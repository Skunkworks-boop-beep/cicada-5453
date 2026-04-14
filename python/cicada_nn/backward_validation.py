"""
Backward validation: analyze closed trades to find calibrations that would have been most profitable.
For losses: analyze the opposite direction (if we went LONG and lost, SHORT would have won) and verify
by simulating. Use verified calibrations to tune regime/param configs.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from .regime_detection import RegimeConfig, detect_regime_series

logger = logging.getLogger(__name__)
from .signals import get_signal
from .research_server import _cartesian, _get_regime_grid_for_instrument

# Scope -> primary timeframe (matches frontend scope.ts)
SCOPE_TO_TIMEFRAME: dict[str, str] = {
    "scalp": "M5",
    "day": "H1",
    "swing": "H4",
    "position": "D1",
}


def _scope_to_timeframe(scope: str | None) -> str:
    if not scope:
        return "H1"
    return SCOPE_TO_TIMEFRAME.get(scope, "H1")


def _find_entry_bar(
    bars: list[dict[str, Any]],
    entry_price: float | None,
    opened_at_ms: int | None,
    closed_at_ms: int | None,
    tolerance_pct: float = 0.002,
) -> int | None:
    """
    Find bar index where trade would have entered.
    Prefer: bar time close to opened_at and close ≈ entry_price.
    Fallback: bar before closed_at with close ≈ entry_price.
    """
    if not bars or len(bars) < 10:
        return None

    best_idx: int | None = None
    best_score = -1.0

    for i in range(10, len(bars) - 1):
        bar = bars[i]
        t = bar.get("time")
        if t is None:
            continue
        bar_ms = int(t) * 1000 if t < 1e12 else int(t)
        c = bar.get("close")
        if c is None or c <= 0:
            continue

        # Time score: prefer bar near opened_at
        time_score = 1.0
        if opened_at_ms is not None:
            diff_ms = abs(bar_ms - opened_at_ms)
            # 1 bar tolerance ~ 5min for M5, 1h for H1
            time_score = max(0, 1.0 - diff_ms / (3600 * 1000 * 2))

        # Price score: prefer close ≈ entry_price
        price_score = 1.0
        if entry_price is not None and entry_price > 0:
            pct_diff = abs(c - entry_price) / entry_price
            if pct_diff <= tolerance_pct:
                price_score = 1.0 - pct_diff / tolerance_pct
            else:
                price_score = 0.0

        score = time_score * 0.5 + price_score * 0.5
        if score > best_score:
            best_score = score
            best_idx = i

    return best_idx


def _simulate_trade_from_bar(
    bars: list[dict[str, Any]],
    entry_bar: int,
    side: int,
    stop_pct: float,
    risk_pct: float,
    target_r: float,
    spread_pct: float = 0.0001,
    slippage_pct: float = 0.00005,
    max_bars: int = 200,
) -> float | None:
    """
    Simulate a single trade from entry_bar: enter with side (1=long, -1=short),
    run until stop/target or signal flip. Return PnL.
    """
    if entry_bar < 0 or entry_bar >= len(bars):
        return None
    c = bars[entry_bar].get("close")
    if c is None or c <= 0:
        return None

    equity = 10_000.0
    risk_amount = equity * risk_pct
    sl_dist = c * stop_pct
    if sl_dist <= 0:
        return None
    tp_dist = sl_dist * target_r
    size = risk_amount / sl_dist

    if side == 1:
        entry_price = c * (1 + spread_pct)
        stop = c - sl_dist
        target = c + tp_dist
    else:
        entry_price = c * (1 - spread_pct)
        stop = c + sl_dist
        target = c - tp_dist

    for j in range(entry_bar + 1, min(entry_bar + max_bars + 1, len(bars))):
        b = bars[j]
        o, h, l, cl = b.get("open", c), b.get("high", c), b.get("low", c), b.get("close", c)
        if o is None or h is None or l is None or cl is None:
            continue

        exit_price: float | None = None
        if side == 1:
            if l <= stop:
                exit_price = stop - cl * slippage_pct
            elif h >= target:
                exit_price = target - cl * slippage_pct
        else:
            if h >= stop:
                exit_price = stop + cl * slippage_pct
            elif l <= target:
                exit_price = target + cl * slippage_pct

        if exit_price is not None:
            if side == 1:
                pnl = (exit_price - entry_price) * size
            else:
                pnl = (entry_price - exit_price) * size
            return pnl

    # Unrealized at end of bars
    last = bars[-1].get("close", c)
    if side == 1:
        return (last - entry_price) * size
    return (entry_price - last) * size


def run_backward_validation(
    closed_trades: list[dict[str, Any]],
    bars_by_key: dict[str, list[dict[str, Any]]],
    instrument_symbols: dict[str, str],
    strategy_ids: list[str],
    strategy_names: dict[str, str],
    max_configs_per_trade: int = 20,
) -> dict[str, Any]:
    """
    For each closed trade:
    1. Determine "correct" direction: if pnl>0 our direction was right; if pnl<0 opposite was right.
    2. Find entry bar in OHLCV.
    3. Simulate the correct-direction trade to verify it would have been profitable.
    4. Grid search calibrations: which regime config + strategy would have produced the correct signal?
    5. Aggregate: return calibration recommendations per instrument.

    Returns:
        {
          "validatedTrades": [...],
          "calibrationHints": { "instrumentId": { "regimeConfig": {...}, "riskParams": {...}, "score": float } },
          "summary": { "total": int, "verified": int, "skipped": int }
        }
    """
    validated: list[dict[str, Any]] = []
    calibration_votes: dict[str, list[dict[str, Any]]] = {}
    skipped = 0

    logger.info(
        "backward_validation start trades=%d instruments=%d strategies=%d bars_keys=%d",
        len(closed_trades),
        len({t.get("instrumentId") for t in closed_trades if t.get("instrumentId")}),
        len(strategy_ids),
        len(bars_by_key),
    )

    for trade in closed_trades:
        instrument_id = trade.get("instrumentId") or ""
        bot_id = trade.get("botId") or ""
        trade_type = trade.get("type")  # "LONG" | "SHORT"
        pnl = float(trade.get("pnl", 0))
        entry_price = trade.get("entryPrice")
        opened_at = trade.get("openedAt")
        closed_at = trade.get("closedAt")
        scope = trade.get("scope")

        if not instrument_id:
            logger.debug("backward_validation skip trade: missing instrumentId")
            skipped += 1
            continue

        symbol = instrument_symbols.get(instrument_id, instrument_id)
        timeframe = _scope_to_timeframe(scope)
        key = f"{instrument_id}|{timeframe}"
        bars = bars_by_key.get(key)
        if not bars or len(bars) < 50:
            logger.debug("backward_validation skip trade instrument=%s key=%s bars=%d", instrument_id, key, len(bars or []))
            skipped += 1
            continue

        opened_at_ms = None
        if opened_at:
            try:
                from datetime import datetime
                dt = datetime.fromisoformat(opened_at.replace("Z", "+00:00"))
                opened_at_ms = int(dt.timestamp() * 1000)
            except Exception:
                pass
        closed_at_ms = None
        if closed_at:
            try:
                from datetime import datetime
                dt = datetime.fromisoformat(closed_at.replace("Z", "+00:00"))
                closed_at_ms = int(dt.timestamp() * 1000)
            except Exception:
                pass

        entry_bar = _find_entry_bar(bars, entry_price, opened_at_ms, closed_at_ms)
        if entry_bar is None:
            logger.debug("backward_validation skip trade instrument=%s: entry_bar not found", instrument_id)
            skipped += 1
            continue

        # Correct direction: if we lost, opposite would have won
        if trade_type == "LONG":
            our_side = 1
        elif trade_type == "SHORT":
            our_side = -1
        else:
            skipped += 1
            continue

        correct_side = our_side if pnl > 0 else (-our_side)

        # Verify: simulate correct-direction trade
        stop_pct = float(trade.get("nnSlPct") or 0.02)
        target_r = float(trade.get("nnTpR") or 2.0)
        risk_pct = 0.01
        sim_pnl = _simulate_trade_from_bar(
            bars, entry_bar, correct_side,
            stop_pct=stop_pct, risk_pct=risk_pct, target_r=target_r,
        )
        if sim_pnl is None or sim_pnl <= 0:
            logger.debug(
                "backward_validation skip trade instrument=%s type=%s: sim_pnl=%s (not profitable)",
                instrument_id, trade_type, sim_pnl,
            )
            skipped += 1
            continue

        logger.info(
            "backward_validation verified instrument=%s type=%s correct_side=%s sim_pnl=%.2f entry_bar=%d",
            instrument_id, trade_type, "LONG" if correct_side == 1 else "SHORT", sim_pnl, entry_bar,
        )
        validated.append({
            "instrumentId": instrument_id,
            "botId": bot_id,
            "tradeType": trade_type,
            "pnl": pnl,
            "correctSide": "LONG" if correct_side == 1 else "SHORT",
            "entryBar": entry_bar,
            "simulatedPnl": sim_pnl,
            "verified": True,
        })

        # Grid search: which calibration would have produced correct_side at entry_bar?
        regime_grid = _get_regime_grid_for_instrument(symbol)
        regime_configs = _cartesian(regime_grid)
        if len(regime_configs) > 12:
            step = len(regime_configs) / 12
            regime_configs = [regime_configs[min(int(i * step), len(regime_configs) - 1)] for i in range(12)]

        for rc_dict in regime_configs:
            rc = RegimeConfig(
                lookback=int(rc_dict.get("lookback", 50)),
                trend_threshold=float(rc_dict.get("trend_threshold", 0.00015)),
                volatility_high=float(rc_dict.get("volatility_high", 0.02)),
                volatility_low=float(rc_dict.get("volatility_low", 0.004)),
                donchian_boundary_frac=float(rc_dict.get("donchian_boundary_frac", 0.998)),
            )
            regime_series = detect_regime_series(bars, config=rc)
            reg_at_bar = regime_series[entry_bar] if entry_bar < len(regime_series) else "unknown"

            for strat_id in strategy_ids:
                sig = get_signal(strat_id, bars, entry_bar, reg_at_bar, None)
                if sig == correct_side:
                    cfg_key = f"{instrument_id}|{strat_id}"
                    if cfg_key not in calibration_votes:
                        calibration_votes[cfg_key] = []
                    calibration_votes[cfg_key].append({
                        "regimeConfig": rc.to_dict(),
                        "regime": reg_at_bar,
                        "strategyId": strat_id,
                        "tradePnl": pnl,
                        "simulatedPnl": sim_pnl,
                    })

    # Aggregate: pick most-voted (regimeConfig, strategyId) per instrument
    inst_config_counts: dict[str, dict[str, int]] = {}
    inst_config_example: dict[str, dict[str, dict[str, Any]]] = {}
    for cfg_key, votes in calibration_votes.items():
        instrument_id = cfg_key.split("|")[0]
        if not votes:
            continue
        for v in votes:
            cfg_str = json.dumps(v["regimeConfig"], sort_keys=True)
            key = f"{cfg_str}|{v['strategyId']}"
            if instrument_id not in inst_config_counts:
                inst_config_counts[instrument_id] = {}
                inst_config_example[instrument_id] = {}
            inst_config_counts[instrument_id][key] = inst_config_counts[instrument_id].get(key, 0) + 1
            if key not in inst_config_example.get(instrument_id, {}):
                inst_config_example[instrument_id][key] = v

    calibration_hints: dict[str, dict[str, Any]] = {}
    for instrument_id, counts in inst_config_counts.items():
        if not counts:
            continue
        best_key = max(counts.keys(), key=lambda k: counts[k])
        example = inst_config_example.get(instrument_id, {}).get(best_key, {})
        strat_id = example.get("strategyId", best_key.split("|")[-1] if "|" in best_key else "")
        calibration_hints[instrument_id] = {
            "regimeConfig": example.get("regimeConfig", {}),
            "strategyId": strat_id,
            "score": counts[best_key],
            "verifiedTrades": counts[best_key],
        }

    logger.info(
        "backward_validation done total=%d verified=%d skipped=%d calibration_hints=%d",
        len(closed_trades), len(validated), skipped, len(calibration_hints),
    )
    logger.debug(
        "backward_validation calibration_hints instruments=%s",
        list(calibration_hints.keys()),
    )
    return {
        "validatedTrades": validated,
        "calibrationHints": calibration_hints,
        "summary": {
            "total": len(closed_trades),
            "verified": len(validated),
            "skipped": skipped,
        },
    }
