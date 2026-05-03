"""Stage 2A: orders-table migration to add the four latency columns.

Verifies:
  * Fresh DBs get the v2 schema with all 19 columns.
  * Pre-existing v1 DBs (without the latency columns) get them added on
    open without losing data.
  * ``append_order`` round-trips the latency fields.
  * Legacy rows read back with NULL latency fields.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from cicada_nn.order_records import OrderRecordStore, OrderStatus


_REQUIRED_LATENCY_COLS = (
    "execution_delta_ms",
    "latency_baseline_ms",
    "latency_anomaly",
    "expected_slippage_ms",
)


def _column_names(db: Path) -> set[str]:
    con = sqlite3.connect(str(db))
    try:
        cur = con.execute("PRAGMA table_info(orders)")
        return {row[1] for row in cur.fetchall()}
    finally:
        con.close()


def _seed_v1(db: Path) -> None:
    """Create a pre-Stage-2A DB exactly as Stage 1 wrote it (no latency cols)."""
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
                ts            REAL NOT NULL
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
                                status, reason, ticket, data_source, ts)
            VALUES ('bot-1', 'inst-x', 'EURUSD', 'scalping', 'LONG', 0.10,
                    1.20, 1.19, 1.22, 0.7,
                    'submitted', NULL, 1234, 'live', 1700000000.0);
            """
        )
        con.commit()
    finally:
        con.close()


# ── Fresh DB has v2 schema ───────────────────────────────────────────────


def test_fresh_db_has_latency_columns(tmp_path: Path):
    db = tmp_path / "orders.sqlite"
    OrderRecordStore(db).close()
    cols = _column_names(db)
    for c in _REQUIRED_LATENCY_COLS:
        assert c in cols, f"missing column: {c}"


# ── Migration adds columns to v1 DB ──────────────────────────────────────


def test_migration_adds_columns_to_v1_db(tmp_path: Path):
    db = tmp_path / "orders.sqlite"
    _seed_v1(db)
    cols_before = _column_names(db)
    for c in _REQUIRED_LATENCY_COLS:
        assert c not in cols_before
    # Open with the new code — should ALTER TABLE
    s = OrderRecordStore(db)
    s.close()
    cols_after = _column_names(db)
    for c in _REQUIRED_LATENCY_COLS:
        assert c in cols_after


def test_migration_preserves_legacy_rows(tmp_path: Path):
    db = tmp_path / "orders.sqlite"
    _seed_v1(db)
    s = OrderRecordStore(db)
    rows = s.list_orders()
    assert len(rows) == 1
    r = rows[0]
    assert r.bot_id == "bot-1"
    assert r.execution_delta_ms is None
    assert r.latency_baseline_ms is None
    assert r.latency_anomaly is None
    assert r.expected_slippage_ms is None
    s.close()


# ── append_order round-trips new fields ──────────────────────────────────


def test_append_with_latency_fields_roundtrips(tmp_path: Path):
    s = OrderRecordStore(tmp_path / "orders.sqlite")
    s.append_order(
        bot_id="bot-1",
        instrument_id="inst-x",
        instrument_symbol="EURUSD",
        style="scalping",
        side="LONG",
        size=0.10,
        entry_price=1.2,
        stop_loss=1.19,
        take_profit=1.22,
        confidence=0.7,
        status=OrderStatus.SUBMITTED,
        execution_delta_ms=42.5,
        latency_baseline_ms=20.0,
        latency_anomaly=False,
        expected_slippage_ms=1.5,
    )
    rows = s.list_orders()
    assert len(rows) == 1
    r = rows[0]
    assert r.execution_delta_ms == 42.5
    assert r.latency_baseline_ms == 20.0
    assert r.latency_anomaly is False
    assert r.expected_slippage_ms == 1.5


def test_append_with_anomaly_true_roundtrips(tmp_path: Path):
    s = OrderRecordStore(tmp_path / "orders.sqlite")
    s.append_order(
        bot_id="bot-1", instrument_id="x", instrument_symbol="X",
        style="swing", side="LONG", size=0.1, entry_price=1.0,
        stop_loss=0.99, take_profit=1.02, confidence=0.8,
        status=OrderStatus.SUBMITTED, latency_anomaly=True,
    )
    r = s.list_orders()[0]
    assert r.latency_anomaly is True


def test_append_without_latency_fields_writes_null(tmp_path: Path):
    s = OrderRecordStore(tmp_path / "orders.sqlite")
    s.append_order(
        bot_id="bot-1", instrument_id="x", instrument_symbol="X",
        style="day", side="SHORT", size=0.1, entry_price=1.0,
        stop_loss=1.01, take_profit=0.98, confidence=0.7,
        status=OrderStatus.INTENT,
    )
    r = s.list_orders()[0]
    assert r.execution_delta_ms is None
    assert r.latency_baseline_ms is None
    assert r.latency_anomaly is None
    assert r.expected_slippage_ms is None
