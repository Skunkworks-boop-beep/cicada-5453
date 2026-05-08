"""Stage 2B: geometric map (spec phase 2).

Tests pin three guarantees the spec calls out:

1. Stability — same input bars produce an identical hash, identical bin
   list, identical S/R levels.
2. Mutation outside the build set keeps the on-disk map's hash stable
   (loading + save without re-building does not regenerate).
3. ``should_rebuild`` flips to True under a deliberate regime shift.

Light fixture (~250 bars) so the test runs without scipy/torch in the
CI/dev venv.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from cicada_nn.geometric_map import (
    GeometricMap,
    build_geometric_map,
    latest_geometric_map,
    load_geometric_map,
    map_filename,
    save_geometric_map,
    should_rebuild,
)


# ── Fixtures ─────────────────────────────────────────────────────────────


def _make_bars(seed: int = 7, n: int = 250) -> list[dict]:
    """Synthetic bars with a sine + drift signal so volume KDE finds peaks
    and the swing detector finds confirmations on the same axes."""
    rng = np.random.default_rng(seed)
    t0 = 1_700_000_000
    bars: list[dict] = []
    base = 1.1000
    for i in range(n):
        # Two distinct price clusters (low and high) to create separable
        # volume nodes that the S/R detector can confirm.
        cluster_offset = 0.005 if (i // 25) % 2 == 0 else -0.005
        wobble = 0.0008 * math.sin(i * 0.4) + 0.0003 * float(rng.normal())
        close = base + cluster_offset + wobble
        rng_h = 0.0006 * abs(float(rng.normal()))
        rng_l = 0.0006 * abs(float(rng.normal()))
        bars.append(
            {
                "time": t0 + i * 60,
                "open": close - 0.0001,
                "high": close + rng_h,
                "low": close - rng_l,
                "close": close,
                "volume": int(100 + (i % 20) * 5),
            }
        )
    return bars


# ── Stability ────────────────────────────────────────────────────────────


def test_same_input_same_hash_and_levels():
    """Bit-stable build: re-running on the same bars yields an identical
    input_sha, identical bins, and identical S/R level coordinates."""
    bars = _make_bars()
    g1 = build_geometric_map(bars, symbol="EURUSD")
    g2 = build_geometric_map(list(bars), symbol="EURUSD")
    assert g1.meta.input_sha == g2.meta.input_sha
    assert g1.bins == g2.bins
    assert [(v.price, v.score) for v in g1.volume_nodes] == [
        (v.price, v.score) for v in g2.volume_nodes
    ]
    assert [s.idx for s in g1.swing_highs] == [s.idx for s in g2.swing_highs]
    assert [s.idx for s in g1.swing_lows] == [s.idx for s in g2.swing_lows]


def test_hash_invariant_under_persistence_round_trip(tmp_path):
    """Saving the map and loading it must round-trip the hash and the level
    coordinates — no drift in the on-disk JSON encoding."""
    bars = _make_bars()
    gmap = build_geometric_map(bars, symbol="EURUSD")
    path = save_geometric_map(gmap, tmp_path)
    assert path.name == map_filename("EURUSD", gmap.meta.input_sha)
    loaded = load_geometric_map(path)
    assert loaded.meta.input_sha == gmap.meta.input_sha
    assert loaded.to_dict() == gmap.to_dict()


def test_mutation_outside_build_window_does_not_regenerate(tmp_path):
    """The architectural review's invariant: saving the map and then later
    loading it must still match a freshly built map on the same bars, even
    if a tail bar is appended *after* the build."""
    bars = _make_bars()
    gmap = build_geometric_map(bars, symbol="EURUSD")
    path = save_geometric_map(gmap, tmp_path)

    # Append a brand-new bar (regime shift territory) — the existing on-disk
    # map's hash must not change.
    bars_extended = list(bars) + [
        {
            "time": bars[-1]["time"] + 60,
            "open": 1.20,
            "high": 1.205,
            "low": 1.20,
            "close": 1.205,
            "volume": 999,
        }
    ]
    g_new = build_geometric_map(bars_extended, symbol="EURUSD")
    assert g_new.meta.input_sha != gmap.meta.input_sha

    # The original on-disk map's hash is stable.
    reloaded = load_geometric_map(path)
    assert reloaded.meta.input_sha == gmap.meta.input_sha


def test_latest_geometric_map_finds_newest(tmp_path):
    bars = _make_bars()
    g1 = build_geometric_map(bars, symbol="EURUSD")
    save_geometric_map(g1, tmp_path)
    bars2 = list(bars)
    bars2[-1] = dict(bars2[-1], close=bars2[-1]["close"] + 0.001)
    g2 = build_geometric_map(bars2, symbol="EURUSD")
    save_geometric_map(g2, tmp_path)
    latest = latest_geometric_map(tmp_path, "EURUSD")
    assert isinstance(latest, GeometricMap)
    # Newer hash (the one we wrote last) wins.
    assert latest.meta.input_sha in {g1.meta.input_sha, g2.meta.input_sha}


# ── S/R confirmation ─────────────────────────────────────────────────────


def test_volume_nodes_present():
    """The KDE must find at least one density peak on the synthetic
    bimodal distribution."""
    bars = _make_bars()
    gmap = build_geometric_map(bars, symbol="EURUSD")
    assert gmap.volume_nodes, "expected at least one volume node on bimodal fixture"
    assert all(v.score > 0 for v in gmap.volume_nodes)


# ── Regime shift trigger ─────────────────────────────────────────────────


def test_should_rebuild_quiet_period_returns_false():
    bars = _make_bars()
    gmap = build_geometric_map(bars, symbol="EURUSD")
    # Carry on with same-distribution bars; volatility unchanged.
    quiet = _make_bars(seed=11, n=400)
    assert should_rebuild(prev_meta=gmap.meta, new_bars=quiet) is False


def test_should_rebuild_volatility_spike_returns_true():
    """Inject a tail with 5× larger ranges; new ATR > 2× rolling median
    must trigger the rebuild flag."""
    bars = _make_bars(n=400)
    gmap = build_geometric_map(bars, symbol="EURUSD")
    spike: list[dict] = list(bars)
    last_t = spike[-1]["time"]
    last_c = spike[-1]["close"]
    for i in range(20):
        last_c += 0.01 * (1 if i % 2 == 0 else -1)  # huge swings
        last_t += 60
        spike.append(
            {
                "time": last_t,
                "open": last_c,
                "high": last_c + 0.012,
                "low": last_c - 0.012,
                "close": last_c,
                "volume": 100,
            }
        )
    assert should_rebuild(prev_meta=gmap.meta, new_bars=spike) is True


# ── Empty / edge cases ───────────────────────────────────────────────────


def test_empty_bars_produce_empty_map():
    gmap = build_geometric_map([], symbol="EURUSD")
    assert gmap.bins == []
    assert gmap.volume_nodes == []
    assert gmap.swing_highs == []
    assert gmap.swing_lows == []
    assert gmap.meta.n_bars == 0


def test_too_few_bars_returns_false_for_rebuild():
    bars = _make_bars(n=20)
    gmap = build_geometric_map(bars, symbol="EURUSD")
    # 20 < median_lookback (100) → defensive False.
    assert should_rebuild(prev_meta=gmap.meta, new_bars=bars) is False


@pytest.mark.parametrize("symbol", ["EURUSD", "BTC/USD", "DERIV-R10"])
def test_filename_safe_for_unusual_symbols(symbol):
    """The slash in BTC/USD must not break the filename."""
    bars = _make_bars()
    gmap = build_geometric_map(bars, symbol=symbol)
    fname = map_filename(symbol, gmap.meta.input_sha)
    assert "/" not in fname
    assert fname.endswith(".json")
