"""Continuous RTT logger to the MT5 bridge.

Spec lines 1227-1346. Every 30s the monitor records round-trip time of a
``GET /health`` call to the bridge — the closest non-trading proxy to real
order-execution latency. Each row is an append-only entry in the
``latency_log`` SQLite table tagged with market session, day-of-week,
hour-UTC, host CPU%, RAM%, and an anomaly flag (RTT > p95 × 1.5 for the
current session).

The trading engine reads from the matching ``LatencyModel`` (in
``latency_model.py``) before every live order; that's where the per-mode
gates live. This file is just the writer + the schema.

Threading: ``start()`` spawns a daemon thread that dies with the process.
``stop()`` flips a flag and joins. The monitor never touches any lock held
by the trading engine, so a stuck monitor cannot stall trades.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Optional

from . import mt5_bridge
from .mt5_bridge import BridgeError


logger = logging.getLogger(__name__)


# ── Market sessions (UTC hour windows) ───────────────────────────────────


class MarketSession(str, Enum):
    SYDNEY = "SYDNEY"
    TOKYO = "TOKYO"
    LONDON = "LONDON"
    NEW_YORK = "NEW_YORK"
    LONDON_NY_OVERLAP = "LONDON_NY_OVERLAP"
    OFF_HOURS = "OFF_HOURS"


def current_market_session(now_utc_hour: int) -> MarketSession:
    """Map UTC hour to session. ``LONDON_NY_OVERLAP`` is its own bucket per
    spec lines 1313-1323 — separate latency profile due to volume."""
    h = int(now_utc_hour) % 24
    if 12 <= h < 16:
        return MarketSession.LONDON_NY_OVERLAP
    if 7 <= h < 12 or 16 <= h < 17:
        return MarketSession.LONDON
    if h >= 17 and h < 21:
        return MarketSession.NEW_YORK
    if 0 <= h < 7:
        # 00-07 overlaps Tokyo (00-09); pick TOKYO as primary by volume.
        return MarketSession.TOKYO
    if 21 <= h < 24:
        return MarketSession.SYDNEY
    return MarketSession.OFF_HOURS


# ── psutil is optional (requirements list keeps deps minimal) ─────────────


def _read_resource_usage() -> tuple[float, float]:
    """Return (cpu_pct, mem_pct) using psutil when available; (0.0, 0.0) else."""
    try:
        import psutil  # type: ignore
    except ImportError:
        return 0.0, 0.0
    try:
        return float(psutil.cpu_percent(interval=None)), float(psutil.virtual_memory().percent)
    except Exception as e:  # psutil rarely throws but we never want to crash the thread
        logger.debug("psutil read failed: %s", e)
        return 0.0, 0.0


# ── Schema ────────────────────────────────────────────────────────────────


_LATENCY_DDL = """
CREATE TABLE IF NOT EXISTS latency_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              REAL NOT NULL,
    rtt_ms          REAL,
    market_session  TEXT NOT NULL,
    day_of_week     INTEGER NOT NULL,
    hour_utc        INTEGER NOT NULL,
    local_cpu_pct   REAL,
    local_mem_pct   REAL,
    anomaly         INTEGER NOT NULL DEFAULT 0,
    notes           TEXT
)
"""

_LATENCY_INDEXES = (
    "CREATE INDEX IF NOT EXISTS idx_latency_ts ON latency_log(ts)",
    "CREATE INDEX IF NOT EXISTS idx_latency_session_ts ON latency_log(market_session, ts)",
)


@dataclass(frozen=True)
class LatencyRow:
    id: int
    ts: float
    rtt_ms: Optional[float]
    market_session: str
    day_of_week: int
    hour_utc: int
    local_cpu_pct: Optional[float]
    local_mem_pct: Optional[float]
    anomaly: bool
    notes: Optional[str]


class LatencyLogStore:
    """Append-only SQLite store for latency observations.

    Co-located with the orders DB by default so the spec's "single
    trading.db" footprint is preserved. Tests pass an explicit path."""

    def __init__(self, path: Path):
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(
            str(self._path),
            check_same_thread=False,
            isolation_level=None,
        )
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute(_LATENCY_DDL)
            for ddl in _LATENCY_INDEXES:
                cur.execute(ddl)

    # ── Append API ────────────────────────────────────────────────────────

    def append(
        self,
        *,
        rtt_ms: Optional[float],
        market_session: MarketSession | str,
        day_of_week: int,
        hour_utc: int,
        local_cpu_pct: Optional[float] = None,
        local_mem_pct: Optional[float] = None,
        anomaly: bool = False,
        notes: Optional[str] = None,
        ts: Optional[float] = None,
    ) -> int:
        ts_val = float(ts if ts is not None else time.time())
        session_val = market_session.value if isinstance(market_session, MarketSession) else str(market_session)
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                "INSERT INTO latency_log (ts, rtt_ms, market_session, day_of_week, hour_utc, "
                "local_cpu_pct, local_mem_pct, anomaly, notes) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    ts_val,
                    (float(rtt_ms) if rtt_ms is not None else None),
                    session_val,
                    int(day_of_week),
                    int(hour_utc),
                    (float(local_cpu_pct) if local_cpu_pct is not None else None),
                    (float(local_mem_pct) if local_mem_pct is not None else None),
                    int(bool(anomaly)),
                    notes,
                ),
            )
            return int(cur.lastrowid or 0)

    # ── Read API ──────────────────────────────────────────────────────────

    def list_recent(self, *, limit: int = 1000, session: Optional[str] = None) -> list[LatencyRow]:
        sql = "SELECT * FROM latency_log WHERE 1=1"
        args: list[Any] = []
        if session is not None:
            sql += " AND market_session = ?"
            args.append(session)
        sql += " ORDER BY ts DESC LIMIT ?"
        args.append(int(limit))
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(sql, args)
            return [_row_to_latency(r) for r in cur.fetchall()]

    def list_since(self, *, since_ts: float, session: Optional[str] = None) -> list[LatencyRow]:
        sql = "SELECT * FROM latency_log WHERE ts >= ?"
        args: list[Any] = [float(since_ts)]
        if session is not None:
            sql += " AND market_session = ?"
            args.append(session)
        sql += " ORDER BY ts ASC"
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(sql, args)
            return [_row_to_latency(r) for r in cur.fetchall()]

    def count(self) -> int:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("SELECT COUNT(*) FROM latency_log")
            r = cur.fetchone()
            return int(r[0] if r else 0)

    def latest(self, *, session: Optional[str] = None) -> Optional[LatencyRow]:
        rows = self.list_recent(limit=1, session=session)
        return rows[0] if rows else None

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except sqlite3.Error:
                pass


def _row_to_latency(r: sqlite3.Row) -> LatencyRow:
    return LatencyRow(
        id=int(r["id"]),
        ts=float(r["ts"]),
        rtt_ms=(float(r["rtt_ms"]) if r["rtt_ms"] is not None else None),
        market_session=str(r["market_session"]),
        day_of_week=int(r["day_of_week"]),
        hour_utc=int(r["hour_utc"]),
        local_cpu_pct=(float(r["local_cpu_pct"]) if r["local_cpu_pct"] is not None else None),
        local_mem_pct=(float(r["local_mem_pct"]) if r["local_mem_pct"] is not None else None),
        anomaly=bool(r["anomaly"]),
        notes=(str(r["notes"]) if r["notes"] is not None else None),
    )


# ── Monitor (background thread) ───────────────────────────────────────────


_DEFAULT_INTERVAL_S = 30.0


@dataclass
class LatencyMonitor:
    """Background daemon thread that records RTT to the bridge."""

    store: LatencyLogStore
    interval_s: float = _DEFAULT_INTERVAL_S
    health_check: Callable[[], None] = None  # type: ignore[assignment]
    p95_lookup: Callable[[str], Optional[float]] = lambda _s: None
    clock: Callable[[], float] = time.time
    _thread: Optional[threading.Thread] = None
    _stop: threading.Event = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.health_check is None:  # type: ignore[truthy-function]
            bridge = mt5_bridge.get_bridge()
            self.health_check = lambda: bridge.health_check()
        self._stop = threading.Event()

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        t = threading.Thread(target=self._run, name="latency-monitor", daemon=True)
        self._thread = t
        t.start()

    def stop(self, join_timeout_s: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=join_timeout_s)

    # ── Sample one observation (also exposed for tests) ───────────────────

    def sample_once(self) -> LatencyRow:
        from datetime import datetime, timezone

        now = datetime.fromtimestamp(self.clock(), tz=timezone.utc)
        session = current_market_session(now.hour)
        rtt_ms: Optional[float]
        notes: Optional[str] = None
        try:
            t0 = time.perf_counter()
            self.health_check()
            rtt_ms = (time.perf_counter() - t0) * 1000.0
        except BridgeError as e:
            rtt_ms = None
            notes = f"BRIDGE_UNREACHABLE: {e}"
        cpu, mem = _read_resource_usage()
        anomaly = False
        if rtt_ms is not None:
            p95 = self.p95_lookup(session.value)
            if p95 is not None and rtt_ms > p95 * 1.5:
                anomaly = True
        row_id = self.store.append(
            rtt_ms=rtt_ms,
            market_session=session,
            day_of_week=int(now.weekday()),
            hour_utc=int(now.hour),
            local_cpu_pct=cpu,
            local_mem_pct=mem,
            anomaly=anomaly,
            notes=notes,
            ts=now.timestamp(),
        )
        latest = self.store.latest()
        if latest is None or latest.id != row_id:  # pragma: no cover — sanity
            raise RuntimeError("latency_monitor: append returned but row not visible")
        return latest

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.sample_once()
            except Exception as e:  # never crash the daemon thread
                logger.warning("latency_monitor sample failed: %s", e)
            # sleep with cancellation
            self._stop.wait(self.interval_s)
