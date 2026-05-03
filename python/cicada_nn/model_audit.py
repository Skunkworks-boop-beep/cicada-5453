"""
Model audit: scan every detection-model meta file and report which models are
unsafe to trade.

Background
==========
The operator hit the "everything loses" failure mode because models trained
with badly skewed labels + uncapped class weights produced ``val_accuracy``
well below the random-baseline (1/3 for a three-class classifier). The
trainer now writes ``safe_to_use`` and ``inversion_score`` into the meta file;
this module surfaces that information so the dashboard can show the operator
which bots must be retrained before they're allowed to trade.

The audit is read-only — it never touches the checkpoints themselves.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)


# Random baseline for a three-class detection model. A model below this is
# guaranteed to lose money in the long run unless its predictions are
# systematically inverted (in which case ``inversion_score`` will flag it for
# auto-flip).
RANDOM_BASELINE = 1.0 / 3.0
PROMOTION_MARGIN = 0.04
PROMOTION_FLOOR = RANDOM_BASELINE + PROMOTION_MARGIN


@dataclass
class ModelAuditEntry:
    instrument_id: str
    timeframe: str | None
    strategy_id: str | None
    val_accuracy: float | None
    safe_to_use: bool
    inversion_score: float | None
    promotion_floor: float
    label_distribution: dict[str, float] | None
    num_train: int | None
    num_val: int | None
    file: str
    verdict: str  # 'ok' | 'below_floor' | 'inverted' | 'missing_metric'


def _classify(meta: dict[str, Any]) -> tuple[bool, str, float | None]:
    """Return (safe, verdict, inversion_score)."""
    val_acc_raw = meta.get("val_accuracy")
    try:
        val_acc = float(val_acc_raw) if val_acc_raw is not None else None
    except (TypeError, ValueError):
        val_acc = None

    if val_acc is None:
        return False, "missing_metric", None

    inv = max(0.0, RANDOM_BASELINE - val_acc) if val_acc < RANDOM_BASELINE else 0.0

    # If the meta carries explicit ``safe_to_use`` (newer trainer), trust it.
    if "safe_to_use" in meta:
        ok = bool(meta["safe_to_use"])
        if ok:
            return True, "ok", inv
        # Model is below floor; classify why so the UI can render it.
        if val_acc < RANDOM_BASELINE * 0.5:
            # Far below random ⇒ likely inverted.
            return False, "inverted", inv
        return False, "below_floor", inv

    # Older meta files (pre-floor) — derive verdict from val_acc alone.
    if val_acc >= PROMOTION_FLOOR:
        return True, "ok", inv
    if val_acc < RANDOM_BASELINE * 0.5:
        return False, "inverted", inv
    return False, "below_floor", inv


def audit_checkpoints(checkpoint_dir: Path) -> list[ModelAuditEntry]:
    """Walk ``checkpoint_dir`` for ``instrument_detection_*_meta.json`` files
    and produce one audit entry per meta. Tolerant of malformed files (logs
    and skips). Returns the list sorted with unsafe entries first so the UI
    can show them prominently."""
    out: list[ModelAuditEntry] = []
    for meta_path in sorted(checkpoint_dir.glob("instrument_detection_*_meta.json")):
        try:
            meta = json.loads(meta_path.read_text())
        except (OSError, json.JSONDecodeError) as e:
            logger.warning("audit_checkpoints: skip malformed %s: %s", meta_path, e)
            continue
        safe, verdict, inversion = _classify(meta)
        out.append(
            ModelAuditEntry(
                instrument_id=str(meta.get("instrument_id") or ""),
                timeframe=meta.get("timeframe"),
                strategy_id=meta.get("strategy_id"),
                val_accuracy=meta.get("val_accuracy"),
                safe_to_use=safe,
                inversion_score=inversion,
                promotion_floor=PROMOTION_FLOOR,
                label_distribution=meta.get("label_distribution"),
                num_train=meta.get("num_train"),
                num_val=meta.get("num_val"),
                file=meta_path.name,
                verdict=verdict,
            )
        )
    # Sort: unsafe first, then by inversion score (worst inverted first).
    out.sort(key=lambda e: (e.safe_to_use, -(e.inversion_score or 0.0)))
    return out


def audit_summary(entries: list[ModelAuditEntry]) -> dict[str, Any]:
    """One-glance summary suitable for /audit/models response and for the FE."""
    total = len(entries)
    unsafe = [e for e in entries if not e.safe_to_use]
    inverted = [e for e in entries if e.verdict == "inverted"]
    return {
        "total": total,
        "unsafe": len(unsafe),
        "ok": total - len(unsafe),
        "inverted": len(inverted),
        "promotion_floor": PROMOTION_FLOOR,
        "random_baseline": RANDOM_BASELINE,
        "entries": [asdict(e) for e in entries],
    }
