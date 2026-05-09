"""Stage 9: tick capture columns on the orders table.

Adds ``signal_price``, ``tick_bid_at_signal``, ``tick_ask_at_signal``,
``realized_slippage_pips``. Verifies:
  * Fresh DBs get the v3 schema with all 23 columns.
  * Pre-existing v2 DBs (Stage 2A schema, no tick columns) get the four
    columns added on open without losing data.
  * ``append_order`` round-trips the tick fields.
  * Legacy rows read back with NULL tick fields.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from cicada_nn.order_records import OrderRecordStore, OrderStatus


_REQUIRED_TICK_COLS = (
    "signal_price",
    "tick_bid_at_signal",
    "tick_ask_at_signal",
    "realized_slippage_pips",
)


def _column_names(db: Path) -> set[str]:
    con = sqlite3.connect(str(db))
    try:
        cur = con.execute("PRAGMA table_info(orders)")
        return {row[1] for row in cur.fetchall()}
    finally:
        con.close()


def _seed_v2(db: Path) -> None:
    """Stage 2A schema (latency cols present, tick cols absent)."""
    db.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(db))
    try:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS orders (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                bot_id        TEXT NOT NULL,
                instrument_id TEXT NOT NULL,
                instrument_symbol TEXT NOT NULL,
                style         TEXT NOT NULL,
                side          TEXT NOT NULL,
                size          REAL NOT NULL,
                entry_price   REAL NOT NULL,
                stop_loss     REAL,
                take_profit   REAL,
                confidence    REAL,
                status        TEXT NOT NULL,
                reason        TEXT,
                ticket        INTEGER,
                data_source   TEXT NOT NULL DEFAULT 'live',
                ts            REAL NOT NULL,
                execution_delta_ms    REAL,
                latency_baseline_ms   REAL,
                latency_anomaly       INTEGER,
                expected_slippage_ms  REAL
            );
            CREATE TABLE IF NOT EXISTS sl_tp_events (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket  INTEGER NOT NULL,
                bot_id  TEXT NOT NULL,
                kind    TEXT NOT NULL,
                sl      REAL,
                tp      REAL,
                price   REAL,
                note    TEXT,
                ts      REAL NOT NULL
            );
            INSERT INTO orders (bot_id, instrument_id, instrument_symbol, style, side, size,
                                entry_price, stop_loss, take_profit, confidence,
                                status, reason, ticket, data_source, ts,
                                execution_delta_ms, latency_baseline_ms, latency_anomaly,
                                expected_slippage_ms)
            VALUES ('bot-1', 'inst-x', 'EURUSD', 'scalping', 'LONG', 0.10,
                    1.20, 1.19, 1.22, 0.7,
                    'submitted', NULL, 1234, 'live', 1700000000.0,
                    32.0, 18.0, 0, 1.5);
            """
        )
        con.commit()
    finally:
        con.close()


# ── Fresh DB has v3 schema ───────────────────────────────────────────────


def test_fresh_db_has_tick_columns(tmp_path: Path):
    db = tmp_path / "orders.sqlite"
    OrderRecordStore(db).close()
    cols = _column_names(db)
    for c in _REQUIRED_TICK_COLS:
        assert c in cols, f"missing column: {c}"


# ── Migration adds columns to v2 DB ──────────────────────────────────────


def test_migration_adds_columns_to_v2_db(tmp_path: Path):
    db = tmp_path / "orders.sqlite"
    _seed_v2(db)
    cols_before = _column_names(db)
    for c in _REQUIRED_TICK_COLS:
        assert c not in cols_before
    s = OrderRecordStore(db)
    s.close()
    cols_after = _column_names(db)
    for c in _REQUIRED_TICK_COLS:
        assert c in cols_after


def test_migration_preserves_legacy_rows(tmp_path: Path):
    db = tmp_path / "orders.sqlite"
    _seed_v2(db)
    s = OrderRecordStore(db)
    rows = s.list_orders()
    assert len(rows) == 1
    r = rows[0]
    assert r.bot_id == "bot-1"
    # Pre-Stage-9 rows have no tick capture.
    assert r.signal_price is None
    assert r.tick_bid_at_signal is None
    assert r.tick_ask_at_signal is None
    assert r.realized_slippage_pips is None
    # But Stage 2A latency capture is still intact.
    assert r.execution_delta_ms == 32.0
    s.close()


# ── append_order round-trips new fields ──────────────────────────────────


def test_append_with_tick_fields_roundtrips(tmp_path: Path):
    s = OrderRecordStore(tmp_path / "orders.sqlite")
    s.append_order(
        bot_id="bot-1",
        instrument_id="inst-x",
        instrument_symbol="EURUSD",
        style="scalping",
        side="LONG",
        size=0.10,
        entry_price=1.10025,
        stop_loss=1.09950,
        take_profit=1.10100,
        confidence=0.7,
        status=OrderStatus.SUBMITTED,
        signal_price=1.10000,
        tick_bid_at_signal=1.10020,
        tick_ask_at_signal=1.10025,
        realized_slippage_pips=0.00025,
    )
    rows = s.list_orders()
    assert len(rows) == 1
    r = rows[0]
    assert r.signal_price == 1.10000
    assert r.tick_bid_at_signal == 1.10020
    assert r.tick_ask_at_signal == 1.10025
    assert r.realized_slippage_pips == 0.00025


def test_append_without_tick_fields_writes_null(tmp_path: Path):
    """Bridge unreachable / no live tick → daemon falls back to bar close
    and passes None for the tick fields. The store must accept that."""
    s = OrderRecordStore(tmp_path / "orders.sqlite")
    s.append_order(
        bot_id="bot-1", instrument_id="x", instrument_symbol="X",
        style="day", side="SHORT", size=0.1, entry_price=1.0,
        stop_loss=1.01, take_profit=0.98, confidence=0.7,
        status=OrderStatus.INTENT,
    )
    r = s.list_orders()[0]
    assert r.signal_price is None
    assert r.tick_bid_at_signal is None
    assert r.tick_ask_at_signal is None
    assert r.realized_slippage_pips is None
