"""Fakeout detection as event class (spec phase 5b).

Per the architectural review §11, this is *distinct* from the existing
``pa-fakeout`` strategy ID — that one fires a -1/0/+1 trading signal at
runtime; this module produces a separate ``FAKEOUT`` event row that the
context layer joins as a label-stream input. Same word, two layers; the
naming carry-over is documented so a future contributor doesn't collapse
the concepts.

Spec rules (lines 150-194 of the original spec text — the brief paraphrases
them):

    A bar i is part of a FAKEOUT around an S/R level L when:
      1. Breach magnitude is < 1.5 × ATR
      2. Time spent beyond L is ≤ 3 bars
      3. Volume contraction OR a wick rejection on the breaching bar
      4. High return-velocity on the reversal bar

Rows always carry ``event_type="FAKEOUT"`` — never ``"LOSS"``. The
strategy-side ``pa-fakeout`` continues to fire its own signal in
``signals.py`` and is unchanged.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Iterable, Sequence

import numpy as np

from .geometric_map import GeometricMap


@dataclass(frozen=True)
class FakeoutEvent:
    """One detected fakeout. Closed schema — context layer joins by name."""
    bar_idx: int
    bar_time: float
    level_price: float
    level_kind: str  # "support" / "resistance"
    breach_magnitude: float
    time_beyond_bars: int
    volume_contraction: bool
    wick_rejection: bool
    reversal_velocity: float
    event_type: str = "FAKEOUT"

    def to_dict(self) -> dict:
        return asdict(self)


# ── Helpers ──────────────────────────────────────────────────────────────


def _atr_window(bars: Sequence[dict], end_idx: int, window: int) -> float:
    """ATR-style true range mean over the window ending at end_idx."""
    if end_idx < 1:
        return 0.0
    start = max(1, end_idx - window + 1)
    trs: list[float] = []
    for j in range(start, end_idx + 1):
        h = float(bars[j].get("high") or 0.0)
        lo = float(bars[j].get("low") or 0.0)
        c_prev = float(bars[j - 1].get("close") or 0.0)
        trs.append(max(h - lo, abs(h - c_prev), abs(lo - c_prev)))
    if not trs:
        return 0.0
    out = float(np.mean(trs))
    return out if np.isfinite(out) and out > 0 else 0.0


def _is_volume_contraction(bars: Sequence[dict], i: int, window: int = 10) -> bool:
    """Bar i's volume < 0.7 × rolling-mean volume of the previous window."""
    if i < window:
        return False
    prev = np.array([float(bars[j].get("volume") or 0.0) for j in range(i - window, i)])
    if prev.size == 0:
        return False
    mean = float(np.mean(prev))
    if mean <= 0:
        return False
    return float(bars[i].get("volume") or 0.0) < 0.7 * mean


def _has_wick_rejection(bar: dict, side: str) -> bool:
    """Wick rejection means the breaching tail is at least 50% of the bar's
    range. ``side="up"`` checks an upper-wick rejection (price spiked above
    a resistance and closed back); ``side="down"`` mirrors."""
    o = float(bar.get("open") or 0.0)
    c = float(bar.get("close") or 0.0)
    h = float(bar.get("high") or 0.0)
    l = float(bar.get("low") or 0.0)
    rng = h - l
    if rng <= 0:
        return False
    body_top = max(o, c)
    body_bot = min(o, c)
    if side == "up":
        wick = h - body_top
    else:
        wick = body_bot - l
    return wick / rng >= 0.5


def _reversal_velocity(bars: Sequence[dict], i: int) -> float:
    """|close_i - close_{i-1}| / max(true_range_{i-1}, eps). Higher means
    a sharper reversal bar."""
    if i < 1:
        return 0.0
    prev = bars[i - 1]
    cur = bars[i]
    move = abs(float(cur.get("close") or 0.0) - float(prev.get("close") or 0.0))
    rng = max(
        float(prev.get("high") or 0.0) - float(prev.get("low") or 0.0),
        1e-12,
    )
    return move / rng


def _levels(geometric_map: GeometricMap) -> list[tuple[float, str]]:
    """Flat list of (price, kind) used for breach checks."""
    out: list[tuple[float, str]] = []
    for s in geometric_map.support_levels:
        out.append((s.price, "support"))
    for r in geometric_map.resistance_levels:
        out.append((r.price, "resistance"))
    return out


def _breach_magnitude(bar: dict, level_price: float, kind: str) -> float:
    """Distance the bar pushed past the level. Always non-negative; zero
    means the bar didn't breach."""
    h = float(bar.get("high") or 0.0)
    lo = float(bar.get("low") or 0.0)
    if kind == "resistance":
        return max(0.0, h - level_price)
    return max(0.0, level_price - lo)


def _time_beyond(bars: Sequence[dict], start_idx: int, level_price: float, kind: str, max_bars: int) -> int:
    """Number of consecutive bars (starting at start_idx) where the bar
    extreme remains beyond the level. Capped at max_bars+1 so the rule's
    upper bound is testable."""
    n = len(bars)
    count = 0
    for j in range(start_idx, min(n, start_idx + max_bars + 1)):
        bar = bars[j]
        if kind == "resistance":
            beyond = float(bar.get("high") or 0.0) > level_price
        else:
            beyond = float(bar.get("low") or 0.0) < level_price
        if beyond:
            count += 1
        else:
            break
    return count


# ── Main detector ────────────────────────────────────────────────────────


def detect_fakeouts(
    bars: Sequence[dict],
    geometric_map: GeometricMap,
    *,
    atr_window: int = 14,
    breach_atr_mult: float = 1.5,
    max_time_beyond_bars: int = 3,
    velocity_threshold: float = 0.5,
) -> list[FakeoutEvent]:
    """Return one FakeoutEvent per (bar, level) pair that satisfies all four
    rules. ``event_type`` is always ``"FAKEOUT"`` — never ``"LOSS"``."""
    if not bars or geometric_map is None:
        return []
    levels = _levels(geometric_map)
    if not levels:
        return []
    events: list[FakeoutEvent] = []
    for i in range(1, len(bars) - 1):
        atr = _atr_window(bars, i, atr_window)
        if atr <= 0:
            continue
        for price, kind in levels:
            mag = _breach_magnitude(bars[i], price, kind)
            if mag <= 0:
                continue
            if mag >= breach_atr_mult * atr:
                continue  # too large — this is a real breakout, not a fakeout
            time_beyond = _time_beyond(bars, i, price, kind, max_time_beyond_bars)
            if time_beyond == 0 or time_beyond > max_time_beyond_bars:
                continue
            wick_side = "up" if kind == "resistance" else "down"
            wick = _has_wick_rejection(bars[i], wick_side)
            vol_contract = _is_volume_contraction(bars, i)
            if not (wick or vol_contract):
                continue
            # Reversal-velocity check on the *next* bar — the fakeout's
            # signature is a sharp reversal after the failed breach.
            velocity = _reversal_velocity(bars, i + 1)
            if velocity < velocity_threshold:
                continue
            events.append(
                FakeoutEvent(
                    bar_idx=i,
                    bar_time=float(bars[i].get("time") or 0.0),
                    level_price=float(price),
                    level_kind=kind,
                    breach_magnitude=float(mag),
                    time_beyond_bars=int(time_beyond),
                    volume_contraction=bool(vol_contract),
                    wick_rejection=bool(wick),
                    reversal_velocity=float(velocity),
                )
            )
    return events
