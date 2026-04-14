# True Computations Verification

All core trading, backtest, research, and NN flows use **true computations** — no placeholder logic, simplifications, or simulated data. Verified components:

## Backtest

| Component | Computation | Source |
|-----------|-------------|--------|
| **Signals** | RSI, MACD, BB, FVG, BOS, liquidity sweep, breakout retest, candlestick patterns | `signals.py` — real indicator math (EMA, SMA, Donchian, ATR) |
| **Regime detection** | Trend (linear regression slope), volatility (ATR%), momentum (RSI), Donchian bounds | `regime_detection.py`, `regimes.ts` — real indicators |
| **P&L** | `(exitPrice - entryPrice) * size` per trade; equity curve from cumulative PnL | `backtest_server.py`, `backtest.ts` |
| **Sharpe/Sortino** | `avg_ret / std_ret * sqrt(252)` from trade returns | `backtest_server.py` |
| **Win rate, profit factor** | `wins/total`, `gross_profit/gross_loss` | From actual trades |
| **Max drawdown** | `(peak - equity) / peak` per bar | From equity curve |

**Unknown strategies**: Unmapped strategies raise `ValueError` — no fallback; ensures all backtests use real strategy logic.

## Research

| Component | Computation | Source |
|-----------|-------------|--------|
| **Regime calibration** | Entropy × (1 - unknown_ratio) over regime series | `research_server.py` — real entropy from distribution |
| **Param tune** | Walk-forward: train on 60%, validate on 20%, test on 20% | Real backtest runs on each split |
| **Profitability+consistency score** | Data-driven min-max normalization from candidate set; weighted sum of profit, Sharpe, drawdown, win rate | `scope_grid_config.py` — no hardcoded scaling constants |

## NN Build & Predict

| Component | Computation | Source |
|-----------|-------------|--------|
| **Feature vector** | Aggregated win/profit/pf/sharpe per strategy, per tf×regime from backtest rows | `train.py` `backtest_rows_to_features` |
| **Detection model** | `bars_to_features` from OHLC bars → NN forward pass | `train_detection.py` — real bar features |
| **Predict** | Regime/timeframe one-hot + feature vector → model forward → actions, sl_pct, tp_r | `api.py` — real inference |
| **Detection predict** | `bar_window` → `bars_to_features` → StrategyDetectionNN | Uses `bar_window`; `feature_vector` in BuildResponse is API shape only (detection model ignores it) |

## Risk & Execution

| Component | Computation | Source |
|-----------|-------------|--------|
| **Position size** | `riskAmount / riskPerUnit`; Kelly cap when enabled | `risk.ts` |
| **Volatility scaling** | Linear: 1 at ATR%≤2%, 0.5 at ATR%≥7% | Real ATR% from bars |
| **Max positions per instrument** | 1/2/3 from regime confidence thresholds | `getMaxPositionsPerInstrument` |

## Backward Validation

| Component | Computation | Source |
|-----------|-------------|--------|
| **Trade verification** | Replay trade from entry bar: stop/target/signal exit on actual OHLC | `_simulate_trade_from_bar` — deterministic replay, not random |
| **Calibration hints** | Grid search over regime configs; score from verified trades | Real backtest + verification |

## Point Size / Spread

| Component | Computation | Source |
|-----------|-------------|--------|
| **inferPointSize** | Known symbols only (JPY pairs, synthetics R_/CRASH/BOOM, indices US30/AUS200). Unknown: log error and throw — use broker pip_size. No inference. | `spread_utils.py`, `spreadUtils.ts` |

## Scope Selection

| Component | Computation | Source |
|-----------|-------------|--------|
| **scoreScopeForCandidate** | Weighted regime/vol/time/confidence scores from real inputs | `botExecution.ts` — heuristic weights (0.4, 0.25, etc.) for scope fit |
