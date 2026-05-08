"""Drift detection — Section 7 + spec lines 1066-1097 as callable rules.

The five drift triggers from the spec:

  TRIGGER                         THRESHOLD                          ACTION
  ───────────────────────────────────────────────────────────────────────────────
  Prediction confidence drop      < 0.55 for 20 consecutive trades   no_new_orders
  Rolling prediction error        > 2× baseline / 50-trade window    close_all + soft retrain
  Volatility regime shift         ATR > 2σ of training distribution  suspend_placement
                                                                     + rebuild maps + retrain
  Fakeout rate anomaly            > 3× historical baseline           soft_retrain
  Live drawdown breach            > 3× expected from backtest        emergency_stop_with_audit

Design:

* Each rule is a **pure function** of a :class:`DriftContext` snapshot.
  No I/O, no global state — easy to unit-test row-by-row against the spec
  table.
* :class:`DriftMonitor` is the orchestrator. It builds the context from
  the live state (orders table + recent trades + ATR), evaluates every
  rule in a deterministic order, and applies the most severe action via
  :class:`daemon_guards.DaemonGuards` and the bridge.
* Severity order (lowest → highest): ``NONE`` < ``HALT_NEW_ORDERS`` <
  ``SUSPEND_PLACEMENT`` < ``SOFT_RETRAIN`` < ``CLOSE_ALL`` <
  ``EMERGENCY_STOP``. The orchestrator picks the highest, applies it,
  and emits a single drift event.
"""

from __future__ import annotations

import logging
import math
import statistics
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional

from . import mt5_bridge
from .daemon_guards import GUARDS, DaemonGuards
from .mt5_bridge import BridgeError
from .order_records import OrderRecordStore, OrderStatus


logger = logging.getLogger(__name__)


# ── Action enum + severity ───────────────────────────────────────────


class DriftAction(str, Enum):
    NONE = "none"
    HALT_NEW_ORDERS = "halt_new_orders"
    SUSPEND_PLACEMENT = "suspend_placement"
    SOFT_RETRAIN = "soft_retrain"
    CLOSE_ALL = "close_all"
    EMERGENCY_STOP = "emergency_stop"


_SEVERITY: dict[DriftAction, int] = {
    DriftAction.NONE: 0,
    DriftAction.HALT_NEW_ORDERS: 1,
    DriftAction.SUSPEND_PLACEMENT: 2,
    DriftAction.SOFT_RETRAIN: 3,
    DriftAction.CLOSE_ALL: 4,
    DriftAction.EMERGENCY_STOP: 5,
}


# ── Inputs to the rules ──────────────────────────────────────────────


@dataclass
class DriftContext:
    """Snapshot of everything the rules need.

    Constructed fresh on every evaluation pass — never cached. Pure data;
    no methods, no I/O.
    """

    # Confidence drop rule.
    recent_confidences: list[float] = field(default_factory=list)
    # Rolling prediction error rule.
    recent_errors: list[float] = field(default_factory=list)
    error_baseline: Optional[float] = None
    # Volatility regime shift rule.
    current_atr: Optional[float] = None
    training_atr_mean: Optional[float] = None
    training_atr_stdev: Optional[float] = None
    # Fakeout rate anomaly rule.
    recent_fakeout_rate: Optional[float] = None
    historical_fakeout_rate: Optional[float] = None
    # Live drawdown breach rule.
    live_drawdown_pct: Optional[float] = None
    expected_drawdown_pct: Optional[float] = None


@dataclass(frozen=True)
class RuleResult:
    """One rule's evaluation. ``triggered`` False ⇒ ``action`` is ``NONE``."""

    rule_id: str
    triggered: bool
    action: DriftAction
    reason: str


# ── The five rules — pure functions ──────────────────────────────────


CONFIDENCE_DROP_THRESHOLD = 0.55
CONFIDENCE_DROP_LOOKBACK = 20

ERROR_RATE_LOOKBACK = 50
ERROR_RATE_MULTIPLIER = 2.0

VOLATILITY_REGIME_STDEV = 2.0

FAKEOUT_RATE_MULTIPLIER = 3.0

DRAWDOWN_BREACH_MULTIPLIER = 3.0


def confidence_drop_rule(ctx: DriftContext) -> RuleResult:
    """Section 7 row 1: confidence < 0.55 for 20+ consecutive trades."""
    rule_id = "confidence_drop"
    if len(ctx.recent_confidences) < CONFIDENCE_DROP_LOOKBACK:
        return RuleResult(rule_id, False, DriftAction.NONE, "insufficient samples")
    last_n = ctx.recent_confidences[-CONFIDENCE_DROP_LOOKBACK:]
    if all(c < CONFIDENCE_DROP_THRESHOLD for c in last_n):
        return RuleResult(
            rule_id,
            True,
            DriftAction.HALT_NEW_ORDERS,
            f"all of last {CONFIDENCE_DROP_LOOKBACK} confidences < {CONFIDENCE_DROP_THRESHOLD}",
        )
    return RuleResult(rule_id, False, DriftAction.NONE, "ok")


def prediction_error_rule(ctx: DriftContext) -> RuleResult:
    """Section 7 row 2: rolling error > 2× baseline over a 50-trade window."""
    rule_id = "prediction_error"
    if len(ctx.recent_errors) < ERROR_RATE_LOOKBACK:
        return RuleResult(rule_id, False, DriftAction.NONE, "insufficient samples")
    if ctx.error_baseline is None or ctx.error_baseline <= 0:
        return RuleResult(rule_id, False, DriftAction.NONE, "no baseline")
    window = ctx.recent_errors[-ERROR_RATE_LOOKBACK:]
    avg = statistics.fmean(window)
    if avg > ctx.error_baseline * ERROR_RATE_MULTIPLIER:
        return RuleResult(
            rule_id,
            True,
            DriftAction.CLOSE_ALL,
            f"rolling error {avg:.4f} > {ERROR_RATE_MULTIPLIER}× baseline {ctx.error_baseline:.4f}",
        )
    return RuleResult(rule_id, False, DriftAction.NONE, "ok")


def volatility_regime_rule(ctx: DriftContext) -> RuleResult:
    """Section 7 row 3: ATR > 2σ of training distribution."""
    rule_id = "volatility_regime"
    if (
        ctx.current_atr is None
        or ctx.training_atr_mean is None
        or ctx.training_atr_stdev is None
        or ctx.training_atr_stdev <= 0
    ):
        return RuleResult(rule_id, False, DriftAction.NONE, "missing inputs")
    z = (ctx.current_atr - ctx.training_atr_mean) / ctx.training_atr_stdev
    if z > VOLATILITY_REGIME_STDEV:
        return RuleResult(
            rule_id,
            True,
            DriftAction.SUSPEND_PLACEMENT,
            f"current ATR {ctx.current_atr:.6f} is {z:.2f}σ above training mean",
        )
    return RuleResult(rule_id, False, DriftAction.NONE, "ok")


def fakeout_rate_rule(ctx: DriftContext) -> RuleResult:
    """Section 7 row 4: live fakeout rate > 3× historical."""
    rule_id = "fakeout_rate"
    if ctx.recent_fakeout_rate is None or ctx.historical_fakeout_rate is None:
        return RuleResult(rule_id, False, DriftAction.NONE, "missing rates")
    if ctx.historical_fakeout_rate <= 0:
        return RuleResult(rule_id, False, DriftAction.NONE, "no historical baseline")
    if ctx.recent_fakeout_rate > ctx.historical_fakeout_rate * FAKEOUT_RATE_MULTIPLIER:
        return RuleResult(
            rule_id,
            True,
            DriftAction.SOFT_RETRAIN,
            f"recent fakeout rate {ctx.recent_fakeout_rate:.3f} > "
            f"{FAKEOUT_RATE_MULTIPLIER}× historical {ctx.historical_fakeout_rate:.3f}",
        )
    return RuleResult(rule_id, False, DriftAction.NONE, "ok")


def drawdown_breach_rule(ctx: DriftContext) -> RuleResult:
    """Section 7 row 5: live drawdown > 3× expected. The hardest stop."""
    rule_id = "drawdown_breach"
    if ctx.live_drawdown_pct is None or ctx.expected_drawdown_pct is None:
        return RuleResult(rule_id, False, DriftAction.NONE, "missing inputs")
    if ctx.expected_drawdown_pct <= 0:
        return RuleResult(rule_id, False, DriftAction.NONE, "no expected baseline")
    if ctx.live_drawdown_pct > ctx.expected_drawdown_pct * DRAWDOWN_BREACH_MULTIPLIER:
        return RuleResult(
            rule_id,
            True,
            DriftAction.EMERGENCY_STOP,
            f"live drawdown {ctx.live_drawdown_pct:.3%} > "
            f"{DRAWDOWN_BREACH_MULTIPLIER}× expected {ctx.expected_drawdown_pct:.3%}",
        )
    return RuleResult(rule_id, False, DriftAction.NONE, "ok")


ALL_RULES: tuple[Callable[[DriftContext], RuleResult], ...] = (
    confidence_drop_rule,
    prediction_error_rule,
    volatility_regime_rule,
    fakeout_rate_rule,
    drawdown_breach_rule,
)


# ── Orchestrator state ───────────────────────────────────────────────


@dataclass
class DriftSnapshot:
    """What ``GET /drift/status`` returns."""

    last_run_ts: float = 0.0
    rules: list[RuleResult] = field(default_factory=list)
    chosen_action: DriftAction = DriftAction.NONE
    chosen_reason: str = ""
    actions_applied: int = 0


# ── DriftMonitor ─────────────────────────────────────────────────────


_DEFAULT_INTERVAL_S = 30.0


def drift_monitor_enabled() -> bool:
    """``CICADA_DISABLE_DRIFT=1`` skips the daemon thread. Mirrors the
    reconciler / latency env-gate pattern so tests probe the predicate
    without importing api.py."""
    import os as _os
    raw = (_os.environ.get("CICADA_DISABLE_DRIFT") or "").strip().lower()
    return raw not in {"1", "true", "yes", "on"}


class DriftMonitor:
    """Builds the context, evaluates rules, applies the most severe action."""

    def __init__(
        self,
        order_store: OrderRecordStore,
        *,
        guards: DaemonGuards = GUARDS,
        bridge_get_positions: Optional[Callable[[], list[dict]]] = None,
        bridge_close_position: Optional[Callable[[int], None]] = None,
        soft_retrain_hook: Optional[Callable[[str], None]] = None,
        clock: Callable[[], float] = time.time,
        rules: tuple[Callable[[DriftContext], RuleResult], ...] = ALL_RULES,
        interval_s: float = _DEFAULT_INTERVAL_S,
    ):
        self._store = order_store
        self._guards = guards
        self._fetch_positions = bridge_get_positions or self._default_fetch_positions
        self._close_position = bridge_close_position or self._default_close_position
        self._soft_retrain_hook = soft_retrain_hook
        self._clock = clock
        self._rules = rules
        self._snapshot = DriftSnapshot()
        self._snapshot_lock = threading.Lock()
        self.interval_s = interval_s
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ── Public surface ────────────────────────────────────────────────

    def snapshot(self) -> DriftSnapshot:
        with self._snapshot_lock:
            return DriftSnapshot(
                last_run_ts=self._snapshot.last_run_ts,
                rules=list(self._snapshot.rules),
                chosen_action=self._snapshot.chosen_action,
                chosen_reason=self._snapshot.chosen_reason,
                actions_applied=self._snapshot.actions_applied,
            )

    def evaluate(self, ctx: DriftContext) -> DriftSnapshot:
        """Run every rule against ``ctx``, apply the most severe action,
        update the snapshot, return a copy. Rules are pure; only this
        orchestrator touches guards / bridge / hooks."""
        results = [rule(ctx) for rule in self._rules]
        triggered = [r for r in results if r.triggered]
        if triggered:
            triggered.sort(key=lambda r: _SEVERITY[r.action], reverse=True)
            top = triggered[0]
            self._apply(top)
        else:
            top = RuleResult("none", False, DriftAction.NONE, "no rule triggered")

        with self._snapshot_lock:
            self._snapshot.last_run_ts = self._clock()
            self._snapshot.rules = results
            self._snapshot.chosen_action = top.action
            self._snapshot.chosen_reason = top.reason
            if top.triggered:
                self._snapshot.actions_applied += 1
        return self.snapshot()

    # ── Action dispatch ───────────────────────────────────────────────

    def _apply(self, result: RuleResult) -> None:
        action = result.action
        reason = f"[{result.rule_id}] {result.reason}"
        if action == DriftAction.HALT_NEW_ORDERS:
            self._guards.halt_new_orders(source="drift", reason=reason)
        elif action == DriftAction.SUSPEND_PLACEMENT:
            self._guards.halt_new_orders(source="drift", reason=reason)
        elif action == DriftAction.SOFT_RETRAIN:
            if self._soft_retrain_hook is not None:
                try:
                    self._soft_retrain_hook(reason)
                except Exception as e:
                    logger.warning("soft_retrain_hook failed: %s", e)
        elif action == DriftAction.CLOSE_ALL:
            self._guards.halt_new_orders(source="drift", reason=reason)
            self._close_all_positions(reason)
        elif action == DriftAction.EMERGENCY_STOP:
            self._guards.emergency_stop(source="drift", reason=reason)
            self._close_all_positions(reason)

    def _close_all_positions(self, reason: str) -> None:
        try:
            positions = self._fetch_positions()
        except BridgeError as e:
            logger.error("drift close-all: bridge fetch failed: %s — positions remain open", e)
            return
        for p in positions:
            ticket = int(p.get("ticket") or 0)
            if not ticket:
                continue
            try:
                self._close_position(ticket)
            except Exception as e:
                logger.warning("drift close-all: close ticket=%s failed: %s", ticket, e)

    # ── Context builder + tick loop ───────────────────────────────────

    def build_context(self) -> DriftContext:
        """Pull the latest drift inputs from the order store.

        Many fields (volatility, drawdown, error baseline) are not yet
        plumbed through to a queryable surface — for those we leave the
        context field ``None`` and the rule degrades gracefully to
        ``missing inputs``. Stage 5 will populate them as the equity
        history + bar-stats pipeline matures.

        Stage 4 wires ``historical_fakeout_rate`` from the same store:
        we slice the order history into a "recent" window (last 200) and
        a "historical" window (rows 200-2000) and compute the fakeout
        rate over each. The rule fires when recent > 3 × historical."""
        # Pull a 2,000-row deep window to slice into recent + historical.
        rows = self._store.list_orders(limit=2_000)
        # Confidence drop rule: pull recent confidences from filled rows.
        confidences = [
            float(r.confidence) for r in rows
            if r.confidence is not None and r.status == OrderStatus.FILLED.value
        ]

        def _fakeout_rate(window: list) -> float | None:
            if not window:
                return None
            n = sum(
                1 for r in window
                if (r.reason or "").startswith("fakeout") or "FAKEOUT" in (r.reason or "")
            )
            return n / len(window)

        recent_window = rows[-200:]
        historical_window = rows[-2_000:-200] if len(rows) > 200 else []
        recent_fakeout_rate = _fakeout_rate(recent_window)
        # Need at least 200 rows in the historical window for the baseline
        # to be meaningful. Below that the rule should stay silent.
        historical_fakeout_rate = _fakeout_rate(historical_window) if len(historical_window) >= 200 else None

        return DriftContext(
            recent_confidences=confidences[-CONFIDENCE_DROP_LOOKBACK * 2 :],
            recent_errors=[],            # TODO Stage 5: backtest-vs-live error tracking
            error_baseline=None,         # TODO Stage 5
            current_atr=None,            # TODO Stage 5: read from execution_quality_map
            training_atr_mean=None,      # TODO Stage 5
            training_atr_stdev=None,     # TODO Stage 5
            recent_fakeout_rate=recent_fakeout_rate,
            historical_fakeout_rate=historical_fakeout_rate,
            live_drawdown_pct=None,      # TODO Stage 5: from equity-history slice
            expected_drawdown_pct=None,  # TODO Stage 5: from backtest stats
        )

    def tick(self) -> DriftSnapshot:
        ctx = self.build_context()
        return self.evaluate(ctx)

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        t = threading.Thread(target=self._run, name="drift-monitor", daemon=True)
        self._thread = t
        t.start()

    def stop(self, join_timeout_s: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=join_timeout_s)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as e:  # never crash the daemon thread
                logger.warning("drift_monitor tick raised: %s", e)
            self._stop.wait(self.interval_s)

    # ── Default bridge wiring (overridable in tests) ──────────────────

    @staticmethod
    def _default_fetch_positions() -> list[dict]:
        return mt5_bridge.get_bridge().get_positions()

    @staticmethod
    def _default_close_position(ticket: int) -> None:
        mt5_bridge.get_bridge().close_position(ticket=ticket)


# ── Module-level singleton ───────────────────────────────────────────


_DRIFT_MONITOR: Optional[DriftMonitor] = None


def get_drift_monitor() -> Optional[DriftMonitor]:
    return _DRIFT_MONITOR


def set_drift_monitor(m: Optional[DriftMonitor]) -> None:
    global _DRIFT_MONITOR
    _DRIFT_MONITOR = m
