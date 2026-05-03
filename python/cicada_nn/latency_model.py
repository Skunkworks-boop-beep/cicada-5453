"""Session-aware latency baselines and per-mode trade gates.

Reads from the ``latency_log`` table populated by ``latency_monitor`` and
exposes the gating logic the order pipeline needs:

  * ``is_baseline_valid()`` — pre-order check #6
  * ``get_trade_gate(mode)`` — pre-order check #7

Per-mode thresholds are extrapolated from spec lines 1378-1396 to cover
all five styles (the spec gives explicit rules for SCALP / SWING / SNIPER;
DAY and MED_SWING are filled in between, conservatively).

All thresholds are multiples of the per-session p95. The model is
intentionally simple: percentile-based, no time-decay weighting, no fancy
forecasting — the data shape is too coarse (one sample per 30s) for
anything more aggressive to be honest.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass
from typing import Callable, Optional

from .latency_monitor import (
    LatencyLogStore,
    LatencyRow,
    MarketSession,
    current_market_session,
)
from .trade_modes import TradeStyle


# ── Per-mode thresholds (multipliers of session p95) ─────────────────────


@dataclass(frozen=True)
class _GateThresholds:
    elevated: float    # > p95 × this → flag (and for strict modes, reject)
    severe: float      # > p95 × this → reject
    elevated_rejects: bool  # SCALPING is strict: elevated also rejects
    elevated_reason: str
    severe_reason: str


# Spec lines 1378-1396 for SCALP/SWING/SNIPER, plus extrapolations for DAY
# and MED_SWING (between SCALP's strictness and SWING's tolerance).
_THRESHOLDS: dict[TradeStyle, _GateThresholds] = {
    "scalping": _GateThresholds(
        elevated=1.2,
        severe=1.5,
        elevated_rejects=True,
        elevated_reason="LATENCY_ELEVATED",
        severe_reason="LATENCY_ANOMALY",
    ),
    "day": _GateThresholds(
        elevated=1.5,
        severe=2.0,
        elevated_rejects=False,
        elevated_reason="LATENCY_ELEVATED",
        severe_reason="LATENCY_SEVERE",
    ),
    "medium_swing": _GateThresholds(
        elevated=1.7,
        severe=2.5,
        elevated_rejects=False,
        elevated_reason="LATENCY_ELEVATED",
        severe_reason="LATENCY_SEVERE",
    ),
    "swing": _GateThresholds(
        elevated=1.5,
        severe=2.0,
        elevated_rejects=False,
        elevated_reason="LATENCY_ELEVATED",
        severe_reason="LATENCY_SEVERE",
    ),
    "sniper": _GateThresholds(
        elevated=2.0,
        severe=3.0,
        elevated_rejects=False,
        elevated_reason="LATENCY_ELEVATED",
        severe_reason="LATENCY_EXTREME",
    ),
}


# ── Public dataclasses ───────────────────────────────────────────────────


@dataclass(frozen=True)
class Baseline:
    p50: float
    p95: float
    p99: float
    sample_count: int


@dataclass(frozen=True)
class TradeGate:
    allowed: bool
    reason: str
    current_rtt: Optional[float]
    baseline_p95: Optional[float]
    recommendation: str


# ── Model ────────────────────────────────────────────────────────────────


_MIN_SAMPLES_FOR_BASELINE = 20
_BASELINE_WINDOW_S = 7 * 24 * 3600  # 7-day rolling window per spec line 1367
_STALE_AFTER_S = 60.0


class LatencyModel:
    """Wraps a ``LatencyLogStore`` with statistics + gating logic."""

    def __init__(
        self,
        store: LatencyLogStore,
        *,
        clock: Callable[[], float] = None,  # type: ignore[assignment]
        min_samples: int = _MIN_SAMPLES_FOR_BASELINE,
        window_s: float = _BASELINE_WINDOW_S,
    ):
        import time
        self._store = store
        self._clock = clock or time.time
        self._min_samples = int(min_samples)
        self._window_s = float(window_s)

    # ── Recent / current ──────────────────────────────────────────────────

    def get_current_rtt(self) -> Optional[float]:
        latest = self._store.latest()
        if latest is None or latest.rtt_ms is None:
            return None
        if self._clock() - latest.ts > _STALE_AFTER_S:
            return None
        return float(latest.rtt_ms)

    def market_session_now(self) -> str:
        from datetime import datetime, timezone
        h = datetime.fromtimestamp(self._clock(), tz=timezone.utc).hour
        return current_market_session(h).value

    # ── Baselines ─────────────────────────────────────────────────────────

    def _samples_for(self, session: str) -> list[float]:
        since = self._clock() - self._window_s
        rows = self._store.list_since(since_ts=since, session=session)
        return [float(r.rtt_ms) for r in rows if r.rtt_ms is not None]

    def get_baseline(self, session: Optional[str] = None) -> Optional[Baseline]:
        s = session or self.market_session_now()
        samples = self._samples_for(s)
        if len(samples) < self._min_samples:
            return None
        return Baseline(
            p50=_percentile(samples, 50),
            p95=_percentile(samples, 95),
            p99=_percentile(samples, 99),
            sample_count=len(samples),
        )

    def is_baseline_valid(self) -> bool:
        return self.get_baseline() is not None

    def is_anomalous(self, threshold: float = 1.5) -> bool:
        rtt = self.get_current_rtt()
        if rtt is None:
            return False
        b = self.get_baseline()
        if b is None:
            return False
        return rtt > b.p95 * float(threshold)

    # ── Per-mode gate ─────────────────────────────────────────────────────

    def get_trade_gate(self, mode: TradeStyle) -> TradeGate:
        """Pre-order check #7. See spec lines 1377-1396."""
        thr = _THRESHOLDS.get(mode)  # type: ignore[arg-type]
        if thr is None:
            return TradeGate(
                allowed=False,
                reason="UNKNOWN_MODE",
                current_rtt=None,
                baseline_p95=None,
                recommendation=f"unknown trade style: {mode!r}",
            )
        rtt = self.get_current_rtt()
        b = self.get_baseline()
        if b is None:
            return TradeGate(
                allowed=False,
                reason="BASELINE_NOT_ESTABLISHED",
                current_rtt=rtt,
                baseline_p95=None,
                recommendation=(
                    f"need at least {self._min_samples} samples in current session "
                    "before live orders are allowed"
                ),
            )
        if rtt is None:
            return TradeGate(
                allowed=False,
                reason="RTT_STALE",
                current_rtt=None,
                baseline_p95=b.p95,
                recommendation="latency monitor stopped reporting; restart bridge?",
            )
        if rtt > b.p95 * thr.severe:
            return TradeGate(
                allowed=False,
                reason=thr.severe_reason,
                current_rtt=rtt,
                baseline_p95=b.p95,
                recommendation=(
                    f"current RTT {rtt:.1f}ms > {thr.severe:.2f}× p95 ({b.p95:.1f}ms); "
                    f"hold {mode!r} entries until conditions normalise"
                ),
            )
        if rtt > b.p95 * thr.elevated:
            allowed = not thr.elevated_rejects
            return TradeGate(
                allowed=allowed,
                reason=thr.elevated_reason,
                current_rtt=rtt,
                baseline_p95=b.p95,
                recommendation=(
                    f"RTT elevated at {rtt:.1f}ms vs p95 {b.p95:.1f}ms — "
                    + (
                        "blocked for SCALPING (strict)"
                        if thr.elevated_rejects
                        else "proceed with flag in order record"
                    )
                ),
            )
        return TradeGate(
            allowed=True,
            reason="OK",
            current_rtt=rtt,
            baseline_p95=b.p95,
            recommendation="",
        )

    # ── Profiles & analytics ──────────────────────────────────────────────

    def session_profile(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for s in MarketSession:
            samples = self._samples_for(s.value)
            if not samples:
                out[s.value] = {"sample_count": 0}
                continue
            out[s.value] = {
                "p50": _percentile(samples, 50),
                "p95": _percentile(samples, 95),
                "p99": _percentile(samples, 99),
                "sample_count": len(samples),
            }
        return out

    def day_of_week_profile(self) -> dict[int, dict]:
        since = self._clock() - self._window_s
        rows = self._store.list_since(since_ts=since)
        buckets: dict[int, list[float]] = {i: [] for i in range(7)}
        for r in rows:
            if r.rtt_ms is None:
                continue
            buckets[int(r.day_of_week)].append(float(r.rtt_ms))
        out: dict[int, dict] = {}
        for d, samples in buckets.items():
            if not samples:
                out[d] = {"sample_count": 0}
                continue
            out[d] = {
                "avg": statistics.fmean(samples),
                "p95": _percentile(samples, 95),
                "sample_count": len(samples),
            }
        return out

    # ── Expected slippage (simple regression) ─────────────────────────────

    def expected_slippage(self, mode: TradeStyle, session: Optional[str] = None) -> float:
        """Linear estimate: assume slippage scales with RTT × per-mode sensitivity.

        We don't yet have actual slippage data joined to RTT (that lands when
        Stage 2B wires execution_quality_map up to ticks). Until then this is
        a structural placeholder that callers can use as an upper bound."""
        sensitivity = {
            "scalping": 0.05,
            "day": 0.03,
            "medium_swing": 0.025,
            "swing": 0.02,
            "sniper": 0.025,
        }.get(str(mode), 0.03)
        rtt = self.get_current_rtt()
        if rtt is None:
            return 0.0
        return float(rtt) * float(sensitivity)


# ── Helpers ──────────────────────────────────────────────────────────────


def _percentile(samples: list[float], pct: float) -> float:
    """Linear-interpolation percentile (NumPy-equivalent for 0 ≤ pct ≤ 100).

    Used here to avoid a hard numpy dependency for a basic stat. Empty input
    returns 0.0 (callers gate on sample_count first)."""
    if not samples:
        return 0.0
    s = sorted(samples)
    n = len(s)
    if n == 1:
        return float(s[0])
    rank = (pct / 100.0) * (n - 1)
    lo = int(rank)
    hi = min(lo + 1, n - 1)
    frac = rank - lo
    return float(s[lo] + (s[hi] - s[lo]) * frac)
