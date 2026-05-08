"""Stage 2B: fakeout-as-event detection (spec phase 5b).

Pinned guarantees per the brief:

* Known historical fakeout fixtures classify as ``FAKEOUT`` rows.
* Regular trend-continuation bars produce no FAKEOUT row.
* Output rows never carry ``event_type="LOSS"`` — distinct from the
  strategy-side ``pa-fakeout`` ID (review §11).
"""

from __future__ import annotations

import numpy as np
import pytest

from cicada_nn.fakeout_detection import FakeoutEvent, detect_fakeouts
from cicada_nn.geometric_map import (
    GeometricMap,
    GeometricMapMeta,
    SRLevel,
    VolumeNode,
)


# ── Helpers ──────────────────────────────────────────────────────────────


def _bar(t: int, o: float, h: float, l: float, c: float, v: int) -> dict:
    return {"time": t, "open": o, "high": h, "low": l, "close": c, "volume": v}


def _empty_map_with_levels(supports=(), resistances=()) -> GeometricMap:
    """Build a GeometricMap stub carrying only the level lists the detector
    needs. The other fields are inert."""
    return GeometricMap(
        symbol="EURUSD",
        bins=[1.0, 1.5, 2.0],
        volume_nodes=[VolumeNode(price=1.0, score=0.1)],
        swing_highs=[],
        swing_lows=[],
        support_levels=[SRLevel(price=p, kind="support", confirmations=2, score=1.0) for p in supports],
        resistance_levels=[SRLevel(price=p, kind="resistance", confirmations=2, score=1.0) for p in resistances],
        meta=GeometricMapMeta(
            version=1,
            symbol="EURUSD",
            n_bars=10,
            bar_first_time=0.0,
            bar_last_time=10.0,
            atr_at_build=0.05,
            input_sha="0" * 64,
        ),
    )


def _trending_bars(n: int = 30) -> list[dict]:
    """Steadily rising bars — no fakeouts, just trend continuation."""
    out: list[dict] = []
    for i in range(n):
        c = 1.0 + i * 0.01
        out.append(_bar(t=1_700_000_000 + i * 60, o=c - 0.001, h=c + 0.005, l=c - 0.005, c=c, v=100))
    return out


# ── Known fakeout fixture ────────────────────────────────────────────────


def _fakeout_fixture() -> tuple[list[dict], GeometricMap]:
    """A 25-bar series with a deliberate failed-breakout near a resistance:

    * Bars 0-19: stable around 1.10 with normal volume.
    * Bar 20 (the fakeout): high 1.108 (slightly above the 1.107 resistance),
      close 1.099 — a long upper wick rejection.
    * Bar 21: hard reversal close at 1.095 with normal range — high velocity.
    * Bars 22-24: continuation down.

    Resistance at 1.107 (volume-profile peak with two confirming swing highs)
    is supplied via the geometric map stub.
    """
    bars: list[dict] = []
    t0 = 1_700_000_000
    for i in range(20):
        c = 1.100 + 0.0003 * np.sin(i)
        bars.append(_bar(t=t0 + i * 60, o=c - 0.0001, h=c + 0.0010, l=c - 0.0010, c=float(c), v=100))
    # Bar 20 — fakeout: spikes above 1.107 then closes well below.
    bars.append(_bar(t=t0 + 20 * 60, o=1.103, h=1.108, l=1.097, c=1.099, v=40))  # vol contracted
    # Bar 21 — hard reversal: large red bar, high velocity (close move > 0.5×range_20).
    bars.append(_bar(t=t0 + 21 * 60, o=1.099, h=1.100, l=1.090, c=1.090, v=120))
    # Bars 22-24 — continuation down.
    for i in range(22, 25):
        c = 1.094 - (i - 22) * 0.001
        bars.append(_bar(t=t0 + i * 60, o=c + 0.0005, h=c + 0.001, l=c - 0.001, c=float(c), v=110))
    gmap = _empty_map_with_levels(resistances=(1.107,))
    return bars, gmap


# ── Tests ────────────────────────────────────────────────────────────────


def test_known_fakeout_classified_as_fakeout():
    bars, gmap = _fakeout_fixture()
    events = detect_fakeouts(bars, gmap)
    assert events, "expected at least one FakeoutEvent on the known fixture"
    assert all(e.event_type == "FAKEOUT" for e in events)
    # The breach happens on bar 20 (resistance at 1.107).
    bar20 = next((e for e in events if e.bar_idx == 20), None)
    assert bar20 is not None
    assert bar20.level_kind == "resistance"
    assert bar20.level_price == pytest.approx(1.107)
    assert bar20.breach_magnitude > 0
    assert bar20.time_beyond_bars <= 3


def test_no_fakeout_on_trending_bars():
    bars = _trending_bars()
    gmap = _empty_map_with_levels(resistances=(2.0,), supports=(0.5,))
    assert detect_fakeouts(bars, gmap) == []


def test_event_type_never_loss():
    """Hard contract: FAKEOUT rows never leak the ``LOSS`` event type that
    the loss-inversion module owns."""
    bars, gmap = _fakeout_fixture()
    events = detect_fakeouts(bars, gmap)
    assert all(e.event_type != "LOSS" for e in events)


def test_no_levels_returns_empty():
    bars, _ = _fakeout_fixture()
    empty = _empty_map_with_levels()  # no support / no resistance
    assert detect_fakeouts(bars, empty) == []


def test_full_breakout_not_a_fakeout():
    """When the breach magnitude exceeds 1.5×ATR the detector must reject —
    that's a real breakout, not a failed one."""
    bars: list[dict] = []
    t0 = 1_700_000_000
    for i in range(15):
        c = 1.100
        bars.append(_bar(t=t0 + i * 60, o=c, h=c + 0.001, l=c - 0.001, c=c, v=100))
    # Massive breakout: high 1.20 (ATR ~0.001 → 1.5×ATR ~0.0015). Magnitude > threshold → no fakeout.
    bars.append(_bar(t=t0 + 15 * 60, o=1.10, h=1.20, l=1.10, c=1.19, v=200))
    bars.append(_bar(t=t0 + 16 * 60, o=1.19, h=1.21, l=1.18, c=1.20, v=200))
    gmap = _empty_map_with_levels(resistances=(1.105,))
    assert detect_fakeouts(bars, gmap) == []


def test_empty_bars_returns_empty():
    gmap = _empty_map_with_levels(resistances=(1.10,))
    assert detect_fakeouts([], gmap) == []


def test_event_to_dict_keeps_event_type():
    bars, gmap = _fakeout_fixture()
    events = detect_fakeouts(bars, gmap)
    assert events
    payload = events[0].to_dict()
    assert payload["event_type"] == "FAKEOUT"
    for required in ("bar_idx", "bar_time", "level_price", "level_kind"):
        assert required in payload
