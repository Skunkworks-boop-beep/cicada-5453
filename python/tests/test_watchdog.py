"""Stage 7: bridge watchdog supervisor.

Tests the pure pieces — health probe parsing + restart-storm tracking —
without spawning real subprocesses (CI-friendly, no port binding).
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from bridge.watchdog import _record_restart, _restart_storm, probe_health


def test_record_restart_drops_entries_older_than_an_hour():
    times: list[float] = []
    now = time.time()
    # Pre-seed with stale entries.
    times.extend([now - 3700, now - 3650])
    _record_restart(times)
    # The pre-seeded entries should be dropped after the call.
    assert all(t > now - 3600 for t in times)


def test_restart_storm_threshold():
    times: list[float] = []
    now = time.time()
    for _ in range(5):
        times.append(now)
    assert _restart_storm(times, threshold=10) is False
    for _ in range(7):
        times.append(now)
    assert _restart_storm(times, threshold=10) is True


def test_probe_health_unreachable_returns_false_with_detail():
    # No server on this port — probe should fail cleanly.
    ok, detail = probe_health("http://127.0.0.1:1/health", timeout_s=1.0)
    assert ok is False
    assert detail  # non-empty diagnostic


class _FakeResponse:
    def __init__(self, status: int, body: bytes):
        self.status = status
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self) -> bytes:
        return self._body


def test_probe_health_ok_returns_true_for_status_ok_body():
    fake = _FakeResponse(200, b'{"status":"ok","mt5_connected":true,"account":"12345"}')
    ok, detail = probe_health("http://test/health", timeout_s=1.0,
                               opener=lambda *a, **kw: fake)
    assert ok is True
    assert detail == "ok"


def test_probe_health_returns_false_on_unexpected_body():
    fake = _FakeResponse(200, b'{"status":"degraded"}')
    ok, detail = probe_health("http://test/health", timeout_s=1.0,
                               opener=lambda *a, **kw: fake)
    assert ok is False
    assert "unexpected" in detail.lower()


def test_probe_health_returns_false_on_non_200():
    fake = _FakeResponse(503, b"")
    ok, detail = probe_health("http://test/health", timeout_s=1.0,
                               opener=lambda *a, **kw: fake)
    assert ok is False
    assert "503" in detail
