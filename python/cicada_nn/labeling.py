"""
Forward-looking trade labeling for CICADA-5453.

The old training used targets derived from the same features fed to the network
(a trivial identity leak). This module generates **honest** labels from what the
market actually did after each bar — the standard ML-for-trading approach from
López de Prado (Ch. 3, Advances in Financial Machine Learning).

Three label flavours are exported:

* ``triple_barrier_labels``: for each bar, walk forward until an upper (TP) or
  lower (SL) barrier is hit, or a time barrier expires. Label ∈ {0=short, 1=long,
  2=neutral} (neutral = time-barrier exit with |return| below the meta threshold).
* ``forward_return_labels``: signed-return bucketing over a fixed horizon.
* ``sample_weights``: uniqueness weighting so overlapping look-ahead windows do
  not dominate the loss surface.

All functions are deterministic and pure; they accept a simple list-of-dicts bar
series (``open``, ``high``, ``low``, ``close``, optional ``time``) to stay
interoperable with the rest of the backend.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np


@dataclass(frozen=True)
class TripleBarrierConfig:
    """Barrier definition for triple-barrier labeling.

    The TP and SL barriers are expressed as multiples of a volatility measure
    (``atr`` / ``close``). ``horizon_bars`` is the vertical (time) barrier.
    """

    tp_mult: float = 2.0
    sl_mult: float = 1.0
    horizon_bars: int = 20
    min_event_return: float = 0.0005  # below this → neutral label

    def __post_init__(self) -> None:
        if self.tp_mult <= 0 or self.sl_mult <= 0:
            raise ValueError("tp_mult and sl_mult must be positive")
        if self.horizon_bars < 1:
            raise ValueError("horizon_bars must be >= 1")


def _atr_proxy(bars: Sequence[dict], i: int, lookback: int = 14) -> float:
    """Simple ATR proxy over the last ``lookback`` bars ending at i (inclusive).

    Uses true-range sum / n. Falls back to ``0.002 * close`` (20 bps) if the
    window is short or the close is invalid — keeps the labeler robust for any
    series length.
    """
    close_i = float(bars[i].get("close") or 0.0)
    if close_i <= 0:
        return 0.0
    start = max(0, i - lookback + 1)
    trs: list[float] = []
    prev_close = float(bars[start].get("close") or close_i)
    for j in range(start, i + 1):
        h = float(bars[j].get("high") or bars[j].get("close") or close_i)
        lo = float(bars[j].get("low") or bars[j].get("close") or close_i)
        c_prev = prev_close
        tr = max(h - lo, abs(h - c_prev), abs(lo - c_prev))
        trs.append(tr)
        prev_close = float(bars[j].get("close") or c_prev)
    if not trs:
        return 0.002 * close_i
    atr = sum(trs) / len(trs)
    if atr <= 0 or not np.isfinite(atr):
        return 0.002 * close_i
    return atr


def triple_barrier_labels(
    bars: Sequence[dict],
    config: TripleBarrierConfig | None = None,
) -> np.ndarray:
    """Label every bar with {0=short, 1=long, 2=neutral}.

    For each bar ``i`` we set an upper barrier ``close[i] + tp_mult*atr`` and
    lower barrier ``close[i] - sl_mult*atr``. We then walk forward up to
    ``horizon_bars`` bars and check whether the subsequent **high** crosses the
    upper barrier or the **low** crosses the lower barrier first (using intrabar
    extremes, which is more realistic than close-only checks). Ties (both
    crossed on the same bar) are resolved by proximity to the open.
    """
    cfg = config or TripleBarrierConfig()
    n = len(bars)
    labels = np.full(n, 2, dtype=np.int64)  # default neutral
    if n < 2:
        return labels

    for i in range(n - 1):
        close_i = float(bars[i].get("close") or 0.0)
        if close_i <= 0:
            continue
        atr = _atr_proxy(bars, i)
        if atr <= 0:
            continue
        upper = close_i + cfg.tp_mult * atr
        lower = close_i - cfg.sl_mult * atr
        end = min(n - 1, i + cfg.horizon_bars)
        hit_long = False
        hit_short = False
        for j in range(i + 1, end + 1):
            h = float(bars[j].get("high") or bars[j].get("close") or 0.0)
            lo = float(bars[j].get("low") or bars[j].get("close") or 0.0)
            up_hit = h >= upper
            dn_hit = lo <= lower
            if up_hit and dn_hit:
                # Pessimistic tie-break: whichever barrier is farther from the
                # open is assumed to be hit last. This avoids a systematic bias
                # towards the more-profitable side on high-ATR bars.
                o = float(bars[j].get("open") or close_i)
                hit_long = abs(o - lower) > abs(o - upper)
                hit_short = not hit_long
                break
            if up_hit:
                hit_long = True
                break
            if dn_hit:
                hit_short = True
                break
        if hit_long:
            labels[i] = 1
        elif hit_short:
            labels[i] = 0
        else:
            # Time-barrier exit: keep neutral unless the close move is large.
            c_end = float(bars[end].get("close") or close_i)
            ret = (c_end - close_i) / close_i if close_i else 0.0
            if abs(ret) >= cfg.min_event_return:
                labels[i] = 1 if ret > 0 else 0
            else:
                labels[i] = 2
    return labels


def forward_return_labels(
    bars: Sequence[dict],
    horizon_bars: int = 10,
    neutral_threshold: float = 0.0005,
) -> np.ndarray:
    """Label = sign of forward return over ``horizon_bars``.

    Simpler than triple-barrier but useful as an auxiliary signal.
    """
    n = len(bars)
    labels = np.full(n, 2, dtype=np.int64)
    for i in range(n - horizon_bars):
        c0 = float(bars[i].get("close") or 0.0)
        c1 = float(bars[i + horizon_bars].get("close") or 0.0)
        if c0 <= 0 or c1 <= 0:
            continue
        ret = (c1 - c0) / c0
        if ret > neutral_threshold:
            labels[i] = 1
        elif ret < -neutral_threshold:
            labels[i] = 0
        else:
            labels[i] = 2
    return labels


def uniqueness_weights(
    n_samples: int,
    horizon_bars: int,
) -> np.ndarray:
    """Per-sample weights ≈ 1 / avg overlap with other samples.

    When every label look-ahead window is ``horizon_bars``, consecutive samples
    share most of their outcome window. López de Prado's uniqueness approach
    downweights those samples so the loss surface does not over-weight runs of
    correlated labels. Implementation: concurrent-event count for each bar
    (inverse of how many labels cover it), averaged over each sample's window.
    """
    if n_samples <= 0:
        return np.zeros(0, dtype=np.float32)
    concurrent = np.zeros(n_samples + horizon_bars, dtype=np.float32)
    for i in range(n_samples):
        concurrent[i : min(i + horizon_bars, len(concurrent))] += 1.0
    weights = np.zeros(n_samples, dtype=np.float32)
    for i in range(n_samples):
        end = min(i + horizon_bars, len(concurrent))
        win = concurrent[i:end]
        avg = float(win.mean()) if len(win) else 1.0
        weights[i] = 1.0 / max(1.0, avg)
    # Re-normalise so mean weight = 1 (keeps the effective sample size similar).
    mean_w = float(weights.mean()) or 1.0
    return weights / mean_w


def label_distribution(labels: np.ndarray) -> dict[str, float]:
    """Convenience: fraction of each class for log summaries."""
    if labels.size == 0:
        return {"short": 0.0, "long": 0.0, "neutral": 0.0}
    total = float(labels.size)
    return {
        "short": float((labels == 0).sum()) / total,
        "long": float((labels == 1).sum()) / total,
        "neutral": float((labels == 2).sum()) / total,
    }
