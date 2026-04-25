"""
Transaction cost model for CICADA-5453 backtests.

Previous backtests only charged spread + a flat slippage fraction on every
fill. That systematically overstates backtest P&L because:

* Forex + indices carry a swap (overnight financing) when the position is held
  across the daily cut-off. Scalps avoid it, swings don't.
* Crypto CFDs often charge 24h funding even intraday on some brokers.
* Broker commissions (per round-trip, per lot) on tight-spread accounts are
  real and matter for scalp strategies where net edge per trade is small.
* Stop / limit fills do experience worse slippage than market fills during
  volatile bars because the book thins out at barriers.

This module centralises all of the above so both backtest engines (TS + Python)
charge a realistic cost. Defaults are conservative retail values; any broker-
specific value can be passed through via config.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CostConfig:
    """Per-instrument-type cost parameters (fractional, applied on notional)."""

    commission_roundtrip_pct: float = 0.0
    swap_long_daily_pct: float = 0.0
    swap_short_daily_pct: float = 0.0
    base_slippage_pct: float = 5e-5
    stop_slippage_mult: float = 2.0  # stops/limits typically experience worse fills


# Reasonable defaults by instrument type. Users can override via env or a
# backtest config payload.
DEFAULT_COSTS_BY_TYPE: dict[str, CostConfig] = {
    "fiat": CostConfig(
        commission_roundtrip_pct=5e-5,    # ~0.5 pip/lot round trip on a decent ECN account
        swap_long_daily_pct=-6e-6,        # small negative (holding cost) by default
        swap_short_daily_pct=-6e-6,
        base_slippage_pct=3e-5,
        stop_slippage_mult=2.0,
    ),
    "crypto": CostConfig(
        commission_roundtrip_pct=2e-4,     # 0.02% round trip
        swap_long_daily_pct=-5e-4,         # meaningful funding on crypto CFDs
        swap_short_daily_pct=-5e-4,
        base_slippage_pct=1e-4,
        stop_slippage_mult=3.0,
    ),
    "synthetic_deriv": CostConfig(
        commission_roundtrip_pct=0.0,      # Deriv builds cost into the spread
        swap_long_daily_pct=0.0,
        swap_short_daily_pct=0.0,
        base_slippage_pct=2e-5,
        stop_slippage_mult=1.5,
    ),
    "indices_exness": CostConfig(
        commission_roundtrip_pct=8e-5,
        swap_long_daily_pct=-4e-5,
        swap_short_daily_pct=-2e-5,
        base_slippage_pct=5e-5,
        stop_slippage_mult=2.5,
    ),
}


BARS_PER_TRADING_DAY: dict[str, float] = {
    "M1": 1440,
    "M5": 288,
    "M15": 96,
    "M30": 48,
    "H1": 24,
    "H4": 6,
    "D1": 1,
    "W1": 1 / 5,
}


def cost_for_type(instrument_type: str) -> CostConfig:
    return DEFAULT_COSTS_BY_TYPE.get(instrument_type, DEFAULT_COSTS_BY_TYPE["fiat"])


def commission(notional: float, instrument_type: str) -> float:
    """Round-trip commission charged at trade close, in account currency.

    We spread the round-trip cost across open and close so backtests don't
    double-charge if only close events are summed; callers should apply this
    once per closed trade.
    """
    return max(0.0, notional * cost_for_type(instrument_type).commission_roundtrip_pct)


def swap_accrual(
    notional: float,
    instrument_type: str,
    hold_bars: int,
    timeframe: str,
    side: int,
) -> float:
    """Cumulative swap charge over ``hold_bars`` at ``timeframe``.

    ``side == 1`` for long, ``-1`` for short. Negative return means a cost.
    """
    cfg = cost_for_type(instrument_type)
    per_day = cfg.swap_long_daily_pct if side == 1 else cfg.swap_short_daily_pct
    bars_per_day = BARS_PER_TRADING_DAY.get(timeframe.upper(), 24.0)
    days = hold_bars / bars_per_day if bars_per_day else 0.0
    return notional * per_day * days


def fill_slippage_pct(
    base_slippage: float | None,
    instrument_type: str,
    exit_reason: str = "signal",
) -> float:
    """Slippage fraction to apply on the fill price for a given exit kind."""
    cfg = cost_for_type(instrument_type)
    base = base_slippage if base_slippage is not None else cfg.base_slippage_pct
    mult = cfg.stop_slippage_mult if exit_reason in {"stop", "target"} else 1.0
    return max(0.0, float(base) * float(mult))
