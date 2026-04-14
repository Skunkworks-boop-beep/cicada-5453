# How the Backtest Works

This document explains how the backtest engine places trades, sizes positions, and handles edge cases.

---

## Overview

The backtest runs in `src/app/core/backtest.ts`. It:

1. Fetches live OHLCV bars from Deriv or MT5 (no synthetic data)
2. Detects market regime per bar (trending_bull, trending_bear, ranging, etc.)
3. For each bar, calls the strategy’s signal function → `1` (long), `-1` (short), or `0` (no trade)
4. Enters trades when a signal matches the filtered regime
5. Exits on stop, target, or opposite signal

---

## 1. Entry Logic

**When does a trade open?**

```ts
// backtest.ts lines 149–161
if (!position && (signal === 1 || signal === -1)) {
  const regimeMatches = reg?.regime === regime;
  if (!regimeMatches) continue;
  // ... compute entry price, size, stop, target
  position = { side: signal as 1 | -1, entryBar: i, entryPrice, size, stop, target };
}
```

- `position` is null (no open trade)
- `signal` is 1 or -1 (not 0)
- `regimeMatches` is true: the detected regime at this bar equals the job’s regime filter (e.g. `trending_bear`)

**Entry price:**

- Long: `bar.close * (1 + spread)` — you pay the ask
- Short: `bar.close * (1 - spread)` — you pay the bid

---

## 2. Lot Size (Position Sizing)

**How is size calculated?**

```ts
const riskAmount = equity * RISK_PER_TRADE_PCT;   // 1% of equity
const riskDist = entryPrice * STOP_LOSS_PCT;      // 2% of price
const size = riskDist > 0 ? riskAmount / riskDist : 0;
```

- `RISK_PER_TRADE_PCT = 0.01` (1% per trade)
- `STOP_LOSS_PCT = 0.02` (2% stop)
- `riskAmount = equity × 0.01`
- `riskDist = entryPrice × 0.02` (distance to stop)
- `size = riskAmount / riskDist` — units so that the stop distance equals risk amount

**Example:** equity = 10,000, entry = 100, stop = 98

- riskAmount = 100  
- riskDist = 2  
- size = 100 / 2 = 50 units

If price hits 98, loss ≈ 50 × 2 = 100 (1% of equity).

---

## 3. Stop Loss & Take Profit

**Stop:**

- Long: `entryPrice * (1 - STOP_LOSS_PCT)` = 2% below entry
- Short: `entryPrice * (1 + STOP_LOSS_PCT)` = 2% above entry

**Target:**

- `riskDistAbs = |entryPrice - stop|`
- `TAKE_PROFIT_R = 2` (2:1 R:R)
- Long: `entryPrice + riskDistAbs * 2`
- Short: `entryPrice - riskDistAbs * 2`

---

## 4. Exit Logic

**Per bar, while in a position:**

1. **Stop hit:**  
   - Long: `bar.low <= position.stop` → exit at stop  
   - Short: `bar.high >= position.stop` → exit at stop  

2. **Target hit:**  
   - Long: `bar.high >= position.target` → exit at target  
   - Short: `bar.low <= position.target` → exit at target  

3. **Opposite signal:**  
   - Long + `signal === -1` → exit at `bar.close * (1 - spread)`  
   - Short + `signal === 1` → exit at `bar.close * (1 + spread)`  

**Slippage:**

- Exit price is adjusted by `SLIPPAGE_PCT = 0.00005` (0.005%):
  - Long: `actualExit = exitPrice - slippage`
  - Short: `actualExit = exitPrice + slippage`

---

## 5. Trade Mode / Scope Constraints (Realistic Backtest)

The backtest enforces **scope-specific constraints** so scalp, day, swing, and position modes behave realistically:

| Scope | Max hold (bars) | Default stop | Default target | Default risk |
|-------|-----------------|--------------|----------------|--------------|
| **scalp** | 15 | 1% | 1.5R | 0.5% |
| **day** | 48 | 2% | 2R | 1% |
| **swing** | 120 | 3% | 2.5R | 1% |
| **position** | 252 | 4% | 3R | 0.8% |

- **Max hold**: When a trade exceeds the scope's max hold bars, it is force-closed at bar close (spread + slippage applied). Scalp trades cannot hold 100 bars.
- **Scope defaults**: When no job/instrument override is set, scope-specific stop/target/risk are used. Job overrides take precedence.
- Scope is derived from timeframe (M5→scalp, H4→swing, etc.).

---

## 6. Edge Cases

| Case | Behavior |
|------|----------|
| **Regime mismatch** | No entry if `reg?.regime !== regime` |
| **Consecutive bars** | No new entry if `position` is still open |
| **Max hold exceeded** | Force exit at close (scope constraint) |
| **Zero size** | `size = 0` when `riskDist <= 0` or `riskAmount <= 0` |
| **No bars** | Throws: `Live data required for backtest` |
| **Spread** | `instrumentSpreads` or `DEFAULT_SPREAD_PCT = 0.0001` |
| **Equity** | Starts at `INITIAL_EQUITY = 10000`; equity is updated after each closed trade |

---

## 7. Constants and Tuning

| Constant | Value | Meaning |
|----------|-------|---------|
| `INITIAL_EQUITY` | 10,000 | Starting equity |
| `RISK_PER_TRADE_PCT` | 0.01 | 1% risk per trade |
| `STOP_LOSS_PCT` | 0.02 | 2% stop distance |
| `TAKE_PROFIT_R` | 2 | 2:1 target-to-stop |
| `SLIPPAGE_PCT` | 0.00005 | 0.005% slippage |
| `DEFAULT_SPREAD_PCT` | 0.0001 | 0.01% default spread |

---

## 8. Job Flow

1. `runBacktest(request)` builds jobs from `instrumentIds × strategyIds × timeframes × regimes × paramCombinations`.
2. For each job, `fetchOHLCV` (or cached bars) is used.
3. `runSingleBacktest(..., bars, strategyParams)` runs the loop.
4. `getSignalFn(strategyId)` returns the signal function for that strategy.
5. `detectRegimeSeries(bars)` returns the regime for each bar.

---

## 9. Candlestick Patterns (cs-*)

Each cs-* strategy has its own signal function in `src/app/core/candlestickSignals.ts`. Previously, all cs-* mapped to a single `signalCandlestick`, which produced identical results for On-Neck, In-Neck, etc.

Now each pattern has:

- Its own detection logic
- Optional params: `bodyPct`, `wickPct` for grid search

Example: `cs-on-neck` vs `cs-in-neck`:

- **On-Neck:** Bearish candle followed by small bullish closing at/near prev low
- **In-Neck:** Same setup, but the bullish candle closes slightly inside the prior bearish body

---

## 10. Live vs Backtest

- **Backtest:** Uses `runSingleBacktest` with historical bars; no real broker orders.
- **Live:** Uses `botExecution.ts` + `placeBrokerOrder` + `addPositionWithRiskCheck`; risk checks apply (Kelly, max positions, drawdown, etc.).
