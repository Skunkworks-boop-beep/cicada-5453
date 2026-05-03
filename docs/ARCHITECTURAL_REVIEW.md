# Cicada-5453 — Architectural Review (Stage 2A baseline)

> Date: 2026-05-03 · Branch: `feat/cicada-stage2a-bridge-latency` ·
> Reviewer: deep audit pass before handing Stage 2B planning to Ultraplan.
>
> Scope: the codebase as it stands after Stage 1 (web Ultraplan) + Stage 2A
> (local). Specifically calling out:
>   1. issues that exist today and will hurt if not fixed
>   2. self-critique of Stage 2A choices
>   3. design tensions Stage 2B and 3 will collide with
>   4. caveats Ultraplan should be told before it plans Stage 2B

Findings are **severity-ranked** (P0 = ship-blocker / silent-correctness;
P1 = real risk in production; P2 = code-health; P3 = nit).

---

## TL;DR — top 7 things to address

| # | Severity | Finding | Surface |
|---|----------|---------|---------|
| 1 | **P0** | Look-ahead-bias enforcement is documented but not implemented. The spec mandates a runtime assertion `features.index <= T` on every train; nothing in the code does that. `dataEndTime` is only used at the **result-row** level, not the feature-vector level. | `train.py`, `labeling.py`, `backtest_parallel.py` |
| 2 | **P0** | **Two trade-execution loops co-exist.** The frontend `runBotExecution` (browser) currently owns live trading; the backend `ExecutionDaemon` is gated off by default (`CICADA_ENABLE_EXECUTION_DAEMON=0`). Spec says backend owns the live loop. Today, validation, SL/TP management, order records, and latency gates **only fire when the backend daemon is enabled** — most users will never see them. | `daemon_runtime._auto_daemon_enabled`, `botExecution.ts:runBotExecution` |
| 3 | **P0** | Stage 2A bug I introduced: `mt5_client.MT5_AVAILABLE` is now a `__getattr__` property that hits the bridge's `/health` over HTTP **on every access** (1s timeout). Any caller in a hot path will pay that latency. | `mt5_client.py:50-58` |
| 4 | **P1** | `LATENCY_MONITOR.start()` runs as a **side-effect of importing `cicada_nn.api`**. Tests, REPL inspection, or any tool that imports the module spins up a daemon thread that polls `localhost:5000` every 30s. | `api.py` (in `_bootstrap_daemon`) |
| 5 | **P1** | Bridge's account info is **only the login string**. `mt5_client.get_account()` now returns `balance=0.0`, `equity=0.0` as placeholder zeros — the dashboard surfaces these as real zeros. Not a NULL. Misleading. | `mt5_client.py:88-110`, BrokersManager rendering |
| 6 | **P1** | `get_symbol_spreads()` and `get_prices()` post-Stage-2A return empty dicts unconditionally. Anything that relied on live spread/quote (BacktestEngine instrument spreads, the live-spread panel) now silently degrades. | `mt5_client.py`, `LiveSpreadPanel.tsx`, `BacktestEngine` |
| 7 | **P1** | Three cicada_nn modules — `paper_trades.py`, `closed_trade_learning.py`, `model_audit.py` — exist as untracked working-tree files on `feat/cicada-stage1-trade-modes` but were **never committed on this branch**. `api.py:483` does a runtime import of `model_audit`. A clean checkout of this branch on a fresh machine 500s on `GET /audit/models`. | git state |

Detailed sections below.

---

## 1. Architectural shape (today)

### Two-process system

```
┌──────────────────────────┐         ┌────────────────────────────┐
│ Browser (React)          │  HTTP   │ Ubuntu host (FastAPI)      │
│ TradingStore.tsx 3,935L  │ ──────▶ │ cicada_nn.api              │
│   - all client state     │         │   - /build /predict /jobs  │
│   - persistence (FS sync)│         │   - shadow training        │
│   - **runBotExecution**  │         │   - **ExecutionDaemon**    │
│     (live trade loop)    │         │     (off by default)       │
│   - calls placeBrokerOrder──────▶  │   - mt5_client → mt5_bridge│
└──────────────────────────┘         │   - latency_monitor (30s)  │
                                     │   - order_records (SQLite) │
                                     └─────┬──────────────────────┘
                                           │  HTTP localhost:5000
                                           ▼
                                     ┌────────────────────────────┐
                                     │ KVM Windows VM             │
                                     │ bridge/server.py           │
                                     │   - import MetaTrader5     │
                                     └─────┬──────────────────────┘
                                           │
                                           ▼
                                     ┌────────────────────────────┐
                                     │ Broker                     │
                                     └────────────────────────────┘
```

### Ownership model is muddled

- The **frontend** holds 3,935 lines of state in one file (instruments,
  brokers, strategies, backtest, research, bots, execution, portfolio,
  schedule, closed trades, backward validation, drift, rebuilds).
- The **frontend** runs the live trade loop (`runBotExecution`) by default.
  This is the path every demo user hits.
- The **backend daemon** is the spec-aligned owner — but is opt-in. It
  validates per mode, writes append-only orders, runs SL/TP lifecycle,
  records latency gates. Nothing of that fires when the backend daemon is
  off.

The Stage 1 + 2A work is **all on the backend daemon path**. The frontend
loop has no equivalent: no per-mode `validate_order`, no `sl_tp_manager`,
no `order_records.append_order`, no latency gate. The `f658b05` commit
made small additive edits to `botExecution.ts` and `BrokersManager.tsx`
but did not migrate the trade loop.

**Implication for Stage 2B/3:** unless the backend daemon becomes the
default trade owner, the geometric-map / execution-quality / fakeout-as-
event work also won't reach live trades. Stage 2B builds the analytical
core on the backend; the frontend loop won't see it.

This is the **single biggest architectural decision** to surface to
Ultraplan.

---

## 2. Look-ahead bias — the spec's #1 failure mode

Spec §5: *"Before training, run automated validation: Assert: zero feature
columns have timestamps > T for any row in dataset. This check must run as
part of the build pipeline every time. It is not optional."*

### What exists

- `BacktestResultRow.dataEndTime` — last-bar timestamp of the run, used to
  filter rows when feeding `postBuild` (avoids training on validation slice).
  This is a **result-row** filter, not a **feature-column** filter.
- `splitBacktestResultsForOOS` — temporal split of result rows for OOS
  evaluation.
- `train.py` docstring mentions identity leak prevention (V1 → V3 evolution).
- A handful of code comments mention "leak" (5 occurrences). No assertion code.

### What's missing

- No `lookahead_validator.py` (the Stage 2B spec module).
- No code path asserts that for any training row at time T, every input
  feature column was computed from data with timestamp ≤ T.
- The bidirectional analysis (Phase 5) has not been built, so the test
  surface for this assertion doesn't exist yet.

### Why it matters

The spec is explicit: *"There is no graceful degradation — it breaks
completely. A model that leaks future data will backtest perfectly and
fail immediately in live trading."*

This is the **single highest-leverage thing** Stage 2B must land.
Recommendation: write the validator FIRST in Stage 2B, before
`geometric_map`, before `context_layer`. Any new feature module gets
shape-tested against it.

---

## 3. Self-critique of Stage 2A

### 3.1 `MT5_AVAILABLE` does an HTTP call per access — P0

`mt5_client.py:50-58`:

```python
def __getattr__(name: str) -> Any:
    """``MT5_AVAILABLE`` is computed on access so callers see live bridge state."""
    if name == "MT5_AVAILABLE":
        return _bridge_available()
    raise AttributeError(name)
```

`_bridge_available()` calls `mt5_bridge.is_reachable(timeout_s=1.0)` which
does a real HTTP `GET /health`. Any code that does
`if mt5_client.MT5_AVAILABLE:` in a hot loop pays a 1s timeout on each
access in the failure case. Even on success it adds a network roundtrip.

Concrete hits from grep:
- `daemon_runtime.py:118` — `if not mt5_client.is_connected():` (separate
  call, but `is_connected` also hits the bridge — *same problem in a
  different shape*).
- `daemon_runtime.py:398` — `if mt5_client.is_connected() and ...` per
  order submit.
- `daemon_runtime.py:521` — `if mt5_client.is_connected():` per SL event.

**Fix:** cache the reachability state with a TTL (say 5s) inside
`mt5_bridge`. Daemon ticks at scope intervals (15-120s); a 5s cache means
at most one bridge probe per tick instead of 3-N probes.

### 3.2 Latency monitor starts as a side-effect of importing api.py — P1

`api.py:_bootstrap_daemon` calls `LATENCY_MONITOR.start()`. The
`@app.on_event("startup")` decorator only fires when uvicorn boots, but
the monitor itself is created at module import time
(`LATENCY_MONITOR = LatencyMonitor(...)`).

Today's failure mode:
- A test that imports `cicada_nn.api` to inspect routes constructs the
  monitor object (no thread yet — `__post_init__` only creates the
  `Event`).
- A test that triggers `_bootstrap_daemon` (e.g. by calling `app.startup`
  for endpoint contract testing) starts a real thread, polling
  `localhost:5000` every 30s for the test process lifetime.
- The thread will continue probing even after the test exits, until the
  Python process dies. Daemon threads die with the parent process, but
  test runners often spawn subprocesses and orphans aren't impossible.

**Fix:** gate the start with `os.environ.get("CICADA_LATENCY_MONITOR")
in {"1","true",...}` or only start when uvicorn is actually serving (check
for the absence of a `pytest` marker, or use lazy-start triggered by the
first `/latency/status` call).

### 3.3 The SQLite file is shared between OrderRecordStore and LatencyLogStore — P2

Both connect to `orders.sqlite` with WAL+NORMAL. WAL serialises writers
correctly, but:
- `OrderRecordStore` and `LatencyLogStore` each hold their own connection
  with their own `threading.Lock`. SQLite's file lock prevents corruption,
  but the two python locks don't coordinate.
- Latency monitor writes every 30s → ~2,880 writes/day.
- Order pipeline writes per intent/submit/fill/SL move → low volume but
  bursty.

In normal use this is fine. Under load (heavy backtest writing thousands
of paper-trade rows + live latency monitor running) you'd see SQLite
`SQLITE_BUSY` retries. Not a bug; a smell.

**Fix later (P3):** consider separate files (`orders.sqlite`,
`latency.sqlite`) — the spec says "single trading.db" but that's a logical
grouping, not a filesystem one.

### 3.4 Bridge's `get_account()` placeholders — P1

The spec's `/health` returns only `{status, mt5_connected, account}` where
`account` is the login string. `mt5_client.get_account()` synthesises a
full account dict but with `balance=0.0`, `equity=0.0` as placeholders.

The dashboard (`Dashboard.tsx` for status strip, BrokersManager for the
broker row) renders these as real zeros. The Stage 2A
`BrokersManager.tsx` MT5 BRIDGE pill side-steps the issue (it shows
`BRIDGE OK · {account}`), but the **legacy** broker rows still call
`getMt5Account()` and get balance=0.

**Fix:** add a `/account` endpoint to the bridge (calls
`mt5.account_info()` returning full balance/equity/currency/leverage) and
have `mt5_client.get_account()` proxy to it. ~20 lines on each side, low
risk.

### 3.5 `get_symbol_spreads()` and `get_prices()` return empty dicts — P1

Same root cause as 3.4 — these aren't on the bridge yet. Anything that
populated UI from them now silently shows blanks.

Concrete consumers:
- `LiveSpreadPanel.tsx` — likely shows nothing.
- `BacktestEngine.tsx` — `instrumentSpreads` was sourced from MT5; now
  empty, falls back to a constant.
- `Dashboard.tsx` ticker bar — may show broker quotes from Deriv/Exness
  which still work (frontend has separate fetch paths for those), so
  partially OK.

**Fix:** add `/symbol/spread` and `/symbol/tick` endpoints to the bridge.
Or: switch the dashboard to read live spread from the **execution-quality
map** that Stage 2B builds (per-coordinate `avg_spread`). The latter is
spec-aligned.

### 3.6 Stage 2A trade-mode extrapolation — P3 (heads-up, not a bug)

I extrapolated DAY and MED_SWING parameters from the spec's SCALP / SWING
/ SNIPER table. The user accepted these, but:

| Param | DAY (mine) | MED_SWING (mine) |
|---|---|---|
| Min hold | 6 bars | 8 bars |
| Min TP | 1.0×ATR | 1.5×ATR |
| Min SL | 0.6×ATR | 0.8×ATR |
| Max SL | 2.0×ATR | 3.0×ATR |
| SL mgmt | trail after 1R | breakeven@1R, trail |
| Confidence threshold | 0.65 | 0.70 |

These are reasonable interpolations but **not validated against backtest
data**. Once Stage 2B ships, run a parameter sweep on each style and tune
these to maximise OOS profit factor while keeping the spec's strict
independence rule. Mark as a Stage 2B deliverable.

### 3.7 Latency-mode mapping for the spec's 3-mode rules to our 5 — P2

Spec lines 1378-1396 specify gates for SCALP / SWING / SNIPER only. I
mapped:
- DAY → between SCALP and SWING (1.5/2.0 thresholds, non-strict elevated)
- MED_SWING → closer to SWING (1.7/2.5)

These are defensible but not from the spec. Tests pass; behaviour is
sensible. Worth documenting in the parity script's output (currently it
only checks the trade-mode parameter table, not the latency thresholds).

---

## 4. Concurrency hazards

### 4.1 `_INSTRUMENT_SYMBOL_MAP` mutated without a lock — P2

`daemon_runtime.py:145` and `set_instrument_symbol_map()` mutate a
module-global dict. Worker threads read it during `fetch_bars_for_daemon`.

Race scenario: FE pushes a new symbol map (`POST /daemon/symbols`)
mid-tick. Reader sees a partial state.

In practice the dict has 1-100 entries and Python's `dict.clear()` +
`dict.__setitem__` are GIL-protected at the C level — for primitive
key/value types, individual operations are atomic. But the **clear-then-
populate** pattern in `set_instrument_symbol_map` opens a window where the
reader sees an empty map.

**Fix:** wrap `set_instrument_symbol_map` mutation under a lock and
materialise the dict atomically (`new = dict(items); _MAP = new`).

### 4.2 `_LAST_CREDS` access through `getattr` — P3

`daemon_runtime.py:120`:
```python
if getattr(mt5_client, "_LAST_CREDS", None):
    ok, _ = mt5_client.reconnect()
```

Accessing a private name through getattr is a code smell; the value also
isn't lock-protected. Low risk (creds change rarely), but `mt5_client`
should expose a public `has_cached_credentials()` predicate.

### 4.3 The 48 broad `except Exception` blocks — P2

48 occurrences across `cicada_nn/`. Many are intentional ("never crash
the daemon thread"), but examples like `daemon_runtime.py:131` swallow
`Exception` from `mt5_client.get_rates()`. If MT5 returns a malformed
shape, the daemon silently returns empty bars and skips the tick — no
metric, no alert.

**Fix:** convert most of these to specific exception classes
(`BridgeError`, `sqlite3.Error`, `KeyError`, `ValueError`) and emit an
event-bus warning when caught. The "never crash the thread" goal is
preserved while making failures observable.

---

## 5. The frontend trade loop is a missed surface

`runBotExecution` (`botExecution.ts:492`) is the live trade loop most
demo/operator sessions actually run. It does **none of the Stage 1+2A work**:

| Stage 1+2A change | Backend (daemon) | Frontend (`runBotExecution`) |
|---|---|---|
| Per-mode `validate_order` | ✅ `execution_daemon.py:399` | ❌ |
| Append-only `order_records` | ✅ via `daemon_submit_order` | ❌ uses `addPosition` directly |
| SL/TP lifecycle (BE, trail) | ✅ `sl_tp_manager` | ❌ flat SL only |
| Min-hold gate (bug 1) | ✅ `bars_since_last_open` | ❌ |
| Latency gate (checks 6/7) | ✅ via `latency_model` | ❌ |

**Implication:** the four named bugs in the spec **are still alive in the
frontend trade loop** that most users hit. The promise that Stage 1
"shipped" the bug fixes is true *only for the backend daemon path that's
off by default*.

This needs explicit treatment in Stage 2B/3 planning:
- Option A: cut the frontend loop entirely, force backend ownership.
- Option B: port `validate_order`, `sl_tp_manager`, and the order-record
  emission to TS so both loops are spec-compliant.
- Option C: keep the frontend loop demo-only (synthetic OHLCV, no live
  broker), have the backend own all live trades.

The spec implies Option C. The current `_auto_daemon_enabled()` gate
defaults to "frontend owns" — the opposite. This decision should be
front-and-centre in Stage 2B.

---

## 6. Demo mode vs live mode — separation is leaky

- **Frontend demo mode** is the default: synthetic OHLCV, no broker, the
  whole stack works in-browser.
- **Backend** has no demo mode. `fetch_bars_for_daemon` returns `[]` when
  MT5 isn't connected. Backtest server uses MT5-only data (per Stage 1's
  removal of Deriv/Exness).
- **Stage 2A** added the bridge layer. With the bridge unreachable,
  backend orders REJECT with `BASELINE_NOT_ESTABLISHED` (after 20 RTT
  samples accumulate, which never happens without a bridge).

The seam: a demo user runs the frontend loop with synthetic OHLCV;
backend latency monitor is live but never gets a healthy bridge → its
samples are all `null` rtt with `BRIDGE_UNREACHABLE` notes. The demo user
never sees the latency strip populated unless they run a real bridge.

**This is fine** — the demo is browser-only, the backend story starts
when MT5 is real. But it should be **explicitly documented**: the
ProcessMonitor latency strip says `RTT n/a, samples 0` in demo, which is
correct but looks broken at first glance. Add a `[ DEMO MODE — BRIDGE
NOT REQUIRED ]` hint when the bridge is unreachable AND no live brokers
are connected.

---

## 7. Append-only invariants — code-level

Good news: zero `UPDATE` statements found against `orders`,
`sl_tp_events`, `latency_log`. The invariant is **enforced by code**, not
just convention. Tests assert it (`test_order_records.py`).

Caveats:
- The invariant relies on every caller using `append_order()` /
  `append_sl_tp_event()`. There's nothing stopping a future contributor
  from opening the SQLite file and running raw SQL. A pre-commit hook or
  schema-level `CREATE TRIGGER ... INSTEAD OF UPDATE ... NOTHING` would
  harden this.
- Latency log inherits the invariant by construction (only an `append`
  method exists). Same caveat applies.

---

## 8. Frontend code-health

### 8.1 `TradingStore.tsx` is 3,935 lines

Single mega-store. Holds 13 distinct concerns (instruments, brokers,
strategies, backtest, research, bots, execution, portfolio, schedule,
closedTrades, backwardValidation, log streams, persistence). Splitting
into slices would:
- Reduce blast radius of edits (Stage 1 already had a `getJobRecord`
  drift here).
- Make persistence more granular (currently a single `persist()` writes
  everything).
- Enable code-splitting in the Vite bundle (currently 1.2MB single
  chunk warning).

Not Stage 2B work. Note for future cleanup.

### 8.2 Bundle size warning

`dist/assets/index-Bpa7-MZ8.js 1,218.30 kB` — single chunk over 500kB
threshold. Vite suggests `build.rollupOptions.output.manualChunks`. Not
critical but UX-affecting on slow connections.

### 8.3 `getJobRecord` was missing from api.ts (fixed in Stage 2A)

Symptom: `npm run build` failed on `succes-v1` and
`feat/cicada-stage1-trade-modes`. This means **Stage 1's commit was
broken** — the web Ultraplan session removed `getJobRecord` from `api.ts`
without removing the import in `TradingStore.tsx`. Fixed now, but the
process produced a non-building commit. Worth adding `npm run build` to
the parity verification suite (`npm run verify-all`) to catch this class
of error pre-commit.

---

## 9. Three orphaned `cicada_nn` modules — P1

`paper_trades.py`, `closed_trade_learning.py`, `model_audit.py` exist on
disk **but are not tracked** on `feat/cicada-stage1-trade-modes`:

```bash
$ git log --all --oneline -- python/cicada_nn/paper_trades.py
(no output)
```

Yet `api.py:483` imports `model_audit` at runtime:
```python
from .model_audit import audit_checkpoints, audit_summary
```

A clean checkout of this branch on a fresh machine **500s on
`GET /audit/models`**. The endpoint is silent until called — the test
suite doesn't exercise it (it's a UI-only endpoint, polled by
ProcessMonitor).

**They are tracked on `wip/audit-safety-floor-snapshot`**. They came
across when I switched branches because untracked files persist. This is
both a Stage 1 oversight and a Stage 2A pickup — the wip files were
preserved (good) but the `feat/cicada-stage1-trade-modes` branch
references them via api.py without owning them.

**Fix:** decide. Either (a) commit these files onto Stage 1 (or a Stage
1.1 follow-up) since `api.py` already references them, or (b) remove the
`/audit/models` endpoint and the import from `api.py` until they land
properly.

I'd recommend (a) because the `42 wins / 0 losses on R_10 (+$348)` data
the operator referenced in the predict safety-floor docstring suggests
the audit code is load-bearing in their day-to-day. But it should be a
deliberate decision.

---

## 10. Tests — coverage and gaps

### 10.1 What runs locally now

- 150/150 Stage 1 + 2A pytest tests pass.
- 80/80 vitest tests pass.
- Trade-mode parity passes.
- `npm run build` clean.

### 10.2 What doesn't run on this machine

The "heavy" pytest suites need numpy/torch/scipy/pandas which aren't in
the lightweight venv I built:

- `test_full_history.py` — full-history pipeline integration
- `test_jobs_and_shadow.py` — JOB_MANAGER + ShadowRegistry
- `test_model_audit_and_safety.py` — `model_audit` module
- `test_new_nn_pipeline.py` — V3 detection model
- `test_research_server.py` — grid research server
- `test_backward_validation*.py` — backward validation API + module

These run in CI presumably, but **CI status is unknown** — the
`scripts/verify-all.sh` and `npm run verify-all` we have don't gate on
them. Worth checking that CI is green and adding the heavy suites to the
verify chain so Stage 2B doesn't accidentally break them.

### 10.3 Tests we don't have but probably want

- **End-to-end smoke**: `npm run dev` + `uvicorn` + a fake bridge —
  click through demo-mode checkout, deploy a bot, verify SCALPING bot
  doesn't close before bar 3. Requires Playwright or similar; not in the
  repo today.
- **`mt5_client.MT5_AVAILABLE` doesn't double-call** — the property bug
  in §3.1 needs a regression test.
- **Latency monitor doesn't start when only api module is imported** —
  for the side-effect bug in §3.2.
- **Order pipeline integration**: signal → validate → append intent →
  bridge place_order → append filled → first sl_tp_event row. End-to-end
  in one test using a fake bridge.

---

## 11. The fakeout duality (heads-up for Stage 2B)

`pa-fakeout` exists today as a **strategy ID** (`signals.py:929`,
`signals.ts:2415`, `patternDetection.ts:85`). It produces a -1/0/+1
trading signal.

The spec's Phase 5b wants `FAKEOUT` as an **event type** (4-class
softmax: LONG / SHORT / NEUTRAL / FAKEOUT_REVERSAL). Different concept.

If Stage 2B isn't careful these will collide. The integration plan:
- Keep `pa-fakeout` as a strategy signal source for backward-compat.
- Add `fakeout_detection.py` that observes price action at S/R nodes and
  emits a separate `FAKEOUT` event when the spec's threshold matches
  (breach < 1.5×ATR ∧ time_beyond ≤ 3 bars ∧ contraction-or-wick ∧ high
  return-velocity). This event flows into the **context layer** as a
  label; the strategy continues to fire signals on its own.
- The NN's 4th class predicts `FAKEOUT_REVERSAL` (the post-fakeout
  reversal entry); the strategy signal's role is unchanged.

Document this clearly in Stage 2B's plan so the contributor doesn't
collapse them.

---

## 12. The geometric map's "stable coordinate system" guarantee

Spec: *"Computed ONCE from the full historical record. Never recomputed
bar-to-bar during backtest. Only rebuilt on volatility regime shift or
full system retrain."*

This is a strong claim. To honour it Stage 2B needs:
- A persisted, content-addressed map artifact (e.g.
  `geometric_map_<symbol>_<sha>.parquet`) so the same input always
  produces the same map (and a hash mismatch screams).
- A regime-shift detector that triggers rebuild explicitly. Spec hand-
  waves "rebuild on volatility regime shift"; what's the threshold? ATR
  > 2σ for N consecutive bars? Worth pinning down.
- Tests that load a fixture, build the map, hash it, mutate one bar
  outside the build window, rebuild, assert hash unchanged. (Stability
  invariant.)

Without these, "stable coordinate system" decays into "whatever was last
computed" — and the bidirectional analysis claim breaks.

---

## 13. The bridge's `place_order` slippage problem

`bridge/server.py` always uses `tick.bid/ask` at request time:

```python
price = float(tick.ask if req.direction == "LONG" else tick.bid)
```

But `validate_order` ran **before** the request was sent, validating
against a `signal.entry_price` that came from the bot's bar-close. If the
market moves between signal generation and order send, the validated
TP/SL distance may be below mode minimum at the actual fill price. Order
goes through anyway because the bridge re-prices.

**Mitigation options:**
- Re-run `validate_order` against `(fill_price, sl, tp, atr)` after the
  fill. If it now fails, immediately close the position and log a
  `POST_FILL_VALIDATION_FAIL`. Aggressive but matches the spec's
  rejection-never-modify rule.
- Accept the slippage as a known cost; track it in `expected_slippage_ms`
  and in the execution-quality map.

The spec doesn't address this directly. Worth raising explicitly in
Stage 2B.

---

## 14. What to hand to Ultraplan

If you re-engage Ultraplan for Stage 2B, give it:

1. **This document** as input.
2. **The current plan file** at
   `/home/skunkworks/.claude/plans/abstract-soaring-hedgehog.md`
   (Plan v2 with Stage 2A folded in).
3. **The updated spec** at
   `/home/skunkworks/Downloads/trading_system_claude_code (updated).txt`.
4. **A directive** specifying:
   - **Stage 2B priority order**: lookahead validator FIRST, then
     geometric map, then execution-quality map, then loss inversion +
     bidirectional analysis, then context layer, then fakeout-as-event,
     then NN 4-class retrain.
   - **The two-loop decision** (§5 above): which path owns live trades.
     This determines whether Stage 2B builds on the backend daemon (most
     spec-aligned) or also ports to the frontend.
   - **Stage 2A bug fixes** to fold in (§3.1, §3.2, §3.4, §3.5, §9).
   - **Tests are mandatory**: every new module needs a fixture and
     property test. The lookahead validator gets a deliberately-leaked
     fixture that must raise.
   - **The 5-mode parameter table needs validation**: a parameter sweep
     in Stage 2B's NN training pass on each style, with results.
   - **UI/UX guardrails**: same `#00ff00`/`#ff6600` palette,
     `text-[10px]` only, corner-bracket boxes, JetBrains Mono. No new
     fonts, no oversized text.

Strong recommendation: **Ultraplan plans, local executes**. Stage 1's
parallel-cloud execution produced a non-building commit (the
`getJobRecord` issue). Local execution caught it.

---

## Appendix A: file-by-file health snapshot

| File | LOC | Health | Notes |
|---|---|---|---|
| `python/cicada_nn/api.py` | ~2,100 | yellow | very long, many endpoints, side-effects on import |
| `python/cicada_nn/daemon_runtime.py` | 640 | green | clean separation, well-commented |
| `python/cicada_nn/execution_daemon.py` | 626 | green | good shape, per-mode rules wired in Stage 1 |
| `python/cicada_nn/mt5_client.py` | 290 (post-2A) | yellow | down from 523; `__getattr__` quirk needs caching |
| `python/cicada_nn/mt5_bridge.py` | 186 | green | clean |
| `python/cicada_nn/order_records.py` | 360 | green | append-only, good migration |
| `python/cicada_nn/trade_modes.py` | 320 | green | parity-checked, latency-aware |
| `python/cicada_nn/sl_tp_manager.py` | 165 | green | pure functions |
| `python/cicada_nn/latency_monitor.py` | 290 | yellow | side-effect start in api.py needs gating |
| `python/cicada_nn/latency_model.py` | 245 | green | percentile math is right; sensitivity numbers placeholder |
| `python/cicada_nn/shadow_training.py` | ~600 | green | well-designed promotion gate |
| `bridge/server.py` | 356 | green | matches spec endpoint shapes |
| `bridge/test_bridge_contract.py` | 210 | green | runs on Linux via stub MT5 |
| `src/app/store/TradingStore.tsx` | 3,935 | red | mega-store; refactor candidate |
| `src/app/core/botExecution.ts` | ~1,300 | yellow | live trade loop on FE — divergent from backend daemon |
| `src/app/components/BrokersManager.tsx` | ~600 | yellow | still has Deriv/Exness UI; bridge pill added |
| `src/app/components/ProcessMonitor.tsx` | ~500 | green | latency strip added cleanly |

---

## Appendix B: open questions for the operator

These are decisions that affect Stage 2B/3 architecture and don't have
spec answers. Worth resolving with the user before Ultraplan plans:

1. **Frontend trade loop fate** — keep, port, or delete? (§5)
2. **`/audit/models` and the WIP files** — commit or delete? (§9)
3. **Bridge `/account` endpoint** — should we add it, or is bridge
   supposed to be minimal? (§3.4)
4. **Demo mode policy** — does Stage 2B+ keep demo mode functional, or
   do we accept that the spec-compliant system needs MT5 reachable to
   meaningfully run? (§6)
5. **Geometric map rebuild trigger threshold** — what counts as a
   "volatility regime shift"? (§12)
6. **Post-fill re-validation** — strict (§13 option 1) or lenient
   (§13 option 2)?
