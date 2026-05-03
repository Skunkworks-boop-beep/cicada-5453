"""
Append-only order + SL/TP-event store for CICADA-5453.

Spec §6: every order status transition is a NEW row; every SL/TP modification
is a NEW row in ``sl_tp_events``. Nothing is ever updated in place — that was
the source of the "incomplete order records" bug where a modified SL silently
overwrote the original and the audit trail vanished.

Backed by SQLite in WAL mode for crash safety. Tests in
``python/tests/test_order_records.py`` enforce the append-only invariant on a
real file (no in-memory mocks).
"""

from __future__ import annotations

import sqlite3
import threading
import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Iterable, Optional


class OrderStatus(str, Enum):
    INTENT = "intent"           # signal generated, not yet validated
    REJECTED = "rejected"       # validate_order returned reject
    SUBMITTED = "submitted"     # passed to broker
    FILLED = "filled"
    CLOSED = "closed"
    BROKER_ERROR = "broker_error"


class SLTPEventKind(str, Enum):
    INITIAL = "initial"          # SL/TP set on entry
    MOVE_BE = "move_be"          # moved to breakeven
    TRAIL = "trail"              # trail step
    PARTIAL_TP = "partial_tp"    # partial TP filled
    SL_HIT = "sl_hit"
    TP_HIT = "tp_hit"


@dataclass(frozen=True)
class OrderRow:
    id: int
    bot_id: str
    instrument_id: str
    instrument_symbol: str
    style: str
    side: str
    size: float
    entry_price: float
    stop_loss: float | None
    take_profit: float | None
    confidence: float | None
    status: str
    reason: str | None
    ticket: int | None
    data_source: str
    ts: float
    # ── Stage 2A: per-order latency capture (spec lines 1284-1289). NULL for
    # rows written before the migration; readers must handle None.
    execution_delta_ms: float | None = None
    latency_baseline_ms: float | None = None
    latency_anomaly: bool | None = None
    expected_slippage_ms: float | None = None


@dataclass(frozen=True)
class SLTPEventRow:
    id: int
    ticket: int
    bot_id: str
    kind: str
    sl: float | None
    tp: float | None
    price: float | None
    note: str | None
    ts: float


_ORDERS_DDL = """
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
    -- Stage 2A: per-order latency capture (spec lines 1284-1289).
    execution_delta_ms    REAL,
    latency_baseline_ms   REAL,
    latency_anomaly       INTEGER,
    expected_slippage_ms  REAL
)
"""

# Stage 2A migration: rows written before the new columns existed need the
# columns added. SQLite has no `ADD COLUMN IF NOT EXISTS` so we introspect.
_LATENCY_COLUMNS = (
    ("execution_delta_ms", "REAL"),
    ("latency_baseline_ms", "REAL"),
    ("latency_anomaly", "INTEGER"),
    ("expected_slippage_ms", "REAL"),
)

_SL_TP_DDL = """
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
)
"""

_INDEXES = (
    "CREATE INDEX IF NOT EXISTS idx_orders_bot_ts ON orders(bot_id, ts)",
    "CREATE INDEX IF NOT EXISTS idx_orders_ticket ON orders(ticket)",
    "CREATE INDEX IF NOT EXISTS idx_sltp_ticket_ts ON sl_tp_events(ticket, ts)",
)


class OrderRecordStore:
    """Append-only SQLite store. Thread-safe via a single connection guarded
    by an internal lock; SQLite's own WAL handles cross-process concurrency."""

    def __init__(self, path: Path):
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(
            str(self._path),
            check_same_thread=False,
            isolation_level=None,  # autocommit; explicit BEGIN where needed
        )
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    # ── Schema ──────────────────────────────────────────────────────────────

    def _init_schema(self) -> None:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute(_ORDERS_DDL)
            cur.execute(_SL_TP_DDL)
            for ddl in _INDEXES:
                cur.execute(ddl)
            # Stage 2A migration: add the latency columns to pre-existing
            # tables. ``ALTER TABLE`` is the only way to add columns and
            # SQLite has no IF NOT EXISTS guard, so we check first.
            cur.execute("PRAGMA table_info(orders)")
            existing = {row[1] for row in cur.fetchall()}
            for col_name, col_type in _LATENCY_COLUMNS:
                if col_name not in existing:
                    cur.execute(f"ALTER TABLE orders ADD COLUMN {col_name} {col_type}")

    # ── Append API ──────────────────────────────────────────────────────────

    def append_order(
        self,
        *,
        bot_id: str,
        instrument_id: str,
        instrument_symbol: str,
        style: str,
        side: str,
        size: float,
        entry_price: float,
        stop_loss: Optional[float],
        take_profit: Optional[float],
        confidence: Optional[float],
        status: OrderStatus | str,
        reason: Optional[str] = None,
        ticket: Optional[int] = None,
        data_source: str = "live",
        ts: Optional[float] = None,
        execution_delta_ms: Optional[float] = None,
        latency_baseline_ms: Optional[float] = None,
        latency_anomaly: Optional[bool] = None,
        expected_slippage_ms: Optional[float] = None,
    ) -> int:
        """Append an order row. Returns the new row id.

        NOTE: NEVER use UPDATE on this table. Status transitions are new rows.

        Stage 2A: ``execution_delta_ms`` / ``latency_baseline_ms`` /
        ``latency_anomaly`` / ``expected_slippage_ms`` are optional latency
        capture fields written by the order pipeline at fill-time per spec
        lines 1438-1454.
        """
        ts_val = float(ts if ts is not None else time.time())
        status_val = status.value if isinstance(status, OrderStatus) else str(status)
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                "INSERT INTO orders (bot_id, instrument_id, instrument_symbol, style, "
                "side, size, entry_price, stop_loss, take_profit, confidence, "
                "status, reason, ticket, data_source, ts, "
                "execution_delta_ms, latency_baseline_ms, latency_anomaly, expected_slippage_ms) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    bot_id,
                    instrument_id,
                    instrument_symbol,
                    style,
                    side,
                    float(size),
                    float(entry_price),
                    float(stop_loss) if stop_loss is not None else None,
                    float(take_profit) if take_profit is not None else None,
                    float(confidence) if confidence is not None else None,
                    status_val,
                    reason,
                    int(ticket) if ticket is not None else None,
                    data_source,
                    ts_val,
                    float(execution_delta_ms) if execution_delta_ms is not None else None,
                    float(latency_baseline_ms) if latency_baseline_ms is not None else None,
                    (int(bool(latency_anomaly)) if latency_anomaly is not None else None),
                    float(expected_slippage_ms) if expected_slippage_ms is not None else None,
                ),
            )
            return int(cur.lastrowid or 0)

    def append_sl_tp_event(
        self,
        *,
        ticket: int,
        bot_id: str,
        kind: SLTPEventKind | str,
        sl: Optional[float] = None,
        tp: Optional[float] = None,
        price: Optional[float] = None,
        note: Optional[str] = None,
        ts: Optional[float] = None,
    ) -> int:
        ts_val = float(ts if ts is not None else time.time())
        kind_val = kind.value if isinstance(kind, SLTPEventKind) else str(kind)
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                "INSERT INTO sl_tp_events (ticket, bot_id, kind, sl, tp, price, note, ts) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    int(ticket),
                    bot_id,
                    kind_val,
                    float(sl) if sl is not None else None,
                    float(tp) if tp is not None else None,
                    float(price) if price is not None else None,
                    note,
                    ts_val,
                ),
            )
            return int(cur.lastrowid or 0)

    # ── Read API ────────────────────────────────────────────────────────────

    def list_orders(
        self,
        *,
        bot_id: str | None = None,
        ticket: int | None = None,
        since: float | None = None,
        limit: int = 1000,
    ) -> list[OrderRow]:
        sql = "SELECT * FROM orders WHERE 1=1"
        args: list[Any] = []
        if bot_id is not None:
            sql += " AND bot_id = ?"
            args.append(bot_id)
        if ticket is not None:
            sql += " AND ticket = ?"
            args.append(int(ticket))
        if since is not None:
            sql += " AND ts >= ?"
            args.append(float(since))
        sql += " ORDER BY id ASC LIMIT ?"
        args.append(int(limit))
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(sql, args)
            return [_row_to_order(r) for r in cur.fetchall()]

    def list_sl_tp_events(
        self,
        *,
        ticket: int | None = None,
        bot_id: str | None = None,
        since: float | None = None,
        limit: int = 1000,
    ) -> list[SLTPEventRow]:
        sql = "SELECT * FROM sl_tp_events WHERE 1=1"
        args: list[Any] = []
        if ticket is not None:
            sql += " AND ticket = ?"
            args.append(int(ticket))
        if bot_id is not None:
            sql += " AND bot_id = ?"
            args.append(bot_id)
        if since is not None:
            sql += " AND ts >= ?"
            args.append(float(since))
        sql += " ORDER BY id ASC LIMIT ?"
        args.append(int(limit))
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(sql, args)
            return [_row_to_sl_tp(r) for r in cur.fetchall()]

    def order_count(self) -> int:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("SELECT COUNT(*) FROM orders")
            row = cur.fetchone()
            return int(row[0] if row else 0)

    def sl_tp_event_count(self) -> int:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("SELECT COUNT(*) FROM sl_tp_events")
            row = cur.fetchone()
            return int(row[0] if row else 0)

    # ── Lifecycle ───────────────────────────────────────────────────────────

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except sqlite3.Error:
                pass


def _row_to_order(r: sqlite3.Row) -> OrderRow:
    # PRAGMA table_info-based migration leaves new columns NULL on legacy
    # rows; the dataclass defaults to None for those.
    keys = r.keys()

    def _get(name: str) -> Any:
        return r[name] if name in keys else None

    return OrderRow(
        id=int(r["id"]),
        bot_id=str(r["bot_id"]),
        instrument_id=str(r["instrument_id"]),
        instrument_symbol=str(r["instrument_symbol"]),
        style=str(r["style"]),
        side=str(r["side"]),
        size=float(r["size"]),
        entry_price=float(r["entry_price"]),
        stop_loss=(float(r["stop_loss"]) if r["stop_loss"] is not None else None),
        take_profit=(float(r["take_profit"]) if r["take_profit"] is not None else None),
        confidence=(float(r["confidence"]) if r["confidence"] is not None else None),
        status=str(r["status"]),
        reason=(str(r["reason"]) if r["reason"] is not None else None),
        ticket=(int(r["ticket"]) if r["ticket"] is not None else None),
        data_source=str(r["data_source"]),
        ts=float(r["ts"]),
        execution_delta_ms=(
            float(_get("execution_delta_ms")) if _get("execution_delta_ms") is not None else None
        ),
        latency_baseline_ms=(
            float(_get("latency_baseline_ms")) if _get("latency_baseline_ms") is not None else None
        ),
        latency_anomaly=(
            bool(_get("latency_anomaly")) if _get("latency_anomaly") is not None else None
        ),
        expected_slippage_ms=(
            float(_get("expected_slippage_ms")) if _get("expected_slippage_ms") is not None else None
        ),
    )


def _row_to_sl_tp(r: sqlite3.Row) -> SLTPEventRow:
    return SLTPEventRow(
        id=int(r["id"]),
        ticket=int(r["ticket"]),
        bot_id=str(r["bot_id"]),
        kind=str(r["kind"]),
        sl=(float(r["sl"]) if r["sl"] is not None else None),
        tp=(float(r["tp"]) if r["tp"] is not None else None),
        price=(float(r["price"]) if r["price"] is not None else None),
        note=(str(r["note"]) if r["note"] is not None else None),
        ts=float(r["ts"]),
    )
