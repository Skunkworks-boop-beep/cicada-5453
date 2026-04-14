"""
Server-side backtest for CICADA-5453. Fetches OHLC from MT5, runs a simple strategy, returns
results in the same shape as the frontend (BacktestResultRow) for offload/remote run.
Includes param grid iteration so NN training receives strategyParams-augmented rows.
"""

from __future__ import annotations

import time
from typing import Any

from . import mt5_client
from .backtest_config import get_backtest_config
from .regime_detection import RegimeConfig, detect_regime_series
from .signals import get_signal
from .spread_utils import spread_points_to_fraction as spread_points_to_fraction_instrument
from .grid_config import normalize_param_combos_limit
from .strategy_params import get_param_combinations
from .multi_timeframe import build_htf_index_for_each_ltf_bar, get_higher_timeframe

MIN_BARS_REQUIRED_BACKTEST = 10  # Halt if fewer; no inference or skip

TF_TO_SCOPE: dict[str, str] = {
    "M1": "scalp",
    "M5": "scalp",
    "M15": "day",
    "M30": "day",
    "H1": "day",
    "H4": "swing",
    "D1": "swing",
    "W1": "position",
}

# Max hold bars per scope — realistic backtest: scalp exits quickly, swing holds longer
SCOPE_MAX_HOLD_BARS: dict[str, int] = {
    "scalp": 15,
    "day": 48,
    "swing": 120,
    "position": 252,
}

# Scope-specific defaults when no job override (realistic per trade mode)
SCOPE_BACKTEST_DEFAULTS: dict[str, dict[str, float]] = {
    "scalp": {"stop_loss_pct": 0.01, "take_profit_r": 1.5, "risk_per_trade_pct": 0.005},
    "day": {"stop_loss_pct": 0.02, "take_profit_r": 2.0, "risk_per_trade_pct": 0.01},
    "swing": {"stop_loss_pct": 0.03, "take_profit_r": 2.5, "risk_per_trade_pct": 0.01},
    "position": {"stop_loss_pct": 0.04, "take_profit_r": 3.0, "risk_per_trade_pct": 0.008},
}


def _spread_points_to_fraction(
    spread_points: float, instrument_symbol: str, mid_price: float = 1.0
) -> float:
    """Convert spread (points/pips) to price fraction using instrument-specific point size."""
    return spread_points_to_fraction_instrument(spread_points, instrument_symbol, mid_price)


def _resolve_prefer_htf_regime(
    prefer_htf_regime: bool | None,
    htf_bars: list | None,
    regime_lookback: int,
) -> bool:
    if prefer_htf_regime is False:
        return False
    if prefer_htf_regime is True:
        return True
    return bool(htf_bars and len(htf_bars) >= regime_lookback + 2)


def _run_single(
    instrument_id: str,
    instrument_symbol: str,
    strategy_id: str,
    strategy_name: str,
    timeframe: str,
    regime: str,
    bars: list[dict[str, Any]],
    strategy_params: dict[str, float] | None = None,
    spread_pct: float | None = None,
    bt_config: dict | None = None,
    regime_config: RegimeConfig | None = None,
    htf_bars: list[dict[str, Any]] | None = None,
    htf_index_by_ltf: list[int] | None = None,
    prefer_htf_regime: bool | None = None,
) -> dict[str, Any]:
    """Run backtest using get_signal (RSI, MACD, FVG, BOS, etc.) — real strategy logic, no momentum fallback."""
    scope = TF_TO_SCOPE.get(timeframe.upper(), "day")
    cfg = get_backtest_config(bt_config)
    scope_defaults = SCOPE_BACKTEST_DEFAULTS.get(scope, {})
    for k in ("stop_loss_pct", "take_profit_r", "risk_per_trade_pct"):
        if (not bt_config or bt_config.get(k) is None) and k in scope_defaults:
            cfg[k] = scope_defaults[k]
    max_hold_bars = int(bt_config.get("max_hold_bars")) if (bt_config and bt_config.get("max_hold_bars") is not None) else SCOPE_MAX_HOLD_BARS.get(scope, 120)
    spread = spread_pct if spread_pct is not None else cfg["spread_pct"]
    if not bars or len(bars) < 10:
        row: dict[str, Any] = {
            "instrumentId": instrument_id,
            "instrumentSymbol": instrument_symbol,
            "strategyId": strategy_id,
            "strategyName": strategy_name,
            "timeframe": timeframe,
            "regime": regime,
            "scope": scope,
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
        }
        if strategy_params:
            row["strategyParams"] = strategy_params
        return row

    initial_equity = cfg["initial_equity"]
    regime_lookback = cfg["regime_lookback"]
    risk_pct = cfg["risk_per_trade_pct"]
    stop_pct = cfg["stop_loss_pct"]
    target_r = cfg["take_profit_r"]
    slippage_pct = cfg["slippage_pct"]

    equity = initial_equity
    peak = initial_equity
    max_dd = 0.0
    trades: list[dict[str, Any]] = []
    position: dict[str, Any] | None = None

    # Regime at each bar — research regime_config wins; else optional HTF-mapped regime (slow filter)
    regime_series: list[str]
    if regime_config is not None:
        regime_series = detect_regime_series(bars, config=regime_config)
    else:
        use_htf_reg = bool(
            _resolve_prefer_htf_regime(prefer_htf_regime, htf_bars, regime_lookback)
            and htf_bars
            and htf_index_by_ltf
            and len(htf_bars) >= regime_lookback + 2
        )
        if use_htf_reg:
            htf_reg = detect_regime_series(htf_bars, lookback=regime_lookback)
            regime_series = []
            for i0 in range(len(bars)):
                hi = htf_index_by_ltf[i0] if htf_index_by_ltf and i0 < len(htf_index_by_ltf) else -1
                if hi < 0:
                    regime_series.append("unknown")
                else:
                    regime_series.append(htf_reg[hi] if hi < len(htf_reg) else htf_reg[-1])
        else:
            regime_series = detect_regime_series(bars, lookback=regime_lookback)

    signal_ctx: dict[str, Any] | None = None
    if htf_bars and htf_index_by_ltf and len(htf_bars) >= 2:
        signal_ctx = {"htf_bars": htf_bars, "htf_index_by_ltf": htf_index_by_ltf}

    for i in range(1, len(bars)):
        bar = bars[i]
        o, h, l, c = bar["open"], bar["high"], bar["low"], bar["close"]
        reg_at_bar = regime_series[i] if i < len(regime_series) else "unknown"

        signal = get_signal(strategy_id, bars, i, reg_at_bar, strategy_params, signal_ctx)

        if position is not None:
            # Check exit: max_hold (scope constraint), stop/target, or signal flip
            entry = position["entry"]
            side = position["side"]
            size = position["size"]
            stop = position["stop"]
            target = position["target"]
            hold_bars = i - position["entry_bar"]
            exit_price: float | None = None
            exit_reason = "signal"
            if hold_bars >= max_hold_bars:
                exit_price = c * (1 - spread) if side == 1 else c * (1 + spread)
                exit_reason = "max_hold"
            elif side == 1:
                if l <= stop:
                    exit_price = stop
                    exit_reason = "stop"
                elif h >= target:
                    exit_price = target
                    exit_reason = "target"
                elif signal == -1:
                    exit_price = c
                    exit_reason = "signal"
            else:
                if h >= stop:
                    exit_price = stop
                    exit_reason = "stop"
                elif l <= target:
                    exit_price = target
                    exit_reason = "target"
                elif signal == 1:
                    exit_price = c
                    exit_reason = "signal"

            if exit_price is not None:
                # Spread/slippage: at signal/max_hold exit use close ± spread and slippage; at stop/target apply slippage only.
                slippage = c * slippage_pct
                if exit_reason in ("signal", "max_hold"):
                    if side == 1:
                        exit_price = c * (1 - spread) - slippage
                    else:
                        exit_price = c * (1 + spread) + slippage
                else:
                    if side == 1:
                        exit_price = exit_price - slippage
                    else:
                        exit_price = exit_price + slippage

                pnl = (exit_price - entry) * size if side == 1 else (entry - exit_price) * size
                pnl_pct = (pnl / (entry * size)) * 100 if entry and size else 0
                equity += pnl
                hold = i - position["entry_bar"]
                trades.append({"pnl": pnl, "pnl_pct": pnl_pct, "hold_bars": hold})
                if equity > peak:
                    peak = equity
                dd = (peak - equity) / peak if peak and peak > 0 else 0
                if dd > max_dd:
                    max_dd = dd
                position = None

        # Entry: real signal logic (RSI, MACD, BB, FVG, BOS, liquidity sweep, breakout retest, etc.)
        # regime 'any' = bypass filter (enter whenever strategy signals)
        regime_matches = regime == "any" or reg_at_bar == regime
        if position is None and regime_matches and signal != 0:
            risk_amount = equity * risk_pct
            dist = abs(c - o) or c * stop_pct
            sl_dist = max(dist, c * stop_pct)
            tp_dist = sl_dist * target_r
            if signal == 1:
                stop = c - sl_dist
                target = c + tp_dist
            else:
                stop = c + sl_dist
                target = c - tp_dist
            size = risk_amount / sl_dist if sl_dist else 0
            if size > 0:
                # Entry pays spread: long at ask (c + spread), short at bid (c - spread)
                entry_price = c * (1 + spread) if signal == 1 else c * (1 - spread)
                position = {
                    "entry": entry_price,
                    "entry_bar": i,
                    "side": signal,
                    "size": size,
                    "stop": stop,
                    "target": target,
                }

    # Unrealized
    if position is not None and bars:
        last = bars[-1]["close"]
        side = position["side"]
        size = position["size"]
        entry = position["entry"]
        pnl = (last - entry) * size if side == 1 else (entry - last) * size
        equity += pnl

    wins = sum(1 for t in trades if t["pnl"] > 0)
    total_trades = len(trades)
    win_rate = (100.0 * wins / total_trades) if total_trades else 0.0
    profit = equity - initial_equity
    gross_profit = sum(t["pnl"] for t in trades if t["pnl"] > 0)
    gross_loss = abs(sum(t["pnl"] for t in trades if t["pnl"] < 0))
    profit_factor = (gross_profit / gross_loss) if gross_loss else (2.0 if gross_profit else 0.0)
    avg_hold = (sum(t["hold_bars"] for t in trades) / total_trades) if total_trades else 0.0

    # Sharpe/Sortino from trade returns (pnl_pct). Cap to ±10 to avoid explosion with few/similar trades.
    returns = [t["pnl_pct"] / 100.0 for t in trades]
    avg_ret = (sum(returns) / len(returns)) if returns else 0.0
    std_ret = (sum((r - avg_ret) ** 2 for r in returns) / len(returns)) ** 0.5 if len(returns) > 1 else 0.0
    _sharpe_raw = (avg_ret / std_ret * (252 ** 0.5)) if std_ret and std_ret > 1e-10 else 0.0
    sharpe = max(-10.0, min(10.0, _sharpe_raw))
    downside = [r for r in returns if r < 0]
    std_down = (sum(r ** 2 for r in downside) / len(downside)) ** 0.5 if downside else 0.0
    _sortino_raw = (avg_ret / std_down * (252 ** 0.5)) if std_down and std_down > 1e-10 else 0.0
    sortino = max(-10.0, min(10.0, _sortino_raw))

    data_end_time: str | None = None
    if bars and len(bars) > 0:
        from datetime import datetime, timezone
        last_ts = bars[-1].get("time")
        if last_ts is not None:
            data_end_time = datetime.fromtimestamp(last_ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")

    result: dict[str, Any] = {
        "instrumentId": instrument_id,
        "instrumentSymbol": instrument_symbol,
        "strategyId": strategy_id,
        "strategyName": strategy_name,
        "timeframe": timeframe,
        "regime": regime,
        "scope": scope,
        "winRate": round(win_rate, 1),
        "profit": round(profit, 2),
        "trades": total_trades,
        "maxDrawdown": round(max_dd, 4),
        "profitFactor": round(profit_factor, 2),
        "sharpeRatio": round(sharpe, 2),
        "sortinoRatio": round(sortino, 2),
        "avgHoldBars": round(avg_hold, 1),
        "status": "completed",
        "completedAt": _iso_now(),
        "dataSource": "live",
    }
    if data_end_time:
        result["dataEndTime"] = data_end_time
    if strategy_params:
        result["strategyParams"] = strategy_params
    return result


def _iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _normalize_bars(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert client bars: time in ms -> seconds if needed; ensure open/high/low/close."""
    out: list[dict[str, Any]] = []
    for b in raw:
        t = b.get("time")
        if t is None:
            continue
        # Client sends time in ms; backend expects seconds for datetime.fromtimestamp
        if t > 1e12:
            t = t / 1000.0
        out.append({
            "time": t,
            "open": float(b.get("open", 0)),
            "high": float(b.get("high", 0)),
            "low": float(b.get("low", 0)),
            "close": float(b.get("close", 0)),
            "volume": float(b.get("volume", 0)),
        })
    return out


def run_backtest(
    instrument_ids: list[str],
    strategy_ids: list[str],
    strategy_names: dict[str, str],
    timeframes: list[str],
    regimes: list[str],
    instrument_symbols: dict[str, str],
    date_from: str,
    date_to: str,
    bars: dict[str, list[dict[str, Any]]] | None = None,
    instrument_spreads: dict[str, float] | None = None,
    backtest_config: dict[str, Any] | None = None,
    instrument_risk_overrides: dict[str, dict[str, float]] | None = None,
    job_risk_overrides: dict[str, dict[str, float]] | None = None,
    param_combos_limit: int | None = None,
    regime_tunes: dict[str, dict[str, Any]] | None = None,
    prefer_htf_regime: bool | None = None,
) -> list[dict[str, Any]]:
    """
    Run server-side backtest: for each (instrument, strategy, tf, regime) load OHLC from
    client-provided bars (Deriv/eXness/MT5) or MT5 when available. Returns list of
    BacktestResultRow-like dicts (with id added by API).
    """
    results: list[dict[str, Any]] = []
    count = 10_000  # bars per request
    bars_provided = bars or {}
    spreads = instrument_spreads or {}

    for inst_id in instrument_ids:
        symbol = (instrument_symbols or {}).get(inst_id) or inst_id.replace("inst-", "").replace("-", "").upper()
        if not symbol:
            continue
        mt5_symbol = symbol.replace("/", "").strip().upper()  # MT5 uses EURUSD not EUR/USD
        for strategy_id in strategy_ids:
            name = (strategy_names or {}).get(strategy_id) or strategy_id
            pc = normalize_param_combos_limit(param_combos_limit)
            param_combos = get_param_combinations(strategy_id, max_combinations=pc)
            for strategy_params in param_combos:
                params_to_send = strategy_params if strategy_params else None
                for tf in timeframes:
                    ohlc_bars: list[dict[str, Any]] | None = None
                    key = f"{inst_id}|{tf}"
                    if key in bars_provided and bars_provided[key]:
                        ohlc_bars = _normalize_bars(bars_provided[key])
                    if ohlc_bars is None and mt5_client.is_connected():
                        ohlc_bars = mt5_client.get_rates(
                            mt5_symbol, tf, count=count,
                            date_from=date_from or None,
                            date_to=date_to or None,
                        )
                    if not ohlc_bars:
                        # No bars: return failed row (no simulated data)
                        for regime in regimes:
                            failed_row: dict[str, Any] = {
                                "instrumentId": inst_id,
                                "instrumentSymbol": symbol,
                                "strategyId": strategy_id,
                                "strategyName": name,
                                "timeframe": tf,
                                "regime": regime,
                                "scope": TF_TO_SCOPE.get(tf.upper(), "day"),
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
                            }
                            if params_to_send:
                                failed_row["strategyParams"] = params_to_send
                            results.append(failed_row)
                        continue
                    spread_pts = spreads.get(inst_id)
                    mid_price = ohlc_bars[-1]["close"] if ohlc_bars else 1.0
                    spread_pct = None
                    if spread_pts is not None and isinstance(spread_pts, (int, float)):
                        try:
                            val = float(spread_pts)
                            if not (val != val or val < 0):  # reject NaN and negative
                                spread_pct = _spread_points_to_fraction(val, symbol, mid_price)
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
                    # Instrument-specific regime config from research (per inst or per inst|tf)
                    regime_config = None
                    if regime_tunes:
                        key_tf = f"{inst_id}|{tf}"
                        if key_tf in regime_tunes:
                            regime_config = RegimeConfig.from_dict(regime_tunes[key_tf])
                        elif inst_id in regime_tunes:
                            regime_config = RegimeConfig.from_dict(regime_tunes[inst_id])
                    htf_bars_norm: list[dict[str, Any]] | None = None
                    htf_index_by_ltf: list[int] | None = None
                    htf_tf = get_higher_timeframe(tf)
                    if htf_tf:
                        hkey_htf = f"{inst_id}|{htf_tf}"
                        raw_htf = bars_provided.get(hkey_htf)
                        if raw_htf:
                            htf_bars_norm = _normalize_bars(raw_htf)
                            if len(htf_bars_norm) >= 2:
                                htf_index_by_ltf = build_htf_index_for_each_ltf_bar(ohlc_bars, htf_bars_norm)

                    for regime in regimes:
                        row = _run_single(
                            inst_id, symbol, strategy_id, name, tf, regime, ohlc_bars,
                            params_to_send, spread_pct, job_config or None,
                            regime_config=regime_config,
                            htf_bars=htf_bars_norm,
                            htf_index_by_ltf=htf_index_by_ltf,
                            prefer_htf_regime=prefer_htf_regime,
                        )
                        results.append(row)

    return results


def run_backtest_stream(
    instrument_ids: list[str],
    strategy_ids: list[str],
    strategy_names: dict[str, str],
    timeframes: list[str],
    regimes: list[str],
    instrument_symbols: dict[str, str],
    date_from: str,
    date_to: str,
    bars: dict[str, list[dict[str, Any]]] | None = None,
    instrument_spreads: dict[str, float] | None = None,
    backtest_config: dict[str, Any] | None = None,
    instrument_risk_overrides: dict[str, dict[str, float]] | None = None,
    job_risk_overrides: dict[str, dict[str, float]] | None = None,
    param_combos_limit: int | None = None,
    regime_tunes: dict[str, dict[str, Any]] | None = None,
    prefer_htf_regime: bool | None = None,
):
    """
    Stream server-side backtest rows one by one.
    Yields tuples: (row, completed, total).
    """
    count = 10_000
    bars_provided = bars or {}
    spreads = instrument_spreads or {}

    total = 0
    for _inst_id in instrument_ids:
        for strategy_id in strategy_ids:
            pc = normalize_param_combos_limit(param_combos_limit)
            param_combos = get_param_combinations(strategy_id, max_combinations=pc)
            total += len(param_combos) * len(timeframes) * len(regimes)

    completed = 0
    for inst_id in instrument_ids:
        symbol = (instrument_symbols or {}).get(inst_id) or inst_id.replace("inst-", "").replace("-", "").upper()
        if not symbol:
            continue
        mt5_symbol = symbol.replace("/", "").strip().upper()
        for strategy_id in strategy_ids:
            name = (strategy_names or {}).get(strategy_id) or strategy_id
            pc = normalize_param_combos_limit(param_combos_limit)
            param_combos = get_param_combinations(strategy_id, max_combinations=pc)
            for strategy_params in param_combos:
                params_to_send = strategy_params if strategy_params else None
                for tf in timeframes:
                    ohlc_bars: list[dict[str, Any]] | None = None
                    key = f"{inst_id}|{tf}"
                    if key in bars_provided and bars_provided[key]:
                        ohlc_bars = _normalize_bars(bars_provided[key])
                    if ohlc_bars is None and mt5_client.is_connected():
                        ohlc_bars = mt5_client.get_rates(
                            mt5_symbol, tf, count=count,
                            date_from=date_from or None,
                            date_to=date_to or None,
                        )
                    if not ohlc_bars:
                        for regime in regimes:
                            failed_row: dict[str, Any] = {
                                "instrumentId": inst_id,
                                "instrumentSymbol": symbol,
                                "strategyId": strategy_id,
                                "strategyName": name,
                                "timeframe": tf,
                                "regime": regime,
                                "scope": TF_TO_SCOPE.get(tf.upper(), "day"),
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
                            }
                            if params_to_send:
                                failed_row["strategyParams"] = params_to_send
                            completed += 1
                            yield failed_row, completed, total
                        continue
                    spread_pts = spreads.get(inst_id)
                    mid_price = ohlc_bars[-1]["close"] if ohlc_bars else 1.0
                    spread_pct = None
                    if spread_pts is not None and isinstance(spread_pts, (int, float)):
                        try:
                            val = float(spread_pts)
                            if not (val != val or val < 0):
                                spread_pct = _spread_points_to_fraction(val, symbol, mid_price)
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
                    regime_config = None
                    if regime_tunes:
                        key_tf = f"{inst_id}|{tf}"
                        if key_tf in regime_tunes:
                            regime_config = RegimeConfig.from_dict(regime_tunes[key_tf])
                        elif inst_id in regime_tunes:
                            regime_config = RegimeConfig.from_dict(regime_tunes[inst_id])
                    htf_bars_norm: list[dict[str, Any]] | None = None
                    htf_index_by_ltf: list[int] | None = None
                    htf_tf = get_higher_timeframe(tf)
                    if htf_tf:
                        hkey_htf = f"{inst_id}|{htf_tf}"
                        raw_htf = bars_provided.get(hkey_htf)
                        if raw_htf:
                            htf_bars_norm = _normalize_bars(raw_htf)
                            if len(htf_bars_norm) >= 2:
                                htf_index_by_ltf = build_htf_index_for_each_ltf_bar(ohlc_bars, htf_bars_norm)

                    for regime in regimes:
                        row = _run_single(
                            inst_id, symbol, strategy_id, name, tf, regime, ohlc_bars,
                            params_to_send, spread_pct, job_config or None,
                            regime_config=regime_config,
                            htf_bars=htf_bars_norm,
                            htf_index_by_ltf=htf_index_by_ltf,
                            prefer_htf_regime=prefer_htf_regime,
                        )
                        completed += 1
                        yield row, completed, total
