"""Stage 2A: latency_log table + session bucketing + monitor sampling."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from cicada_nn.latency_monitor import (
    LatencyLogStore,
    LatencyMonitor,
    MarketSession,
    current_market_session,
)
from cicada_nn.mt5_bridge import BridgeUnreachableError


# ── Session mapping per spec lines 1313-1323 ─────────────────────────────


@pytest.mark.parametrize(
    ("hour", "expected"),
    [
        (0, MarketSession.TOKYO),
        (6, MarketSession.TOKYO),
        (7, MarketSession.LONDON),
        (11, MarketSession.LONDON),
        (12, MarketSession.LONDON_NY_OVERLAP),
        (15, MarketSession.LONDON_NY_OVERLAP),
        (16, MarketSession.LONDON),
        (17, MarketSession.NEW_YORK),
        (20, MarketSession.NEW_YORK),
        (21, MarketSession.SYDNEY),
        (23, MarketSession.SYDNEY),
    ],
)
def test_market_session_mapping(hour: int, expected: MarketSession):
    assert current_market_session(hour) == expected


# ── Append / read invariants ─────────────────────────────────────────────


def _store(tmp_path: Path) -> LatencyLogStore:
    return LatencyLogStore(tmp_path / "latency.sqlite")


def test_append_and_read_row(tmp_path: Path):
    s = _store(tmp_path)
    rid = s.append(
        rtt_ms=42.5,
        market_session=MarketSession.LONDON,
        day_of_week=2,
        hour_utc=10,
        local_cpu_pct=11.1,
        local_mem_pct=22.2,
        anomaly=False,
    )
    assert rid > 0
    rows = s.list_recent(limit=10)
    assert len(rows) == 1
    r = rows[0]
    assert r.rtt_ms == 42.5
    assert r.market_session == "LONDON"
    assert r.day_of_week == 2
    assert r.hour_utc == 10
    assert r.anomaly is False


def test_null_rtt_recorded_with_notes(tmp_path: Path):
    s = _store(tmp_path)
    s.append(
        rtt_ms=None,
        market_session=MarketSession.OFF_HOURS,
        day_of_week=5,
        hour_utc=3,
        notes="BRIDGE_UNREACHABLE: timeout",
    )
    rows = s.list_recent()
    assert rows[0].rtt_ms is None
    assert "BRIDGE_UNREACHABLE" in (rows[0].notes or "")


def test_count_grows_only(tmp_path: Path):
    s = _store(tmp_path)
    for _ in range(5):
        s.append(rtt_ms=10.0, market_session=MarketSession.LONDON, day_of_week=1, hour_utc=10)
    assert s.count() == 5
    s.append(rtt_ms=12.0, market_session=MarketSession.LONDON, day_of_week=1, hour_utc=10)
    assert s.count() == 6


def test_list_since_filters_by_time(tmp_path: Path):
    s = _store(tmp_path)
    t0 = time.time()
    s.append(rtt_ms=1.0, market_session=MarketSession.LONDON, day_of_week=1, hour_utc=10, ts=t0 - 100)
    s.append(rtt_ms=2.0, market_session=MarketSession.LONDON, day_of_week=1, hour_utc=10, ts=t0 - 10)
    s.append(rtt_ms=3.0, market_session=MarketSession.LONDON, day_of_week=1, hour_utc=10, ts=t0 + 0)
    rows = s.list_since(since_ts=t0 - 50)
    assert len(rows) == 2
    assert [r.rtt_ms for r in rows] == [2.0, 3.0]


# ── Monitor sampling ─────────────────────────────────────────────────────


def _fake_clock(t: float):
    state = {"t": t}

    def clock() -> float:
        return state["t"]

    def advance(seconds: float) -> None:
        state["t"] += seconds

    clock.advance = advance  # type: ignore[attr-defined]
    return clock


def test_sample_once_records_rtt_when_bridge_reachable(tmp_path: Path):
    s = _store(tmp_path)
    clock = _fake_clock(1_700_000_000.0)
    calls: list[int] = []

    def healthy() -> None:
        calls.append(1)

    mon = LatencyMonitor(store=s, health_check=healthy, clock=clock)
    row = mon.sample_once()
    assert row.rtt_ms is not None and row.rtt_ms >= 0
    assert row.notes is None
    assert s.count() == 1
    assert calls == [1]


def test_sample_once_handles_bridge_failure(tmp_path: Path):
    s = _store(tmp_path)
    clock = _fake_clock(1_700_000_000.0)

    def unreachable() -> None:
        raise BridgeUnreachableError("VM down")

    mon = LatencyMonitor(store=s, health_check=unreachable, clock=clock)
    row = mon.sample_once()
    assert row.rtt_ms is None
    assert row.notes is not None
    assert "BRIDGE_UNREACHABLE" in row.notes


def test_sample_once_flags_anomaly_above_p95(tmp_path: Path):
    s = _store(tmp_path)
    clock = _fake_clock(1_700_000_000.0)

    def slow() -> None:
        # the test "real" rtt isn't directly controllable since sample_once
        # uses perf_counter; instead we make the lookup fixed and assert the
        # anomaly flag fires when p95 is set artificially low.
        pass

    p95 = {"value": 0.0001}  # extremely low so any RTT trips anomaly

    mon = LatencyMonitor(
        store=s,
        health_check=slow,
        clock=clock,
        p95_lookup=lambda _s: p95["value"],
    )
    row = mon.sample_once()
    assert row.anomaly is True


def test_sample_once_no_anomaly_when_p95_unknown(tmp_path: Path):
    s = _store(tmp_path)
    clock = _fake_clock(1_700_000_000.0)

    mon = LatencyMonitor(
        store=s,
        health_check=lambda: None,
        clock=clock,
        p95_lookup=lambda _s: None,
    )
    row = mon.sample_once()
    assert row.anomaly is False


def test_session_tagged_to_clock_hour(tmp_path: Path):
    s = _store(tmp_path)
    # 13 UTC = LONDON_NY_OVERLAP per spec
    import datetime as _dt
    overlap_dt = _dt.datetime(2026, 5, 3, 13, 0, 0, tzinfo=_dt.timezone.utc)
    clock = _fake_clock(overlap_dt.timestamp())

    mon = LatencyMonitor(store=s, health_check=lambda: None, clock=clock)
    row = mon.sample_once()
    assert row.market_session == "LONDON_NY_OVERLAP"


# ── Stage 2B fix B: env-gate ─────────────────────────────────────────────


def test_bootstrap_daemon_skips_monitor_when_env_disabled(monkeypatch):
    """Architectural review §3.2: importing ``cicada_nn.api`` must not spawn
    a daemon thread when ``CICADA_LATENCY_MONITOR=0``. The thread default is
    ON for production; this test pins the test/REPL escape hatch."""
    monkeypatch.setenv("CICADA_LATENCY_MONITOR", "0")
    # Import inside the test so the env var is honoured at startup-hook time.
    import importlib

    import cicada_nn.api as api  # noqa: WPS433
    importlib.reload(api)
    api.LATENCY_MONITOR.stop()  # belt-and-braces in case a prior test started it
    api._bootstrap_daemon()
    assert api.LATENCY_MONITOR._thread is None or not api.LATENCY_MONITOR._thread.is_alive()


def test_bootstrap_daemon_starts_monitor_by_default(monkeypatch):
    monkeypatch.setenv("CICADA_LATENCY_MONITOR", "1")
    import importlib

    import cicada_nn.api as api  # noqa: WPS433
    importlib.reload(api)
    api._bootstrap_daemon()
    try:
        assert api.LATENCY_MONITOR._thread is not None
        assert api.LATENCY_MONITOR._thread.is_alive()
    finally:
        api.LATENCY_MONITOR.stop()
