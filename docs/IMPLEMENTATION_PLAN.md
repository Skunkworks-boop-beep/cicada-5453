# Cicada-5453 — Refactor to Context-Centred Geometric Trading System

> **Plan version 2** — folded in the updated spec at
> `/home/skunkworks/Downloads/trading_system_claude_code (updated).txt`
> (1,512 lines, 77 kB; original was 891 lines, 48 kB). Two new chapters:
> **Execution Architecture** (Ubuntu host + KVM Windows VM + native MT5 +
> FastAPI bridge) and **Latency Modelling Module** (RTT monitor + session-aware
> baselines + per-mode trade gates + new orders-table columns).

## Context

The user has a 47k-LOC trading dashboard (React + Python FastAPI + optional MT5)
that already runs end-to-end in demo mode. The updated spec re-architects the
system around a **stable geometric price map**, **loss inversion**,
**bidirectional temporal analysis**, **fakeout detection as a separate event
class**, **execution-quality awareness**, **per-session latency gating**, and a
**KVM Windows VM hosting native MT5 behind an HTTP bridge**. It also fixes four
named bugs (immediate close, no dynamic SL, modes-share-logic, incomplete order
records). The existing UI/UX language (green-on-black CRT terminal, JetBrains
Mono, `#00ff00` / `#ff6600`, all-caps bracketed labels, neon glows, corner
brackets, `text-[10px]`/`text-xs` type scale) is preserved; robust tests on
every module.

## Decided constraints

1. **Phased rollout** — each stage individually shippable.
2. **MT5-only execution** — Deriv and Exness deprecated.
3. **Tick data via MT5 only** — through the bridge's `GET /ticks` endpoint
   (which wraps `mt5.copy_ticks_from()`/`copy_ticks_range()` inside the VM).
   When the bridge is unreachable, Phase 2b simply does not run.
4. **Five trade styles preserved** (`scalping`, `day`, `medium_swing`,
   `swing`, `sniper`) — each with a fully independent parameter set.
5. **KVM Windows VM bridge architecture** — all MT5 communication goes via
   HTTP to `localhost:5000`; **no module other than `mt5_bridge.py` knows
   that MT5 even exists**. This supersedes Stage 1's direct-import shape.

## Trade-mode parameter table (final, all five — locked from Stage 1)

| Parameter | SCALPING | DAY | MED_SWING | SWING | SNIPER |
|---|---|---|---|---|---|
| Timeframe | M1–M5 | M15–H1 | H1–H4 | H4–D1 | M15–H1 |
| Min holding period | 3 bars | 6 bars | 8 bars | 12 bars | 6 bars |
| Min TP distance | 0.5×ATR | 1.0×ATR | 1.5×ATR | 2.0×ATR | 1.5×ATR |
| Min SL distance | 0.3×ATR | 0.6×ATR | 0.8×ATR | 1.0×ATR | 0.8×ATR |
| Max SL distance | 1.0×ATR | 2.0×ATR | 3.0×ATR | 4.0×ATR | 2.5×ATR |
| SL management | Static | Trail after 1R | Breakeven@1R, trail | Breakeven@1R, trail | Trail from entry |
| TP management | Fixed | Partial@1R, rest@TP | Partial@1R, rest@2R | Partial@1R, rest@2R | Fixed |
| Entry confirmation | PA + map zone | PA + map zone + 1 indicator | Map zone + momentum | Map zone + momentum + structure | 2+ S/R confluence + map zone |
| Exit trigger | TP/SL/reversal after min hold | TP/SL/regime break | TP/SL/structure break | TP/SL/structure break | TP or SL only |
| Max concurrent | 3 | 2 | 2 | 2 | 1 |
| Confidence threshold | 0.60 | 0.65 | 0.70 | 0.70 | 0.80 |

Authoritative source: `python/cicada_nn/trade_modes.py` and
`src/app/core/tradeModes.ts`. Parity asserted by
`scripts/verify-trade-mode-parity.ts`.

## UI/UX guardrails (do not violate)

- **Palette** — only `#00ff00`, `#ff6600`, `#ffff00` (warning/active) +
  alpha variants (`/40`, `/50`, `/70`, `/80`). No new accent colours.
- **Typography** — only `text-[10px]`, `text-xs`, `text-sm` in components and
  `text-base` for body defaults. No oversized text. JetBrains Mono everywhere.
- **Component vocabulary** — reuse `RetroBox`, the corner-bracket box pattern,
  `[ LABEL ]` bracketed buttons, `tracking-wider` uppercase, neon
  `box-shadow: 0 0 N rgba(0,255,0,X)`.
- **Beehive** uses ONLY the green palette listed in Section 11
  (`#020d02 → #1aff1a`).

---

## Stage 1 — DONE (web Ultraplan session, branch `feat/cicada-stage1-trade-modes`)

✅ Merged into local checkout. **75 Stage 1 tests pass**:
`test_trade_modes`, `test_order_records`, `test_dynamic_sl`,
`test_immediate_close_bug`, `test_mt5_abstraction`, `test_sl_tp_manager`.

Delivered:
- `python/cicada_nn/trade_modes.py` — canonical 5-mode parameter table.
- `python/cicada_nn/order_records.py` — append-only `orders` + `sl_tp_events`
  SQLite tables.
- `python/cicada_nn/sl_tp_manager.py` — per-mode SL/TP lifecycle.
- `src/app/core/tradeModes.ts` + `src/app/core/orderRecords.ts` — TS mirrors.
- `scripts/verify-trade-mode-parity.ts` — Python↔TS parity check.
- Updates to `mt5_client.py` (still direct-import — refactored in Stage 2A),
  `daemon_runtime.py`, `execution_daemon.py`, `botExecution.ts`,
  `TradingStore.tsx`, `TradingModes.tsx`, `BotExecutionLog.tsx`,
  `BrokersManager.tsx`, `brokerExecution.ts`.
- 6 new test files; docs touch in `BUGS_FIXED.md` and `SETUP_LIVE.md`.

**WIP from before Stage 1** (audit-models endpoint, predict safety-floor
kill-switch, ProcessMonitor table, concentration/sizing rule tweaks) is
preserved on `origin/wip/audit-safety-floor-snapshot`. To revisit later.

---

## Stage 2A — Foundations: KVM bridge + latency module + MT5 layer refactor

**Goal**: rebuild the MT5 layer in the spec's HTTP-bridge shape. Add the
latency module so every order record carries execution-delta/anomaly/
predicted-slippage. **Backtest and demo mode keep working without a live
VM** (bridge calls are mocked or short-circuited when `is_baseline_valid()`
is False, depending on context).

### Files to add

- `python/cicada_nn/mt5_bridge.py` — **the new abstraction**. Pure HTTP
  client to the FastAPI bridge running inside the Windows VM at
  `localhost:5000`. Methods: `place_order`, `modify_sl`, `close_position`,
  `get_positions`, `get_ticks`, `get_history`, `health_check`. Re-uses
  the same method names as `mt5_client.py` so call-sites can be migrated
  with minimal churn. Connection failures bubble up as typed exceptions
  (`BridgeUnreachableError`, `BridgeRetcodeError`); never silently fail.
- `python/cicada_nn/latency_monitor.py` — background daemon thread.
  Measures RTT to `GET /health` every 30s, writes to `latency_log` SQLite
  table (append-only, same rules as `orders`). Tags each measurement
  with market session (SYDNEY / TOKYO / LONDON / NEW_YORK /
  LONDON_NY_OVERLAP / OFF_HOURS), day-of-week, hour-UTC, host CPU%, RAM%.
  Anomaly flag (`rtt > p95 * 1.5`).
- `python/cicada_nn/latency_model.py` — `get_baseline(session)`,
  `is_baseline_valid()`, `is_anomalous()`, `get_trade_gate(mode)`,
  `expected_slippage(mode, session)`, `session_profile()`,
  `day_of_week_profile()`. Per-mode gate logic per spec lines 1378–1396:
  SCALP strictest (`> p95*1.5` rejects), SWING moderate, SNIPER widest.
- `bridge/server.py` — the FastAPI server that runs inside the Windows
  VM. New top-level `bridge/` directory at the repo root (not under
  `python/`) so it's clear this is the VM-side service, not part of the
  Ubuntu trading code. Endpoints exactly per spec lines 1135–1199.
  Includes a runbook (`bridge/README.md`) for one-time VM setup.
- `bridge/test_bridge_contract.py` — contract tests that run **on Linux**
  using a stub MetaTrader5 module (the `MetaTrader5` Python package
  doesn't install on macOS/Linux; the stub gives us a testable surface).

### Files to modify

- `python/cicada_nn/mt5_client.py` — keep the file as the public surface
  but make every method delegate to `mt5_bridge.py`. **The only line that
  imports `MetaTrader5` is removed**. Section 7 abstraction rule now
  holds: zero non-bridge files import MetaTrader5. The existing
  `test_mt5_abstraction.py` becomes a stronger guard.
- `python/cicada_nn/order_records.py` — add columns to the `orders` table
  per spec lines 1284–1289: `execution_delta_ms`, `latency_baseline_ms`,
  `latency_anomaly`, `expected_slippage_ms`. Migration: `ALTER TABLE`
  with `IF NOT EXISTS` semantics; existing rows get `NULL` (handled in
  reads).
- `python/cicada_nn/trade_modes.py` — `validate_order(...)` gains two
  new pre-order checks per spec lines 1418–1431:
  6. `latency_model.is_baseline_valid()` — REJECTED with reason
     `BASELINE_NOT_ESTABLISHED`
  7. `latency_model.get_trade_gate(mode).allowed` — REJECTED with reason
     from gate (`LATENCY_ANOMALY`, `LATENCY_ELEVATED`, `LATENCY_SEVERE`,
     `LATENCY_EXTREME`).
- `python/cicada_nn/daemon_runtime.py` and `execution_daemon.py` — every
  call previously going to `mt5_client.something()` continues to work
  (the public surface is unchanged), so these files only need to verify
  no direct MT5 imports remain.
- `python/cicada_nn/api.py` — add `GET /latency/status`,
  `GET /latency/baseline`, `GET /bridge/health` (proxy to the VM bridge
  for the dashboard's connection panel).
- `src/app/core/api.ts` — TS clients for the new endpoints.
- `src/app/components/BrokersManager.tsx` — replace "MT5 add-on" panel
  with "MT5 bridge". Status pill shows: `BRIDGE OK` /
  `BRIDGE UNREACHABLE` / `MT5 DISCONNECTED INSIDE VM`. Same green/orange
  pill aesthetic as the existing broker pills.
- `src/app/components/ProcessMonitor.tsx` — add a small latency strip
  showing current RTT and per-session p95. Same `text-[10px]` rows
  pattern as the existing strip — no new colours.
- `src/app/store/TradingStore.tsx` — new `latency` slice hydrated from
  `/latency/status`.

### Tests to add (Stage 2A)

- `python/tests/test_mt5_bridge.py` — bridge HTTP client against a fake
  HTTPServer; verifies retry-on-5xx, typed exceptions, no MT5 import
  leakage. Re-asserts the abstraction property.
- `python/tests/test_latency_monitor.py` — RTT recording, session
  bucketing, anomaly flagging. Uses a fake `requests` impl so test
  doesn't need network.
- `python/tests/test_latency_model.py` — every cell of the per-mode gate
  matrix from spec 1378–1396; baseline staleness; expected-slippage
  regression on synthetic data; rejection-reason strings.
- `python/tests/test_orders_schema_v2.py` — new columns present;
  migration from v1 schema works; reads with NULL execution fields are
  safe.
- `python/tests/test_validate_order_with_latency.py` — checks 6 and 7
  reject correctly. Confidence-threshold + latency anomaly together
  produce REJECTED with the *first* failing reason (deterministic
  ordering, not random).
- `bridge/test_bridge_contract.py` — endpoint shape contracts using a
  stub `MetaTrader5` (verifies field names, retcode handling).

### Verification (Stage 2A)

```bash
# Python: full Stage 2A suite
python -m pytest python/tests/test_mt5_bridge.py python/tests/test_latency_*.py \
                 python/tests/test_orders_schema_v2.py \
                 python/tests/test_validate_order_with_latency.py -v

# Re-assert no MT5 import outside the bridge
python -m pytest python/tests/test_mt5_abstraction.py -v

# Demo mode end-to-end
npm run dev    # log in demo, deploy a bot, confirm:
               # - Brokers panel shows MT5 BRIDGE pill (UNREACHABLE in demo)
               # - ProcessMonitor latency strip is visible (RTT n/a)
               # - Orders are REJECTED with BASELINE_NOT_ESTABLISHED when
               #   live exec attempted in demo mode
```

---

## Stage 2B — Analytical core: maps, fakeout-as-event, look-ahead enforcement, NN retrain

**Goal**: deliver Phases 2, 2b, 3, 4, 5, 5b, 6 of the spec and retrain the NN
on the new context layer with strict look-ahead validation.

### Files to add

- `python/cicada_nn/geometric_map.py` — Phase 2. Stable S/R nodes, volume
  profile (KDE), fractal swing highs/lows. Computed once from full
  Parquet history; persisted to
  `python/checkpoints/geometric_map_<symbol>.parquet`. Rebuild only on
  volatility regime shift or full retrain. Reuses
  `python/cicada_nn/regime_detection.py` for the shift signal.
- `python/cicada_nn/execution_quality_map.py` — Phase 2b. Reads ticks
  via `mt5_bridge.get_ticks(...)` (NOT direct MT5 import). Per-coordinate
  `avg_spread`, `spread_variance`, `avg_slippage`,
  `partial_fill_probability`, `book_depth_proxy`, `latency_impact_estimate`.
  Stored as Parquet partitioned by instrument + date.
- `python/cicada_nn/fakeout_detection.py` — Phase 5b. Classifier per
  spec (breach < 1.5×ATR ∧ time_beyond ≤ 3 bars ∧
  volume-contraction-or-wick ∧ high return-velocity). Outputs a
  `FAKEOUT` event row, never a `LOSS`. Reuses
  `python/cicada_nn/signals.py:929` (`_detect_fakeout`) for the
  detection primitive.
- `python/cicada_nn/loss_inversion.py` — Phase 4. Re-enters every losing
  trade at the same price point in opposite direction with guaranteed
  fill (closed historical dataset). Produces `INVERSION` event row.
- `python/cicada_nn/bidirectional_analysis.py` — Phase 5. For each
  trade entry T, builds the lookback feature vector (all data ≤ T) and
  the look-forward label vector (all data > T). Reuses
  `python/cicada_nn/bar_features.py` for momentum/volume/candle features.
- `python/cicada_nn/context_layer.py` — Phase 6. Joins everything into
  the row schema from spec Section 2 Phase 6 (lines 200–222). Calls
  `lookahead_validator` before returning.
- `python/cicada_nn/lookahead_validator.py` — Section 5 enforcement.
  Two assertions:
  1. Every feature column for every row has timestamp ≤ T.
  2. No label column appears in the feature matrix.
  Mandatory pre-train pipeline step; raises `LookaheadLeakError`.

### Files to modify

- `python/cicada_nn/labeling.py` — repoint at the new `context_layer`
  schema. Add fourth class `FAKEOUT_REVERSAL`.
- `python/cicada_nn/model.py` — switch head to 4-class softmax (LONG /
  SHORT / NEUTRAL / FAKEOUT_REVERSAL). LSTM 64u per spec.
- `python/cicada_nn/train.py` — call `lookahead_validator` before any
  training step. Fail loudly on any leak. Train on the new context
  layer.
- `python/cicada_nn/backtest_parallel.py`, `backtest_server.py` —
  switch to reading from `geometric_map` + `execution_quality_map` so
  backtests are execution-aware (real spread/slippage from the
  coordinate system, not constants).
- `python/cicada_nn/api.py` — endpoints:
  `GET /map/geometric/{symbol}`,
  `GET /map/execution_quality/{symbol}`,
  `POST /train/loss_inversion`,
  `POST /train/context_layer`,
  `GET /context_layer/{symbol}`.

### UI surfaces (Stage 2B)

- `src/app/components/GeometricMapPanel.tsx` (new) — read-only S/R bands
  + volume nodes + fractal swings as a vertical price ladder with
  `text-[10px]` rows. Sits between `BotExecutionLog` and
  `BrokersManager` on the right column of `Dashboard.tsx`.
- `src/app/components/BacktestEngine.tsx`,
  `src/app/components/BacktestGridVisualization.tsx` — add an
  "execution-quality applied" line in result rows when the new pipeline
  ran. Same `[ LABEL ]` bracket pattern.

### Tests to add (Stage 2B)

- `test_geometric_map_stability.py` — same input → identical map hash;
  no bar-to-bar drift.
- `test_execution_quality_map.py` — round-trip through fake-bridge
  ticks; per-coordinate fields are present and non-negative.
- `test_fakeout_detection.py` — known historical fakeouts on fixture
  data classify as `FAKEOUT`, NOT `LOSS`.
- `test_lookahead_validator.py` — deliberately leak a label; assert
  validator raises. Pass clean data; assert succeeds.
- `test_loss_inversion.py` — every losing fixture trade produces an
  `INVERSION` row at the same price point.
- `test_context_layer_schema.py` — exact field-list match with spec
  Section 2 Phase 6.
- `test_nn_4class.py` — training run on tiny fixture asserts 4-class
  output and sensible confidence calibration.

### Verification (Stage 2B)

```bash
# Build maps from a fixture instrument (uses fake-bridge ticks)
python -m cicada_nn.geometric_map --symbol EURUSD --output check
python -m cicada_nn.execution_quality_map --symbol EURUSD --output check

# Full pipeline run end-to-end on fixture
python -m pytest python/tests/test_*pipeline*.py -v

# Look-ahead bias check is mandatory and runs on every train invocation
python -m pytest python/tests/test_lookahead_validator.py -v

# UI inspection
npm run dev   # open Geometric Map panel, scrub instruments, verify map
              # is stable (no flicker), exec-quality cells populate only
              # when the bridge is reachable (i.e. live MT5 available)
```

---

## Stage 3 — Beehive visualiser, drift hardening, reconciliation polish, VM runbook

**Goal**: deliver the spec's Section 10/11 (Beehive visualiser) as a route at
`/dashboard/map`, plus hardened drift detection, plus the 5-second position
reconciliation poll loop, plus the VM-setup runbook.

### Files to add

- `src/app/pages/GeometricMap.tsx` — new top-level route. Uses existing
  top header (logo, time, logout, broker pills) so it stays inside the
  dashboard chrome.
- `src/app/components/Beehive/Beehive.tsx` — canvas hex grid per
  Section 11. `requestAnimationFrame` render loop, motion-blur trail,
  hover probe, command line, event log. **Strictly the green palette
  listed in Section 11** (`#020d02 → #1aff1a`). 60fps target.
- `src/app/components/Beehive/cellModel.ts` — cell data model from
  Section 11; cells map 1:1 to price points loaded from
  `/map/geometric/{symbol}`.
- `src/app/components/Beehive/commands.ts` — `fire`, `fakeout`, `storm`,
  `reset`, `help`.
- `python/cicada_nn/drift_monitor.py` — Section 7 + spec lines 1066–1097
  drift table as callable rules. Each rule returns
  `(triggered: bool, action: enum)`. Actions map to bridge calls
  (`no_new_orders`, `close_all_via_bridge`, `suspend_placement`,
  `soft_retrain`, `emergency_stop_with_audit`).
- `python/cicada_nn/reconciler.py` — 5-second poll. Compares
  `mt5_bridge.get_positions()` vs `orders` table where
  `status='OPEN'`. On discrepancy: alert, halt new placement, do not
  resume until manually resolved.
- `bridge/SETUP_RUNBOOK.md` — operator runbook for one-time KVM Windows
  VM creation, MT5 install, bridge auto-start, network configuration,
  and benchmarking (per spec lines 1098–1127, 1489–1503).

### Files to modify

- `src/app/store/TradingStore.tsx` — drift events flow through the
  existing drift slice; surface in Beehive event log + `BotExecutionLog`.
- `python/cicada_nn/daemon_runtime.py` — drift triggers call into
  `drift_monitor` actions. Reconciliation poll runs in a daemon thread.
- `python/cicada_nn/api.py` — `GET /drift/status`, `GET /reconcile/status`.

### Tests to add (Stage 3)

- `test_drift_monitor.py` — every row of the spec Section 7 +
  lines 1066–1097 drift table.
- `test_reconciliation.py` — inject a discrepancy in a fake bridge,
  assert daemon halts new orders.
- `Beehive.test.tsx` — render contract: every cell visual state in
  Section 11 produces the right fills/borders. No new colour appears
  in any rendered frame.

### Verification (Stage 3)

```bash
python -m pytest python/tests/test_drift_monitor.py \
                 python/tests/test_reconciliation.py -v

npm run dev   # /dashboard/map — visually confirm the map renders, all
              # commands fire, palette stays green-only, no oversized
              # text. Beehive runs at 60fps.
```

---

## Cross-cutting work

- **Single source of truth for parameters** — `trade_modes.py` and
  `tradeModes.ts`; parity asserted in CI.
- **Magic numbers** are constants in one place: SCALPING=1001,
  DAY=1002, MED_SWING=1003, SWING=1004, SNIPER=1005 — defined in
  `trade_modes.py` only.
- **No mocked databases in tests** — order/event/latency tests use a
  real SQLite file in a tmp dir.
- **Append-only invariants** (`orders`, `sl_tp_events`, `latency_log`)
  are property-tested with `hypothesis` (added to
  `python/requirements.txt`).
- **Directory layout decision** — keep the existing flat
  `python/cicada_nn/` for now (Stage 1 is already there). The spec's
  `pipeline/` / `live/` / `execution/` / `modes/` / `data/` / `maps/`
  / `models/` layout is a future restructure (Stage 4 if/when wanted)
  and can be done as a pure rename PR. New files in Stage 2A/B/3 use
  the spec's *names* (`mt5_bridge.py`, `geometric_map.py`,
  `execution_quality_map.py`, `fakeout_detection.py`,
  `loss_inversion.py`, `bidirectional_analysis.py`, `context_layer.py`,
  `lookahead_validator.py`, `latency_monitor.py`, `latency_model.py`,
  `drift_monitor.py`, `reconciler.py`) so the rename is mechanical
  later.

## Top-level verification (after all three stages)

```bash
# Python: full suite
python -m pytest python/tests/ -v --tb=short

# TS: full suite + coverage
npm run test:coverage

# Parity & wiring scripts
npm run verify-all
npm run verify-trade-mode-parity

# Demo end-to-end
npm run dev
# Open browser, log in demo, deploy a bot, confirm:
#   - SCALPING bot won't close before bar 3
#   - SWING bot SL trails to breakeven at +1R; each move a NEW row
#   - Order records are append-only
#   - Bridge pill shows BRIDGE UNREACHABLE in demo (no VM running)
#   - Latency strip shows RTT n/a; orders REJECTED with
#     BASELINE_NOT_ESTABLISHED if live exec attempted in demo
#   - Geometric map panel renders, stable across reloads
#   - Beehive at /dashboard/map runs at 60fps and stays green-only
#   - With bridge reachable: ticks flow, exec-quality fields populate
#   - Lookahead validator runs on every NN train; fails the build on leakage
```

## Session pacing reality check

This refactor remains multi-day work. **One session realistically covers
Stage 2A** (MT5 bridge + latency module + orders schema migration + the two
new validation checks + tests) — the fastest path to landing the updated
spec's foundations. **Stage 2B** (analytical core + NN retrain) is a
separate session: it depends on real OHLCV at minimum, and execution-quality
needs a reachable bridge. **Stage 3** is a third session.

## What we're starting now

Stage 2A. Concretely, the order of work in this session:

1. Add `bridge/` directory + `bridge/server.py` skeleton + contract tests
   (Linux-runnable using a stub MetaTrader5).
2. Add `python/cicada_nn/mt5_bridge.py` (HTTP client to the bridge).
3. Refactor `python/cicada_nn/mt5_client.py` to delegate to
   `mt5_bridge.py`; remove direct `import MetaTrader5`.
4. Add `python/cicada_nn/latency_monitor.py` and
   `python/cicada_nn/latency_model.py` + `latency_log` table.
5. Migrate `orders` schema to add the 4 new latency columns.
6. Extend `validate_order(...)` with checks 6 and 7.
7. Add the 6 new test files; run the whole Python suite.
8. UI: `BrokersManager` swap MT5 add-on → MT5 bridge pill;
   `ProcessMonitor` latency strip; `TradingStore` latency slice;
   `api.ts` clients.
9. Run `npm run test:coverage`, `npm run verify-all`, demo-mode smoke.
10. Commit on a new working branch `feat/cicada-stage2a-bridge-latency`,
    push, open PR.
