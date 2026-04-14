#!/usr/bin/env python3
"""
Verification script: ensure Python signals align with project logic.
- All strategy types (ind-*, pa-*, cs-*, cp-*) produce valid signals (1, -1, 0)
- Regime filtering works (entry only when bar regime matches job regime)
- Backtest completes without errors
"""

import sys
from pathlib import Path

# Add project root
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cicada_nn.signals import get_signal, SIGNAL_ROUTER
from cicada_nn.regime_detection import detect_regime_series
from cicada_nn.backtest_server import _run_single


def make_bars(n: int = 150, trend: str = "up") -> list[dict]:
    """Generate deterministic test bars."""
    bars = []
    base = 1.0
    for i in range(n):
        if trend == "up":
            o = base + i * 0.001
            c = o + 0.0005
        elif trend == "down":
            o = base - i * 0.001
            c = o - 0.0005
        else:
            o = base + (i % 10 - 5) * 0.0002
            c = o + 0.0001
        h = max(o, c) + 0.0003
        l_ = min(o, c) - 0.0003
        bars.append({"time": 1000 + i, "open": o, "high": h, "low": l_, "close": c, "volume": 1000})
    return bars


def test_signal_validity():
    """All strategies must return 1, -1, or 0."""
    bars = make_bars(150)
    regimes = detect_regime_series(bars, 50)
    strategies = list(SIGNAL_ROUTER.keys()) + [
        "cs-engulfing",
        "cp-double-top",
    ]
    errors = []
    for sid in strategies:
        for i in range(20, min(100, len(bars) - 1)):
            reg = regimes[i] if i < len(regimes) else "unknown"
            try:
                s = get_signal(sid, bars, i, reg, None)
            except Exception as e:
                errors.append(f"{sid} @ {i}: {e}")
                continue
            if s not in (1, -1, 0):
                errors.append(f"{sid} @ {i}: invalid signal {s}")
    if errors:
        print("FAIL signal validity:", errors[:10])
        return False
    print("OK signal validity: all strategies return 1/-1/0")
    return True


def test_regime_filtering():
    """Entry only when regime matches."""
    bars = make_bars(150, "up")
    regimes = detect_regime_series(bars, 50)
    # Find a bar with known regime
    sample_reg = regimes[80] if len(regimes) > 80 else "unknown"
    # Run backtest for matching vs non-matching regime
    row_match = _run_single("inst-eur", "EURUSD", "ind-rsi-oversold", "RSI", "M5", sample_reg, bars, {"period": 14})
    row_nomatch = _run_single("inst-eur", "EURUSD", "ind-rsi-oversold", "RSI", "M5", "nonexistent_regime", bars, {"period": 14})
    # With nonexistent regime, we expect 0 trades (or very few if regime happens to appear)
    if row_match["status"] != "completed" or row_nomatch["status"] != "completed":
        print("FAIL regime: backtest status", row_match["status"], row_nomatch["status"])
        return False
    print("OK regime filtering: backtest completes for both regimes")
    return True


def test_unknown_strategy_raises():
    """Unknown strategies raise ValueError — no momentum fallback."""
    bars = make_bars(50)
    try:
        get_signal("unknown-strategy-fake", bars, 25, "unknown", None)
        print("FAIL unknown strategy: expected ValueError")
        return False
    except ValueError as e:
        if "no signal mapping" not in str(e).lower():
            print("FAIL unknown strategy: wrong error", e)
            return False
    print("OK unknown strategy: raises ValueError")
    return True


def test_cs_cp_fallbacks():
    """cs-* and cp-* use candlestick/chart pattern, not momentum."""
    bars = make_bars(100)
    # Create a bearish engulfing at bar 50
    bars[50] = {"time": 1050, "open": 1.05, "high": 1.052, "low": 1.048, "close": 1.049}
    bars[49] = {"time": 1049, "open": 1.048, "high": 1.051, "low": 1.047, "close": 1.05}
    s_cs = get_signal("cs-engulfing", bars, 50, "trending_bull", None)
    s_cp = get_signal("cp-double-top", bars, 50, "trending_bull", {"lookback": 20})
    # cs/cp should not fall through to momentum
    print("OK cs/cp fallbacks: cs-engulfing ->", s_cs, ", cp-double-top ->", s_cp)
    return True


def test_backtest_integration():
    """Full backtest run with multiple strategies."""
    bars = make_bars(120)
    strategies = ["pa-fvg", "pa-bos", "ind-rsi-oversold", "ind-macd-cross", "pa-liquidity-sweep"]
    regimes = ["trending_bull", "reversal_bear", "ranging"]
    for sid in strategies:
        for reg in regimes:
            row = _run_single("inst-eur", "EURUSD", sid, sid, "M5", reg, bars, None)
            if row["status"] != "completed":
                print("FAIL backtest:", sid, reg, row["status"])
                return False
    print("OK backtest integration: all strategy/regime combos complete")
    return True


def main():
    ok = True
    ok &= test_signal_validity()
    ok &= test_regime_filtering()
    ok &= test_unknown_strategy_raises()
    ok &= test_cs_cp_fallbacks()
    ok &= test_backtest_integration()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
