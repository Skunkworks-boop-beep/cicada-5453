"""Stage 3: DaemonGuards thread-safe halt flags."""

from __future__ import annotations

import threading
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.daemon_guards import DaemonGuards


def test_initial_state_clear():
    g = DaemonGuards()
    assert g.new_orders_halted is False
    assert g.emergency_stopped is False
    assert g.halt_reason is None
    assert g.history == []


def test_halt_new_orders_records_reason_and_history():
    g = DaemonGuards()
    g.halt_new_orders(source="reconciler", reason="ghost ticket=42")
    assert g.new_orders_halted is True
    assert g.emergency_stopped is False
    assert "ghost" in (g.halt_reason or "")
    assert len(g.history) == 1
    assert g.history[0].kind == "halt_orders"
    assert g.history[0].source == "reconciler"


def test_emergency_stop_implies_halt_orders():
    g = DaemonGuards()
    g.emergency_stop(source="drift", reason="drawdown breach")
    assert g.emergency_stopped is True
    assert g.new_orders_halted is True
    assert g.emergency_reason == "drawdown breach"


def test_resume_clears_both_halts():
    g = DaemonGuards()
    g.emergency_stop(source="drift", reason="dd")
    g.resume(source="manual")
    assert g.new_orders_halted is False
    assert g.emergency_stopped is False
    assert g.halt_reason is None
    # Resume is in history.
    assert g.history[-1].kind == "resume"


def test_clear_halt_only_does_not_lift_emergency():
    """Drift normalising should not auto-clear past an emergency stop —
    operator must explicitly resume."""
    g = DaemonGuards()
    g.emergency_stop(source="drift", reason="dd")
    g.clear_halt_only(source="drift")
    assert g.new_orders_halted is True   # still halted
    assert g.emergency_stopped is True   # still emergency


def test_clear_halt_only_lifts_soft_halt():
    g = DaemonGuards()
    g.halt_new_orders(source="reconciler", reason="ghost")
    g.clear_halt_only(source="reconciler", reason="ghost gone")
    assert g.new_orders_halted is False
    assert g.history[-1].kind == "clear"


def test_thread_safety_under_concurrent_writers():
    """Smoke test: many concurrent halt+resume calls don't crash and
    leave the guard in a deterministic post-state. No pure race-free
    semantics asserted; just that no exception is raised."""
    g = DaemonGuards()

    def worker():
        for _ in range(50):
            g.halt_new_orders(source="t", reason="r")
            g.clear_halt_only(source="t")

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    snap = g.snapshot()
    # 50 halt + 50 clear * 8 threads = 800 events, capped at 50 by snapshot.
    assert len(snap["history"]) == 50


def test_snapshot_history_capped_at_50():
    g = DaemonGuards()
    for i in range(100):
        g.halt_new_orders(source="t", reason=f"r{i}")
    snap = g.snapshot()
    assert len(snap["history"]) == 50
