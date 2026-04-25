"""
Parallel backtest driver that fans out jobs across multiple processes.

The single-threaded `run_backtest` / `run_backtest_stream` functions in
``backtest_server.py`` are convenient but hit a CPU ceiling of one core,
even on a workstation with 16+ threads available. A research run that expands
to 20 000+ (instrument × strategy × tf × regime × param_combo) jobs takes
minutes of wall-clock time for that reason.

This module provides a drop-in parallel runner:

* ``run_backtest_parallel`` fans jobs out to a ``ProcessPoolExecutor`` with
  a size controlled by ``CICADA_BACKTEST_WORKERS`` (see ``compute.py``).
* Each worker re-uses the same ``_run_single`` function so results are
  bit-identical to the serial runner — this is critical for `verify-parity`.
* The runner is a generator so it can be wrapped by the streaming endpoint:
  results are yielded in the order they complete (not the order they were
  submitted), which is fine for progress UIs.

Worker safety: each subprocess gets its own MT5 client connection *only when
requested*. In practice, callers hand us pre-fetched bars via the ``bars``
dict, so the workers never need network access — they just crunch numbers.
This keeps the fan-out deterministic and avoids broker rate-limit issues.
"""

from __future__ import annotations

import logging
import os
from concurrent.futures import ProcessPoolExecutor, as_completed
from typing import Any, Iterator

from .backtest_server import (
    _infer_instrument_type,
    _normalize_bars,
    _run_single,
    _iso_now,
)
from .backtest_server import (
    TF_TO_SCOPE,
    MIN_BARS_REQUIRED_BACKTEST,
)
from .compute import get_compute_config
from .grid_config import normalize_param_combos_limit
from .regime_detection import RegimeConfig
from .multi_timeframe import build_htf_index_for_each_ltf_bar, get_higher_timeframe
from .strategy_params import get_param_combinations
from .spread_utils import spread_points_to_fraction as spread_points_to_fraction_instrument


logger = logging.getLogger(__name__)


def _spread_points_to_fraction(pts: float, symbol: str, mid: float) -> float:
    return spread_points_to_fraction_instrument(pts, symbol, mid)


def _job_worker(payload: dict) -> dict:
    """Worker entrypoint: runs ``_run_single`` on a pre-normalised job payload."""
    try:
        regime_cfg = None
        if payload.get("regime_config_dict"):
            regime_cfg = RegimeConfig.from_dict(payload["regime_config_dict"])
        row = _run_single(
            instrument_id=payload["inst_id"],
            instrument_symbol=payload["symbol"],
            strategy_id=payload["strategy_id"],
            strategy_name=payload["name"],
            timeframe=payload["tf"],
            regime=payload["regime"],
            bars=payload["ohlc_bars"],
            strategy_params=payload.get("strategy_params"),
            spread_pct=payload.get("spread_pct"),
            bt_config=payload.get("job_config"),
            regime_config=regime_cfg,
            htf_bars=payload.get("htf_bars"),
            htf_index_by_ltf=payload.get("htf_index_by_ltf"),
            prefer_htf_regime=payload.get("prefer_htf_regime"),
            instrument_type=payload.get("instrument_type", "fiat"),
        )
        return {"ok": True, "row": row}
    except Exception as e:
        return {"ok": False, "error": repr(e), "job": {
            "inst_id": payload.get("inst_id"),
            "symbol": payload.get("symbol"),
            "strategy_id": payload.get("strategy_id"),
            "tf": payload.get("tf"),
            "regime": payload.get("regime"),
        }}


def _iter_jobs(
    instrument_ids: list[str],
    strategy_ids: list[str],
    strategy_names: dict[str, str],
    timeframes: list[str],
    regimes: list[str],
    instrument_symbols: dict[str, str],
    bars: dict[str, list[dict[str, Any]]],
    instrument_spreads: dict[str, float],
    backtest_config: dict[str, Any] | None,
    instrument_risk_overrides: dict[str, dict[str, float]] | None,
    job_risk_overrides: dict[str, dict[str, float]] | None,
    param_combos_limit: int | None,
    regime_tunes: dict[str, dict[str, Any]] | None,
    prefer_htf_regime: bool | None,
    instrument_types: dict[str, str] | None,
) -> Iterator[dict]:
    """Yield fully-resolved worker payloads, one per backtest job."""
    spreads = instrument_spreads or {}
    for inst_id in instrument_ids:
        symbol = (instrument_symbols or {}).get(inst_id) or inst_id.replace("inst-", "").replace("-", "").upper()
        if not symbol:
            continue
        inst_type = (instrument_types or {}).get(inst_id) or _infer_instrument_type(inst_id, symbol)
        for strategy_id in strategy_ids:
            name = (strategy_names or {}).get(strategy_id) or strategy_id
            pc = normalize_param_combos_limit(param_combos_limit)
            param_combos = get_param_combinations(strategy_id, max_combinations=pc)
            for strategy_params in param_combos:
                params_to_send = strategy_params if strategy_params else None
                for tf in timeframes:
                    key = f"{inst_id}|{tf}"
                    bar_list = bars.get(key)
                    if not bar_list or len(bar_list) < MIN_BARS_REQUIRED_BACKTEST:
                        # Parallel driver only handles pre-fetched bars; rely
                        # on callers to validate depth up front.
                        continue
                    ohlc_bars = _normalize_bars(bar_list)
                    spread_pts = spreads.get(inst_id)
                    mid = ohlc_bars[-1]["close"] if ohlc_bars else 1.0
                    spread_pct = None
                    if spread_pts is not None and isinstance(spread_pts, (int, float)):
                        try:
                            val = float(spread_pts)
                            if not (val != val or val < 0):
                                spread_pct = _spread_points_to_fraction(val, symbol, mid)
                        except (TypeError, ValueError):
                            pass
                    job_key = f"{inst_id}|{strategy_id}"
                    job_key_tf = f"{inst_id}|{strategy_id}|{tf}"
                    job_overrides = (job_risk_overrides or {}).get(job_key_tf) or (job_risk_overrides or {}).get(job_key)
                    inst_overrides = (instrument_risk_overrides or {}).get(inst_id) or {}
                    overrides = job_overrides if job_overrides else inst_overrides
                    job_config = dict(backtest_config or {})
                    if overrides.get("riskPerTradePct") is not None:
                        job_config["risk_per_trade_pct"] = overrides["riskPerTradePct"]
                    if overrides.get("stopLossPct") is not None:
                        job_config["stop_loss_pct"] = overrides["stopLossPct"]
                    if overrides.get("takeProfitR") is not None:
                        job_config["take_profit_r"] = overrides["takeProfitR"]
                    regime_cfg_dict: dict[str, Any] | None = None
                    if regime_tunes:
                        tf_key = f"{inst_id}|{tf}"
                        if tf_key in regime_tunes:
                            regime_cfg_dict = dict(regime_tunes[tf_key])
                        elif inst_id in regime_tunes:
                            regime_cfg_dict = dict(regime_tunes[inst_id])
                    htf_bars_norm: list[dict[str, Any]] | None = None
                    htf_index_by_ltf: list[int] | None = None
                    htf_tf = get_higher_timeframe(tf)
                    if htf_tf:
                        hkey_htf = f"{inst_id}|{htf_tf}"
                        raw_htf = bars.get(hkey_htf)
                        if raw_htf:
                            htf_bars_norm = _normalize_bars(raw_htf)
                            if len(htf_bars_norm) >= 2:
                                htf_index_by_ltf = build_htf_index_for_each_ltf_bar(ohlc_bars, htf_bars_norm)
                    for regime in regimes:
                        yield {
                            "inst_id": inst_id,
                            "symbol": symbol,
                            "strategy_id": strategy_id,
                            "name": name,
                            "tf": tf,
                            "regime": regime,
                            "ohlc_bars": ohlc_bars,
                            "strategy_params": params_to_send,
                            "spread_pct": spread_pct,
                            "job_config": job_config or None,
                            "regime_config_dict": regime_cfg_dict,
                            "htf_bars": htf_bars_norm,
                            "htf_index_by_ltf": htf_index_by_ltf,
                            "prefer_htf_regime": prefer_htf_regime,
                            "instrument_type": inst_type,
                        }


def run_backtest_parallel(
    *,
    instrument_ids: list[str],
    strategy_ids: list[str],
    strategy_names: dict[str, str],
    timeframes: list[str],
    regimes: list[str],
    instrument_symbols: dict[str, str],
    bars: dict[str, list[dict[str, Any]]],
    instrument_spreads: dict[str, float] | None = None,
    backtest_config: dict[str, Any] | None = None,
    instrument_risk_overrides: dict[str, dict[str, float]] | None = None,
    job_risk_overrides: dict[str, dict[str, float]] | None = None,
    param_combos_limit: int | None = None,
    regime_tunes: dict[str, dict[str, Any]] | None = None,
    prefer_htf_regime: bool | None = None,
    instrument_types: dict[str, str] | None = None,
    max_workers: int | None = None,
) -> Iterator[tuple[dict[str, Any], int, int]]:
    """Run all backtest jobs in parallel and yield (row, completed, total).

    Results are yielded in completion order, not submission order. The total
    is the count of jobs actually submitted (bars-missing jobs are elided).
    """
    cfg = get_compute_config()
    workers = max(1, int(max_workers or cfg.backtest_workers))
    jobs = list(
        _iter_jobs(
            instrument_ids=instrument_ids,
            strategy_ids=strategy_ids,
            strategy_names=strategy_names,
            timeframes=timeframes,
            regimes=regimes,
            instrument_symbols=instrument_symbols,
            bars=bars,
            instrument_spreads=instrument_spreads or {},
            backtest_config=backtest_config,
            instrument_risk_overrides=instrument_risk_overrides,
            job_risk_overrides=job_risk_overrides,
            param_combos_limit=param_combos_limit,
            regime_tunes=regime_tunes,
            prefer_htf_regime=prefer_htf_regime,
            instrument_types=instrument_types,
        )
    )
    total = len(jobs)
    if total == 0:
        return

    # When there's only a handful of jobs the fork overhead dwarfs the work.
    if total <= max(4, workers):
        completed = 0
        for job in jobs:
            res = _job_worker(job)
            completed += 1
            if res.get("ok"):
                yield res["row"], completed, total
            else:
                yield _failed_row_from_job(job, res.get("error", "unknown")), completed, total
        return

    # Spawn workers: use ``spawn`` where forking is unsafe (e.g. torch on mac).
    context = "spawn" if os.name == "nt" else None
    executor_kwargs: dict[str, Any] = {"max_workers": workers}
    if context is not None:
        import multiprocessing as mp
        executor_kwargs["mp_context"] = mp.get_context(context)
    with ProcessPoolExecutor(**executor_kwargs) as pool:
        futures = {pool.submit(_job_worker, job): job for job in jobs}
        completed = 0
        for fut in as_completed(futures):
            completed += 1
            res = fut.result()
            if res.get("ok"):
                yield res["row"], completed, total
            else:
                yield _failed_row_from_job(futures[fut], res.get("error", "unknown")), completed, total


def _failed_row_from_job(job: dict, error: str) -> dict[str, Any]:
    """Keep the streaming shape intact even when a worker crashes."""
    return {
        "instrumentId": job.get("inst_id"),
        "instrumentSymbol": job.get("symbol"),
        "strategyId": job.get("strategy_id"),
        "strategyName": job.get("name", job.get("strategy_id")),
        "timeframe": job.get("tf"),
        "regime": job.get("regime"),
        "scope": TF_TO_SCOPE.get((job.get("tf") or "").upper(), "day"),
        "winRate": 0.0,
        "profit": 0.0,
        "trades": 0,
        "maxDrawdown": 0.0,
        "profitFactor": 0.0,
        "sharpeRatio": 0.0,
        "sortinoRatio": 0.0,
        "avgHoldBars": 0.0,
        "status": "failed",
        "completedAt": _iso_now(),
        "error": error,
    }
