# Robust Audit Report

Audit for false logic, fake implementations, simulations vs true computations, and missing edge cases.

## Full Test Run (Latest)

| Suite | Result |
|-------|--------|
| `npm run verify-all` | ✅ Pass |
| `npm run test:backward-validation` (pytest) | ✅ 35 passed |
| `npx vitest run` | ✅ 45 passed (2 files) |
| `python verify_signals.py` | ✅ Pass |

## Summary

| Category | Status | Notes |
|----------|--------|-------|
| **False logic** | ✅ Clean | Conditions and branches verified |
| **Fake implementations** | ⚠️ Fixed | get_signal momentum fallback → raise; getInstrumentType → log+unknown |
| **Simulations vs true** | ⚠️ Fixed | Drift profit factor when all wins; momentum fallback removed |
| **Edge cases** | ✅ Mostly covered | Division guards, empty arrays, null checks in place |
| **Missing edge guards** | ✅ Addressed | Documented; critical paths fixed |

---

## 1. False Logic

- **scope selection** (`botExecution.ts`): `scoreScopeForCandidate` default returns 0.5 for unknown scope; `selectScope` returns `candidates[0]` when best.score ≤ 0 only when `candidates.length > 0` (guarded by earlier checks).
- **backtest metrics** (`backtest_server.py`): win_rate, profit_factor, sharpe, sortino all have zero-division guards.
- **risk.ts**: `kellyFraction` returns 0 for invalid inputs; `positionSizeFromRisk` returns 0 when `riskPerUnit <= 0`.

---

## 2. Fake Implementations / Placeholders

### Fixed

| Location | Issue | Fix |
|----------|-------|-----|
| `signals.py` `get_signal` | Unknown strategy used `_signal_momentum` fallback (simulated) | Raise `ValueError` for unmapped strategies |
| `strategyInstrumentConfig.ts` `getInstrumentType` | Silent inference for unknown symbols → `'fiat'` | Log warning and return `'unknown'` |

### Intentional (verified)

- **backward_validation** `_simulate_trade_from_bar`: Replay of trade on OHLC for verification; not random. Documented in TRUE_COMPUTATIONS_VERIFICATION.
- **Math.random** in project: Used only for IDs (`pos-*`, `ev-*`, `bt-*`), not for trading logic.

---

## 3. Simulations vs True Computations

### Fixed

| Location | Issue | Fix |
|----------|-------|-----|
| `drift.ts` `getLiveMetricsFromClosedTrades` | When all wins: `grossLoss=0` → profit factor = `2` or `1` (arbitrary) | Use `Infinity`-like sentinel; in drift check treat "all wins" as no drift |

---

## 4. Edge Cases

### Division by zero

- `math_utils.safe_div`: Uses `eps` when divisor is 0 or NaN.
- `regime_detection._rsi`: `avg_loss == 0` → returns 50 or 100.
- `backtest_server`: `total_trades`, `gross_loss`, `std_ret`, `std_down` all guarded.
- `scope_grid_config._norm_minmax`: `hi <= lo` → returns 0.5.

### Empty arrays / null

- `botExecution`: `candidates.length === 0` → `return null` before `candidates[0]`.
- `backtest_server`: `not bars or len(bars) < 10` → failed row.
- `derivApi`, `api.ts`: Empty arrays return `[]`; null checks.
- `drift.ts`: `closedTrades.length === 0` → `{ winRate: 0, profitFactor: 1, sampleSize: 0 }`.

### Out-of-range / invalid

- `exnessApi`: `Number.isFinite` checks for balance/equity.
- `risk.validateNewPosition`: `!Number.isFinite(portfolio.equity) || portfolio.equity <= 0` → reject.

---

## 5. Missing Edge Case Handling

| Location | Risk | Mitigation |
|----------|------|------------|
| `exnessApi` empty response | 200 OK with empty body → `{}`; balance treated as 0 | Could throw; current behavior is acceptable for "no positions" |
| `getInstrumentType` unknown | Previously inferred as `fiat` | Now returns `unknown` with logging |
| `score_profitability_consistency` negative `max_drawdown_pct` | Fallback `1.0 - dd/0.5` could exceed 1 | `max(0, ...)` clamps; negative dd is rare |
| `signals` slope with `len(slice_bars)==0` | Division by zero | `len(slice_bars) <= 0` guard returns 0 before division |

---

## 6. Audits Completed

### Strategy registry vs SIGNAL_ROUTER
- **verify-strategy-mapping.ts**: All 236 registry strategies mapped in Python; `get_signal` returns valid signals for each.
- **SIGNAL_ROUTER** + prefix fallbacks (ind-/pa-/cs-/cp-) cover all strategies; unknown strategies now raise `ValueError`.

### getInstrumentType / getInstrumentBucket
- **getInstrumentType** (strategyInstrumentConfig): Single caller `getStrategyInstrumentConfig`; `unknown` uses `INSTRUMENT_TYPE_RISK['unknown']` (conservative).
- **getInstrumentBucket** (risk.ts): Uses `types.ts` InstrumentType (fiat/crypto/synthetic_deriv/indices_exness); separate from strategyInstrumentConfig; receives type from Instrument entity (broker), not from symbol inference.

### Research grid stream (pytest fix)
- **Pre-scan**: Instruments that never make it into `tf_pairs` (no symbol or insufficient bars) are now added to `skippedInstruments` and emit skip progress. Fixes 3 previously failing tests.

### Fallbacks / defaults
- Intentional defaults (RegimeConfig, backtest scope defaults, Kelly, etc.) verified as real config, not fake data.
- Deriv symbol lookup uses registry fallbacks for API mapping; no synthetic data.

## 7. Data-Fetch-Before-Process (Full Historical Depth)

All required data must be fetched before any process runs; otherwise the process halts with a logically descriptive error. No inference, skip, or partial runs.

| Flow | Behavior |
|------|----------|
| **Research** | Default timeframes = all 8 (M1–W1). Fetch all inst×TF before starting. If any fetch returns < 200 bars → throw. Backend validates all bars exist and sufficient before streaming. |
| **Backtest (server offload)** | Fetch all inst×TF before sending. If any < 10 bars → throw. Backend validates when bars provided; raises 400 if any missing/insufficient. |
| **Backtest (client)** | getBars required; throws on fetch failure. Uses date range + 50k cap for full depth. |

**Constants**: `MIN_BARS_REQUIRED_BACKTEST=10`, `MIN_BARS_REQUIRED_RESEARCH=200`, `FULL_DEPTH_TIMEFRAMES=['M1','M5','M15','M30','H1','H4','D1','W1']`.

## 8. Recommendations

1. **Strategy registry**: All 236 strategies have `SIGNAL_ROUTER` or prefix handlers; unknown strategies raise.
2. **Instrument type**: When `getInstrumentType` returns `unknown`, `INSTRUMENT_TYPE_RISK['unknown']` applies conservative defaults.
3. **Drift**: "All wins" case uses `PROFIT_FACTOR_ALL_WINS` sentinel; no arbitrary fake value.
