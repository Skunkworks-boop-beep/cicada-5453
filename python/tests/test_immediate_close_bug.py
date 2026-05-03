"""Regression for bug 1: SCALPING bot must not close before min_hold_bars."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.sl_tp_manager import PositionLifecycleState, can_exit
from cicada_nn.trade_modes import (
    OrderSignal,
    RejectReason,
    get_rules,
    validate_order,
)


def test_scalping_cannot_close_on_entry_bar():
    """Entry happens on bar T. The min-hold gate must reject any signal-based
    close attempt until bar T+3."""
    r = get_rules("scalping")
    assert r.min_hold_bars == 3
    for bars in (0, 1, 2):
        life = PositionLifecycleState(
            side="LONG", entry_price=100.0, initial_sl=99.7, initial_tp=100.5,
            current_sl=99.7, bars_since_open=bars, partial_taken=False,
        )
        assert can_exit(r, life) is False, f"scalp must not exit at bar +{bars}"
    on_time = PositionLifecycleState(
        side="LONG", entry_price=100.0, initial_sl=99.7, initial_tp=100.5,
        current_sl=99.7, bars_since_open=3, partial_taken=False,
    )
    assert can_exit(r, on_time) is True


def test_validation_rejects_too_soon_re_open():
    """A bot that just placed a SCALPING entry cannot re-enter on the next
    bar — the validate_order min-hold gate stops the second order."""
    r = get_rules("scalping")
    s = OrderSignal(
        side="LONG", entry_price=100.0, stop_loss=99.7, take_profit=100.5,
        confidence=0.7,
    )
    res = validate_order(r, s, atr=1.0, n_concurrent=0, bars_since_last_open=1)
    assert not res.ok
    assert res.reason is RejectReason.MIN_HOLD_NOT_ELAPSED


@pytest.mark.parametrize("style", ["scalping", "day", "medium_swing", "swing", "sniper"])
def test_min_hold_threshold_per_style(style):
    r = get_rules(style)
    s = OrderSignal(
        side="LONG", entry_price=100.0,
        stop_loss=100.0 - (r.min_sl_atr + 0.05),
        take_profit=100.0 + (r.min_tp_atr + 0.05),
        confidence=r.confidence_threshold + 0.05,
    )
    too_soon = validate_order(r, s, atr=1.0, n_concurrent=0,
                              bars_since_last_open=r.min_hold_bars - 1)
    on_time = validate_order(r, s, atr=1.0, n_concurrent=0,
                             bars_since_last_open=r.min_hold_bars)
    assert not too_soon.ok and too_soon.reason is RejectReason.MIN_HOLD_NOT_ELAPSED
    assert on_time.ok
