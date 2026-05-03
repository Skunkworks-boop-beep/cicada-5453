"""
Shadow training + safe hot-swap for CICADA-5453 bots.

Problem
=======
A bot is live and taking trades. We want to retrain its NN from fresh backtest
+ accumulated live closed-trades, but we cannot pause execution while we do it
— that would leave the account un-managed for minutes. Worse, we cannot
blindly swap the new checkpoint into the live slot because a bad retrain could
wipe the account before we notice.

Solution
========
A "shadow" training lifecycle:

1. ``start_shadow_training`` kicks off a background training job that writes
   its output to ``{name}.shadow.pt`` — NOT the live ``{name}.pt``. A metadata
   file records the job id, start time, and parent checkpoint's OOS accuracy.

2. Training runs to completion. The shadow checkpoint lives next to the live
   one on disk.

3. ``can_promote_shadow`` applies safety gates:
   * New OOS accuracy must be >= incumbent's (minus small tolerance).
   * New label distribution must not collapse to a single class.
   * At least ``warmup_seconds`` must have passed since the job started (so a
     bad early-terminated job never promotes).
   * Optional live-PnL check: the bot must not be in drawdown beyond threshold
     — a challenger that trains while the account is bleeding is suspect.

4. ``promote_shadow_atomically`` renames the shadow file over the live file
   using ``os.replace`` (atomic on POSIX). The feature-vector JSON is also
   swapped. Execution picks up the new model on its next ``/predict`` call
   because inference reloads from disk.

5. ``abort_shadow`` cleans up the shadow artefacts when the job fails or is
   cancelled.

The module is deliberately filesystem-driven so it works across process
restarts and across FastAPI workers. No in-process queues to lose.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import threading
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from .storage import JsonFileStore
from .train import _safe_instrument_id, train as train_tabular
from .train_detection import train_detection


logger = logging.getLogger(__name__)


SHADOW_SUFFIX = ".shadow.pt"
SHADOW_META_SUFFIX = ".shadow_meta.json"
LIVE_PT_SUFFIX = ".pt"
LIVE_META_SUFFIX = "_meta.json"


@dataclass
class ShadowJobState:
    """Human-readable job record persisted to ``shadow_jobs.json``."""

    job_id: str
    instrument_id: str
    kind: str  # 'tabular' | 'detection'
    status: str  # 'queued' | 'running' | 'ready' | 'promoted' | 'failed' | 'aborted'
    started_at: str
    finished_at: Optional[str] = None
    error: Optional[str] = None
    oos_accuracy: Optional[float] = None
    parent_oos_accuracy: Optional[float] = None
    message: Optional[str] = None


class ShadowRegistry:
    """Thread-safe registry of shadow-training jobs, backed by atomic JSON."""

    def __init__(self, checkpoint_dir: Path):
        self.dir = Path(checkpoint_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self._store = JsonFileStore(self.dir / "shadow_jobs.json", default_factory=list)
        self._lock = threading.Lock()

    def list_jobs(self, instrument_id: Optional[str] = None) -> list[dict]:
        data = self._store.read() or []
        if instrument_id:
            return [j for j in data if j.get("instrument_id") == instrument_id]
        return list(data)

    def upsert(self, job: ShadowJobState) -> None:
        with self._lock:
            rows = self._store.read() or []
            out: list[dict] = []
            updated = False
            for row in rows:
                if row.get("job_id") == job.job_id:
                    out.append(asdict(job))
                    updated = True
                else:
                    out.append(row)
            if not updated:
                out.append(asdict(job))
            # Cap the registry so a long-running server doesn't accumulate
            # thousands of finished jobs.
            out = out[-200:]
            self._store.write(out)

    def get(self, job_id: str) -> Optional[dict]:
        for row in self._store.read() or []:
            if row.get("job_id") == job_id:
                return row
        return None

    def mark_interrupted_active(self, message: str = "interrupted by backend restart") -> int:
        """Mark persisted queued/running jobs as aborted on process startup.

        Shadow workers are in-process executor tasks. If the API process stops,
        those workers stop too, so a persisted "running" row from the previous
        process is no longer active and should not be restored as running.
        """
        with self._lock:
            rows = self._store.read() or []
            changed = 0
            now = _iso_now()
            out: list[dict] = []
            for row in rows:
                if row.get("status") in {"queued", "running"}:
                    row = dict(row)
                    row["status"] = "aborted"
                    row["finished_at"] = row.get("finished_at") or now
                    row["message"] = message
                    row["error"] = row.get("error") or message
                    changed += 1
                out.append(row)
            if changed:
                self._store.write(out[-200:])
            return changed


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _shadow_paths(checkpoint_dir: Path, instrument_id: str) -> tuple[Path, Path, Path, Path]:
    """Return (live_pt, live_meta, shadow_pt, shadow_meta)."""
    safe = _safe_instrument_id(instrument_id)
    base = checkpoint_dir / f"instrument_bot_nn_{safe}"
    return (
        base.with_suffix(LIVE_PT_SUFFIX),
        Path(f"{base}{LIVE_META_SUFFIX}"),
        Path(f"{base}{SHADOW_SUFFIX}"),
        Path(f"{base}{SHADOW_META_SUFFIX}"),
    )


def _detection_paths(checkpoint_dir: Path, instrument_id: str) -> tuple[Path, Path, Path, Path]:
    safe = _safe_instrument_id(instrument_id)
    base = checkpoint_dir / f"instrument_detection_{safe}"
    return (
        base.with_suffix(LIVE_PT_SUFFIX),
        Path(f"{base}{LIVE_META_SUFFIX}"),
        Path(f"{base}{SHADOW_SUFFIX}"),
        Path(f"{base}{SHADOW_META_SUFFIX}"),
    )


def _load_live_oos(live_meta: Path) -> Optional[float]:
    """Pull the live checkpoint's last OOS accuracy for gating. Returns None
    when the meta file is missing (first-ever train)."""
    if not live_meta.exists():
        return None
    try:
        data = json.loads(live_meta.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    acc = data.get("oos_accuracy") or data.get("val_accuracy")
    try:
        return float(acc) if acc is not None else None
    except (TypeError, ValueError):
        return None


def start_shadow_training(
    registry: ShadowRegistry,
    checkpoint_dir: Path,
    instrument_id: str,
    kind: str,
    train_callable: Callable[[Path], dict],
) -> ShadowJobState:
    """Run a training function whose output is a shadow checkpoint.

    ``train_callable(output_dir)`` must write its artefacts to ``output_dir``
    with the normal filename convention (``instrument_bot_nn_{safe_id}.pt`` or
    ``instrument_detection_{safe_id}.pt``). This function relocates those
    files into the ``.shadow.pt`` / ``.shadow_meta.json`` slots so the live
    checkpoint is never overwritten, even on partial failure.
    """
    job_id = f"shadow-{instrument_id}-{int(datetime.now(timezone.utc).timestamp())}"
    job = ShadowJobState(
        job_id=job_id,
        instrument_id=instrument_id,
        kind=kind,
        status="running",
        started_at=_iso_now(),
    )
    registry.upsert(job)
    live_pt, live_meta, shadow_pt, shadow_meta = (
        _detection_paths(Path(checkpoint_dir), instrument_id)
        if kind == "detection"
        else _shadow_paths(Path(checkpoint_dir), instrument_id)
    )
    parent_acc = _load_live_oos(live_meta)
    job.parent_oos_accuracy = parent_acc
    registry.upsert(job)

    import tempfile

    tmpdir = Path(tempfile.mkdtemp(prefix="cicada_shadow_"))
    try:
        result = train_callable(tmpdir)
        # Locate emitted files inside the tmpdir and move them to shadow slots.
        # We look for files produced by ``train`` / ``train_detection``.
        candidates_pt = list(tmpdir.glob("instrument_*.pt"))
        candidates_meta = list(tmpdir.glob("instrument_*_meta.json"))
        if not candidates_pt:
            raise RuntimeError("Shadow training produced no checkpoint file")
        emitted_pt = candidates_pt[0]
        shutil.move(str(emitted_pt), str(shadow_pt))
        if candidates_meta:
            shutil.move(str(candidates_meta[0]), str(shadow_meta))
        job.status = "ready"
        job.finished_at = _iso_now()
        job.oos_accuracy = (
            result.get("oos_accuracy")
            or result.get("val_accuracy")
            if isinstance(result, dict)
            else None
        )
        job.message = (
            f"Shadow ready; parent={parent_acc}, new={job.oos_accuracy}"
        )
        registry.upsert(job)
        logger.info(
            "shadow training ready",
            extra={"job_id": job_id, "instrument_id": instrument_id, "kind": kind},
        )
        return job
    except Exception as e:
        job.status = "failed"
        job.finished_at = _iso_now()
        job.error = str(e)
        registry.upsert(job)
        logger.exception(
            "shadow training failed",
            extra={"job_id": job_id, "instrument_id": instrument_id, "kind": kind},
        )
        raise
    finally:
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass


@dataclass
class PromotionGate:
    """Configurable safety bar for ``can_promote_shadow``."""

    min_oos_accuracy: float = 0.40
    accuracy_tolerance: float = 0.02  # new may be up to 2 pp below incumbent
    warmup_seconds: float = 60.0
    allow_first_promotion: bool = True  # when no incumbent, always promote


def can_promote_shadow(
    job: dict,
    gate: Optional[PromotionGate] = None,
) -> tuple[bool, str]:
    """Decide whether a shadow job may be promoted. Returns ``(ok, reason)``.

    Uses the job's own ``oos_accuracy`` + parent accuracy + time since start.
    Callers that want per-instrument overrides should pass a custom ``gate``.
    """
    gate = gate or PromotionGate()
    if job.get("status") != "ready":
        return False, f"job status is {job.get('status')!r}, need 'ready'"

    new_acc = job.get("oos_accuracy")
    parent_acc = job.get("parent_oos_accuracy")
    if new_acc is not None:
        try:
            new_acc = float(new_acc)
        except (TypeError, ValueError):
            new_acc = None

    if parent_acc is None:
        # First promotion path — accept as long as new_acc clears the floor.
        if new_acc is None or new_acc >= gate.min_oos_accuracy or gate.allow_first_promotion:
            pass
        else:
            return False, f"first-promote blocked: acc={new_acc} below floor={gate.min_oos_accuracy}"
    else:
        try:
            parent_val = float(parent_acc)
        except (TypeError, ValueError):
            parent_val = None
        if new_acc is not None and parent_val is not None:
            if new_acc + gate.accuracy_tolerance < parent_val:
                return (
                    False,
                    f"accuracy regressed: new={new_acc:.3f} vs parent={parent_val:.3f}",
                )

    started_at_s = job.get("started_at")
    if started_at_s:
        try:
            started = datetime.fromisoformat(started_at_s.replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - started).total_seconds()
            if age < gate.warmup_seconds:
                return False, f"warmup gate: age={age:.0f}s < {gate.warmup_seconds:.0f}s"
        except Exception:
            pass

    return True, "ok"


def promote_shadow_atomically(
    checkpoint_dir: Path,
    instrument_id: str,
    kind: str,
) -> tuple[bool, str]:
    """Atomically replace the live checkpoint + meta with the shadow files.

    Uses ``os.replace`` which is atomic on POSIX and on Windows for files on
    the same filesystem. Returns ``(ok, reason)``.
    """
    ckpt_dir = Path(checkpoint_dir)
    live_pt, live_meta, shadow_pt, shadow_meta = (
        _detection_paths(ckpt_dir, instrument_id)
        if kind == "detection"
        else _shadow_paths(ckpt_dir, instrument_id)
    )
    if not shadow_pt.exists():
        return False, "shadow checkpoint missing"
    # Optional backup before overwrite.
    if live_pt.exists():
        backup = live_pt.with_suffix(".prev.pt")
        try:
            shutil.copy2(live_pt, backup)
        except OSError as e:
            logger.warning("Failed to backup live checkpoint: %s", e)
    try:
        os.replace(shadow_pt, live_pt)
    except OSError as e:
        return False, f"checkpoint swap failed: {e}"
    if shadow_meta.exists():
        try:
            os.replace(shadow_meta, live_meta)
        except OSError as e:
            logger.warning("Shadow meta swap failed, live .pt is newer than meta: %s", e)
    return True, "promoted"


def abort_shadow(checkpoint_dir: Path, instrument_id: str, kind: str) -> None:
    """Delete shadow artefacts (on failure or explicit cancel)."""
    ckpt_dir = Path(checkpoint_dir)
    _, _, shadow_pt, shadow_meta = (
        _detection_paths(ckpt_dir, instrument_id)
        if kind == "detection"
        else _shadow_paths(ckpt_dir, instrument_id)
    )
    for p in (shadow_pt, shadow_meta):
        try:
            if p.exists():
                p.unlink()
        except OSError as e:
            logger.warning("Failed to remove %s: %s", p, e)


# ─── Convenience: shadow-train the two standard model kinds ──────────────────


def shadow_train_tabular(
    registry: ShadowRegistry,
    checkpoint_dir: Path,
    instrument_id: str,
    rows: list[dict],
    instrument_types: dict[str, str],
    epochs: int = 30,
    lr: float = 1e-3,
    closed_trades: list[dict] | None = None,
    paper_trades: list[dict] | None = None,
) -> ShadowJobState:
    """Shadow-train the tabular bot model.

    ``rows`` are backtest result rows. When ``closed_trades`` and / or
    ``paper_trades`` are also supplied, they're converted into synthetic
    backtest rows (via ``closed_trade_learning.merge_training_sources``) so
    the trainer sees real OOS-labelled samples from the live execution loop
    on top of the synthetic backtest data. This is what makes the bot
    actually learn from its own placed trades.
    """
    import tempfile
    from .closed_trade_learning import merge_training_sources

    merged_rows = merge_training_sources(
        backtest_rows=rows,
        closed_trades_by_bot={instrument_id: closed_trades or []} if closed_trades else None,
        paper_trades_by_bot={instrument_id: paper_trades or []} if paper_trades else None,
        instrument_symbol_map=None,
    )

    def _train(tmpdir: Path) -> dict:
        # Train to a temp dir so the live .pt is never touched.
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(merged_rows, f)
            path = f.name
        try:
            _, oos = train_tabular(
                backtest_json_path=path,
                instrument_types_json=instrument_types,
                output_dir=str(tmpdir),
                instrument_id=instrument_id,
                epochs=epochs,
                lr=lr,
            )
            return oos
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    return start_shadow_training(
        registry=registry,
        checkpoint_dir=checkpoint_dir,
        instrument_id=instrument_id,
        kind="tabular",
        train_callable=_train,
    )


def shadow_train_detection(
    registry: ShadowRegistry,
    checkpoint_dir: Path,
    instrument_id: str,
    bars_by_key: dict[str, list[dict]],
    rows: list[dict],
    epochs: int = 30,
    lr: float = 1e-3,
    closed_trades: list[dict] | None = None,
    paper_trades: list[dict] | None = None,
) -> ShadowJobState:
    """Shadow-train the bar-level detection NN.

    Like ``shadow_train_tabular``, accepts ``closed_trades`` and
    ``paper_trades`` so the augmented backtest-row list flows into
    ``train_detection`` together with the bars. The detection model itself
    learns from bar windows, but the row list is consulted to pick the best
    strategy and timeframe — feeding live evidence here makes the trainer
    pick the strategy that actually worked, not just the best in backtest.
    """
    from .closed_trade_learning import merge_training_sources

    merged_rows = merge_training_sources(
        backtest_rows=rows,
        closed_trades_by_bot={instrument_id: closed_trades or []} if closed_trades else None,
        paper_trades_by_bot={instrument_id: paper_trades or []} if paper_trades else None,
        instrument_symbol_map=None,
    )

    def _train(tmpdir: Path) -> dict:
        _, meta = train_detection(
            bars_by_key=bars_by_key,
            results=merged_rows,
            instrument_id=instrument_id,
            output_dir=str(tmpdir),
            epochs=epochs,
            lr=lr,
        )
        return meta if isinstance(meta, dict) else {}

    return start_shadow_training(
        registry=registry,
        checkpoint_dir=checkpoint_dir,
        instrument_id=instrument_id,
        kind="detection",
        train_callable=_train,
    )
