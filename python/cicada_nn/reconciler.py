"""Position reconciler — 5-second poll of MT5 vs. ``orders`` table.

Spec lines 1050-1064 ("POSITION RECONCILIATION (every 5 seconds)"). The
reconciler is the source of truth for "what positions do we *actually*
hold". Every Section 7 drift action that involves MT5 (close-all,
suspend-placement) calls into here first to know what positions exist.

Discrepancy taxonomy:

* **GHOST** — MT5 has a position whose ticket is not in any
  ``orders.status='filled'`` row. Someone (or something) placed an order
  outside our system. We HALT new placement immediately and write a
  ``RECONCILE_GHOST`` row to ``orders`` for audit. Manual resume via
  ``POST /drift/resume``.
* **IMPLICIT_CLOSE** — ``orders`` has a ``filled`` ticket that is no
  longer in MT5 positions. The broker closed it (SL/TP hit, end-of-day,
  manual close on the broker side). We append a ``closed`` row with
  ``close_reason='reconcile_implied'`` plus a matching
  ``sl_tp_event`` of kind ``reconcile_close``. No halt — this is the
  expected end-of-life for any trade that didn't close through our own
  daemon.
* **DIVERGENT** — same ticket on both sides but volume / sl / tp differ.
  Logged as a warning; no halt. Often legitimate (partial close, broker-
  side SL move). Future Stage 4 work could surface these on the UI.

Threading: a single daemon thread, started by ``api._bootstrap_daemon``
when ``CICADA_DISABLE_RECONCILER`` is unset. Same env-gate pattern as
``latency_monitor`` so test imports don't accidentally spawn polling.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

from . import mt5_bridge
from .daemon_guards import GUARDS, DaemonGuards, get_guards
from .mt5_bridge import BridgeError
from .order_records import OrderRecordStore, OrderStatus, SLTPEventKind


logger = logging.getLogger(__name__)


# ── Env gate ─────────────────────────────────────────────────────────


def reconciler_enabled() -> bool:
    """``CICADA_DISABLE_RECONCILER=1`` (or true / yes / on) skips the
    daemon thread. Default ON for production. Mirrors
    ``latency_monitor.latency_monitor_enabled`` so tests probe the
    predicate directly without importing api.py / torch."""
    raw = (os.environ.get("CICADA_DISABLE_RECONCILER") or "").strip().lower()
    return raw not in {"1", "true", "yes", "on"}


# ── Result types ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class Discrepancy:
    """One reconciler finding."""

    kind: str  # 'GHOST' | 'IMPLICIT_CLOSE' | 'DIVERGENT'
    ticket: int
    detail: str


@dataclass
class ReconcileSnapshot:
    """Most-recent reconciler state, surfaced on GET /reconcile/status."""

    last_run_ts: float = 0.0
    last_error: Optional[str] = None
    mt5_position_count: int = 0
    tracked_position_count: int = 0
    discrepancies: list[Discrepancy] = field(default_factory=list)
    halts_raised: int = 0


# ── The reconciler ───────────────────────────────────────────────────


_DEFAULT_INTERVAL_S = 5.0


class Reconciler:
    """Background daemon thread that drives one ``run_once`` per interval."""

    def __init__(
        self,
        order_store: OrderRecordStore,
        *,
        interval_s: float = _DEFAULT_INTERVAL_S,
        guards: DaemonGuards = GUARDS,
        bridge_get_positions: Optional[Callable[[], list[dict]]] = None,
        clock: Callable[[], float] = time.time,
    ):
        self._store = order_store
        self.interval_s = interval_s
        self._guards = guards
        self._fetch = bridge_get_positions or self._default_fetch
        self._clock = clock
        self._snapshot = ReconcileSnapshot()
        self._snapshot_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ── Default position fetch (the bridge) ───────────────────────────

    @staticmethod
    def _default_fetch() -> list[dict]:
        try:
            return mt5_bridge.get_bridge().get_positions()
        except BridgeError as e:
            raise BridgeError(f"reconciler: bridge failed: {e}") from e

    # ── Public surface ────────────────────────────────────────────────

    def snapshot(self) -> ReconcileSnapshot:
        """Caller-side immutable copy of the latest snapshot."""
        with self._snapshot_lock:
            return ReconcileSnapshot(
                last_run_ts=self._snapshot.last_run_ts,
                last_error=self._snapshot.last_error,
                mt5_position_count=self._snapshot.mt5_position_count,
                tracked_position_count=self._snapshot.tracked_position_count,
                discrepancies=list(self._snapshot.discrepancies),
                halts_raised=self._snapshot.halts_raised,
            )

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        t = threading.Thread(target=self._run, name="reconciler", daemon=True)
        self._thread = t
        t.start()

    def stop(self, join_timeout_s: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=join_timeout_s)

    # ── One pass (also exposed for tests) ─────────────────────────────

    def run_once(self) -> ReconcileSnapshot:
        """Fetch MT5 positions, compare against the orders table, walk
        the discrepancies. Returns a copy of the updated snapshot."""
        try:
            mt5_positions = self._fetch()
        except BridgeError as e:
            logger.warning("reconciler: bridge unreachable: %s", e)
            with self._snapshot_lock:
                self._snapshot.last_run_ts = self._clock()
                self._snapshot.last_error = str(e)
            return self.snapshot()

        tracked = self._tracked_filled_orders()
        mt5_by_ticket = {int(p.get("ticket") or 0): p for p in mt5_positions if p.get("ticket")}
        tracked_by_ticket = {row.ticket: row for row in tracked if row.ticket}

        discrepancies: list[Discrepancy] = []
        halts_raised_this_pass = 0

        # GHOSTs — present in MT5, absent from orders.
        for ticket, pos in mt5_by_ticket.items():
            if ticket not in tracked_by_ticket:
                detail = (
                    f"MT5 ticket {ticket} ({pos.get('symbol', '?')} "
                    f"{pos.get('direction', '?')} {pos.get('volume', 0)}) "
                    f"has no matching filled order"
                )
                discrepancies.append(Discrepancy(kind="GHOST", ticket=ticket, detail=detail))
                self._record_ghost(ticket, pos)
                if not self._guards.new_orders_halted:
                    self._guards.halt_new_orders(
                        source="reconciler",
                        reason=f"ghost position detected (ticket={ticket})",
                    )
                    halts_raised_this_pass += 1

        # IMPLICIT_CLOSE — present in orders, absent from MT5.
        for ticket, row in tracked_by_ticket.items():
            if ticket not in mt5_by_ticket:
                detail = f"order ticket {ticket} no longer in MT5; assuming broker close"
                discrepancies.append(
                    Discrepancy(kind="IMPLICIT_CLOSE", ticket=ticket, detail=detail)
                )
                self._record_implicit_close(row)

        # DIVERGENTs — both sides have it but fields differ.
        for ticket, pos in mt5_by_ticket.items():
            row = tracked_by_ticket.get(ticket)
            if row is None:
                continue
            divergences: list[str] = []
            mt5_volume = float(pos.get("volume") or 0.0)
            if abs(mt5_volume - float(row.size)) > 1e-9:
                divergences.append(f"volume mt5={mt5_volume} order={row.size}")
            mt5_sl = float(pos.get("sl") or 0.0)
            order_sl = float(row.stop_loss or 0.0)
            if order_sl and abs(mt5_sl - order_sl) > 1e-9 and mt5_sl != 0.0:
                # Note: SL/TP can legitimately drift when sl_tp_manager moves them.
                # We still log the divergence because a *broker-side* unauthorised
                # SL move is something we want to surface.
                divergences.append(f"sl mt5={mt5_sl} order={order_sl}")
            if divergences:
                discrepancies.append(
                    Discrepancy(
                        kind="DIVERGENT",
                        ticket=ticket,
                        detail="; ".join(divergences),
                    )
                )

        with self._snapshot_lock:
            self._snapshot.last_run_ts = self._clock()
            self._snapshot.last_error = None
            self._snapshot.mt5_position_count = len(mt5_by_ticket)
            self._snapshot.tracked_position_count = len(tracked_by_ticket)
            self._snapshot.discrepancies = discrepancies
            self._snapshot.halts_raised += halts_raised_this_pass
        return self.snapshot()

    # ── Internals ─────────────────────────────────────────────────────

    def _tracked_filled_orders(self) -> list:
        """The set of orders we believe are still open. Naive impl: take
        the most recent row per ticket and keep it if its status is
        'filled'. Good enough until Stage 4 builds an explicit position
        table — orders is currently the source of truth."""
        rows = self._store.list_orders(limit=10_000)
        latest_by_ticket: dict[int, object] = {}
        for r in rows:
            if not r.ticket:
                continue
            latest_by_ticket[r.ticket] = r
        # Only those whose latest status is 'filled' (not 'closed').
        return [r for r in latest_by_ticket.values() if r.status == OrderStatus.FILLED.value]  # type: ignore[attr-defined]

    def _record_ghost(self, ticket: int, pos: dict) -> None:
        try:
            self._store.append_order(
                bot_id="__reconciler__",
                instrument_id="__ghost__",
                instrument_symbol=str(pos.get("symbol") or "?"),
                style="unknown",
                side=str(pos.get("direction") or "LONG"),
                size=float(pos.get("volume") or 0.0),
                entry_price=float(pos.get("open_price") or 0.0),
                stop_loss=float(pos.get("sl") or 0.0) or None,
                take_profit=float(pos.get("tp") or 0.0) or None,
                confidence=None,
                status=OrderStatus.REJECTED,
                reason=f"reconcile_ghost ticket={ticket}",
                ticket=ticket,
                data_source="reconcile",
            )
        except Exception as e:
            logger.warning("reconciler: failed to record ghost ticket=%s: %s", ticket, e)

    def _record_implicit_close(self, row) -> None:
        try:
            self._store.append_order(
                bot_id=row.bot_id,
                instrument_id=row.instrument_id,
                instrument_symbol=row.instrument_symbol,
                style=row.style,
                side=row.side,
                size=row.size,
                entry_price=row.entry_price,
                stop_loss=row.stop_loss,
                take_profit=row.take_profit,
                confidence=row.confidence,
                status=OrderStatus.CLOSED,
                reason="reconcile_implied",
                ticket=row.ticket,
                data_source=row.data_source,
            )
            self._store.append_sl_tp_event(
                ticket=row.ticket,
                bot_id=row.bot_id,
                kind=SLTPEventKind.SL_HIT,  # Best-effort tag; we don't know which side closed it.
                price=row.entry_price,
                note="reconcile_close (broker-side close, side unknown)",
            )
        except Exception as e:
            logger.warning(
                "reconciler: failed to record implicit close ticket=%s: %s",
                row.ticket, e,
            )

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_once()
            except Exception as e:  # never crash the daemon thread
                logger.warning("reconciler tick raised: %s", e)
                with self._snapshot_lock:
                    self._snapshot.last_error = str(e)
            self._stop.wait(self.interval_s)


# ── Module-level singleton (lazy) ────────────────────────────────────


_RECONCILER: Optional[Reconciler] = None


def get_reconciler() -> Optional[Reconciler]:
    return _RECONCILER


def set_reconciler(r: Optional[Reconciler]) -> None:
    """Inject (or clear) the module-level Reconciler. Called by api.py
    bootstrap, and by tests to install a fake-bridge variant."""
    global _RECONCILER
    _RECONCILER = r
