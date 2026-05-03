"""Append-only invariant + crash-restart tests for OrderRecordStore."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.order_records import (
    OrderRecordStore,
    OrderStatus,
    SLTPEventKind,
)


def _build_store(tmp_path: Path) -> OrderRecordStore:
    return OrderRecordStore(tmp_path / "orders.sqlite")


def _add_intent(store: OrderRecordStore, **overrides) -> int:
    payload = dict(
        bot_id="bot-1",
        instrument_id="inst-eur",
        instrument_symbol="EURUSD",
        style="day",
        side="LONG",
        size=0.1,
        entry_price=1.10,
        stop_loss=1.099,
        take_profit=1.102,
        confidence=0.7,
        status=OrderStatus.INTENT,
    )
    payload.update(overrides)
    return store.append_order(**payload)


def test_status_transitions_are_new_rows(tmp_path):
    store = _build_store(tmp_path)
    intent_id = _add_intent(store)
    submitted_id = _add_intent(store, status=OrderStatus.SUBMITTED, ticket=1234)
    filled_id = _add_intent(store, status=OrderStatus.FILLED, ticket=1234)
    closed_id = _add_intent(store, status=OrderStatus.CLOSED, ticket=1234)

    rows = store.list_orders(bot_id="bot-1")
    statuses = [r.status for r in rows]
    assert statuses == [OrderStatus.INTENT.value, OrderStatus.SUBMITTED.value,
                        OrderStatus.FILLED.value, OrderStatus.CLOSED.value]
    assert {intent_id, submitted_id, filled_id, closed_id} == {r.id for r in rows}
    # Each insert produces a new id.
    assert len({r.id for r in rows}) == 4


def test_append_only_count_is_monotonic(tmp_path):
    store = _build_store(tmp_path)
    last = 0
    for i in range(50):
        _add_intent(store, side="LONG" if i % 2 else "SHORT")
        n = store.order_count()
        assert n > last
        last = n
    assert last == 50


def test_no_update_or_delete_paths_exist(tmp_path):
    """The store has no UPDATE or DELETE methods. Sanity-check the invariant."""
    store = _build_store(tmp_path)
    methods = {name for name in dir(store) if not name.startswith("_")}
    forbidden = {"update_order", "delete_order", "update_sl_tp_event", "delete_sl_tp_event"}
    assert methods.isdisjoint(forbidden)


def test_crash_restart_keeps_rows(tmp_path):
    """Writes survive a process-level close+reopen — i.e. the WAL flushes."""
    db = tmp_path / "orders.sqlite"
    s1 = OrderRecordStore(db)
    _add_intent(s1)
    _add_intent(s1, status=OrderStatus.SUBMITTED)
    s1.close()

    s2 = OrderRecordStore(db)
    rows = s2.list_orders(bot_id="bot-1")
    assert len(rows) == 2


def test_sl_tp_events_append_only(tmp_path):
    store = _build_store(tmp_path)
    store.append_sl_tp_event(ticket=1, bot_id="bot-1", kind=SLTPEventKind.INITIAL, sl=1.0, tp=2.0)
    store.append_sl_tp_event(ticket=1, bot_id="bot-1", kind=SLTPEventKind.MOVE_BE, sl=1.05)
    store.append_sl_tp_event(ticket=1, bot_id="bot-1", kind=SLTPEventKind.TRAIL, sl=1.06)
    rows = store.list_sl_tp_events(ticket=1)
    kinds = [r.kind for r in rows]
    assert kinds == [SLTPEventKind.INITIAL.value, SLTPEventKind.MOVE_BE.value, SLTPEventKind.TRAIL.value]
    assert store.sl_tp_event_count() == 3


def test_filters_by_bot_and_ticket(tmp_path):
    store = _build_store(tmp_path)
    _add_intent(store, bot_id="bot-A", ticket=10)
    _add_intent(store, bot_id="bot-B", ticket=20)
    _add_intent(store, bot_id="bot-A", ticket=10)

    rows_a = store.list_orders(bot_id="bot-A")
    rows_b = store.list_orders(bot_id="bot-B")
    rows_t = store.list_orders(ticket=10)
    assert len(rows_a) == 2
    assert len(rows_b) == 1
    assert len(rows_t) == 2


def test_no_in_place_update_via_raw_sqlite(tmp_path):
    """If a future patch tries to UPDATE this table, the test catches it.

    We assert at the SQL level that all rows ever written are still present
    after a sequence of status transitions.
    """
    db = tmp_path / "orders.sqlite"
    store = OrderRecordStore(db)
    ids = [_add_intent(store, status=OrderStatus.INTENT) for _ in range(3)]
    for tid in ids:
        store.append_order(
            bot_id="bot-1",
            instrument_id="inst-eur",
            instrument_symbol="EURUSD",
            style="day",
            side="LONG",
            size=0.1,
            entry_price=1.10,
            stop_loss=1.099,
            take_profit=1.102,
            confidence=0.7,
            status=OrderStatus.SUBMITTED,
            ticket=tid,
        )
    store.close()

    conn = sqlite3.connect(str(db))
    try:
        cur = conn.execute("SELECT COUNT(*) FROM orders")
        assert cur.fetchone()[0] == 6  # 3 intent + 3 submitted, no overwrites
    finally:
        conn.close()
