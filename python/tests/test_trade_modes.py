"""Exhaustive validation table for the canonical trade-mode rules."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.trade_modes import (
    ALL_STYLES,
    OrderSignal,
    RejectReason,
    TRADE_MODES,
    get_rules,
    validate_order,
)


def _ok_signal(rules, atr: float = 1.0) -> OrderSignal:
    """Build a signal that passes the given rules with a small margin."""
    sl_dist = (rules.min_sl_atr + rules.max_sl_atr) / 2 * atr
    tp_dist = max(rules.min_tp_atr, rules.min_tp_atr + 0.1) * atr
    return OrderSignal(
        side="LONG",
        entry_price=100.0,
        stop_loss=100.0 - sl_dist,
        take_profit=100.0 + tp_dist,
        confidence=rules.confidence_threshold + 0.05,
    )


def test_all_five_styles_present():
    assert set(TRADE_MODES.keys()) == set(ALL_STYLES)
    assert len(TRADE_MODES) == 5


def test_max_concurrent_per_style():
    assert TRADE_MODES["scalping"].max_concurrent == 3
    assert TRADE_MODES["day"].max_concurrent == 2
    assert TRADE_MODES["medium_swing"].max_concurrent == 2
    assert TRADE_MODES["swing"].max_concurrent == 2
    assert TRADE_MODES["sniper"].max_concurrent == 1


def test_mt5_magic_unique():
    magics = {r.mt5_magic for r in TRADE_MODES.values()}
    assert len(magics) == 5
    assert magics == {1001, 1002, 1003, 1004, 1005}


def test_get_rules_unknown_raises():
    with pytest.raises(KeyError):
        get_rules("nonexistent")


@pytest.mark.parametrize("style", ALL_STYLES)
def test_baseline_signal_validates(style):
    r = get_rules(style)
    signal = _ok_signal(r)
    res = validate_order(r, signal, atr=1.0, n_concurrent=0, bars_since_last_open=None)
    assert res.ok, f"{style}: {res.reason} {res.detail}"


@pytest.mark.parametrize("style", ALL_STYLES)
def test_confidence_below_threshold_rejects(style):
    r = get_rules(style)
    s = _ok_signal(r)
    s = OrderSignal(s.side, s.entry_price, s.stop_loss, s.take_profit, r.confidence_threshold - 0.01)
    res = validate_order(r, s, atr=1.0, n_concurrent=0)
    assert not res.ok
    assert res.reason is RejectReason.CONFIDENCE_BELOW_THRESHOLD


@pytest.mark.parametrize("style", ALL_STYLES)
def test_max_concurrent_rejects(style):
    r = get_rules(style)
    s = _ok_signal(r)
    res = validate_order(r, s, atr=1.0, n_concurrent=r.max_concurrent)
    assert not res.ok
    assert res.reason is RejectReason.MAX_CONCURRENT_EXCEEDED


@pytest.mark.parametrize("style", ALL_STYLES)
def test_min_hold_rejects(style):
    r = get_rules(style)
    s = _ok_signal(r)
    res = validate_order(r, s, atr=1.0, n_concurrent=0, bars_since_last_open=r.min_hold_bars - 1)
    assert not res.ok
    assert res.reason is RejectReason.MIN_HOLD_NOT_ELAPSED
    res2 = validate_order(r, s, atr=1.0, n_concurrent=0, bars_since_last_open=r.min_hold_bars)
    assert res2.ok


@pytest.mark.parametrize("style", ALL_STYLES)
def test_tp_too_tight(style):
    r = get_rules(style)
    s = OrderSignal(
        side="LONG",
        entry_price=100.0,
        stop_loss=100.0 - r.min_sl_atr,
        take_profit=100.0 + (r.min_tp_atr - 0.1),
        confidence=r.confidence_threshold,
    )
    res = validate_order(r, s, atr=1.0, n_concurrent=0)
    assert not res.ok
    assert res.reason is RejectReason.TP_TOO_TIGHT


@pytest.mark.parametrize("style", ALL_STYLES)
def test_sl_too_tight(style):
    r = get_rules(style)
    s = OrderSignal(
        side="LONG",
        entry_price=100.0,
        stop_loss=100.0 - max(0.01, r.min_sl_atr - 0.1),
        take_profit=100.0 + r.min_tp_atr,
        confidence=r.confidence_threshold,
    )
    res = validate_order(r, s, atr=1.0, n_concurrent=0)
    assert not res.ok
    assert res.reason is RejectReason.SL_TOO_TIGHT


@pytest.mark.parametrize("style", ALL_STYLES)
def test_sl_too_wide(style):
    r = get_rules(style)
    s = OrderSignal(
        side="LONG",
        entry_price=100.0,
        stop_loss=100.0 - (r.max_sl_atr + 0.5),
        take_profit=100.0 + r.min_tp_atr,
        confidence=r.confidence_threshold,
    )
    res = validate_order(r, s, atr=1.0, n_concurrent=0)
    assert not res.ok
    assert res.reason is RejectReason.SL_TOO_WIDE


def test_invalid_signal_rejects_zero_atr():
    r = get_rules("day")
    s = _ok_signal(r)
    res = validate_order(r, s, atr=0.0, n_concurrent=0)
    assert not res.ok
    assert res.reason is RejectReason.INVALID_SIGNAL


def test_short_side_distances_use_abs():
    r = get_rules("day")
    s = OrderSignal(
        side="SHORT",
        entry_price=100.0,
        stop_loss=100.0 + 1.0,
        take_profit=100.0 - 1.5,
        confidence=r.confidence_threshold,
    )
    res = validate_order(r, s, atr=1.0, n_concurrent=0)
    assert res.ok


def test_validate_does_not_mutate_signal():
    r = get_rules("day")
    s = _ok_signal(r)
    snapshot = (s.side, s.entry_price, s.stop_loss, s.take_profit, s.confidence)
    validate_order(r, s, atr=1.0, n_concurrent=0)
    assert (s.side, s.entry_price, s.stop_loss, s.take_profit, s.confidence) == snapshot
