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


def simulate_position_states(
    labels: np.ndarray,
    *,
    horizon_bars: int = 24,
    notional_pct_per_position: float = 0.05,
    soft_cap: int = 3,
) -> tuple[list[dict], np.ndarray]:
    """For each bar i, return (state, effective_label) describing the
    simulated bot's behaviour if it had taken every directional signal
    subject to a soft per-side cap.

    Returns:
      states           — list[dict] of length n; each dict matches the
                          schema ``_encode_position_state`` consumes.
      effective_labels — np.ndarray[int64] of length n; labels[i] is set to
                          2 (NEUTRAL) when the simulation would have BLOCKED
                          the entry at bar i because the same-side count was
                          already at ``soft_cap``. Returned so the model is
                          trained against the labels that match the
                          position state it sees — without this the labels
                          say LONG and the features say "stacked", but the
                          model has no signal that those two relate.

    Simplifications (acceptable for Phase 2):
      * Every virtual position closes exactly ``horizon_bars`` after entry
        (no SL/TP simulation). Over-estimates hold time → model errs cautious.
      * Drawdown stays at 0 (equity tracking would need MFE/MAE re-simulation).
      * total_exposure_pct = n_open × notional_pct_per_position (proxy).
    """
    n = len(labels)
    effective = labels.copy().astype(np.int64)
    states: list[dict] = []
    last_entry = -1
    # Maintain rolling list of (entry_bar, side, exit_bar) — sweep forward.
    open_positions: list[tuple[int, int, int]] = []
    for i in range(n):
        # Evict positions that closed strictly before i.
        open_positions = [p for p in open_positions if p[2] >= i]
        n_long = sum(1 for p in open_positions if p[1] == 1)
        n_short = sum(1 for p in open_positions if p[1] == 0)
        n_open = n_long + n_short
        bars_since = (i - last_entry) if last_entry >= 0 else 999
        states.append({
            "n_open_long": n_long,
            "n_open_short": n_short,
            "total_exposure_pct": min(1.0, n_open * notional_pct_per_position),
            "drawdown_pct": 0.0,
            "bars_since_last_entry": bars_since,
        })

        # Entry decision for bar i — respect the soft cap. When blocked,
        # rewrite the effective label to NEUTRAL so the training signal is
        # "high exposure → output NEUTRAL".
        cls = int(effective[i])
        if cls == 1:
            if n_long >= soft_cap:
                effective[i] = 2
            else:
                open_positions.append((i, 1, min(n - 1, i + horizon_bars)))
                last_entry = i
        elif cls == 0:
            if n_short >= soft_cap:
                effective[i] = 2
            else:
                open_positions.append((i, 0, min(n - 1, i + horizon_bars)))
                last_entry = i
    return states, effective


def mfe_mae_regression_labels(
    bars: Sequence[dict],
    class_labels: np.ndarray,
    *,
    horizon_bars: int = 24,
) -> np.ndarray:
    """Per-bar regression targets for the StrategyDetectionNN regression head.

    For each bar ``i``, walks forward up to ``horizon_bars`` bars and computes
    MFE (max favourable excursion) and MAE (max adverse excursion) IN THE
    DIRECTION OF ``class_labels[i]`` (long / short / neutral). Returns shape
    ``(n, 3)`` of values in ``[0, 1]`` matching the sigmoid output range of
    the regression head:

      out[i, 0] = size_target     ← maps back to size_multiplier ∈ [0.5, 2.0]
      out[i, 1] = sl_atr_target   ← maps back to sl_atr_mult     ∈ [0.3, 4.0]
      out[i, 2] = tp_r_target     ← maps back to tp_r            ∈ [1.0, 3.0]

    Heuristic labels (derived from hindsight on the historical bars):

      sl_atr_mult = clamp(MAE_in_ATR × 1.2, 0.3, 4.0)
          — tight stop just beyond the worst dip we ever saw, with a 20%
            buffer so a trade that retests the exact MAE isn't immediately
            stopped out
      tp_r        = clamp(MFE / max(MAE, ε), 1.0, 3.0)
          — R-multiple = how many times the SL distance the move actually
            went in our favour
      size_mult   = 1.5 if MFE > 2 × MAE else 1.0 if MFE > MAE else 0.5
          — scale into clean setups, scale out of marginal ones

    Neutral bars (label=2) get conservative defaults: small SL, modest TP,
    minimum size. The MSE loss on these isn't strong because the
    classification head will route most NEUTRAL predictions to ignore them
    anyway, but they need *some* value to avoid the regression head
    overfitting on the directional samples.

    This is the function ``train_detection.train_detection`` calls to fill
    out the regression head's training targets — without it, the head's
    output is random weights at inference time and the daemon has to clamp
    them to mode bounds (see ``daemon_runtime.daemon_predict``)."""
    n = len(bars)
    out = np.zeros((n, 3), dtype=np.float32)
    if n == 0:
        return out
    # Neutral defaults
    out[:, 0] = (0.5 - 0.5) / 1.5  # size_mult = 0.5 (minimum)
    out[:, 1] = (1.0 - 0.3) / 3.7  # sl_atr_mult = 1.0  (mid-range; safe default)
    out[:, 2] = (1.5 - 1.0) / 2.0  # tp_r        = 1.5  (1.5 R; modest TP)

    for i in range(n - 1):
        cls = int(class_labels[i]) if i < len(class_labels) else 2
        if cls == 2:
            continue  # leave defaults
        close_i = float(bars[i].get("close") or 0.0)
        if close_i <= 0:
            continue
        atr = _atr_proxy(bars, i)
        if atr <= 0:
            continue
        end = min(n - 1, i + horizon_bars)
        mfe = 0.0  # max favourable in the direction of cls
        mae = 0.0  # max adverse
        for j in range(i + 1, end + 1):
            hi = float(bars[j].get("high") or bars[j].get("close") or close_i)
            lo = float(bars[j].get("low") or bars[j].get("close") or close_i)
            if cls == 1:  # long
                mfe = max(mfe, hi - close_i)
                mae = max(mae, close_i - lo)
            else:  # short (cls == 0)
                mfe = max(mfe, close_i - lo)
                mae = max(mae, hi - close_i)
        sl_atr = max(0.3, min(4.0, (mae / atr) * 1.2))
        r_mult = max(1.0, min(3.0, mfe / max(mae, 1e-9)))
        size = 1.5 if mfe > 2 * mae else (1.0 if mfe > mae else 0.5)
        out[i, 0] = max(0.0, min(1.0, (size - 0.5) / 1.5))
        out[i, 1] = max(0.0, min(1.0, (sl_atr - 0.3) / 3.7))
        out[i, 2] = max(0.0, min(1.0, (r_mult - 1.0) / 2.0))
    return out


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
    """Convenience: fraction of each class for log summaries.

    Auto-detects whether the input uses the 3-class triple-barrier scheme
    ({0,1,2}) or the Stage 2B 4-class scheme ({0,1,2,3} with FAKEOUT_REVERSAL).
    Keys for the 3-class path stay backward-compatible.
    """
    if labels.size == 0:
        return {"short": 0.0, "long": 0.0, "neutral": 0.0}
    max_label = int(labels.max())
    total = float(labels.size)
    if max_label >= 3:
        return {
            "long": float((labels == LABEL_LONG).sum()) / total,
            "short": float((labels == LABEL_SHORT).sum()) / total,
            "neutral": float((labels == LABEL_NEUTRAL).sum()) / total,
            "fakeout_reversal": float((labels == LABEL_FAKEOUT_REVERSAL).sum()) / total,
        }
    return {
        "short": float((labels == 0).sum()) / total,
        "long": float((labels == 1).sum()) / total,
        "neutral": float((labels == 2).sum()) / total,
    }


# ── Stage 2B: 4-class bidirectional labels ───────────────────────────────
#
# Spec phase 7: NN head becomes a 4-class softmax.
#   0 = LONG
#   1 = SHORT
#   2 = NEUTRAL
#   3 = FAKEOUT_REVERSAL
# These are *event* labels emitted by the context layer, distinct from the
# strategy-side ``pa-fakeout`` ID. Existing 3-class triple_barrier_labels
# stays in place for backward compatibility with V1/V2 detection models.

LABEL_LONG = 0
LABEL_SHORT = 1
LABEL_NEUTRAL = 2
LABEL_FAKEOUT_REVERSAL = 3
NUM_BIDIRECTIONAL_CLASSES = 4


def bidirectional_labels(context_rows: Sequence) -> np.ndarray:
    """Convert ``context_layer.ContextLayerRow`` objects to a class-index
    array in {0,1,2,3}. Robust to both real ContextLayerRow instances and
    simple dicts so unit tests can pass dicts.

    The mapping is: FAKEOUT_REVERSAL > LONG > SHORT > NEUTRAL — first hit
    wins so the rare events aren't masked by a co-fired NEUTRAL flag.
    """
    out = np.full(len(context_rows), LABEL_NEUTRAL, dtype=np.int64)
    for i, row in enumerate(context_rows):
        labels = getattr(row, "labels", None) or row.get("labels", {})
        if float(labels.get("FAKEOUT_REVERSAL", 0.0)) > 0.0:
            out[i] = LABEL_FAKEOUT_REVERSAL
        elif float(labels.get("LONG", 0.0)) > 0.0:
            out[i] = LABEL_LONG
        elif float(labels.get("SHORT", 0.0)) > 0.0:
            out[i] = LABEL_SHORT
        else:
            out[i] = LABEL_NEUTRAL
    return out
