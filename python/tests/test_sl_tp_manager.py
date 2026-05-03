"""Per-mode SL/TP lifecycle: BE@1R, trail forward, partials emit once."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.sl_tp_manager import (
    PositionLifecycleState,
    can_exit,
    evaluate_sl,
    evaluate_tp,
)
from cicada_nn.trade_modes import (
    SLManagement,
    TPManagement,
    get_rules,
)


def _life(side="LONG", entry=100.0, sl=99.0, tp=102.0, current_sl=None,
          bars=10, partial=False) -> PositionLifecycleState:
    return PositionLifecycleState(
        side=side,
        entry_price=entry,
        initial_sl=sl,
        initial_tp=tp,
        current_sl=current_sl if current_sl is not None else sl,
        bars_since_open=bars,
        partial_taken=partial,
    )


# ── STATIC SL (scalping) ────────────────────────────────────────────────────


def test_scalping_static_sl_never_moves():
    r = get_rules("scalping")
    assert r.sl_management is SLManagement.STATIC
    life = _life()
    decision = evaluate_sl(r, life, current_price=105.0, atr=0.5)
    assert decision.is_noop


# ── TRAIL_AFTER_1R (day) ────────────────────────────────────────────────────


def test_day_trail_does_not_move_below_1r():
    r = get_rules("day")
    assert r.sl_management is SLManagement.TRAIL_AFTER_1R
    # Entry 100, SL 99 → 1R is 1.0 → 1R triggers at price >= 101.
    life = _life(entry=100.0, sl=99.0)
    assert evaluate_sl(r, life, current_price=100.5, atr=0.5).is_noop


def test_day_trail_starts_at_1r_and_only_moves_forward():
    r = get_rules("day")
    life = _life(entry=100.0, sl=99.0)
    # At +1R (price 101), trail SL = 101 - 0.5 = 100.5.
    d1 = evaluate_sl(r, life, current_price=101.0, atr=0.5)
    assert d1.new_sl == pytest.approx(100.5)
    life = PositionLifecycleState(
        side=life.side, entry_price=life.entry_price, initial_sl=life.initial_sl,
        initial_tp=life.initial_tp, current_sl=d1.new_sl,
        bars_since_open=life.bars_since_open + 1, partial_taken=False,
    )
    # If price retraces, SL should NOT move backward.
    retrace = evaluate_sl(r, life, current_price=100.6, atr=0.5)
    assert retrace.is_noop or retrace.new_sl == life.current_sl


# ── BE_THEN_TRAIL (medium_swing, swing) ─────────────────────────────────────


@pytest.mark.parametrize("style", ["medium_swing", "swing"])
def test_be_then_trail_first_hits_breakeven(style):
    r = get_rules(style)
    assert r.sl_management is SLManagement.BE_THEN_TRAIL
    life = _life(entry=100.0, sl=98.0)
    # Price = 102 = +1R. SL must move to entry first (100), not trail past it yet.
    d1 = evaluate_sl(r, life, current_price=102.0, atr=1.0)
    assert d1.new_sl == 100.0
    assert "be" in d1.note


def test_be_then_trail_subsequent_trails_forward():
    r = get_rules("swing")
    life = _life(entry=100.0, sl=98.0, current_sl=100.0)  # already at BE
    d = evaluate_sl(r, life, current_price=104.0, atr=1.0)
    assert d.new_sl is not None and d.new_sl > 100.0
    # And does not move backward on retrace.
    life2 = PositionLifecycleState(
        side="LONG", entry_price=100.0, initial_sl=98.0, initial_tp=104.0,
        current_sl=d.new_sl, bars_since_open=15, partial_taken=False,
    )
    d2 = evaluate_sl(r, life2, current_price=102.0, atr=1.0)
    assert d2.is_noop or d2.new_sl == life2.current_sl


# ── TRAIL_FROM_ENTRY (sniper) ───────────────────────────────────────────────


def test_sniper_trails_immediately():
    r = get_rules("sniper")
    assert r.sl_management is SLManagement.TRAIL_FROM_ENTRY
    life = _life(entry=100.0, sl=99.0)
    # Even at +0.5R, sniper trail should propose a forward move.
    d = evaluate_sl(r, life, current_price=100.5, atr=1.0)
    # 100.5 - 0.5 * 1.0 = 100.0 → new SL > initial 99.0
    assert d.new_sl == pytest.approx(100.0)


# ── TP partials ────────────────────────────────────────────────────────────


def test_fixed_tp_does_not_partial():
    r = get_rules("scalping")
    assert r.tp_management is TPManagement.FIXED
    life = _life(entry=100.0, sl=99.0, current_sl=99.0)
    d = evaluate_tp(r, life, current_price=102.0)
    assert d.is_noop


@pytest.mark.parametrize("style", ["day", "medium_swing", "swing"])
def test_partial_at_1r_emits_once(style):
    r = get_rules(style)
    life = _life(entry=100.0, sl=99.0)
    d1 = evaluate_tp(r, life, current_price=101.0)
    assert d1.take_partial_fraction == 0.5
    # Subsequent calls must NOT re-emit a partial.
    life2 = PositionLifecycleState(
        side="LONG", entry_price=100.0, initial_sl=99.0, initial_tp=102.0,
        current_sl=99.0, bars_since_open=10, partial_taken=True,
    )
    d2 = evaluate_tp(r, life2, current_price=101.5)
    assert d2.is_noop


# ── Exit gating (bug 1: immediate close) ────────────────────────────────────


@pytest.mark.parametrize("style", ["scalping", "day", "medium_swing", "swing", "sniper"])
def test_can_exit_blocks_until_min_hold(style):
    r = get_rules(style)
    early = _life(bars=r.min_hold_bars - 1)
    on_time = _life(bars=r.min_hold_bars)
    assert can_exit(r, early) is False
    assert can_exit(r, on_time) is True
