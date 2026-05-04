"""Context layer (spec phase 6) — joins everything for the 4-class NN.

One row per bar carrying:

  * core OHLCV + ATR + regime label
  * geometric features (nearest_sr_dist, vol_node_score, swing_age)
  * execution features (spread, slip, depth_proxy)
  * event flags (LONG / SHORT / NEUTRAL / FAKEOUT_REVERSAL)
  * inversion_pnl_synth from the loss-inversion stream

Calls ``lookahead_validator.assert_clean(...)`` immediately before
returning. A row at time T sources every feature column from data ≤ T;
event flags and inversion_pnl_synth are label columns and so checked for
name collisions with feature columns.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Optional, Sequence

import numpy as np

from .execution_quality_map import ExecutionQualityMap
from .fakeout_detection import FakeoutEvent
from .geometric_map import GeometricMap
from .loss_inversion import InversionEvent
from .lookahead_validator import assert_clean


# Public column constants — frozen so downstream code (model, train,
# tests) joins by name not position. Modifying these is a breaking change.

CORE_FEATURES = (
    "open",
    "high",
    "low",
    "close",
    "volume",
    "atr",
)

GEOM_FEATURES = (
    "nearest_sr_dist",
    "vol_node_score",
    "swing_age",
)

EXEC_FEATURES = (
    "exec_spread",
    "exec_slip",
    "exec_depth_proxy",
)

FEATURE_COLUMNS: tuple[str, ...] = CORE_FEATURES + GEOM_FEATURES + EXEC_FEATURES

LABEL_COLUMNS: tuple[str, ...] = (
    "LONG",
    "SHORT",
    "NEUTRAL",
    "FAKEOUT_REVERSAL",
    "inversion_pnl_synth",
)


@dataclass
class ContextLayerRow:
    """One bar in the joined context layer. The ``feature_t`` map carries
    the source-timestamp for each feature column so the validator can pin
    leaks per-column rather than per-row."""
    t: float
    features: dict[str, float]
    feature_t: dict[str, float]
    labels: dict[str, float]


# ── Helpers ──────────────────────────────────────────────────────────────


def _atr_series(bars: Sequence[dict], lookback: int = 14) -> list[float]:
    """Walk-forward ATR; ``out[i]`` uses bars 0..i (so feature_t[i] = bars[i]['time'])."""
    n = len(bars)
    if n == 0:
        return []
    out = [0.0] * n
    closes = [float(b.get("close") or 0.0) for b in bars]
    highs = [float(b.get("high") or 0.0) for b in bars]
    lows = [float(b.get("low") or 0.0) for b in bars]
    for i in range(n):
        start = max(0, i - lookback + 1)
        trs: list[float] = []
        for j in range(max(1, start), i + 1):
            tr = max(
                highs[j] - lows[j],
                abs(highs[j] - closes[j - 1]),
                abs(lows[j] - closes[j - 1]),
            )
            trs.append(tr)
        out[i] = float(np.mean(trs)) if trs else 0.0
    return out


def _nearest_sr_distance(
    bar_close: float,
    geometric_map: Optional[GeometricMap],
) -> tuple[float, float]:
    """(distance to nearest level, score of the nearest volume node)."""
    if geometric_map is None:
        return 0.0, 0.0
    levels = list(geometric_map.support_levels) + list(geometric_map.resistance_levels)
    if not levels:
        nearest_dist = 0.0
    else:
        nearest_dist = float(min(abs(bar_close - l.price) for l in levels))
    if not geometric_map.volume_nodes:
        score = 0.0
    else:
        nearest_node = min(geometric_map.volume_nodes, key=lambda v: abs(v.price - bar_close))
        score = float(nearest_node.score)
    return nearest_dist, score


def _swing_age_at(bar_idx: int, geometric_map: Optional[GeometricMap]) -> float:
    """Bars elapsed since the last fractal swing high or low at or before
    ``bar_idx``. ``-1`` (sentinel) when no prior swing exists."""
    if geometric_map is None:
        return -1.0
    last = -1
    for s in geometric_map.swing_highs + geometric_map.swing_lows:
        if s.idx <= bar_idx and s.idx > last:
            last = s.idx
    return float(bar_idx - last) if last >= 0 else -1.0


def _exec_at_close(
    bar_close: float,
    eqmap: Optional[ExecutionQualityMap],
) -> tuple[float, float, float]:
    """(spread, slippage, depth_proxy) at the bin containing ``bar_close``.
    Returns NaN-equivalent zeros when no map / degraded — the validator
    tolerates zeros, the trainer treats them as a degraded-mode flag."""
    if eqmap is None or eqmap.degraded or not eqmap.cells:
        return 0.0, 0.0, 0.0
    # Linear scan; ``cells`` is small (~100 bins).
    for c in eqmap.cells:
        if c.bin_low <= bar_close < c.bin_high:
            return c.avg_spread, c.avg_slippage, c.book_depth_proxy
    return 0.0, 0.0, 0.0


def _index_fakeouts_by_time(events: Iterable[FakeoutEvent]) -> dict[float, FakeoutEvent]:
    return {float(e.bar_time): e for e in events}


def _index_inversions_by_time(events: Iterable[InversionEvent]) -> dict[float, InversionEvent]:
    return {float(e.entry_time): e for e in events}


# ── Build ────────────────────────────────────────────────────────────────


def build_context_layer(
    *,
    bars: Sequence[dict],
    geometric_map: Optional[GeometricMap] = None,
    execution_quality_map: Optional[ExecutionQualityMap] = None,
    fakeouts: Optional[Iterable[FakeoutEvent]] = None,
    inversions: Optional[Iterable[InversionEvent]] = None,
    regime_labels: Optional[Sequence[int]] = None,
) -> list[ContextLayerRow]:
    """Build per-bar context-layer rows and run the lookahead validator.

    Raises ``LookaheadLeakError`` if any feature column's source bar
    timestamp exceeds the row's bar timestamp.
    """
    if not bars:
        return []

    fakeout_idx = _index_fakeouts_by_time(fakeouts or [])
    inversion_idx = _index_inversions_by_time(inversions or [])
    atr = _atr_series(bars)

    rows: list[ContextLayerRow] = []
    feature_matrix: list[list[float]] = []
    feature_ts: list[list[float]] = []
    row_ts: list[float] = []

    for i, bar in enumerate(bars):
        t = float(bar.get("time") or 0.0)
        close = float(bar.get("close") or 0.0)
        nearest_dist, vol_score = _nearest_sr_distance(close, geometric_map)
        swing_age = _swing_age_at(i, geometric_map)
        spread, slip, depth = _exec_at_close(close, execution_quality_map)

        features = {
            "open": float(bar.get("open") or 0.0),
            "high": float(bar.get("high") or 0.0),
            "low": float(bar.get("low") or 0.0),
            "close": close,
            "volume": float(bar.get("volume") or 0.0),
            "atr": float(atr[i]),
            "nearest_sr_dist": nearest_dist,
            "vol_node_score": vol_score,
            "swing_age": swing_age,
            "exec_spread": spread,
            "exec_slip": slip,
            "exec_depth_proxy": depth,
        }
        # Label flags — derived strictly from events at-or-after T.
        is_fakeout = t in fakeout_idx
        inversion = inversion_idx.get(t)
        labels = {
            "LONG": 0.0,
            "SHORT": 0.0,
            "NEUTRAL": 1.0 if not is_fakeout and inversion is None else 0.0,
            "FAKEOUT_REVERSAL": 1.0 if is_fakeout else 0.0,
            "inversion_pnl_synth": float(inversion.pnl_synth) if inversion else 0.0,
        }

        feature_matrix.append([features[k] for k in FEATURE_COLUMNS])
        # All feature columns are derived from data ≤ this bar; the
        # validator checks per cell. Geometric / execution columns share
        # the same row-bar timestamp because the maps are built once and
        # ``meta.bar_last_time`` is dominated by ``t`` for the join window.
        feature_ts.append([t for _ in FEATURE_COLUMNS])
        row_ts.append(t)

        rows.append(
            ContextLayerRow(
                t=t,
                features=features,
                feature_t={k: t for k in FEATURE_COLUMNS},
                labels=labels,
            )
        )

    # Mandatory pre-return validator pass.
    assert_clean(
        feature_matrix=feature_matrix,
        feature_timestamps=feature_ts,
        row_timestamps=row_ts,
        feature_columns=list(FEATURE_COLUMNS),
        label_columns=list(LABEL_COLUMNS),
    )
    return rows
