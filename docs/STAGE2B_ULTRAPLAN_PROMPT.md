# Stage 2B Ultraplan brief

> Self-contained prompt for the next cloud Ultraplan session. Read this
> file end-to-end before planning anything else.

## Repo + branch

- Remote: `github.com/Skunkworks-boop-beep/cicada-5453`
- Base branch: `feat/cicada-stage2a-bridge-latency`
- Open Stage 2B work on a NEW branch: `feat/cicada-stage2b-analytical-core`

## Critical context — read these in the repo before planning

1. **`docs/ARCHITECTURAL_REVIEW.md`** (649 lines) — deep audit done after
   Stage 2A. Severity-ranked findings, the two-loop ownership problem,
   three Stage 2A bugs to fix, six open questions to resolve mid-plan.
2. **`docs/IMPLEMENTATION_PLAN.md`** — Plan v2 with Stage 1 (DONE) +
   Stage 2A (DONE) detailed and Stage 2B + 3 outlined. Use as the
   skeleton; tighten and expand it with whatever the architectural review
   surfaces.
3. **The trading-system spec** (1,512-line text file) lives on the
   operator's machine at
   `/home/skunkworks/Downloads/trading_system_claude_code (updated).txt`.
   The cloud sandbox cannot read user-local paths; if the spec is
   needed, the operator pastes its content into the session prompt or
   uploads it. Stage 2B's analytical core does not require the
   Execution-Architecture / Latency-Module chapters (lines 894-1512) —
   those are Stage 2A territory and are already implemented. Stage 2B
   does need spec sections 2 (Phases 2 / 2b / 4 / 5 / 5b / 6), 5
   (look-ahead enforcement), and parts of 7 (NN training).

## What's done — do not redo

### Stage 1 (`feat/cicada-stage1-trade-modes`, merged into stage2a)

- `python/cicada_nn/trade_modes.py` — canonical 5-mode parameter table
  (locked, parity-checked Python ↔ TS via
  `scripts/verify-trade-mode-parity.ts`).
- `python/cicada_nn/order_records.py` — append-only SQLite tables
  `orders` + `sl_tp_events`.
- `python/cicada_nn/sl_tp_manager.py` — per-mode SL/TP lifecycle.
- Regression tests for the four spec bugs: immediate close, no dynamic
  SL, modes-share-logic, incomplete order records.

### Stage 2A (`feat/cicada-stage2a-bridge-latency`)

- `bridge/server.py` — FastAPI service for the Windows VM. The **only**
  place `import MetaTrader5` is allowed; Linux contract tests run
  against a stub MT5 injected into `sys.modules`.
- `python/cicada_nn/mt5_bridge.py` — typed HTTP client
  (`BridgeUnreachableError` / `BridgeRetcodeError`).
- `python/cicada_nn/mt5_client.py` — refactored to delegate to the
  bridge; **zero MT5 imports under `cicada_nn`**.
- `python/cicada_nn/latency_monitor.py` + `latency_model.py` —
  session-aware p50/p95/p99 baselines and per-mode trade gates per
  spec lines 1378-1396.
- `orders` schema migration adding the four latency columns.
- `validate_order` extended with checks 6 (`baseline_valid`) and
  7 (`trade_gate_allowed`) per spec lines 1418-1431.
- API endpoints: `GET /bridge/health`, `GET /latency/status`,
  `GET /latency/baseline`.
- UI: `BrokersManager` MT5 BRIDGE pill, `ProcessMonitor` latency strip.
- **Tests**: 150 pytest pass, 80 vitest pass, `npm run build` clean,
  trade-mode parity green.

## Stage 2B — priority order (do not deviate)

This is the analytical core. Build in this order; each step is a
shippable sub-deliverable with tests:

### 1. `python/cicada_nn/lookahead_validator.py` — first

Spec section 5 enforcement: runtime assertion that for every row at time
T, every feature column has timestamp ≤ T and no label column appears in
the feature matrix. Mandatory pre-train pipeline step. **Build this
FIRST** — every later module gets shape-tested against it.

### 2. `python/cicada_nn/geometric_map.py` (Phase 2)

S/R nodes, volume profile via `scipy.stats.gaussian_kde`, fractal swing
highs/lows. Computed ONCE from full Parquet history; persisted to
`checkpoints/geometric_map_<symbol>_<sha>.parquet`. Content-addressed so
the same input always produces the same map. Stability invariant test:
same fixture → identical hash.

### 3. `python/cicada_nn/execution_quality_map.py` (Phase 2b)

Reads ticks via `mt5_bridge.get_ticks()` (NOT direct MT5 import).
Per-coordinate `avg_spread`, `spread_variance`, `avg_slippage`,
`partial_fill_probability`, `book_depth_proxy`,
`latency_impact_estimate`. Aligned with the geometric map's coordinate
system. Parquet partitioned by instrument + date.

### 4. `python/cicada_nn/loss_inversion.py` (Phase 4)

Re-enter every losing trade at the same price point in the opposite
direction (guaranteed fill on closed historical data). Produces an
`INVERSION` event row.

### 5. `python/cicada_nn/bidirectional_analysis.py` (Phase 5)

For each trade entry T: lookback feature vector (data ≤ T) +
look-forward label vector (data > T). Calls `lookahead_validator`
before returning.

### 6. `python/cicada_nn/fakeout_detection.py` (Phase 5b)

Classifier per spec lines 150-194. Outputs `FAKEOUT` event rows,
**never** `LOSS` rows. Reuses `signals.py:929` (`_detect_fakeout`) for
the primitive. Note the spec wants `FAKEOUT_REVERSAL` as a fourth NN
class, distinct from the existing `pa-fakeout` strategy id (see review
§11 on the duality — these are two different concepts that share a
word).

### 7. `python/cicada_nn/context_layer.py` (Phase 6)

Joins everything into the row schema from spec section 2 phase 6
(lines 200-222). Calls `lookahead_validator` before returning.

### 8. `labeling.py` + `model.py` + `train.py`

Repoint at the new `context_layer` schema. NN head becomes 4-class
softmax (`LONG` / `SHORT` / `NEUTRAL` / `FAKEOUT_REVERSAL`) per spec
phase 7. LSTM 64u. `train.py` calls `lookahead_validator` before any
training step and fails loudly on leakage.

### 9. `python/cicada_nn/api.py`

New endpoints: `GET /map/geometric/{symbol}`,
`GET /map/execution_quality/{symbol}`, `POST /train/loss_inversion`,
`POST /train/context_layer`, `GET /context_layer/{symbol}`.

### 10. UI: `src/app/components/GeometricMapPanel.tsx`

Read-only, vertical price ladder of S/R bands + volume nodes + fractal
swings, `text-[10px]` rows, sits in the right column of `Dashboard.tsx`
between `BotExecutionLog` and `BrokersManager`.

## Stage 2A bug fixes — fold into Stage 2B

From the architectural review:

**A. `mt5_client.MT5_AVAILABLE` / `is_connected` do an HTTP probe per
access** (review §3.1). Add a TTL cache (5s) inside `mt5_bridge` so
daemon ticks pay at most one bridge probe each.

**B. `LATENCY_MONITOR.start()` is a side-effect of importing
`api.py`** (review §3.2). Gate it on an env var (default off) or only
start when uvicorn is actually serving.

**C. Add `GET /account` to `bridge/server.py`** and extend
`mt5_client.get_account` to proxy it (review §3.4). Stop returning
placeholder zeros for balance / equity.

## Open questions — ask the operator mid-plan if their answers shift the design

See Appendix B of `docs/ARCHITECTURAL_REVIEW.md` for the full list. The
most consequential:

1. **Frontend trade-loop fate** (keep / port / delete) — the spec
   implies backend ownership; today the frontend `runBotExecution`
   loop is the default path. Stage 1 + 2A's bug fixes do **not** reach
   the frontend loop.
2. **Geometric map rebuild trigger threshold** — what counts as a
   "volatility regime shift"? The spec hand-waves it.
3. **Post-fill re-validation policy** — strict reject-on-mismatch or
   lenient track-only when bridge fill price diverges from signal
   entry price beyond mode tolerance?

## UI/UX guardrails — do not violate

- **Palette only**: `#00ff00`, `#ff6600`, `#ffff00` + alpha variants
  `/40` `/50` `/70` `/80`. No new accent colours.
- **Typography only**: `text-[10px]`, `text-xs`, `text-sm` in
  components; `text-base` for body defaults. **No oversized text.**
  JetBrains Mono throughout.
- **Component vocabulary**: reuse `RetroBox`, the corner-bracket box
  pattern, `[ LABEL ]` bracketed buttons, `tracking-wider` uppercase,
  neon `box-shadow` recipe.
- The Beehive visualiser (Stage 3, not 2B) uses the spec's strict
  green palette `#020d02 → #1aff1a` only.

## Test requirements

- Every new module gets a fixture and at least one property test.
- `lookahead_validator` gets a deliberately-leaked fixture that **must
  raise**.
- `geometric_map` gets a stability-invariant test (same input → same
  hash) and a regime-shift trigger test.
- `execution_quality_map` round-trips through a fake-bridge tick supply.
- `fakeout_detection` classifies known historical fakeouts as
  `FAKEOUT`, not `LOSS`.
- The 4-class NN trains end-to-end on a tiny fixture with sensible
  confidence calibration.
- Append-only invariants on any new SQLite tables: zero `UPDATE`
  statements; tests assert on a real tmp file (no mocks).
- `npm run verify-all` + `npm run build` must pass after each commit.
- `npm run test:coverage` stays green.
- Trade-mode parity script must still pass.

## Do not

- Break Stage 1 + 2A tests (150 pytest, 80 vitest).
- Add new colours or larger text to the UI.
- Import `MetaTrader5` outside `bridge/server.py` (the abstraction guard
  test will catch it).
- Modify the `trade_modes.py` parameter table without updating
  `src/app/core/tradeModes.ts` and re-running parity.
- Land code that fails the look-ahead validator on a sample run.

## Deliverable

A pull request on the new branch
`feat/cicada-stage2b-analytical-core` with all of steps 1–10
implemented, bug fixes A/B/C done, all tests passing, and a brief PR
body noting what's done, what's deferred, and any open questions still
unresolved.
