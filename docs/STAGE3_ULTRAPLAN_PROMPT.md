# Stage 3 Ultraplan brief

> Self-contained prompt for the next cloud Ultraplan session. Read this
> file end-to-end before planning anything else.

## Repo + branch

- Remote: `github.com/Skunkworks-boop-beep/cicada-5453`
- Base branch: `feat/cicada-stage2b-analytical-core` (Stage 2B + live-only
  pipeline, all green: 240 pytest, 85 vitest, build clean, parity ✅)
- Open Stage 3 work on a NEW branch: `feat/cicada-stage3-beehive-drift`
- Operator decision (logged): branches stay separate, no merging until the
  full build is done.

## Critical context — read these in the repo first

1. **`docs/ARCHITECTURAL_REVIEW.md`** — deep audit; Stage 3 carries the
   open items from §6 (drift hardening), §11 (fakeout duality — keep
   straight in the Beehive UI), §12 (geometric-map stability — Beehive
   reads the same artefact), and §13 (post-fill re-validation —
   reconciler may surface this).
2. **`docs/IMPLEMENTATION_PLAN.md`** — Plan v2 with Stage 3's outline at
   the bottom. Use as the skeleton; expand as needed.
3. **`docs/STAGE2B_ULTRAPLAN_PROMPT.md`** — the predecessor brief (for
   shape and tone reference).
4. **The trading-system spec** lives on the operator's machine at
   `/home/skunkworks/Downloads/trading_system_claude_code (updated).txt`
   (1,512 lines). Stage 3 needs spec **Section 7** (MT5 integration +
   drift table), **Section 10** (Beehive overview), **Section 11**
   (full Beehive module spec — exact hex palette, cell visual states,
   pulse animation, HUD layout, command terminal), and lines
   **1066-1097** (drift detection in the Execution Architecture chapter).

## What's done — do not redo

### Stage 1 (`feat/cicada-stage1-trade-modes`, merged into 2a)
- 5-mode parameter table (parity-checked Python ↔ TS).
- Append-only `orders` + `sl_tp_events` SQLite, `sl_tp_manager.py`.
- The four spec bugs (immediate close, no dynamic SL, modes-share-logic,
  incomplete order records) regression-tested.

### Stage 2A (`feat/cicada-stage2a-bridge-latency`)
- `bridge/server.py` (FastAPI inside Windows VM, the ONLY allowed
  `import MetaTrader5`).
- `python/cicada_nn/mt5_bridge.py` (typed HTTP client, TTL cache).
- `python/cicada_nn/latency_monitor.py` + `latency_model.py` (RTT
  baselines, per-mode trade gates).
- `validate_order` checks 6 + 7 (latency).
- `bridge/server.py` `GET /account` (review §3.4).
- UI: BrokersManager bridge pill, ProcessMonitor latency strip.

### Stage 2B (`feat/cicada-stage2b-analytical-core`)
- `lookahead_validator.py` (mandatory pre-train assertion).
- `geometric_map.py` (content-addressed sha256, scipy-optional).
- `execution_quality_map.py` (per-coordinate spread/slippage/depth).
- `loss_inversion.py`, `bidirectional_analysis.py`, `context_layer.py`,
  `fakeout_detection.py` (FAKEOUT events distinct from `pa-fakeout`
  strategy id).
- `model.py` 4-class softmax (LONG / SHORT / NEUTRAL /
  FAKEOUT_REVERSAL) with LSTM 64u; `train.py` calls
  `lookahead_validator` before any train step.
- API endpoints: `GET /map/geometric/{symbol}`,
  `GET /map/execution_quality/{symbol}`, `POST /train/loss_inversion`,
  `POST /train/context_layer`, `GET /context_layer/{symbol}`.
- UI: `GeometricMapPanel.tsx` (read-only price ladder).
- **Live-only pipeline** — frontend trade loop deleted, demo mode
  removed, backend `ExecutionDaemon` is the canonical owner.
- All 240 Python tests + 85 vitest tests pass.

## Stage 3 — priority order (do not deviate)

This is the operator-facing finishing layer of the spec: a structural
visualiser, hard drift-detection actions, and a position reconciler that
halts trading on discrepancy. Build in this order; each step is a
shippable sub-deliverable with tests.

### 1. `python/cicada_nn/reconciler.py` — first

5-second `mt5.positions_get()` (via the bridge) poll. Compares MT5 open
positions against `orders` table where `status='filled'`. On
discrepancy:
- Position in MT5 but not in `orders` → ALERT, halt new placement, log
  for audit, do NOT auto-resume.
- Position in `orders` but not in MT5 → assume closed by broker, append
  a `closed` row with `close_reason='reconcile_implied'` and an
  `sl_tp_event` row of kind `reconcile_close`.

Spec lines 1050-1064 are the source. Build this FIRST because Stage 3's
drift actions depend on knowing the position truth.

### 2. `python/cicada_nn/drift_monitor.py`

Section 7 + lines 1066-1097 drift table, callable rules:
- `prediction_confidence_drop` (rolling avg over 20 trades, threshold
  0.55) → `no_new_orders`.
- `rolling_prediction_error` (50-trade window > 2× baseline) →
  `close_all_via_bridge` + soft retrain.
- `volatility_regime_shift` (ATR > 2σ of training distribution) →
  `suspend_placement` + rebuild geometric_map + execution_quality_map
  + full retrain.
- `fakeout_rate_anomaly` (> 3× historical fakeout rate over 50 trades)
  → soft retrain.
- `live_drawdown_breach` (> 3× expected from backtest) →
  `emergency_stop_with_audit`, requires manual approval to resume.

Each rule returns `(triggered: bool, action: enum)`. Actions wire into
`mt5_bridge.close_position` / order placement halts. Tests exhaustively
cover the table.

### 3. `python/cicada_nn/api.py`

- `GET /drift/status` — current drift state, last evaluation, action
  taken.
- `GET /reconcile/status` — last poll time, discrepancies, halt state.
- `POST /drift/resume` — manual approval to lift an
  emergency_stop_with_audit. Requires `X-API-Key` if
  `CICADA_API_KEY` is set.

### 4. `python/cicada_nn/daemon_runtime.py`

- Hook the reconciler into `_bootstrap_daemon` (env-gated like the
  latency monitor — `CICADA_DISABLE_RECONCILER=1` is the kill switch).
- Drift triggers call into `drift_monitor` actions on every tick of
  `execution_daemon._tick_once`.
- Halt flags (`new_orders_halted`, `emergency_stopped`) live in a
  thread-safe `DaemonGuards` dataclass; `daemon_submit_order` checks
  them and writes `REJECTED` rows with the appropriate reason.

### 5. `src/app/pages/GeometricMap.tsx`

New top-level route at `/dashboard/map`, added to `src/app/routes.ts`.
Uses the existing top header (logo, time, logout, broker pills,
LIVE/DISCONNECTED state pill) so it stays inside the dashboard chrome.

### 6. `src/app/components/Beehive/`

The canvas-based hex grid per **Section 11 of the spec — implement
verbatim**. Strict adherence required:

- **Palette**: ONLY the green hex list `#020d02 → #1aff1a` (Section 11
  lines 642-655). No other colours under any circumstance.
- **Grid math**: `HEX_R = 18px`, `HEX_W = HEX_R * 2`,
  `HEX_H = sqrt(3) * HEX_R`; cell coords per spec lines 660-665.
- **Cell visual states**: INACTIVE / IDLE NODE / FIRING NODE / FAKEOUT
  NODE — colour fills + borders per spec lines 690-712.
- **Pulse animation**: 2px dot + 0.15-progress trail, 0.06 + random(0,
  0.04) speed, 28% base cascade fire on arrival, max depth 5
  (lines 712-720).
- **Price level bands**: 8 horizontal bands, level activation every
  ~200 ticks, 50% chance per cell in band (lines 721-728).
- **HUD layout**: top-left stats (NODES / ACTIVE / PULSES / FAKEOUT /
  ENERGY), top-centre mode label, top-right price ticker, bottom
  terminal (`root@geomap:~$ `), event log above terminal (max 6 lines,
  fade #1aff1a → #0a5a0a → #020a02 over 6s).
- **Hover probe**: throttled 40ms, 9px title + 8px body fields, 'FAKEOUT
  ACTIVE' line in `#3aff3a` when applicable.
- **Commands**: `fire`, `fakeout`, `storm`, `reset`, `help` per spec
  lines 805-832.
- **Spontaneous behaviour**: 70-tick random fire, 200-tick level
  activation, 12-tick price update, 20-tick stats update.
- **60fps target** via `requestAnimationFrame`.

Files:
- `Beehive.tsx` — main canvas component.
- `cellModel.ts` — cell data model (lines 666-688).
- `commands.ts` — terminal command implementations.
- `Beehive.test.tsx` — render contract: every visual state in Section
  11 produces the right fills/borders. **No new colour appears in any
  rendered frame** (the test asserts on getImageData against the
  permitted palette).

Cells map 1:1 to price points loaded from `/map/geometric/{symbol}`.

### 7. `bridge/SETUP_RUNBOOK.md`

Operator runbook for one-time KVM Windows VM creation, MT5 install,
bridge auto-start (Windows Task Scheduler), network configuration
(virbr0 / SSH port-forward), benchmarking. Spec lines 1098-1127 +
1489-1503 are the source — convert into a checked, copy-pasteable
runbook with verification commands.

### 8. `src/app/store/TradingStore.tsx`

Add a `drift` slice hydrated from `/drift/status` (poll every 10s) and a
`reconcile` slice from `/reconcile/status`. Drift events flow through
to `BotExecutionLog` and the Beehive event log. When
`emergency_stopped` is true, the dashboard displays a red banner that
disables all bot-deploy buttons until manually resumed.

## Cleanup that may ride along (only if scope allows)

These are deferred from earlier reviews; Stage 3 should fold them in
**only if they don't slow the main deliverables**:

- Lock `_INSTRUMENT_SYMBOL_MAP` mutation in `daemon_runtime.py:145`
  (review §4.1).
- Convert the most impactful 48 broad `except Exception` blocks to
  typed exceptions with event-bus warnings (review §4.3).
- Add a post-fill re-validation hook (review §13) — re-run
  `validate_order` against the actual fill price; reject + close on
  mismatch.

If any cleanup is skipped, list it in the PR body.

## Out of scope for Stage 3

- Full Deriv / eXness frontend code deletion (still load-bearing for
  charts; deferred to a Stage 4 cleanup).
- TradingStore.tsx mega-store split (3,935 LOC).
- The dead `state.execution.enabled` toggle.
- Bundle-size warning (1.17 MB single chunk).
- CI configuration — separate concern.

## UI/UX guardrails — do not violate

- **Dashboard palette**: `#00ff00`, `#ff6600`, `#ffff00` + alpha
  variants `/40` `/50` `/70` `/80`. No new accent colours.
- **Beehive palette** (Section 11): the **only** allowed colours are
  the listed green hex codes `#020d02 → #1aff1a`. Even `#ff6600` from
  the dashboard is forbidden inside the Beehive surface.
- **Typography**: `text-[10px]`, `text-xs`, `text-sm` only. No
  oversized text. JetBrains Mono throughout.
- Reuse `RetroBox`, the corner-bracket box pattern, `[ LABEL ]`
  bracketed buttons, `tracking-wider` uppercase, neon `box-shadow`
  recipe.
- The Beehive command terminal uses spec font `Courier New` —
  acceptable because it's an in-Beehive surface and matches the
  spec's terminal aesthetic. Outside the Beehive, JetBrains Mono only.

## Test requirements

- **Reconciler**: fixture-based — inject a fake bridge that returns
  three positions, the orders table has two; assert
  `new_orders_halted=True`. Inject a bridge missing one position; assert
  the missing one gets `reconcile_implied` close + sl_tp_event.
- **Drift monitor**: every row of the Section 7 table produces the
  expected action enum on a deterministic fixture.
- **Drift API**: `GET /drift/status` returns the right shape; `POST
  /drift/resume` clears `emergency_stopped` only when API-key is
  correct.
- **Beehive**: render contract tests via `vitest` + jsdom canvas mock
  (or pixel sampling against `getImageData`). Every cell visual state
  produces the right palette colour. Pulse animation step is
  unit-tested for cascade probability and depth cap.
- **Daemon hooks**: `_bootstrap_daemon` starts the reconciler when env
  is default; skips when `CICADA_DISABLE_RECONCILER=1`. Tested via the
  same predicate-extraction pattern Stage 2B used for
  `latency_monitor_enabled`.
- **Append-only invariant**: any new SQLite tables (e.g. drift events
  if persisted) hold zero `UPDATE` statements; tested on a real tmp
  file.
- `npm run verify-all` + `npm run build` must pass after each commit.
- Trade-mode parity script must still pass.

## Do not

- Break Stage 1 + 2A + 2B tests (240 pytest, 85 vitest).
- Re-introduce demo mode, the frontend trade loop, or any synthetic
  data path.
- Add new colours or larger text to the UI.
- Import `MetaTrader5` outside `bridge/server.py` (the abstraction
  guard test will catch it).
- Modify `trade_modes.py` parameter table without updating
  `src/app/core/tradeModes.ts` and re-running parity.
- Land Beehive code that produces any colour outside the Section 11
  green palette.

## Deliverable

A pull request on `feat/cicada-stage3-beehive-drift` with all of steps
1–8 implemented (plus any cleanup that rode along), all tests passing,
and a brief PR body noting:
- What's done.
- What cleanup items rode along (or were skipped, with reason).
- Any open questions still unresolved.
- The post-merge migration story (e.g. operators need to update their
  VM bridge to expose `/account` if they hadn't yet).
