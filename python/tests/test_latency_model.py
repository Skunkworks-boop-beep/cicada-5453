"""Stage 2A: per-mode trade gates + baseline statistics for the latency model.

Spec lines 1357-1412 (methods) and 1378-1396 (per-mode gate matrix)."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from cicada_nn.latency_model import LatencyModel
from cicada_nn.latency_monitor import LatencyLogStore, MarketSession


# ── Helpers ──────────────────────────────────────────────────────────────


def _london_clock() -> float:
    """Pin the clock to a LONDON-session UTC hour so ``market_session_now()``
    matches the seeded session deterministically. 2026-05-04 10:00 UTC is
    a Monday inside the 07-12 LONDON window."""
    import datetime as _dt
    return _dt.datetime(2026, 5, 4, 10, 0, 0, tzinfo=_dt.timezone.utc).timestamp()


def _model(tmp_path: Path, *, samples: list[float] | None = None,
           session: MarketSession = MarketSession.LONDON,
           clock_t: float | None = None,
           min_samples: int = 20):
    store = LatencyLogStore(tmp_path / "latency.sqlite")
    t = clock_t if clock_t is not None else _london_clock()
    if samples:
        for i, rtt in enumerate(samples):
            # Stagger inside the rolling window so list_since picks them up.
            store.append(
                rtt_ms=rtt,
                market_session=session,
                day_of_week=(i % 7),
                hour_utc=10,
                ts=t - (len(samples) - i),
            )
    return LatencyModel(store, clock=lambda: t, min_samples=min_samples)


# ── Baseline ─────────────────────────────────────────────────────────────


def test_baseline_none_when_below_min_samples(tmp_path: Path):
    m = _model(tmp_path, samples=[10.0] * 5, min_samples=20)
    assert m.get_baseline() is None
    assert m.is_baseline_valid() is False


def test_baseline_p50_p95_p99_with_enough_samples(tmp_path: Path):
    samples = [float(i + 1) for i in range(100)]  # 1..100
    m = _model(tmp_path, samples=samples, min_samples=20)
    b = m.get_baseline()
    assert b is not None
    assert b.sample_count == 100
    # ~50.5 / ~95.05 / ~99.01 with linear interpolation
    assert 50.0 <= b.p50 <= 51.0
    assert 94.0 <= b.p95 <= 96.0
    assert 98.0 <= b.p99 <= 100.0


# ── Trade gate per mode ──────────────────────────────────────────────────


def test_gate_baseline_not_established(tmp_path: Path):
    m = _model(tmp_path, samples=[10.0] * 5, min_samples=20)
    g = m.get_trade_gate("scalping")
    assert g.allowed is False
    assert g.reason == "BASELINE_NOT_ESTABLISHED"


def test_gate_ok_when_rtt_under_p95(tmp_path: Path):
    # Stable baseline of low RTT, current latest is also low
    m = _model(tmp_path, samples=[20.0] * 30, min_samples=20)
    g = m.get_trade_gate("scalping")
    assert g.allowed is True
    assert g.reason == "OK"


def test_scalp_strict_blocks_at_elevated(tmp_path: Path):
    """SCALPING blocks at >1.2× p95 — even though SWING would proceed."""
    base_t = _london_clock()
    m = _model(tmp_path, samples=[20.0] * 30, clock_t=base_t, min_samples=20)
    store = m._store  # noqa: SLF001 (intentional: arrange for the test)
    store.append(
        rtt_ms=28.0,  # 1.4× of 20 (p95 ~= 20 with all-equal samples)
        market_session=MarketSession.LONDON,
        day_of_week=1,
        hour_utc=10,
        ts=base_t,
    )
    g = m.get_trade_gate("scalping")
    assert g.allowed is False
    assert g.reason == "LATENCY_ELEVATED"


def test_swing_allows_elevated_with_flag(tmp_path: Path):
    """SWING proceeds at >1.5× p95 (with flag) but rejects at >2.0×."""
    base_t = _london_clock()
    m = _model(tmp_path, samples=[20.0] * 30, clock_t=base_t, min_samples=20)
    store = m._store  # noqa: SLF001
    store.append(rtt_ms=35.0, market_session=MarketSession.LONDON, day_of_week=1, hour_utc=10,
                 ts=base_t)
    g = m.get_trade_gate("swing")
    assert g.allowed is True
    assert g.reason == "LATENCY_ELEVATED"


def test_swing_rejects_at_severe(tmp_path: Path):
    base_t = _london_clock()
    m = _model(tmp_path, samples=[20.0] * 30, clock_t=base_t, min_samples=20)
    store = m._store  # noqa: SLF001
    store.append(rtt_ms=80.0, market_session=MarketSession.LONDON, day_of_week=1, hour_utc=10,
                 ts=base_t)
    g = m.get_trade_gate("swing")
    assert g.allowed is False
    assert g.reason == "LATENCY_SEVERE"


def test_sniper_allows_at_2_5x_p95(tmp_path: Path):
    """SNIPER tolerates 2.5× p95 (only blocks above 3×)."""
    base_t = _london_clock()
    m = _model(tmp_path, samples=[20.0] * 30, clock_t=base_t, min_samples=20)
    store = m._store  # noqa: SLF001
    # 2.5× of the seeded p95 (~20)
    store.append(rtt_ms=50.0, market_session=MarketSession.LONDON, day_of_week=1, hour_utc=10,
                 ts=base_t)
    g = m.get_trade_gate("sniper")
    assert g.allowed is True


def test_sniper_blocks_at_extreme(tmp_path: Path, tmp_path_factory):
    """SNIPER blocks above 3× p95 with reason LATENCY_EXTREME.

    Uses an isolated store so the high-RTT current sample doesn't pollute
    the baseline window enough to deny the gate via dilution alone."""
    base_t = _london_clock()
    # Lots of low-RTT seeds so one outlier doesn't move p95 above ~21
    m = _model(tmp_path, samples=[20.0] * 100, clock_t=base_t, min_samples=20)
    store = m._store  # noqa: SLF001
    # 200ms vs p95 ~ 20 → 10× — well above SNIPER's 3× threshold even after
    # the outlier joins the baseline window.
    store.append(rtt_ms=200.0, market_session=MarketSession.LONDON, day_of_week=1, hour_utc=10,
                 ts=base_t)
    g = m.get_trade_gate("sniper")
    assert g.allowed is False
    assert g.reason == "LATENCY_EXTREME"


def test_unknown_mode_blocked(tmp_path: Path):
    m = _model(tmp_path, samples=[20.0] * 30, min_samples=20)
    g = m.get_trade_gate("nonsense")  # type: ignore[arg-type]
    assert g.allowed is False
    assert g.reason == "UNKNOWN_MODE"


# ── RTT staleness ────────────────────────────────────────────────────────


def test_get_current_rtt_none_when_stale(tmp_path: Path):
    store = LatencyLogStore(tmp_path / "latency.sqlite")
    # Old sample > 60s ago
    store.append(rtt_ms=15.0, market_session=MarketSession.LONDON, day_of_week=1, hour_utc=10,
                 ts=time.time() - 600)
    m = LatencyModel(store, clock=time.time, min_samples=1)
    assert m.get_current_rtt() is None


def test_get_current_rtt_returns_value_when_fresh(tmp_path: Path):
    store = LatencyLogStore(tmp_path / "latency.sqlite")
    store.append(rtt_ms=42.0, market_session=MarketSession.LONDON, day_of_week=1, hour_utc=10,
                 ts=time.time())
    m = LatencyModel(store, clock=time.time, min_samples=1)
    assert m.get_current_rtt() == 42.0


# ── Profiles & expected slippage ─────────────────────────────────────────


def test_session_profile_includes_all_sessions(tmp_path: Path):
    m = _model(tmp_path, samples=[20.0] * 25, session=MarketSession.LONDON, min_samples=20)
    out = m.session_profile()
    assert set(out.keys()) == {s.value for s in MarketSession}
    assert out["LONDON"]["sample_count"] == 25
    assert out["TOKYO"]["sample_count"] == 0


def test_expected_slippage_scales_with_rtt(tmp_path: Path):
    store = LatencyLogStore(tmp_path / "latency.sqlite")
    t = time.time()
    store.append(rtt_ms=100.0, market_session=MarketSession.LONDON, day_of_week=1, hour_utc=10, ts=t)
    m = LatencyModel(store, clock=lambda: t, min_samples=1)
    scalp = m.expected_slippage("scalping")
    swing = m.expected_slippage("swing")
    assert scalp > 0
    assert scalp > swing  # scalping is more sensitive
