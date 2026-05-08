"""Stage 4: historical_fakeout_rate is now populated from the order store.

The drift-monitor previously left this field None; the rule could not
fire. Stage 4 slices the order history into a 200-row recent window and
a 1,800-row historical window and computes the rate over each. The rule
fires when recent rate > 3 × historical rate.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.daemon_guards import DaemonGuards
from cicada_nn.drift_monitor import DriftAction, DriftMonitor
from cicada_nn.order_records import OrderRecordStore, OrderStatus


def _store(tmp_path: Path) -> OrderRecordStore:
    return OrderRecordStore(tmp_path / "orders.sqlite")


def _add_order(s: OrderRecordStore, *, fakeout: bool, idx: int) -> None:
    s.append_order(
        bot_id="bot",
        instrument_id="inst",
        instrument_symbol="EURUSD",
        style="day",
        side="LONG",
        size=0.1,
        entry_price=1.0,
        stop_loss=0.99,
        take_profit=1.02,
        confidence=0.7,
        status=OrderStatus.FILLED,
        reason=("fakeout reversal" if fakeout else None),
        ticket=idx + 1,
    )


def test_baseline_silent_with_fewer_than_200_historical_rows(tmp_path: Path):
    """Below the 200-historical floor, the rate stays None and the rule
    can't fire."""
    s = _store(tmp_path)
    for i in range(100):
        _add_order(s, fakeout=False, idx=i)
    monitor = DriftMonitor(s, guards=DaemonGuards(), bridge_get_positions=lambda: [])
    ctx = monitor.build_context()
    assert ctx.historical_fakeout_rate is None


def test_baseline_populated_with_2000_rows(tmp_path: Path):
    s = _store(tmp_path)
    # Historical 1,800 rows: 5% fakeouts.
    for i in range(1_800):
        _add_order(s, fakeout=(i % 20 == 0), idx=i)
    # Recent 200 rows: also 5% fakeouts. Rule should not fire.
    for i in range(200):
        _add_order(s, fakeout=(i % 20 == 0), idx=1_800 + i)
    monitor = DriftMonitor(s, guards=DaemonGuards(), bridge_get_positions=lambda: [])
    ctx = monitor.build_context()
    assert ctx.historical_fakeout_rate is not None
    assert 0.04 < ctx.historical_fakeout_rate < 0.06
    assert ctx.recent_fakeout_rate is not None
    assert 0.04 < ctx.recent_fakeout_rate < 0.06
    snap = monitor.evaluate(ctx)
    # Recent ≈ historical → no trigger.
    assert snap.chosen_action == DriftAction.NONE


def test_fakeout_rate_triggers_when_recent_above_3x_historical(tmp_path: Path):
    s = _store(tmp_path)
    # Historical 1,800 rows: 5% fakeouts.
    for i in range(1_800):
        _add_order(s, fakeout=(i % 20 == 0), idx=i)
    # Recent 200 rows: 30% fakeouts (> 3 × 5%).
    for i in range(200):
        _add_order(s, fakeout=(i % 3 == 0), idx=1_800 + i)
    guards = DaemonGuards()
    fired: list[str] = []
    monitor = DriftMonitor(
        s, guards=guards,
        bridge_get_positions=lambda: [],
        soft_retrain_hook=lambda reason: fired.append(reason),
    )
    snap = monitor.tick()
    assert snap.chosen_action == DriftAction.SOFT_RETRAIN
    assert any("fakeout" in r.lower() for r in fired)
