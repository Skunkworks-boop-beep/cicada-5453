# Backend Wiring Verification

Verified: all frontend components are appropriately wired to the backend API. **100% completeness.**

Run: `npx tsx scripts/verify-backend-wiring.ts`

## API Endpoints (Python `cicada_nn/api.py`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check; used before backtest/build |
| `/build` | POST | Train NN from backtest results |
| `/predict` | POST | NN inference (regime + timeframe aware) |
| `/backtest` | POST | Server-side backtest offload (MT5 OHLC) |
| `/mt5/connect` | POST | MT5 login |
| `/mt5/status` | GET | MT5 availability and connection status |
| `/mt5/ohlc` | GET | OHLC bars from MT5 |
| `/mt5/prices` | GET | Live bid/ask for symbols |
| `/mt5/symbols_spread` | GET | Live spread in points per symbol |
| `/mt5/positions` | GET | Open MT5 positions |
| `/mt5/order` | POST | Place market order via MT5 |

## Component → Backend Wiring

### TradingStore (central state)
- **getHealth** → before `runBacktest`, `buildBot`
- **postBacktest** → `runBacktest` (when API available; falls back to client if all server results failed)
- **postBuild** → `buildBot`
- **postMt5Connect** → `connectBroker` (MT5)
- **getMt5Prices** → `tickPortfolioPrices`, `syncBrokerPositions`
- **getMt5SymbolSpreads** → `syncInstrumentSpreads` (live spreads when MT5 connected)
- **getMt5Positions** → `syncBrokerPositions`
- **Deriv** → `derivApi` (connect, balance, positions, ticks)
- **eXness** → `exnessApi` (account, positions)

### BacktestEngine
- **getMt5Status** → MT5 connection status display

### botExecution
- **postPredict** → NN inference for deployed bots
- **fetchOHLCV** → OHLCV from MT5/Deriv (no synthetic fallback)
- **Trading mode (scope selection)** → Frontend-only; backend is scope-agnostic. `selectScopeForTick` uses `scopeMode`/`fixedScope` before calling predict.

### ohlcvFeed (fetchOHLCV)
- **getMt5Ohlc** → when broker is MT5 and connected
- **getTicksHistoryCandles** (Deriv) → when broker is Deriv and connected

### brokerExecution (placeBrokerOrder)
- **postMt5Order** → when instrument uses MT5 broker and connected

### LiveSpreadPanel, TickerBar
- **getMt5Prices** → live bid/ask for selected instrument / ticker symbols

### ServerOffload
- **testServerConnection** → validates remote server before saving URL

### Deploy/Undeploy (frontend-only)
- **deployBot**, **undeployBot**, **deployAllReadyBots**, **undeployAllBots** — store actions; no backend calls

## Request/Response Alignment

### POST /build
- **Frontend sends**: `results` (instrumentId, strategyId, strategyParams, timeframe, regime, winRate, profit, trades, maxDrawdown, profitFactor, dataEndTime), `instrument_types`, `epochs`, `lr`, `training_cutoff_iso`
- **Backend expects**: `BuildRequest` — matches
- **Backend returns**: `success`, `message`, `checkpoint_path`, `feature_vector`
- **Fix applied**: `dataEndTime` now falls back to `completedAt` when missing
- **Fix applied**: Server backtest now returns `dataSource: 'live'` and `dataEndTime`; frontend patches server results without `dataSource` when hydrating

### POST /predict
- **Frontend sends**: `instrument_id`, `feature_vector`, `instrument_type`, `regime`, `timeframe`
- **Backend expects**: `PredictRequest` — matches
- **Backend returns**: `actions` (5 ints), `style_names`

### POST /backtest
- **Frontend sends**: `instrumentIds`, `strategyIds`, `timeframes`, `regimes`, `dateFrom`, `dateTo`, `instrument_symbols`, `strategy_names`, `bars`, `instrument_spreads`
- **Backend expects**: `BacktestRunRequest` — matches (includes `instrument_spreads`)
- **Backend returns**: `results`, `status`
- **Fix applied**: Fall back to client backtest when server returns only failed rows (e.g. MT5 not connected)
- **instrument_spreads**: Per-instrument live broker spreads; backend uses in `_run_single` via `_spread_points_to_fraction`

### MT5 endpoints
- All MT5 endpoints align; frontend uses correct query/body params
- **GET /mt5/symbols_spread**: `symbols` query (comma-separated); returns `{ spreads: { SYMBOL: points } }`

## Config

- **getNnApiBaseUrl()** — uses `VITE_NN_API_URL` or `localhost:8000`; when remote server is set (ServerOffload), uses that URL
- All API calls use `getNnApiBaseUrl()` for the base URL

## Trading Mode (Scope Selection) Wiring

Trading mode selection is **frontend-only**; the Python backend does not receive `scopeMode`/`fixedScope`/`fixedStyles`. Scope is chosen on the frontend before each predict call. The backend receives the **resulting timeframe** (derived from scope).

| Step | Component | What happens |
|------|-----------|--------------|
| 1 | TradingModes.tsx | User clicks [ AUTO ] or mode card(s) → `actions.setBot({ scopeMode, fixedScope, fixedStyle, fixedStyles, allowedScopes })` |
| 2 | TradingStore | `setBot` updates `bots` array, persists to localStorage |
| 3 | Dashboard | `useEffect` runs `tickBotExecution` every N ms (15–120s by scope) when `execution.enabled` |
| 4 | runBotExecution | For each deployed bot: `scope = selectScopeForTick(bot, input)` |
| 5 | selectScopeForTick | Manual single: return `fixedScope`. Manual multi (2–4 styles): run auto logic restricted to those scopes. Auto: run full dynamic logic. Returns `null` → skip tick. |
| 6 | runBotExecution | If `scope == null` → `continue` (no predict). Else: `tf = getTimeframesForScope(scope)` → pick from `bot.timeframes` |
| 7 | postPredict | Sends `{ instrument_id, feature_vector, instrument_type, regime, timeframe, scope, regime_confidence }` to `/predict` |
| 8 | Backend | Receives `scope` (when set) or derives from `timeframe` via TF_TO_SCOPE; uses `scope` for NN style_index (0–3). `regime_confidence` scales regime_onehot and gates multiple positions per instrument. |

**Backend wiring:** Modes are wired via **scope → timeframe → predict**. Frontend sends `scope` explicitly so backend uses correct NN output head (scalp=0, day=1, swing=2, position=3). `regime_confidence` is used for regime_onehot scaling and (on frontend) for `getMaxPositionsPerInstrument` (1–3 positions depending on confidence).

**Verification:** Run `npx tsx scripts/verify-trading-mode.ts` for full coverage (selectScopeForTick, mode selection logic, scope→timeframe→predict).

## Verification Scripts

| Script | Purpose |
|--------|---------|
| `npx tsx scripts/verify-backend-wiring.ts` | All API calls → endpoints, request/response alignment |
| `npx tsx scripts/verify-trading-mode.ts` | Scope selection, mode logic, scope→timeframe→predict |

Add to CI: `verify-backend-wiring` runs before `verify-all`.

## Gaps Found & Fixed

1. **Server backtest missing `dataSource`** — Build filters by `dataSource === 'live'`. Server results lacked this field, so NN build would fail with "Connect a broker" even after a successful server backtest. Fixed: backend now sets `dataSource: 'live'` and `dataEndTime`; frontend patches when hydrating.
2. **Server backtest fallback** — When server returns only failed rows (MT5 not connected), frontend now falls back to client-side backtest.
3. **instrument_spreads** — Backtest (client and server) now accepts per-instrument spreads; frontend passes from store; backend uses in `_run_single`.
4. **Live spreads** — `getMt5SymbolSpreads` + `syncInstrumentSpreads`; Deriv `getDerivSymbolSpreads` from portfolio bid/ask.
5. **Scope in predict** — Frontend sends `scope` (scalp/day/swing/position) to `/predict`; backend uses it for style_index (NN output head). Aligns with trade modes (scalp, day, med_swing, swing, sniper).
6. **Multiple positions per instrument** — `getMaxPositionsPerInstrument(confidence)` in botExecution: 1 below 70%, 2 at ≥70%, 3 at ≥85%. Passed to `tryOpenPosition` as `maxPositionsPerInstrument`.
