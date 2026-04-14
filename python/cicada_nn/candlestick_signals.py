"""
Individual candlestick pattern signal functions for Python backend.
Mirrors src/app/core/candlestickSignals.ts for server-side backtest parity.
"""

from __future__ import annotations

from typing import Any, Callable

from .math_utils import safe_div

CandlestickSignalFn = Callable[[list[dict], int, dict[str, float] | None], int]


def _p(params: dict[str, float] | None, key: str, default: float) -> float:
    if params and key in params and params[key] is not None:
        return float(params[key])
    return default


def _body_pct(b: dict) -> float:
    r = b["high"] - b["low"]
    return abs(b["close"] - b["open"]) / r if r > 0 else 0


def _upper_wick_pct(b: dict) -> float:
    r = b["high"] - b["low"]
    return (b["high"] - max(b["open"], b["close"])) / r if r > 0 else 0


def _lower_wick_pct(b: dict) -> float:
    r = b["high"] - b["low"]
    return (min(b["open"], b["close"]) - b["low"]) / r if r > 0 else 0


def _is_bullish(b: dict) -> bool:
    return b["close"] > b["open"]


def _is_bearish(b: dict) -> bool:
    return b["close"] < b["open"]


def _is_doji(b: dict, body_pct_max: float = 0.1) -> bool:
    return _body_pct(b) < body_pct_max


def _is_marubozu(b: dict, wick_max: float = 0.05) -> bool:
    r = b["high"] - b["low"]
    if r <= 0:
        return False
    uw = (b["high"] - max(b["open"], b["close"])) / r
    lw = (min(b["open"], b["close"]) - b["low"]) / r
    return uw <= wick_max and lw <= wick_max


def _gap_up(prev: dict, cur: dict, tol: float = 0.0005) -> bool:
    return cur["low"] > prev["high"] * (1 + tol)


def _gap_down(prev: dict, cur: dict, tol: float = 0.0005) -> bool:
    return cur["high"] < prev["low"] * (1 - tol)


def _signal_on_neck(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 1:
        return 0
    prev, cur = bars[i - 1], bars[i]
    bp = _p(params, "bodyPct", 0.1)
    if not _is_bearish(prev) or not _is_bullish(cur) or _body_pct(cur) > max(0.2, bp * 2):
        return 0
    if safe_div(abs(cur["close"] - prev["low"]), prev["low"]) < 0.005:
        return -1
    return 0


def _signal_in_neck(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 1:
        return 0
    prev, cur = bars[i - 1], bars[i]
    bp = _p(params, "bodyPct", 0.1)
    if not _is_bearish(prev) or not _is_bullish(cur) or _body_pct(cur) > max(0.2, bp * 2):
        return 0
    prev_body = prev["open"] - prev["close"]
    penetration = safe_div(cur["close"] - prev["low"], prev_body)
    if prev["low"] < cur["close"] < prev["close"] and penetration <= 0.5:
        return -1
    return 0


def _signal_engulfing_bull(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 1:
        return 0
    prev, cur = bars[i - 1], bars[i]
    bp = _p(params, "bodyPct", 0.1)
    if not _is_bearish(prev) or not _is_bullish(cur):
        return 0
    pb, cb = abs(prev["close"] - prev["open"]), abs(cur["close"] - cur["open"])
    if cb <= pb * 1.1:
        return 0
    if cur["open"] < prev["close"] and cur["close"] > prev["open"] and _body_pct(cur) >= bp * 0.5:
        return 1
    return 0


def _signal_engulfing_bear(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 1:
        return 0
    prev, cur = bars[i - 1], bars[i]
    bp = _p(params, "bodyPct", 0.1)
    if not _is_bullish(prev) or not _is_bearish(cur):
        return 0
    pb, cb = abs(prev["close"] - prev["open"]), abs(cur["close"] - cur["open"])
    if cb <= pb * 1.1:
        return 0
    if cur["open"] > prev["close"] and cur["close"] < prev["open"] and _body_pct(cur) >= bp * 0.5:
        return -1
    return 0


def _signal_hammer(bars: list[dict], i: int, params: dict | None) -> int:
    cur = bars[i]
    bp, wp = _p(params, "bodyPct", 0.1), _p(params, "wickPct", 0.6)
    if _lower_wick_pct(cur) >= wp and _body_pct(cur) <= max(0.3, bp * 3) and _upper_wick_pct(cur) < 0.2:
        return 1
    return 0


def _signal_inverted_hammer(bars: list[dict], i: int, params: dict | None) -> int:
    cur = bars[i]
    bp, wp = _p(params, "bodyPct", 0.1), _p(params, "wickPct", 0.6)
    if _upper_wick_pct(cur) >= wp and _body_pct(cur) <= max(0.3, bp * 3) and _lower_wick_pct(cur) < 0.2:
        return 1
    return 0


def _signal_hanging_man(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    cur, prev = bars[i], bars[i - 1]
    bp, wp = _p(params, "bodyPct", 0.1), _p(params, "wickPct", 0.6)
    if not _is_bullish(prev):
        return 0
    if _lower_wick_pct(cur) >= wp and _body_pct(cur) <= max(0.3, bp * 3) and _upper_wick_pct(cur) < 0.2:
        return -1
    return 0


def _signal_shooting_star(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    cur, prev = bars[i], bars[i - 1]
    bp, wp = _p(params, "bodyPct", 0.1), _p(params, "wickPct", 0.6)
    if not _is_bullish(prev):
        return 0
    if _upper_wick_pct(cur) >= wp and _body_pct(cur) <= max(0.3, bp * 3) and _lower_wick_pct(cur) < 0.2:
        return -1
    return 0


def _signal_piercing(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 1:
        return 0
    prev, cur = bars[i - 1], bars[i]
    bp = _p(params, "bodyPct", 0.1)
    if not _is_bearish(prev) or not _is_bullish(cur) or safe_div(abs(prev["close"] - prev["open"]), prev["high"] - prev["low"], eps=1.0) < bp:
        return 0
    mid = (prev["open"] + prev["close"]) / 2
    if cur["open"] < prev["low"] and cur["close"] > mid and cur["close"] < prev["open"]:
        return 1
    return 0


def _signal_dark_cloud(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 1:
        return 0
    prev, cur = bars[i - 1], bars[i]
    bp = _p(params, "bodyPct", 0.1)
    r = prev["high"] - prev["low"]
    if not _is_bullish(prev) or not _is_bearish(cur) or (r and abs(prev["close"] - prev["open"]) / r < bp):
        return 0
    mid = (prev["open"] + prev["close"]) / 2
    if cur["open"] > prev["high"] and cur["close"] < mid and cur["close"] > prev["close"]:
        return -1
    return 0


def _signal_harami_bull(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 1:
        return 0
    prev, cur = bars[i - 1], bars[i]
    if not _is_bearish(prev) or not _is_bullish(cur) or _body_pct(cur) > 0.4:
        return 0
    if cur["open"] > prev["close"] and cur["close"] < prev["open"]:
        return 1
    return 0


def _signal_harami_bear(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 1:
        return 0
    prev, cur = bars[i - 1], bars[i]
    if not _is_bullish(prev) or not _is_bearish(cur) or _body_pct(cur) > 0.4:
        return 0
    if cur["open"] < prev["close"] and cur["close"] > prev["open"]:
        return -1
    return 0


def _signal_three_soldiers(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    c1, c2, c3 = bars[i - 2], bars[i - 1], bars[i]
    if not all(_is_bullish(x) for x in (c1, c2, c3)):
        return 0
    if c2["close"] > c1["close"] and c3["close"] > c2["close"] and c2["open"] > c1["open"] and c3["open"] > c2["open"]:
        return 1
    return 0


def _signal_three_crows(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    c1, c2, c3 = bars[i - 2], bars[i - 1], bars[i]
    if not all(_is_bearish(x) for x in (c1, c2, c3)):
        return 0
    if c2["close"] < c1["close"] and c3["close"] < c2["close"] and c2["open"] < c1["open"] and c3["open"] < c2["open"]:
        return -1
    return 0


def _signal_thrusting(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 1:
        return 0
    prev, cur = bars[i - 1], bars[i]
    if not _is_bearish(prev) or not _is_bullish(cur) or _body_pct(cur) > 0.25:
        return 0
    mid = (prev["open"] + prev["close"]) / 2
    if prev["low"] < cur["close"] < mid:
        return -1
    return 0


def _signal_tweezer_top(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 1:
        return 0
    prev, cur = bars[i - 1], bars[i]
    if safe_div(abs(prev["high"] - cur["high"]), prev["high"], eps=1.0) > 0.002:
        return 0
    if _is_bearish(cur):
        return -1
    return 0


def _signal_tweezer_bottom(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 1:
        return 0
    prev, cur = bars[i - 1], bars[i]
    if safe_div(abs(prev["low"] - cur["low"]), prev["low"], eps=1.0) > 0.002:
        return 0
    if _is_bullish(cur):
        return 1
    return 0


def _signal_pin_bar_bull(bars: list[dict], i: int, params: dict | None) -> int:
    cur = bars[i]
    bp, wp = _p(params, "bodyPct", 0.35), _p(params, "wickPct", 0.65)
    if _lower_wick_pct(cur) >= wp and _body_pct(cur) <= bp:
        return 1
    return 0


def _signal_pin_bar_bear(bars: list[dict], i: int, params: dict | None) -> int:
    cur = bars[i]
    bp, wp = _p(params, "bodyPct", 0.35), _p(params, "wickPct", 0.65)
    if _upper_wick_pct(cur) >= wp and _body_pct(cur) <= bp:
        return -1
    return 0


def _signal_doji(bars: list[dict], i: int, params: dict | None) -> int:
    cur = bars[i]
    bp, wp = _p(params, "bodyPct", 0.1), _p(params, "wickPct", 0.6)
    if not _is_doji(cur, bp):
        return 0
    if _lower_wick_pct(cur) > wp:
        return 1
    if _upper_wick_pct(cur) > wp:
        return -1
    return 0


def _signal_dragonfly_doji(bars: list[dict], i: int, params: dict | None) -> int:
    cur = bars[i]
    bp, wp = _p(params, "bodyPct", 0.1), _p(params, "wickPct", 0.6)
    if not _is_doji(cur, bp) or _lower_wick_pct(cur) < wp or _upper_wick_pct(cur) > 0.1:
        return 0
    return 1


def _signal_gravestone_doji(bars: list[dict], i: int, params: dict | None) -> int:
    cur = bars[i]
    bp, wp = _p(params, "bodyPct", 0.1), _p(params, "wickPct", 0.6)
    if not _is_doji(cur, bp) or _upper_wick_pct(cur) < wp or _lower_wick_pct(cur) > 0.1:
        return 0
    return -1


def _signal_morning_star(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    first, mid, third = bars[i - 2], bars[i - 1], bars[i]
    bp = _p(params, "bodyPct", 0.1)
    if not _is_bearish(first) or not _is_doji(mid, bp * 1.5) or not _is_bullish(third):
        return 0
    first_mid = (first["open"] + first["close"]) / 2
    if third["close"] > first_mid and third["close"] > mid["open"]:
        return 1
    return 0


def _signal_evening_star(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    first, mid, third = bars[i - 2], bars[i - 1], bars[i]
    bp = _p(params, "bodyPct", 0.1)
    if not _is_bullish(first) or not _is_doji(mid, bp * 1.5) or not _is_bearish(third):
        return 0
    first_mid = (first["open"] + first["close"]) / 2
    if third["close"] < first_mid and third["close"] < mid["open"]:
        return -1
    return 0


def _signal_harami_cross_bull(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 1:
        return 0
    prev, cur = bars[i - 1], bars[i]
    bp = _p(params, "bodyPct", 0.1)
    if not _is_bearish(prev) or not _is_doji(cur, bp):
        return 0
    if cur["open"] > prev["close"] and cur["close"] < prev["open"]:
        return 1
    return 0


def _signal_harami_cross_bear(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 1:
        return 0
    prev, cur = bars[i - 1], bars[i]
    bp = _p(params, "bodyPct", 0.1)
    if not _is_bullish(prev) or not _is_doji(cur, bp):
        return 0
    if cur["open"] < prev["close"] and cur["close"] > prev["open"]:
        return -1
    return 0


def _signal_morning_doji_star(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    first, mid, third = bars[i - 2], bars[i - 1], bars[i]
    bp = _p(params, "bodyPct", 0.1)
    if not _is_bearish(first) or not _is_doji(mid, bp) or not _is_bullish(third):
        return 0
    if _gap_down(first, mid) and third["close"] > (first["open"] + first["close"]) / 2:
        return 1
    return 0


def _signal_evening_doji_star(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    first, mid, third = bars[i - 2], bars[i - 1], bars[i]
    bp = _p(params, "bodyPct", 0.1)
    if not _is_bullish(first) or not _is_doji(mid, bp) or not _is_bearish(third):
        return 0
    if _gap_up(first, mid) and third["close"] < (first["open"] + first["close"]) / 2:
        return -1
    return 0


def _signal_three_inside(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    first, second, third = bars[i - 2], bars[i - 1], bars[i]
    if not _is_bearish(first) or not _is_bullish(second) or not _is_bullish(third):
        return 0
    if second["open"] >= first["close"] and second["close"] <= first["open"] and third["close"] > second["high"]:
        return 1
    return 0


def _signal_three_outside(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    first, second, third = bars[i - 2], bars[i - 1], bars[i]
    if not _is_bearish(first) or not _is_bullish(second) or not _is_bullish(third):
        return 0
    if second["open"] < first["close"] and second["close"] > first["open"] and third["close"] > second["high"]:
        return 1
    return 0


def _signal_stick_sandwich(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    c1, c2, c3 = bars[i - 2], bars[i - 1], bars[i]
    if not _is_bearish(c1) or not _is_bullish(c2) or not _is_bearish(c3):
        return 0
    if c2["open"] > c1["close"] and c2["close"] < c1["open"] and c3["close"] < c2["low"]:
        return 1
    return 0


def _signal_marubozu_white(bars: list[dict], i: int, params: dict | None) -> int:
    cur = bars[i]
    if _is_bullish(cur) and _is_marubozu(cur, 0.02) and _body_pct(cur) >= 0.85:
        return 1
    return 0


def _signal_marubozu_black(bars: list[dict], i: int, params: dict | None) -> int:
    cur = bars[i]
    if _is_bearish(cur) and _is_marubozu(cur, 0.02) and _body_pct(cur) >= 0.85:
        return -1
    return 0


def _signal_abandoned_baby_bull(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    first, mid, third = bars[i - 2], bars[i - 1], bars[i]
    bp = _p(params, "bodyPct", 0.1)
    if not _is_bearish(first) or not _is_doji(mid, bp) or not _is_bullish(third):
        return 0
    if _gap_down(first, mid) and _gap_up(mid, third):
        return 1
    return 0


def _signal_abandoned_baby_bear(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    first, mid, third = bars[i - 2], bars[i - 1], bars[i]
    bp = _p(params, "bodyPct", 0.1)
    if not _is_bullish(first) or not _is_doji(mid, bp) or not _is_bearish(third):
        return 0
    if _gap_up(first, mid) and _gap_down(mid, third):
        return -1
    return 0


def _signal_kicking_bull(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 1:
        return 0
    prev, cur = bars[i - 1], bars[i]
    if not _is_marubozu(prev) or not _is_bearish(prev):
        return 0
    if not _is_marubozu(cur) or not _is_bullish(cur):
        return 0
    if _gap_down(prev, cur):
        return 1
    return 0


def _signal_kicking_bear(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 1:
        return 0
    prev, cur = bars[i - 1], bars[i]
    if not _is_marubozu(prev) or not _is_bullish(prev):
        return 0
    if not _is_marubozu(cur) or not _is_bearish(cur):
        return 0
    if _gap_up(prev, cur):
        return -1
    return 0


def _signal_northern_doji(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    cur, prev = bars[i], bars[i - 1]
    bp = _p(params, "bodyPct", 0.1)
    if not _is_doji(cur, bp) or not _is_bullish(prev):
        return 0
    return -1


def _signal_southern_doji(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    cur, prev = bars[i], bars[i - 1]
    bp = _p(params, "bodyPct", 0.1)
    if not _is_doji(cur, bp) or not _is_bearish(prev):
        return 0
    return 1


def _signal_three_line_strike_bull(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 3:
        return 0
    c1, c2, c3, c4 = bars[i - 3], bars[i - 2], bars[i - 1], bars[i]
    if not all(_is_bearish(x) for x in (c1, c2, c3)) or not _is_bullish(c4):
        return 0
    if c4["open"] < c3["close"] and c4["close"] > c1["open"]:
        return 1
    return 0


def _signal_three_line_strike_bear(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 3:
        return 0
    c1, c2, c3, c4 = bars[i - 3], bars[i - 2], bars[i - 1], bars[i]
    if not all(_is_bullish(x) for x in (c1, c2, c3)) or not _is_bearish(c4):
        return 0
    if c4["open"] > c3["close"] and c4["close"] < c1["open"]:
        return -1
    return 0


def _signal_three_white_crows(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    c1, c2, c3 = bars[i - 2], bars[i - 1], bars[i]
    if not all(_is_bullish(x) for x in (c1, c2, c3)):
        return 0
    if c2["open"] >= c1["open"] and c2["open"] <= c1["close"] and c3["open"] >= c2["open"] and c3["open"] <= c2["close"]:
        return 1
    return 0


def _signal_advance_block(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    c1, c2, c3 = bars[i - 2], bars[i - 1], bars[i]
    if not all(_is_bullish(x) for x in (c1, c2, c3)):
        return 0
    b1 = abs(c1["close"] - c1["open"])
    b2 = abs(c2["close"] - c2["open"])
    b3 = abs(c3["close"] - c3["open"])
    if b2 < b1 and b3 < b2:
        return -1
    return 0


def _signal_ladder_bottom(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 4:
        return 0
    c1, c2, c3, c4, c5 = bars[i - 4], bars[i - 3], bars[i - 2], bars[i - 1], bars[i]
    if not all(_is_bearish(x) for x in (c1, c2, c3, c4)):
        return 0
    if _is_bullish(c5) and c5["close"] > c4["high"]:
        return 1
    return 0


def _signal_rising_three(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 4:
        return 0
    c1, c5 = bars[i - 4], bars[i]
    if not _is_bullish(c1):
        return 0
    lows = [bars[i - 3]["low"], bars[i - 2]["low"], bars[i - 1]["low"]]
    highs = [bars[i - 3]["high"], bars[i - 2]["high"], bars[i - 1]["high"]]
    in_range = all(l > c1["low"] for l in lows) and all(h < c1["high"] for h in highs)
    if in_range and _is_bullish(c5) and c5["close"] > c1["high"]:
        return 1
    return 0


def _signal_falling_three(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 4:
        return 0
    c1, c5 = bars[i - 4], bars[i]
    if not _is_bearish(c1):
        return 0
    lows = [bars[i - 3]["low"], bars[i - 2]["low"], bars[i - 1]["low"]]
    highs = [bars[i - 3]["high"], bars[i - 2]["high"], bars[i - 1]["high"]]
    in_range = all(l > c1["low"] for l in lows) and all(h < c1["high"] for h in highs)
    if in_range and _is_bearish(c5) and c5["close"] < c1["low"]:
        return -1
    return 0


def _signal_tasuki_gap_up(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    prev_prev = bars[i - 3] if i >= 3 else bars[i - 2]
    c1, c2, c3 = bars[i - 2], bars[i - 1], bars[i]
    if not _is_bullish(c1) or not _gap_up(prev_prev, c1):
        return 0
    if not _is_bearish(c2) or c2["open"] < c1["low"] or c2["close"] > c1["high"]:
        return 0
    if _is_bullish(c3) and c3["close"] > c2["high"]:
        return 1
    return 0


def _signal_tasuki_gap_down(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    prev_prev = bars[i - 3] if i >= 3 else bars[i - 2]
    c1, c2, c3 = bars[i - 2], bars[i - 1], bars[i]
    if not _is_bearish(c1) or not _gap_down(prev_prev, c1):
        return 0
    if not _is_bullish(c2) or c2["close"] < c1["high"] or c2["open"] > c1["low"]:
        return 0
    if _is_bearish(c3) and c3["close"] < c2["low"]:
        return -1
    return 0


def _signal_three_stars_south(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    bp = _p(params, "bodyPct", 0.1)
    c1, c2, c3 = bars[i - 2], bars[i - 1], bars[i]
    if not all(_is_doji(x, bp) for x in (c1, c2, c3)):
        return 0
    if c2["low"] < c1["low"] and c3["low"] < c2["low"]:
        return -1
    return 0


def _signal_tri_star(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    bp = _p(params, "bodyPct", 0.1)
    c1, c2, c3 = bars[i - 2], bars[i - 1], bars[i]
    if not all(_is_doji(x, bp) for x in (c1, c2, c3)):
        return 0
    if _gap_down(c1, c2) and _gap_up(c2, c3):
        return 1
    if _gap_up(c1, c2) and _gap_down(c2, c3):
        return -1
    return 0


def _signal_identical_three_crows(bars: list[dict], i: int, params: dict | None) -> int:
    if i < 2:
        return 0
    c1, c2, c3 = bars[i - 2], bars[i - 1], bars[i]
    if not all(_is_bearish(x) for x in (c1, c2, c3)):
        return 0
    tol = 0.001
    if safe_div(abs(c1["open"] - c2["open"]), c1["open"], eps=1.0) < tol and safe_div(abs(c2["open"] - c3["open"]), c2["open"], eps=1.0) < tol:
        return -1
    return 0


def _signal_belt_hold_bull(bars: list[dict], i: int, params: dict | None) -> int:
    cur = bars[i]
    if not _is_bullish(cur) or _body_pct(cur) < 0.7:
        return 0
    r = cur["high"] - cur["low"]
    if r > 0 and abs(cur["open"] - cur["low"]) / r < 0.02:
        return 1
    return 0


def _signal_belt_hold_bear(bars: list[dict], i: int, params: dict | None) -> int:
    cur = bars[i]
    if not _is_bearish(cur) or _body_pct(cur) < 0.7:
        return 0
    r = cur["high"] - cur["low"]
    if r > 0 and abs(cur["open"] - cur["high"]) / r < 0.02:
        return -1
    return 0


# Map strategy_id -> function for cs-* patterns. Fallback to generic for unmapped.
CS_PATTERN_MAP: dict[str, CandlestickSignalFn] = {
    "cs-on-neck": _signal_on_neck,
    "cs-in-neck": _signal_in_neck,
    "cs-engulfing-bull": _signal_engulfing_bull,
    "cs-engulfing-bear": _signal_engulfing_bear,
    "cs-hammer": _signal_hammer,
    "cs-inverted-hammer": _signal_inverted_hammer,
    "cs-hanging-man": _signal_hanging_man,
    "cs-shooting-star": _signal_shooting_star,
    "cs-piercing": _signal_piercing,
    "cs-dark-cloud": _signal_dark_cloud,
    "cs-harami-bull": _signal_harami_bull,
    "cs-harami-bear": _signal_harami_bear,
    "cs-three-soldiers": _signal_three_soldiers,
    "cs-three-crows": _signal_three_crows,
    "cs-thrusting": _signal_thrusting,
    "cs-tweezer-top": _signal_tweezer_top,
    "cs-tweezer-bottom": _signal_tweezer_bottom,
    "cs-pin-bar-bull": _signal_pin_bar_bull,
    "cs-pin-bar-bear": _signal_pin_bar_bear,
    "cs-doji": _signal_doji,
    "cs-dragonfly-doji": _signal_dragonfly_doji,
    "cs-gravestone-doji": _signal_gravestone_doji,
    "cs-morning-star": _signal_morning_star,
    "cs-evening-star": _signal_evening_star,
    "cs-harami-cross-bull": _signal_harami_cross_bull,
    "cs-harami-cross-bear": _signal_harami_cross_bear,
    "cs-morning-doji-star": _signal_morning_doji_star,
    "cs-evening-doji-star": _signal_evening_doji_star,
    "cs-three-inside": _signal_three_inside,
    "cs-three-outside": _signal_three_outside,
    "cs-stick-sandwich": _signal_stick_sandwich,
    "cs-marubozu-white": _signal_marubozu_white,
    "cs-marubozu-black": _signal_marubozu_black,
    "cs-abandoned-baby-bull": _signal_abandoned_baby_bull,
    "cs-abandoned-baby-bear": _signal_abandoned_baby_bear,
    "cs-kicking-bull": _signal_kicking_bull,
    "cs-kicking-bear": _signal_kicking_bear,
    "cs-northern-doji": _signal_northern_doji,
    "cs-southern-doji": _signal_southern_doji,
    "cs-three-line-strike-bull": _signal_three_line_strike_bull,
    "cs-three-line-strike-bear": _signal_three_line_strike_bear,
    "cs-three-white-crows": _signal_three_white_crows,
    "cs-advance-block": _signal_advance_block,
    "cs-ladder-bottom": _signal_ladder_bottom,
    "cs-rising-three": _signal_rising_three,
    "cs-falling-three": _signal_falling_three,
    "cs-tasuki-gap-up": _signal_tasuki_gap_up,
    "cs-tasuki-gap-down": _signal_tasuki_gap_down,
    "cs-three-stars-south": _signal_three_stars_south,
    "cs-tri-star": _signal_tri_star,
    "cs-identical-three-crows": _signal_identical_three_crows,
    "cs-belt-hold-bull": _signal_belt_hold_bull,
    "cs-belt-hold-bear": _signal_belt_hold_bear,
}


def get_cs_signal(
    strategy_id: str,
    bars: list[dict],
    i: int,
    params: dict[str, float] | None,
    fallback_fn: Callable[[list[dict], int], int],
) -> int:
    """Dispatch to pattern-specific function or fallback for unmapped cs-*."""
    fn = CS_PATTERN_MAP.get(strategy_id)
    if fn is not None:
        return fn(bars, i, params)
    return fallback_fn(bars, i)
