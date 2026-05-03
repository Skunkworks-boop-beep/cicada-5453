"""
Per-mode SL/TP lifecycle for CICADA-5453.

This module is the spec's answer to bug 2 ("no dynamic SL"). The previous
codebase placed an order with an initial SL/TP and never moved them — even
SWING bots that should breakeven-trail after +1R. There was no module that
owned post-entry SL/TP behaviour; ``signals.py:2940 _signal_atr_trail`` is a
*signal* generator, not an SL manager.

Each per-mode policy is a pure function over current price and the position's
entry/initial-SL — no broker calls, no DB writes. The caller (the daemon)
decides when to push a modify request to MT5 and when to log the change to
``order_records.sl_tp_events``. That separation keeps unit tests deterministic
and makes the policy table easy to read.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .trade_modes import SLManagement, TPManagement, TradeModeRules


@dataclass(frozen=True)
class PositionLifecycleState:
    """What the SL manager needs to know about an open position.

    Bar counters are caller-managed; this module is pure given them.
    """

    side: str               # "LONG" | "SHORT"
    entry_price: float
    initial_sl: float
    initial_tp: float
    current_sl: float
    bars_since_open: int
    partial_taken: bool = False


@dataclass(frozen=True)
class SLDecision:
    """A proposed SL/TP move. ``None`` for no-op."""

    new_sl: Optional[float] = None
    take_partial_fraction: Optional[float] = None  # e.g. 0.5 for half
    note: str = ""

    @property
    def is_noop(self) -> bool:
        return self.new_sl is None and self.take_partial_fraction is None


# ─── Helpers ────────────────────────────────────────────────────────────────


def _r_distance(state: PositionLifecycleState) -> float:
    """1R as price distance from entry to initial SL. Always positive."""
    return abs(state.entry_price - state.initial_sl)


def _r_multiple(state: PositionLifecycleState, current_price: float) -> float:
    """Current open profit measured in R (signed: + favourable, − adverse)."""
    r = _r_distance(state)
    if r <= 0:
        return 0.0
    if state.side == "LONG":
        return (current_price - state.entry_price) / r
    return (state.entry_price - current_price) / r


def _trail_sl(state: PositionLifecycleState, current_price: float, atr: float, mult: float = 1.0) -> float:
    """ATR-based trailing stop in the favourable direction; never moves backward."""
    if state.side == "LONG":
        candidate = current_price - atr * mult
        return max(state.current_sl, candidate)
    candidate = current_price + atr * mult
    return min(state.current_sl, candidate)


def _be_or_better(state: PositionLifecycleState) -> float:
    """Move SL to entry, never backward."""
    if state.side == "LONG":
        return max(state.current_sl, state.entry_price)
    return min(state.current_sl, state.entry_price)


# ─── Public API ─────────────────────────────────────────────────────────────


def evaluate_sl(
    rules: TradeModeRules,
    state: PositionLifecycleState,
    current_price: float,
    atr: float,
) -> SLDecision:
    """Per-mode SL policy. Returns the desired new SL (or no-op)."""
    if rules.sl_management is SLManagement.STATIC:
        return SLDecision()

    r_mult = _r_multiple(state, current_price)

    if rules.sl_management is SLManagement.TRAIL_AFTER_1R:
        if r_mult < 1.0:
            return SLDecision()
        new_sl = _trail_sl(state, current_price, atr)
        if new_sl == state.current_sl:
            return SLDecision()
        return SLDecision(new_sl=new_sl, note=f"trail@{r_mult:.2f}R")

    if rules.sl_management is SLManagement.BE_THEN_TRAIL:
        if r_mult < 1.0:
            return SLDecision()
        be = _be_or_better(state)
        # If we're newly past 1R and SL is still below entry, bump to BE first.
        if (state.side == "LONG" and state.current_sl < state.entry_price) or (
            state.side == "SHORT" and state.current_sl > state.entry_price
        ):
            if be != state.current_sl:
                return SLDecision(new_sl=be, note="move_be@1R")
        new_sl = _trail_sl(state, current_price, atr)
        if new_sl == state.current_sl:
            return SLDecision()
        return SLDecision(new_sl=new_sl, note=f"trail@{r_mult:.2f}R")

    if rules.sl_management is SLManagement.TRAIL_FROM_ENTRY:
        # Sniper: trail tight from the start. Use a 0.5×ATR pull for sniper-like
        # behaviour so we don't get stopped immediately on entry-bar noise.
        new_sl = _trail_sl(state, current_price, atr, mult=0.5)
        if new_sl == state.current_sl:
            return SLDecision()
        return SLDecision(new_sl=new_sl, note=f"sniper_trail@{r_mult:.2f}R")

    return SLDecision()


def evaluate_tp(
    rules: TradeModeRules,
    state: PositionLifecycleState,
    current_price: float,
) -> SLDecision:
    """Per-mode TP policy. Returns a partial-take or no-op."""
    if rules.tp_management is TPManagement.FIXED:
        return SLDecision()

    if state.partial_taken:
        return SLDecision()

    r_mult = _r_multiple(state, current_price)
    if r_mult < 1.0:
        return SLDecision()

    if rules.tp_management in (TPManagement.PARTIAL_1R_REST_TP, TPManagement.PARTIAL_1R_REST_2R):
        return SLDecision(take_partial_fraction=0.5, note="partial_1R")

    return SLDecision()


def can_exit(rules: TradeModeRules, state: PositionLifecycleState) -> bool:
    """Bug 1 fix: refuse exit-by-signal until the per-mode min hold has elapsed.

    TP/SL hits are not gated here — they are price events, not signal events,
    and the caller checks them separately.
    """
    return state.bars_since_open >= rules.min_hold_bars
