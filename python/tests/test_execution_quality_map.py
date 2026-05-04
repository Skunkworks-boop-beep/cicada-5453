"""Stage 2B: execution-quality map (spec phase 2b).

Tests use a fake bridge so we never need a network or real MT5; this is
the same pattern as ``test_mt5_bridge.py``.

Pinned guarantees:

* Round-trip through the fake bridge produces non-negative spread fields.
* Missing bridge → ``degraded=True`` with no exception.
* Persistence partitions by instrument/date and round-trips the dataclass.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Optional

import pytest

from cicada_nn.execution_quality_map import (
    ExecutionQualityMap,
    build_execution_quality_map,
    latest_execution_quality_map,
    load_execution_quality_map,
    save_execution_quality_map,
)
from cicada_nn.mt5_bridge import BridgeUnreachableError


# ── Fake bridge ──────────────────────────────────────────────────────────


class _FakeBridge:
    """Mirrors the public ``MT5Bridge.get_ticks`` surface."""

    def __init__(self, ticks: list[dict]):
        self._ticks = ticks
        self.calls: list[tuple[str, int, int]] = []

    def get_ticks(self, *, symbol: str, from_ts: int, to_ts: int) -> list[dict]:
        self.calls.append((symbol, int(from_ts), int(to_ts)))
        return list(self._ticks)


class _UnreachableBridge:
    def get_ticks(self, *, symbol: str, from_ts: int, to_ts: int) -> list[dict]:
        raise BridgeUnreachableError("VM offline")


# ── Fixtures ─────────────────────────────────────────────────────────────


def _ticks(n: int = 200) -> list[dict]:
    """Synthetic ticks distributed across two clusters, matching the
    bimodal price fixture used in test_geometric_map_stability.py."""
    out: list[dict] = []
    t0 = 1_700_000_000
    for i in range(n):
        cluster = 1.105 if (i // 25) % 2 == 0 else 1.095
        bid = cluster + 0.0001 * (i % 10) - 0.0005
        ask = bid + 0.0002 + (0.0008 if (i % 50 == 0) else 0.0)  # occasional wide spread
        out.append(
            {
                "time": t0 + i,
                "bid": bid,
                "ask": ask,
                "volume": 50 + (i % 20),
                "spread": max(0.0, ask - bid),
            }
        )
    return out


def _bins() -> list[float]:
    """Geometric map's bins covering both clusters."""
    return [round(1.090 + i * 0.001, 4) for i in range(21)]  # 1.090 → 1.110


# ── Build through fake bridge ────────────────────────────────────────────


def test_build_round_trip_through_fake_bridge():
    bridge = _FakeBridge(_ticks())
    eqmap = build_execution_quality_map(
        symbol="EURUSD",
        bins=_bins(),
        bridge=bridge,
        from_ts=1_700_000_000,
        to_ts=1_700_001_000,
        expected_slippage_ms=0.5,
    )
    assert eqmap.degraded is False
    assert eqmap.cells, "expected at least one populated bin"
    for c in eqmap.cells:
        assert c.n_ticks > 0
        assert c.avg_spread >= 0.0
        assert c.spread_variance >= 0.0
        assert c.avg_slippage >= 0.0
        assert 0.0 <= c.partial_fill_probability <= 1.0
        assert c.book_depth_proxy >= 0.0
        # latency_impact_estimate ought to be a real number when expected_slippage is provided.
        assert math.isfinite(c.latency_impact_estimate)
    assert bridge.calls == [("EURUSD", 1_700_000_000, 1_700_001_000)]


def test_build_with_explicit_ticks_skips_bridge():
    eqmap = build_execution_quality_map(
        symbol="EURUSD",
        bins=_bins(),
        ticks=_ticks(),
    )
    assert eqmap.degraded is False
    assert eqmap.cells


# ── Degraded paths ───────────────────────────────────────────────────────


def test_unreachable_bridge_marks_degraded_no_raise():
    eqmap = build_execution_quality_map(
        symbol="EURUSD",
        bins=_bins(),
        bridge=_UnreachableBridge(),
        from_ts=1,
        to_ts=2,
    )
    assert eqmap.degraded is True
    assert eqmap.cells == []
    assert eqmap.note and "BRIDGE_UNREACHABLE" in eqmap.note


def test_no_ticks_marks_degraded():
    eqmap = build_execution_quality_map(
        symbol="EURUSD",
        bins=_bins(),
        ticks=[],
    )
    assert eqmap.degraded is True
    assert eqmap.note == "NO_TICKS"


def test_missing_time_range_marks_degraded():
    eqmap = build_execution_quality_map(
        symbol="EURUSD",
        bins=_bins(),
        bridge=_FakeBridge(_ticks()),
    )
    assert eqmap.degraded is True
    assert eqmap.note == "MISSING_TIME_RANGE"


# ── Persistence ──────────────────────────────────────────────────────────


def test_save_and_load_round_trip(tmp_path: Path):
    eqmap = build_execution_quality_map(
        symbol="EURUSD",
        bins=_bins(),
        ticks=_ticks(),
        expected_slippage_ms=0.5,
    )
    path = save_execution_quality_map(eqmap, tmp_path)
    # Partition layout: <tmp>/<SYMBOL>/<date>/<file>.json
    assert path.parent.parent.name == "EURUSD"
    loaded = load_execution_quality_map(path)
    assert loaded.to_dict() == eqmap.to_dict()


def test_latest_finds_newest(tmp_path: Path):
    eq1 = build_execution_quality_map(symbol="EURUSD", bins=_bins(), ticks=_ticks())
    save_execution_quality_map(eq1, tmp_path)
    found = latest_execution_quality_map(tmp_path, "EURUSD")
    assert isinstance(found, ExecutionQualityMap)
    assert not found.degraded


def test_latest_missing_symbol_returns_none(tmp_path: Path):
    assert latest_execution_quality_map(tmp_path, "NONESUCH") is None
