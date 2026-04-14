"""
Strategy parameter grid for server-side backtest. Mirrors frontend strategyParams.ts.

Full Cartesian grids can reach ~500k combos per family for 2-axis families (see grid_config.APPROX_FULL_GRID_COMBOS_PER_FAMILY).
Runtime caps use grid_config.DEFAULT_PARAM_COMBOS_LIMIT (env CICADA_PARAM_COMBOS_LIMIT); max_combinations <= 0 = full grid.
"""

from typing import Any

from .grid_config import DEFAULT_PARAM_COMBOS_LIMIT


def _irange(start: int, stop: int, count: int) -> list[int]:
    """Integer range with count values (inclusive start, exclusive stop)."""
    if count <= 1:
        return [start] if count == 1 else []
    step = (stop - start) / (count - 1)
    return [int(start + i * step) for i in range(count)]


def _frange(start: float, stop: float, count: int, round_digits: int = 4) -> list[float]:
    """Float range with count values."""
    if count <= 1:
        return [start] if count == 1 else []
    step = (stop - start) / (count - 1)
    return [round(start + i * step, round_digits) for i in range(count)]


DEFAULT_PARAMS: dict[str, dict[str, float]] = {
    "rsi": {"period": 14, "overbought": 70, "oversold": 30},
    "macd": {"fast": 12, "slow": 26, "signal": 9},
    "ema": {"fast": 9, "slow": 21},
    "bb": {"period": 20, "stdMult": 2},
    "atr": {"period": 14, "mult": 1.5},
    "stoch": {"kPeriod": 14, "dPeriod": 3, "overbought": 80, "oversold": 20},
    "structure": {"lookback": 10, "rsiPeriod": 14, "bbPeriod": 20, "atrPeriod": 14, "donchianPeriod": 20},
    "cci": {"period": 20},
    "williamsR": {"period": 14},
    "roc": {"period": 12},
    "adx": {"period": 14},
    "keltner": {"emaPeriod": 20, "atrPeriod": 10, "mult": 2},
    "donchian": {"period": 20},
    "dpo": {"period": 20},
    "trix": {"period": 15},
    "candlestick": {"bodyPct": 0.1, "wickPct": 0.6},
    "mfi": {"period": 14, "overbought": 80, "oversold": 20},
    "vwap": {"tolerance": 0.001},
    "vwapBands": {"period": 20, "stdMult": 2},
    "cmf": {"period": 20},
    "cmo": {"period": 14, "overbought": 50, "oversold": -50},
    "tsi": {"longPeriod": 25, "shortPeriod": 13},
    "ultimateOsc": {"overbought": 70, "oversold": 30},
    "obv": {"lookback": 5},
    "forceIndex": {"period": 2},
    "eom": {"period": 14},
    "vpt": {"lookback": 5},
    "coppock": {"roc1": 14, "roc2": 11, "smooth": 10},
    "nviPvi": {"lookback": 5},
    "accumulation": {"lookback": 5},
    "pivotPoints": {"tolerance": 0.001},
    "camarilla": {"tolerance": 0.001},
    "fibPivot": {"tolerance": 0.001},
    "zigzag": {"thresholdPct": 0.001, "tolerance": 0.002},
    "fractals": {},
}

# Expanded for robust research. ~500k combos per family (matches regime scale).
# 3-param: 80^3≈512k; 4-param: 27^4≈531k; 2-param: 708^2≈501k; 1-param: 80 values.
STRATEGY_PARAM_RANGES: dict[str, dict[str, list[float]]] = {
    "rsi": {
        "period": _irange(5, 85, 80),
        "overbought": _frange(65, 90, 80, 1),
        "oversold": _frange(10, 35, 80, 1),
    },
    "macd": {
        "fast": _irange(6, 86, 80),
        "slow": _irange(17, 97, 80),
        "signal": _irange(7, 87, 80),
    },
    "ema": {"fast": _irange(6, 714, 708), "slow": _irange(18, 726, 708)},
    "bb": {"period": _irange(12, 720, 708), "stdMult": _frange(1.5, 2.5, 708)},
    "atr": {"period": _irange(8, 716, 708), "mult": _frange(1.25, 2.5, 708)},
    "stoch": {
        "kPeriod": _irange(8, 35, 27),
        "dPeriod": _irange(3, 30, 27),
        "overbought": _irange(75, 95, 27),
        "oversold": _irange(15, 35, 27),
    },
    "structure": {"lookback": _irange(3, 711, 708), "donchianPeriod": _irange(12, 720, 708)},
    "cci": {"period": _irange(10, 90, 80)},
    "williamsR": {"period": _irange(8, 88, 80)},
    "roc": {"period": _irange(8, 88, 80)},
    "adx": {"period": _irange(10, 90, 80)},
    "keltner": {
        "emaPeriod": _irange(15, 95, 80),
        "atrPeriod": _irange(8, 88, 80),
        "mult": _frange(1.5, 2.5, 80),
    },
    "donchian": {"period": _irange(12, 92, 80)},
    "dpo": {"period": _irange(12, 92, 80)},
    "trix": {"period": _irange(10, 90, 80)},
    "candlestick": {"bodyPct": _frange(0.06, 0.15, 708), "wickPct": _frange(0.5, 0.7, 708)},
    "mfi": {
        "period": _irange(10, 90, 80),
        "overbought": _irange(75, 95, 80),
        "oversold": _irange(15, 35, 80),
    },
    "vwap": {"tolerance": _frange(0.0003, 0.002, 80)},
    "vwapBands": {"period": _irange(12, 720, 708), "stdMult": _frange(1.5, 2.5, 708)},
    "cmf": {"period": _irange(10, 90, 80)},
    "cmo": {
        "period": _irange(8, 88, 80),
        "overbought": _irange(45, 60, 80),
        "oversold": _frange(-55, -40, 80, 0),
    },
    "tsi": {"longPeriod": _irange(18, 98, 80), "shortPeriod": _irange(8, 88, 80)},
    "ultimateOsc": {"overbought": _irange(65, 95, 80), "oversold": _irange(25, 45, 80)},
    "obv": {"lookback": _irange(3, 83, 80)},
    "forceIndex": {"period": _irange(2, 82, 80)},
    "eom": {"period": _irange(8, 88, 80)},
    "vpt": {"lookback": _irange(3, 83, 80)},
    "coppock": {"roc1": _irange(11, 91, 80), "roc2": _irange(11, 91, 80), "smooth": _irange(8, 88, 80)},
    "nviPvi": {"lookback": _irange(3, 83, 80)},
    "accumulation": {"lookback": _irange(3, 83, 80)},
    "pivotPoints": {"tolerance": _frange(0.0003, 0.002, 80)},
    "camarilla": {"tolerance": _frange(0.0003, 0.002, 80)},
    "fibPivot": {"tolerance": _frange(0.0003, 0.002, 80)},
    "zigzag": {
        "thresholdPct": _frange(0.0003, 0.002, 708),
        "tolerance": _frange(0.0008, 0.002, 708),
    },
    "fractals": {},
}

STRATEGY_TO_PARAM_FAMILY: dict[str, str] = {
    "ind-rsi-div": "rsi",
    "ind-rsi-overbought": "rsi",
    "ind-rsi-oversold": "rsi",
    "ind-rsi-trend": "rsi",
    "ind-macd-cross": "macd",
    "ind-macd-hist-div": "macd",
    "ind-macd-zero": "macd",
    "ind-ema-ribbon": "ema",
    "ind-ema-cross-9-21": "ema",
    "ind-ema-cross-50-200": "ema",
    "ind-bb-squeeze": "bb",
    "ind-bb-walk": "bb",
    "ind-bb-reversion": "bb",
    "ind-atr-breakout": "atr",
    "ind-atr-trail": "atr",
    "ind-stoch-overbought": "stoch",
    "ind-stoch-oversold": "stoch",
    "ind-stoch-div": "stoch",
    "pa-bos": "structure",
    "pa-breakout-retest": "structure",
    "pa-liquidity-sweep": "structure",
    "ind-cci-overbought": "cci",
    "ind-cci-oversold": "cci",
    "ind-williams-r": "williamsR",
    "ind-mfi": "mfi",
    "ind-roc": "roc",
    "ind-adx-trend": "adx",
    "ind-adx-breakout": "adx",
    "ind-keltner": "keltner",
    "ind-donchian": "donchian",
    "ind-dpo": "dpo",
    "ind-trix": "trix",
    "ind-vwap": "vwap",
    "ind-vwap-bands": "vwapBands",
    "ind-vwap-anchor": "vwap",
    "ind-cmf": "cmf",
    "ind-cmo": "cmo",
    "ind-tsi": "tsi",
    "ind-ultimate-osc": "ultimateOsc",
    "ind-obv-div": "obv",
    "ind-obv-breakout": "obv",
    "ind-force-index": "forceIndex",
    "ind-eom": "eom",
    "ind-vpt": "vpt",
    "ind-coppock": "coppock",
    "ind-nvi-pvi": "nviPvi",
    "ind-accumulation": "accumulation",
    "ind-pivot-points": "pivotPoints",
    "ind-camarilla": "camarilla",
    "ind-fib-pivot": "fibPivot",
    "ind-zigzag": "zigzag",
    "ind-fractals": "fractals",
}
# cp-* and cs-* use prefix match (see get_param_combinations)

# Mirrors frontend STRATEGY_DEFAULT_OVERRIDES + FIXED_PARAM_STRATEGIES
STRATEGY_DEFAULT_OVERRIDES: dict[str, dict[str, float]] = {
    "ind-ema-cross-9-21": {"fast": 9, "slow": 21},
    "ind-ema-cross-50-200": {"fast": 50, "slow": 200},
    "ind-ema-ribbon": {"fast": 8, "slow": 55},
}
FIXED_PARAM_STRATEGIES = frozenset(STRATEGY_DEFAULT_OVERRIDES.keys())


def _cfg_key(cfg: dict[str, float]) -> tuple[tuple[str, float], ...]:
    return tuple(sorted((k, float(v)) for k, v in cfg.items()))


# Sweep order: first keys get slightly more slots when budget does not divide evenly.
# Mirrors frontend PARAM_KEY_ORDER (iterative 1-D sweeps, not random Cartesian subsampling).
PARAM_KEY_ORDER: dict[str, list[str]] = {
    "structure": ["lookback", "donchianPeriod"],
    "rsi": ["period", "overbought", "oversold"],
    "macd": ["fast", "slow", "signal"],
    "ema": ["fast", "slow"],
    "bb": ["period", "stdMult"],
    "atr": ["period", "mult"],
    "stoch": ["kPeriod", "dPeriod", "overbought", "oversold"],
    "cci": ["period"],
    "williamsR": ["period"],
    "roc": ["period"],
    "adx": ["period"],
    "keltner": ["emaPeriod", "atrPeriod", "mult"],
    "donchian": ["period"],
    "dpo": ["period"],
    "trix": ["period"],
    "candlestick": ["bodyPct", "wickPct"],
    "mfi": ["period", "overbought", "oversold"],
    "vwap": ["tolerance"],
    "vwapBands": ["period", "stdMult"],
    "cmf": ["period"],
    "cmo": ["period", "overbought", "oversold"],
    "tsi": ["longPeriod", "shortPeriod"],
    "ultimateOsc": ["overbought", "oversold"],
    "obv": ["lookback"],
    "forceIndex": ["period"],
    "eom": ["period"],
    "vpt": ["lookback"],
    "coppock": ["roc1", "roc2", "smooth"],
    "nviPvi": ["lookback"],
    "accumulation": ["lookback"],
    "pivotPoints": ["tolerance"],
    "camarilla": ["tolerance"],
    "fibPivot": ["tolerance"],
    "zigzag": ["thresholdPct", "tolerance"],
}


def _ordered_keys(family: str, ranges: dict[str, list[Any]]) -> list[str]:
    keys = list(ranges.keys())
    order = PARAM_KEY_ORDER.get(family)
    if not order:
        return keys
    first = [k for k in order if k in ranges]
    rest = [k for k in keys if k not in first]
    return first + rest


def _evenly_spaced_indices(n: int, count: int) -> list[int]:
    """Pick `count` distinct indices spread from 0 .. n-1 (iterative sweep along one axis)."""
    if count <= 0 or n <= 0:
        return []
    if count >= n:
        return list(range(n))
    if count == 1:
        return [n // 2]
    idxs: list[int] = []
    for i in range(count):
        idx = min(int(round(i * (n - 1) / (count - 1))), n - 1)
        idxs.append(idx)
    seen: set[int] = set()
    out: list[int] = []
    for i in idxs:
        if i not in seen:
            seen.add(i)
            out.append(i)
    return out


def _iterative_param_sets(
    keys: list[str],
    ranges: dict[str, list[Any]],
    defaults: dict[str, float],
    max_combinations: int,
) -> list[dict[str, float]]:
    """
    Build up to max_combinations configs by sweeping each parameter axis in order:
    defaults first, then evenly spaced values along key[0] (others default), then key[1], etc.
    Deterministic — covers min→max along each axis, not arbitrary Cartesian corners.
    """
    out: list[dict[str, float]] = []
    seen: set[tuple[tuple[str, float], ...]] = set()

    def add(cfg: dict[str, float]) -> None:
        k = _cfg_key(cfg)
        if k not in seen:
            seen.add(k)
            out.append(dict(cfg))

    add(dict(defaults))
    if max_combinations <= 1:
        return out

    budget = max_combinations - 1
    n_keys = len(keys)
    if n_keys == 0:
        return out

    slots_per = [budget // n_keys] * n_keys
    for i in range(budget % n_keys):
        slots_per[i] += 1

    for ki, key in enumerate(keys):
        vals = ranges.get(key)
        if not vals:
            continue
        want = slots_per[ki]
        idxs = _evenly_spaced_indices(len(vals), min(want, len(vals)))
        for idx in idxs:
            if len(out) >= max_combinations:
                break
            cfg = dict(defaults)
            v = vals[idx]
            cfg[key] = float(v) if isinstance(v, (int, float)) else v
            add(cfg)
        if len(out) >= max_combinations:
            break

    return out[:max_combinations]


def _cartesian(values: list[list[Any]]) -> list[list[Any]]:
    if not values:
        return [[]]
    first, rest = values[0], values[1:]
    rest_combos = _cartesian(rest)
    return [[v] + r for v in first for r in rest_combos]


def get_param_combinations(strategy_id: str, max_combinations: int = DEFAULT_PARAM_COMBOS_LIMIT) -> list[dict[str, float]]:
    """Return list of param configs for grid search. Mirrors frontend getParamCombinationsLimited."""
    if strategy_id in FIXED_PARAM_STRATEGIES:
        family = STRATEGY_TO_PARAM_FAMILY.get(strategy_id, "ema")
        base = dict(DEFAULT_PARAMS.get(family, {}))
        base.update(STRATEGY_DEFAULT_OVERRIDES[strategy_id])
        return [base]

    family = STRATEGY_TO_PARAM_FAMILY.get(strategy_id)
    if not family and strategy_id.startswith("cp-"):
        family = "structure"
    if not family and strategy_id.startswith("cs-"):
        family = "candlestick"
    ranges = STRATEGY_PARAM_RANGES.get(family) if family else None
    defaults = DEFAULT_PARAMS.get(family, {}) if family else {}

    if not ranges or not ranges:
        return [dict(defaults)]

    keys = _ordered_keys(family, ranges)
    total = 1
    for k in keys:
        total *= max(1, len(ranges[k]))

    if max_combinations <= 0 or total <= max_combinations:
        combos = _cartesian([ranges[k] for k in keys])
        configs: list[dict[str, float]] = []
        for c in combos:
            cfg = dict(defaults)
            for i, k in enumerate(keys):
                cfg[k] = c[i]
            configs.append(cfg)
        return configs

    if max_combinations == 1:
        return [dict(defaults)]

    return _iterative_param_sets(keys, ranges, defaults, max_combinations)
