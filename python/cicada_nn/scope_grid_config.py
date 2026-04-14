"""
Scope grid configurations for profitability + consistency optimization.

Trade modes: scalp, day, med_swing, swing, sniper.
- scalp: M1/M5, quick exits
- day: M15/M30/H1, intraday
- med_swing: multi-day, 4H focus (maps to swing scope)
- swing: H4/D1, multi-day
- sniper: precision entry/exit (maps to scalp scope)

Position = position trading: longest holds (weeks/months), D1/W1 focus.
Used for very long-term configs; the 5 trade modes above are the primary modes.

Goal: balance profitability and consistency over large extended periods.
"""

from __future__ import annotations

from typing import Any


def _linspace(start: float, stop: float, n: int, round_digits: int = 4) -> list[float]:
    if n <= 1:
        return [start] if n == 1 else []
    step = (stop - start) / (n - 1)
    return [round(start + i * step, round_digits) for i in range(n)]


# Trade modes for iteration (scalp, day, med_swing, swing, sniper)
ALL_TRADE_MODES: list[str] = ["scalp", "day", "med_swing", "swing", "sniper"]

# Scope = backtest bucket; trade mode maps to scope
# med_swing and swing both use swing scope; sniper uses scalp
# position = position trading (longest holds, D1/W1) — scope only, not a trade mode
TRADE_MODE_TO_SCOPE: dict[str, str] = {
    "scalp": "scalp",
    "day": "day",
    "med_swing": "swing",
    "swing": "swing",
    "sniper": "scalp",
}

# All scopes (including position for longest holds)
ALL_SCOPES: list[str] = ["scalp", "day", "swing", "position"]

# Per-scope param ranges. Scale matches REGIME_GRID (~531k) and RISK_GRID_ROBUST (~512k).
# 27 values per float param (like regime); 9 for max_hold. 27^3 * 9 ≈ 177k per scope; 4 scopes ≈ 708k total.
SCOPE_PARAM_RANGES: dict[str, dict[str, list[float | int]]] = {
    "scalp": {
        "stop_loss_pct": _linspace(0.005, 0.02, 27),
        "take_profit_r": _linspace(1.0, 2.5, 27, 2),
        "risk_per_trade_pct": _linspace(0.002, 0.012, 27),
        "max_hold_bars": [8, 10, 11, 12, 13, 14, 15, 16, 18],
    },
    "day": {
        "stop_loss_pct": _linspace(0.01, 0.035, 27),
        "take_profit_r": _linspace(1.2, 3.0, 27, 2),
        "risk_per_trade_pct": _linspace(0.004, 0.018, 27),
        "max_hold_bars": [30, 36, 40, 42, 44, 46, 48, 52, 56],
    },
    "swing": {
        "stop_loss_pct": _linspace(0.02, 0.05, 27),
        "take_profit_r": _linspace(1.5, 3.5, 27, 2),
        "risk_per_trade_pct": _linspace(0.005, 0.02, 27),
        "max_hold_bars": [72, 84, 90, 96, 102, 108, 114, 120, 132],
    },
    "position": {
        "stop_loss_pct": _linspace(0.03, 0.07, 27),
        "take_profit_r": _linspace(2.0, 4.5, 27, 2),
        "risk_per_trade_pct": _linspace(0.003, 0.015, 27),
        "max_hold_bars": [150, 180, 200, 220, 240, 252, 270, 300, 330],
    },
}


def _cartesian(grid: dict[str, list[Any]]) -> list[dict[str, Any]]:
    """Cartesian product of grid values."""
    keys = list(grid.keys())
    vals = [grid[k] for k in keys]
    if not vals:
        return [{}]

    def expand(acc: list[dict], i: int) -> list[dict]:
        if i >= len(keys):
            return acc
        new_acc: list[dict] = []
        for d in acc:
            for v in vals[i]:
                new_acc.append({**d, keys[i]: v})
        return expand(new_acc, i + 1)

    return expand([{}], 0)


def build_scope_grid(
    scopes: list[str] | None = None,
    trade_modes: list[str] | None = None,
    use_trade_modes: bool = True,
    include_position_scope: bool = True,
) -> list[dict[str, Any]]:
    """
    Build a large array of grid configurations for iteration.

    Args:
        scopes: Scopes to include (default: all). Ignored if use_trade_modes=True.
        trade_modes: Trade modes to include (scalp, day, med_swing, swing, sniper).
        use_trade_modes: If True, iterate by trade mode (maps to scope); else by scope.
        include_position_scope: If True, add position scope configs (longest holds).

    Returns:
        List of configs: { scope, trade_mode?, stop_loss_pct, take_profit_r, risk_per_trade_pct, max_hold_bars }
    """
    modes = trade_modes or ALL_TRADE_MODES
    scope_list = scopes or ALL_SCOPES

    configs: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, float, float, float, int]] = set()

    def _add_configs_for_scope(scope: str, trade_mode: str | None = None) -> None:
        if scope not in SCOPE_PARAM_RANGES:
            return
        ranges = SCOPE_PARAM_RANGES[scope]
        for cfg in _cartesian(ranges):
            max_hold = int(cfg["max_hold_bars"])
            key = (scope, cfg["stop_loss_pct"], cfg["take_profit_r"], cfg["risk_per_trade_pct"], max_hold)
            if key in seen_keys:
                continue
            seen_keys.add(key)
            entry: dict[str, Any] = {
                "scope": scope,
                "stop_loss_pct": cfg["stop_loss_pct"],
                "take_profit_r": cfg["take_profit_r"],
                "risk_per_trade_pct": cfg["risk_per_trade_pct"],
                "max_hold_bars": max_hold,
            }
            if trade_mode is not None:
                entry["trade_mode"] = trade_mode
            configs.append(entry)

    if use_trade_modes:
        for mode in modes:
            scope = TRADE_MODE_TO_SCOPE.get(mode, "day")
            _add_configs_for_scope(scope, trade_mode=mode)
        if include_position_scope and "position" in SCOPE_PARAM_RANGES:
            _add_configs_for_scope("position", trade_mode="position")
    else:
        for scope in scope_list:
            _add_configs_for_scope(scope)

    return configs


def _norm_minmax(x: float, lo: float, hi: float) -> float:
    """Normalize x to [0,1] using lo..hi range. Returns 0.5 when lo==hi."""
    if hi <= lo:
        return 0.5
    return max(0.0, min(1.0, (x - lo) / (hi - lo)))


def score_profitability_consistency(
    profit: float,
    sharpe_ratio: float,
    max_drawdown_pct: float,
    win_rate: float,
    trades: int,
    profit_weight: float = 0.4,
    sharpe_weight: float = 0.25,
    dd_weight: float = 0.2,
    win_rate_weight: float = 0.1,
    min_trades: int = 5,
    *,
    profit_range: tuple[float, float] | None = None,
    sharpe_range: tuple[float, float] | None = None,
    dd_range: tuple[float, float] | None = None,
    wr_range: tuple[float, float] | None = None,
) -> float:
    """
    Composite score balancing profitability and consistency. All inputs from real backtest.

    When profit_range, sharpe_range, dd_range, wr_range are provided (from candidate set),
    uses data-driven min-max normalization. Otherwise uses fallback ranges for single-candidate.
    """
    if trades < min_trades:
        return -1e9  # Reject configs with too few trades
    wr = win_rate / 100.0 if win_rate > 1 else win_rate  # win_rate 0-100 -> 0-1
    if profit_range:
        profit_norm = _norm_minmax(profit, profit_range[0], profit_range[1])
    else:
        profit_norm = _norm_minmax(profit, 0.0, max(1.0, profit)) if profit > 0 else 0.0
    if sharpe_range:
        sharpe_norm = _norm_minmax(sharpe_ratio, sharpe_range[0], sharpe_range[1])
    else:
        sharpe_norm = _norm_minmax(sharpe_ratio, -1.0, 2.0)
    if dd_range:
        dd_norm = 1.0 - _norm_minmax(max_drawdown_pct, dd_range[0], dd_range[1])  # lower DD = better
    else:
        dd_norm = max(0.0, 1.0 - max_drawdown_pct / 0.5)
    if wr_range:
        wr_norm = _norm_minmax(wr, wr_range[0], wr_range[1])
    else:
        wr_norm = wr
    return (
        profit_weight * profit_norm
        + sharpe_weight * sharpe_norm
        + dd_weight * dd_norm
        + win_rate_weight * wr_norm
    )


def score_candidates_profitability_consistency(
    candidates: list[dict[str, Any]],
    profit_key: str = "profitOOS",
    sharpe_key: str = "sharpeRatio",
    dd_key: str = "maxDrawdown",
    wr_key: str = "winRate",
    trades_key: str = "tradesOOS",
) -> None:
    """
    Compute data-driven profitability+consistency scores for candidates. Mutates in place.
    Uses min/max from the candidate set for normalization (no hardcoded scaling).
    """
    valid = [c for c in candidates if (c.get(trades_key) or 0) >= 5]
    if not valid:
        for c in candidates:
            c["profitabilityConsistencyScore"] = -1e9
        return
    profits = [c.get(profit_key) or 0.0 for c in valid]
    sharpes = [c.get(sharpe_key) or 0.0 for c in valid]
    dds = [c.get(dd_key) or 0.0 for c in valid]
    wrs = [
        (c.get(wr_key) or 0) / 100.0 if (c.get(wr_key) or 0) > 1 else (c.get(wr_key) or 0)
        for c in valid
    ]
    profit_r = (min(profits), max(profits))
    sharpe_r = (min(sharpes), max(sharpes))
    dd_r = (min(dds), max(dds))
    wr_r = (min(wrs), max(wrs))
    for c in candidates:
        profit = c.get(profit_key) or 0.0
        sharpe = c.get(sharpe_key) or 0.0
        dd = c.get(dd_key) or 0.0
        wr = (c.get(wr_key) or 0) / 100.0 if (c.get(wr_key) or 0) > 1 else (c.get(wr_key) or 0)
        trades = c.get(trades_key) or 0
        c["profitabilityConsistencyScore"] = score_profitability_consistency(
            profit, sharpe, dd, wr, trades,
            profit_range=profit_r, sharpe_range=sharpe_r, dd_range=dd_r, wr_range=wr_r,
        )


# Pre-built grid for iteration. ~708k configs (27^3 * 9 per scope × 4 scopes). Matches regime/risk scale.
SCOPE_GRID_CONFIGS: list[dict[str, Any]] = build_scope_grid(use_trade_modes=True)
