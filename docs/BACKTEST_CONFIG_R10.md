# Backtest Configuration for R_10 (Volatility 10)

## Strategy–Instrument Configuration

Each strategy has **instrument-specific configuration** in `strategyInstrumentConfig.ts`:

- **Volatility (R_*)**: Oscillators (RSI, Stoch, CCI, MFI), BB squeeze, FVG, BOS, liquidity sweep — wider stops (4–5%), lower risk (0.5%)
- **Crash/Boom**: Breakout, ATR, exhaustion — very wide stops (5–6%), lowest risk (0.4–0.5%)
- **Forex/Indices**: Trend (EMA, MACD, ADX), chart patterns — standard 2% stop, 1% risk

Backtest applies per-job overrides: `instrumentId|strategyId` → risk params. Use `getRecommendedStrategiesForInstrument(symbol)` to filter strategies by instrument.

## Instrument-Specific Risk (Automatic)

The backtest now uses **instrument-specific risk management**:

1. **Registry defaults** — Known instruments (R_10, CRASH/BOOM, forex, indices) get preset stop/risk/target from `instrumentRisk.ts`.
2. **Data-driven analysis** — When using the remote server, bars are analyzed (ATR%, volatility) and risk params are derived per instrument before running.
3. **Per-instrument overrides** — You can pass `instrumentRiskOverrides` in the request to override any instrument.

R_10 defaults: stop 4%, risk 0.5%, target 1.5R.

## Why So Many $0 and Losses?

1. **Regime explosion** — By default the backtest ran 10 jobs per strategy×timeframe×instrument (one per regime). Most regime-specific jobs (trending_bull, ranging, etc.) produce $0 because the market rarely stays in that regime long enough. **Fix:** Use "Any only" regime filter (now the default in Backtest Engine).

2. **Stop/target defaults** — Default 2% stop, 2R target. For R_10 (volatile), 2% can be hit quickly; 2R may be hard to reach. Consider wider stop, lower target.

3. **Spread** — Ensure Deriv is connected so live spread is used. Without it, default 0.01% may understate costs.

## Recommended Setup for R_10

| Setting | Default | R_10 suggestion |
|---------|---------|------------------|
| Regime filter | All (10×) | **Any only** (1×) |
| Stop loss | 2% | 3–4% (wider for volatility) |
| Take profit R | 2 | 1.5–2 |
| Risk per trade | 1% | 0.5% (smaller size) |

## Env Overrides

Create `.env` or set before run:

```
VITE_BACKTEST_STOP_LOSS_PCT=0.04
VITE_BACKTEST_TAKE_PROFIT_R=1.5
VITE_BACKTEST_RISK_PER_TRADE_PCT=0.005
```

Python backend (when using remote server):

```
CICADA_BACKTEST_STOP_LOSS_PCT=0.04
CICADA_BACKTEST_TAKE_PROFIT_R=1.5
CICADA_BACKTEST_RISK_PER_TRADE_PCT=0.005
```

## Data Source

Backtest requires **live data** (Deriv or MT5). Connect in Brokers before running. No synthetic fallback.
