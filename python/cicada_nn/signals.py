"""
Signal generation for server-side backtest. Ported from frontend signals.ts + patternDetection.ts.
Real computations — RSI, MACD, BB, FVG, BOS, liquidity sweep, breakout retest.
"""

from __future__ import annotations

from typing import Any

from .math_utils import safe_div
from .regime_detection import _atr, _ema, _rsi


def _sma(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    for i in range(period - 1, len(values)):
        out[i] = sum(values[i - period + 1 : i + 1]) / period
    return out


def _bollinger(closes: list[float], period: int = 20, std_mult: float = 2) -> tuple[list[float | None], list[float | None]]:
    upper: list[float | None] = [None] * len(closes)
    lower: list[float | None] = [None] * len(closes)
    for i in range(period - 1, len(closes)):
        window = closes[i - period + 1 : i + 1]
        mid = sum(window) / period
        var = sum((x - mid) ** 2 for x in window) / period
        std = var ** 0.5
        upper[i] = mid + std_mult * std
        lower[i] = mid - std_mult * std
    return upper, lower


def _macd(closes: list[float], fast: int = 12, slow: int = 26, sig: int = 9) -> tuple[list[float | None], list[float | None]]:
    fast_ema = _ema(closes, fast)
    slow_ema = _ema(closes, slow)
    macd_line: list[float | None] = [None] * len(closes)
    for i in range(len(closes)):
        if fast_ema[i] is not None and slow_ema[i] is not None:
            macd_line[i] = fast_ema[i] - slow_ema[i]
    macd_vals = [x if x is not None else 0.0 for x in macd_line]
    sig_line = _ema(macd_vals, sig)
    return macd_line, sig_line


def _donchian(bars: list[dict], period: int) -> tuple[list[float | None], list[float | None]]:
    upper: list[float | None] = [None] * len(bars)
    lower: list[float | None] = [None] * len(bars)
    for i in range(period - 1, len(bars)):
        window = bars[i - period + 1 : i + 1]
        upper[i] = max(b["high"] for b in window)
        lower[i] = min(b["low"] for b in window)
    return upper, lower


def _p(params: dict[str, float] | None, key: str, default: float) -> float:
    if params and key in params and params[key] is not None:
        return float(params[key])
    return default


def _stochastic(bars: list[dict], k_period: int = 14, d_period: int = 3) -> tuple[list[float | None], list[float | None]]:
    k: list[float | None] = [None] * len(bars)
    for i in range(k_period - 1, len(bars)):
        window = bars[i - k_period + 1 : i + 1]
        high_n = max(b["high"] for b in window)
        low_n = min(b["low"] for b in window)
        rng = high_n - low_n
        if rng == 0:
            k[i] = 50.0
        else:
            k[i] = ((bars[i]["close"] - low_n) / rng) * 100
    d: list[float | None] = [None] * len(bars)
    for i in range(d_period - 1, len(bars)):
        s = sum(k[i - j] or 0 for j in range(d_period))
        d[i] = s / d_period
    return k, d


def _cci(bars: list[dict], period: int = 20) -> list[float | None]:
    tp = [(b["high"] + b["low"] + b["close"]) / 3 for b in bars]
    out: list[float | None] = [None] * len(bars)
    for i in range(period - 1, len(bars)):
        window = tp[i - period + 1 : i + 1]
        sma_tp = sum(window) / period
        mean_dev = sum(abs(v - sma_tp) for v in window) / period
        if mean_dev == 0:
            out[i] = 0.0
        else:
            out[i] = (tp[i] - sma_tp) / (0.015 * mean_dev)
    return out


def _williams_r(bars: list[dict], period: int = 14) -> list[float | None]:
    out: list[float | None] = [None] * len(bars)
    for i in range(period - 1, len(bars)):
        window = bars[i - period + 1 : i + 1]
        high_n = max(b["high"] for b in window)
        low_n = min(b["low"] for b in window)
        rng = high_n - low_n
        if rng == 0:
            out[i] = -50.0
        else:
            out[i] = -100 * ((high_n - bars[i]["close"]) / rng)
    return out


def _roc(closes: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(closes)
    for i in range(period, len(closes)):
        prev = closes[i - period]
        out[i] = (closes[i] - prev) / prev if prev else 0.0
    return out


def _smma(values: list[float], period: int) -> list[float | None]:
    """Smoothed Moving Average (SMMA/RMA). Used by Alligator."""
    out: list[float | None] = [None] * len(values)
    prev: float | None = None
    for i in range(len(values)):
        if i < period - 1:
            continue
        if prev is None:
            prev = sum(values[:period]) / period
        else:
            prev = (prev * (period - 1) + values[i]) / period
        out[i] = prev
    return out


def _supertrend(bars: list[dict], period: int = 10, mult: float = 3) -> tuple[list[float | None], list[int]]:
    """ATR-based Supertrend. Returns (line, direction). direction: 1=bullish, -1=bearish."""
    atr_arr = _atr(bars, period)
    direction: list[int] = []
    line: list[float | None] = []
    upper_band = lower_band = st = 0.0
    dir_val = 1
    for idx in range(len(bars)):
        if idx < period:
            line.append(None)
            direction.append(1)
            continue
        a = atr_arr[idx]
        if a is None:
            line.append(None)
            direction.append(dir_val)
            continue
        hl2 = (bars[idx]["high"] + bars[idx]["low"]) / 2
        basic_upper = hl2 + mult * a
        basic_lower = hl2 - mult * a
        if idx == period:
            upper_band = basic_upper
            lower_band = basic_lower
            st = lower_band if dir_val == 1 else upper_band
        else:
            if basic_upper < upper_band or bars[idx - 1]["close"] > upper_band:
                upper_band = basic_upper
            if basic_lower > lower_band or bars[idx - 1]["close"] < lower_band:
                lower_band = basic_lower
            if dir_val == 1:
                if bars[idx]["close"] < lower_band:
                    dir_val = -1
                    st = upper_band
                else:
                    st = lower_band
            else:
                if bars[idx]["close"] > upper_band:
                    dir_val = 1
                    st = lower_band
                else:
                    st = upper_band
        line.append(st)
        direction.append(dir_val)
    return line, direction


def _parabolic_sar(bars: list[dict], af_start: float = 0.02, af_step: float = 0.02, af_max: float = 0.2) -> list[float | None]:
    """Parabolic SAR. Returns SAR series."""
    out: list[float | None] = [None]
    if len(bars) < 2:
        return out
    sar = bars[0]["low"]
    ep = bars[0]["high"]
    af = af_start
    dir_val = 1
    for i in range(1, len(bars)):
        h, l, c = bars[i]["high"], bars[i]["low"], bars[i]["close"]
        if dir_val == 1:
            if l < sar:
                dir_val = -1
                sar = ep
                ep = l
                af = af_start
            else:
                if h > ep:
                    ep = h
                    af = min(af + af_step, af_max)
                sar = sar + af * (ep - sar)
                if sar > bars[i - 1]["low"]:
                    sar = bars[i - 1]["low"]
                if sar > l:
                    sar = l
        else:
            if h > sar:
                dir_val = 1
                sar = ep
                ep = h
                af = af_start
            else:
                if l < ep:
                    ep = l
                    af = min(af + af_step, af_max)
                sar = sar - af * (sar - ep)
                if sar < bars[i - 1]["high"]:
                    sar = bars[i - 1]["high"]
                if sar < h:
                    sar = h
        out.append(sar)
    return out


def _ichimoku(bars: list[dict]) -> tuple[list[float | None], list[float | None], list[float | None], list[float | None], list[float | None]]:
    """Ichimoku Cloud: tenkan, kijun, senkouA, senkouB, chikou."""
    def hl2(i: int, p: int) -> float | None:
        if i < p - 1:
            return None
        sl = bars[i - p + 1 : i + 1]
        return (max(b["high"] for b in sl) + min(b["low"] for b in sl)) / 2

    tenkan = [hl2(i, 9) for i in range(len(bars))]
    kijun = [hl2(i, 26) for i in range(len(bars))]
    senkou_a_raw: list[float | None] = []
    for i in range(len(bars)):
        t, k = tenkan[i], kijun[i]
        senkou_a_raw.append((t + k) / 2 if t is not None and k is not None else None)
    senkou_b_raw: list[float | None] = []
    for i in range(len(bars)):
        if i >= 51:
            sl = bars[i - 51 : i + 1]
            senkou_b_raw.append((max(b["high"] for b in sl) + min(b["low"] for b in sl)) / 2)
        else:
            senkou_b_raw.append(None)
    senkou_a = [senkou_a_raw[i - 26] if i >= 26 else None for i in range(len(bars))]
    senkou_b = [senkou_b_raw[i - 26] if i >= 26 else None for i in range(len(bars))]
    chikou = [bars[i]["close"] if i + 26 < len(bars) else None for i in range(len(bars))]
    return tenkan, kijun, senkou_a, senkou_b, chikou


def _alligator(bars: list[dict]) -> tuple[list[float | None], list[float | None], list[float | None]]:
    """Alligator: Jaw, Teeth, Lips. Uses median price (H+L)/2. Shifted."""
    median = [(b["high"] + b["low"]) / 2 for b in bars]
    j = _smma(median, 13)
    t = _smma(median, 8)
    l = _smma(median, 5)

    def shift(arr: list[float | None], n: int) -> list[float | None]:
        return [arr[i - n] if i >= n else None for i in range(len(arr))]

    return shift(j, 8), shift(t, 5), shift(l, 3)


def _gator_oscillator(bars: list[dict]) -> tuple[list[float | None], list[float | None]]:
    """Gator: upper=|Jaw-Teeth|, lower=|Teeth-Lips|."""
    jaw, teeth, lips = _alligator(bars)
    upper: list[float | None] = []
    lower: list[float | None] = []
    for i in range(len(bars)):
        j, t, lv = jaw[i], teeth[i], lips[i]
        upper.append(abs(j - t) if j is not None and t is not None else None)
        lower.append(abs(t - lv) if t is not None and lv is not None else None)
    return upper, lower


def _kst(closes: list[float]) -> tuple[list[float | None], list[float | None]]:
    """Know Sure Thing: weighted ROC momentum."""
    r1 = _roc(closes, 10)
    r2 = _roc(closes, 15)
    r3 = _roc(closes, 20)
    r4 = _roc(closes, 30)
    r1_vals = [x if x is not None else 0.0 for x in r1]
    r2_vals = [x if x is not None else 0.0 for x in r2]
    r3_vals = [x if x is not None else 0.0 for x in r3]
    r4_vals = [x if x is not None else 0.0 for x in r4]
    rocma1 = _sma(r1_vals, 10)
    rocma2 = _sma(r2_vals, 10)
    rocma3 = _sma(r3_vals, 10)
    rocma4 = _sma(r4_vals, 15)
    kst_line: list[float | None] = []
    for i in range(len(closes)):
        a, b, c, d = rocma1[i], rocma2[i], rocma3[i], rocma4[i]
        if a is None or b is None or c is None or d is None:
            kst_line.append(None)
        else:
            kst_line.append(a * 1 + b * 2 + c * 3 + d * 4)
    kst_vals = [x if x is not None else 0.0 for x in kst_line]
    signal = _sma(kst_vals, 9)
    return kst_line, signal


def _pvo(bars: list[dict]) -> tuple[list[float | None], list[float | None], list[float | None]]:
    """Price Volume Oscillator: (EMA(vol,12)-EMA(vol,26))/EMA(vol,26)*100. Histogram=PVO-Signal."""
    vols = [b.get("volume") or 0 for b in bars]
    fast = _ema(vols, 12)
    slow = _ema(vols, 26)
    pvo_line: list[float | None] = []
    for i in range(len(bars)):
        if fast[i] is None or slow[i] is None or slow[i] == 0:
            pvo_line.append(None)
        else:
            pvo_line.append(100 * (fast[i] - slow[i]) / slow[i])
    pvo_vals = [x if x is not None else 0.0 for x in pvo_line]
    sig = _ema(pvo_vals, 9)
    hist: list[float | None] = []
    for i in range(len(bars)):
        if pvo_line[i] is None or sig[i] is None:
            hist.append(None)
        else:
            hist.append(pvo_line[i] - sig[i])
    return pvo_line, sig, hist


def _swing_index(bars: list[dict], limit_move: float = 25000) -> list[float | None]:
    """Wilder Swing Index."""
    out: list[float | None] = [None]
    for i in range(1, len(bars)):
        c, o, h, l = bars[i]["close"], bars[i]["open"], bars[i]["high"], bars[i]["low"]
        cn1, on1 = bars[i - 1]["close"], bars[i - 1]["open"]
        k = max(h - cn1, l - cn1)
        h_cn1, l_cn1, hl = h - cn1, l - cn1, h - l
        if h_cn1 >= l_cn1 and h_cn1 >= hl:
            r = h_cn1 + 0.5 * l_cn1 + 0.25 * (cn1 - on1)
        elif l_cn1 >= h_cn1 and l_cn1 >= hl:
            r = l_cn1 + 0.5 * h_cn1 + 0.25 * (cn1 - on1)
        else:
            r = hl + 0.25 * (cn1 - on1)
        if r == 0:
            out.append(0.0)
            continue
        si = ((c - cn1) + 0.5 * (c - o) + 0.25 * (cn1 - on1)) / r * (k / limit_move) * 50
        out.append(si)
    return out


def _adx(bars: list[dict], period: int = 14) -> tuple[list[float | None], list[float | None], list[float | None]]:
    tr: list[float] = []
    for i in range(len(bars)):
        if i == 0:
            tr.append(bars[i]["high"] - bars[i]["low"])
        else:
            tr.append(max(
                bars[i]["high"] - bars[i]["low"],
                abs(bars[i]["high"] - bars[i - 1]["close"]),
                abs(bars[i]["low"] - bars[i - 1]["close"]),
            ))
    plus_dm: list[float] = [0.0]
    minus_dm: list[float] = [0.0]
    for i in range(1, len(bars)):
        up = bars[i]["high"] - bars[i - 1]["high"]
        down = bars[i - 1]["low"] - bars[i]["low"]
        plus_dm.append(up if up > down and up > 0 else 0.0)
        minus_dm.append(down if down > up and down > 0 else 0.0)
    atr_arr = _ema(tr, period)
    smooth_plus = _ema(plus_dm, period)
    smooth_minus = _ema(minus_dm, period)
    plus_di: list[float | None] = [None] * len(bars)
    minus_di: list[float | None] = [None] * len(bars)
    dx: list[float | None] = [None] * len(bars)
    for i in range(len(bars)):
        if atr_arr[i] is None or atr_arr[i] == 0 or smooth_plus[i] is None or smooth_minus[i] is None:
            continue
        p_di = 100 * smooth_plus[i] / atr_arr[i]
        m_di = 100 * smooth_minus[i] / atr_arr[i]
        plus_di[i] = p_di
        minus_di[i] = m_di
        s = p_di + m_di
        dx[i] = 100 * abs(p_di - m_di) / s if s else 0.0
    adx_vals = _ema([x or 0.0 for x in dx], period)
    return adx_vals, plus_di, minus_di


def _keltner(bars: list[dict], ema_period: int = 20, atr_period: int = 10, mult: float = 2) -> tuple[list[float | None], list[float | None]]:
    closes = [b["close"] for b in bars]
    middle = _ema(closes, ema_period)
    atr_arr = _atr(bars, atr_period)
    upper: list[float | None] = [None] * len(bars)
    lower: list[float | None] = [None] * len(bars)
    for i in range(len(bars)):
        if middle[i] is not None and atr_arr[i] is not None:
            upper[i] = middle[i] + mult * atr_arr[i]
            lower[i] = middle[i] - mult * atr_arr[i]
    return upper, lower


def _awesome_oscillator(bars: list[dict]) -> list[float | None]:
    median = [(b["high"] + b["low"]) / 2 for b in bars]
    sma5 = _sma(median, 5)
    sma34 = _sma(median, 34)
    out: list[float | None] = []
    for i in range(len(bars)):
        if sma5[i] is None or sma34[i] is None:
            out.append(None)
        else:
            out.append(sma5[i] - sma34[i])
    return out


def _accelerator_oscillator(bars: list[dict]) -> list[float | None]:
    """AC = AO - SMA(AO, 5)."""
    ao = _awesome_oscillator(bars)
    ao_vals = [x if x is not None else 0.0 for x in ao]
    sma_ao = _sma(ao_vals, 5)
    out: list[float | None] = []
    for i in range(len(bars)):
        if ao[i] is None or sma_ao[i] is None:
            out.append(None)
        else:
            out.append(ao[i] - sma_ao[i])
    return out


def _dpo(closes: list[float], period: int = 20) -> list[float | None]:
    shift = period // 2 + 1
    sma_price = _sma(closes, period)
    out: list[float | None] = [None] * len(closes)
    for i in range(period + shift - 1, len(closes)):
        if sma_price[i - shift] is not None:
            out[i] = closes[i] - sma_price[i - shift]
    return out


def _vwap(bars: list[dict]) -> list[float | None]:
    """Cumulative VWAP: sum(TP*vol)/sum(vol)."""
    out: list[float | None] = [None] * len(bars)
    cum_tpv = cum_vol = 0.0
    for i in range(len(bars)):
        tp = (bars[i]["high"] + bars[i]["low"] + bars[i]["close"]) / 3
        vol = bars[i].get("volume") or 0
        cum_tpv += tp * vol
        cum_vol += vol
        out[i] = cum_tpv / cum_vol if cum_vol else None
    return out


def _vwap_bands(bars: list[dict], period: int = 20, std_mult: float = 2) -> tuple[list[float | None], list[float | None]]:
    """VWAP ± std dev over rolling period."""
    vwap_series = _vwap(bars)
    upper: list[float | None] = [None] * len(bars)
    lower: list[float | None] = [None] * len(bars)
    for i in range(period - 1, len(bars)):
        window = bars[i - period + 1 : i + 1]
        tps = [(b["high"] + b["low"] + b["close"]) / 3 for b in window]
        vols = [b.get("volume") or 0 for b in window]
        tpv = sum(t * v for t, v in zip(tps, vols))
        vol_sum = sum(vols)
        if vol_sum == 0:
            continue
        v = tpv / vol_sum
        var = sum((t - v) ** 2 * (vols[j] or 0) for j, t in enumerate(tps)) / vol_sum
        std = var ** 0.5
        upper[i] = v + std_mult * std
        lower[i] = v - std_mult * std
    return upper, lower


def _cmf(bars: list[dict], period: int = 20) -> list[float | None]:
    """Chaikin Money Flow: sum(MF)/sum(vol), MF = ((2*close-high-low)/(high-low))*vol."""
    out: list[float | None] = [None] * len(bars)
    for i in range(period - 1, len(bars)):
        mf_sum = vol_sum = 0.0
        for j in range(i - period + 1, i + 1):
            b = bars[j]
            hl = b["high"] - b["low"]
            mf = ((2 * b["close"] - b["high"] - b["low"]) / hl * (b.get("volume") or 0)) if hl else 0
            mf_sum += mf
            vol_sum += b.get("volume") or 0
        out[i] = mf_sum / vol_sum if vol_sum else None
    return out


def _cmo(closes: list[float], period: int = 14) -> list[float | None]:
    """Chande Momentum Oscillator: 100*(sum gains - sum losses)/(sum gains + sum losses)."""
    out: list[float | None] = [None] * len(closes)
    for i in range(period, len(closes)):
        gains = losses = 0.0
        for j in range(i - period + 1, i + 1):
            ch = closes[j] - closes[j - 1]
            if ch > 0:
                gains += ch
            else:
                losses -= ch
        s = gains + losses
        out[i] = 100 * (gains - losses) / s if s else 0.0
    return out


def _tsi(closes: list[float], long_period: int = 25, short_period: int = 13) -> list[float | None]:
    """True Strength Index: double EMA of price change vs |price change|."""
    pc = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    pc.insert(0, 0.0)
    abs_pc = [abs(x) for x in pc]
    d1 = _ema(pc, long_period)
    d2 = _ema([x or 0.0 for x in d1], short_period)
    d1_abs = _ema(abs_pc, long_period)
    d2_abs = _ema([x or 0.0 for x in d1_abs], short_period)
    out: list[float | None] = [None] * len(closes)
    for i in range(len(closes)):
        if d2[i] is not None and d2_abs[i] is not None and d2_abs[i] != 0:
            out[i] = 100 * d2[i] / d2_abs[i]
    return out


def _ultimate_oscillator(bars: list[dict]) -> list[float | None]:
    """Ultimate Oscillator: BP/TR over 7,14,28, weighted 4:2:1."""
    out: list[float | None] = [None] * len(bars)
    for i in range(1, len(bars)):
        prev_close = bars[i - 1]["close"]
        bp = bars[i]["close"] - min(bars[i]["low"], prev_close)
        tr = max(bars[i]["high"], prev_close) - min(bars[i]["low"], prev_close)
        if i < 28 or tr == 0:
            continue
        bp7 = sum(
            bars[j]["close"] - min(bars[j]["low"], bars[j - 1]["close"])
            for j in range(i - 6, i + 1)
        )
        tr7 = sum(
            max(bars[j]["high"], bars[j - 1]["close"]) - min(bars[j]["low"], bars[j - 1]["close"])
            for j in range(i - 6, i + 1)
        )
        bp14 = sum(
            bars[j]["close"] - min(bars[j]["low"], bars[j - 1]["close"])
            for j in range(i - 13, i + 1)
        )
        tr14 = sum(
            max(bars[j]["high"], bars[j - 1]["close"]) - min(bars[j]["low"], bars[j - 1]["close"])
            for j in range(i - 13, i + 1)
        )
        bp28 = sum(
            bars[j]["close"] - min(bars[j]["low"], bars[j - 1]["close"])
            for j in range(i - 27, i + 1)
        )
        tr28 = sum(
            max(bars[j]["high"], bars[j - 1]["close"]) - min(bars[j]["low"], bars[j - 1]["close"])
            for j in range(i - 27, i + 1)
        )
        avg7 = bp7 / tr7 if tr7 else 0
        avg14 = bp14 / tr14 if tr14 else 0
        avg28 = bp28 / tr28 if tr28 else 0
        out[i] = 100 * (4 * avg7 + 2 * avg14 + avg28) / 7
    return out


def _obv(bars: list[dict]) -> list[float | None]:
    """On-Balance Volume."""
    out: list[float | None] = [None] * len(bars)
    obv_val = 0.0
    for i in range(len(bars)):
        vol = bars[i].get("volume") or 0
        if i == 0:
            obv_val = vol
        else:
            if bars[i]["close"] > bars[i - 1]["close"]:
                obv_val += vol
            elif bars[i]["close"] < bars[i - 1]["close"]:
                obv_val -= vol
        out[i] = obv_val
    return out


def _force_index(bars: list[dict], period: int = 2) -> list[float | None]:
    """(close - prev_close) * volume, EMA-smoothed."""
    raw: list[float] = [0.0]
    for i in range(1, len(bars)):
        raw.append((bars[i]["close"] - bars[i - 1]["close"]) * (bars[i].get("volume") or 0))
    ema_vals = _ema(raw, period)
    return ema_vals


EOM_VOLUME_FALLBACK = 1.0


def _eom(bars: list[dict], period: int = 14) -> list[float | None]:
    """Ease of Movement: distance/volume ratio, EMA-smoothed. Aligns with TS indicators.ts."""
    raw: list[float] = [0.0]
    for i in range(1, len(bars)):
        dm = (bars[i]["high"] + bars[i]["low"]) / 2 - (bars[i - 1]["high"] + bars[i - 1]["low"]) / 2
        vol = bars[i].get("volume") or 0
        vol = vol if vol > 0 else EOM_VOLUME_FALLBACK
        box_ratio = (bars[i]["high"] - bars[i]["low"]) / vol
        raw.append(dm / box_ratio if box_ratio else 0.0)
    return _ema(raw, period)


def _vpt(bars: list[dict]) -> list[float | None]:
    """Volume Price Trend: cumulative volume * % price change."""
    out: list[float | None] = [None] * len(bars)
    vpt_val = 0.0
    for i in range(len(bars)):
        vol = bars[i].get("volume") or 0
        if i == 0:
            out[i] = 0.0
            continue
        pct = safe_div(bars[i]["close"] - bars[i - 1]["close"], bars[i - 1]["close"])
        vpt_val += vol * pct
        out[i] = vpt_val
    return out


def _coppock(closes: list[float], roc1: int = 14, roc2: int = 11, smooth: int = 10) -> list[float | None]:
    """Coppock Curve: SMA of (ROC14 + ROC11)."""
    r1 = _roc(closes, roc1)
    r2 = _roc(closes, roc2)
    raw = [(r1[i] or 0) + (r2[i] or 0) for i in range(len(closes))]
    return _sma(raw, smooth)


def _nvi(bars: list[dict]) -> list[float | None]:
    """Negative Volume Index: cumulative when volume < prev volume."""
    out: list[float | None] = [1000.0]
    for i in range(1, len(bars)):
        vol = bars[i].get("volume") or 0
        prev_vol = bars[i - 1].get("volume") or 0
        prev = out[i - 1] or 1000.0
        prev_close = bars[i - 1]["close"]
        if vol < prev_vol and prev_close is not None and prev_close != 0:
            pct = (bars[i]["close"] - prev_close) / prev_close
            out.append(prev * (1 + pct))
        else:
            out.append(prev)
    return out


def _pvi(bars: list[dict]) -> list[float | None]:
    """Positive Volume Index: cumulative when volume > prev volume."""
    out: list[float | None] = [1000.0]
    for i in range(1, len(bars)):
        vol = bars[i].get("volume") or 0
        prev_vol = bars[i - 1].get("volume") or 0
        prev = out[i - 1] or 1000.0
        prev_close = bars[i - 1]["close"]
        if vol > prev_vol and prev_close is not None and prev_close != 0:
            pct = (bars[i]["close"] - prev_close) / prev_close
            out.append(prev * (1 + pct))
        else:
            out.append(prev)
    return out


def _accumulation_distribution(bars: list[dict]) -> list[float | None]:
    """A/D: cumulative ((2*close-high-low)/(high-low))*volume."""
    out: list[float | None] = [0.0]
    cum = 0.0
    for i in range(1, len(bars)):
        b = bars[i]
        hl = b["high"] - b["low"]
        mfm = (2 * b["close"] - b["high"] - b["low"]) / hl if hl else 0
        cum += mfm * (b.get("volume") or 0)
        out.append(cum)
    return out


def _pivot_points(bars: list[dict]) -> tuple[list[float | None], list[float | None], list[float | None], list[float | None], list[float | None]]:
    """Classic pivots from prior bar."""
    pivot, r1, r2, s1, s2 = [None], [None], [None], [None], [None]
    for i in range(1, len(bars)):
        p = bars[i - 1]
        h, l, c = p["high"], p["low"], p["close"]
        pv = (h + l + c) / 3
        pivot.append(pv)
        r1.append(2 * pv - l)
        r2.append(pv + (h - l))
        s1.append(2 * pv - h)
        s2.append(pv - (h - l))
    return pivot, r1, r2, s1, s2


def _camarilla_pivots(bars: list[dict]) -> tuple[list[float | None], ...]:
    """Camarilla pivots."""
    r4, r3, r2, r1 = [None], [None], [None], [None]
    s1, s2, s3, s4 = [None], [None], [None], [None]
    for i in range(1, len(bars)):
        p = bars[i - 1]
        h, l, c = p["high"], p["low"], p["close"]
        r = (h - l) * 1.1
        r4.append(c + r / 2)
        r3.append(c + r / 4)
        r2.append(c + r / 12)
        r1.append(c + r / 24)
        s1.append(c - r / 24)
        s2.append(c - r / 12)
        s3.append(c - r / 4)
        s4.append(c - r / 2)
    return r4, r3, r2, r1, s1, s2, s3, s4


def _fib_pivot(bars: list[dict]) -> tuple[list[float | None], list[float | None], list[float | None], list[float | None], list[float | None]]:
    """Fibonacci pivot."""
    pivot, r1, r2, s1, s2 = [None], [None], [None], [None], [None]
    for i in range(1, len(bars)):
        p = bars[i - 1]
        h, l, c = p["high"], p["low"], p["close"]
        pv = (h + l + c) / 3
        pivot.append(pv)
        r1.append(pv + (h - l) * 0.382)
        r2.append(pv + (h - l) * 0.618)
        s1.append(pv - (h - l) * 0.382)
        s2.append(pv - (h - l) * 0.618)
    return pivot, r1, r2, s1, s2


def _zigzag(bars: list[dict], threshold_pct: float = 0.001) -> tuple[list[float | None], list[bool]]:
    """ZigZag levels and is_high flag."""
    levels: list[float | None] = []
    is_high: list[bool] = []
    if not bars:
        return levels, is_high
    last_extreme = bars[0]["close"]
    last_is_high = True
    for i in range(len(bars)):
        h, l = bars[i]["high"], bars[i]["low"]
        thresh = abs(last_extreme) * threshold_pct or 0.0001
        if last_is_high:
            if h >= last_extreme:
                last_extreme = h
            elif l <= last_extreme - thresh:
                last_extreme = l
                last_is_high = False
        else:
            if l <= last_extreme:
                last_extreme = l
            elif h >= last_extreme + thresh:
                last_extreme = h
                last_is_high = True
        levels.append(last_extreme)
        is_high.append(last_is_high)
    return levels, is_high


def _fractals(bars: list[dict]) -> tuple[list[float | None], list[float | None]]:
    """Bill Williams Fractals: 5-bar high/low."""
    high_f, low_f = [], []
    for i in range(len(bars)):
        if i < 2 or i >= len(bars) - 2:
            high_f.append(None)
            low_f.append(None)
            continue
        h, l = bars[i]["high"], bars[i]["low"]
        is_high = all(bars[i + k]["high"] < h for k in [-2, -1, 1, 2])
        is_low = all(bars[i + k]["low"] > l for k in [-2, -1, 1, 2])
        high_f.append(h if is_high else None)
        low_f.append(l if is_low else None)
    return high_f, low_f


def _trix(closes: list[float], period: int = 15) -> list[float | None]:
    e = _ema(closes, period)
    e = _ema([x or 0.0 for x in e], period)
    e = _ema([x or 0.0 for x in e], period)
    out: list[float | None] = [None] * len(closes)
    for i in range(1, len(closes)):
        if e[i] is not None and e[i - 1] is not None and e[i - 1] != 0:
            out[i] = 100 * ((e[i] - e[i - 1]) / e[i - 1])
    return out


# --- Pattern detection (from patternDetection.ts) ---


def _detect_fvg(bars: list[dict], i: int) -> int:
    if i < 2:
        return 0
    c1, c2, c3 = bars[i - 2], bars[i - 1], bars[i]
    if c1["low"] > c3["high"] and c3["close"] > c3["open"] and c1["close"] < c1["open"]:
        return 1
    if c1["high"] < c3["low"] and c3["close"] < c3["open"] and c1["close"] > c1["open"]:
        return -1
    return 0


def _detect_liquidity_sweep(bars: list[dict], i: int, lookback: int = 8) -> int:
    """Swing-based: sweeps occur at swing points (stop clusters). Match frontend detectLiquiditySweep."""
    if lookback <= 0 or i < lookback + 4:
        return 0
    swing_highs: list[dict] = []
    swing_lows: list[dict] = []
    for j in range(max(2, i - lookback), min(i - 1, len(bars) - 2) + 1):
        if _is_swing_high(bars, j):
            swing_highs.append({"idx": j, "high": bars[j]["high"]})
        if _is_swing_low(bars, j):
            swing_lows.append({"idx": j, "low": bars[j]["low"]})
    if not swing_highs or not swing_lows:
        return 0
    last_sh = swing_highs[-1]
    last_sl = swing_lows[-1]
    cur = bars[i]
    if cur["low"] < last_sl["low"] and cur["close"] > cur["open"] and cur["close"] > last_sl["low"]:
        return 1
    if cur["high"] > last_sh["high"] and cur["close"] < cur["open"] and cur["close"] < last_sh["high"]:
        return -1
    return 0


def _detect_liquidity_pool(bars: list[dict], i: int, lookback: int = 14) -> int:
    """Sweep of liquidity cluster (2+ swing points in tight zone). Match frontend detectLiquidityPool."""
    if lookback <= 0 or i < lookback + 4:
        return 0
    swing_highs: list[dict] = []
    swing_lows: list[dict] = []
    for j in range(max(2, i - lookback), min(i - 1, len(bars) - 2) + 1):
        if _is_swing_high(bars, j):
            swing_highs.append({"idx": j, "high": bars[j]["high"]})
        if _is_swing_low(bars, j):
            swing_lows.append({"idx": j, "low": bars[j]["low"]})
    cluster_tol = 0.003
    has_high = len(swing_highs) >= 2 and safe_div(abs(swing_highs[-1]["high"] - swing_highs[-2]["high"]), swing_highs[-1]["high"]) <= cluster_tol
    has_low = len(swing_lows) >= 2 and safe_div(abs(swing_lows[-1]["low"] - swing_lows[-2]["low"]), swing_lows[-1]["low"]) <= cluster_tol
    if not has_high and not has_low:
        return 0
    last_sh = swing_highs[-1]
    last_sl = swing_lows[-1]
    cur = bars[i]
    if has_low and cur["low"] < last_sl["low"] and cur["close"] > cur["open"] and cur["close"] > last_sl["low"]:
        return 1
    if has_high and cur["high"] > last_sh["high"] and cur["close"] < cur["open"] and cur["close"] < last_sh["high"]:
        return -1
    return 0


def _detect_inducement(bars: list[dict], i: int, lookback: int = 8) -> int:
    """Quick fake-out sweep then reversal; requires wick rejection >= 0.4. Match frontend detectInducement."""
    if lookback <= 0 or i < lookback + 4:
        return 0
    swing_highs: list[dict] = []
    swing_lows: list[dict] = []
    for j in range(max(2, i - lookback), min(i - 1, len(bars) - 2) + 1):
        if _is_swing_high(bars, j):
            swing_highs.append({"idx": j, "high": bars[j]["high"]})
        if _is_swing_low(bars, j):
            swing_lows.append({"idx": j, "low": bars[j]["low"]})
    if not swing_highs or not swing_lows:
        return 0
    last_sh = swing_highs[-1]
    last_sl = swing_lows[-1]
    cur = bars[i]
    rng = cur["high"] - cur["low"]
    lower_wick = (min(cur["open"], cur["close"]) - cur["low"]) / rng if rng > 0 else 0
    upper_wick = (cur["high"] - max(cur["open"], cur["close"])) / rng if rng > 0 else 0
    if cur["low"] < last_sl["low"] and cur["close"] > cur["open"] and cur["close"] > last_sl["low"] and lower_wick >= 0.4:
        return 1
    if cur["high"] > last_sh["high"] and cur["close"] < cur["open"] and cur["close"] < last_sh["high"] and upper_wick >= 0.4:
        return -1
    return 0


def _detect_stop_hunt(bars: list[dict], i: int, lookback: int = 10) -> int:
    """Sweep of most recent obvious swing level. Same logic as liquidity_sweep, wider lookback. Match frontend detectStopHunt."""
    return _detect_liquidity_sweep(bars, i, lookback)


def _detect_bos(bars: list[dict], i: int, lookback: int = 10) -> int:
    """Swing-based: break of prior swing high (bullish) or swing low (bearish)."""
    if i < lookback + 4:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    swing_highs: list[dict] = []
    swing_lows: list[dict] = []
    for j in range(2, len(slice_bars) - 2):
        b = slice_bars[j]
        if (
            b["high"] >= slice_bars[j - 1]["high"]
            and b["high"] >= slice_bars[j - 2]["high"]
            and b["high"] >= slice_bars[j + 1]["high"]
            and b["high"] >= slice_bars[j + 2]["high"]
        ):
            swing_highs.append({"idx": j, "high": b["high"]})
        if (
            b["low"] <= slice_bars[j - 1]["low"]
            and b["low"] <= slice_bars[j - 2]["low"]
            and b["low"] <= slice_bars[j + 1]["low"]
            and b["low"] <= slice_bars[j + 2]["low"]
        ):
            swing_lows.append({"idx": j, "low": b["low"]})
    if not swing_highs or not swing_lows:
        return 0
    last_sh = swing_highs[-1]
    last_sl = swing_lows[-1]
    cur = bars[i]
    if cur["close"] > last_sh["high"] and cur["close"] > cur["open"]:
        return 1
    if cur["close"] < last_sl["low"] and cur["close"] < cur["open"]:
        return -1
    return 0


def _detect_structure_break(bars: list[dict], i: int, lookback: int = 5) -> int:
    """Structure break: break of prior swing high (bullish) or swing low (bearish). Swing-based."""
    if i < lookback + 4:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    swing_highs: list[dict] = []
    swing_lows: list[dict] = []
    for j in range(2, len(slice_bars) - 2):
        b = slice_bars[j]
        if (
            b["high"] >= slice_bars[j - 1]["high"]
            and b["high"] >= slice_bars[j - 2]["high"]
            and b["high"] >= slice_bars[j + 1]["high"]
            and b["high"] >= slice_bars[j + 2]["high"]
        ):
            swing_highs.append({"idx": j, "high": b["high"]})
        if (
            b["low"] <= slice_bars[j - 1]["low"]
            and b["low"] <= slice_bars[j - 2]["low"]
            and b["low"] <= slice_bars[j + 1]["low"]
            and b["low"] <= slice_bars[j + 2]["low"]
        ):
            swing_lows.append({"idx": j, "low": b["low"]})
    if not swing_highs or not swing_lows:
        return 0
    last_sh = swing_highs[-1]
    last_sl = swing_lows[-1]
    cur = bars[i]
    if cur["close"] > last_sh["high"] and cur["close"] > cur["open"]:
        return 1
    if cur["close"] < last_sl["low"] and cur["close"] < cur["open"]:
        return -1
    return 0


def _detect_fakeout(bars: list[dict], i: int, lookback: int = 10) -> int:
    """Swing-based: price breaks swing level then reverses (false breakout)."""
    if i < lookback + 4:
        return 0
    swing_highs: list[dict] = []
    swing_lows: list[dict] = []
    for j in range(max(2, i - lookback), min(i - 2, len(bars) - 2) + 1):
        if _is_swing_high(bars, j):
            swing_highs.append({"idx": j, "high": bars[j]["high"]})
        if _is_swing_low(bars, j):
            swing_lows.append({"idx": j, "low": bars[j]["low"]})
    if not swing_highs or not swing_lows:
        return 0
    last_sh = swing_highs[-1]
    last_sl = swing_lows[-1]
    prev, cur = bars[i - 1], bars[i]
    if prev["close"] >= last_sh["high"] * 0.998 and cur["close"] < last_sl["low"] and cur["close"] < cur["open"]:
        return -1
    if prev["close"] <= last_sl["low"] * 1.002 and cur["close"] > last_sh["high"] and cur["close"] > cur["open"]:
        return 1
    return 0


def _detect_close_beyond(bars: list[dict], i: int, lookback: int = 10) -> int:
    """Swing-based: close beyond swing high/low (key level); commitment."""
    if i < lookback + 4:
        return 0
    swing_highs: list[dict] = []
    swing_lows: list[dict] = []
    for j in range(max(2, i - lookback), min(i - 2, len(bars) - 2) + 1):
        if _is_swing_high(bars, j):
            swing_highs.append({"idx": j, "high": bars[j]["high"]})
        if _is_swing_low(bars, j):
            swing_lows.append({"idx": j, "low": bars[j]["low"]})
    if not swing_highs or not swing_lows:
        return 0
    last_sh = swing_highs[-1]
    last_sl = swing_lows[-1]
    cur = bars[i]
    if cur["close"] > last_sh["high"] and cur["close"] > cur["open"]:
        return 1
    if cur["close"] < last_sl["low"] and cur["close"] < cur["open"]:
        return -1
    return 0


def _detect_breakout_retest(bars: list[dict], i: int, period: int = 20) -> int:
    if i < period + 3 or period <= 0:
        return 0
    window = bars[i - period : i]
    upper = max(b["high"] for b in window)
    lower = min(b["low"] for b in window)
    cur, prev = bars[i], bars[i - 1]
    if prev["close"] >= upper * 0.998 and cur["low"] < upper and cur["close"] > upper and cur["close"] > cur["open"]:
        return 1
    if prev["close"] <= lower * 1.002 and cur["high"] > lower and cur["close"] < lower and cur["close"] < cur["open"]:
        return -1
    return 0


def _detect_equal_highs_lows(bars: list[dict], i: int, lookback: int = 15, tolerance: float = 0.002) -> int:
    """Two swing highs or two swing lows at similar level; break of neckline."""
    if i < lookback + 4:
        return 0
    swing_highs: list[dict] = []
    swing_lows: list[dict] = []
    for j in range(max(2, i - lookback), min(i - 2, len(bars) - 2) + 1):
        if _is_swing_high(bars, j):
            swing_highs.append({"idx": j, "high": bars[j]["high"]})
        if _is_swing_low(bars, j):
            swing_lows.append({"idx": j, "low": bars[j]["low"]})
    if len(swing_highs) >= 2:
        last, prev = swing_highs[-1], swing_highs[-2]
        diff = safe_div(abs(last["high"] - prev["high"]), prev["high"])
        if diff <= tolerance:
            neck_low = min(bars[k]["low"] for k in range(prev["idx"], last["idx"] + 1))
            if bars[i]["close"] < neck_low and bars[i]["close"] < bars[i]["open"]:
                return -1
    if len(swing_lows) >= 2:
        last, prev = swing_lows[-1], swing_lows[-2]
        diff = safe_div(abs(last["low"] - prev["low"]), prev["low"])
        if diff <= tolerance:
            neck_high = max(bars[k]["high"] for k in range(prev["idx"], last["idx"] + 1))
            if bars[i]["close"] > neck_high and bars[i]["close"] > bars[i]["open"]:
                return 1
    return 0


def _detect_sr_flip(bars: list[dict], i: int, lookback: int = 10) -> int:
    """Prior support becomes resistance (bearish) or prior resistance becomes support (bullish)."""
    if i < lookback + 3:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    swing_highs: list[float] = []
    swing_lows: list[float] = []
    for j in range(2, len(slice_bars) - 2):
        b = slice_bars[j]
        if (
            b["high"] >= slice_bars[j - 1]["high"]
            and b["high"] >= slice_bars[j - 2]["high"]
            and b["high"] >= slice_bars[j + 1]["high"]
            and b["high"] >= slice_bars[j + 2]["high"]
        ):
            swing_highs.append(b["high"])
        if (
            b["low"] <= slice_bars[j - 1]["low"]
            and b["low"] <= slice_bars[j - 2]["low"]
            and b["low"] <= slice_bars[j + 1]["low"]
            and b["low"] <= slice_bars[j + 2]["low"]
        ):
            swing_lows.append(b["low"])
    if not swing_highs or not swing_lows:
        return 0
    res, sup = min(swing_highs), max(swing_lows)
    tol = (res - sup) * 0.02
    cur = bars[i]
    if cur["close"] < sup - tol and cur["close"] < cur["open"] and cur["high"] >= sup - tol:
        return -1
    if cur["close"] > res + tol and cur["close"] > cur["open"] and cur["low"] <= res + tol:
        return 1
    return 0


def _detect_trendline_break(bars: list[dict], i: int, lookback: int = 15) -> int:
    """Price breaks linear trendline (support/resistance)."""
    if i < lookback + 3:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    if len(slice_bars) <= 0:
        return 0
    highs = [b["high"] for b in slice_bars]
    lows = [b["low"] for b in slice_bars]
    slope_h = (highs[-1] - highs[0]) / len(slice_bars)
    slope_l = (lows[-1] - lows[0]) / len(slice_bars)
    cur = bars[i]
    if slope_h < 0 and slope_l < 0:
        tl = lows[0] + slope_l * (len(slice_bars) - 1)
        if cur["close"] < tl * 0.998 and cur["close"] < cur["open"]:
            return -1
    if slope_h > 0 and slope_l > 0:
        tl = highs[0] + slope_h * (len(slice_bars) - 1)
        if cur["close"] > tl * 1.002 and cur["close"] > cur["open"]:
            return 1
    return 0


def _detect_swing_failure(bars: list[dict], i: int, lookback: int = 8) -> int:
    """Price breaks swing high/low then reverses (failed break)."""
    if i < lookback + 4:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    swing_highs: list[float] = []
    swing_lows: list[float] = []
    for j in range(2, len(slice_bars) - 2):
        b = slice_bars[j]
        if (
            b["high"] >= slice_bars[j - 1]["high"]
            and b["high"] >= slice_bars[j - 2]["high"]
            and b["high"] >= slice_bars[j + 1]["high"]
            and b["high"] >= slice_bars[j + 2]["high"]
        ):
            swing_highs.append(b["high"])
        if (
            b["low"] <= slice_bars[j - 1]["low"]
            and b["low"] <= slice_bars[j - 2]["low"]
            and b["low"] <= slice_bars[j + 1]["low"]
            and b["low"] <= slice_bars[j + 2]["low"]
        ):
            swing_lows.append(b["low"])
    if not swing_highs or not swing_lows:
        return 0
    res, sup = max(swing_highs), min(swing_lows)
    prev, cur = bars[i - 1], bars[i]
    if prev["high"] >= res * 0.998 and cur["close"] < prev["low"] and cur["close"] < cur["open"]:
        return -1
    if prev["low"] <= sup * 1.002 and cur["close"] > prev["high"] and cur["close"] > cur["open"]:
        return 1
    return 0


def _detect_turtle_soup(bars: list[dict], i: int, lookback: int = 10) -> int:
    """Breakout of prior high/low fails, price reverses. Donchian-style range."""
    if i < lookback + 3 or lookback <= 0:
        return 0
    prev_slice = bars[i - lookback : i - 1]
    prev_high = max(b["high"] for b in prev_slice)
    prev_low = min(b["low"] for b in prev_slice)
    prev, cur = bars[i - 1], bars[i]
    if prev["close"] >= prev_high * 0.998 and cur["close"] < prev_low and cur["close"] < cur["open"]:
        return -1
    if prev["close"] <= prev_low * 1.002 and cur["close"] > prev_high and cur["close"] > cur["open"]:
        return 1
    return 0


def _detect_exhaustion(bars: list[dict], i: int, lookback: int = 5) -> int:
    """High range bar then reversal."""
    if i < lookback + 2 or lookback <= 1:
        return 0
    atr_lookback = bars[i - lookback : i - 1]
    if len(atr_lookback) <= 0:
        return 0
    avg_range = sum(b["high"] - b["low"] for b in atr_lookback) / len(atr_lookback)
    cur_range = bars[i]["high"] - bars[i]["low"]
    if cur_range < avg_range * 1.5:
        return 0
    cur = bars[i]
    prev = bars[i - 1]
    if cur["high"] > prev["high"] and cur["close"] < cur["open"] and cur["close"] < prev["close"]:
        return -1
    if cur["low"] < prev["low"] and cur["close"] > cur["open"] and cur["close"] > prev["close"]:
        return 1
    return 0


def _detect_capitulation(bars: list[dict], i: int, lookback: int = 5) -> int:
    """Selling climax (sharp down then reversal up) or buying climax."""
    if i < lookback + 2:
        return 0
    cur, prev = bars[i], bars[i - 1]
    was_down = prev["close"] < prev["open"]
    sharp_down = cur["low"] < prev["low"] and cur["open"] > cur["close"]
    reversal_up = cur["close"] > (cur["high"] + cur["low"]) / 2 and cur["close"] > cur["open"]
    if was_down and sharp_down and reversal_up:
        return 1
    was_up = prev["close"] > prev["open"]
    sharp_up = cur["high"] > prev["high"] and cur["open"] < cur["close"]
    reversal_down = cur["close"] < (cur["high"] + cur["low"]) / 2 and cur["close"] < cur["open"]
    if was_up and sharp_up and reversal_down:
        return -1
    return 0


def _detect_news_spike(bars: list[dict], i: int, lookback: int = 10) -> int:
    """Large range bar, direction from close."""
    if i < lookback + 1 or lookback <= 0:
        return 0
    avg_range = sum(b["high"] - b["low"] for b in bars[i - lookback : i]) / lookback
    cur_range = bars[i]["high"] - bars[i]["low"]
    if cur_range < avg_range * 2:
        return 0
    if bars[i]["close"] > bars[i]["open"]:
        return 1
    if bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _detect_choch(bars: list[dict], i: int, lookback: int = 8) -> int:
    """Change of Character: BOS against prior trend. Prior LH/LL then bullish BOS, or prior HH/HL then bearish BOS."""
    if i < lookback * 2 + 4 or lookback <= 0:
        return 0
    prior_slice = bars[i - lookback * 2 : i - lookback]
    recent_slice = bars[i - lookback : i]
    cur = bars[i]
    swing_highs: list[float] = []
    swing_lows: list[float] = []
    for j in range(2, len(prior_slice) - 2):
        b = prior_slice[j]
        if (
            b["high"] >= (prior_slice[j - 1]["high"] if j - 1 >= 0 else 0)
            and b["high"] >= (prior_slice[j - 2]["high"] if j - 2 >= 0 else 0)
            and b["high"] >= (prior_slice[j + 1]["high"] if j + 1 < len(prior_slice) else 0)
            and b["high"] >= (prior_slice[j + 2]["high"] if j + 2 < len(prior_slice) else 0)
        ):
            swing_highs.append(b["high"])
        if (
            b["low"] <= (prior_slice[j - 1]["low"] if j - 1 >= 0 else float("inf"))
            and b["low"] <= (prior_slice[j - 2]["low"] if j - 2 >= 0 else float("inf"))
            and b["low"] <= (prior_slice[j + 1]["low"] if j + 1 < len(prior_slice) else float("inf"))
            and b["low"] <= (prior_slice[j + 2]["low"] if j + 2 < len(prior_slice) else float("inf"))
        ):
            swing_lows.append(b["low"])
    prior_first_half = prior_slice[: len(prior_slice) // 2]
    prior_second_half = prior_slice[len(prior_slice) // 2 :]
    if not prior_first_half or not prior_second_half:
        return 0
    prior_first_high = swing_highs[0] if len(swing_highs) >= 2 else max(b["high"] for b in prior_first_half)
    prior_second_high = swing_highs[-1] if len(swing_highs) >= 2 else max(b["high"] for b in prior_second_half)
    prior_first_low = swing_lows[0] if len(swing_lows) >= 2 else min(b["low"] for b in prior_first_half)
    prior_second_low = swing_lows[-1] if len(swing_lows) >= 2 else min(b["low"] for b in prior_second_half)
    recent_high = max(b["high"] for b in recent_slice) if recent_slice else 0
    recent_low = min(b["low"] for b in recent_slice) if recent_slice else float("inf")
    if prior_second_high < prior_first_high and prior_second_low < prior_first_low:
        if cur["high"] > recent_high and cur["close"] > recent_high and cur["close"] > cur["open"]:
            return 1
    if prior_second_high > prior_first_high and prior_second_low > prior_first_low:
        if cur["low"] < recent_low and cur["close"] < recent_low and cur["close"] < cur["open"]:
            return -1
    return 0


def _detect_scalp_break(bars: list[dict], i: int, lookback: int = 3) -> int:
    """Quick break of micro level (short lookback)."""
    if i < lookback + 1 or lookback <= 0:
        return 0
    prev_high = max(b["high"] for b in bars[i - lookback : i])
    prev_low = min(b["low"] for b in bars[i - lookback : i])
    cur = bars[i]
    if cur["close"] > prev_high and cur["close"] > cur["open"]:
        return 1
    if cur["close"] < prev_low and cur["close"] < cur["open"]:
        return -1
    return 0


def _detect_tight_consolidation(bars: list[dict], i: int, lookback: int = 8, consol_bars: int = 4) -> int:
    """Narrow range (small ATR ratio) then breakout."""
    if lookback <= 1 or i < lookback + consol_bars + 1:
        return 0
    consol_slice = bars[i - consol_bars : i]
    consol_range = max(b["high"] for b in consol_slice) - min(b["low"] for b in consol_slice)
    prior_bars = bars[i - lookback : i - 1]
    if len(prior_bars) <= 0:
        return 0
    avg_range = sum(b["high"] - b["low"] for b in prior_bars) / len(prior_bars)
    if avg_range <= 0 or consol_range > avg_range * 0.6:
        return 0
    upper = max(b["high"] for b in consol_slice)
    lower = min(b["low"] for b in consol_slice)
    cur = bars[i]
    if cur["close"] > upper and cur["close"] > cur["open"]:
        return 1
    if cur["close"] < lower and cur["close"] < cur["open"]:
        return -1
    return 0


def _detect_absorption(bars: list[dict], i: int, lookback: int = 10, absorb_bars: int = 5) -> int:
    """Narrow range at level with elevated volume (institutional absorption) then breakout."""
    if i < lookback + absorb_bars + 1 or absorb_bars <= 0:
        return 0
    absorb_slice = bars[i - absorb_bars : i]
    range_ = max(b["high"] for b in absorb_slice) - min(b["low"] for b in absorb_slice)
    prior_slice = bars[i - lookback : i - absorb_bars]
    prior_range = (max(b["high"] for b in prior_slice) - min(b["low"] for b in prior_slice)) if prior_slice else 0
    if prior_range <= 0 or range_ >= prior_range * 0.6:
        return 0
    absorb_vol = sum(b.get("volume", 0) for b in absorb_slice) / absorb_bars
    prior_vol = sum(b.get("volume", 0) for b in prior_slice) / len(prior_slice) if prior_slice else absorb_vol
    if prior_vol > 0 and absorb_vol < prior_vol * 1.2:
        return 0
    upper = max(b["high"] for b in absorb_slice)
    lower = min(b["low"] for b in absorb_slice)
    cur = bars[i]
    if cur["close"] > upper and cur["close"] > cur["open"]:
        return 1
    if cur["close"] < lower and cur["close"] < cur["open"]:
        return -1
    return 0


def _detect_opening_range(bars: list[dict], i: int, or_bars: int = 5) -> int:
    """Breakout of first N bars of session."""
    if i < or_bars + 1 or or_bars <= 0:
        return 0
    or_slice = bars[i - or_bars : i]
    or_high = max(b["high"] for b in or_slice)
    or_low = min(b["low"] for b in or_slice)
    cur = bars[i]
    if cur["close"] > or_high and cur["close"] > cur["open"]:
        return 1
    if cur["close"] < or_low and cur["close"] < cur["open"]:
        return -1
    return 0


def _detect_asian_range(bars: list[dict], i: int, range_bars: int = 8) -> int:
    """Breakout of early-session range."""
    if i < range_bars + 1 or range_bars <= 0:
        return 0
    range_slice = bars[i - range_bars : i]
    range_high = max(b["high"] for b in range_slice)
    range_low = min(b["low"] for b in range_slice)
    cur = bars[i]
    if cur["close"] > range_high and cur["close"] > cur["open"]:
        return 1
    if cur["close"] < range_low and cur["close"] < cur["open"]:
        return -1
    return 0


def _detect_triangle_symmetric(bars: list[dict], i: int, lookback: int = 20) -> int:
    """Symmetric triangle: converging trendlines; breakout in close direction."""
    if i < lookback + 4:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    highs = [b["high"] for b in slice_bars]
    lows = [b["low"] for b in slice_bars]
    mid = len(slice_bars) // 2
    first_high = max(highs[:mid])
    second_high = max(highs[mid:])
    first_low = min(lows[:mid])
    second_low = min(lows[mid:])
    if second_high >= first_high * 0.998 or second_low <= first_low * 1.002:
        return 0
    upper = max(highs[-5:])
    lower = min(lows[-5:])
    if bars[i]["close"] > upper and bars[i]["close"] > bars[i]["open"]:
        return 1
    if bars[i]["close"] < lower and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _detect_triangle_ascending(bars: list[dict], i: int, lookback: int = 20) -> int:
    """Ascending triangle: flat top, rising bottom; breakout up."""
    if i < lookback + 4:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    highs = [b["high"] for b in slice_bars]
    lows = [b["low"] for b in slice_bars]
    resistance = max(highs)
    res_tol = resistance * 0.003
    flat_top = sum(1 for h in highs if abs(h - resistance) <= res_tol) >= 2
    slope_l = (lows[-1] - lows[0]) / len(slice_bars)
    if not flat_top or slope_l <= 0:
        return 0
    if bars[i]["close"] > resistance and bars[i]["close"] > bars[i]["open"]:
        return 1
    return 0


def _detect_triangle_descending(bars: list[dict], i: int, lookback: int = 20) -> int:
    """Descending triangle: flat bottom, falling top; breakout down."""
    if i < lookback + 4:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    highs = [b["high"] for b in slice_bars]
    lows = [b["low"] for b in slice_bars]
    support = min(lows)
    sup_tol = support * 0.003
    flat_bottom = sum(1 for l in lows if abs(l - support) <= sup_tol) >= 2
    slope_h = (highs[-1] - highs[0]) / len(slice_bars)
    if not flat_bottom or slope_h >= 0:
        return 0
    if bars[i]["close"] < support and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _detect_flag_bull(bars: list[dict], i: int, lookback: int = 15) -> int:
    """Bull flag: strong up move, small down consolidation, breakout above flag high."""
    if i < lookback + 5:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    pole_end = int(lookback * 0.4)
    if pole_end >= len(slice_bars) - 4:
        return 0
    pole = slice_bars[: pole_end + 1]
    flag = slice_bars[pole_end:]
    pole_up = (pole[-1]["close"] - pole[0]["close"]) if pole else 0
    pole_range = max(b["high"] for b in pole) - min(b["low"] for b in pole) if pole else 0
    if pole_up <= 0 or pole_range <= 0:
        return 0
    flag_high = max(b["high"] for b in flag)
    flag_low = min(b["low"] for b in flag)
    if flag_high - flag_low >= pole_range * 0.5:
        return 0
    if bars[i]["close"] > flag_high and bars[i]["close"] > bars[i]["open"]:
        return 1
    return 0


def _detect_flag_bear(bars: list[dict], i: int, lookback: int = 15) -> int:
    """Bear flag: strong down move, small up consolidation, breakout below flag low."""
    if i < lookback + 5:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    pole_end = int(lookback * 0.4) + 1
    if pole_end >= len(slice_bars) - 4:
        return 0
    pole = slice_bars[: pole_end + 1]
    flag = slice_bars[pole_end:]
    pole_down = (pole[0]["close"] - pole[-1]["close"]) if pole else 0
    pole_range = max(b["high"] for b in pole) - min(b["low"] for b in pole) if pole else 0
    if pole_down <= 0 or pole_range <= 0:
        return 0
    flag_high = max(b["high"] for b in flag)
    flag_low = min(b["low"] for b in flag)
    if flag_high - flag_low >= pole_range * 0.5:
        return 0
    if bars[i]["close"] < flag_low and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _detect_pennant(bars: list[dict], i: int, lookback: int = 15) -> int:
    """Pennant: small symmetric triangle after strong move; breakout in trend direction."""
    if i < lookback + 5:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    mid = len(slice_bars) // 2
    first_half = slice_bars[:mid]
    second_half = slice_bars[mid:]
    move1 = (first_half[-1]["close"] - first_half[0]["close"]) if first_half else 0
    range1 = max(b["high"] for b in first_half) - min(b["low"] for b in first_half) if first_half else 0
    if range1 <= 0:
        return 0
    recent_high = max(b["high"] for b in second_half)
    recent_low = min(b["low"] for b in second_half)
    if move1 > 0 and bars[i]["close"] > recent_high and bars[i]["close"] > bars[i]["open"]:
        return 1
    if move1 < 0 and bars[i]["close"] < recent_low and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _detect_rectangle(bars: list[dict], i: int, lookback: int = 20, tolerance: float = 0.005) -> int:
    """Horizontal range; breakout above/below."""
    if i < lookback + 3:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    upper = max(b["high"] for b in slice_bars)
    lower = min(b["low"] for b in slice_bars)
    cur = bars[i]
    if cur["close"] > upper * (1 + tolerance) and cur["close"] > cur["open"]:
        return 1
    if cur["close"] < lower * (1 - tolerance) and cur["close"] < cur["open"]:
        return -1
    return 0


def _detect_gap_up(bars: list[dict], i: int, min_gap_pct: float = 0.001) -> int:
    """Current low > prior high. Continuation up = bullish."""
    if i < 2:
        return 0
    cur, prev = bars[i], bars[i - 1]
    if cur["low"] <= prev["high"] * (1 + min_gap_pct):
        return 0
    if cur["close"] > cur["open"] and cur["close"] > cur["high"] * 0.99:
        return 1
    return 0


def _detect_gap_down(bars: list[dict], i: int, min_gap_pct: float = 0.001) -> int:
    """Current high < prior low. Continuation down = bearish."""
    if i < 2:
        return 0
    cur, prev = bars[i], bars[i - 1]
    if cur["high"] >= prev["low"] * (1 - min_gap_pct):
        return 0
    if cur["close"] < cur["open"] and cur["close"] < cur["low"] * 1.01:
        return -1
    return 0


def _detect_rising_window(bars: list[dict], i: int) -> int:
    """3-candle: gap between c1 and c3, c3 bullish."""
    if i < 2:
        return 0
    c1, c3 = bars[i - 2], bars[i]
    if c1["high"] >= c3["low"]:
        return 0
    if c3["close"] > c3["open"] and c3["close"] > c3["high"] * 0.99:
        return 1
    return 0


def _detect_falling_window(bars: list[dict], i: int) -> int:
    """3-candle: gap between c1 and c3, c3 bearish."""
    if i < 2:
        return 0
    c1, c3 = bars[i - 2], bars[i]
    if c1["low"] <= c3["high"]:
        return 0
    if c3["close"] < c3["open"] and c3["close"] < c3["low"] * 1.01:
        return -1
    return 0


def _detect_bump_run(bars: list[dict], i: int, lookback: int = 25) -> int:
    """Parabolic move up then break of trendline = bearish; down then break = bullish."""
    if i < lookback + 4:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    highs = [b["high"] for b in slice_bars]
    lows = [b["low"] for b in slice_bars]
    slope_l = (lows[-1] - lows[0]) / len(slice_bars)
    slope_h = (highs[-1] - highs[0]) / len(slice_bars)
    if slope_l > 0 and slope_h > 0:
        trendline = lows[0] + slope_l * (len(slice_bars) - 1)
        if bars[i]["close"] < trendline * 0.998 and bars[i]["close"] < bars[i]["open"]:
            return -1
    elif slope_l < 0 and slope_h < 0:
        trendline = highs[0] + slope_h * (len(slice_bars) - 1)
        if bars[i]["close"] > trendline * 1.002 and bars[i]["close"] > bars[i]["open"]:
            return 1
    return 0


def _detect_elliott_impulse(bars: list[dict], i: int, lookback: int = 20) -> int:
    """Elliott impulse: 5-wave motive. Wave 2 retrace 0.382-0.618, wave 3 > wave 1. Dedicated."""
    if i < lookback + 8:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    swing_highs: list[dict] = []
    swing_lows: list[dict] = []
    for j in range(2, len(slice_bars) - 2):
        b = slice_bars[j]
        if (
            b["high"] >= slice_bars[j - 1]["high"]
            and b["high"] >= slice_bars[j - 2]["high"]
            and b["high"] >= slice_bars[j + 1]["high"]
            and b["high"] >= slice_bars[j + 2]["high"]
        ):
            swing_highs.append({"idx": j, "high": b["high"]})
        if (
            b["low"] <= slice_bars[j - 1]["low"]
            and b["low"] <= slice_bars[j - 2]["low"]
            and b["low"] <= slice_bars[j + 1]["low"]
            and b["low"] <= slice_bars[j + 2]["low"]
        ):
            swing_lows.append({"idx": j, "low": b["low"]})
    if len(swing_highs) < 3 or len(swing_lows) < 3:
        closes = [b["close"] for b in slice_bars]
        ln = max(2, len(slice_bars) // 5)
        w1 = closes[:ln]
        w2 = closes[ln : ln * 2]
        w3 = closes[ln * 2 : ln * 3]
        p0, p1 = w1[0] if w1 else 0, w1[-1] if w1 else 0
        p2, p3 = w2[-1] if w2 else 0, w3[-1] if w3 else 0
        wave1 = abs(p1 - p0)
        wave2 = abs(p2 - p1)
        wave3 = abs(p3 - p2)
        if wave1 <= 0:
            return 0
        retrace2 = wave2 / wave1
        if retrace2 < 0.382 or retrace2 > 0.618:
            return 0
        if wave3 <= wave1:
            return 0
        if p1 > p0 and p2 < p1 and p3 > p2 and bars[i]["close"] > bars[i]["open"]:
            return 1
        if p1 < p0 and p2 > p1 and p3 < p2 and bars[i]["close"] < bars[i]["open"]:
            return -1
        return 0
    sh, sl = swing_highs, swing_lows
    p0, p1 = sl[0]["low"], sh[0]["high"]
    p2, p3 = sl[1]["low"], sh[1]["high"]
    wave1 = abs(p1 - p0)
    wave2 = abs(p2 - p1)
    wave3 = abs(p3 - p2)
    if wave1 <= 0:
        return 0
    retrace2 = wave2 / wave1
    if retrace2 < 0.382 or retrace2 > 0.618:
        return 0
    if wave3 <= wave1:
        return 0
    if p1 > p0 and p2 < p1 and p3 > p2 and bars[i]["close"] > bars[i]["open"]:
        return 1
    if p1 < p0 and p2 > p1 and p3 < p2 and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _detect_elliott_abc(bars: list[dict], i: int, lookback: int = 15) -> int:
    """Elliott ABC: 3-wave correction. C = 0.618 or 1.0 of A. C completion = reversal. Dedicated."""
    if i < lookback + 6:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    closes = [b["close"] for b in slice_bars]
    lows = [b["low"] for b in slice_bars]
    highs = [b["high"] for b in slice_bars]
    mid = len(slice_bars) // 3
    leg1 = closes[:mid]
    leg2 = closes[mid : mid * 2]
    leg3 = closes[mid * 2 :]
    if len(leg1) < 2 or len(leg2) < 2 or len(leg3) < 2:
        return 0
    a_high = max(highs[j] for j in range(len(leg1)))
    a_low = min(lows[j] for j in range(len(leg1)))
    a_range = a_high - a_low
    b_high = max(highs[mid + j] for j in range(len(leg2)))
    b_low = min(lows[mid + j] for j in range(len(leg2)))
    c_start = leg2[-1] if leg2 else 0
    c_end = leg3[-1] if leg3 else 0
    if a_range <= 0:
        return 0
    a_down = (leg1[0] or 0) > (leg1[-1] or 0)
    b_up = (leg2[0] or 0) < (leg2[-1] or 0)
    c_down = c_start > c_end
    if a_down and b_up and c_down:
        c_range = abs(c_end - c_start)
        ratio = c_range / a_range
        if (0.55 <= ratio <= 0.75) or (0.9 <= ratio <= 1.1):
            if bars[i]["close"] > bars[i]["open"]:
                return 1
    a_up = (leg1[0] or 0) < (leg1[-1] or 0)
    b_down = (leg2[0] or 0) > (leg2[-1] or 0)
    c_up = c_start < c_end
    if a_up and b_down and c_up:
        c_range = abs(c_end - c_start)
        ratio = c_range / a_range
        if (0.55 <= ratio <= 0.75) or (0.9 <= ratio <= 1.1):
            if bars[i]["close"] < bars[i]["open"]:
                return -1
    return 0


def _detect_gap_fill(bars: list[dict], i: int, lookback: int = 5) -> int:
    """Price returns to fill prior gap. Bullish: gap down filled then bounce. Bearish: gap up filled then drop."""
    if i < lookback + 3:
        return 0
    cur = bars[i]
    for j in range(i - 1, max(0, i - lookback) - 1, -1):
        if j < 1:
            break
        c0, c1 = bars[j - 1], bars[j]
        gap_down = c1["high"] < c0["low"]
        gap_up = c1["low"] > c0["high"]
        if gap_down:
            gap_low = c1["high"]
            gap_high = c0["low"]
            if cur["low"] <= gap_high and cur["close"] > gap_low and cur["close"] > cur["open"]:
                return 1
        if gap_up:
            gap_low = c0["high"]
            gap_high = c1["low"]
            if cur["high"] >= gap_low and cur["close"] < gap_high and cur["close"] < cur["open"]:
                return -1
    return 0


def _detect_order_block(bars: list[dict], i: int) -> int:
    if i < 4:
        return 0
    p3, p2, prev = bars[i - 3], bars[i - 2], bars[i - 1]
    cur = bars[i]
    if p3["close"] < p3["open"] and p2["close"] > p2["open"] and prev["close"] > prev["open"]:
        move = cur["close"] - p3["low"]
        if move > (p3["high"] - p3["low"]) * 1.5:
            return 1
    if p3["close"] > p3["open"] and p2["close"] < p2["open"] and prev["close"] < prev["open"]:
        move = p3["high"] - cur["close"]
        if move > (p3["high"] - p3["low"]) * 1.5:
            return -1
    return 0


def _is_swing_high(bars: list[dict], i: int, left: int = 2, right: int = 2) -> bool:
    if i < left or i >= len(bars) - right:
        return False
    h = bars[i]["high"]
    for k in range(1, left + 1):
        if bars[i - k]["high"] >= h:
            return False
    for k in range(1, right + 1):
        if bars[i + k]["high"] >= h:
            return False
    return True


def _is_swing_low(bars: list[dict], i: int, left: int = 2, right: int = 2) -> bool:
    if i < left or i >= len(bars) - right:
        return False
    l_ = bars[i]["low"]
    for k in range(1, left + 1):
        if bars[i - k]["low"] <= l_:
            return False
    for k in range(1, right + 1):
        if bars[i + k]["low"] <= l_:
            return False
    return True


def _detect_double_top(bars: list[dict], i: int, lookback: int = 20, tolerance: float = 0.002) -> int:
    if i < lookback + 4:
        return 0
    swing_highs: list[tuple[int, float]] = []
    for j in range(max(2, i - lookback), min(i - 2, len(bars) - 2)):
        if _is_swing_high(bars, j):
            swing_highs.append((j, bars[j]["high"]))
    if len(swing_highs) < 2:
        return 0
    last_h = swing_highs[-1][1]
    prev_h = swing_highs[-2][1]
    diff = safe_div(abs(last_h - prev_h), prev_h)
    if diff <= tolerance and bars[i]["close"] < last_h:
        return -1
    return 0


def _detect_double_bottom(bars: list[dict], i: int, lookback: int = 20, tolerance: float = 0.002) -> int:
    if i < lookback + 4:
        return 0
    swing_lows: list[tuple[int, float]] = []
    for j in range(max(2, i - lookback), min(i - 2, len(bars) - 2)):
        if _is_swing_low(bars, j):
            swing_lows.append((j, bars[j]["low"]))
    if len(swing_lows) < 2:
        return 0
    last_l = swing_lows[-1][1]
    prev_l = swing_lows[-2][1]
    diff = safe_div(abs(last_l - prev_l), prev_l)
    if diff <= tolerance and bars[i]["close"] > last_l:
        return 1
    return 0


def _detect_triple_top(bars: list[dict], i: int, lookback: int = 25, tolerance: float = 0.002) -> int:
    if i < lookback + 6:
        return 0
    swing_highs: list[tuple[int, float]] = []
    for j in range(max(2, i - lookback), min(i - 2, len(bars) - 2)):
        if _is_swing_high(bars, j):
            swing_highs.append((j, bars[j]["high"]))
    if len(swing_highs) < 3:
        return 0
    a, b, c = swing_highs[-3], swing_highs[-2], swing_highs[-1]
    avg = (a[1] + b[1] + c[1]) / 3
    diff = safe_div(max(abs(a[1] - avg), abs(b[1] - avg), abs(c[1] - avg)), avg)
    if diff <= tolerance and bars[i]["close"] < c[1]:
        return -1
    return 0


def _detect_triple_bottom(bars: list[dict], i: int, lookback: int = 25, tolerance: float = 0.002) -> int:
    if i < lookback + 6:
        return 0
    swing_lows: list[tuple[int, float]] = []
    for j in range(max(2, i - lookback), min(i - 2, len(bars) - 2)):
        if _is_swing_low(bars, j):
            swing_lows.append((j, bars[j]["low"]))
    if len(swing_lows) < 3:
        return 0
    a, b, c = swing_lows[-3], swing_lows[-2], swing_lows[-1]
    avg = (a[1] + b[1] + c[1]) / 3
    diff = safe_div(max(abs(a[1] - avg), abs(b[1] - avg), abs(c[1] - avg)), avg)
    if diff <= tolerance and bars[i]["close"] > c[1]:
        return 1
    return 0


def _detect_head_and_shoulders(bars: list[dict], i: int, lookback: int = 35, tolerance: float = 0.01) -> int:
    """Head and shoulders: L shoulder, higher head, R shoulder; bearish on neckline break.
    Neckline from swing lows between shoulders and head (match frontend patternDetection)."""
    if lookback <= 0 or i < lookback + 4:
        return 0
    swing_highs: list[tuple[int, float]] = []
    swing_lows: list[tuple[int, float]] = []
    for j in range(max(2, i - lookback), min(i + 1, len(bars) - 2)):
        if _is_swing_high(bars, j):
            swing_highs.append((j, bars[j]["high"]))
        if _is_swing_low(bars, j):
            swing_lows.append((j, bars[j]["low"]))
    if len(swing_highs) < 3 or len(swing_lows) < 2:
        return 0
    ls, head, rs = swing_highs[-3], swing_highs[-2], swing_highs[-1]
    if head[1] <= ls[1] or head[1] <= rs[1]:
        return 0
    neck_low1 = next((sl for sl in swing_lows if ls[0] < sl[0] < head[0]), None)
    neck_low2 = next((sl for sl in swing_lows if head[0] < sl[0] < rs[0]), None)
    if neck_low1 is None or neck_low2 is None:
        return 0
    neckline = (neck_low1[1] + neck_low2[1]) / 2
    if bars[i]["close"] < neckline * (1 - tolerance):
        return -1
    return 0


def _detect_inverse_head_and_shoulders(bars: list[dict], i: int, lookback: int = 35, tolerance: float = 0.01) -> int:
    """Inverse H&S: L shoulder, lower head, R shoulder; bullish on neckline break.
    Neckline from swing highs between shoulders and head (match frontend)."""
    if lookback <= 0 or i < lookback + 4:
        return 0
    swing_highs: list[tuple[int, float]] = []
    swing_lows: list[tuple[int, float]] = []
    for j in range(max(2, i - lookback), min(i + 1, len(bars) - 2)):
        if _is_swing_high(bars, j):
            swing_highs.append((j, bars[j]["high"]))
        if _is_swing_low(bars, j):
            swing_lows.append((j, bars[j]["low"]))
    if len(swing_lows) < 3 or len(swing_highs) < 2:
        return 0
    ls, head, rs = swing_lows[-3], swing_lows[-2], swing_lows[-1]
    if head[1] >= ls[1] or head[1] >= rs[1]:
        return 0
    neck_high1 = next((sh for sh in swing_highs if ls[0] < sh[0] < head[0]), None)
    neck_high2 = next((sh for sh in swing_highs if head[0] < sh[0] < rs[0]), None)
    if neck_high1 is None or neck_high2 is None:
        return 0
    neckline = (neck_high1[1] + neck_high2[1]) / 2
    if bars[i]["close"] > neckline * (1 + tolerance):
        return 1
    return 0


def _detect_cup_and_handle(bars: list[dict], i: int, lookback: int = 25, cup_min_bars: int = 8) -> int:
    """U-shaped trough + handle; bullish on breakout."""
    if i < lookback + cup_min_bars or lookback <= 0 or cup_min_bars <= 0:
        return 0
    window = bars[i - lookback : i + 1]
    lows = [b["low"] for b in window]
    cup_low_idx = lows.index(min(lows))
    if cup_low_idx < cup_min_bars or cup_low_idx > len(window) - 4:
        return 0
    rim = max(window[0]["high"], window[-1]["high"])
    if window[-1]["close"] > rim:
        return 1
    return 0


def _detect_inverse_cup_and_handle(bars: list[dict], i: int, lookback: int = 25, cup_min_bars: int = 8) -> int:
    """Inverse cup; bearish on breakdown."""
    if i < lookback + cup_min_bars or lookback <= 0 or cup_min_bars <= 0:
        return 0
    window = bars[i - lookback : i + 1]
    highs = [b["high"] for b in window]
    cup_high_idx = highs.index(max(highs))
    if cup_high_idx < cup_min_bars or cup_high_idx > len(window) - 4:
        return 0
    rim = min(window[0]["low"], window[-1]["low"])
    if window[-1]["close"] < rim:
        return -1
    return 0


def _detect_broadening(bars: list[dict], i: int, lookback: int = 15) -> int:
    """Broadening: expanding range (higher highs, lower lows); reversal at extremes."""
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    highs = [b["high"] for b in slice_bars]
    lows = [b["low"] for b in slice_bars]
    mid = len(slice_bars) // 2
    first_high = max(highs[:mid])
    second_high = max(highs[mid:])
    first_low = min(lows[:mid])
    second_low = min(lows[mid:])
    if second_high > first_high and second_low < first_low:
        mid_close = slice_bars[mid]["close"]
        if bars[i]["close"] > bars[i]["open"] and bars[i]["close"] > mid_close:
            return 1
        if bars[i]["close"] < bars[i]["open"] and bars[i]["close"] < mid_close:
            return -1
    return 0


def _detect_ascending_broadening(bars: list[dict], i: int, lookback: int = 15) -> int:
    """Ascending broadening: both trendlines rising (higher highs, higher lows); breakout at extremes."""
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    highs = [b["high"] for b in slice_bars]
    lows = [b["low"] for b in slice_bars]
    mid = len(slice_bars) // 2
    first_high = max(highs[:mid])
    second_high = max(highs[mid:])
    first_low = min(lows[:mid])
    second_low = min(lows[mid:])
    if second_high <= first_high or second_low <= first_low:
        return 0
    expanding = (second_high - first_high) + (second_low - first_low) > 0
    if not expanding:
        return 0
    last_highs = highs[-3:]
    last_lows = lows[-3:]
    if bars[i]["close"] > bars[i]["open"] and bars[i]["close"] > max(last_highs):
        return 1
    if bars[i]["close"] < bars[i]["open"] and bars[i]["close"] < min(last_lows):
        return -1
    return 0


def _detect_fan_lines(bars: list[dict], i: int, lookback: int = 20) -> int:
    """Fan lines: Gann-style 1/3 and 2/3 levels from swing pivot. Pivot = first swing low."""
    if i < lookback + 4:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    swing_lows: list[dict] = []
    for j in range(2, len(slice_bars) - 2):
        b = slice_bars[j]
        if (
            b["low"] <= slice_bars[j - 1]["low"]
            and b["low"] <= slice_bars[j - 2]["low"]
            and b["low"] <= slice_bars[j + 1]["low"]
            and b["low"] <= slice_bars[j + 2]["low"]
        ):
            swing_lows.append({"idx": j, "low": b["low"]})
    pivot = swing_lows[0]["low"] if swing_lows else min(b["low"] for b in slice_bars)
    highs = [b["high"] for b in slice_bars]
    end_high = max(highs)
    range_val = end_high - pivot
    if range_val <= 0:
        return 0
    line1 = pivot + range_val * (1 / 3)
    line2 = pivot + range_val * (2 / 3)
    price = bars[i]["close"]
    tol = range_val * 0.03
    if abs(price - line1) < tol or abs(price - line2) < tol:
        if bars[i]["close"] > bars[i]["open"]:
            return 1
        if bars[i]["close"] < bars[i]["open"]:
            return -1
    return 0


def _detect_wedge_rising(bars: list[dict], i: int, lookback: int = 20) -> int:
    """Rising wedge; bearish on breakdown."""
    if i < lookback + 2:
        return 0
    window = bars[i - lookback : i + 1]
    lows = [b["low"] for b in window]
    if lows[-1] > lows[0] and bars[i]["close"] < bars[i - 1]["low"]:
        return -1
    return 0


def _detect_wedge_falling(bars: list[dict], i: int, lookback: int = 20) -> int:
    """Falling wedge; bullish on breakout."""
    if i < lookback + 2:
        return 0
    window = bars[i - lookback : i + 1]
    highs = [b["high"] for b in window]
    if highs[-1] < highs[0] and bars[i]["close"] > bars[i - 1]["high"]:
        return 1
    return 0


def _detect_rounding_bottom(bars: list[dict], i: int, lookback: int = 20) -> int:
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    closes = [b["close"] for b in slice_bars]
    mid = lookback // 2
    first, second = closes[:mid], closes[mid:]
    min_first, min_second = min(first), min(second)
    last = closes[-1]
    resistance = max(closes[:mid])
    if min_second >= min_first * 0.998 and last > resistance * 1.001 and bars[i]["close"] > bars[i]["open"]:
        return 1
    return 0


def _detect_rounding_top(bars: list[dict], i: int, lookback: int = 20) -> int:
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    closes = [b["close"] for b in slice_bars]
    mid = lookback // 2
    first, second = closes[:mid], closes[mid:]
    max_first, max_second = max(first), max(second)
    last = closes[-1]
    support = min(closes[:mid])
    if max_second <= max_first * 1.002 and last < support * 0.999 and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _detect_inside_bar(bars: list[dict], i: int) -> int:
    if i < 2:
        return 0
    cur, mother = bars[i], bars[i - 1]
    if cur["high"] >= mother["high"] or cur["low"] <= mother["low"]:
        return 0
    if cur["close"] > mother["high"] and cur["close"] > cur["open"]:
        return 1
    if cur["close"] < mother["low"] and cur["close"] < cur["open"]:
        return -1
    return 0


def _detect_outside_bar(bars: list[dict], i: int) -> int:
    if i < 2:
        return 0
    cur, prev = bars[i], bars[i - 1]
    if cur["high"] <= prev["high"] or cur["low"] >= prev["low"]:
        return 0
    if cur["close"] > cur["open"] and cur["close"] > prev["high"]:
        return 1
    if cur["close"] < cur["open"] and cur["close"] < prev["low"]:
        return -1
    return 0


def _detect_key_reversal(bars: list[dict], i: int) -> int:
    if i < 2:
        return 0
    cur, prev = bars[i], bars[i - 1]
    if cur["high"] > prev["high"] and cur["close"] < prev["close"] and cur["close"] < cur["open"]:
        return -1
    if cur["low"] < prev["low"] and cur["close"] > prev["close"] and cur["close"] > cur["open"]:
        return 1
    return 0


def _detect_island_reversal(bars: list[dict], i: int, min_gap_pct: float = 0.001) -> int:
    if i < 4:
        return 0
    cur, prev, before = bars[i], bars[i - 1], bars[i - 2]
    gap_down = prev["high"] < before["low"] * (1 - min_gap_pct)
    gap_up = prev["low"] > before["high"] * (1 + min_gap_pct)
    gap_up_after = cur["low"] > prev["high"] * (1 + min_gap_pct)
    gap_down_after = cur["high"] < prev["low"] * (1 - min_gap_pct)
    if gap_down and gap_up_after and cur["close"] > cur["open"]:
        return 1
    if gap_up and gap_down_after and cur["close"] < cur["open"]:
        return -1
    return 0


def _detect_channel_up(bars: list[dict], i: int, lookback: int = 15) -> int:
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    highs = [b["high"] for b in slice_bars]
    lows = [b["low"] for b in slice_bars]
    slope_h = (highs[-1] - highs[0]) / len(slice_bars)
    slope_l = (lows[-1] - lows[0]) / len(slice_bars)
    if slope_h <= 0 or slope_l <= 0:
        return 0
    lower_line = lows[0] + slope_l * (len(slice_bars) - 1)
    upper_line = highs[0] + slope_h * (len(slice_bars) - 1)
    price = bars[i]["close"]
    tol = (upper_line - lower_line) * 0.05
    if price <= lower_line + tol and bars[i]["close"] > bars[i]["open"]:
        return 1
    if price >= upper_line - tol and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _detect_channel_down(bars: list[dict], i: int, lookback: int = 15) -> int:
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    highs = [b["high"] for b in slice_bars]
    lows = [b["low"] for b in slice_bars]
    slope_h = (highs[-1] - highs[0]) / len(slice_bars)
    slope_l = (lows[-1] - lows[0]) / len(slice_bars)
    if slope_h >= 0 or slope_l >= 0:
        return 0
    lower_line = lows[0] + slope_l * (len(slice_bars) - 1)
    upper_line = highs[0] + slope_h * (len(slice_bars) - 1)
    price = bars[i]["close"]
    tol = (upper_line - lower_line) * 0.05
    if price <= lower_line + tol and bars[i]["close"] > bars[i]["open"]:
        return 1
    if price >= upper_line - tol and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _detect_fib_retracement(bars: list[dict], i: int, lookback: int = 18) -> int:
    """Fib retracement: buy at pullback down from swing high, sell at pullback up from swing low.
    Aligns with frontend patternDetection.detectFibRetracement (swing-based, not raw window high/low)."""
    if lookback <= 0 or i < lookback + 4:
        return 0
    swing_highs: list[dict] = []
    swing_lows: list[dict] = []
    for j in range(max(2, i - lookback), min(i - 1, len(bars) - 2)):
        if _is_swing_high(bars, j):
            swing_highs.append({"idx": j, "high": bars[j]["high"]})
        if _is_swing_low(bars, j):
            swing_lows.append({"idx": j, "low": bars[j]["low"]})
    if not swing_highs or not swing_lows:
        return 0
    sh = swing_highs[-1]
    sl = swing_lows[-1]
    price = bars[i]["close"]
    tol_pct = 0.03
    rng = sh["high"] - sl["low"]
    if rng <= 0:
        return 0
    tol = rng * tol_pct
    if sh["idx"] > sl["idx"]:
        fib382 = sh["high"] - rng * 0.382
        fib5 = sh["high"] - rng * 0.5
        fib618 = sh["high"] - rng * 0.618
        near_fib = abs(price - fib382) < tol or abs(price - fib5) < tol or abs(price - fib618) < tol
        if near_fib and bars[i]["close"] > bars[i]["open"]:
            return 1
    else:
        fib382 = sl["low"] + rng * 0.382
        fib5 = sl["low"] + rng * 0.5
        fib618 = sl["low"] + rng * 0.618
        near_fib = abs(price - fib382) < tol or abs(price - fib5) < tol or abs(price - fib618) < tol
        if near_fib and bars[i]["close"] < bars[i]["open"]:
            return -1
    return 0


def _detect_diamond(bars: list[dict], i: int, lookback: int = 24) -> int:
    """Broadening then contracting; breakout in close direction."""
    if i < lookback + 2:
        return 0
    mid = lookback // 2
    first = bars[i - lookback : i - mid]
    second = bars[i - mid : i + 1]
    r1 = max(b["high"] for b in first) - min(b["low"] for b in first)
    r2 = max(b["high"] for b in second) - min(b["low"] for b in second)
    if r1 > r2 * 1.2:
        if bars[i]["close"] > bars[i]["open"]:
            return 1
        if bars[i]["close"] < bars[i]["open"]:
            return -1
    return 0


def _detect_hh_hl(bars: list[dict], i: int, lookback: int = 5) -> int:
    """Swing-based: last two swing highs and swing lows — HH and HL."""
    if i < lookback + 4:
        return 0
    swing_highs: list[dict] = []
    swing_lows: list[dict] = []
    for j in range(max(2, i - lookback), min(i - 2, len(bars) - 2) + 1):
        if _is_swing_high(bars, j):
            swing_highs.append({"idx": j, "high": bars[j]["high"]})
        if _is_swing_low(bars, j):
            swing_lows.append({"idx": j, "low": bars[j]["low"]})
    if len(swing_highs) < 2 or len(swing_lows) < 2:
        return 0
    prev_sh, last_sh = swing_highs[-2], swing_highs[-1]
    prev_sl, last_sl = swing_lows[-2], swing_lows[-1]
    if last_sh["high"] > prev_sh["high"] and last_sl["low"] > prev_sl["low"]:
        return 1
    return 0


def _detect_lh_ll(bars: list[dict], i: int, lookback: int = 5) -> int:
    """Swing-based: last two swing highs and swing lows — LH and LL."""
    if i < lookback + 4:
        return 0
    swing_highs: list[dict] = []
    swing_lows: list[dict] = []
    for j in range(max(2, i - lookback), min(i - 2, len(bars) - 2) + 1):
        if _is_swing_high(bars, j):
            swing_highs.append({"idx": j, "high": bars[j]["high"]})
        if _is_swing_low(bars, j):
            swing_lows.append({"idx": j, "low": bars[j]["low"]})
    if len(swing_highs) < 2 or len(swing_lows) < 2:
        return 0
    prev_sh, last_sh = swing_highs[-2], swing_highs[-1]
    prev_sl, last_sl = swing_lows[-2], swing_lows[-1]
    if last_sh["high"] < prev_sh["high"] and last_sl["low"] < prev_sl["low"]:
        return -1
    return 0


def _signal_candlestick(bars: list[dict], i: int) -> int:
    """Engulfing, hammer, doji, pin bar. Ported from frontend signalCandlestick."""
    if i < 2:
        return 0
    cur = bars[i]
    prev = bars[i - 1]
    o, h, l_, c = cur["open"], cur["high"], cur["low"], cur["close"]
    body = abs(c - o)
    range_ = h - l_
    upper_wick = (h - max(o, c)) / range_ if range_ > 0 else 0
    lower_wick = (min(o, c) - l_) / range_ if range_ > 0 else 0
    body_pct = body / range_ if range_ > 0 else 0

    if body_pct < 0.1:
        if lower_wick > 0.6:
            return 1
        if upper_wick > 0.6:
            return -1
        return 0

    prev_body = abs(prev["close"] - prev["open"])
    if c > o and prev["close"] < prev["open"] and c > prev["open"] and o < prev["close"] and body > prev_body * 1.1:
        return 1
    if c < o and prev["close"] > prev["open"] and c < prev["open"] and o > prev["close"] and body > prev_body * 1.1:
        return -1

    if lower_wick >= 0.6 and body_pct <= 0.3 and upper_wick < 0.2:
        return 1
    if upper_wick >= 0.6 and body_pct <= 0.3 and lower_wick < 0.2:
        return -1

    if lower_wick >= 0.65 and body_pct <= 0.35:
        return 1
    if upper_wick >= 0.65 and body_pct <= 0.35:
        return -1
    return 0


def _signal_chart_pattern(bars: list[dict], i: int, regime: str | None, params: dict[str, float] | None) -> int:
    """Full cascade for unknown cp-* only. No proxy — returns 0 when no pattern matches. Matches TS signalChartPattern."""
    lookback = int(_p(params, "lookback", 24))
    tol = float(_p(params, "tolerance", 0.002))
    cup_min = int(_p(params, "cupMinBars", 12))
    rb = _detect_rounding_bottom(bars, i, lookback)
    if rb != 0:
        return rb
    rt = _detect_rounding_top(bars, i, lookback)
    if rt != 0:
        return rt
    ib = _detect_inside_bar(bars, i)
    if ib != 0:
        return ib
    ob = _detect_outside_bar(bars, i)
    if ob != 0:
        return ob
    kr = _detect_key_reversal(bars, i)
    if kr != 0:
        return kr
    ir = _detect_island_reversal(bars, i)
    if ir != 0:
        return ir
    cu = _detect_channel_up(bars, i, lookback)
    if cu != 0:
        return cu
    cd = _detect_channel_down(bars, i, lookback)
    if cd != 0:
        return cd
    fr = _detect_fib_retracement(bars, i, lookback)
    if fr != 0:
        return fr
    dt = _detect_double_top(bars, i, lookback, tol)
    if dt != 0:
        return dt
    db = _detect_double_bottom(bars, i, lookback, tol)
    if db != 0:
        return db
    tt = _detect_triple_top(bars, i, lookback, tol)
    if tt != 0:
        return tt
    tb = _detect_triple_bottom(bars, i, lookback, tol)
    if tb != 0:
        return tb
    hs = _detect_head_and_shoulders(bars, i, lookback)
    if hs != 0:
        return hs
    ihs = _detect_inverse_head_and_shoulders(bars, i, lookback)
    if ihs != 0:
        return ihs
    cup = _detect_cup_and_handle(bars, i, lookback, cup_min)
    if cup != 0:
        return cup
    icup = _detect_inverse_cup_and_handle(bars, i, lookback, cup_min)
    if icup != 0:
        return icup
    broad = _detect_broadening(bars, i, lookback)
    if broad != 0:
        return broad
    wedge_up = _detect_wedge_rising(bars, i, lookback)
    if wedge_up != 0:
        return wedge_up
    wedge_dn = _detect_wedge_falling(bars, i, lookback)
    if wedge_dn != 0:
        return wedge_dn
    diamond = _detect_diamond(bars, i, lookback)
    if diamond != 0:
        return diamond
    return 0


def _mfi(bars: list[dict], period: int = 14) -> list[float | None]:
    """Money Flow Index: volume-weighted RSI."""
    out: list[float | None] = [None] * len(bars)
    for i in range(period, len(bars)):
        pos_flow = neg_flow = 0.0
        for j in range(i - period + 1, i + 1):
            tp = (bars[j]["high"] + bars[j]["low"] + bars[j]["close"]) / 3
            mf = tp * (bars[j].get("volume") or 0)
            prev_tp = (bars[j - 1]["high"] + bars[j - 1]["low"] + bars[j - 1]["close"]) / 3
            if tp > prev_tp:
                pos_flow += mf
            elif tp < prev_tp:
                neg_flow += mf
        if neg_flow == 0:
            out[i] = 100.0
        else:
            out[i] = 100.0 - 100.0 / (1 + pos_flow / neg_flow)
    return out


def _signal_mfi(bars: list[dict], i: int, regime: str | None, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 14))
    ob, os = _p(params, "overbought", 80), _p(params, "oversold", 20)
    if i < period:
        return 0
    series = _mfi(bars, period)
    v = series[i] if i < len(series) else None
    if v is None:
        return 0
    if regime in ("reversal_bull", "trending_bear"):
        if v <= os:
            return 1
        if v >= ob:
            return -1
    elif regime in ("reversal_bear", "trending_bull"):
        if v >= ob:
            return -1
        if v <= os:
            return 1
    else:
        if v <= os:
            return 1
        if v >= ob:
            return -1
    return 0


def _signal_rsi(bars: list[dict], i: int, regime: str | None, params: dict[str, float] | None) -> int:
    closes = [b["close"] for b in bars]
    period = _p(params, "period", 14)
    ob, os = _p(params, "overbought", 70), _p(params, "oversold", 30)
    if i < int(period):
        return 0
    rsi_series = _rsi(closes, int(period))
    v = rsi_series[i] if i < len(rsi_series) else None
    if v is None:
        return 0
    if regime in ("reversal_bull", "trending_bear"):
        if v <= os:
            return 1
        if v >= ob:
            return -1
    elif regime in ("reversal_bear", "trending_bull"):
        if v >= ob:
            return -1
        if v <= os:
            return 1
    else:
        if v <= os:
            return 1
        if v >= ob:
            return -1
    return 0


def _signal_rsi_div(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """RSI divergence: price higher high + RSI lower high = bearish; price lower low + RSI higher low = bullish."""
    period = int(_p(params, "period", 14))
    lookback = int(_p(params, "lookback", 10))
    if i < period + lookback + 2:
        return 0
    closes = [b["close"] for b in bars]
    rsi_series = _rsi(closes, period)
    v = rsi_series[i] if i < len(rsi_series) else None
    if v is None:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    price_highs = [b["high"] for b in slice_bars]
    price_lows = [b["low"] for b in slice_bars]
    rsi_slice = [rsi_series[j] for j in range(i - lookback, min(i + 1, len(rsi_series)))]
    rsi_slice = [x for x in rsi_slice if x is not None]
    mid = lookback // 2
    pH1, pH2 = max(price_highs[:mid]) if mid else 0, max(price_highs[mid:])
    pL1, pL2 = min(price_lows[:mid]) if mid else float("inf"), min(price_lows[mid:])
    rH1 = max(rsi_slice[:mid]) if mid and rsi_slice[:mid] else 0
    rH2 = max(rsi_slice[mid:]) if rsi_slice[mid:] else 0
    rL1 = min(rsi_slice[:mid]) if mid and rsi_slice[:mid] else 100
    rL2 = min(rsi_slice[mid:]) if rsi_slice[mid:] else 100
    if pH2 > pH1 and rH2 < rH1 and bars[i]["close"] < bars[i]["open"]:
        return -1
    if pL2 < pL1 and rL2 > rL1 and bars[i]["close"] > bars[i]["open"]:
        return 1
    return 0


def _signal_rsi_overbought(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """RSI cross below 70 with bearish candle = short."""
    period = int(_p(params, "period", 14))
    ob = _p(params, "overbought", 70)
    if i < period + 2:
        return 0
    closes = [b["close"] for b in bars]
    rsi_series = _rsi(closes, period)
    prev, curr = rsi_series[i - 1], rsi_series[i]
    if prev is None or curr is None:
        return 0
    if prev >= ob and curr < ob and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_rsi_oversold(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """RSI cross above 30 with bullish candle = long."""
    period = int(_p(params, "period", 14))
    os = _p(params, "oversold", 30)
    if i < period + 2:
        return 0
    closes = [b["close"] for b in bars]
    rsi_series = _rsi(closes, period)
    prev, curr = rsi_series[i - 1], rsi_series[i]
    if prev is None or curr is None:
        return 0
    if prev <= os and curr > os and bars[i]["close"] > bars[i]["open"]:
        return 1
    return 0


def _signal_rsi_trend(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """RSI trend filter: only long when RSI > 40; only short when RSI < 60. Donchian breakout."""
    period = int(_p(params, "period", 14))
    donchian_period = int(_p(params, "donchianPeriod", 20))
    if i < max(period, donchian_period) + 2:
        return 0
    closes = [b["close"] for b in bars]
    rsi_series = _rsi(closes, period)
    v = rsi_series[i] if i < len(rsi_series) else None
    upper, lower = _donchian(bars, donchian_period)
    u, l = upper[i], lower[i]
    if v is None or u is None or l is None:
        return 0
    cur = bars[i]["close"]
    if cur >= u * 0.998 and v > 40:
        return 1
    if cur <= l * 1.002 and v < 60:
        return -1
    return 0


def _signal_macd(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    closes = [b["close"] for b in bars]
    fast = _p(params, "fast", 12)
    slow = _p(params, "slow", 26)
    sig = _p(params, "signal", 9)
    if i < int(slow) + int(sig):
        return 0
    macd_line, sig_line = _macd(closes, int(fast), int(slow), int(sig))
    pm, sm = macd_line[i - 1], sig_line[i - 1]
    cm, cs = macd_line[i], sig_line[i]
    if pm is None or sm is None or cm is None or cs is None:
        return 0
    if pm <= sm and cm > cs:
        return 1
    if pm >= sm and cm < cs:
        return -1
    return 0


def _signal_macd_hist_div(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 10))
    fast, slow, sig = int(_p(params, "fast", 12)), int(_p(params, "slow", 26)), int(_p(params, "signal", 9))
    if i < slow + sig + lookback:
        return 0
    closes = [b["close"] for b in bars]
    macd_line, sig_line = _macd(closes, fast, slow, sig)
    hist = [(macd_line[j] or 0) - (sig_line[j] or 0) for j in range(len(bars))]
    mid = lookback // 2
    pH1 = max(b["high"] for b in bars[i - lookback : i - mid])
    pH2 = max(b["high"] for b in bars[i - mid : i + 1])
    pL1 = min(b["low"] for b in bars[i - lookback : i - mid])
    pL2 = min(b["low"] for b in bars[i - mid : i + 1])
    hH1, hH2 = max(hist[i - lookback : i - mid]), max(hist[i - mid : i + 1])
    hL1, hL2 = min(hist[i - lookback : i - mid]), min(hist[i - mid : i + 1])
    if pH2 > pH1 and hH2 < hH1 and bars[i]["close"] < bars[i]["open"]:
        return -1
    if pL2 < pL1 and hL2 > hL1 and bars[i]["close"] > bars[i]["open"]:
        return 1
    return 0


def _signal_macd_zero(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    fast, slow, sig = int(_p(params, "fast", 12)), int(_p(params, "slow", 26)), int(_p(params, "signal", 9))
    if i < slow + sig + 2:
        return 0
    closes = [b["close"] for b in bars]
    macd_line, _ = _macd(closes, fast, slow, sig)
    prev, curr = macd_line[i - 1], macd_line[i]
    if prev is None or curr is None:
        return 0
    if prev <= 0 and curr > 0 and bars[i]["close"] > bars[i]["open"]:
        return 1
    if prev >= 0 and curr < 0 and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_bb_squeeze(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 20))
    if i < period + 5:
        return 0
    closes = [b["close"] for b in bars]
    bb_u, bb_l = _bollinger(closes, period, _p(params, "stdMult", 2))
    k_u, k_l = _keltner(bars, period, 10, _p(params, "keltnerMult", 2))
    was_squeezed = (bb_u[i - 1] or 0) <= (k_u[i - 1] or float("inf")) and (bb_l[i - 1] or 0) >= (k_l[i - 1] or float("-inf"))
    now_break = (bb_u[i] or 0) > (k_u[i] or 0) or (bb_l[i] or 0) < (k_l[i] or 0)
    if not was_squeezed or not now_break:
        return 0
    mid = ((bb_u[i] or 0) + (bb_l[i] or 0)) / 2
    price = closes[i]
    if price > mid and bars[i]["close"] > bars[i]["open"]:
        return 1
    if price < mid and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_bb_walk(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 20))
    lookback = int(_p(params, "lookback", 5))
    if i < period + lookback:
        return 0
    closes = [b["close"] for b in bars]
    upper, lower = _bollinger(closes, period, _p(params, "stdMult", 2))
    u, l = upper[i], lower[i]
    if u is None or l is None:
        return 0
    price = closes[i]
    prev_high = max(closes[i - lookback : i])
    prev_low = min(closes[i - lookback : i])
    first = closes[max(0, i - lookback * 2) : i - lookback]
    uptrend = len(first) > 0 and prev_high > max(first)
    downtrend = len(first) > 0 and prev_low < min(first)
    tol = (u - l) * 0.02
    if u - tol <= price <= u + tol and uptrend and bars[i]["close"] > bars[i]["open"]:
        return 1
    if l - tol <= price <= l + tol and downtrend and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_bb_reversion(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 20))
    if i < period:
        return 0
    closes = [b["close"] for b in bars]
    upper, lower = _bollinger(closes, period, _p(params, "stdMult", 2))
    u, l = upper[i], lower[i]
    if u is None or l is None:
        return 0
    price = closes[i]
    if price >= u * 0.998 and bars[i]["close"] < bars[i]["open"]:
        return -1
    if price <= l * 1.002 and bars[i]["close"] > bars[i]["open"]:
        return 1
    return 0


def _signal_stoch_overbought(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    k_period, d_period = int(_p(params, "kPeriod", 14)), int(_p(params, "dPeriod", 3))
    ob = _p(params, "overbought", 80)
    if i < k_period + d_period:
        return 0
    k, d = _stochastic(bars, k_period, d_period)
    k_cur, d_cur, k_prev = k[i], d[i], k[i - 1]
    if k_cur is None or d_cur is None or k_prev is None:
        return 0
    if k_prev >= ob and k_cur < d_cur:
        return -1
    return 0


def _signal_stoch_oversold(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    k_period, d_period = int(_p(params, "kPeriod", 14)), int(_p(params, "dPeriod", 3))
    os = _p(params, "oversold", 20)
    if i < k_period + d_period:
        return 0
    k, d = _stochastic(bars, k_period, d_period)
    k_cur, d_cur, k_prev = k[i], d[i], k[i - 1]
    if k_cur is None or d_cur is None or k_prev is None:
        return 0
    if k_prev <= os and k_cur > d_cur:
        return 1
    return 0


def _signal_stoch_div(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 10))
    k_period, d_period = int(_p(params, "kPeriod", 14)), int(_p(params, "dPeriod", 3))
    if i < k_period + d_period + lookback:
        return 0
    k, _ = _stochastic(bars, k_period, d_period)
    mid = lookback // 2
    pH1 = max(b["high"] for b in bars[i - lookback : i - mid])
    pH2 = max(b["high"] for b in bars[i - mid : i + 1])
    pL1 = min(b["low"] for b in bars[i - lookback : i - mid])
    pL2 = min(b["low"] for b in bars[i - mid : i + 1])
    k1 = [x for x in k[i - lookback : i - mid] if x is not None]
    k2 = [x for x in k[i - mid : i + 1] if x is not None]
    if not k1 or not k2:
        return 0
    kH1, kH2 = max(k1), max(k2)
    kL1, kL2 = min(k1), min(k2)
    if pH2 > pH1 and kH2 < kH1 and bars[i]["close"] < bars[i]["open"]:
        return -1
    if pL2 < pL1 and kL2 > kL1 and bars[i]["close"] > bars[i]["open"]:
        return 1
    return 0


def _signal_cci_overbought(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 20))
    ob = _p(params, "overbought", 100)
    if i < period + 1:
        return 0
    series = _cci(bars, period)
    prev, curr = series[i - 1], series[i]
    if prev is None or curr is None:
        return 0
    if prev >= ob and curr < ob and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_cci_oversold(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 20))
    os = _p(params, "oversold", -100)
    if i < period + 1:
        return 0
    series = _cci(bars, period)
    prev, curr = series[i - 1], series[i]
    if prev is None or curr is None:
        return 0
    if prev <= os and curr > os and bars[i]["close"] > bars[i]["open"]:
        return 1
    return 0


def _signal_squeeze_momentum(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 20))
    if i < period + 5:
        return 0
    closes = [b["close"] for b in bars]
    bb_u, bb_l = _bollinger(closes, period, _p(params, "stdMult", 2))
    k_u, k_l = _keltner(bars, period, 10, _p(params, "keltnerMult", 2))
    was_squeezed = (bb_u[i - 1] or 0) <= (k_u[i - 1] or float("inf")) and (bb_l[i - 1] or 0) >= (k_l[i - 1] or float("-inf"))
    now_break = (bb_u[i] or 0) > (k_u[i] or 0) or (bb_l[i] or 0) < (k_l[i] or 0)
    if not was_squeezed or not now_break:
        return 0
    if bars[i]["close"] > bars[i]["open"]:
        return 1
    if bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_vwap_anchor(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 20))
    if i < lookback + 2:
        return 0
    anchor_idx = i - 1
    anchor_low = bars[i - 1]["low"]
    for j in range(i - 2, max(0, i - lookback) - 1, -1):
        if bars[j]["low"] < anchor_low:
            anchor_low = bars[j]["low"]
            anchor_idx = j
    slice_bars = bars[anchor_idx : i + 1]
    cum_tpv = sum((b["high"] + b["low"] + b["close"]) / 3 * (b.get("volume") or 0) for b in slice_bars)
    cum_vol = sum(b.get("volume") or 0 for b in slice_bars)
    anchored_vwap = cum_tpv / cum_vol if cum_vol > 0 else bars[i]["close"]
    price = bars[i]["close"]
    tol = (bars[i]["high"] - bars[i]["low"]) * 0.1 or price * 0.001
    if abs(price - anchored_vwap) <= tol and bars[i]["close"] > bars[i]["open"]:
        return 1
    if abs(price - anchored_vwap) <= tol and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_donchian(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 20))
    if i < period:
        return 0
    upper, lower = _donchian(bars, period)
    u, l = upper[i], lower[i]
    if u is None or l is None:
        return 0
    price = bars[i]["close"]
    if price >= u:
        return 1
    if price <= l:
        return -1
    return 0


def _signal_stoch(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    k_period = int(_p(params, "kPeriod", 14))
    d_period = int(_p(params, "dPeriod", 3))
    ob = _p(params, "overbought", 80)
    os = _p(params, "oversold", 20)
    if i < k_period + d_period:
        return 0
    k, d = _stochastic(bars, k_period, d_period)
    k_cur, d_cur = k[i], d[i]
    k_prev, d_prev = k[i - 1], d[i - 1]
    if k_cur is None or d_cur is None or k_prev is None or d_prev is None:
        return 0
    if k_prev >= ob and k_cur < d_cur:
        return -1
    if k_prev <= os and k_cur > d_cur:
        return 1
    return 0


def _signal_cci(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 20))
    if i < period:
        return 0
    series = _cci(bars, period)
    v = series[i]
    if v is None:
        return 0
    if v > 100:
        return -1
    if v < -100:
        return 1
    return 0


def _signal_williams_r(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 14))
    if i < period:
        return 0
    series = _williams_r(bars, period)
    v = series[i]
    if v is None:
        return 0
    if v >= -20:
        return -1
    if v <= -80:
        return 1
    return 0


def _signal_roc(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 12))
    if i < period + 1:
        return 0
    closes = [b["close"] for b in bars]
    series = _roc(closes, period)
    v, prev = series[i], series[i - 1]
    if v is None or prev is None:
        return 0
    if prev < 0 and v > 0:
        return 1
    if prev > 0 and v < 0:
        return -1
    return 0


def _signal_adx(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 14))
    if i < period * 2:
        return 0
    adx_vals, plus_di, minus_di = _adx(bars, period)
    a, p_di, m_di = adx_vals[i], plus_di[i], minus_di[i]
    if a is None or p_di is None or m_di is None:
        return 0
    if a < 25:
        return 0
    if p_di > m_di:
        return 1
    if m_di > p_di:
        return -1
    return 0


def _signal_keltner(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    ema_p = int(_p(params, "emaPeriod", 20))
    atr_p = int(_p(params, "atrPeriod", 10))
    mult = _p(params, "mult", 2)
    if i < ema_p + atr_p:
        return 0
    upper, lower = _keltner(bars, ema_p, atr_p, mult)
    u, l = upper[i], lower[i]
    if u is None or l is None:
        return 0
    price = bars[i]["close"]
    if price >= u:
        return -1
    if price <= l:
        return 1
    return 0


def _signal_ema_cross(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    fast_p = int(_p(params, "fast", 9))
    slow_p = int(_p(params, "slow", 21))
    if i < slow_p:
        return 0
    closes = [b["close"] for b in bars]
    fast = _ema(closes, fast_p)
    slow = _ema(closes, slow_p)
    p_f, p_s = fast[i - 1], slow[i - 1]
    n_f, n_s = fast[i], slow[i]
    if p_f is None or p_s is None or n_f is None or n_s is None:
        return 0
    if p_f <= p_s and n_f > n_s:
        return 1
    if p_f >= p_s and n_f < n_s:
        return -1
    return 0


def _signal_ema_ribbon(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """EMA ribbon: multiple EMAs (8,13,21,34,55) in order; price above/below ribbon. Dedicated."""
    periods = [8, 13, 21, 34, 55]
    max_p = max(periods)
    if i < max_p:
        return 0
    closes = [b["close"] for b in bars]
    emas = [_ema(closes, p) for p in periods]
    vals = [e[i] for e in emas]
    if any(v is None for v in vals):
        return 0
    vals_f: list[float] = [float(v) for v in vals if v is not None]
    if len(vals_f) != len(periods):
        return 0
    ordered = all(vals_f[j] >= vals_f[j - 1] for j in range(1, len(vals_f)))
    ordered_down = all(vals_f[j] <= vals_f[j - 1] for j in range(1, len(vals_f)))
    price = closes[i]
    top = vals_f[-1]
    bot = vals_f[0]
    if ordered and price > top and bars[i]["close"] > bars[i]["open"]:
        return 1
    if ordered_down and price < bot and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_atr_breakout(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 14))
    mult = _p(params, "mult", 1.5)
    if i < period + 5:
        return 0
    atr_series = _atr(bars, period)
    a = atr_series[i]
    if a is None:
        return 0
    rng = bars[i]["high"] - bars[i]["low"]
    prev_close = bars[i - 1]["close"]
    if rng > a * mult and bars[i]["close"] > prev_close:
        return 1
    if rng > a * mult and bars[i]["close"] < prev_close:
        return -1
    return 0


def _signal_range_expansion(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """Narrow range (consolidation) then expansion bar; direction from close. Dedicated."""
    period = int(_p(params, "period", 14))
    mult = _p(params, "mult", 1.5)
    consol_bars = int(_p(params, "consolBars", 5))
    if i < period + consol_bars + 1 or consol_bars <= 0:
        return 0
    atr_series = _atr(bars, period)
    a = atr_series[i]
    if a is None:
        return 0
    prev_ranges = [bars[j]["high"] - bars[j]["low"] for j in range(i - consol_bars, i)]
    if len(prev_ranges) <= 0:
        return 0
    avg_prev_range = sum(prev_ranges) / len(prev_ranges)
    cur_range = bars[i]["high"] - bars[i]["low"]
    if avg_prev_range >= a * 0.8 or cur_range <= a * mult:
        return 0
    if bars[i]["close"] > bars[i]["open"]:
        return 1
    if bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_momentum_shift(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """Prior trend (HH/HL or LH/LL) reverses with expansion. Dedicated."""
    lookback = int(_p(params, "lookback", 5))
    atr_period = int(_p(params, "atrPeriod", 14))
    if i < lookback * 2 + atr_period:
        return 0
    hh = _detect_hh_hl(bars, i - 1, lookback)
    lh = _detect_lh_ll(bars, i - 1, lookback)
    atr_series = _atr(bars, atr_period)
    a = atr_series[i]
    if a is None:
        return 0
    cur_range = bars[i]["high"] - bars[i]["low"]
    if cur_range < a * 1.2:
        return 0
    if hh == 1 and bars[i]["close"] < bars[i]["open"]:
        return -1
    if lh == -1 and bars[i]["close"] > bars[i]["open"]:
        return 1
    return 0


def _signal_dynamic_sr(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """Recent swing high/low as dynamic level; bounce with confirmation. Dedicated."""
    lookback = int(_p(params, "lookback", 10))
    if i < lookback + 4:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    swing_highs: list[float] = []
    swing_lows: list[float] = []
    for j in range(2, len(slice_bars) - 2):
        b = slice_bars[j]
        if (
            b["high"] >= slice_bars[j - 1]["high"]
            and b["high"] >= slice_bars[j - 2]["high"]
            and b["high"] >= slice_bars[j + 1]["high"]
            and b["high"] >= slice_bars[j + 2]["high"]
        ):
            swing_highs.append(b["high"])
        if (
            b["low"] <= slice_bars[j - 1]["low"]
            and b["low"] <= slice_bars[j - 2]["low"]
            and b["low"] <= slice_bars[j + 1]["low"]
            and b["low"] <= slice_bars[j + 2]["low"]
        ):
            swing_lows.append(b["low"])
    if not swing_highs or not swing_lows:
        return 0
    res = min(swing_highs)
    sup = max(swing_lows)
    price = bars[i]["close"]
    range_ = res - sup
    tol = range_ * 0.02
    if price <= sup + tol and price >= sup - tol and bars[i]["close"] > bars[i]["open"]:
        return 1
    if price >= res - tol and price <= res + tol and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_atr_trail(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """ATR trailing stop: price crosses ATR trail from below (long) or above (short). Dedicated."""
    period = int(_p(params, "period", 14))
    mult = _p(params, "mult", 2)
    if i < period + 4:
        return 0
    atr_series = _atr(bars, period)
    a = atr_series[i]
    if a is None:
        return 0
    prev_slice = bars[i - 3 : i]
    prev_low = min(b["low"] for b in prev_slice)
    prev_high = max(b["high"] for b in prev_slice)
    trail_long = prev_low - a * mult
    trail_short = prev_high + a * mult
    cur = bars[i]["close"]
    prev = bars[i - 1]["close"]
    if prev <= trail_long and cur > trail_long and bars[i]["close"] > bars[i]["open"]:
        return 1
    if prev >= trail_short and cur < trail_short and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_supertrend(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """Supertrend: flip from bearish to bullish = long, bullish to bearish = short. Dedicated."""
    period = int(_p(params, "period", 10))
    mult = _p(params, "mult", 3)
    if i < period + 2:
        return 0
    _, direction = _supertrend(bars, period, mult)
    d, d_prev = direction[i], direction[i - 1]
    if d_prev == -1 and d == 1:
        return 1
    if d_prev == 1 and d == -1:
        return -1
    return 0


def _signal_parabolic(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """Parabolic SAR: flip from below price to above = short, above to below = long. Dedicated."""
    if i < 3:
        return 0
    sar = _parabolic_sar(bars)
    s, s_prev = sar[i], sar[i - 1]
    c, c_prev = bars[i]["close"], bars[i - 1]["close"]
    if s is None or s_prev is None:
        return 0
    if s_prev < c_prev and s > c:
        return -1
    if s_prev > c_prev and s < c:
        return 1
    return 0


def _signal_ichimoku_cloud(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """Ichimoku Cloud: TK cross outside kumo, or kumo breakout with TK aligned (mirrors frontend)."""
    if i < 52:
        return 0
    tenkan, kijun, senkou_a, senkou_b = _ichimoku(bars)[:4]
    t, k = tenkan[i], kijun[i]
    sa, sb = senkou_a[i], senkou_b[i]
    t_prev, k_prev = tenkan[i - 1], kijun[i - 1]
    sa_prev, sb_prev = senkou_a[i - 1], senkou_b[i - 1]
    if (
        t is None
        or k is None
        or sa is None
        or sb is None
        or t_prev is None
        or k_prev is None
        or sa_prev is None
        or sb_prev is None
    ):
        return 0
    cloud_top = max(sa, sb)
    cloud_bot = min(sa, sb)
    cloud_top_prev = max(sa_prev, sb_prev)
    cloud_bot_prev = min(sa_prev, sb_prev)
    price = bars[i]["close"]
    price_prev = bars[i - 1]["close"]

    # Classic: TK cross in the direction of the cloud
    if t_prev <= k_prev and t > k and price > cloud_top:
        return 1
    if t_prev >= k_prev and t < k and price < cloud_bot:
        return -1

    # Kumo breakout + TK stack (price was at/inside cloud last bar)
    if t > k and price > cloud_top and price_prev <= cloud_top_prev:
        return 1
    if t < k and price < cloud_bot and price_prev >= cloud_bot_prev:
        return -1

    return 0


def _signal_ichimoku_chikou(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """Ichimoku Chikou: Chikou (close shifted -26) breaks above price from 26 bars ago = long. Dedicated."""
    if i < 28:
        return 0
    closes = [b["close"] for b in bars]
    chikou_now = closes[i]
    price_26_ago = closes[i - 26]
    chikou_prev = closes[i - 1]
    price_27_ago = closes[i - 27]
    if chikou_now is None or price_26_ago is None or chikou_prev is None or price_27_ago is None:
        return 0
    if chikou_prev <= price_27_ago and chikou_now > price_26_ago:
        return 1
    if chikou_prev >= price_27_ago and chikou_now < price_26_ago:
        return -1
    return 0


def _signal_alligator(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """Alligator: Lips cross above Teeth/Jaw = long, below = short. Dedicated."""
    if i < 30:
        return 0
    jaw, teeth, lips = _alligator(bars)
    j, t, lv = jaw[i], teeth[i], lips[i]
    j_prev, t_prev, l_prev = jaw[i - 1], teeth[i - 1], lips[i - 1]
    if j is None or t is None or lv is None or j_prev is None or t_prev is None or l_prev is None:
        return 0
    if l_prev <= t_prev and lv > t and lv > j:
        return 1
    if l_prev >= t_prev and lv < t and lv < j:
        return -1
    return 0


def _signal_gator(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """Gator Oscillator: expansion (upper+lower growing) with direction. Dedicated."""
    if i < 35:
        return 0
    upper, lower = _gator_oscillator(bars)
    u, lv = upper[i], lower[i]
    u_prev, l_prev = upper[i - 1], lower[i - 1]
    jaw, teeth, lips = _alligator(bars)
    lip, teeth_val = lips[i], teeth[i]
    if u is None or lv is None or u_prev is None or l_prev is None or lip is None or teeth_val is None:
        return 0
    expanding = (u + lv) > (u_prev + l_prev)
    if not expanding:
        return 0
    if lip > teeth_val:
        return 1
    if lip < teeth_val:
        return -1
    return 0


def _signal_kst(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """Know Sure Thing: KST crosses above signal = long, below = short. Dedicated."""
    if i < 55:
        return 0
    closes = [b["close"] for b in bars]
    kst_line, signal = _kst(closes)
    k, s = kst_line[i], signal[i]
    k_prev, s_prev = kst_line[i - 1], signal[i - 1]
    if k is None or s is None or k_prev is None or s_prev is None:
        return 0
    if k_prev < s_prev and k > s:
        return 1
    if k_prev > s_prev and k < s:
        return -1
    return 0


def _signal_pvo(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """PVO: Price Volume Oscillator histogram cross of zero. Dedicated."""
    if i < 35:
        return 0
    _, _, hist = _pvo(bars)
    h, h_prev = hist[i], hist[i - 1]
    if h is None or h_prev is None:
        return 0
    if h_prev < 0 and h > 0:
        return 1
    if h_prev > 0 and h < 0:
        return -1
    return 0


def _signal_elder_impulse(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """Elder Impulse: EMA(13) trend + MACD histogram momentum. Green=both up, Red=both down. Dedicated."""
    ema_p = int(_p(params, "emaPeriod", 13))
    if i < ema_p + 30:
        return 0
    closes = [b["close"] for b in bars]
    ema13 = _ema(closes, ema_p)
    macd_line, sig_line = _macd(closes, 12, 26, 9)
    hist = [(macd_line[j] or 0) - (sig_line[j] or 0) for j in range(len(bars))]
    e, e_prev = ema13[i], ema13[i - 1]
    h, h_prev = hist[i], hist[i - 1]
    if e is None or e_prev is None:
        return 0
    if e > e_prev and h > h_prev:
        return 1
    if e < e_prev and h < h_prev:
        return -1
    return 0


def _signal_swing_index(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """Swing Index: Wilder's SI. Zero-line cross. Dedicated."""
    if i < 2:
        return 0
    si = _swing_index(bars)
    v, prev = si[i], si[i - 1]
    if v is None or prev is None:
        return 0
    if prev < 0 and v > 0:
        return 1
    if prev > 0 and v < 0:
        return -1
    return 0


def _detect_swing_high_low(bars: list[dict], i: int, lookback: int = 10) -> int:
    """Swing high/low break: break of swing point. Same logic as BOS but default lookback 10."""
    return _detect_bos(bars, i, lookback)


def _signal_custom_combo(bars: list[dict], i: int, reg: str | None, params: dict[str, float] | None) -> int:
    """Custom combo: requires customFactors or comboRules; else delegates to confluence_zone. Dedicated."""
    has_custom = params and (params.get("customFactors") is not None or params.get("comboRules") is not None)
    if not has_custom:
        return 0
    return _signal_confluence_zone(bars, i, reg, params)


def _signal_ao(bars: list[dict], i: int) -> int:
    if i < 35:
        return 0
    series = _awesome_oscillator(bars)
    v, prev = series[i], series[i - 1]
    if v is None or prev is None:
        return 0
    if prev < 0 and v > 0:
        return 1
    if prev > 0 and v < 0:
        return -1
    return 0


def _signal_adx_breakout(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """ADX crosses above threshold + price break. New trend start."""
    period = int(_p(params, "period", 14))
    threshold = _p(params, "adxThreshold", 20)
    if i < period * 2 + 2:
        return 0
    adx_vals, plus_di, minus_di = _adx(bars, period)
    a, a_prev = adx_vals[i], adx_vals[i - 1]
    p_di, m_di = plus_di[i], minus_di[i]
    if a is None or a_prev is None or p_di is None or m_di is None:
        return 0
    if a_prev >= threshold or a < threshold:
        return 0
    closes = [b["close"] for b in bars]
    cur = closes[i]
    prev_high = max(closes[i - 5 : i]) if i >= 5 else cur
    prev_low = min(closes[i - 5 : i]) if i >= 5 else cur
    if p_di > m_di and cur > prev_high and bars[i]["close"] > bars[i]["open"]:
        return 1
    if m_di > p_di and cur < prev_low and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_ac(bars: list[dict], i: int) -> int:
    """Accelerator Oscillator: AC = AO - SMA(AO,5). Zero-line cross."""
    if i < 40:
        return 0
    series = _accelerator_oscillator(bars)
    v, prev = series[i], series[i - 1]
    if v is None or prev is None:
        return 0
    if prev < 0 and v > 0:
        return 1
    if prev > 0 and v < 0:
        return -1
    return 0


def _signal_dpo(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 20))
    closes = [b["close"] for b in bars]
    series = _dpo(closes, period)
    v, prev = series[i], series[i - 1]
    if v is None or prev is None:
        return 0
    if prev < 0 and v > 0:
        return 1
    if prev > 0 and v < 0:
        return -1
    return 0


def _signal_trix(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 15))
    if i < period * 3 + 2:
        return 0
    closes = [b["close"] for b in bars]
    series = _trix(closes, period)
    v, prev = series[i], series[i - 1]
    if v is None or prev is None:
        return 0
    if prev < 0 and v > 0:
        return 1
    if prev > 0 and v < 0:
        return -1
    return 0


def _signal_bb(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    closes = [b["close"] for b in bars]
    period = _p(params, "period", 20)
    std_mult = _p(params, "stdMult", 2)
    if i < int(period):
        return 0
    upper, lower = _bollinger(closes, int(period), std_mult)
    price = closes[i]
    u, l = upper[i], lower[i]
    if u is None or l is None:
        return 0
    if price >= u:
        return -1
    if price <= l:
        return 1
    return 0


def _signal_vwap(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    if i < 2:
        return 0
    series = _vwap(bars)
    v = series[i] if i < len(series) else None
    if v is None:
        return 0
    price = bars[i]["close"]
    tol = _p(params, "tolerance", 0.001)
    if price <= v * (1 + tol) and price >= v * (1 - tol) and bars[i]["close"] > bars[i]["open"]:
        return 1
    if price <= v * (1 + tol) and price >= v * (1 - tol) and bars[i]["close"] < bars[i]["open"]:
        return -1
    if price < v * (1 - tol) and bars[i]["close"] > bars[i]["open"]:
        return 1
    if price > v * (1 + tol) and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_vwap_bands(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 20))
    std_mult = _p(params, "stdMult", 2)
    if i < period:
        return 0
    upper, lower = _vwap_bands(bars, period, std_mult)
    price = bars[i]["close"]
    u, l = upper[i], lower[i]
    if u is None or l is None:
        return 0
    if price >= u:
        return -1
    if price <= l:
        return 1
    return 0


def _signal_cmf(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 20))
    if i < period:
        return 0
    series = _cmf(bars, period)
    v, prev = series[i] if i < len(series) else None, series[i - 1] if i > 0 else None
    if v is None or prev is None:
        return 0
    if prev < 0 and v > 0:
        return 1
    if prev > 0 and v < 0:
        return -1
    return 0


def _signal_cmo(bars: list[dict], i: int, regime: str | None, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 14))
    ob, os = _p(params, "overbought", 50), _p(params, "oversold", -50)
    if i < period:
        return 0
    closes = [b["close"] for b in bars]
    series = _cmo(closes, period)
    v = series[i] if i < len(series) else None
    if v is None:
        return 0
    r = regime or "unknown"
    if r in ("reversal_bull", "trending_bear"):
        if v <= os:
            return 1
        if v >= ob:
            return -1
    elif r in ("reversal_bear", "trending_bull"):
        if v >= ob:
            return -1
        if v <= os:
            return 1
    else:
        if v <= os:
            return 1
        if v >= ob:
            return -1
    return 0


def _signal_tsi(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    long_p, short_p = int(_p(params, "longPeriod", 25)), int(_p(params, "shortPeriod", 13))
    if i < long_p + short_p:
        return 0
    closes = [b["close"] for b in bars]
    series = _tsi(closes, long_p, short_p)
    v = series[i] if i < len(series) else None
    prev = series[i - 1] if i > 0 else None
    if v is None or prev is None:
        return 0
    if prev < 0 and v > 0:
        return 1
    if prev > 0 and v < 0:
        return -1
    return 0


def _signal_ultimate_osc(bars: list[dict], i: int, regime: str | None, params: dict[str, float] | None) -> int:
    if i < 28:
        return 0
    series = _ultimate_oscillator(bars)
    v = series[i] if i < len(series) else None
    if v is None:
        return 0
    ob, os = _p(params, "overbought", 70), _p(params, "oversold", 30)
    r = regime or "unknown"
    if r in ("reversal_bull", "trending_bear"):
        if v <= os:
            return 1
        if v >= ob:
            return -1
    elif r in ("reversal_bear", "trending_bull"):
        if v >= ob:
            return -1
        if v <= os:
            return 1
    else:
        if v <= os:
            return 1
        if v >= ob:
            return -1
    return 0


def _signal_obv(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 5))
    if i < lookback + 2:
        return 0
    series = _obv(bars)
    v = series[i] if i < len(series) else None
    prev = series[i - lookback] if i >= lookback else None
    if v is None or prev is None:
        return 0
    c, c_prev = bars[i]["close"], bars[i - lookback]["close"]
    if v > prev and c < c_prev:
        return 1
    if v < prev and c > c_prev:
        return -1
    if v > prev and c > c_prev:
        return 1
    if v < prev and c < c_prev:
        return -1
    return 0


def _signal_force_index(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 2))
    if i < period + 1:
        return 0
    series = _force_index(bars, period)
    v = series[i] if i < len(series) else None
    prev = series[i - 1] if i > 0 else None
    if v is None or prev is None:
        return 0
    if prev < 0 and v > 0:
        return 1
    if prev > 0 and v < 0:
        return -1
    return 0


def _signal_eom(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 14))
    if i < period + 1:
        return 0
    series = _eom(bars, period)
    v = series[i] if i < len(series) else None
    prev = series[i - 1] if i > 0 else None
    if v is None or prev is None:
        return 0
    if prev < 0 and v > 0:
        return 1
    if prev > 0 and v < 0:
        return -1
    return 0


def _signal_vpt(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 5))
    if i < lookback + 2:
        return 0
    series = _vpt(bars)
    v = series[i] if i < len(series) else None
    prev = series[i - lookback] if i >= lookback else None
    if v is None or prev is None:
        return 0
    c, c_prev = bars[i]["close"], bars[i - lookback]["close"]
    if v > prev and c < c_prev:
        return 1
    if v < prev and c > c_prev:
        return -1
    if v > prev and c > c_prev:
        return 1
    if v < prev and c < c_prev:
        return -1
    return 0


def _signal_coppock(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    roc1, roc2 = int(_p(params, "roc1", 14)), int(_p(params, "roc2", 11))
    smooth = int(_p(params, "smooth", 10))
    if i < max(roc1, roc2) + smooth:
        return 0
    closes = [b["close"] for b in bars]
    series = _coppock(closes, roc1, roc2, smooth)
    v = series[i] if i < len(series) else None
    prev = series[i - 1] if i > 0 else None
    if v is None or prev is None:
        return 0
    if prev < 0 and v > prev and v < 0:
        return 1
    if prev > 0 and v < prev and v > 0:
        return -1
    if prev < 0 and v >= 0:
        return 1
    if prev > 0 and v <= 0:
        return -1
    return 0


def _signal_nvi_pvi(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 5))
    if i < lookback + 2:
        return 0
    nvi_s = _nvi(bars)
    pvi_s = _pvi(bars)
    nv, pv = nvi_s[i] if i < len(nvi_s) else None, pvi_s[i] if i < len(pvi_s) else None
    nv_prev = nvi_s[i - lookback] if i >= lookback else None
    pv_prev = pvi_s[i - lookback] if i >= lookback else None
    if nv is None or pv is None or nv_prev is None or pv_prev is None:
        return 0
    c, c_prev = bars[i]["close"], bars[i - lookback]["close"]
    if nv > nv_prev and c < c_prev:
        return 1
    if pv < pv_prev and c > c_prev:
        return -1
    if nv > nv_prev and pv > pv_prev and c > c_prev:
        return 1
    if nv < nv_prev and pv < pv_prev and c < c_prev:
        return -1
    return 0


def _signal_accumulation(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 5))
    if i < lookback + 2:
        return 0
    series = _accumulation_distribution(bars)
    v = series[i] if i < len(series) else None
    prev = series[i - lookback] if i >= lookback else None
    if v is None or prev is None:
        return 0
    c, c_prev = bars[i]["close"], bars[i - lookback]["close"]
    if v > prev and c < c_prev:
        return 1
    if v < prev and c > c_prev:
        return -1
    if v > prev and c > c_prev:
        return 1
    if v < prev and c < c_prev:
        return -1
    return 0


def _signal_pivot_points(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    if i < 2:
        return 0
    pivot, r1, r2, s1, s2 = _pivot_points(bars)
    price = bars[i]["close"]
    tol = _p(params, "tolerance", 0.001)
    s1v, s2v, r1v, r2v = s1[i], s2[i], r1[i], r2[i]
    if s1v is None or r1v is None:
        return 0
    if price <= s1v * (1 + tol) and price >= s2v * (1 - tol) and bars[i]["close"] > bars[i]["open"]:
        return 1
    if price >= r1v * (1 - tol) and price <= r2v * (1 + tol) and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_camarilla(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    if i < 2:
        return 0
    r4, r3, r2, r1, s1, s2, s3, s4 = _camarilla_pivots(bars)
    price = bars[i]["close"]
    tol = _p(params, "tolerance", 0.001)
    s1v, s2v, r1v, r2v = s1[i], s2[i], r1[i], r2[i]
    if s1v is None or r1v is None:
        return 0
    if price <= s1v * (1 + tol) and price >= s2v * (1 - tol) and bars[i]["close"] > bars[i]["open"]:
        return 1
    if price >= r1v * (1 - tol) and price <= r2v * (1 + tol) and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_fib_pivot(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    if i < 2:
        return 0
    pivot, r1, r2, s1, s2 = _fib_pivot(bars)
    price = bars[i]["close"]
    tol = _p(params, "tolerance", 0.001)
    s1v, s2v, r1v, r2v = s1[i], s2[i], r1[i], r2[i]
    if s1v is None or r1v is None:
        return 0
    if price <= s1v * (1 + tol) and price >= s2v * (1 - tol) and bars[i]["close"] > bars[i]["open"]:
        return 1
    if price >= r1v * (1 - tol) and price <= r2v * (1 + tol) and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_zigzag(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    thresh = _p(params, "thresholdPct", 0.001)
    if i < 5:
        return 0
    levels, is_high = _zigzag(bars, thresh)
    level = levels[i] if i < len(levels) else None
    if level is None:
        return 0
    price = bars[i]["close"]
    tol = _p(params, "tolerance", 0.002)
    if not is_high[i] and price >= level * (1 - tol) and price <= level * (1 + tol) and bars[i]["close"] > bars[i]["open"]:
        return 1
    if is_high[i] and price >= level * (1 - tol) and price <= level * (1 + tol) and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_fractals(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    if i < 5:
        return 0
    high_f, low_f = _fractals(bars)
    last_high = last_low = None
    for j in range(i - 1, -1, -1):
        if high_f[j] is not None:
            last_high = high_f[j]
            break
    for j in range(i - 1, -1, -1):
        if low_f[j] is not None:
            last_low = low_f[j]
            break
    price = bars[i]["close"]
    if last_low is not None and price > last_low * 1.001 and bars[i]["close"] > bars[i]["open"]:
        return 1
    if last_high is not None and price < last_high * 0.999 and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_fib_extension(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 10))
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    high = max(b["high"] for b in slice_bars)
    low = min(b["low"] for b in slice_bars)
    rng = high - low
    if rng <= 0:
        return 0
    price = bars[i]["close"]
    ext127_up, ext161_up = low + rng * 1.272, low + rng * 1.618
    ext127_dn, ext161_dn = high - rng * 1.272, high - rng * 1.618
    tol = rng * 0.03
    if (abs(price - ext127_up) < tol or abs(price - ext161_up) < tol) and bars[i]["close"] > bars[i]["open"]:
        return 1
    if (abs(price - ext127_dn) < tol or abs(price - ext161_dn) < tol) and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_speed_lines(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 15))
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    high = max(b["high"] for b in slice_bars)
    low = min(b["low"] for b in slice_bars)
    rng = high - low
    if rng <= 0:
        return 0
    price = bars[i]["close"]
    line13, line23 = high - rng / 3, high - (rng * 2) / 3
    line13l, line23l = low + rng / 3, low + (rng * 2) / 3
    tol = rng * 0.02
    if (abs(price - line13) < tol or abs(price - line23) < tol) and bars[i]["close"] > bars[i]["open"]:
        return 1
    if (abs(price - line13l) < tol or abs(price - line23l) < tol) and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_andrews_pitchfork(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 15))
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    highs = [b["high"] for b in slice_bars]
    lows = [b["low"] for b in slice_bars]
    pivot = (highs[0] + lows[0]) / 2
    end_h, end_l = highs[-1], lows[-1]
    median = pivot + ((end_h + end_l) / 2 - pivot) * 0.5
    price = bars[i]["close"]
    tol = abs(end_h - end_l) * 0.05
    if abs(price - median) < tol and bars[i]["close"] > bars[i]["open"]:
        return 1
    if abs(price - median) < tol and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_three_drives(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 12))
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    lows = [b["low"] for b in slice_bars]
    highs = [b["high"] for b in slice_bars]
    d1 = min(lows[:4]) if len(lows) >= 4 else None
    d2 = min(lows[4:8]) if len(lows) >= 8 else None
    d3 = min(lows[8:]) if len(lows) > 8 else None
    if d1 is not None and d2 is not None and d3 is not None and d2 > d1 and d3 > d2:
        leg1, leg2 = d2 - d1, d3 - d2
        if abs(leg2 - leg1 * 1.27) < leg1 * 0.2 and bars[i]["close"] > bars[i]["open"]:
            return 1
    h1 = max(highs[:4]) if len(highs) >= 4 else None
    h2 = max(highs[4:8]) if len(highs) >= 8 else None
    h3 = max(highs[8:]) if len(highs) > 8 else None
    if h1 is not None and h2 is not None and h3 is not None and h2 < h1 and h3 < h2:
        leg1, leg2 = h1 - h2, h2 - h3
        if abs(leg2 - leg1 * 1.27) < leg1 * 0.2 and bars[i]["close"] < bars[i]["open"]:
            return -1
    return 0


def _signal_harmonic_gartley(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 15))
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    high = max(b["high"] for b in slice_bars)
    low = min(b["low"] for b in slice_bars)
    rng = high - low
    if rng <= 0:
        return 0
    price = bars[i]["close"]
    d786, d786l = high - rng * 0.786, low + rng * 0.786
    tol = rng * 0.03
    if abs(price - d786) < tol and bars[i]["close"] > bars[i]["open"]:
        return 1
    if abs(price - d786l) < tol and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_harmonic_bat(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 15))
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    high, low = max(b["high"] for b in slice_bars), min(b["low"] for b in slice_bars)
    rng = high - low
    if rng <= 0:
        return 0
    price = bars[i]["close"]
    d886, d886l = high - rng * 0.886, low + rng * 0.886
    tol = rng * 0.03
    if abs(price - d886) < tol and bars[i]["close"] > bars[i]["open"]:
        return 1
    if abs(price - d886l) < tol and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_harmonic_butterfly(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 15))
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    high, low = max(b["high"] for b in slice_bars), min(b["low"] for b in slice_bars)
    rng = high - low
    if rng <= 0:
        return 0
    price = bars[i]["close"]
    ext127, ext1618 = low + rng * 1.27, low + rng * 1.618
    ext127d, ext1618d = high - rng * 1.27, high - rng * 1.618
    tol = rng * 0.03
    if (abs(price - ext127) < tol or abs(price - ext1618) < tol) and bars[i]["close"] > bars[i]["open"]:
        return 1
    if (abs(price - ext127d) < tol or abs(price - ext1618d) < tol) and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_harmonic_crab(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 15))
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    high, low = max(b["high"] for b in slice_bars), min(b["low"] for b in slice_bars)
    rng = high - low
    if rng <= 0:
        return 0
    price = bars[i]["close"]
    ext1618, ext1618d = low + rng * 1.618, high - rng * 1.618
    tol = rng * 0.03
    if abs(price - ext1618) < tol and bars[i]["close"] > bars[i]["open"]:
        return 1
    if abs(price - ext1618d) < tol and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_harmonic_shark(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 15))
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    high, low = max(b["high"] for b in slice_bars), min(b["low"] for b in slice_bars)
    rng = high - low
    if rng <= 0:
        return 0
    price = bars[i]["close"]
    ext141, ext224 = low + rng * 1.41, low + rng * 2.24
    ext141d, ext224d = high - rng * 1.41, high - rng * 2.24
    tol = rng * 0.04
    if (abs(price - ext141) < tol or abs(price - ext224) < tol) and bars[i]["close"] > bars[i]["open"]:
        return 1
    if (abs(price - ext141d) < tol or abs(price - ext224d) < tol) and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_harmonic_cypher(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 15))
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    high, low = max(b["high"] for b in slice_bars), min(b["low"] for b in slice_bars)
    rng = high - low
    if rng <= 0:
        return 0
    price = bars[i]["close"]
    d786, d786l = high - rng * 0.786, low + rng * 0.786
    tol = rng * 0.03
    if abs(price - d786) < tol and bars[i]["close"] > bars[i]["open"]:
        return 1
    if abs(price - d786l) < tol and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _detect_descending_broadening(bars: list[dict], i: int, lookback: int = 15) -> int:
    """Descending broadening: both trendlines falling (lower highs, lower lows); breakout at extremes."""
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    highs = [b["high"] for b in slice_bars]
    lows = [b["low"] for b in slice_bars]
    mid = len(slice_bars) // 2
    first_high = max(highs[:mid])
    second_high = max(highs[mid:])
    first_low = min(lows[:mid])
    second_low = min(lows[mid:])
    if second_high < first_high and second_low < first_low:
        last_highs = highs[-3:]
        last_lows = lows[-3:]
        if bars[i]["close"] > bars[i]["open"] and bars[i]["close"] > max(last_highs):
            return 1
        if bars[i]["close"] < bars[i]["open"] and bars[i]["close"] < min(last_lows):
            return -1
    return 0


def _signal_descending_broadening(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 18))
    return _detect_descending_broadening(bars, i, lookback)


def _signal_schiff_pitchfork(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 15))
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    pivot_idx = lookback // 3
    pivot = (slice_bars[pivot_idx]["high"] + slice_bars[pivot_idx]["low"]) / 2
    end_h, end_l = slice_bars[-1]["high"], slice_bars[-1]["low"]
    median = pivot + ((end_h + end_l) / 2 - pivot) * 0.5
    price = bars[i]["close"]
    tol = abs(end_h - end_l) * 0.05
    if abs(price - median) < tol and bars[i]["close"] > bars[i]["open"]:
        return 1
    if abs(price - median) < tol and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_wolfe_waves(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 20))
    if i < lookback + 2:
        return 0
    slice_bars = bars[i - lookback : i + 1]
    closes = [b["close"] for b in slice_bars]
    mid = len(slice_bars) // 2
    p1, p5 = min(closes[:mid]), closes[-1]
    trend = p5 > p1
    if trend and bars[i]["close"] > bars[i]["open"] and bars[i]["close"] > bars[i - 1]["high"]:
        return 1
    if not trend and bars[i]["close"] < bars[i]["open"] and bars[i]["close"] < bars[i - 1]["low"]:
        return -1
    return 0


def _signal_gann_square(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 15))
    if i < lookback + 2:
        return 0
    price = bars[i]["close"]
    base = int(price ** 0.5)
    level = base * base
    tol = price * 0.01
    if abs(price - level) < tol and bars[i]["close"] > bars[i]["open"]:
        return 1
    if abs(price - level) < tol and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_trendline_touch(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    period = int(_p(params, "period", 20))
    if i < period + 2:
        return 0
    closes = [b["close"] for b in bars]
    e = _ema(closes, period)
    v = e[i] if i < len(e) else None
    if v is None:
        return 0
    price = bars[i]["close"]
    recent = closes[max(0, i - 5) : i + 1]
    tol = (max(recent) - min(recent)) * 0.02 if recent else 0
    if abs(price - v) <= tol and bars[i]["close"] > bars[i]["open"]:
        return 1
    if abs(price - v) <= tol and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_confluence_zone(bars: list[dict], i: int, regime: str | None, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 5))
    hh = _detect_hh_hl(bars, i, lookback)
    if hh == 1:
        return 1
    lh = _detect_lh_ll(bars, i, lookback)
    if lh == -1:
        return -1
    return _detect_breakout_retest(bars, i, int(_p(params, "donchianPeriod", 20)))


def _signal_two_legged_pullback(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 10))
    if i < lookback + 2:
        return 0
    fr = _detect_fib_retracement(bars, i, lookback)
    if fr != 0:
        return fr
    return _detect_order_block(bars, i)


def _signal_run_and_gun(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    atr_period = int(_p(params, "atrPeriod", 14))
    atr_mult = _p(params, "atrMult", 1.5)
    if i < atr_period + 3:
        return 0
    atr_arr = _atr(bars, atr_period)
    ai = atr_arr[i] if i < len(atr_arr) else None
    if ai is None:
        return 0
    prev_range = bars[i - 1]["high"] - bars[i - 1]["low"]
    cur_range = bars[i]["high"] - bars[i]["low"]
    if prev_range > ai * atr_mult and cur_range < prev_range * 0.5:
        if bars[i - 1]["close"] > bars[i - 1]["open"] and bars[i]["close"] > bars[i]["open"]:
            return 1
        if bars[i - 1]["close"] < bars[i - 1]["open"] and bars[i]["close"] < bars[i]["open"]:
            return -1
    return 0


def _signal_multi_tf_alignment(
    bars: list[dict],
    i: int,
    params: dict[str, float] | None,
    signal_ctx: dict[str, Any] | None = None,
) -> int:
    fast, slow = int(_p(params, "fast", 9)), int(_p(params, "slow", 50))
    if signal_ctx:
        htf_bars = signal_ctx.get("htf_bars")
        htf_idx_list = signal_ctx.get("htf_index_by_ltf")
        if htf_bars and htf_idx_list is not None and i < len(htf_idx_list):
            htf_idx = htf_idx_list[i]
            if htf_idx >= 0 and htf_idx >= slow:
                closes_h = [b["close"] for b in htf_bars]
                f_h, s_h = _ema(closes_h, fast), _ema(closes_h, slow)
                closes_l = [b["close"] for b in bars]
                f_l, s_l = _ema(closes_l, fast), _ema(closes_l, slow)
                htf_up = (f_h[htf_idx] or 0) > (s_h[htf_idx] or 0)
                htf_dn = (f_h[htf_idx] or 0) < (s_h[htf_idx] or 0)
                pf_l, ps_l = f_l[i - 1], s_l[i - 1]
                nf_l, ns_l = f_l[i], s_l[i]
                if pf_l is None or ps_l is None or nf_l is None or ns_l is None:
                    return 0
                if htf_up and pf_l <= ps_l and nf_l > ns_l:
                    return 1
                if htf_dn and pf_l >= ps_l and nf_l < ns_l:
                    return -1
                return 0
    if i < slow + 2:
        return 0
    closes = [b["close"] for b in bars]
    f, s = _ema(closes, fast), _ema(closes, slow)
    pf, ps, nf, ns = f[i - 1], s[i - 1], f[i], s[i]
    if pf is None or ps is None or nf is None or ns is None:
        return 0
    if pf <= ps and nf > ns:
        return 1
    if pf >= ps and nf < ns:
        return -1
    return 0


def _signal_htf_bias(
    bars: list[dict],
    i: int,
    params: dict[str, float] | None,
    signal_ctx: dict[str, Any] | None = None,
) -> int:
    fast, slow = int(_p(params, "fast", 9)), int(_p(params, "slow", 50))
    if signal_ctx:
        htf_bars = signal_ctx.get("htf_bars")
        htf_idx_list = signal_ctx.get("htf_index_by_ltf")
        if htf_bars and htf_idx_list is not None and i < len(htf_idx_list):
            htf_idx = htf_idx_list[i]
            if htf_idx >= 0 and htf_idx >= slow:
                closes_h = [b["close"] for b in htf_bars]
                f_h, s_h = _ema(closes_h, fast), _ema(closes_h, slow)
                cur_h = closes_h[htf_idx]
                sf, ff = s_h[htf_idx], f_h[htf_idx]
                if sf is None or ff is None:
                    return 0
                if ff > sf and cur_h > sf and bars[i]["close"] > bars[i]["open"]:
                    return 1
                if ff < sf and cur_h < sf and bars[i]["close"] < bars[i]["open"]:
                    return -1
                return 0
    if i < slow + 2:
        return 0
    closes = [b["close"] for b in bars]
    f, s = _ema(closes, fast), _ema(closes, slow)
    cur, sf, ff = bars[i]["close"], s[i], f[i]
    if sf is None or ff is None:
        return 0
    if cur > sf and ff > sf and bars[i]["close"] > bars[i]["open"]:
        return 1
    if cur < sf and ff < sf and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_ltf_trigger(
    bars: list[dict],
    i: int,
    params: dict[str, float] | None,
    signal_ctx: dict[str, Any] | None = None,
) -> int:
    fast, slow = int(_p(params, "fast", 9)), int(_p(params, "slow", 21))
    if signal_ctx:
        htf_bars = signal_ctx.get("htf_bars")
        htf_idx_list = signal_ctx.get("htf_index_by_ltf")
        if htf_bars and htf_idx_list is not None and i < len(htf_idx_list):
            htf_idx = htf_idx_list[i]
            if htf_idx >= 0 and htf_idx >= slow:
                closes_h = [b["close"] for b in htf_bars]
                s_h = _ema(closes_h, slow)
                level = s_h[htf_idx]
                closes_l = [b["close"] for b in bars]
                f_l, s_l = _ema(closes_l, fast), _ema(closes_l, slow)
                if level is None:
                    return 0
                price = bars[i]["close"]
                tol = level * 0.002
                cross_up = (f_l[i - 1] or 0) <= (s_l[i - 1] or 0) and (f_l[i] or 0) > (s_l[i] or 0)
                cross_dn = (f_l[i - 1] or 0) >= (s_l[i - 1] or 0) and (f_l[i] or 0) < (s_l[i] or 0)
                if abs(price - level) < tol and cross_up and bars[i]["close"] > bars[i]["open"]:
                    return 1
                if abs(price - level) < tol and cross_dn and bars[i]["close"] < bars[i]["open"]:
                    return -1
                return 0
    if i < slow + 2:
        return 0
    closes = [b["close"] for b in bars]
    f, s = _ema(closes, fast), _ema(closes, slow)
    level = s[i]
    if level is None:
        return 0
    price = bars[i]["close"]
    tol = level * 0.002
    cross_up = (f[i - 1] or 0) <= (s[i - 1] or 0) and (f[i] or 0) > (s[i] or 0)
    cross_dn = (f[i - 1] or 0) >= (s[i - 1] or 0) and (f[i] or 0) < (s[i] or 0)
    if abs(price - level) < tol and cross_up and bars[i]["close"] > bars[i]["open"]:
        return 1
    if abs(price - level) < tol and cross_dn and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_auction_theory(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    atr_period = int(_p(params, "atrPeriod", 14))
    donchian_period = int(_p(params, "donchianPeriod", 20))
    if i < max(atr_period, donchian_period) + 2:
        return 0
    atr_arr = _atr(bars, atr_period)
    ai = atr_arr[i] if i < len(atr_arr) else None
    cur = bars[i]["close"]
    if ai is None:
        return 0
    vol_pct = ai / cur if cur else 0
    if vol_pct < 0.01:
        upper, lower = _donchian(bars, donchian_period)
        u, l = upper[i], lower[i]
        if u is not None and l is not None:
            if cur >= u * 0.998:
                return 1
            if cur <= l * 1.002:
                return -1
    return 0


def _signal_value_area(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """Value Area: VAH/VAL (VWAP ± ATR). Touch VAL = long, VAH = short. Dedicated."""
    if i < 2:
        return 0
    v = _vwap(bars)
    vv = v[i] if i < len(v) else None
    if vv is None:
        return 0
    atr_arr = _atr(bars, int(_p(params, "atrPeriod", 14)))
    ai = atr_arr[i] if i < len(atr_arr) else None
    if ai is None:
        return 0
    vah = vv + ai
    val = vv - ai
    price = bars[i]["close"]
    tol = ai * 0.3
    if price <= val + tol and price >= val - tol and bars[i]["close"] > bars[i]["open"]:
        return 1
    if price <= vah + tol and price >= vah - tol and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_hvn_lvn(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    if i < 2:
        return 0
    v = _vwap(bars)
    vv = v[i] if i < len(v) else None
    if vv is None:
        return 0
    atr_arr = _atr(bars, int(_p(params, "atrPeriod", 14)))
    ai = atr_arr[i] if i < len(atr_arr) else None
    if ai is None:
        return 0
    price = bars[i]["close"]
    tol = ai * 0.5
    if abs(price - vv) <= tol and bars[i]["close"] > bars[i]["open"]:
        return 1
    if abs(price - vv) <= tol and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_poc(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    if i < 2:
        return 0
    v = _vwap(bars)
    vv = v[i] if i < len(v) else None
    if vv is None:
        return 0
    price = bars[i]["close"]
    tol = (bars[i]["high"] - bars[i]["low"]) * 0.1
    if abs(price - vv) <= tol and bars[i]["close"] > bars[i]["open"]:
        return 1
    if abs(price - vv) <= tol and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_session_high_low(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    n = int(_p(params, "sessionBars", 24))
    if i < n + 2:
        return 0
    slice_bars = bars[i - n : i]
    session_high = max(b["high"] for b in slice_bars)
    session_low = min(b["low"] for b in slice_bars)
    price = bars[i]["close"]
    tol = (session_high - session_low) * 0.02
    if price <= session_low + tol and bars[i]["close"] > bars[i]["open"]:
        return 1
    if price >= session_high - tol and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_three_legged(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    """Three-legged: Fib retracement completion at 0.382/0.5/0.618. Dedicated — no fallback."""
    lookback = int(_p(params, "lookback", 15))
    return _detect_fib_retracement(bars, i, lookback)


def _signal_session_overlap(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    atr_period = int(_p(params, "atrPeriod", 14))
    atr_mult = _p(params, "atrMult", 1.5)
    if i < atr_period + 2:
        return 0
    atr_arr = _atr(bars, atr_period)
    ai = atr_arr[i] if i < len(atr_arr) else None
    if ai is None:
        return 0
    rng = bars[i]["high"] - bars[i]["low"]
    if rng > ai * atr_mult:
        return 1 if bars[i]["close"] > bars[i]["open"] else -1
    return 0


def _signal_p_shape(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 5))
    if i < lookback + 2:
        return 0
    closes = [b["close"] for b in bars]
    cur = closes[i]
    prev_high = max(closes[i - lookback : i])
    prev_low = min(closes[i - lookback : i])
    rng = bars[i]["high"] - bars[i]["low"]
    body = abs(bars[i]["close"] - bars[i]["open"])
    if body > rng * 0.7 and cur > prev_high and bars[i]["close"] > bars[i]["open"]:
        return 1
    if body > rng * 0.7 and cur < prev_low and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_b_shape(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 10))
    if i < lookback + 2:
        return 0
    closes = [b["close"] for b in bars]
    mid = lookback // 2
    first = closes[i - lookback : i - mid]
    second = closes[i - mid : i + 1]
    max1, max2 = max(first), max(second)
    min1, min2 = min(first), min(second)
    if safe_div(abs(max1 - max2), max1, eps=1.0) < 0.01 and safe_div(abs(min1 - min2), min1, eps=1.0) < 0.01:
        cur = closes[i]
        mid_price = (max1 + min1) / 2
        if cur < mid_price and bars[i]["close"] > bars[i]["open"]:
            return 1
        if cur > mid_price and bars[i]["close"] < bars[i]["open"]:
            return -1
    return 0


def _signal_double_distribution(bars: list[dict], i: int, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 20))
    if i < lookback + 2 or lookback < 2:
        return 0
    mid = lookback // 2
    first = bars[i - lookback : i - mid]
    second = bars[i - mid : i + 1]
    if not first or not second:
        return 0
    v1 = sum((b["high"] + b["low"]) / 2 for b in first) / len(first)
    v2 = sum((b["high"] + b["low"]) / 2 for b in second) / len(second)
    if v2 > v1 * 1.01 and bars[i]["close"] > bars[i]["open"]:
        return 1
    if v2 < v1 * 0.99 and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_wick_rejection(bars: list[dict], i: int) -> int:
    b = bars[i]
    rng = b["high"] - b["low"]
    if rng <= 0:
        return 0
    lower_wick = min(b["open"], b["close"]) - b["low"]
    upper_wick = b["high"] - max(b["open"], b["close"])
    if lower_wick > rng * 0.6 and bars[i]["close"] > bars[i]["open"]:
        return 1
    if upper_wick > rng * 0.6 and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_touch_and_go(bars: list[dict], i: int) -> int:
    b = bars[i]
    rng = b["high"] - b["low"]
    if rng <= 0:
        return 0
    body = abs(b["close"] - b["open"])
    lower_wick = min(b["open"], b["close"]) - b["low"]
    upper_wick = b["high"] - max(b["open"], b["close"])
    if body < rng * 0.3 and lower_wick > rng * 0.5 and bars[i]["close"] > bars[i]["open"]:
        return 1
    if body < rng * 0.3 and upper_wick > rng * 0.5 and bars[i]["close"] < bars[i]["open"]:
        return -1
    return 0


def _signal_structure(bars: list[dict], i: int, regime: str | None, params: dict[str, float] | None) -> int:
    lookback = int(_p(params, "lookback", 5))
    bb_period = int(_p(params, "bbPeriod", 20))
    donchian_period = int(_p(params, "donchianPeriod", 20))
    atr_period = int(_p(params, "atrPeriod", 14))
    if i < max(lookback + 1, bb_period, atr_period, donchian_period) + 2:
        return 0
    closes = [b["close"] for b in bars]
    cur = closes[i]
    prev_high = max(closes[i - lookback : i]) if i >= lookback else cur
    prev_low = min(closes[i - lookback : i]) if i >= lookback else cur
    r = regime or "unknown"

    if r == "trending_bull" and cur > prev_high:
        return 1
    if r == "trending_bear" and cur < prev_low:
        return -1
    if r in ("ranging", "consolidation"):
        upper, lower = _bollinger(closes, bb_period, 2)
        u, l = upper[i], lower[i]
        if u is not None and l is not None:
            if cur >= u * 0.998:
                return -1
            if cur <= l * 1.002:
                return 1
    if r == "reversal_bull":
        rsi_series = _rsi(closes, 14)
        v = rsi_series[i] if i < len(rsi_series) else None
        if v is not None and v <= 30:
            return 1
    if r == "reversal_bear":
        rsi_series = _rsi(closes, 14)
        v = rsi_series[i] if i < len(rsi_series) else None
        if v is not None and v >= 70:
            return -1
    if r == "volatile":
        atr_series = _atr(bars, atr_period)
        a = atr_series[i] if i < len(atr_series) else None
        if a is not None:
            rng = bars[i]["high"] - bars[i]["low"]
            if rng > a * 1.5:
                return 1 if bars[i]["close"] > bars[i]["open"] else -1
    if r == "breakout":
        upper, lower = _donchian(bars, donchian_period)
        u, l = upper[i], lower[i]
        if u is not None and l is not None:
            if cur >= u * 0.998:
                return 1
            if cur <= l * 1.002:
                return -1
    if r == "unknown":
        if cur > prev_high:
            return 1
        if cur < prev_low:
            return -1
    return 0


def _signal_momentum(bars: list[dict], i: int) -> int:
    if i < 1:
        return 0
    cur, prev = bars[i], bars[i - 1]
    ret_cur = (cur["close"] - cur["open"]) / cur["open"] if cur["open"] else 0
    ret_prev = (prev["close"] - prev["open"]) / prev["open"] if prev["open"] else 0
    if abs(ret_cur) <= 0.0005:
        return 0
    if ret_cur > 0 and ret_prev > 0:
        return 1
    if ret_cur < 0 and ret_prev < 0:
        return -1
    return 0


# Strategy ID to signal function. Maps strategy_id -> (signal_fn, use_regime).
# use_regime: if True, pass regime to signal; else regime ignored.
# Full mapping from frontend SIGNAL_MAP for 101% consistency.
SIGNAL_ROUTER: dict[str, tuple[str, bool]] = {
    "ind-rsi-div": ("rsi_div", False),
    "ind-rsi-overbought": ("rsi_overbought", False),
    "ind-rsi-oversold": ("rsi_oversold", False),
    "ind-rsi-trend": ("rsi_trend", False),
    "ind-macd-cross": ("macd", False),
    "ind-macd-hist-div": ("macd_hist_div", False),
    "ind-macd-zero": ("macd_zero", False),
    "ind-ema-ribbon": ("ema_ribbon", False),
    "ind-ema-cross-9-21": ("ema_cross", False),
    "ind-ema-cross-50-200": ("ema_cross", False),
    "ind-bb-squeeze": ("bb_squeeze", False),
    "ind-bb-walk": ("bb_walk", False),
    "ind-bb-reversion": ("bb_reversion", False),
    "ind-atr-breakout": ("atr_breakout", False),
    "ind-atr-trail": ("atr_trail", False),
    "ind-stoch-overbought": ("stoch_overbought", False),
    "ind-stoch-oversold": ("stoch_oversold", False),
    "ind-stoch-div": ("stoch_div", False),
    "ind-cci-overbought": ("cci_overbought", False),
    "ind-cci-oversold": ("cci_oversold", False),
    "ind-williams-r": ("williams_r", False),
    "ind-roc": ("roc", False),
    "ind-adx-trend": ("adx", False),
    "ind-adx-breakout": ("adx_breakout", False),
    "ind-keltner": ("keltner", False),
    "ind-donchian": ("donchian", False),
    "ind-ao": ("ao", False),
    "ind-ac": ("ac", False),
    "ind-dpo": ("dpo", False),
    "ind-trix": ("trix", False),
    "ind-vwap": ("vwap", False),
    "ind-vwap-bands": ("vwap_bands", False),
    "ind-vwap-anchor": ("vwap_anchor", False),
    "ind-mfi": ("mfi", True),
    "ind-cmf": ("cmf", False),
    "ind-cmo": ("cmo", True),
    "ind-tsi": ("tsi", False),
    "ind-ultimate-osc": ("ultimate_osc", True),
    "ind-kst": ("kst", False),
    "ind-pvo": ("pvo", False),
    "ind-obv-div": ("obv", False),
    "ind-obv-breakout": ("obv", False),
    "ind-force-index": ("force_index", False),
    "ind-eom": ("eom", False),
    "ind-vpt": ("vpt", False),
    "ind-nvi-pvi": ("nvi_pvi", False),
    "ind-elder-impulse": ("elder_impulse", False),
    "ind-coppock": ("coppock", False),
    "ind-swing-index": ("swing_index", False),
    "ind-accumulation": ("accumulation", False),
    "ind-supertrend": ("supertrend", False),
    "ind-parabolic": ("parabolic", False),
    "ind-ichimoku-cloud": ("ichimoku_cloud", False),
    "ind-ichimoku-chikou": ("ichimoku_chikou", False),
    "ind-pivot-points": ("pivot_points", False),
    "ind-camarilla": ("camarilla", False),
    "ind-fib-pivot": ("fib_pivot", False),
    "ind-zigzag": ("zigzag", False),
    "ind-fractals": ("fractals", False),
    "ind-alligator": ("alligator", False),
    "ind-gator": ("gator", False),
    "pa-bos": ("bos", True),
    "pa-liquidity-sweep": ("liquidity_sweep", True),
    "pa-breakout-retest": ("breakout_retest", True),
    "pa-fvg": ("fvg", True),
    "pa-order-block-bull": ("order_block_bull", False),
    "pa-order-block-bear": ("order_block_bear", False),
    "pa-higher-high-higher-low": ("hh_hl", True),
    "pa-lower-high-lower-low": ("lh_ll", True),
    "pa-fakeout": ("fakeout", True),
    "pa-equal-highs-lows": ("equal_highs_lows", True),
    "pa-sr-flip": ("sr_flip", True),
    "pa-structure-break": ("structure_break", True),
    "pa-trendline-touch": ("trendline_touch", False),
    "pa-trendline-break": ("trendline_break", True),
    "pa-swing-high-low": ("swing_high_low", True),
    "pa-imb": ("imb", True),
    "pa-mitigation-block": ("order_block", True),
    "pa-liquidity-pool": ("liquidity_pool", True),
    "pa-inducement": ("inducement", True),
    "pa-wick-rejection": ("wick_rejection", False),
    "pa-close-beyond": ("close_beyond", True),
    "pa-tight-consolidation": ("tight_consolidation", True),
    "pa-range-expansion": ("range_expansion", False),
    "pa-squeeze-momentum": ("squeeze_momentum", False),
    "pa-confluence-zone": ("confluence_zone", True),
    "pa-two-legged-pullback": ("two_legged_pullback", False),
    "pa-swing-failure": ("swing_failure", True),
    "pa-turtle-soup": ("turtle_soup", True),
    "pa-absorption": ("absorption", True),
    "pa-stop-hunt": ("stop_hunt", True),
    "pa-momentum-shift": ("momentum_shift", False),
    "pa-run-and-gun": ("run_and_gun", False),
    "pa-dynamic-sr": ("dynamic_sr", False),
    "pa-multi-tf-alignment": ("multi_tf_alignment", False),
    "pa-htf-bias": ("htf_bias", False),
    "pa-ltf-trigger": ("ltf_trigger", False),
    "pa-auction-theory": ("auction_theory", False),
    "pa-hvn-lvn": ("hvn_lvn", False),
    "pa-value-area": ("value_area", False),
    "pa-poc": ("poc", False),
    "pa-session-high-low": ("session_high_low", False),
    "pa-opening-range": ("opening_range", True),
    "pa-asian-range": ("asian_range", True),
    "pa-choch": ("choch", True),
    "pa-gap-fill": ("gap_fill", True),
    "pa-exhaustion": ("exhaustion", True),
    "pa-capitulation": ("capitulation", True),
    "pa-three-legged": ("three_legged", False),
    "pa-touch-and-go": ("touch_and_go", False),
    "pa-news-spike": ("news_spike", True),
    "pa-session-overlap": ("session_overlap", False),
    "pa-custom-combo": ("custom_combo", True),
    "pa-scalp-break": ("scalp_break", True),
    "pa-channel-touch": ("channel_touch", False),
    "pa-p-shape": ("p_shape", False),
    "pa-b-shape": ("b_shape", False),
    "pa-double-distribution": ("double_distribution", False),
    "cp-double-top": ("double_top", True),
    "cp-double-bottom": ("double_bottom", True),
    "cp-triple-top": ("triple_top", False),
    "cp-triple-bottom": ("triple_bottom", False),
    "cp-head-shoulders": ("head_and_shoulders", False),
    "cp-inverse-h-s": ("inverse_head_and_shoulders", False),
    "cp-triangle-sym": ("triangle_symmetric", True),
    "cp-triangle-asc": ("triangle_ascending", True),
    "cp-triangle-desc": ("triangle_descending", True),
    "cp-flag-bull": ("flag_bull", True),
    "cp-flag-bear": ("flag_bear", True),
    "cp-pennant": ("pennant", True),
    "cp-wedge-rising": ("wedge_rising", False),
    "cp-wedge-falling": ("wedge_falling", False),
    "cp-rectangle": ("rectangle", True),
    "cp-channel-up": ("channel_up", False),
    "cp-channel-down": ("channel_down", False),
    "cp-fib-retracement": ("fib_retracement", False),
    "cp-fib-extension": ("fib_extension", False),
    "cp-cup-handle": ("cup_and_handle", False),
    "cp-inverse-cup": ("inverse_cup_and_handle", False),
    "cp-broadening": ("broadening", False),
    "cp-diamond": ("diamond", False),
    "cp-rounding-bottom": ("rounding_bottom", False),
    "cp-rounding-top": ("rounding_top", False),
    "cp-gap-up": ("gap_up", True),
    "cp-gap-down": ("gap_down", True),
    "cp-tweezer-tops": ("tweezer_top", False),
    "cp-tweezer-bottoms": ("tweezer_bottom", False),
    "cp-rising-window": ("rising_window", True),
    "cp-falling-window": ("falling_window", True),
    "cp-bump-run": ("bump_run", True),
    "cp-fan-lines": ("fan_lines", True),
    "cp-speed-lines": ("speed_lines", False),
    "cp-andrews-pitchfork": ("andrews_pitchfork", False),
    "cp-harmonic-gartley": ("harmonic_gartley", False),
    "cp-harmonic-bat": ("harmonic_bat", False),
    "cp-harmonic-butterfly": ("harmonic_butterfly", False),
    "cp-harmonic-crab": ("harmonic_crab", False),
    "cp-harmonic-shark": ("harmonic_shark", False),
    "cp-cypher": ("harmonic_cypher", False),
    "cp-three-drives": ("three_drives", False),
    "cp-elliott-impulse": ("elliott_impulse", False),
    "cp-elliott-abc": ("elliott_abc", False),
    "cp-ascending-broadening": ("ascending_broadening", True),
    "cp-descending-broadening": ("descending_broadening", False),
    "cp-gann-square": ("gann_square", False),
    "cp-schiff-pitchfork": ("schiff_pitchfork", False),
    "cp-wolfe-waves": ("wolfe_waves", False),
    "cp-island-reversal": ("island_reversal", False),
    "cp-key-reversal": ("key_reversal", False),
    "cp-inside-bar": ("inside_bar", False),
    "cp-outside-bar": ("outside_bar", False),
}


def get_signal(
    strategy_id: str,
    bars: list[dict[str, Any]],
    i: int,
    regime: str | None,
    strategy_params: dict[str, float] | None = None,
    signal_ctx: dict[str, Any] | None = None,
) -> int:
    """
    Get signal (1=long, -1=short, 0=no trade) for strategy at bar i.
    Uses real detection logic — RSI, MACD, BB, FVG, BOS, liquidity sweep, breakout retest.
    """
    route = SIGNAL_ROUTER.get(strategy_id)
    if route is None:
        if strategy_id.startswith("cs-"):
            from .candlestick_signals import get_cs_signal
            return get_cs_signal(strategy_id, bars, i, strategy_params, _signal_candlestick)
        if strategy_id.startswith("cp-"):
            return _signal_chart_pattern(bars, i, regime, strategy_params)
        if strategy_id.startswith("ind-"):
            return _signal_rsi(bars, i, regime, strategy_params)
        if strategy_id.startswith("pa-"):
            return _signal_structure(bars, i, regime, strategy_params)
        raise ValueError(
            f"Strategy {strategy_id!r} has no signal mapping in SIGNAL_ROUTER. "
            "Registry strategies use ind-/pa-/cp-/cs- prefix. Add handler in get_signal."
        )

    sig_type, use_regime = route
    reg = regime if use_regime else None

    if sig_type == "rsi":
        return _signal_rsi(bars, i, reg, strategy_params)
    if sig_type == "rsi_div":
        return _signal_rsi_div(bars, i, strategy_params)
    if sig_type == "rsi_overbought":
        return _signal_rsi_overbought(bars, i, strategy_params)
    if sig_type == "rsi_oversold":
        return _signal_rsi_oversold(bars, i, strategy_params)
    if sig_type == "rsi_trend":
        return _signal_rsi_trend(bars, i, strategy_params)
    if sig_type == "mfi":
        return _signal_mfi(bars, i, reg, strategy_params)
    if sig_type == "macd":
        return _signal_macd(bars, i, strategy_params)
    if sig_type == "macd_hist_div":
        return _signal_macd_hist_div(bars, i, strategy_params)
    if sig_type == "macd_zero":
        return _signal_macd_zero(bars, i, strategy_params)
    if sig_type == "bb":
        return _signal_bb(bars, i, strategy_params)
    if sig_type == "bb_squeeze":
        return _signal_bb_squeeze(bars, i, strategy_params)
    if sig_type == "bb_walk":
        return _signal_bb_walk(bars, i, strategy_params)
    if sig_type == "bb_reversion":
        return _signal_bb_reversion(bars, i, strategy_params)
    if sig_type == "vwap":
        return _signal_vwap(bars, i, strategy_params)
    if sig_type == "vwap_bands":
        return _signal_vwap_bands(bars, i, strategy_params)
    if sig_type == "cmf":
        return _signal_cmf(bars, i, strategy_params)
    if sig_type == "cmo":
        return _signal_cmo(bars, i, reg, strategy_params)
    if sig_type == "tsi":
        return _signal_tsi(bars, i, strategy_params)
    if sig_type == "ultimate_osc":
        return _signal_ultimate_osc(bars, i, reg, strategy_params)
    if sig_type == "obv":
        return _signal_obv(bars, i, strategy_params)
    if sig_type == "force_index":
        return _signal_force_index(bars, i, strategy_params)
    if sig_type == "eom":
        return _signal_eom(bars, i, strategy_params)
    if sig_type == "vpt":
        return _signal_vpt(bars, i, strategy_params)
    if sig_type == "coppock":
        return _signal_coppock(bars, i, strategy_params)
    if sig_type == "nvi_pvi":
        return _signal_nvi_pvi(bars, i, strategy_params)
    if sig_type == "accumulation":
        return _signal_accumulation(bars, i, strategy_params)
    if sig_type == "pivot_points":
        return _signal_pivot_points(bars, i, strategy_params)
    if sig_type == "camarilla":
        return _signal_camarilla(bars, i, strategy_params)
    if sig_type == "fib_pivot":
        return _signal_fib_pivot(bars, i, strategy_params)
    if sig_type == "zigzag":
        return _signal_zigzag(bars, i, strategy_params)
    if sig_type == "fractals":
        return _signal_fractals(bars, i, strategy_params)
    if sig_type == "donchian":
        return _signal_donchian(bars, i, strategy_params)
    if sig_type == "structure":
        return _signal_structure(bars, i, reg, strategy_params)
    if sig_type == "fvg":
        return _detect_fvg(bars, i)
    if sig_type == "liquidity_sweep":
        lookback = int(_p(strategy_params, "lookback", 8))
        return _detect_liquidity_sweep(bars, i, lookback)
    if sig_type == "liquidity_pool":
        lookback = int(_p(strategy_params, "lookback", 14))
        return _detect_liquidity_pool(bars, i, lookback)
    if sig_type == "inducement":
        lookback = int(_p(strategy_params, "lookback", 8))
        return _detect_inducement(bars, i, lookback)
    if sig_type == "stop_hunt":
        lookback = int(_p(strategy_params, "lookback", 10))
        return _detect_stop_hunt(bars, i, lookback)
    if sig_type == "gap_fill":
        lookback = int(_p(strategy_params, "lookback", 6))
        return _detect_gap_fill(bars, i, lookback)
    if sig_type == "bos":
        lookback = int(_p(strategy_params, "lookback", 10))
        return _detect_bos(bars, i, lookback)
    if sig_type == "swing_high_low":
        lookback = int(_p(strategy_params, "lookback", 12))
        return _detect_swing_high_low(bars, i, lookback)
    if sig_type == "structure_break":
        lookback = int(_p(strategy_params, "lookback", 10))
        return _detect_structure_break(bars, i, lookback)
    if sig_type == "imb":
        fvg = _detect_fvg(bars, i)
        if fvg != 0:
            return fvg
        return _detect_order_block(bars, i)
    if sig_type == "fakeout":
        lookback = int(_p(strategy_params, "lookback", 12))
        return _detect_fakeout(bars, i, lookback)
    if sig_type == "close_beyond":
        lookback = int(_p(strategy_params, "lookback", 12))
        return _detect_close_beyond(bars, i, lookback)
    if sig_type == "equal_highs_lows":
        lookback = int(_p(strategy_params, "lookback", 18))
        tol = float(_p(strategy_params, "tolerance", 0.002))
        return _detect_equal_highs_lows(bars, i, lookback, tol)
    if sig_type == "sr_flip":
        lookback = int(_p(strategy_params, "lookback", 12))
        return _detect_sr_flip(bars, i, lookback)
    if sig_type == "trendline_break":
        lookback = int(_p(strategy_params, "lookback", 18))
        return _detect_trendline_break(bars, i, lookback)
    if sig_type == "swing_failure":
        lookback = int(_p(strategy_params, "lookback", 10))
        return _detect_swing_failure(bars, i, lookback)
    if sig_type == "turtle_soup":
        lookback = int(_p(strategy_params, "lookback", 12))
        return _detect_turtle_soup(bars, i, lookback)
    if sig_type == "exhaustion":
        lookback = int(_p(strategy_params, "lookback", 6))
        return _detect_exhaustion(bars, i, lookback)
    if sig_type == "capitulation":
        lookback = int(_p(strategy_params, "lookback", 6))
        return _detect_capitulation(bars, i, lookback)
    if sig_type == "news_spike":
        lookback = int(_p(strategy_params, "lookback", 12))
        return _detect_news_spike(bars, i, lookback)
    if sig_type == "choch":
        lookback = int(_p(strategy_params, "lookback", 10))
        return _detect_choch(bars, i, lookback)
    if sig_type == "scalp_break":
        lookback = int(_p(strategy_params, "lookback", 3))
        return _detect_scalp_break(bars, i, lookback)
    if sig_type == "tight_consolidation":
        lookback = int(_p(strategy_params, "lookback", 10))
        consol_bars = int(_p(strategy_params, "consolBars", 4))
        return _detect_tight_consolidation(bars, i, lookback, consol_bars)
    if sig_type == "absorption":
        lookback = int(_p(strategy_params, "lookback", 12))
        absorb_bars = int(_p(strategy_params, "absorbBars", 5))
        return _detect_absorption(bars, i, lookback, absorb_bars)
    if sig_type == "opening_range":
        or_bars = int(_p(strategy_params, "orBars", 5))
        return _detect_opening_range(bars, i, or_bars)
    if sig_type == "asian_range":
        range_bars = int(_p(strategy_params, "rangeBars", 8))
        return _detect_asian_range(bars, i, range_bars)
    if sig_type == "triangle_symmetric":
        lookback = int(_p(strategy_params, "lookback", 24))
        return _detect_triangle_symmetric(bars, i, lookback)
    if sig_type == "triangle_ascending":
        lookback = int(_p(strategy_params, "lookback", 24))
        return _detect_triangle_ascending(bars, i, lookback)
    if sig_type == "triangle_descending":
        lookback = int(_p(strategy_params, "lookback", 24))
        return _detect_triangle_descending(bars, i, lookback)
    if sig_type == "flag_bull":
        lookback = int(_p(strategy_params, "lookback", 18))
        return _detect_flag_bull(bars, i, lookback)
    if sig_type == "flag_bear":
        lookback = int(_p(strategy_params, "lookback", 18))
        return _detect_flag_bear(bars, i, lookback)
    if sig_type == "pennant":
        lookback = int(_p(strategy_params, "lookback", 18))
        return _detect_pennant(bars, i, lookback)
    if sig_type == "rectangle":
        lookback = int(_p(strategy_params, "lookback", 24))
        tol = float(_p(strategy_params, "tolerance", 0.005))
        return _detect_rectangle(bars, i, lookback, tol)
    if sig_type == "gap_up":
        return _detect_gap_up(bars, i)
    if sig_type == "gap_down":
        return _detect_gap_down(bars, i)
    if sig_type == "rising_window":
        return _detect_rising_window(bars, i)
    if sig_type == "falling_window":
        return _detect_falling_window(bars, i)
    if sig_type == "bump_run":
        lookback = int(_p(strategy_params, "lookback", 28))
        return _detect_bump_run(bars, i, lookback)
    if sig_type == "breakout_retest":
        period = int(_p(strategy_params, "donchianPeriod", 20))
        return _detect_breakout_retest(bars, i, period)
    if sig_type == "order_block":
        return _detect_order_block(bars, i)
    if sig_type == "order_block_bull":
        r = _detect_order_block(bars, i)
        return 1 if r == 1 else 0
    if sig_type == "order_block_bear":
        r = _detect_order_block(bars, i)
        return -1 if r == -1 else 0
    if sig_type == "candlestick":
        return _signal_candlestick(bars, i)
    if sig_type == "tweezer_top":
        from .candlestick_signals import _signal_tweezer_top
        return _signal_tweezer_top(bars, i, strategy_params)
    if sig_type == "tweezer_bottom":
        from .candlestick_signals import _signal_tweezer_bottom
        return _signal_tweezer_bottom(bars, i, strategy_params)
    if sig_type == "chart_pattern":
        return _signal_chart_pattern(bars, i, reg, strategy_params)
    if sig_type == "hh_hl":
        lookback = int(_p(strategy_params, "lookback", 10))
        return _detect_hh_hl(bars, i, lookback)
    if sig_type == "lh_ll":
        lookback = int(_p(strategy_params, "lookback", 10))
        return _detect_lh_ll(bars, i, lookback)
    if sig_type == "stoch":
        return _signal_stoch(bars, i, strategy_params)
    if sig_type == "stoch_overbought":
        return _signal_stoch_overbought(bars, i, strategy_params)
    if sig_type == "stoch_oversold":
        return _signal_stoch_oversold(bars, i, strategy_params)
    if sig_type == "stoch_div":
        return _signal_stoch_div(bars, i, strategy_params)
    if sig_type == "cci":
        return _signal_cci(bars, i, strategy_params)
    if sig_type == "cci_overbought":
        return _signal_cci_overbought(bars, i, strategy_params)
    if sig_type == "cci_oversold":
        return _signal_cci_oversold(bars, i, strategy_params)
    if sig_type == "williams_r":
        return _signal_williams_r(bars, i, strategy_params)
    if sig_type == "roc":
        return _signal_roc(bars, i, strategy_params)
    if sig_type == "adx":
        return _signal_adx(bars, i, strategy_params)
    if sig_type == "adx_breakout":
        return _signal_adx_breakout(bars, i, strategy_params)
    if sig_type == "ac":
        return _signal_ac(bars, i)
    if sig_type == "keltner":
        return _signal_keltner(bars, i, strategy_params)
    if sig_type == "ema_cross":
        return _signal_ema_cross(bars, i, strategy_params)
    if sig_type == "ema_ribbon":
        return _signal_ema_ribbon(bars, i, strategy_params)
    if sig_type == "atr_breakout":
        return _signal_atr_breakout(bars, i, strategy_params)
    if sig_type == "atr_trail":
        return _signal_atr_trail(bars, i, strategy_params)
    if sig_type == "supertrend":
        return _signal_supertrend(bars, i, strategy_params)
    if sig_type == "parabolic":
        return _signal_parabolic(bars, i, strategy_params)
    if sig_type == "ichimoku_cloud":
        return _signal_ichimoku_cloud(bars, i, strategy_params)
    if sig_type == "ichimoku_chikou":
        return _signal_ichimoku_chikou(bars, i, strategy_params)
    if sig_type == "alligator":
        return _signal_alligator(bars, i, strategy_params)
    if sig_type == "gator":
        return _signal_gator(bars, i, strategy_params)
    if sig_type == "kst":
        return _signal_kst(bars, i, strategy_params)
    if sig_type == "pvo":
        return _signal_pvo(bars, i, strategy_params)
    if sig_type == "elder_impulse":
        return _signal_elder_impulse(bars, i, strategy_params)
    if sig_type == "swing_index":
        return _signal_swing_index(bars, i, strategy_params)
    if sig_type == "range_expansion":
        return _signal_range_expansion(bars, i, strategy_params)
    if sig_type == "momentum_shift":
        return _signal_momentum_shift(bars, i, strategy_params)
    if sig_type == "dynamic_sr":
        return _signal_dynamic_sr(bars, i, strategy_params)
    if sig_type == "ao":
        return _signal_ao(bars, i)
    if sig_type == "dpo":
        return _signal_dpo(bars, i, strategy_params)
    if sig_type == "trix":
        return _signal_trix(bars, i, strategy_params)
    if sig_type == "double_top":
        lookback = int(_p(strategy_params, "lookback", 28))
        tol = float(_p(strategy_params, "tolerance", 0.002))
        return _detect_double_top(bars, i, lookback, tol)
    if sig_type == "double_bottom":
        lookback = int(_p(strategy_params, "lookback", 28))
        tol = float(_p(strategy_params, "tolerance", 0.002))
        return _detect_double_bottom(bars, i, lookback, tol)
    if sig_type == "double_top_bottom":
        lookback = int(_p(strategy_params, "lookback", 28))
        tol = float(_p(strategy_params, "tolerance", 0.002))
        dt = _detect_double_top(bars, i, lookback, tol)
        if dt != 0:
            return dt
        return _detect_double_bottom(bars, i, lookback, tol)
    if sig_type == "triple_top":
        lookback = int(_p(strategy_params, "lookback", 28))
        tol = float(_p(strategy_params, "tolerance", 0.002))
        return _detect_triple_top(bars, i, lookback, tol)
    if sig_type == "triple_bottom":
        lookback = int(_p(strategy_params, "lookback", 28))
        tol = float(_p(strategy_params, "tolerance", 0.002))
        return _detect_triple_bottom(bars, i, lookback, tol)
    if sig_type == "triple_top_bottom":
        lookback = int(_p(strategy_params, "lookback", 28))
        tol = float(_p(strategy_params, "tolerance", 0.002))
        tt = _detect_triple_top(bars, i, lookback, tol)
        if tt != 0:
            return tt
        return _detect_triple_bottom(bars, i, lookback, tol)
    if sig_type == "head_and_shoulders":
        lookback = int(_p(strategy_params, "lookback", 35))
        return _detect_head_and_shoulders(bars, i, lookback)
    if sig_type == "inverse_head_and_shoulders":
        lookback = int(_p(strategy_params, "lookback", 35))
        return _detect_inverse_head_and_shoulders(bars, i, lookback)
    if sig_type == "wedge_rising":
        lookback = int(_p(strategy_params, "lookback", 22))
        return _detect_wedge_rising(bars, i, lookback)
    if sig_type == "wedge_falling":
        lookback = int(_p(strategy_params, "lookback", 22))
        return _detect_wedge_falling(bars, i, lookback)
    if sig_type == "cup_and_handle":
        lookback = int(_p(strategy_params, "lookback", 35))
        cup_min = int(_p(strategy_params, "cupMinBars", 12))
        return _detect_cup_and_handle(bars, i, lookback, cup_min)
    if sig_type == "inverse_cup_and_handle":
        lookback = int(_p(strategy_params, "lookback", 35))
        cup_min = int(_p(strategy_params, "cupMinBars", 12))
        return _detect_inverse_cup_and_handle(bars, i, lookback, cup_min)
    if sig_type == "broadening":
        lookback = int(_p(strategy_params, "lookback", 18))
        return _detect_broadening(bars, i, lookback)
    if sig_type == "diamond":
        lookback = int(_p(strategy_params, "lookback", 28))
        return _detect_diamond(bars, i, lookback)
    if sig_type == "rounding_bottom":
        return _detect_rounding_bottom(bars, i, int(_p(strategy_params, "lookback", 22)))
    if sig_type == "rounding_top":
        return _detect_rounding_top(bars, i, int(_p(strategy_params, "lookback", 22)))
    if sig_type == "inside_bar":
        return _detect_inside_bar(bars, i)
    if sig_type == "outside_bar":
        return _detect_outside_bar(bars, i)
    if sig_type == "key_reversal":
        return _detect_key_reversal(bars, i)
    if sig_type == "island_reversal":
        return _detect_island_reversal(bars, i)
    if sig_type == "channel_up":
        return _detect_channel_up(bars, i, int(_p(strategy_params, "lookback", 18)))
    if sig_type == "channel_down":
        return _detect_channel_down(bars, i, int(_p(strategy_params, "lookback", 18)))
    if sig_type == "fib_retracement":
        return _detect_fib_retracement(bars, i, int(_p(strategy_params, "lookback", 18)))
    if sig_type == "fib_extension":
        return _signal_fib_extension(bars, i, strategy_params)
    if sig_type == "speed_lines":
        return _signal_speed_lines(bars, i, strategy_params)
    if sig_type == "andrews_pitchfork":
        return _signal_andrews_pitchfork(bars, i, strategy_params)
    if sig_type == "harmonic_gartley":
        return _signal_harmonic_gartley(bars, i, strategy_params)
    if sig_type == "harmonic_bat":
        return _signal_harmonic_bat(bars, i, strategy_params)
    if sig_type == "harmonic_butterfly":
        return _signal_harmonic_butterfly(bars, i, strategy_params)
    if sig_type == "harmonic_crab":
        return _signal_harmonic_crab(bars, i, strategy_params)
    if sig_type == "harmonic_shark":
        return _signal_harmonic_shark(bars, i, strategy_params)
    if sig_type == "harmonic_cypher":
        return _signal_harmonic_cypher(bars, i, strategy_params)
    if sig_type == "three_drives":
        return _signal_three_drives(bars, i, strategy_params)
    if sig_type == "elliott_impulse":
        lookback = int(_p(strategy_params, "lookback", 20))
        return _detect_elliott_impulse(bars, i, lookback)
    if sig_type == "elliott_abc":
        lookback = int(_p(strategy_params, "lookback", 15))
        return _detect_elliott_abc(bars, i, lookback)
    if sig_type == "fan_lines":
        lookback = int(_p(strategy_params, "lookback", 22))
        return _detect_fan_lines(bars, i, lookback)
    if sig_type == "ascending_broadening":
        lookback = int(_p(strategy_params, "lookback", 18))
        return _detect_ascending_broadening(bars, i, lookback)
    if sig_type == "descending_broadening":
        return _signal_descending_broadening(bars, i, strategy_params)
    if sig_type == "gann_square":
        return _signal_gann_square(bars, i, strategy_params)
    if sig_type == "schiff_pitchfork":
        return _signal_schiff_pitchfork(bars, i, strategy_params)
    if sig_type == "wolfe_waves":
        return _signal_wolfe_waves(bars, i, strategy_params)
    if sig_type == "trendline_touch":
        return _signal_trendline_touch(bars, i, strategy_params)
    if sig_type == "confluence_zone":
        return _signal_confluence_zone(bars, i, reg, strategy_params)
    if sig_type == "custom_combo":
        return _signal_custom_combo(bars, i, reg, strategy_params)
    if sig_type == "two_legged_pullback":
        return _signal_two_legged_pullback(bars, i, strategy_params)
    if sig_type == "run_and_gun":
        return _signal_run_and_gun(bars, i, strategy_params)
    if sig_type == "multi_tf_alignment":
        return _signal_multi_tf_alignment(bars, i, strategy_params, signal_ctx)
    if sig_type == "htf_bias":
        return _signal_htf_bias(bars, i, strategy_params, signal_ctx)
    if sig_type == "ltf_trigger":
        return _signal_ltf_trigger(bars, i, strategy_params, signal_ctx)
    if sig_type == "auction_theory":
        return _signal_auction_theory(bars, i, strategy_params)
    if sig_type == "hvn_lvn":
        return _signal_hvn_lvn(bars, i, strategy_params)
    if sig_type == "value_area":
        return _signal_value_area(bars, i, strategy_params)
    if sig_type == "poc":
        return _signal_poc(bars, i, strategy_params)
    if sig_type == "session_high_low":
        return _signal_session_high_low(bars, i, strategy_params)
    if sig_type == "three_legged":
        return _signal_three_legged(bars, i, strategy_params)
    if sig_type == "session_overlap":
        return _signal_session_overlap(bars, i, strategy_params)
    if sig_type == "channel_touch":
        cu = _detect_channel_up(bars, i, int(_p(strategy_params, "lookback", 15)))
        return cu if cu != 0 else _detect_channel_down(bars, i, int(_p(strategy_params, "lookback", 15)))
    if sig_type == "p_shape":
        return _signal_p_shape(bars, i, strategy_params)
    if sig_type == "b_shape":
        return _signal_b_shape(bars, i, strategy_params)
    if sig_type == "double_distribution":
        return _signal_double_distribution(bars, i, strategy_params)
    if sig_type == "wick_rejection":
        return _signal_wick_rejection(bars, i)
    if sig_type == "touch_and_go":
        return _signal_touch_and_go(bars, i)
    if sig_type == "squeeze_momentum":
        return _signal_squeeze_momentum(bars, i, strategy_params)
    if sig_type == "vwap_anchor":
        return _signal_vwap_anchor(bars, i, strategy_params)

    raise ValueError(f"Unknown sig_type {sig_type!r} for strategy {strategy_id!r} — add handler in get_signal")
