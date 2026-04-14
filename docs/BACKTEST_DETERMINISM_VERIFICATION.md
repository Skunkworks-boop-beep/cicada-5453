# Backtest Determinism Verification

This document verifies that the backtest engine uses **actual computations** of the trading logic—not random simulations. Results are **deterministic**: same inputs always produce the same outputs.

## Evidence from Your Results

Your numbers support determinism:

| Config | Total |
|--------|-------|
| Without research (Any Only) | $2,694.60 |
| Without Auto-compare (Any Only) (only research) | $2,694.60 |
| Without research (All regimes) | $20,960.31 |
| Without Auto-compare (All regimes) (only research) | $20,960.31 |

**Without research** and **only research** (when research config matches defaults) produce **identical totals**. Same config → same result.

---

## Code Verification

### 1. No Randomness in Backtest Logic

**Client (`src/app/core/backtest.ts`):**
- Header: *"Deterministic — no randomness"*
- `runSingleBacktest` receives a `seed` parameter but **never uses it** for any computation
- No `Math.random()` or stochastic logic

**Server (`python/cicada_nn/backtest_server.py`):**
- No `random` or `numpy.random` imports
- `_run_single` uses rule-based execution only

### 2. Regime Detection (Deterministic)

**Client (`src/app/core/regimes.ts`):**
- Linear regression slope (trend)
- ATR (volatility)
- RSI (momentum)
- Donchian channels (breakout)
- All are pure functions of OHLCV bars

**Server (`python/cicada_nn/regime_detection.py`):**
- Same logic, ported from frontend
- Rule-based thresholds (no sampling, no randomness)

### 3. Signal Generation (Deterministic)

**Client (`src/app/core/signals.ts`):**
- Uses indicators (RSI, MACD, EMA, ATR, etc.) and pattern detection
- Each strategy maps to a pure function: `(bars, regime, index, params) → 1 | -1 | 0`
- No random selection or stochastic entry/exit

**Server (`python/cicada_nn/signals/`):**
- Mirrors client logic
- `get_signal(strategy_id, bars, i, reg_at_bar, strategy_params)` is deterministic

### 4. Trade Execution (Rule-Based)

Both client and server use the same rules:

1. **Entry:** Strategy signals 1 or -1, regime matches job filter (or `any`), size from risk config
2. **Exit (in order):**
   - **Stop:** `low <= stop` (long) or `high >= stop` (short)
   - **Target:** `high >= target` (long) or `low <= target` (short)
   - **Signal flip:** Opposite signal closes position

All use bar OHLC and config (stop %, target R, slippage). No random fills or simulated noise.

### 5. Indicators (Pure Math)

`src/app/core/indicators.ts` and Python equivalents:
- SMA, EMA, RSI, MACD, ATR, Bollinger, Donchian, etc.
- All are deterministic functions of price/volume series

---

## Reproducibility

For the same:
- OHLCV bars (from broker or same date range)
- Instrument set
- Strategy set
- Regime mode (Any only / All regimes)
- Risk config (stop, target, risk %)
- Research config (or defaults)

…the backtest will produce **identical** total profit and per-job results every run.

---

## Summary

| Component | Random? | Notes |
|-----------|---------|-------|
| Regime detection | No | Linear regression, ATR, RSI, Donchian |
| Strategy signals | No | Indicators + pattern rules |
| Trade execution | No | Stop/target/signal rules only |
| PnL calculation | No | `size × entryPrice × pnlPct` |
| Slippage | No | Fixed % of price (config) |

The backtest is **fully deterministic**. Your results reflect actual strategy logic applied to real OHLCV data.
