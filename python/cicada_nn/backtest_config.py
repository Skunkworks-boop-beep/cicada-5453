"""
Backtest execution config. Mirrors frontend config.ts BACKTEST_CONFIG.
Overridable via env vars (CICADA_BACKTEST_*) or request payload.
"""

from __future__ import annotations

import os


def _float_env(key: str, default: float) -> float:
    v = os.environ.get(key)
    if v is None or v == "":
        return default
    try:
        return float(v)
    except ValueError:
        return default


def _int_env(key: str, default: int) -> int:
    v = os.environ.get(key)
    if v is None or v == "":
        return default
    try:
        return int(v)
    except ValueError:
        return default


# Env vars: CICADA_BACKTEST_INITIAL_EQUITY, CICADA_BACKTEST_SPREAD_PCT, etc.
BACKTEST_CONFIG = {
    "initial_equity": _float_env("CICADA_BACKTEST_INITIAL_EQUITY", 10_000.0),
    "spread_pct": _float_env("CICADA_BACKTEST_SPREAD_PCT", 0.0001),
    "slippage_pct": _float_env("CICADA_BACKTEST_SLIPPAGE_PCT", 0.00005),
    "risk_per_trade_pct": _float_env("CICADA_BACKTEST_RISK_PER_TRADE_PCT", 0.01),
    "stop_loss_pct": _float_env("CICADA_BACKTEST_STOP_LOSS_PCT", 0.02),
    "take_profit_r": _float_env("CICADA_BACKTEST_TAKE_PROFIT_R", 2.0),
    "regime_lookback": _int_env("CICADA_BACKTEST_REGIME_LOOKBACK", 50),
}


def get_backtest_config(overrides: dict | None = None) -> dict:
    """Merge request overrides with env/default config."""
    cfg = dict(BACKTEST_CONFIG)
    if overrides:
        for k, v in overrides.items():
            if v is not None:
                cfg[k] = v
    return cfg
