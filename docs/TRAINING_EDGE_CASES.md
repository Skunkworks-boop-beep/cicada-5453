# Training and deployment edge cases

This doc describes how the codebase handles regime quality, drift, leakage, cold start, and retrain policy.

## Regime labeling quality

**Method:** Custom rule-based (not HMM). Implemented in `src/app/core/regimes.ts`:

- **Trend:** Linear regression slope over closes (lookback).
- **Volatility:** ATR(14) as % of price → high → `volatile`, low + weak trend → `consolidation`.
- **Momentum:** RSI(14) for overbought/oversold → `reversal_bear` / `reversal_bull`.

**Mislabeling guard:** When confidence is below `REGIME_CONFIDENCE_MIN` (0.55), the regime is forced to `unknown` so backtest and NN training do not attribute performance to a wrong regime.

## Drift detection (early retrain)

**Schedule vs trigger:** Rebuilds are scheduled weekly. When live performance diverges from backtest (e.g. macro shock), you can trigger an early retrain:

- **Mark drift:** In Bot Builder, when a bot is deployed, use **Mark drift**. This sets `driftDetectedAt` and reschedules the next rebuild to 2 hours from now (`DRIFT_EARLY_REBUILD_HOURS`).
- **Clear drift:** Use **Clear** in the drift notice to remove the flag.
- After a successful build or on deploy, drift flags are cleared.

A future improvement is to compute drift automatically (e.g. compare recent closed-trade win rate to backtest expected) and call `setDriftDetected(botId, reason)` when a threshold is exceeded.

## Training data leakage

**Risk:** “Best configurations” or features must not use future data.

**Measures:**

- **`dataEndTime`:** Each backtest result row has `dataEndTime` (last bar timestamp, ISO). Set in the frontend backtest engine.
- **Training cutoff:** Only results with `dataEndTime <= now - 24h` are used for build. Implemented in `filterResultsByTrainingCutoff()`; build fails with a clear error if no rows pass.
- **Payload:** Build request sends `dataEndTime` per row and `training_cutoff_iso`. The Python API filters again by cutoff before training.
- **Metadata:** Each checkpoint is saved with `instrument_bot_nn_meta.json` (trained_at_iso, training_cutoff_iso, data_end_min/max, num_rows, from_scratch) for auditing.

## Cold start after retrain

**Issue:** A newly deployed model can behave unexpectedly in the first days.

**Measures:**

- **`deployedAt`:** Set on **Deploy bot** (ISO timestamp).
- **Warmup:** For the first `WARMUP_HOURS` (48), position size is scaled by `WARMUP_SIZE_SCALE` (0.25). Use `getWarmupScaleFactor(bot)` when sizing new positions (e.g. `size *= getWarmupScaleFactor(bot)`).
- Bot Builder shows a “Cold start: position size scaled to 25% for 48h” notice when the bot is deployed and within the warmup window.

## Catastrophic forgetting

**Policy:** Train **from scratch** on every build (no incremental training). This avoids catastrophic forgetting and keeps behavior stable, at the cost of not retaining long-term historical context in the model.

- Documented in `python/cicada_nn/train.py` and in checkpoint metadata (`"from_scratch": true`).
- Each checkpoint is accompanied by `instrument_bot_nn_meta.json` with data range and training time so you can audit what data the model was trained on.
