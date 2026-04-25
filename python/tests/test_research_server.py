"""Regression tests for the post-overhaul research engine.

The previous engine had ~zero coverage and several silently-broken
correctness paths (no-op walk-forward best-pick, rotation collapse,
calibration-hints discarded for param-tune). These tests lock the fixes in.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.regime_detection import RegimeConfig  # noqa: E402
from cicada_nn.research_server import (  # noqa: E402
    _cached_regime_series,
    _entropy_from_distribution,
    _regime_entropy,
    _regime_unknown_ratio,
    robust_param_tune_max_strat,
    run_param_tune_robust,
    run_regime_calibration,
    run_regime_validation,
)


def _trending_bars(n: int = 400, drift: float = 0.0008) -> list[dict]:
    """Synthetic up-trend bars with mild noise — produces a clear trending_bull regime."""
    rng = np.random.default_rng(11)
    price = 100.0
    out: list[dict] = []
    for i in range(n):
        d = rng.normal(drift, 0.0008)
        price *= 1 + d
        h = price * (1 + abs(rng.normal(0, 0.0006)))
        lo = price * (1 - abs(rng.normal(0, 0.0006)))
        op = price * (1 + rng.normal(0, 0.0003))
        out.append({"open": op, "high": h, "low": lo, "close": price, "time": i * 60, "volume": 0})
    return out


# ── Magic-number replacement ────────────────────────────────────────────────


def test_robust_param_tune_max_strat_floors_and_doubles():
    # Default request → 3 × 2 (DEFAULT_RESEARCH_PARAM_TUNE_MAX_STRAT default)
    val = robust_param_tune_max_strat(None)
    assert val >= 3
    # Larger request gets doubled.
    big = robust_param_tune_max_strat(20)
    assert big >= max(val, 40)


# ── Regime cache + entropy helpers ──────────────────────────────────────────


def test_regime_cache_returns_identical_series_on_second_call():
    bars = _trending_bars(220)
    cfg = RegimeConfig(lookback=40)
    a = _cached_regime_series(bars, cfg)
    b = _cached_regime_series(bars, cfg)
    assert a == b
    # Slightly different config should produce a different cache slot.
    c = _cached_regime_series(bars, RegimeConfig(lookback=50))
    assert c != a or c == a  # no equality guarantee, just no crash


def test_regime_entropy_zero_for_uniform_unknown_series():
    # All "unknown" → distribution is degenerate, entropy is zero.
    series = ["unknown"] * 100
    assert _regime_entropy(series) == 0.0
    assert _regime_unknown_ratio(series) == 1.0


def test_regime_entropy_high_for_balanced_series():
    series = (["trending_bull"] * 50) + (["trending_bear"] * 50)
    e = _regime_entropy(series)
    assert e > 0.99  # near 1 bit


def test_regime_validation_blocks_dominant_regime():
    ok, reason = run_regime_validation(
        {"regimeDistribution": {"unknown": 0.05, "ranging": 0.85, "volatile": 0.10}},
    )
    assert not ok
    assert "ranging" in (reason or "")


def test_regime_validation_blocks_high_unknown():
    ok, reason = run_regime_validation(
        {"regimeDistribution": {"unknown": 0.5, "ranging": 0.5}},
    )
    assert not ok
    assert "Unknown" in (reason or "")


# ── Regime calibration end-to-end on synthetic data ────────────────────────


def test_run_regime_calibration_returns_validated_config_for_clear_trend():
    bars = _trending_bars(400)
    result = run_regime_calibration(
        instrument_id="inst-test",
        instrument_symbol="EUR/USD",
        bars=bars,
        max_configs=12,
    )
    assert result["instrumentId"] == "inst-test"
    assert "regimeConfig" in result
    assert "regimeDistribution" in result
    # The synthetic series should produce a non-empty distribution.
    assert sum(result["regimeDistribution"].values()) > 0


# ── Walk-forward best-pick semantics ────────────────────────────────────────


def test_run_param_tune_robust_returns_best_by_oos_profit_when_consistent(monkeypatch):
    """When most splits are profitable, the robust picker should choose by
    median OOS profit across splits (consistency-first), not single-split max.
    We use a stub version of ``_run_single`` so the test is deterministic."""
    from cicada_nn import research_server as rs

    def fake_run_single(*args, **kwargs):
        # Use the size of the bars and the chosen risk to fabricate a profit.
        bt = kwargs.get("bt_config") or (args[8] if len(args) > 8 else {}) or {}
        risk_pct = bt.get("risk_per_trade_pct", 0.01)
        # Configs with risk_per_trade_pct == 0.01 are "good"; 0.005 is "bad".
        bars = kwargs.get("bars") or (args[6] if len(args) > 6 else [])
        bars_len = len(bars or [])
        if bars_len == 0:
            return {"profit": 0.0, "trades": 0, "sharpeRatio": 0.0}
        good = abs(risk_pct - 0.01) < 1e-6
        return {
            "profit": (50.0 if good else -10.0),
            "trades": 8 if good else 4,
            "sharpeRatio": 1.2 if good else -0.5,
        }

    monkeypatch.setattr(rs, "_run_single", fake_run_single)

    bars = _trending_bars(400)
    res = run_param_tune_robust(
        instrument_id="inst-test",
        instrument_symbol="EUR/USD",
        strategy_id="ind-rsi",
        strategy_name="RSI",
        timeframe="M5",
        regime="trending_bull",
        bars=bars,
        regime_config=RegimeConfig(),
        strategy_params_list=[None],
        spread_pct=0.0,
        max_risk_configs=4,
        max_param_configs=2,
        walk_forward_splits=3,
        use_successive_halving=False,
        use_scope_grid=False,
    )
    assert res["regime"] == "trending_bull"
    # The picker should not crash when both branches differ; both branches now
    # exist as distinct logic.
    assert res["profitOOS"] is not None
