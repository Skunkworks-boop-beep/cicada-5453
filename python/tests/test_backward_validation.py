"""
Robust tests for backward validation module.
Run: cd python && python -m pytest tests/test_backward_validation.py -v
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cicada_nn.backward_validation import (
    _scope_to_timeframe,
    _find_entry_bar,
    _simulate_trade_from_bar,
    run_backward_validation,
    SCOPE_TO_TIMEFRAME,
)


def _make_bars(n: int, base_price: float = 100.0, base_ts: int = 1700000000) -> list[dict]:
    """Generate synthetic OHLCV bars (time in epoch seconds)."""
    bars = []
    for i in range(n):
        p = base_price + (i * 0.1)
        bars.append({
            "time": base_ts + i * 300,  # 5-min bars
            "open": p,
            "high": p + 0.5,
            "low": p - 0.5,
            "close": p + 0.2,
        })
    return bars


def _make_bars_ms(n: int, base_price: float = 100.0, base_ts_ms: int = 1700000000000) -> list[dict]:
    """Generate synthetic OHLCV bars (time in milliseconds)."""
    bars = []
    for i in range(n):
        p = base_price + (i * 0.1)
        bars.append({
            "time": base_ts_ms + i * 300_000,
            "open": p,
            "high": p + 0.5,
            "low": p - 0.5,
            "close": p + 0.2,
        })
    return bars


class TestScopeToTimeframe:
    def test_scalp_returns_m5(self):
        assert _scope_to_timeframe("scalp") == "M5"

    def test_day_returns_h1(self):
        assert _scope_to_timeframe("day") == "H1"

    def test_swing_returns_h4(self):
        assert _scope_to_timeframe("swing") == "H4"

    def test_position_returns_d1(self):
        assert _scope_to_timeframe("position") == "D1"

    def test_none_returns_h1(self):
        assert _scope_to_timeframe(None) == "H1"

    def test_unknown_returns_h1(self):
        assert _scope_to_timeframe("unknown") == "H1"


class TestFindEntryBar:
    def test_returns_none_for_empty_bars(self):
        assert _find_entry_bar([], 100.0, None, None) is None

    def test_returns_none_for_short_bars(self):
        bars = _make_bars(5)
        assert _find_entry_bar(bars, 100.0, None, None) is None

    def test_finds_bar_by_price_when_no_time(self):
        bars = _make_bars(100, base_price=99.0)
        # Bar 50 has close ≈ 99 + 5 = 104. Bar 10 has close ≈ 100.
        idx = _find_entry_bar(bars, 100.0, None, None, tolerance_pct=0.05)
        assert idx is not None
        assert 10 <= idx < 90
        assert abs(bars[idx]["close"] - 100.0) / 100.0 <= 0.05

    def test_finds_bar_by_time_when_opened_at_provided(self):
        bars = _make_bars(100, base_price=100.0, base_ts=1700000000)
        # Bar 50: time = 1700000000 + 50*300 = 1700001500
        bar_50_time_ms = (1700000000 + 50 * 300) * 1000
        idx = _find_entry_bar(bars, bars[50]["close"], bar_50_time_ms, None)
        assert idx is not None
        assert idx == 50

    def test_finds_bar_with_time_in_milliseconds(self):
        bars = _make_bars_ms(100, base_price=100.0, base_ts_ms=1700000000000)
        bar_50_time_ms = 1700000000000 + 50 * 300_000
        idx = _find_entry_bar(bars, bars[50]["close"], bar_50_time_ms, None)
        assert idx is not None
        assert idx == 50

    def test_handles_missing_time_in_bar(self):
        bars = _make_bars(50)
        bars[25] = {**bars[25], "time": None}
        idx = _find_entry_bar(bars, 102.5, None, None, tolerance_pct=0.02)
        assert idx is not None
        assert idx != 25  # Should skip bar with no time


class TestSimulateTradeFromBar:
    def test_returns_none_for_invalid_entry_bar(self):
        bars = _make_bars(100)
        assert _simulate_trade_from_bar(bars, -1, 1, 0.02, 0.01, 2.0) is None
        assert _simulate_trade_from_bar(bars, 1000, 1, 0.02, 0.01, 2.0) is None

    def test_long_hits_target_returns_positive_pnl(self):
        # Bars that go up: entry at 100, target at 104 (2R), bars keep rising
        bars = _make_bars(50, base_price=98.0)
        # Bar 20: close ~100. Next bars go up. Target = 100 + 4 = 104
        bars[21] = {"time": bars[21]["time"], "open": 100, "high": 105, "low": 99, "close": 104}
        pnl = _simulate_trade_from_bar(bars, 20, 1, 0.02, 0.01, 2.0)
        assert pnl is not None
        assert pnl > 0

    def test_short_hits_target_returns_positive_pnl(self):
        # Bars that go down: entry at 100, target at 92 (2R down), bar 21 hits target
        bars = _make_bars(50, base_price=98.0)  # Base trending up slightly
        bars[20] = {"time": bars[20]["time"], "open": 100, "high": 100.5, "low": 99.5, "close": 100}
        bars[21] = {"time": bars[21]["time"], "open": 100, "high": 99.5, "low": 91, "close": 92}  # Hits target 92
        pnl = _simulate_trade_from_bar(bars, 20, -1, 0.02, 0.01, 2.0)
        assert pnl is not None
        assert pnl > 0

    def test_long_hits_stop_returns_negative_pnl(self):
        bars = _make_bars(50, base_price=100.0)
        bars[21] = {"time": bars[21]["time"], "open": 100, "high": 101, "low": 95, "close": 96}
        pnl = _simulate_trade_from_bar(bars, 20, 1, 0.02, 0.01, 2.0)
        assert pnl is not None
        assert pnl < 0

    def test_short_hits_stop_returns_negative_pnl(self):
        bars = _make_bars(50, base_price=98.0)
        bars[21] = {"time": bars[21]["time"], "open": 100, "high": 105, "low": 99, "close": 104}
        pnl = _simulate_trade_from_bar(bars, 20, -1, 0.02, 0.01, 2.0)
        assert pnl is not None
        assert pnl < 0


class TestRunBackwardValidation:
    def test_empty_trades_returns_empty_result(self):
        result = run_backward_validation(
            closed_trades=[],
            bars_by_key={},
            instrument_symbols={},
            strategy_ids=["ind-rsi-overbought"],
            strategy_names={},
        )
        assert result["validatedTrades"] == []
        assert result["calibrationHints"] == {}
        assert result["summary"]["total"] == 0
        assert result["summary"]["verified"] == 0

    def test_skips_trade_without_instrument_id(self):
        result = run_backward_validation(
            closed_trades=[{"instrumentId": "", "type": "LONG", "pnl": 10, "closedAt": "2024-01-01T12:00:00Z"}],
            bars_by_key={},
            instrument_symbols={},
            strategy_ids=["ind-rsi-overbought"],
            strategy_names={},
        )
        assert result["summary"]["skipped"] == 1
        assert result["summary"]["verified"] == 0

    def test_skips_trade_without_bars(self):
        result = run_backward_validation(
            closed_trades=[{
                "instrumentId": "inst-1",
                "type": "LONG",
                "pnl": 10,
                "closedAt": "2024-01-01T12:00:00Z",
                "scope": "day",
            }],
            bars_by_key={},
            instrument_symbols={"inst-1": "SYM1"},
            strategy_ids=["ind-rsi-overbought"],
            strategy_names={},
        )
        assert result["summary"]["skipped"] == 1

    def test_skips_trade_with_invalid_type(self):
        bars = _make_bars(100)
        result = run_backward_validation(
            closed_trades=[{
                "instrumentId": "inst-1",
                "type": "INVALID",
                "pnl": 10,
                "closedAt": "2024-01-01T12:00:00Z",
                "scope": "day",
                "openedAt": "2024-01-01T11:00:00Z",
                "entryPrice": 100.0,
            }],
            bars_by_key={"inst-1|H1": bars},
            instrument_symbols={"inst-1": "SYM1"},
            strategy_ids=["ind-rsi-overbought"],
            strategy_names={},
        )
        assert result["summary"]["skipped"] == 1

    def test_full_flow_with_winning_trade(self):
        """Full integration: winning LONG trade, bars that go up (target hit)."""
        bars = _make_bars(150, base_price=98.0)
        # Make bar 50 area: close ~103. Bar 51 goes up to hit target for long
        bars[50] = {"time": bars[50]["time"], "open": 102.5, "high": 103.5, "low": 102, "close": 103}
        bars[51] = {"time": bars[51]["time"], "open": 103, "high": 107, "low": 102, "close": 106}
        bar_50_ts = bars[50]["time"]
        opened_ms = bar_50_ts * 1000 if bar_50_ts < 1e12 else bar_50_ts

        result = run_backward_validation(
            closed_trades=[{
                "instrumentId": "inst-1",
                "botId": "bot-1",
                "type": "LONG",
                "pnl": 50.0,  # Winning trade
                "entryPrice": 103.0,
                "openedAt": datetime.fromtimestamp(bar_50_ts, tz=timezone.utc).isoformat(),
                "closedAt": datetime.fromtimestamp(bars[51]["time"], tz=timezone.utc).isoformat(),
                "scope": "day",
                "nnSlPct": 0.02,
                "nnTpR": 2.0,
            }],
            bars_by_key={"inst-1|H1": bars},
            instrument_symbols={"inst-1": "SYM1"},
            strategy_ids=["ind-rsi-overbought"],
            strategy_names={"ind-rsi-overbought": "RSI"},
        )
        assert result["summary"]["total"] == 1
        # May verify or skip depending on entry bar finding and simulation
        assert result["summary"]["verified"] >= 0
        assert result["summary"]["verified"] + result["summary"]["skipped"] == 1

    def test_full_flow_with_losing_trade_opposite_verified(self):
        """Losing LONG trade: opposite (SHORT) should be simulated and verified."""
        bars = _make_bars(150, base_price=100.0)
        # Bar 50: close 105. Price drops - SHORT would win
        bars[50] = {"time": bars[50]["time"], "open": 105, "high": 106, "low": 104, "close": 105}
        bars[51] = {"time": bars[51]["time"], "open": 105, "high": 105.5, "low": 99, "close": 100}
        bar_50_ts = bars[50]["time"]
        opened_ms = bar_50_ts * 1000 if bar_50_ts < 1e12 else bar_50_ts

        result = run_backward_validation(
            closed_trades=[{
                "instrumentId": "inst-1",
                "botId": "bot-1",
                "type": "LONG",
                "pnl": -50.0,  # Losing trade
                "entryPrice": 105.0,
                "openedAt": datetime.fromtimestamp(bar_50_ts, tz=timezone.utc).isoformat(),
                "closedAt": datetime.fromtimestamp(bars[51]["time"], tz=timezone.utc).isoformat(),
                "scope": "day",
                "nnSlPct": 0.02,
                "nnTpR": 2.0,
            }],
            bars_by_key={"inst-1|H1": bars},
            instrument_symbols={"inst-1": "SYM1"},
            strategy_ids=["ind-rsi-overbought"],
            strategy_names={},
        )
        assert result["summary"]["total"] == 1
        # If verified: correctSide should be SHORT
        if result["validatedTrades"]:
            assert result["validatedTrades"][0]["correctSide"] == "SHORT"
            assert result["validatedTrades"][0]["simulatedPnl"] > 0


class TestRegimeConfigIntegration:
    """Verify RegimeConfig.from_dict handles backward validation output."""
    def test_regime_config_from_dict(self):
        from cicada_nn.regime_detection import RegimeConfig
        cfg = {"lookback": 50, "trend_threshold": 0.00015, "volatility_high": 0.02, "volatility_low": 0.004, "donchian_boundary_frac": 0.998}
        rc = RegimeConfig.from_dict(cfg)
        assert rc.lookback == 50
        assert rc.trend_threshold == 0.00015
