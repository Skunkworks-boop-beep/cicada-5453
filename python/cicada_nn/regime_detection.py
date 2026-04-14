"""
Market regime detection (ported from frontend regimes.ts).
Aligns server backtest with client: only enter trades when bar's regime matches job's regime.
Supports configurable thresholds for grid research (per-instrument calibration).
"""

from __future__ import annotations

from dataclasses import dataclass

# Default thresholds (match frontend regimes.ts)
TREND_THRESHOLD = 0.00015
VOLATILITY_PCT_THRESHOLD_HIGH = 0.02
VOLATILITY_PCT_THRESHOLD_LOW = 0.004
RSI_OVERBOUGHT = 70
RSI_OVERSOLD = 30
REGIME_CONFIDENCE_MIN = 0.55
DONCHIAN_BOUNDARY_FRAC = 0.998


@dataclass
class RegimeConfig:
    """Configurable regime detection thresholds for grid research."""
    lookback: int = 50
    trend_threshold: float = TREND_THRESHOLD
    volatility_high: float = VOLATILITY_PCT_THRESHOLD_HIGH
    volatility_low: float = VOLATILITY_PCT_THRESHOLD_LOW
    rsi_overbought: float = RSI_OVERBOUGHT
    rsi_oversold: float = RSI_OVERSOLD
    confidence_min: float = REGIME_CONFIDENCE_MIN
    donchian_boundary_frac: float = DONCHIAN_BOUNDARY_FRAC

    def to_dict(self) -> dict:
        return {
            "lookback": self.lookback,
            "trend_threshold": self.trend_threshold,
            "volatility_high": self.volatility_high,
            "volatility_low": self.volatility_low,
            "rsi_overbought": self.rsi_overbought,
            "rsi_oversold": self.rsi_oversold,
            "confidence_min": self.confidence_min,
            "donchian_boundary_frac": self.donchian_boundary_frac,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "RegimeConfig":
        return cls(
            lookback=int(d.get("lookback", 50)),
            trend_threshold=float(d.get("trend_threshold", TREND_THRESHOLD)),
            volatility_high=float(d.get("volatility_high", VOLATILITY_PCT_THRESHOLD_HIGH)),
            volatility_low=float(d.get("volatility_low", VOLATILITY_PCT_THRESHOLD_LOW)),
            rsi_overbought=float(d.get("rsi_overbought", RSI_OVERBOUGHT)),
            rsi_oversold=float(d.get("rsi_oversold", RSI_OVERSOLD)),
            confidence_min=float(d.get("confidence_min", REGIME_CONFIDENCE_MIN)),
            donchian_boundary_frac=float(d.get("donchian_boundary_frac", DONCHIAN_BOUNDARY_FRAC)),
        )


def _ema(values: list[float], period: int) -> list[float | None]:
    if period < 1:
        return [None] * len(values)
    k = 2.0 / (period + 1)
    out: list[float | None] = [None] * len(values)
    prev: float | None = None
    for i in range(len(values)):
        if i < period - 1:
            continue
        if prev is None:
            prev = sum(values[:period]) / period
        else:
            prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def _rsi(closes: list[float], period: int = 14) -> list[float | None]:
    """RSI with Wilder smoothing (Wilder 1978). First avg = SMA of first period; then smoothed. Matches FE indicators.ts."""
    if period < 1:
        return [None] * len(closes)
    out: list[float | None] = [None] * len(closes)
    avg_gain = 0.0
    avg_loss = 0.0
    for i in range(period, len(closes)):
        if i == period:
            gains = losses = 0.0
            for j in range(i - period + 1, i + 1):
                ch = closes[j] - closes[j - 1]
                if ch > 0:
                    gains += ch
                else:
                    losses -= ch
            avg_gain = gains / period
            avg_loss = losses / period
        else:
            ch = closes[i] - closes[i - 1]
            gain = ch if ch > 0 else 0.0
            loss = -ch if ch < 0 else 0.0
            avg_gain = (avg_gain * (period - 1) + gain) / period
            avg_loss = (avg_loss * (period - 1) + loss) / period
        if avg_loss == 0:
            out[i] = 50.0 if avg_gain == 0 else 100.0
        else:
            rs = avg_gain / avg_loss
            out[i] = 100.0 - 100.0 / (1 + rs)
    return out


def _atr(bars: list[dict], period: int = 14) -> list[float | None]:
    if period < 1:
        return [None] * len(bars)
    tr: list[float] = []
    for i in range(len(bars)):
        if i == 0:
            tr.append(bars[i]["high"] - bars[i]["low"])
        else:
            prev_close = bars[i - 1]["close"]
            high, low = bars[i]["high"], bars[i]["low"]
            tr.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return _ema(tr, period)


def _donchian(bars: list[dict], period: int = 20) -> tuple[float | None, float | None]:
    """Return (upper, lower) for last bar. Upper = max of period highs, lower = min of period lows."""
    if period < 1 or len(bars) < period:
        return None, None
    window = bars[-period:]
    return max(b["high"] for b in window), min(b["low"] for b in window)


def _linear_regression_slope(values: list[float], period: int) -> list[float | None]:
    if period < 1:
        return [None] * len(values)
    out: list[float | None] = [None] * len(values)
    for i in range(period - 1, len(values)):
        window = values[i - period + 1 : i + 1]
        sum_x = sum_y = sum_xy = sum_x2 = 0.0
        for j, y in enumerate(window):
            x = float(j)
            sum_x += x
            sum_y += y
            sum_xy += x * y
            sum_x2 += x * x
        n = period
        denom = n * sum_x2 - sum_x * sum_x
        slope = (n * sum_xy - sum_x * sum_y) / denom if denom != 0 else 0.0
        out[i] = slope
    return out


def _detect_regime(
    bars: list[dict],
    lookback: int = 50,
    config: RegimeConfig | None = None,
) -> str:
    """Detect regime for a window of bars. Returns regime label."""
    cfg = config or RegimeConfig(lookback=lookback)
    lb = cfg.lookback
    if lb <= 0 or not bars or len(bars) < lb:
        return "unknown"
    slice_bars = bars[-lb:]
    closes = [b["close"] for b in slice_bars]
    price = closes[-1] if closes else 0
    if price <= 0:
        return "unknown"

    period = min(20, lb)
    slopes = _linear_regression_slope(closes, period)
    slope_raw = slopes[-1] if slopes and slopes[-1] is not None else 0.0
    # Normalize by price (match frontend regimes.ts) — threshold 0.00015 is for slope/price
    trend_strength = slope_raw / price if price and price > 0 else 0.0

    atr_series = _atr(slice_bars, 14)
    atr_val = atr_series[-1] if atr_series and atr_series[-1] is not None else 0.0
    volatility_pct = atr_val / price if price else 0.0

    rsi_series = _rsi(closes, 14)
    rsi_val = rsi_series[-1] if rsi_series and rsi_series[-1] is not None else None

    regime = "unknown"
    confidence = 0.5
    th_trend = cfg.trend_threshold
    th_vol_hi = cfg.volatility_high
    th_vol_lo = cfg.volatility_low
    rsi_ob = cfg.rsi_overbought
    rsi_os = cfg.rsi_oversold
    conf_min = cfg.confidence_min
    donch = cfg.donchian_boundary_frac

    if volatility_pct >= th_vol_hi:
        regime = "volatile"
        confidence = 0.7
    elif volatility_pct <= th_vol_lo and abs(trend_strength) < th_trend:
        upper, lower = _donchian(slice_bars, 20)
        if upper is not None and lower is not None and price > 0 and (
            price >= upper * donch or price <= lower * (2 - donch)
        ):
            regime = "breakout"
            confidence = 0.65
        else:
            regime = "consolidation"
            confidence = 0.65
    elif trend_strength > th_trend:
        if rsi_val is not None and rsi_val >= rsi_ob:
            regime = "reversal_bear"
            confidence = 0.7
        else:
            regime = "trending_bull"
            confidence = min(0.95, 0.5 + abs(trend_strength) * 500)
    elif trend_strength < -th_trend:
        if rsi_val is not None and rsi_val <= rsi_os:
            regime = "reversal_bull"
            confidence = 0.7
        else:
            regime = "trending_bear"
            confidence = min(0.95, 0.5 + abs(trend_strength) * 500)
    else:
        upper, lower = _donchian(slice_bars, 20)
        if upper is not None and lower is not None and price > 0:
            if price >= upper * donch or price <= lower * (2 - donch):
                regime = "breakout"
                confidence = 0.65
            else:
                regime = "ranging"
                confidence = 0.6
        else:
            regime = "ranging"
            confidence = 0.6

    if confidence < conf_min:
        regime = "unknown"

    return regime


def detect_regime_series(
    bars: list[dict],
    lookback: int = 50,
    config: RegimeConfig | None = None,
) -> list[str]:
    """Classify regime at each bar (rolling window). Aligns with frontend detectRegimeSeries."""
    cfg = config or RegimeConfig(lookback=lookback)
    lb = cfg.lookback
    if lb <= 0:
        return ["unknown"] * len(bars)
    result: list[str] = []
    for i in range(len(bars)):
        start = max(0, i - lb)
        window = bars[start : i + 1]
        result.append(_detect_regime(window, lb, cfg))
    return result
