"""Tests for the cross-request job manager + shadow training lifecycle."""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.compute import resolve_compute_config  # noqa: E402
from cicada_nn.job_manager import JobManager  # noqa: E402
from cicada_nn.shadow_training import (  # noqa: E402
    PromotionGate,
    ShadowJobState,
    ShadowRegistry,
    can_promote_shadow,
    promote_shadow_atomically,
)


# ───────────────────────── compute config ─────────────────────────


def test_compute_config_has_workers_and_torch_threads(monkeypatch):
    monkeypatch.delenv("CICADA_DISABLE_CUDA", raising=False)
    cfg = resolve_compute_config()
    assert cfg.cpu_count >= 1
    assert cfg.backtest_workers >= 1
    assert cfg.torch_num_threads >= 1
    assert cfg.dataloader_workers >= 0


def test_compute_config_respects_disable_cuda(monkeypatch):
    monkeypatch.setenv("CICADA_DISABLE_CUDA", "1")
    cfg = resolve_compute_config()
    assert cfg.use_cuda is False
    assert cfg.device_str == "cpu"


# ───────────────────────── job manager ─────────────────────────


def test_job_manager_create_progress_and_finish():
    m = JobManager()
    j = m.create("backtest", "demo")
    assert j.status == "queued"
    m.mark_running(j.job_id)
    m.update_progress(j.job_id, 50, "halfway")
    assert m.get(j.job_id).progress == 50
    assert m.get(j.job_id).message == "halfway"
    m.mark_done(j.job_id, succeeded=True, message="ok")
    assert m.get(j.job_id).status == "succeeded"
    assert m.get(j.job_id).progress == 100


def test_job_manager_cancellation_token_signals_workers():
    m = JobManager()
    j = m.create("research", "long-running")
    m.mark_running(j.job_id)
    cancelled = []

    def worker():
        for _ in range(50):
            if m.should_cancel(j.job_id):
                cancelled.append(True)
                return
            time.sleep(0.005)
        cancelled.append(False)

    t = threading.Thread(target=worker)
    t.start()
    time.sleep(0.05)
    assert m.cancel(j.job_id)
    t.join(timeout=2)
    assert cancelled == [True]
    assert m.get(j.job_id).status == "cancelled"


def test_job_manager_filters_by_kind_and_active():
    m = JobManager()
    a = m.create("backtest", "a")
    b = m.create("research", "b")
    m.mark_running(a.job_id)
    m.mark_done(b.job_id, succeeded=True)
    bts = m.list(kind="backtest")
    assert all(j.kind == "backtest" for j in bts)
    actives = m.list(active_only=True)
    assert all(j.status in {"queued", "running"} for j in actives)


# ───────────────────────── shadow training ─────────────────────────


def test_shadow_registry_persists_to_disk(tmp_path):
    reg = ShadowRegistry(tmp_path)
    job = ShadowJobState(
        job_id="shadow-test-1",
        instrument_id="inst-eurusd",
        kind="detection",
        status="ready",
        started_at="2024-01-01T00:00:00Z",
        oos_accuracy=0.55,
        parent_oos_accuracy=0.50,
    )
    reg.upsert(job)
    persisted_file = tmp_path / "shadow_jobs.json"
    assert persisted_file.exists()
    data = json.loads(persisted_file.read_text())
    assert any(r["job_id"] == "shadow-test-1" for r in data)


def test_can_promote_shadow_blocks_regression():
    job = {
        "status": "ready",
        "oos_accuracy": 0.40,
        "parent_oos_accuracy": 0.55,
        "started_at": "2024-01-01T00:00:00Z",
    }
    ok, reason = can_promote_shadow(job)
    assert not ok
    assert "regressed" in reason


def test_can_promote_shadow_allows_first_promote():
    job = {
        "status": "ready",
        "oos_accuracy": 0.42,
        "parent_oos_accuracy": None,
        "started_at": "2024-01-01T00:00:00Z",
    }
    ok, _ = can_promote_shadow(job)
    assert ok


def test_can_promote_shadow_blocks_warmup():
    from datetime import datetime, timezone
    just_now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    job = {
        "status": "ready",
        "oos_accuracy": 0.55,
        "parent_oos_accuracy": 0.55,
        "started_at": just_now,
    }
    ok, reason = can_promote_shadow(job, gate=PromotionGate(warmup_seconds=120))
    assert not ok
    assert "warmup" in reason


def test_promote_shadow_atomically_swaps_files(tmp_path):
    # Build dummy live + shadow detection checkpoints.
    inst = "inst-eurusd"
    base = tmp_path / "instrument_detection_inst-eurusd"
    live = base.with_suffix(".pt")
    shadow = base.with_suffix(".shadow.pt")
    live.write_bytes(b"live")
    shadow.write_bytes(b"new")
    ok, reason = promote_shadow_atomically(tmp_path, inst, "detection")
    assert ok, reason
    assert live.read_bytes() == b"new"
    assert not shadow.exists()
