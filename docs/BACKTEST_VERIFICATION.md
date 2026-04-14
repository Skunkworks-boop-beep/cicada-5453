# Backtest Verification

This document describes how the backtest works and how to verify it produces real results.

## Architecture

| Mode | Where it runs | Data source | Strategy logic |
|------|---------------|-------------|----------------|
| **Client-side** | Browser (TypeScript) | Deriv ticks_history or MT5 /mt5/ohlc | Full strategy library (RSI, MACD, BB, FVG, BOS, etc.) via `getSignalFn` |
| **Server-side** | Python backend | Bars sent by frontend or MT5 | Same logic via `get_signal` (SIGNAL_ROUTER + fallbacks) + **regime filtering** |

## Requirements for Backtest to Run

1. **Broker connected**: Deriv or MT5 must be connected in the Brokers panel.
2. **Active instruments**: At least one instrument with status "active".
3. **Enabled strategies**: At least one strategy enabled in the Strategy Library.
4. **Timeframes selected**: At least one timeframe selected in the Backtest Engine.

Without a broker, you will see: *"Deriv must be connected"* or *"MT5 must be connected"*.

## Client-Side Backtest (No Server Offload URL)

- Runs entirely in the browser.
- Uses real strategy signals (RSI, MACD, Bollinger Bands, etc.).
- Regime detection per bar; only enters when `regime_at_bar === job_regime`.
- Progress updates incrementally; ETA is rate-based.
- **Server logs**: Only `GET /health` and `GET /mt5/status` (no `POST /backtest`).

## Server-Side Backtest (Server Offload URL Set)

- Frontend fetches OHLC from Deriv/MT5, then `POST /backtest` with bars.
- Python runs momentum strategy with **regime filtering** (aligned with frontend).
- Each regime produces different results (trades only when bar regime matches).
- **Server logs**: `POST /backtest` when you run.

## Known Limitations

1. **Strategy parity**: All 236 strategies are mapped in Python `SIGNAL_ROUTER` (or cs-/cp-/ind-/pa- fallbacks). Server uses real signal logic — RSI, MACD, BB, FVG, BOS, liquidity sweep, breakout retest, candlestick, chart pattern, structure. No momentum fallback for registry strategies.

2. **Consistent pattern**: If you saw identical rows per regime before, that was a bug (fixed). The server now filters by regime so each regime produces different trades.

## Verification Steps

### 1. Client-side (no remote URL)

```bash
# Clear Server Offload URL in the app, connect Deriv or MT5, then:
# 1. Run backtest
# 2. Check that results vary by strategy, timeframe, regime
# 3. Hover over result cards — each shows instrument, strategy, win rate, trades
```

### 2. Server-side

```bash
cd python && source venv/bin/activate
python -c "
from cicada_nn.backtest_server import run_backtest
bars = [{'time': 1000000+i*3600, 'open': 1.0, 'high': 1.002, 'low': 0.998, 'close': 1.0 + (i % 10)*0.0001} for i in range(200)]
result = run_backtest(
    instrument_ids=['inst-eurusd'],
    strategy_ids=['ind-rsi-div'],
    strategy_names={'ind-rsi-div': 'RSI'},
    timeframes=['M5'],
    regimes=['trending_bull', 'ranging'],
    instrument_symbols={'inst-eurusd': 'EURUSD'},
    date_from='', date_to='',
    bars={'inst-eurusd|M5': bars},
)
print('Regimes produce different results:', len(set(r['profit'] for r in result)) > 1)
"
```

### 3. Full wiring

```bash
bash scripts/verify-wiring.sh
```

## Result Display

- **Grid**: Each card = one result row (instrument × strategy × params × timeframe × regime).
- **Green** = profit ≥ 0; **Orange** = profit < 0.
- **Hover** = full details (strategy, win rate, trades, regime).
- **Pipeline**: OHLCV → REGIME → SIGNALS → EXECUTION → METRICS (visual stages during run).
