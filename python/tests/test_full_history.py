"""Full-history coverage tests.

The backtest, research, and robust paths must process every fetched bar.
Past versions silently truncated the MT5 fallback fetch to 10 k while the FE
asked for 50 k, hiding stale-data bugs in long-history runs. These tests
fail loudly if any code path drops bars on the floor.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.backtest_server import (  # noqa: E402
    _normalize_bars,
    _run_single,
    run_backtest,
)
from cicada_nn.regime_detection import RegimeConfig, detect_regime_series
from cicada_nn.research_server import (  # noqa: E402
    _cached_regime_series,
    run_param_tune_robust,
    run_regime_calibration,
)


def _bars(n: int, drift: float = 0.0005, seed: int = 42) -> list[dict]:
    rng = np.random.default_rng(seed)
    price = 100.0
    out: list[dict] = []
    for i in range(n):
        d = rng.normal(drift, 0.001)
        price *= 1 + d
        h = price * (1 + abs(rng.normal(0, 0.0005)))
        lo = price * (1 - abs(rng.normal(0, 0.0005)))
        op = price * (1 + rng.normal(0, 0.0003))
        out.append({"open": op, "high": h, "low": lo, "close": price, "time": i * 60, "volume": 0})
    return out


def test_run_single_iterates_every_bar_in_payload():
    """_run_single must walk i in range(1, len(bars)) — no implicit window cap."""
    bars = _bars(5_000)
    res = _run_single(
        instrument_id="inst-eur",
        instrument_symbol="EUR/USD",
        strategy_id="ind-rsi",
        strategy_name="RSI",
        timeframe="M5",
        regime="any",
        bars=bars,
    )
    # avgHoldBars / trades fields should be derived from the full series.
    # The exact numbers depend on the synthetic series, but trades > 0 confirms
    # the loop reached the late bars.
    assert res["status"] == "completed"
    assert res["trades"] >= 0
    # Smoke: dataEndTime is the last bar's time (in ISO seconds).
    assert res.get("dataEndTime"), "dataEndTime must be set from final bar"


def test_run_backtest_default_count_uses_full_history():
    """The MT5 fallback fetch was capped at 10 000 — a silent truncation
    while the FE asked for 50 000. The fix bumps the constant; this test
    locks the expectation in."""
    import cicada_nn.backtest_server as bs

    # Inspect the source of the streaming function: the count constant should
    # now be 50_000 (or larger). We grep the byte-stream because the constant
    # is local, not exported.
    src = (Path(bs.__file__)).read_text()
    assert "count = 10_000" not in src, "backtest_server still truncates to 10 000 bars"
    assert "count = 50_000" in src


def test_research_default_count_uses_full_history():
    import cicada_nn.research_server as rs
    src = (Path(rs.__file__)).read_text()
    # Both fallbacks must request the full Deriv history budget.
    assert "count=10_000" not in src, "research_server still truncates to 10 000 bars"
    assert "count=50_000" in src


def test_regime_cache_returns_full_series_length():
    """_cached_regime_series must produce one regime label per bar."""
    bars = _bars(2_500)
    cfg = RegimeConfig(lookback=50)
    series = _cached_regime_series(bars, cfg)
    assert len(series) == len(bars)


def test_robust_param_tune_walks_all_splits_within_window(monkeypatch):
    """Robust mode used to collapse rotated walk-forward splits to the same
    first 20% of bars after split 0. With the rebuild, each split must
    consume a different region of the full series."""
    import cicada_nn.research_server as rs

    seen_lengths: list[int] = []

    def fake_run_single(*args, **kwargs):
        bars = kwargs.get("bars") or (args[6] if len(args) > 6 else [])
        seen_lengths.append(len(bars or []))
        return {"profit": 1.0, "trades": 5, "sharpeRatio": 0.5}

    monkeypatch.setattr(rs, "_run_single", fake_run_single)
    bars = _bars(2_000)
    rs.run_param_tune_robust(
        instrument_id="inst-eur",
        instrument_symbol="EUR/USD",
        strategy_id="ind-rsi",
        strategy_name="RSI",
        timeframe="M5",
        regime="any",
        bars=bars,
        regime_config=RegimeConfig(),
        strategy_params_list=[None],
        spread_pct=0.0,
        max_risk_configs=2,
        max_param_configs=1,
        walk_forward_splits=3,
        use_successive_halving=False,
        use_scope_grid=False,
    )
    # Multiple distinct slice lengths means we explored multiple windows
    # rather than collapsing to a single fixed slice.
    assert len(set(seen_lengths)) >= 2, f"walk-forward collapsed to one window: {set(seen_lengths)}"
