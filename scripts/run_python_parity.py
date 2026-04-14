#!/usr/bin/env python3
"""
Parity test helper: regime, signals, or backtest.
Usage:
  python run_python_parity.py regime <bars.json> [lookback]
  python run_python_parity.py signals <bars.json> <strategy_id> [params.json]
  python run_python_parity.py backtest <bars.json> <strategy_id> <regime> [params.json]
Output: JSON to stdout.
"""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / "python"))

from cicada_nn.regime_detection import detect_regime_series
from cicada_nn.signals import get_signal
from cicada_nn.backtest_server import _run_single


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: regime|signals|backtest <path> ..."}), file=sys.stderr)
        sys.exit(1)
    mode = sys.argv[1]
    path = sys.argv[2]
    with open(path) as f:
        bars = json.load(f)

    if mode == "regime":
        lookback = int(sys.argv[3]) if len(sys.argv) > 3 else 50
        regimes = detect_regime_series(bars, lookback)
        print(json.dumps(regimes))

    elif mode == "signals":
        strategy_id = sys.argv[3]
        params = json.loads(sys.argv[4]) if len(sys.argv) > 4 else None
        regimes = detect_regime_series(bars, 50)
        signals = []
        for i in range(len(bars)):
            reg = regimes[i] if i < len(regimes) else "unknown"
            s = get_signal(strategy_id, bars, i, reg, params)
            signals.append(s)
        print(json.dumps(signals))

    elif mode == "backtest":
        strategy_id = sys.argv[3]
        regime = sys.argv[4]
        params = json.loads(sys.argv[5]) if len(sys.argv) > 5 else None
        row = _run_single(
            "inst-eur", "EURUSD", strategy_id, strategy_id, "M5", regime, bars, params
        )
        out = {
            "trades": row["trades"],
            "profit": row["profit"],
            "winRate": row["winRate"],
            "maxDrawdown": row["maxDrawdown"],
            "profitFactor": row["profitFactor"],
        }
        print(json.dumps(out))

    else:
        print(json.dumps({"error": f"Unknown mode: {mode}"}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
