# Grid Research: Pre-Backtest Tuning for Regimes × Instruments

## Goal

Find optimal parameters **before** running the main backtest, so that:
1. **Regime detection** is validated and calibrated per instrument (different assets have different volatility/trend characteristics)
2. **Strategy params** (RSI period, MACD, etc.) are tuned per regime × instrument where necessary
3. **Risk params** (stop, target, risk %) are tuned per regime × instrument
4. Backtest runs with **pre-tuned, robust** config instead of one-size-fits-all defaults
5. **Bot training** uses backtest results produced with these validated configs

---

## Pipeline: Research → Backtest → Bot Training

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  RESEARCH (runs first)                                                       │
│  Phase 0: Regime validation (per instrument)                                │
│  Phase 1: Regime calibration (per instrument)                                │
│  Phase 2: Strategy + risk param tuning (per instrument × regime × strategy)  │
│  Output: regimeTunes, paramTunes                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  BACKTEST (uses research configs)                                            │
│  • regimeTunes → instrument-specific RegimeConfig for regime detection       │
│  • paramTunes → job risk overrides (stop, target, risk %)                    │
│  Output: BacktestResultRow[]                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  BOT TRAINING (uses backtest results)                                        │
│  • Backtest rows (instrument, strategy, regime, timeframe, PnL, etc.)      │
│  • Regime labels come from validated regime detection                        │
│  Output: trained NN checkpoint                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Principle:** Tuning happens in research, before backtest. Backtest consumes research configs. Bot training consumes backtest results. No strategy work is trusted until regime detection is validated per instrument.

---

## Current State

| Component | Location | Tunable? |
|-----------|----------|----------|
| Regime thresholds | `regimes.ts`, `regime_detection.py` | **No** — hardcoded (TREND_THRESHOLD, VOLATILITY_PCT, RSI, lookback) |
| Strategy params | `strategyParams.ts` | **Yes** — `STRATEGY_PARAM_RANGES`, `getParamCombinations()` |
| Risk params | `strategyInstrumentConfig.ts` | **Partial** — per instrument type, not per regime |
| Backtest | `backtest.ts`, `backtest_server.py` | Uses above; no pre-tune phase |

---

## Robustness Principles (from research)

1. **Walk-forward validation** — Optimize on in-sample (e.g. 60–70% of bars), validate on out-of-sample. Avoid tuning on the same data used for final evaluation.
2. **Chronological split** — Markets are non-stationary; never shuffle. Train on past, test on future.
3. **Regime-specific tuning** — Different regimes need different params (e.g. volatile vs ranging).
4. **Instrument-specific regime calibration** — R_10 vs EURUSD have very different volatility; one threshold set does not fit all.
5. **Stable plateaus** — Prefer param ranges that perform well across neighbors, not single “magic” values.
6. **Include costs** — Spread, slippage must be in the optimization loop.

---

## Proposed Architecture

### Phase 0: Regime Validation (per instrument)

**Goal:** Validate that regime detection is **properly discovering** regimes for each instrument before any strategy tuning. Regime labels are foundational — if they are wrong, strategy tuning (which filters by regime) is meaningless.

**What "properly discovered" means:**
- **Reasonable distribution** — Not dominated by "unknown"; not all bars in one regime
- **Instrument-appropriate** — Labels reflect that instrument's behavior (e.g. volatility index vs forex)
- **Calibrated per instrument** — Thresholds derived from that instrument's data, not generic defaults
- **Distinct regimes** — Regimes are meaningfully different and useful for filtering

**Validation criteria (examples):**
- `unknown` ratio < threshold (e.g. 10%)
- No single regime > threshold (e.g. 80%)
- Regime distribution entropy above minimum
- Optional: sanity check on sample bars (inspect labels)

**Output:** `RegimeValidation: { instrumentId, validated: boolean, regimeDistribution, score, message? }`

**Flow:** If validation fails for an instrument, flag it (e.g. "Regime detection needs review for R_10"). Phase 1 calibration may still run, but the user is warned. Strategy tuning (Phase 2) should only be trusted when regime validation passes.

---

### Phase 1: Regime Calibration (per instrument)

**Goal:** Tune regime detection thresholds **from each instrument's own behavior** — not cross-referenced. R_10 gets different thresholds than EURUSD because they behave differently (volatility, trend characteristics). The grid search finds the best thresholds that maximize regime diversity and minimize "unknown" labels for that specific instrument's price action.

**Grid dimensions:**
- `regimeLookback`: [30, 50, 70]
- `trendThreshold`: [0.0001, 0.00015, 0.0002]
- `volatilityHigh`: [0.015, 0.02, 0.025]
- `volatilityLow`: [0.003, 0.004, 0.005]

**Objective:** Maximize regime distribution entropy (avoid “unknown” dominated) and/or stability (regime consistency across adjacent bars).

**Output:** `RegimeTune: { instrumentId, regimeLookback, trendThreshold, volatilityHigh, volatilityLow }`

---

### Phase 2: Strategy + Risk Param Tuning (per instrument × regime)

**Goal:** For each instrument × regime, find best strategy params + risk params.

**Grid dimensions:**
- Strategy params (from `STRATEGY_PARAM_RANGES`, limited combos)
- Risk: `stopLossPct`, `riskPerTradePct`, `takeProfitR` (coarse grid)

**Objective:** Maximize Sharpe ratio or profit factor on in-sample period. Use walk-forward: tune on first 70%, validate on last 30%.

**Output:** `ParamTune: { instrumentId, regime, strategyId, strategyParams, riskParams }`

---

### Phase 3: Integration

1. **Research API** — New endpoint `POST /research/grid` that:
   - Accepts instrumentIds, strategyIds, date range
   - Fetches bars (same as backtest)
   - Runs Phase 0 (validation) + Phase 1 (calibration) + Phase 2 (param tune)
   - Returns `RegimeValidation[]`, `RegimeTune[]`, `ParamTune[]`

2. **Store** — Persist research results; backtest reads them when building `jobRiskOverrides` and regime config.

3. **UI** — BacktestEngine: Research button runs grid research before backtest. Show regime validation status, progress, summary.

4. **Backtest** — Uses `regimeTunes` (instrument-specific RegimeConfig) and `paramTunes` (job risk overrides). Produces `BacktestResultRow[]`.

5. **Bot training** — Consumes backtest results. Regime labels in those rows come from validated regime detection. NN learns from regime-strategy-timeframe-instrument combinations tuned in research.

---

## Implementation Order

1. **Phase 0: Regime validation** — Add validation step: check unknown ratio, regime dominance, entropy. Output `validated` flag per instrument.
2. **Phase 1: Regime calibration** — (Existing) Grid search over regime thresholds; return best config per instrument.
3. **Phase 2: Param tune** — (Existing) Reuse `_run_single`; aggregate by instrument × regime × strategy; pick best by Sharpe.
4. **API + store** — Wire research endpoint, persist results, use in backtest.
5. **UI** — Research button, regime validation status, progress, summary.
6. **Backtest → Bot training** — Ensure backtest passes regimeTunes/paramTunes; bot training receives backtest rows with validated regime labels.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Overfitting | Walk-forward; prefer stable plateaus; limit grid size |
| Long runtime | Coarse grid first; parallel jobs; optional “quick” mode |
| Regime imbalance | Some regimes rare; use weighted objective or skip rare regimes |
| Data leakage | Strict chronological split; never use future data in tune |

---

## File Changes (planned)

| File | Change |
|------|--------|
| `python/cicada_nn/regime_detection.py` | Parameterize thresholds; add `detect_regime_series(bars, config)` |
| `python/cicada_nn/research_server.py` | New: grid search for regime + param tune |
| `python/cicada_nn/api.py` | Add `POST /research/grid` |
| `src/app/core/research.ts` | New: types, API client for research |
| `src/app/store/TradingStore.tsx` | Add `runResearch()`, persist research results |
| `src/app/components/BacktestEngine.tsx` | Add Research button, progress, use tuned params |
