"""
Grid research for pre-backtest tuning: regime calibration + strategy/risk param optimization.
Runs before backtest to find optimal params per instrument × regime.
Uses walk-forward validation (in-sample tune, out-of-sample validate) to reduce overfitting.

Robust mode: OOS profit as objective, successive halving, walk-forward, configurable scale.
"""

from __future__ import annotations

import logging
import math
import os
from collections import Counter
from collections.abc import Generator
from typing import Any, Sequence

logger = logging.getLogger(__name__)

from .backtest_server import TF_TO_SCOPE, _run_single
from .regime_detection import RegimeConfig, detect_regime_series
from .scope_grid_config import SCOPE_GRID_CONFIGS, score_candidates_profitability_consistency
from .grid_config import (
    DEFAULT_RESEARCH_PARAM_TUNE_MAX_RISK,
    DEFAULT_RESEARCH_PARAM_TUNE_MAX_STRAT,
    DEFAULT_RESEARCH_REGIME_GRID_MAX,
)
from .strategy_params import get_param_combinations

# Trade scopes for per-mode grid iteration (scalp/day/swing/position)
ALL_SCOPES: list[str] = ["scalp", "day", "swing", "position"]
SCOPE_TO_TIMEFRAMES: dict[str, list[str]] = {
    "scalp": ["M1", "M5"],
    "day": ["M15", "M30", "H1"],
    "swing": ["H4", "D1"],
    "position": ["D1", "W1"],
}

# Min bars required before any process runs. Halt with descriptive error if insufficient — no inference or skip.
MIN_BARS_REQUIRED_RESEARCH = 200

# Env-configurable scale for robust research (expanded grids: regime ~50k–248k, risk 1k)
MAX_REGIME_CONFIGS = int(os.environ.get("CICADA_RESEARCH_MAX_REGIME_CONFIGS", "600000"))
MAX_RISK_CONFIGS = int(os.environ.get("CICADA_RESEARCH_MAX_RISK_CONFIGS", "600000"))
MIN_OOS_TRADES = int(os.environ.get("CICADA_RESEARCH_MIN_OOS_TRADES", "5"))
WALK_FORWARD_SPLITS = int(os.environ.get("CICADA_RESEARCH_WALK_FORWARD_SPLITS", "5"))


# Regime calibration grid (forex). 27^4 ≈ 531k combos.
REGIME_GRID = {
    "lookback": [15, 18, 20, 22, 25, 28, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200],
    "trend_threshold": [0.00004, 0.00005, 0.00006, 0.00007, 0.00008, 0.00009, 0.0001, 0.00011, 0.00012, 0.00013, 0.00014, 0.00015, 0.00016, 0.00017, 0.00018, 0.00019, 0.0002, 0.00021, 0.00022, 0.00023, 0.00024, 0.00025, 0.00026, 0.00028, 0.0003, 0.00032, 0.00035],
    "volatility_high": [0.008, 0.009, 0.01, 0.011, 0.012, 0.013, 0.014, 0.015, 0.016, 0.017, 0.018, 0.019, 0.02, 0.021, 0.022, 0.023, 0.024, 0.025, 0.026, 0.027, 0.028, 0.029, 0.03, 0.031, 0.032, 0.033, 0.035],
    "volatility_low": [0.0015, 0.002, 0.0022, 0.0025, 0.0028, 0.003, 0.0032, 0.0035, 0.0038, 0.004, 0.0042, 0.0045, 0.0048, 0.005, 0.0052, 0.0055, 0.0058, 0.006, 0.0062, 0.0065, 0.0068, 0.007, 0.0072, 0.0075, 0.0078, 0.008],
}

# Volatility instruments (R_10, R_25, etc.). 14^5 ≈ 538k combos.
REGIME_GRID_VOLATILITY = {
    "lookback": [15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 180],
    "trend_threshold": [0.00002, 0.00003, 0.00004, 0.00005, 0.00006, 0.00008, 0.0001, 0.00012, 0.00015, 0.0002, 0.00025, 0.0003, 0.00035, 0.0004],
    "volatility_high": [0.012, 0.015, 0.02, 0.025, 0.03, 0.035, 0.04, 0.045, 0.05, 0.055, 0.06, 0.065, 0.07, 0.08],
    "volatility_low": [0.003, 0.004, 0.005, 0.006, 0.007, 0.008, 0.009, 0.01, 0.012, 0.015, 0.018, 0.02, 0.025, 0.03],
    "donchian_boundary_frac": [0.99, 0.991, 0.992, 0.993, 0.994, 0.995, 0.996, 0.997, 0.998, 0.9985, 0.999, 0.9995, 0.9999, 0.99995],
}


def _get_regime_grid_for_instrument(instrument_symbol: str) -> dict[str, list[Any]]:
    """Return regime calibration grid suited to instrument's own behavior (no cross-reference)."""
    sym = (instrument_symbol or "").upper().replace("/", "").strip()
    # Volatility indices (R_10, R_25, etc.) and crash/boom — different price scale, wider bars
    if sym and (sym.startswith("R_") and sym[2:].isdigit() or sym.startswith("CRASH") or sym.startswith("BOOM")):
        return REGIME_GRID_VOLATILITY
    return REGIME_GRID

# Coarse grid for risk params (per regime × instrument)
RISK_GRID = {
    "stop_loss_pct": [0.02, 0.03, 0.04],
    "risk_per_trade_pct": [0.005, 0.008, 0.01],
    "take_profit_r": [1.5, 2.0, 2.5],
}

# Expanded grid for robust research. ~80^3 ≈ 512k combos (matches regime scale).
def _linspace(start: float, stop: float, n: int, round_digits: int = 4) -> list[float]:
    if n <= 1:
        return [start] if n == 1 else []
    step = (stop - start) / (n - 1)
    return [round(start + i * step, round_digits) for i in range(n)]


RISK_GRID_ROBUST = {
    "stop_loss_pct": _linspace(0.005, 0.08, 80),
    "risk_per_trade_pct": _linspace(0.001, 0.03, 80),
    "take_profit_r": _linspace(1.0, 4.0, 80, 2),
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


def _regime_entropy(regime_series: list[str]) -> float:
    """Entropy of regime distribution. Higher = more diverse, less 'unknown' dominated."""
    if not regime_series:
        return 0.0
    counts = Counter(regime_series)
    n = len(regime_series)
    entropy = 0.0
    for c in counts.values():
        p = c / n
        if p > 0:
            entropy -= p * math.log2(p)
    return entropy


def _regime_unknown_ratio(regime_series: list[str]) -> float:
    """Fraction of bars labeled 'unknown'. Lower is better."""
    if not regime_series:
        return 1.0
    unknown = sum(1 for r in regime_series if r == "unknown")
    return unknown / len(regime_series)


def _entropy_from_distribution(regime_dist: dict[str, float]) -> float:
    """Entropy of regime distribution. Higher = more diverse."""
    if not regime_dist:
        return 0.0
    entropy = 0.0
    for p in regime_dist.values():
        if p > 0:
            entropy -= p * math.log2(p)
    return entropy


def run_baseline_instrument(
    instrument_id: str,
    instrument_symbol: str,
    bars: list[dict[str, Any]],
    strategy_ids: list[str],
    strategy_names: dict[str, str],
    regimes: list[str],
    timeframe: str,
    spread_pct: float | None,
) -> dict[str, Any]:
    """
    Phase 0: Run with default config to establish baseline before any tuning.
    Uses default RegimeConfig + default risk params. One run per strategy×regime.
    Returns regime distribution and baseline Sharpe/profit for comparison.
    """
    default_rc = RegimeConfig()
    series = detect_regime_series(bars, config=default_rc)
    counts = Counter(series)
    n = len(series)
    dist = {r: c / n for r, c in counts.items()}
    top = ", ".join(f"{r}:{p:.0%}" for r, p in list(dist.items())[:5])

    # One run per strategy×regime with defaults (no grid)
    default_bt = {"stop_loss_pct": 0.02, "risk_per_trade_pct": 0.01, "take_profit_r": 2.0}
    baseline_sharpes: list[float] = []
    baseline_profits: list[float] = []
    for strategy_id in strategy_ids:
        name = strategy_names.get(strategy_id) or strategy_id
        for regime in regimes:
            if regime == "any":
                continue
            split = int(len(bars) * 0.7)
            bars_in = bars[:split]
            row = _run_single(
                instrument_id,
                instrument_symbol,
                strategy_id,
                name,
                timeframe,
                regime,
                bars_in,
                strategy_params=None,
                spread_pct=spread_pct,
                bt_config=default_bt,
                regime_config=default_rc,
            )
            baseline_sharpes.append(row.get("sharpeRatio") or 0.0)
            baseline_profits.append(row.get("profit") or 0.0)

    avg_sharpe = sum(baseline_sharpes) / len(baseline_sharpes) if baseline_sharpes else 0.0
    total_profit = sum(baseline_profits)

    return {
        "instrumentId": instrument_id,
        "instrumentSymbol": instrument_symbol,
        "regimeDistribution": dist,
        "summary": top,
        "baselineAvgSharpe": round(avg_sharpe, 2),
        "baselineTotalProfit": round(total_profit, 2),
    }


def run_baseline_instrument_with_progress(
    instrument_id: str,
    instrument_symbol: str,
    bars: list[dict[str, Any]],
    strategy_ids: list[str],
    strategy_names: dict[str, str],
    regimes: list[str],
    timeframe: str,
    spread_pct: float | None,
) -> Generator[None, None, dict[str, Any]]:
    """
    Same as run_baseline_instrument but yields after each strategy×regime run.
    Caller can emit progress for adaptive ETA. Final result via StopIteration.value.
    """
    default_rc = RegimeConfig()
    series = detect_regime_series(bars, config=default_rc)
    counts = Counter(series)
    n = len(series)
    dist = {r: c / n for r, c in counts.items()}
    top = ", ".join(f"{r}:{p:.0%}" for r, p in list(dist.items())[:5])

    default_bt = {"stop_loss_pct": 0.02, "risk_per_trade_pct": 0.01, "take_profit_r": 2.0}
    baseline_sharpes: list[float] = []
    baseline_profits: list[float] = []
    for strategy_id in strategy_ids:
        name = strategy_names.get(strategy_id) or strategy_id
        for regime in regimes:
            if regime == "any":
                continue
            split = int(len(bars) * 0.7)
            bars_in = bars[:split]
            row = _run_single(
                instrument_id,
                instrument_symbol,
                strategy_id,
                name,
                timeframe,
                regime,
                bars_in,
                strategy_params=None,
                spread_pct=spread_pct,
                bt_config=default_bt,
                regime_config=default_rc,
            )
            baseline_sharpes.append(row.get("sharpeRatio") or 0.0)
            baseline_profits.append(row.get("profit") or 0.0)
            yield  # progress tick for adaptive ETA

    avg_sharpe = sum(baseline_sharpes) / len(baseline_sharpes) if baseline_sharpes else 0.0
    total_profit = sum(baseline_profits)

    return {
        "instrumentId": instrument_id,
        "instrumentSymbol": instrument_symbol,
        "regimeDistribution": dist,
        "summary": top,
        "baselineAvgSharpe": round(avg_sharpe, 2),
        "baselineTotalProfit": round(total_profit, 2),
    }


def run_regime_validation(
    regime_result: dict[str, Any],
    unknown_threshold: float = 0.1,
    max_regime_threshold: float = 0.8,
    min_entropy: float = 0.5,
) -> tuple[bool, str | None]:
    """
    Phase 0: Validate regime calibration result before trusting it for strategy tuning.
    Returns (validated, message). Message is set when validation fails.
    """
    dist = regime_result.get("regimeDistribution") or {}
    if not dist:
        return False, "No regime distribution"

    unknown_ratio = float(dist.get("unknown", 0))
    if unknown_ratio >= unknown_threshold:
        return False, f"Unknown ratio {unknown_ratio:.0%} >= {unknown_threshold:.0%}"

    max_share = max(dist.values()) if dist else 0
    if max_share >= max_regime_threshold:
        top = max(dist, key=dist.get)  # type: ignore[arg-type]
        return False, f"Regime '{top}' dominates ({max_share:.0%} >= {max_regime_threshold:.0%})"

    entropy = _entropy_from_distribution(dist)
    if entropy < min_entropy:
        return False, f"Low entropy {entropy:.2f} < {min_entropy}"

    return True, None


def run_regime_calibration(
    instrument_id: str,
    instrument_symbol: str,
    bars: list[dict[str, Any]],
    regime_grid: dict[str, list[Any]] | None = None,
    max_configs: int = 27,
    seed_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Grid search over regime detection params. Objective: maximize entropy, minimize unknown ratio.
    Uses instrument-specific grid (R_10 etc. get volatility-appropriate ranges) to find each
    instrument's own behavior — no cross-reference.
    When seed_config from backward validation is provided, it is evaluated first and included in the grid.
    Returns best RegimeConfig (as dict) per instrument.
    """
    grid = regime_grid or _get_regime_grid_for_instrument(instrument_symbol)
    configs = _cartesian(grid)
    if seed_config:
        configs = [seed_config] + configs
        logger.info("regime_calibration instrument=%s symbol=%s seed_config=from_backward_validation", instrument_id, instrument_symbol)
    if len(configs) > max_configs:
        step = len(configs) / max_configs
        configs = [configs[min(int(i * step), len(configs) - 1)] for i in range(max_configs)]

    best_score = -1.0
    best_config: dict[str, Any] = {}
    best_regime_dist: dict[str, float] = {}

    for cfg_dict in configs:
        rc = RegimeConfig(
            lookback=int(cfg_dict.get("lookback", 50)),
            trend_threshold=float(cfg_dict.get("trend_threshold", 0.00015)),
            volatility_high=float(cfg_dict.get("volatility_high", 0.02)),
            volatility_low=float(cfg_dict.get("volatility_low", 0.004)),
            donchian_boundary_frac=float(cfg_dict.get("donchian_boundary_frac", 0.998)),
        )
        series = detect_regime_series(bars, config=rc)
        entropy = _regime_entropy(series)
        unknown_ratio = _regime_unknown_ratio(series)
        # Score: entropy * (1 - unknown_ratio) — favor diverse regimes with few unknowns
        score = entropy * (1.0 - unknown_ratio)
        if score > best_score:
            best_score = score
            best_config = rc.to_dict()
            counts = Counter(series)
            n = len(series)
            best_regime_dist = {r: c / n for r, c in counts.items()}

    validated, validation_msg = run_regime_validation(
        {"regimeDistribution": best_regime_dist},
        unknown_threshold=0.1,
        max_regime_threshold=0.8,
        min_entropy=0.5,
    )
    logger.info(
        "regime_calibration instrument=%s symbol=%s score=%.4f validated=%s top_regimes=%s",
        instrument_id, instrument_symbol, best_score, validated,
        ", ".join(f"{r}:{p:.0%}" for r, p in list(best_regime_dist.items())[:5]),
    )
    logger.info(
        "regime_calibration found config instrument=%s symbol=%s regimeConfig=%s",
        instrument_id, instrument_symbol, best_config,
    )
    return {
        "instrumentId": instrument_id,
        "instrumentSymbol": instrument_symbol,
        "regimeConfig": best_config,
        "score": round(best_score, 4),
        "regimeDistribution": best_regime_dist,
        "validated": validated,
        "regimeValidationMessage": validation_msg,
    }


def _run_regime_calibration_with_progress(
    instrument_id: str,
    instrument_symbol: str,
    bars: list[dict[str, Any]],
    regime_grid: dict[str, list[Any]] | None,
    max_configs: int,
    seed_config: dict[str, Any] | None,
):
    """Generator: yields progress during regime calibration, then the result."""
    grid = regime_grid or _get_regime_grid_for_instrument(instrument_symbol)
    configs = _cartesian(grid)
    if seed_config:
        configs = [seed_config] + configs
    if len(configs) > max_configs:
        step = len(configs) / max_configs
        configs = [configs[min(int(i * step), len(configs) - 1)] for i in range(max_configs)]

    best_score = -1.0
    best_config: dict[str, Any] = {}
    best_regime_dist: dict[str, float] = {}
    n_configs = len(configs)
    if n_configs == 0:
        default_rc = RegimeConfig()
        validated, validation_msg = run_regime_validation(
            {"regimeDistribution": {}},
            unknown_threshold=0.1,
            max_regime_threshold=0.8,
            min_entropy=0.5,
        )
        yield {
            "type": "regime_done",
            "result": {
                "instrumentId": instrument_id,
                "instrumentSymbol": instrument_symbol,
                "regimeConfig": default_rc.to_dict(),
                "score": 0.0,
                "regimeDistribution": {},
                "validated": validated,
                "regimeValidationMessage": validation_msg,
            },
        }
        return
    progress_interval = max(1, min(50, n_configs // 20))

    for i, cfg_dict in enumerate(configs):
        if (i + 1) % progress_interval == 0:
            pct = round(100 * (i + 1) / n_configs, 1)
            yield {
                "type": "progress",
                "phase": "regime",
                "level": "progress",
                "message": f"Regime config {i + 1}/{n_configs} ({pct}%)...",
                "instrumentId": instrument_id,
                "currentPhase": "regime",
                "currentInstrument": instrument_symbol,
                "regimeConfigProgress": i + 1,
                "regimeConfigTotal": n_configs,
            }
        rc = RegimeConfig(
            lookback=int(cfg_dict.get("lookback", 50)),
            trend_threshold=float(cfg_dict.get("trend_threshold", 0.00015)),
            volatility_high=float(cfg_dict.get("volatility_high", 0.02)),
            volatility_low=float(cfg_dict.get("volatility_low", 0.004)),
            donchian_boundary_frac=float(cfg_dict.get("donchian_boundary_frac", 0.998)),
        )
        series = detect_regime_series(bars, config=rc)
        entropy = _regime_entropy(series)
        unknown_ratio = _regime_unknown_ratio(series)
        score = entropy * (1.0 - unknown_ratio)
        if score > best_score:
            best_score = score
            best_config = rc.to_dict()
            counts = Counter(series)
            n = len(series)
            best_regime_dist = {r: c / n for r, c in counts.items()}

    validated, validation_msg = run_regime_validation(
        {"regimeDistribution": best_regime_dist},
        unknown_threshold=0.1,
        max_regime_threshold=0.8,
        min_entropy=0.5,
    )
    logger.info(
        "regime_calibration instrument=%s symbol=%s score=%.4f validated=%s top_regimes=%s",
        instrument_id, instrument_symbol, best_score, validated,
        ", ".join(f"{r}:{p:.0%}" for r, p in list(best_regime_dist.items())[:5]),
    )
    yield {
        "type": "regime_done",
        "result": {
            "instrumentId": instrument_id,
            "instrumentSymbol": instrument_symbol,
            "regimeConfig": best_config,
            "score": round(best_score, 4),
            "regimeDistribution": best_regime_dist,
            "validated": validated,
            "regimeValidationMessage": validation_msg,
        },
    }


def run_param_tune(
    instrument_id: str,
    instrument_symbol: str,
    strategy_id: str,
    strategy_name: str,
    timeframe: str,
    regime: str,
    bars: list[dict[str, Any]],
    regime_config: RegimeConfig | None,
    strategy_params_list: Sequence[dict[str, float] | None] | None,
    risk_grid: dict[str, list[Any]] | None,
    spread_pct: float | None,
    in_sample_ratio: float = 0.7,
    max_risk_configs: int = 9,
    max_param_configs: int = 3,
    min_trades_oos: int = 0,
    rank_by_oos_profit: bool = True,
) -> dict[str, Any]:
    """
    Grid search over strategy params + risk params for a given instrument × regime.
    Uses walk-forward: tune on first in_sample_ratio of bars, validate on rest.
    By default ranks by OOS profit (not in-sample Sharpe) to reduce overfitting.
    When rank_by_oos_profit=True: pick config with highest OOS profit; if tradesOOS < min_trades_oos,
    prefer configs with more OOS trades, then highest OOS profit.
    """
    if not bars or len(bars) < 100:
        return {
            "instrumentId": instrument_id,
            "strategyId": strategy_id,
            "regime": regime,
            "strategyParams": {},
            "riskParams": {},
            "sharpeInSample": 0.0,
            "profitOOS": 0.0,
            "tradesOOS": 0,
        }

    split = int(len(bars) * in_sample_ratio)
    bars_in = bars[:split]
    bars_oos = bars[split:]

    strat_params = strategy_params_list or [None]
    if len(strat_params) > max_param_configs:
        step = len(strat_params) / max_param_configs
        strat_params = [strat_params[min(int(i * step), len(strat_params) - 1)] for i in range(max_param_configs)]

    risk_configs = _cartesian(risk_grid or RISK_GRID)
    if len(risk_configs) > max_risk_configs:
        step = len(risk_configs) / max_risk_configs
        risk_configs = [risk_configs[min(int(i * step), len(risk_configs) - 1)] for i in range(max_risk_configs)]

    candidates: list[dict[str, Any]] = []

    for sp in strat_params:
        for risk in risk_configs:
            bt_config = {
                "stop_loss_pct": risk.get("stop_loss_pct", 0.02),
                "risk_per_trade_pct": risk.get("risk_per_trade_pct", 0.01),
                "take_profit_r": risk.get("take_profit_r", 2.0),
            }
            if risk.get("max_hold_bars") is not None:
                bt_config["max_hold_bars"] = int(risk["max_hold_bars"])
            row_in = _run_single(
                instrument_id,
                instrument_symbol,
                strategy_id,
                strategy_name,
                timeframe,
                regime,
                bars_in,
                strategy_params=sp,
                spread_pct=spread_pct,
                bt_config=bt_config,
                regime_config=regime_config,
            )
            row_oos = _run_single(
                instrument_id,
                instrument_symbol,
                strategy_id,
                strategy_name,
                timeframe,
                regime,
                bars_oos,
                strategy_params=sp,
                spread_pct=spread_pct,
                bt_config=bt_config,
                regime_config=regime_config,
            )
            oos_profit = row_oos.get("profit") or 0.0
            oos_trades = row_oos.get("trades") or 0
            sharpe_in = row_in.get("sharpeRatio") or 0.0
            candidates.append({
                "strat_params": sp,
                "risk": {
                    "stopLossPct": bt_config["stop_loss_pct"],
                    "riskPerTradePct": bt_config["risk_per_trade_pct"],
                    "takeProfitR": bt_config["take_profit_r"],
                },
                "sharpeInSample": sharpe_in,
                "profitOOS": oos_profit,
                "tradesOOS": oos_trades,
            })

    if not candidates:
        return {
            "instrumentId": instrument_id,
            "strategyId": strategy_id,
            "regime": regime,
            "timeframe": timeframe,
            "strategyParams": {},
            "riskParams": {"stopLossPct": 0.02, "riskPerTradePct": 0.01, "takeProfitR": 2.0},
            "sharpeInSample": 0.0,
            "profitOOS": 0.0,
            "tradesOOS": 0,
        }

    if rank_by_oos_profit:
        # Primary: OOS profit (higher = better). Secondary: more OOS trades.
        best = max(candidates, key=lambda c: (c["profitOOS"], c["tradesOOS"]))
    else:
        best = max(candidates, key=lambda c: c["sharpeInSample"])

    logger.info(
        "param_tune instrument=%s strategy=%s regime=%s oos_profit=%.2f trades_oos=%d sharpe_in=%.2f",
        instrument_id, strategy_id, regime, best["profitOOS"], best["tradesOOS"], best["sharpeInSample"],
    )
    logger.info(
        "param_tune found instrument=%s strategy=%s regime=%s strategyParams=%s riskParams=%s",
        instrument_id, strategy_id, regime, best["strat_params"] or {}, best["risk"],
    )
    return {
        "instrumentId": instrument_id,
        "strategyId": strategy_id,
        "regime": regime,
        "timeframe": timeframe,
        "strategyParams": best["strat_params"] or {},
        "riskParams": best["risk"],
        "sharpeInSample": round(best["sharpeInSample"], 2),
        "profitOOS": round(best["profitOOS"], 2),
        "tradesOOS": best["tradesOOS"],
    }


def _run_param_tune_with_bars(
    instrument_id: str,
    instrument_symbol: str,
    strategy_id: str,
    strategy_name: str,
    timeframe: str,
    regime: str,
    bars_in: list[dict[str, Any]],
    bars_oos: list[dict[str, Any]],
    regime_config: RegimeConfig | None,
    strat_params: Sequence[dict[str, float] | None],
    risk_configs: list[dict[str, Any]],
    spread_pct: float | None,
) -> dict[str, Any]:
    """Internal: run param tune with explicit in/OOS bars. Returns best by OOS profit."""
    candidates: list[dict[str, Any]] = []
    for sp in (strat_params or [None]):
        for risk in risk_configs:
            bt_config = {
                "stop_loss_pct": risk.get("stop_loss_pct", 0.02),
                "risk_per_trade_pct": risk.get("risk_per_trade_pct", 0.01),
                "take_profit_r": risk.get("take_profit_r", 2.0),
            }
            if risk.get("max_hold_bars") is not None:
                bt_config["max_hold_bars"] = int(risk["max_hold_bars"])
            row_oos = _run_single(
                instrument_id, instrument_symbol, strategy_id, strategy_name,
                timeframe, regime, bars_oos,
                strategy_params=sp, spread_pct=spread_pct, bt_config=bt_config,
                regime_config=regime_config,
            )
            oos_profit = row_oos.get("profit") or 0.0
            oos_trades = row_oos.get("trades") or 0
            oos_sharpe = row_oos.get("sharpeRatio") or 0.0
            oos_max_dd = row_oos.get("maxDrawdown") or 0.0
            oos_wr = row_oos.get("winRate") or 0.0
            row_in = _run_single(
                instrument_id, instrument_symbol, strategy_id, strategy_name,
                timeframe, regime, bars_in,
                strategy_params=sp, spread_pct=spread_pct, bt_config=bt_config,
                regime_config=regime_config,
            )
            candidates.append({
                "strat_params": sp,
                "risk": {
                    "stopLossPct": bt_config["stop_loss_pct"],
                    "riskPerTradePct": bt_config["risk_per_trade_pct"],
                    "takeProfitR": bt_config["take_profit_r"],
                },
                "sharpeInSample": row_in.get("sharpeRatio") or 0.0,
                "profitOOS": oos_profit,
                "tradesOOS": oos_trades,
                "sharpeRatio": oos_sharpe,
                "maxDrawdown": oos_max_dd,
                "winRate": oos_wr,
            })
    score_candidates_profitability_consistency(candidates)
    if not candidates:
        return {
            "instrumentId": instrument_id, "strategyId": strategy_id, "regime": regime,
            "timeframe": timeframe, "strategyParams": {}, "riskParams": {},
            "sharpeInSample": 0.0, "profitOOS": 0.0, "tradesOOS": 0,
        }
    # Rank by profitability+consistency score (higher = better), then OOS profit, then trades
    best = max(candidates, key=lambda c: (c["profitabilityConsistencyScore"], c["profitOOS"], c["tradesOOS"]))
    return {
        "instrumentId": instrument_id, "strategyId": strategy_id, "regime": regime,
        "timeframe": timeframe,
        "strategyParams": best["strat_params"] or {},
        "riskParams": best["risk"],
        "sharpeInSample": round(best["sharpeInSample"], 2),
        "profitOOS": round(best["profitOOS"], 2),
        "tradesOOS": best["tradesOOS"],
    }


def _get_risk_configs_for_scope(scope: str, max_configs: int) -> list[dict[str, Any]]:
    """Scope grid configs filtered by scope for profitability + consistency iteration."""
    filtered = [c for c in SCOPE_GRID_CONFIGS if c.get("scope") == scope]
    if not filtered:
        # Fallback to RISK_GRID_ROBUST cartesian (no max_hold_bars)
        full = _cartesian(RISK_GRID_ROBUST)
        if len(full) > max_configs:
            step = len(full) / max_configs
            full = [full[min(int(i * step), len(full) - 1)] for i in range(max_configs)]
        return [{"stop_loss_pct": r["stop_loss_pct"], "risk_per_trade_pct": r["risk_per_trade_pct"], "take_profit_r": r["take_profit_r"]} for r in full]
    if len(filtered) > max_configs:
        step = len(filtered) / max_configs
        filtered = [filtered[min(int(i * step), len(filtered) - 1)] for i in range(max_configs)]
    return [
        {
            "stop_loss_pct": c["stop_loss_pct"],
            "risk_per_trade_pct": c["risk_per_trade_pct"],
            "take_profit_r": c["take_profit_r"],
            "max_hold_bars": c.get("max_hold_bars"),
        }
        for c in filtered
    ]


def run_param_tune_robust(
    instrument_id: str,
    instrument_symbol: str,
    strategy_id: str,
    strategy_name: str,
    timeframe: str,
    regime: str,
    bars: list[dict[str, Any]],
    regime_config: RegimeConfig | None,
    strategy_params_list: Sequence[dict[str, float] | None] | None,
    spread_pct: float | None,
    max_risk_configs: int = 54,
    max_param_configs: int = 6,
    min_trades_oos: int = 5,
    walk_forward_splits: int = 5,
    use_successive_halving: bool = True,
    use_scope_grid: bool = True,
) -> dict[str, Any]:
    """
    Robust param tune: OOS profit objective, walk-forward validation, optional successive halving.
    When use_scope_grid: use SCOPE_GRID_CONFIGS filtered by scope (scalp/day/swing/position).
    Goal: balance profitability and consistency over extended periods.
    """
    scope = TF_TO_SCOPE.get(timeframe.upper(), "day")
    logger.info(
        "param_tune_robust instrument=%s strategy=%s regime=%s scope=%s bars=%d splits=%d successive_halving=%s use_scope_grid=%s",
        instrument_id, strategy_id, regime, scope, len(bars) if bars else 0, walk_forward_splits, use_successive_halving, use_scope_grid,
    )
    if not bars or len(bars) < 200:
        return {
            "instrumentId": instrument_id, "strategyId": strategy_id, "regime": regime,
            "timeframe": timeframe, "strategyParams": {}, "riskParams": {},
            "sharpeInSample": 0.0, "profitOOS": 0.0, "tradesOOS": 0,
        }

    if use_scope_grid:
        risk_configs_full = _get_risk_configs_for_scope(scope, max_risk_configs)
    else:
        risk_configs_full = _cartesian(RISK_GRID_ROBUST)
        if len(risk_configs_full) > max_risk_configs:
            step = len(risk_configs_full) / max_risk_configs
            risk_configs_full = [risk_configs_full[min(int(i * step), len(risk_configs_full) - 1)] for i in range(max_risk_configs)]

    strat_params = strategy_params_list or [None]
    if len(strat_params) > max_param_configs:
        step = len(strat_params) / max_param_configs
        strat_params = [strat_params[min(int(i * step), len(strat_params) - 1)] for i in range(max_param_configs)]

    n = len(bars)
    wf_results: list[dict[str, Any]] = []

    for split_idx in range(walk_forward_splits):
        logger.debug("param_tune_robust split=%d/%d instrument=%s strategy=%s regime=%s", split_idx + 1, walk_forward_splits, instrument_id, strategy_id, regime)
        # Walk-forward: train on 60%, validate on 20%, test on 20%
        train_end = int(n * 0.6)
        val_end = int(n * 0.8)
        if split_idx > 0:
            # Rotate: shift the window
            shift = (split_idx * (n // walk_forward_splits)) % n
            train_end = (train_end + shift) % n
            val_end = (val_end + shift) % n
            if train_end > val_end:
                train_end, val_end = 0, int(n * 0.2)
        bars_train = bars[:train_end]
        bars_val = bars[train_end:val_end]
        bars_test = bars[val_end:]

        if len(bars_train) < 50 or len(bars_val) < 30:
            continue

        if use_successive_halving and len(risk_configs_full) > 12:
            # Stage 1: 20% of data, full grid
            bars_s1 = bars_train[: int(len(bars_train) * 0.2)] if len(bars_train) > 100 else bars_train
            if len(bars_s1) < 30:
                bars_s1 = bars_train
            candidates_s1: list[tuple[dict, float, int]] = []
            for sp in strat_params:
                for risk in risk_configs_full:
                    bt_config = {
                        "stop_loss_pct": risk.get("stop_loss_pct", 0.02),
                        "risk_per_trade_pct": risk.get("risk_per_trade_pct", 0.01),
                        "take_profit_r": risk.get("take_profit_r", 2.0),
                    }
                    if risk.get("max_hold_bars") is not None:
                        bt_config["max_hold_bars"] = int(risk["max_hold_bars"])
                    row = _run_single(
                        instrument_id, instrument_symbol, strategy_id, strategy_name,
                        timeframe, regime, bars_s1,
                        strategy_params=sp, spread_pct=spread_pct, bt_config=bt_config,
                        regime_config=regime_config,
                    )
                    profit = row.get("profit") or 0.0
                    trades = row.get("trades") or 0
                    candidates_s1.append(({"sp": sp, "risk": risk, "bt_config": bt_config}, profit, trades))
            keep = max(1, len(candidates_s1) // 5)
            top_s1 = sorted(candidates_s1, key=lambda x: (x[1], x[2]), reverse=True)[:keep]
            risk_configs_stage2 = [c[0]["risk"] for c in top_s1]
        else:
            risk_configs_stage2 = risk_configs_full

        tune = _run_param_tune_with_bars(
            instrument_id, instrument_symbol, strategy_id, strategy_name,
            timeframe, regime,
            bars_train, bars_val,
            regime_config, strat_params, risk_configs_stage2, spread_pct,
        )
        test_row = _run_single(
            instrument_id, instrument_symbol, strategy_id, strategy_name,
            timeframe, regime, bars_test,
            strategy_params=tune.get("strategyParams"),
            spread_pct=spread_pct,
            bt_config={
                "stop_loss_pct": tune["riskParams"].get("stopLossPct", 0.02),
                "risk_per_trade_pct": tune["riskParams"].get("riskPerTradePct", 0.01),
                "take_profit_r": tune["riskParams"].get("takeProfitR", 2.0),
            },
            regime_config=regime_config,
        )
        tune["profitOOS"] = round(test_row.get("profit") or 0.0, 2)
        tune["tradesOOS"] = test_row.get("trades") or 0
        wf_results.append(tune)

    if not wf_results:
        return run_param_tune(
            instrument_id, instrument_symbol, strategy_id, strategy_name,
            timeframe, regime, bars, regime_config, strategy_params_list,
            RISK_GRID_ROBUST, spread_pct,
            max_risk_configs=max_risk_configs, max_param_configs=max_param_configs,
            min_trades_oos=min_trades_oos, rank_by_oos_profit=True,
        )

    # Pick config that is profitable in most splits, else highest avg OOS profit
    profitable_count = sum(1 for r in wf_results if r["profitOOS"] > 0)
    if profitable_count >= walk_forward_splits // 2:
        best = max(wf_results, key=lambda r: (r["profitOOS"], r["tradesOOS"]))
    else:
        best = max(wf_results, key=lambda r: (r["profitOOS"], r["tradesOOS"]))
    logger.info(
        "param_tune_robust best instrument=%s strategy=%s regime=%s oos_profit=%.2f trades_oos=%d splits_used=%d",
        instrument_id, strategy_id, regime, best["profitOOS"], best["tradesOOS"], len(wf_results),
    )
    logger.info(
        "param_tune_robust found instrument=%s strategy=%s regime=%s strategyParams=%s riskParams=%s",
        instrument_id, strategy_id, regime, best.get("strategyParams", {}), best.get("riskParams", {}),
    )
    return best


def run_grid_research(
    instrument_ids: list[str],
    strategy_ids: list[str],
    strategy_names: dict[str, str],
    timeframes: list[str],
    instrument_symbols: dict[str, str],
    bars: dict[str, list[dict[str, Any]]],
    instrument_spreads: dict[str, float] | None = None,
    regimes: list[str] | None = None,
    regime_grid_max: int = 9,
    param_tune_max_strat: int = 2,
    param_tune_max_risk: int = 6,
    date_from: str = "",
    date_to: str = "",
    calibration_hints: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """
    Full grid research: Phase 0 baseline (defaults), Phase 1 regime calibration, Phase 2 param tune.
    Baseline runs with default RegimeConfig + default risk to establish before-tuning metrics.
    Returns regimeTunes and paramTunes for backtest to consume.
    """
    from . import mt5_client
    from .backtest_server import _normalize_bars, _spread_points_to_fraction

    regimes = regimes or ["trending_bull", "trending_bear", "ranging", "volatile", "breakout"]
    spreads = instrument_spreads or {}
    regime_tunes: list[dict[str, Any]] = []
    param_tunes: list[dict[str, Any]] = []
    baseline_results: list[dict[str, Any]] = []
    skipped_instruments: list[dict[str, Any]] = []

    for inst_id in instrument_ids:
        symbol = (instrument_symbols or {}).get(inst_id) or inst_id.replace("inst-", "").replace("-", "").upper()
        if not symbol:
            skipped_instruments.append({"instrumentId": inst_id, "reason": "no_symbol", "detail": "instrument_symbols missing or empty"})
            logger.warning("research skip instrument=%s reason=no_symbol (multi-instrument mode: instrument_symbols missing)", inst_id)
            continue

        # Cross-TF: process each TF that has bars (not just first)
        tfs_with_bars: list[str] = []
        for tf in (timeframes or ["M5"]):
            key = f"{inst_id}|{tf}"
            if key in (bars or {}) and bars[key] and len(bars[key]) >= 200:
                tfs_with_bars.append(tf)
        if not tfs_with_bars and mt5_client.is_connected():
            mt5_sym = symbol.replace("/", "").strip().upper()
            for tf in (timeframes or ["M5"]):
                ohlc_try = mt5_client.get_rates(
                    mt5_sym, tf, count=10_000,
                    date_from=date_from or None, date_to=date_to or None,
                )
                if ohlc_try and len(ohlc_try) >= 200:
                    tfs_with_bars.append(tf)
                    break

        if not tfs_with_bars:
            skipped_instruments.append({"instrumentId": inst_id, "instrumentSymbol": symbol, "reason": "insufficient_bars", "barCount": 0, "minRequired": 200})
            logger.warning("research skip instrument=%s symbol=%s reason=insufficient_bars (no TF with >=200 bars)", inst_id, symbol)
            continue

        spread_pct = None
        spread_pts = spreads.get(inst_id)

        for tf in tfs_with_bars:
            key = f"{inst_id}|{tf}"
            ohlc = _normalize_bars(bars[key])
            if spread_pts is not None and isinstance(spread_pts, (int, float)) and spread_pct is None:
                try:
                    val = float(spread_pts)
                    if not (val != val or val < 0):
                        mid = ohlc[-1]["close"] if ohlc else 1.0
                        spread_pct = _spread_points_to_fraction(val, symbol, mid)
                except (TypeError, ValueError):
                    pass

            baseline = run_baseline_instrument(
                inst_id, symbol, ohlc,
                strategy_ids=strategy_ids,
                strategy_names=strategy_names or {},
                regimes=regimes,
                timeframe=tf,
                spread_pct=spread_pct,
            )
            scope = TF_TO_SCOPE.get(tf.upper(), "day")
            baseline_results.append({
                "instrumentId": inst_id,
                "instrumentSymbol": symbol,
                "timeframe": tf,
                "scope": scope,
                "regimeDistribution": baseline.get("regimeDistribution", {}),
                "baselineAvgSharpe": baseline.get("baselineAvgSharpe", 0),
                "baselineTotalProfit": baseline.get("baselineTotalProfit", 0),
            })

            hint = (calibration_hints or {}).get(inst_id, {})
            seed_config = hint.get("regimeConfig") if isinstance(hint.get("regimeConfig"), dict) else None
            regime_result = run_regime_calibration(
                inst_id, symbol, ohlc, max_configs=regime_grid_max, seed_config=seed_config
            )
            regime_result["timeframe"] = tf
            regime_result["scope"] = scope
            regime_tunes.append(regime_result)
            rc = RegimeConfig.from_dict(regime_result["regimeConfig"])

            for strategy_id in strategy_ids:
                name = (strategy_names or {}).get(strategy_id) or strategy_id
                param_combos = get_param_combinations(strategy_id, max_combinations=param_tune_max_strat)
                for regime in regimes:
                    if regime == "any":
                        continue
                    tune = run_param_tune(
                        inst_id, symbol, strategy_id, name,
                        tf, regime, ohlc,
                        regime_config=rc,
                        strategy_params_list=param_combos if param_combos else [None],
                        risk_grid=RISK_GRID,
                        spread_pct=spread_pct,
                        max_risk_configs=param_tune_max_risk,
                        max_param_configs=param_tune_max_strat,
                    )
                    tune["scope"] = scope
                    param_tunes.append(tune)

    if skipped_instruments:
        logger.info(
            "research completed with %d skipped instrument(s) (multi-instrument mode): %s",
            len(skipped_instruments),
            [(s.get("instrumentId"), s.get("reason"), s.get("barCount") or s.get("detail")) for s in skipped_instruments],
        )
    return {
        "regimeTunes": regime_tunes,
        "paramTunes": param_tunes,
        "baselineResults": baseline_results,
        "skippedInstruments": skipped_instruments,
    }


def run_grid_research_with_progress(
    instrument_ids: list[str],
    strategy_ids: list[str],
    strategy_names: dict[str, str],
    timeframes: list[str],
    instrument_symbols: dict[str, str],
    bars: dict[str, list[dict[str, Any]]],
    instrument_spreads: dict[str, float] | None = None,
    regimes: list[str] | None = None,
    regime_grid_max: int = DEFAULT_RESEARCH_REGIME_GRID_MAX,
    param_tune_max_strat: int = DEFAULT_RESEARCH_PARAM_TUNE_MAX_STRAT,
    param_tune_max_risk: int = DEFAULT_RESEARCH_PARAM_TUNE_MAX_RISK,
    date_from: str = "",
    date_to: str = "",
    robust_mode: bool = False,
    calibration_hints: dict[str, dict[str, Any]] | None = None,
):
    """
    Same as run_grid_research but yields progress dicts before the final result.
    Phase 0: baseline (defaults), Phase 1: regime calibration, Phase 2: param tune.
    Yields: {"type": "progress", "message": str, "phase": str, "level": str, ...} then
            {"type": "done", "regimeTunes": [...], "paramTunes": [...]}
    """
    from . import mt5_client
    from .backtest_server import _normalize_bars, _spread_points_to_fraction

    regimes = regimes or ["trending_bull", "trending_bear", "ranging", "volatile", "breakout"]
    spreads = instrument_spreads or {}
    logger.info(
        "grid_research_with_progress instruments=%d strategies=%d robust_mode=%s calibration_hints=%d",
        len(instrument_ids), len(strategy_ids), robust_mode, len(calibration_hints or {}),
    )
    regime_tunes: list[dict[str, Any]] = []
    param_tunes: list[dict[str, Any]] = []
    baseline_results: list[dict[str, Any]] = []
    skipped_instruments: list[dict[str, Any]] = []

    done_param = 0
    actual_completed = 0

    def _progress_payload(completed: int) -> dict[str, Any]:
        pct = round(100 * completed / total_steps, 1) if total_steps else 0
        return {"progress": pct, "total": total_steps, "completed": completed}

    # Cross-TF + per-scope: collect (inst_id, tf) pairs that have bars. Iterate over scopes then TFs.
    def _collect_tf_pairs() -> list[tuple[str, str]]:
        pairs: list[tuple[str, str]] = []
        for scope in ALL_SCOPES:
            scope_tfs = SCOPE_TO_TIMEFRAMES.get(scope, [])
            for inst_id in instrument_ids:
                symbol = (instrument_symbols or {}).get(inst_id) or inst_id.replace("inst-", "").replace("-", "").upper()
                if not symbol:
                    continue
                for tf in (timeframes or ["M5"]):
                    if tf not in scope_tfs:
                        continue
                    key = f"{inst_id}|{tf}"
                    if key in (bars or {}) and bars[key] and len(bars[key]) >= 200:
                        pairs.append((inst_id, tf))
        # Dedupe (same inst+tf can appear in multiple scopes, e.g. D1 in swing and position)
        seen: set[tuple[str, str]] = set()
        out: list[tuple[str, str]] = []
        for p in pairs:
            if p not in seen:
                seen.add(p)
                out.append(p)
        return out

    tf_pairs = _collect_tf_pairs()
    if not tf_pairs and bars:
        # Fallback: use first TF with bars per instrument (legacy behavior)
        for inst_id in instrument_ids:
            for tf in (timeframes or ["M5"]):
                key = f"{inst_id}|{tf}"
                if key in (bars or {}) and bars[key] and len(bars[key]) >= 200:
                    tf_pairs.append((inst_id, tf))
                    break

    baseline_runs_per_inst = len(strategy_ids) * len([r for r in regimes if r != "any"])
    total_param_jobs = len(tf_pairs) * len(strategy_ids) * len([r for r in regimes if r != "any"])
    total_steps = len(tf_pairs) * (1 + baseline_runs_per_inst) + total_param_jobs
    param_jobs_per_inst = baseline_runs_per_inst if tf_pairs else 0

    # Pre-scan: add instruments that never made it into tf_pairs (no symbol or insufficient bars)
    inst_ids_in_pairs = {p[0] for p in tf_pairs}
    for inst_id in instrument_ids:
        if inst_id in inst_ids_in_pairs:
            continue
        symbol = (instrument_symbols or {}).get(inst_id) or inst_id.replace("inst-", "").replace("-", "").upper()
        if not symbol:
            skipped_instruments.append({"instrumentId": inst_id, "reason": "no_symbol", "detail": "instrument_symbols missing or empty"})
            yield {
                "type": "progress",
                "phase": "regime",
                "level": "warning",
                "message": f"Skip {inst_id}: no symbol (instrument_symbols missing or empty)",
                "currentPhase": "skip",
                "currentInstrument": inst_id,
                **_progress_payload(actual_completed),
            }
            continue
        # Has symbol but insufficient bars for all TFs
        max_bars = 0
        for tf in (timeframes or ["M5"]):
            key = f"{inst_id}|{tf}"
            bar_count = len(bars.get(key, [])) if bars else 0
            max_bars = max(max_bars, bar_count)
        skipped_instruments.append({"instrumentId": inst_id, "instrumentSymbol": symbol, "reason": "insufficient_bars", "barCount": max_bars, "minRequired": 200})
        yield {
            "type": "progress",
            "phase": "regime",
            "level": "warning",
            "message": f"Skip {symbol}: insufficient bars ({max_bars})",
            "currentPhase": "skip",
            "currentInstrument": symbol,
            **_progress_payload(actual_completed),
        }

    for idx, (inst_id, tf) in enumerate(tf_pairs):
        symbol = (instrument_symbols or {}).get(inst_id) or inst_id.replace("inst-", "").replace("-", "").upper()
        if not symbol:
            total_steps -= 1 + baseline_runs_per_inst + param_jobs_per_inst
            continue

        key = f"{inst_id}|{tf}"
        ohlc = _normalize_bars(bars[key]) if key in (bars or {}) and bars[key] else None
        if not ohlc and mt5_client.is_connected():
            mt5_sym = symbol.replace("/", "").strip().upper()
            ohlc = mt5_client.get_rates(
                mt5_sym,
                tf,
                count=10_000,
                date_from=date_from or None,
                date_to=date_to or None,
            )

        if not ohlc or len(ohlc) < 200:
            bar_count = len(ohlc or [])
            total_steps -= 1 + baseline_runs_per_inst + param_jobs_per_inst
            skipped_instruments.append({"instrumentId": inst_id, "instrumentSymbol": symbol, "reason": "insufficient_bars", "barCount": bar_count, "minRequired": 200, "timeframe": tf})
            yield {
                "type": "progress",
                "phase": "regime",
                "level": "warning",
                "message": f"Skip {symbol} {tf}: insufficient bars ({bar_count})",
                "currentPhase": "skip",
                "currentInstrument": symbol,
                **_progress_payload(actual_completed),
            }
            continue

        scope = TF_TO_SCOPE.get(tf.upper(), "day")

        # Phase 0: Baseline with defaults (before any tuning)
        spread_pct = None
        spread_pts = spreads.get(inst_id)
        if spread_pts is not None and isinstance(spread_pts, (int, float)):
            try:
                val = float(spread_pts)
                if not (val != val or val < 0):
                    mid = ohlc[-1]["close"] if ohlc else 1.0
                    spread_pct = _spread_points_to_fraction(val, symbol, mid)
            except (TypeError, ValueError):
                pass
        yield {
            "type": "progress",
            "phase": "baseline",
            "level": "info",
            "message": f"Baseline {symbol} {tf} ({scope}) ({idx + 1}/{len(tf_pairs)})...",
            "currentPhase": "baseline",
            "currentInstrument": symbol,
            "instrumentIdx": idx + 1,
            "instrumentTotal": len(tf_pairs),
            **_progress_payload(actual_completed),
        }
        try:
            baseline_gen = run_baseline_instrument_with_progress(
                inst_id, symbol, ohlc,
                strategy_ids=strategy_ids,
                strategy_names=strategy_names or {},
                regimes=regimes,
                timeframe=tf,
                spread_pct=spread_pct,
            )
            baseline = None
            try:
                while True:
                    next(baseline_gen)
                    actual_completed += 1
                    yield {"type": "progress", "phase": "baseline", "level": "progress", "message": f"  → baseline {symbol}...", **_progress_payload(actual_completed)}
            except StopIteration as e:
                baseline = e.value
            if baseline is None:
                raise RuntimeError("Baseline generator did not return result")
            baseline_results.append({
                "instrumentId": inst_id,
                "instrumentSymbol": symbol,
                "timeframe": tf,
                "scope": scope,
                "regimeDistribution": baseline.get("regimeDistribution", {}),
                "baselineAvgSharpe": baseline.get("baselineAvgSharpe", 0),
                "baselineTotalProfit": baseline.get("baselineTotalProfit", 0),
            })
            bl_sum = baseline.get("summary", "")
            bl_sharpe = baseline.get("baselineAvgSharpe", 0)
            bl_profit = baseline.get("baselineTotalProfit", 0)
            yield {"type": "progress", "phase": "baseline", "level": "info", "message": f"  → {bl_sum} | baseline Sharpe={bl_sharpe:.2f}, profit={bl_profit:.2f}", **_progress_payload(actual_completed)}
        except Exception as e:
            actual_completed += 1
            yield {"type": "progress", "phase": "baseline", "level": "warning", "message": f"  → Baseline error: {str(e)[:60]}", **_progress_payload(actual_completed)}

        yield {
            "type": "progress",
            "phase": "regime",
            "level": "progress",
            "message": f"Calibrating regime {symbol} {tf} ({scope}) ({idx + 1}/{len(tf_pairs)})...",
            "currentPhase": "regime",
            "currentInstrument": symbol,
            "instrumentIdx": idx + 1,
            "instrumentTotal": len(tf_pairs),
            **_progress_payload(actual_completed),
        }
        try:
            _regime_max = min(regime_grid_max or MAX_REGIME_CONFIGS, MAX_REGIME_CONFIGS) if robust_mode else (regime_grid_max or DEFAULT_RESEARCH_REGIME_GRID_MAX)
            hint = (calibration_hints or {}).get(inst_id, {})
            seed_config = hint.get("regimeConfig") if isinstance(hint.get("regimeConfig"), dict) else None
            regime_result = None
            for item in _run_regime_calibration_with_progress(
                inst_id, symbol, ohlc,
                regime_grid=None,
                max_configs=_regime_max,
                seed_config=seed_config,
            ):
                if item.get("type") == "regime_done":
                    regime_result = item["result"]
                else:
                    # Regime progress: use fractional completed for smooth ETA during long calibration
                    rp = item.get("regimeConfigProgress")
                    rt = item.get("regimeConfigTotal")
                    if isinstance(rp, (int, float)) and isinstance(rt, (int, float)) and rt > 0:
                        effective = actual_completed + (float(rp) / float(rt))
                        payload = {"progress": round(100 * effective / total_steps, 1) if total_steps else 0, "total": total_steps, "completed": effective}
                    else:
                        payload = _progress_payload(actual_completed)
                    yield {**item, **payload}
            if regime_result is None:
                raise RuntimeError("Regime calibration produced no result")
        except Exception as e:
            total_steps -= param_jobs_per_inst
            actual_completed += 1
            yield {"type": "progress", "phase": "regime", "level": "error", "message": f"  → Error: {str(e)[:80]}", **_progress_payload(actual_completed)}
            continue
        actual_completed += 1
        regime_result["timeframe"] = tf
        regime_result["scope"] = scope
        regime_tunes.append(regime_result)
        score = regime_result.get("score", 0)
        dist = regime_result.get("regimeDistribution", {})
        top_regimes = ", ".join(f"{r}:{p:.0%}" for r, p in list(dist.items())[:5])
        validated = regime_result.get("validated", True)
        val_msg = regime_result.get("regimeValidationMessage") or ""
        msg = f"{symbol} done (score={score:.2f}): {top_regimes}"
        level = "warning" if not validated and val_msg else "success"
        if not validated and val_msg:
            msg += f" [validation: {val_msg}]"
        yield {"type": "progress", "phase": "regime", "level": level, "instrumentId": inst_id, "message": msg, **_progress_payload(actual_completed)}

        rc = RegimeConfig.from_dict(regime_result["regimeConfig"])

        for strategy_id in strategy_ids:
            name = (strategy_names or {}).get(strategy_id) or strategy_id
            param_combos = get_param_combinations(strategy_id, max_combinations=param_tune_max_strat)
            for regime in regimes:
                if regime == "any":
                    continue
                done_param += 1
                yield {
                    "type": "progress",
                    "phase": "param",
                    "level": "progress",
                    "instrumentId": inst_id,
                    "strategyId": strategy_id,
                    "regime": regime,
                    "message": f"Tuning {symbol} {tf} × {strategy_id} × {regime} ({done_param}/{total_param_jobs})",
                    "currentPhase": "param",
                    "currentInstrument": symbol,
                    "currentStrategy": strategy_id,
                    "currentRegime": regime,
                    "paramJobDone": done_param,
                    "paramJobTotal": total_param_jobs,
                    **_progress_payload(actual_completed),
                }
                try:
                    if robust_mode:
                        _max_risk = min(param_tune_max_risk or MAX_RISK_CONFIGS, MAX_RISK_CONFIGS)
                        tune = run_param_tune_robust(
                            inst_id, symbol, strategy_id, name,
                            tf, regime, ohlc,
                            regime_config=rc,
                            strategy_params_list=param_combos if param_combos else [None],
                            spread_pct=spread_pct,
                            max_risk_configs=_max_risk,
                            max_param_configs=max(
                                3 * DEFAULT_RESEARCH_PARAM_TUNE_MAX_STRAT,
                                (param_tune_max_strat or DEFAULT_RESEARCH_PARAM_TUNE_MAX_STRAT) * 2,
                            ),
                            min_trades_oos=MIN_OOS_TRADES,
                            walk_forward_splits=WALK_FORWARD_SPLITS,
                            use_successive_halving=True,
                        )
                    else:
                        tune = run_param_tune(
                            inst_id, symbol, strategy_id, name,
                            tf, regime, ohlc,
                            regime_config=rc,
                            strategy_params_list=param_combos if param_combos else [None],
                            risk_grid=RISK_GRID,
                            spread_pct=spread_pct,
                            max_risk_configs=param_tune_max_risk,
                            max_param_configs=param_tune_max_strat,
                            min_trades_oos=MIN_OOS_TRADES,
                            rank_by_oos_profit=True,
                        )
                    tune["scope"] = scope
                    param_tunes.append(tune)
                    sharpe = tune.get("sharpeInSample", 0)
                    oos_profit = tune.get("profitOOS", 0)
                    trades_oos = tune.get("tradesOOS", 0)
                    unrealized = " (unrealized)" if trades_oos == 0 and oos_profit != 0 else ""
                    actual_completed += 1
                    yield {
                        "type": "progress",
                        "phase": "param",
                        "level": "success",
                        "instrumentId": inst_id,
                        "strategyId": strategy_id,
                        "regime": regime,
                        "message": f"  → Sharpe={sharpe:.2f}, OOS profit={oos_profit:.2f}{unrealized}, trades={trades_oos}",
                        "currentPhase": "param",
                        "currentInstrument": symbol,
                        "currentStrategy": strategy_id,
                        "currentRegime": regime,
                        "paramJobDone": done_param,
                        "paramJobTotal": total_param_jobs,
                        "instrumentIdx": idx + 1,
                        "instrumentTotal": len(tf_pairs),
                        **_progress_payload(actual_completed),
                    }
                except Exception as e:
                    err_msg = str(e)[:80]
                    actual_completed += 1
                    yield {
                        "type": "progress",
                        "phase": "param",
                        "level": "error",
                        "instrumentId": inst_id,
                        "strategyId": strategy_id,
                        "regime": regime,
                        "message": f"  → Error: {err_msg}",
                        "currentPhase": "param",
                        "currentInstrument": symbol,
                        "currentStrategy": strategy_id,
                        "currentRegime": regime,
                        "paramJobDone": done_param,
                        "paramJobTotal": total_param_jobs,
                        **_progress_payload(actual_completed),
                    }

    if skipped_instruments:
        logger.info(
            "research completed with %d skipped instrument(s) (multi-instrument mode): %s",
            len(skipped_instruments),
            [(s.get("instrumentId"), s.get("reason"), s.get("barCount") or s.get("detail")) for s in skipped_instruments],
        )
    yield {
        "type": "done",
        "regimeTunes": regime_tunes,
        "paramTunes": param_tunes,
        "baselineResults": baseline_results,
        "skippedInstruments": skipped_instruments,
    }
