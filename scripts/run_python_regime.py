#!/usr/bin/env python3
"""Helper for regime parity test: load bars from JSON path, run detect_regime_series, print JSON."""
import json
import sys
from pathlib import Path

# Add python/ so cicada_nn is importable
root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / "python"))
from cicada_nn.regime_detection import detect_regime_series

def main():
    path = sys.argv[1]
    lookback = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    with open(path) as f:
        bars = json.load(f)
    regimes = detect_regime_series(bars, lookback)
    print(json.dumps(regimes))

if __name__ == "__main__":
    main()
