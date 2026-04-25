"""
Scale-invariant bar-window features for the detection NN.

The old ``bars_to_features`` normalised OHLC by ``slice_bars[0].close`` — the
resulting distribution still shifts with the absolute price level because a
price that has moved 10% within the window yields a different ratio range than
one that has moved 1%. That is a clean source of train-serve skew whenever the
live window's price level differs from the training window's.

This module uses log returns and range-relative statistics instead. Output is
bounded and distribution-stable across instruments and price regimes:

* Per-bar log return:       ln(close_t / close_{t-1})
* Per-bar high range:       (high_t - close_{t-1}) / close_{t-1}
* Per-bar low range:        (low_t  - close_{t-1}) / close_{t-1}
* Per-bar body fraction:    (close_t - open_t) / (high_t - low_t + eps)

plus optional context features (RSI, ATR/price, Bollinger %b, trend slope).

All features are winsorised to ``[-clip, +clip]`` so a bad bar can't blow up
training.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np


PER_BAR_FEATURES = 4  # log-return, high-range, low-range, body fraction


@dataclass(frozen=True)
class BarFeatureConfig:
    window: int = 60
    clip: float = 0.2  # winsorise returns to ±20% per bar (tick instruments can move fast)
    include_context: bool = True  # adds 4 extra rolling-stat dims when True
    rsi_period: int = 14
    atr_period: int = 14


def _wilder_rsi(closes: np.ndarray, period: int) -> float | None:
    """Last RSI value on a 1-D close array using Wilder smoothing. ``None`` when
    the series is too short."""
    if len(closes) <= period:
        return None
    diffs = np.diff(closes)
    gains = np.clip(diffs, 0.0, None)
    losses = np.clip(-diffs, 0.0, None)
    avg_gain = float(gains[:period].mean())
    avg_loss = float(losses[:period].mean())
    for g, l in zip(gains[period:], losses[period:]):
        avg_gain = (avg_gain * (period - 1) + float(g)) / period
        avg_loss = (avg_loss * (period - 1) + float(l)) / period
    if avg_loss == 0.0:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def _last_atr_over_price(
    highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int
) -> float:
    """Tail ATR expressed as fraction of last close. Zero when window is short."""
    if len(closes) < 2:
        return 0.0
    trs = np.zeros_like(closes, dtype=np.float64)
    trs[0] = highs[0] - lows[0]
    for i in range(1, len(closes)):
        pc = closes[i - 1]
        trs[i] = max(highs[i] - lows[i], abs(highs[i] - pc), abs(lows[i] - pc))
    tail = trs[-period:] if len(trs) >= period else trs
    atr = float(tail.mean())
    c = float(closes[-1])
    if c <= 0 or not np.isfinite(atr):
        return 0.0
    return atr / c


def _last_bollinger_pctb(closes: np.ndarray, period: int = 20, k: float = 2.0) -> float:
    if len(closes) < period:
        return 0.5
    w = closes[-period:]
    mid = float(w.mean())
    sd = float(w.std(ddof=0))
    if sd <= 0:
        return 0.5
    upper = mid + k * sd
    lower = mid - k * sd
    c = float(closes[-1])
    denom = upper - lower
    if denom <= 0:
        return 0.5
    return float(np.clip((c - lower) / denom, 0.0, 1.0))


def _last_trend_slope(closes: np.ndarray, period: int = 20) -> float:
    """Slope of a linear fit over the last ``period`` closes, normalised by the
    last close. Returns 0 for short series.
    """
    if len(closes) < period or period < 2:
        return 0.0
    y = closes[-period:]
    x = np.arange(period, dtype=np.float64)
    denom = float((x * x).sum() * period - x.sum() ** 2)
    if denom == 0.0:
        return 0.0
    slope = (period * float((x * y).sum()) - float(x.sum()) * float(y.sum())) / denom
    c = float(closes[-1])
    if c <= 0 or not np.isfinite(slope):
        return 0.0
    return float(slope) / c


def feature_dim(config: BarFeatureConfig | None = None) -> int:
    cfg = config or BarFeatureConfig()
    base = cfg.window * PER_BAR_FEATURES
    return base + (4 if cfg.include_context else 0)


def window_features(
    bars: Sequence[dict],
    end_index: int,
    config: BarFeatureConfig | None = None,
) -> np.ndarray:
    """Return a stable, scale-invariant feature vector for bars[end-window+1:end+1]."""
    cfg = config or BarFeatureConfig()
    w = cfg.window
    start = max(0, end_index - w + 1)
    slice_bars = list(bars[start : end_index + 1])
    dim = feature_dim(cfg)
    out = np.zeros(dim, dtype=np.float32)
    if len(slice_bars) < 2:
        return out

    opens = np.array([float(b.get("open") or 0.0) for b in slice_bars], dtype=np.float64)
    highs = np.array([float(b.get("high") or 0.0) for b in slice_bars], dtype=np.float64)
    lows = np.array([float(b.get("low") or 0.0) for b in slice_bars], dtype=np.float64)
    closes = np.array([float(b.get("close") or 0.0) for b in slice_bars], dtype=np.float64)

    # Guard against zero / negative prices (junk ticks).
    safe_closes = np.where(closes > 0, closes, np.nan)
    prev = np.roll(safe_closes, 1)
    prev[0] = safe_closes[0] if len(safe_closes) else 1.0
    prev[~np.isfinite(prev)] = safe_closes[0] if len(safe_closes) else 1.0
    prev = np.where(prev > 0, prev, 1.0)

    log_ret = np.zeros_like(closes)
    with np.errstate(invalid="ignore", divide="ignore"):
        log_ret = np.log(np.where(safe_closes > 0, safe_closes, prev) / prev)
    log_ret = np.nan_to_num(log_ret, nan=0.0, posinf=cfg.clip, neginf=-cfg.clip)
    log_ret = np.clip(log_ret, -cfg.clip, cfg.clip)

    high_range = np.clip((highs - prev) / prev, -cfg.clip, cfg.clip)
    low_range = np.clip((lows - prev) / prev, -cfg.clip, cfg.clip)

    body = closes - opens
    rng = highs - lows
    with np.errstate(invalid="ignore", divide="ignore"):
        body_frac = np.where(rng > 0, body / rng, 0.0)
    body_frac = np.nan_to_num(body_frac, nan=0.0)
    body_frac = np.clip(body_frac, -1.0, 1.0)

    # Pack per-bar features (right-aligned; pad earlier bars with zeros).
    per_bar = np.stack([log_ret, high_range, low_range, body_frac], axis=1)  # (L, 4)
    if len(per_bar) < w:
        pad = np.zeros((w - len(per_bar), PER_BAR_FEATURES), dtype=np.float32)
        per_bar_full = np.concatenate([pad, per_bar.astype(np.float32)], axis=0)
    else:
        per_bar_full = per_bar[-w:].astype(np.float32)
    out[: w * PER_BAR_FEATURES] = per_bar_full.flatten()

    if cfg.include_context:
        rsi_val = _wilder_rsi(closes.astype(np.float32), cfg.rsi_period)
        rsi_norm = 0.0 if rsi_val is None else float(rsi_val - 50.0) / 50.0
        atr_pct = _last_atr_over_price(highs, lows, closes, cfg.atr_period)
        boll_pctb = _last_bollinger_pctb(closes) * 2.0 - 1.0  # centre around 0
        slope_norm = float(np.clip(_last_trend_slope(closes) * 1000.0, -1.0, 1.0))
        out[w * PER_BAR_FEATURES + 0] = rsi_norm
        out[w * PER_BAR_FEATURES + 1] = float(np.clip(atr_pct * 50.0, 0.0, 1.0))
        out[w * PER_BAR_FEATURES + 2] = boll_pctb
        out[w * PER_BAR_FEATURES + 3] = slope_norm
    return out


def batch_window_features(
    bars: Sequence[dict],
    start: int,
    stop: int,
    config: BarFeatureConfig | None = None,
) -> np.ndarray:
    """Build features for every index in ``[start, stop)`` at once."""
    cfg = config or BarFeatureConfig()
    n = max(0, stop - start)
    dim = feature_dim(cfg)
    out = np.zeros((n, dim), dtype=np.float32)
    for k, i in enumerate(range(start, stop)):
        out[k] = window_features(bars, i, cfg)
    return out
