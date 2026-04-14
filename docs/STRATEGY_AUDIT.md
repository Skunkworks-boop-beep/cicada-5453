# Strategy Audit: Python vs Frontend Alignment

Full check performed to align Python backend (`python/cicada_nn/signals.py`) with frontend (`src/app/core/patternDetection.ts`, `signals.ts`).

## Fixes Applied

### 1. Chart Patterns (cp-*)

| Strategy | Fix |
|----------|-----|
| **cp-double-top** | lookback 20→28, added tolerance 0.002 |
| **cp-double-bottom** | lookback 20→28, added tolerance 0.002 |
| **cp-triple-top** | lookback 25→28, added tolerance 0.002 |
| **cp-triple-bottom** | lookback 25→28, added tolerance 0.002 |
| **cp-head-shoulders** | Neckline from swing lows (not shoulder highs); lookback 30→35; tolerance on break |
| **cp-inverse-h-s** | Neckline from swing highs; same fixes |
| **cp-fib-retracement** | Swing-based (not window high/low); lookback 10→18 |
| **cp-cup-handle** | lookback 25→35, cupMinBars 8→12 |
| **cp-inverse-cup** | same |
| **cp-broadening** | lookback 15→18 |
| **cp-ascending-broadening** | lookback 15→18 |
| **cp-descending-broadening** | lookback 20→18 |
| **cp-wedge-rising** | lookback 20→22 |
| **cp-wedge-falling** | lookback 20→22 |
| **cp-channel-up** | lookback 15→18 |
| **cp-channel-down** | lookback 15→18 |
| **cp-diamond** | lookback 24→28 |
| **cp-rounding-bottom** | lookback 20→22 |
| **cp-rounding-top** | lookback 20→22 |
| **cp-fan-lines** | lookback 20→22 |
| **cp-triangle-sym/asc/desc** | lookback 20→24 |
| **cp-flag-bull/bear** | lookback 15→18 |
| **cp-pennant** | lookback 15→18 |
| **cp-rectangle** | lookback 20→24, added tolerance 0.005 |
| **cp-bump-run** | lookback 25→28 |

### 2. Price Action (pa-*)

| Strategy | Fix |
|----------|-----|
| **pa-liquidity-sweep** | lookback 5→8; was correct |
| **pa-liquidity-pool** | **NEW**: Implemented (was using liquidity_sweep); lookback 14; cluster tolerance 0.003 |
| **pa-inducement** | **NEW**: Implemented (was using liquidity_sweep); lookback 8; wick rejection ≥0.4 |
| **pa-stop-hunt** | **NEW**: Implemented (was using liquidity_sweep); lookback 10 |
| **pa-bos** | lookback 5→10 |
| **pa-gap-fill** | lookback 5→6 |
| **pa-swing-high-low** | lookback 10→12 |
| **pa-structure-break** | lookback 5→10 |
| **pa-fakeout** | lookback 10→12 |
| **pa-close-beyond** | lookback 10→12 |
| **pa-equal-highs-lows** | lookback 15→18, added tolerance 0.002 |
| **pa-sr-flip** | lookback 10→12 |
| **pa-trendline-break** | lookback 15→18 |
| **pa-swing-failure** | lookback 8→10 |
| **pa-turtle-soup** | lookback 10→12 |
| **pa-exhaustion** | lookback 5→6 |
| **pa-capitulation** | lookback 5→6 |
| **pa-news-spike** | lookback 10→12 |
| **pa-choch** | lookback 8→10 |
| **pa-tight-consolidation** | lookback 8→10, added consolBars 4 |
| **pa-absorption** | lookback 10→12, added absorbBars 5 |
| **pa-hh-hl** | lookback 5→10 |
| **pa-lh-ll** | lookback 5→10 |

### 3. Regime Detection

| Fix |
|-----|
| **Trend strength normalization**: `slope_raw / price` (was raw slope); threshold 0.00015 is for normalized value |

## Patterns Not Yet Fully Aligned

- **Cup and Handle / Inverse Cup**: Frontend has rim symmetry check (3% tolerance) and handle validation; Python uses simpler rim breakout. Consider porting full logic if needed.
- **Harmonic patterns** (Gartley, Bat, etc.): Use raw window high/low in some paths; frontend uses swing points. Lower priority.
- **Speed lines / Andrews pitchfork**: Use window high/low; frontend may differ.

## Verification

Run research/backtest and compare results. Strategies that previously showed 0 trades (e.g. cp-head-shoulders, cp-fib-retracement) should now produce signals when patterns form.
