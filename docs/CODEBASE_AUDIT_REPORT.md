# CICADA-5453 Codebase Audit Report

**Date:** March 10, 2026  
**Scope:** Trade log, bot log, predictions, backtest engine, bot building

---

## 1. Trade Log / Closed Trades — Fake Values Issue

### Root Cause

The closed trades showing incorrect P/L (e.g. +$185.90 when account is in loss) was traced to:

1. **Persisted state**: `closedTradesByBot` is saved to localStorage and restored on load. Stale or wrong data from a previous session persists across reloads.
2. **Broker disconnect**: When the user disconnects the broker, the app continued to display closed trades from the previous session without indicating they were stale.
3. **MT5/eXness estimated P/L**: For MT5 and eXness, when a position disappears from the broker list, the app infers it as closed and computes P/L from `stopLoss ?? takeProfit ?? currentPrice ?? entryPrice`. There is no `getBrokerProfit` / deal history API, so P/L is estimated, not broker-confirmed.

### Fixes Implemented

- **Clear closed trades on broker disconnect**: When the source broker disconnects (or connection fails), `closedTradesByBot` is now cleared to avoid showing stale/wrong P/L.
- **Stale data warning**: When the broker is disconnected but closed trades exist, the Live Portfolio shows: *"Broker disconnected — closed trades below may be stale. Connect broker for live P/L."*

### Data Flow by Broker

| Broker | Closed trade source | P/L accuracy |
|--------|---------------------|--------------|
| **Deriv** | `profit_table` (broker API) — only records when contract_id matches | Broker-confirmed |
| **MT5** | Position diff + `getLiveExitPrice` (current bid/ask when position disappears) | Estimated |
| **eXness** | Position diff + `stopLoss ?? takeProfit ?? currentPrice ?? entryPrice` | Estimated |

### Recommendation

For MT5/eXness, add broker deal/history APIs when available (e.g. MT5 `history_deals_get`, Exness transaction history) to use broker-confirmed P/L for closed trades.

---

## 2. Predictions — Real vs Mock

### Verification

**Predictions are real.** There is no mock path.

- **Frontend**: `postPredict()` in `api.ts` calls `POST /predict` on the NN backend.
- **Backend**: `python/cicada_nn/api.py` loads the instrument-specific checkpoint, runs `model.predict_actions()` with regime/timeframe one-hot, and returns actions (0=LONG, 1=SHORT, 2=NEUTRAL).
- **Flow**: `runBotExecution` → `fetchOHLCV` → `detectRegime` → `selectScopeForTick` → `postPredict` → `tryOpenPosition` → `placeBrokerOrder` → `addPosition`.

### No Fake Computations

- `feature_vector` comes from the build response (`bot.nnFeatureVector`).
- Regime is from `detectRegime(bars)` on live OHLCV.
- No hardcoded or mock values between prediction and execution.

---

## 3. Backtest Engine — Strategy Diversity

### Verification

- **All strategies backtest**: Jobs are created as a Cartesian product of `instrumentIds × strategyIds × timeframes × regimes × paramCombinations`. Each job runs `runSingleBacktest` with its own `strategyId` and `getSignalFn(strategyId)`.
- **Per-instrument bars**: Bar cache key is `instrumentId|timeframe`. Different instruments use different bars; same instrument+timeframe share bars across strategies (correct).
- **Strategy diversity**: `scripts/verify-backtest-full.ts` now checks that different strategies (indicator + price-action) produce different profit values on the same bars. All checks pass.

---

## 4. Bot Building — Full Flow and Verification

### Prerequisites (enforced in order)

1. **Backend available** — `getHealth()` must succeed; else "Backend unavailable".
2. **Backtest completed** — `backtest.status === 'completed'` (not cancelled/failed); else "Run a backtest first" or "Full backtest required".
3. **Live data only** — `backtestResults.filter(r => r.dataSource === 'live')`; synthetic/disconnected results excluded. Else "Connect a broker and run backtest".
4. **Strategies selected** — `buildStrategyIds` from `bot.strategyIds` (or all enabled); must be non-empty and valid.
5. **Instrument in backtest** — `liveResults` must contain rows for `b.instrumentId` from `buildStrategyIds`; else "No live backtest results for X".
6. **Timeframes** — `bot.timeframes.length > 0`; else "Select at least one timeframe".
7. **Training rows** — After OOS split, `trainResults.length >= MIN_TRAINING_ROWS_FOR_BUILD` (5); else "Need at least 5 training rows".

### Data flow (step by step)

```
1. Filter: liveResults = backtest.results.filter(r => r.dataSource === 'live')
2. Filter: botInstrumentLive = liveResults.filter(
     r => r.instrumentId === b.instrumentId && buildStrategyIds.includes(r.strategyId)
   )
3. Split:  { train, validation } = splitBacktestResultsForOOS(botInstrumentLive, 0.8)
   → Train = first 80% by dataEndTime; validation never sent (no leakage)
4. Select: bestResults = getBestResultsForBuild(trainResults)
   → Keeps profitFactor >= 1 OR profit >= 0; fallback: top 75% by profit
5. Send:   postBuild(bestResults.length ? bestResults : trainResults, instrumentTypes)
6. Store:  nnFeatureVector = res.feature_vector (256-dim); strategyIds = usedStrategyIds
7. Reset:  resetBacktestResults() — user must rerun backtest to build another instrument
```

### Backend (Python)

- **Input**: `results` (instrumentId, strategyId, strategyParams, timeframe, regime, winRate, profit, trades, maxDrawdown, profitFactor, dataEndTime), `instrument_types`, `epochs`, `lr`.
- **Train**: `train()` builds feature vectors via `backtest_rows_to_features` (strategy win/profit, tf×regime win/profit), pads/truncates to 256 dim, trains InstrumentBotNN.
- **Output**: Checkpoint `instrument_bot_nn_{instrument_id}.pt`, meta JSON (strategy_id_to_idx, timeframe_to_idx, regime_to_idx), and `feature_vector` (256-dim) for inference.
- **Predict**: Loads checkpoint by `instrument_id`, runs `model.predict_actions(x, inst, regime_onehot, timeframe_onehot)` → actions [0=LONG, 1=SHORT, 2=NEUTRAL] per style.

### Instrument–strategy alignment

- **Backtest** uses `stratIds` from: bot's `strategyIds` (when instrument selected + bot has strategies) OR all enabled strategies.
- **Build** uses `buildStrategyIds` from: bot's `strategyIds` (when non-empty) OR all enabled strategies.
- **Result**: Build only uses rows where `r.strategyId` is in `buildStrategyIds` and `r.instrumentId === b.instrumentId`. No cross-instrument leakage.

### Feature vector and deployment

- **Execution** requires `b.nnFeatureVector?.length === 256` (botExecution.ts). Bots without a valid 256-dim vector do not run predictions.
- **Safeguard**: Build only marks bot as `ready` when `res.feature_vector?.length === 256`. If backend returns success without a valid vector, bot stays `outdated` with an error.

### Verification

- Run `npx tsx scripts/verify-build-selection.ts` to confirm `getBestResultsForBuild` includes best greens and oranges when fallback triggers.
- Backtest diversity: `npx tsx scripts/verify-backtest-full.ts` ensures different strategies produce different results.

---

## 5. File Reference

| Component | File | Purpose |
|-----------|------|---------|
| Closed trades display | `LivePortfolio.tsx` | Renders closed trades from `closedTradesByBot` |
| Closed trades store | `TradingStore.tsx` | `recordClosedTrade`, `reconcileClosedPositions`, `updateClosedTradesFromDerivProfitTable` |
| Bot execution log | `BotExecutionLog.tsx` | Predictions, skips, orders |
| Predictions API | `api.ts` | `postPredict` |
| Predictions backend | `python/cicada_nn/api.py` | `POST /predict` |
| Bot execution | `botExecution.ts` | `runBotExecution`, `postPredict` |
| Backtest engine | `backtest.ts` | `runBacktest`, `runSingleBacktest` |
| Strategy library | `registries.ts` | `getAllStrategies` |
| Build flow | `TradingStore.tsx` | `buildBot` |

---

## 6. Verification Commands

```bash
# Backtest values and strategy diversity
npx tsx scripts/verify-backtest-full.ts

# Backtest profit calculation
npx tsx scripts/verify-backtest-values-and-depth.ts

# Build selection (getBestResultsForBuild)
npx tsx scripts/verify-build-selection.ts
```
