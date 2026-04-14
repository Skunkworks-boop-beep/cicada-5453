# Strategy library: how it’s used and calculated

## Overview

The strategy library is the single source of strategy definitions. It is **fetched** by the store and backtest, **filtered** by enabled state and request, and **calculated** in the backtest engine via per-strategy signal functions that use indicators and OHLC.

## 1. Where strategies are defined (the library)

| Source | Path | Contents |
|--------|------|----------|
| Chart patterns | `src/app/core/strategies/chartPatterns.ts` | 45+ patterns (cp-*): Head & Shoulders, double top/bottom, triangles, flags, harmonics, etc. |
| Candlestick patterns | `src/app/core/strategies/candlestickPatterns.ts` | 55+ patterns (cs-*): Engulfing, hammer, doji, morning star, harami, etc. |
| Indicator strategies | `src/app/core/strategies/indicatorStrategies.ts` | 55+ (ind-*): RSI, MACD, BB, EMA, Stochastic, ADX, VWAP, etc. |
| Price action logic | `src/app/core/strategies/priceActionLogic.ts` | 55+ (pa-*): Order blocks, BOS, FVG, liquidity sweep, breakout retest, etc. |

**Registry:** `src/app/core/registries.ts` exports `getAllStrategies()`, which returns `[...CHART_PATTERNS, ...CANDLESTICK_PATTERNS, ...TRADE_LOGIC_STRATEGIES]` (chart + candlestick + indicator + price action). Helpers: `getStrategiesByCategory`, `getStrategiesForRegime`, `getStrategiesForStyle`.

## 2. Where strategies are fetched and used

- **Store:** On load, `strategies = getAllStrategies()` (then merged with persisted enabled state). The UI and backtest use `state.strategies`.
- **Backtest:** `runBacktest(request)` requires `request.strategyIds`. It does `getAllStrategies().filter((s) => request.strategyIds.includes(s.id))` and builds one job per (instrument × strategy × timeframe × regime). Each job runs `runSingleBacktest(..., strategyId, strategyName, ...)`.
- **BacktestEngine (UI):** Collects `strategyIds` from `strategies.filter((s) => s.enabled).map((s) => s.id)` and passes them in the backtest request.
- **Bot:** `createBotForInstrument` sets `strategyIds` from the first N enabled strategies; bots use these ids for build (backtest results are filtered by strategy).

So: strategies are **fetched** from the registry (and store); the **set of ids** used in a run is the enabled strategies (or the bot’s selected strategies).

## 3. How signals are calculated (per strategy id)

For each bar in a backtest, the engine needs a **signal** (1 = long, -1 = short, 0 = neutral). That comes from a **signal function** selected by strategy id.

**Location:** `src/app/core/signals.ts`.

- **`getSignalFn(strategyId)`** returns the signal function for that id:
  - If the id is in **SIGNAL_MAP**, that exact function is used (e.g. `ind-rsi-div` → RSI, `ind-macd-cross` → MACD crossover, `ind-stoch-overbought` → stochastic, `cs-*` → candlestick, etc.).
  - Otherwise **category-based default**:
    - **cs-** → `signalCandlestick` (OHLC-based: engulfing, hammer, doji, pin bar).
    - **cp-** → `signalChartPattern` (H&S, cup-and-handle, double top/bottom, wedges, diamond, then structure).
    - **pa-** → `signalStructure` (structure/breakout).
    - **ind-** (not in map) → `signalRsi` (RSI overbought/oversold as momentum proxy).

So every strategy id is **calculated**: either by a dedicated signal or by a category-appropriate default. No strategy falls through to “no signal”.

## 4. How indicators are computed

**Location:** `src/app/core/indicators.ts`. All functions take series (e.g. `closes[]`) or bars and return arrays aligned by index (or null before enough data).

| Indicator | Used by signals | Notes |
|-----------|------------------|--------|
| RSI | signalRsi, ind-rsi-* | `rsi(closes, 14)` |
| MACD | signalMacd, ind-macd-* | `macd(closes, 12, 26, 9)` → macd line, signal, histogram |
| EMA | signalEmaCross, MACD, etc. | `ema(closes, period)` |
| ATR | signalAtrBreakout, regimes | `atr(bars, 14)` |
| Bollinger | signalBB, ind-bb-* | `bollingerBands(closes, 20, 2)` → upper, middle, lower |
| Stochastic | signalStoch, ind-stoch-* | `stochastic(bars, 14, 3)` → %K, %D |
| VWAP, VWAP Bands | signalVwap, signalVwapBands | Cumulative VWAP; bands = VWAP ± std dev |
| CMF, CMO, TSI, Ultimate Osc | signalCmf, signalCmo, signalTsi, signalUltimateOsc | Full implementations |
| OBV, Force Index, EOM, VPT | signalObv, signalForceIndex, signalEom, signalVpt | Volume-based |
| SMA, linearRegressionSlope, ROC | regimes, other logic | Available for future signals |

Regime detection (`regimes.ts`) uses **ATR**, **linearRegressionSlope**, and **RSI**; its output is passed into signal functions as `regimeAtBar` where needed (e.g. signalRsi, signalStructure).

## 5. Data flow summary

1. **Library** → `getAllStrategies()` → list of strategy defs (id, name, category, regimes, styles, entry/exit logic text).
2. **UI** → user enables strategies → store keeps `strategies` with `enabled` flags.
3. **Backtest run** → request includes `strategyIds` (enabled) and `instrumentIds`, `timeframes`, `regimes` → engine builds jobs (instrument × strategy × timeframe × regime).
4. **Per job** → `runSingleBacktest(..., strategyId, ...)` gets bars from `getBars` (Deriv/MT5; no synthetic fallback), runs `detectRegimeSeries(bars)`, then for each bar index `i`: `signal = getSignalFn(strategyId)(bars, regimeSeries[i], i)`.
5. **getSignalFn(strategyId)** → returns the right signal function (from SIGNAL_MAP or category default); that function **uses** indicators (from `indicators.ts`) and/or raw OHLC (candlestick, structure).

So: strategies are **fetched** from the registry, **filtered** by enabled/request, and **calculated** in the backtest by indicator-based and OHLC-based signal functions keyed by strategy id (with category fallbacks so every id is handled).
