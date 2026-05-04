"""Bidirectional analysis (spec phase 5).

For each trade entry T we build:

* a **lookback** feature vector from data ≤ T (the model-side context),
* a **look-forward** label vector from data > T (the outcome the model
  is being asked to predict).

Calls ``lookahead_validator.assert_clean(...)`` before returning so any
accidental leak (a feature derived from a bar at t > T) aborts the build
loudly.

Lookback features intentionally reuse the rolling stats vocabulary used
elsewhere in the codebase (returns / volatility / momentum / rsi-style
counts) without importing the heavyweight feature builders — a tight
inline loop keeps the data-flow auditable and the validator's
column-by-column timestamp matrix tractable.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np

from .lookahead_validator import assert_clean


# Public column order — frozen so the context layer can join by name.
LOOKBACK_FEATURES = (
    "ret_mean",
    "ret_std",
    "ret_skew",
    "vol_mean",
    "range_mean",
    "wick_up_mean",
    "wick_dn_mean",
    "rsi_proxy",
)


LABEL_COLUMNS = (
    "fwd_ret_h1",
    "fwd_ret_h5",
    "fwd_max_excursion",
    "fwd_min_excursion",
    "outcome_class",  # 0=LONG, 1=SHORT, 2=NEUTRAL, 3=FAKEOUT_REVERSAL (heuristic)
)


@dataclass(frozen=True)
class BidirectionalRow:
    """One trade-entry row. ``feature_t`` is the timestamp the lookback
    feature uses (== entry bar's time, so feature_t == row_t)."""
    trade_id: str
    row_t: float
    entry_price: float
    side: str
    lookback: dict
    lookback_feature_t: float
    labels: dict
    look_forward_t_min: float


def _safe(x: float, default: float = 0.0) -> float:
    if x is None or not np.isfinite(x):
        return default
    return float(x)


def _lookback_features(bars: Sequence[dict], end_idx: int, window: int) -> tuple[dict, float]:
    """Compute the 8 lookback features over ``bars[end_idx-window:end_idx+1]``.

    Returns ``(features, max_t)`` where ``max_t`` is the maximum bar
    timestamp the features touch (= bars[end_idx]['time']). The validator
    will check ``max_t <= row_t``.
    """
    start = max(0, end_idx - window + 1)
    win = bars[start : end_idx + 1]
    if len(win) < 2:
        zeros = {k: 0.0 for k in LOOKBACK_FEATURES}
        return zeros, float(bars[end_idx].get("time") or 0.0)
    closes = np.array([float(b.get("close") or 0.0) for b in win], dtype=float)
    highs = np.array([float(b.get("high") or 0.0) for b in win], dtype=float)
    lows = np.array([float(b.get("low") or 0.0) for b in win], dtype=float)
    opens = np.array([float(b.get("open") or 0.0) for b in win], dtype=float)
    vols = np.array([float(b.get("volume") or 0.0) for b in win], dtype=float)
    rets = np.diff(closes) / np.maximum(closes[:-1], 1e-12)
    body = closes - opens
    wick_up = highs - np.maximum(closes, opens)
    wick_dn = np.minimum(closes, opens) - lows
    # RSI proxy: fraction of up-bars in the window. Cheap, monotonic in the
    # real RSI for the windows the NN cares about.
    rsi_proxy = float(np.mean(rets > 0)) if len(rets) > 0 else 0.5
    feats = {
        "ret_mean": _safe(float(np.mean(rets))),
        "ret_std": _safe(float(np.std(rets))),
        "ret_skew": _safe(float(_skew(rets))) if len(rets) > 2 else 0.0,
        "vol_mean": _safe(float(np.mean(vols))),
        "range_mean": _safe(float(np.mean(highs - lows))),
        "wick_up_mean": _safe(float(np.mean(wick_up))),
        "wick_dn_mean": _safe(float(np.mean(wick_dn))),
        "rsi_proxy": rsi_proxy,
    }
    max_t = float(win[-1].get("time") or 0.0)
    return feats, max_t


def _skew(arr: np.ndarray) -> float:
    """Sample skew. scipy-free; matches scipy.stats.skew bias=False shape closely
    enough for a feature signal."""
    if len(arr) < 3:
        return 0.0
    m = float(np.mean(arr))
    s = float(np.std(arr))
    if s <= 1e-12:
        return 0.0
    return float(np.mean(((arr - m) / s) ** 3))


def _look_forward(bars: Sequence[dict], entry_idx: int, lookahead: int, side: str) -> tuple[dict, float]:
    """Look-forward label vector. Times here are strictly > entry's time, so
    the validator will pass when ``row_t == bars[entry_idx]['time']`` and
    these labels live in a separate matrix."""
    n = len(bars)
    end = min(n - 1, entry_idx + lookahead)
    if end <= entry_idx:
        return {k: 0.0 for k in LABEL_COLUMNS}, float(bars[entry_idx].get("time") or 0.0)
    entry_close = float(bars[entry_idx].get("close") or 0.0)
    closes = np.array([float(bars[j].get("close") or 0.0) for j in range(entry_idx + 1, end + 1)])
    highs = np.array([float(bars[j].get("high") or 0.0) for j in range(entry_idx + 1, end + 1)])
    lows = np.array([float(bars[j].get("low") or 0.0) for j in range(entry_idx + 1, end + 1)])
    h1 = closes[0] - entry_close if len(closes) > 0 else 0.0
    h5 = closes[min(4, len(closes) - 1)] - entry_close if len(closes) > 0 else 0.0
    max_excursion = float(np.max(highs)) - entry_close if len(highs) > 0 else 0.0
    min_excursion = float(np.min(lows)) - entry_close if len(lows) > 0 else 0.0
    # Heuristic 4-class outcome:
    #   - LONG when forward h5 return > 0.1× range_mean and the max excursion is high.
    #   - SHORT mirrored.
    #   - FAKEOUT_REVERSAL when the trade direction's favourable side hit at
    #     least 0.5× max_excursion before the close reverses.
    #   - NEUTRAL otherwise.
    side_up = side.upper()
    favorable = max_excursion if side_up == "LONG" else -min_excursion
    adverse = -min_excursion if side_up == "LONG" else max_excursion
    final_in_favor = h5 if side_up == "LONG" else -h5
    outcome = 2  # NEUTRAL
    if final_in_favor > 0 and favorable > 0:
        outcome = 0 if side_up == "LONG" else 1
    elif favorable > 2 * abs(final_in_favor) and adverse > favorable:
        outcome = 3  # FAKEOUT_REVERSAL — favourable side touched, then reversed.
    next_t = float(bars[entry_idx + 1].get("time") or 0.0)
    return (
        {
            "fwd_ret_h1": _safe(float(h1)),
            "fwd_ret_h5": _safe(float(h5)),
            "fwd_max_excursion": _safe(float(max_excursion)),
            "fwd_min_excursion": _safe(float(min_excursion)),
            "outcome_class": float(outcome),
        },
        next_t,
    )


def _bar_index_at_or_before(bars: Sequence[dict], t: float) -> int:
    """Last bar whose time ≤ t. Returns -1 when no bar qualifies."""
    best = -1
    for i, b in enumerate(bars):
        bt = float(b.get("time") or 0.0)
        if bt <= t:
            best = i
        else:
            break
    return best


def build_bidirectional(
    trades: Sequence[dict],
    bars: Sequence[dict],
    *,
    lookback_bars: int = 64,
    lookahead_bars: int = 32,
) -> list[BidirectionalRow]:
    """Build one row per trade entry; runs the lookahead validator before
    returning."""
    rows: list[BidirectionalRow] = []
    if not trades or not bars:
        return rows
    # Sort bars by time once.
    sorted_bars = sorted(bars, key=lambda b: float(b.get("time") or 0.0))
    feature_matrix: list[list[float]] = []
    feature_ts: list[list[float]] = []
    row_ts: list[float] = []
    for t in trades:
        try:
            tid = str(t["trade_id"])
            side = str(t["side"]).upper()
            entry_t = float(t["entry_time"])
            entry_p = float(t["entry_price"])
        except (KeyError, TypeError, ValueError):
            continue
        idx = _bar_index_at_or_before(sorted_bars, entry_t)
        if idx < 0:
            continue
        lb_feats, lb_max_t = _lookback_features(sorted_bars, idx, lookback_bars)
        labels, lf_min_t = _look_forward(sorted_bars, idx, lookahead_bars, side)
        rows.append(
            BidirectionalRow(
                trade_id=tid,
                row_t=entry_t,
                entry_price=entry_p,
                side=side,
                lookback=lb_feats,
                lookback_feature_t=lb_max_t,
                labels=labels,
                look_forward_t_min=lf_min_t,
            )
        )
        feature_matrix.append([lb_feats[k] for k in LOOKBACK_FEATURES])
        # Every column in this row was derived from data ≤ lb_max_t (the
        # entry bar's time). We tag each column with the same max_t so the
        # validator checks the worst-case timestamp per column.
        feature_ts.append([lb_max_t for _ in LOOKBACK_FEATURES])
        row_ts.append(entry_t)
    # Mandatory leak check.
    assert_clean(
        feature_matrix=feature_matrix,
        feature_timestamps=feature_ts,
        row_timestamps=row_ts,
        feature_columns=list(LOOKBACK_FEATURES),
        label_columns=list(LABEL_COLUMNS),
    )
    return rows
