"""
Convert live closed trades + paper trades into labelled samples for the
shadow-training pipeline.

Background
==========
The system today learns from three sources, but only one was actually wired
into training:

  1. Backtest results          ✅ feed shadow training (existing path)
  2. Live closed trades        ❌ used only for drift detection
  3. Observe-mode paper trades ❌ no follow-up — no labels at all

Closing the gap matters more than tuning hyperparameters: every real trade
the bot makes is a *labelled OOS sample* — the most valuable training data
we have, because it comes from the exact distribution the bot is deployed
on. With ~50–100 closed trades a day on a single bot, the next retrain has
genuine recent data to learn from.

This module:

* Maps closed-trade dicts (the shape persisted under ``closedTradesByBot``
  in ``positions.json``) to "synthetic backtest rows" that the existing
  ``train`` / ``train_detection`` paths already accept.
* Computes the realised win-rate, profit-factor, sharpe, etc. so each row
  carries the same metric shape as a backtest row.
* Filters rows for sanity (drops 0-PnL or zero-trade records).

The output of ``synthesize_rows_from_closed_trades(...)`` can be appended to
the backtest result list before calling ``train()`` or ``train_detection()``
without any further plumbing.
"""

from __future__ import annotations

import logging
import math
import statistics
from collections import defaultdict
from typing import Any, Iterable


logger = logging.getLogger(__name__)


def _split_by_strategy(closed_trades: list[dict]) -> dict[str, list[dict]]:
    """Group closed trades by strategy id (falling back to a single bucket)."""
    out: dict[str, list[dict]] = defaultdict(list)
    for t in closed_trades:
        sid = (t.get("strategyId") or "live").strip() or "live"
        out[sid].append(t)
    return out


def _aggregate_metrics(trades: list[dict]) -> dict[str, Any]:
    """Compute backtest-row-shaped metrics from a list of closed trades."""
    n = len(trades)
    pnls = [float(t.get("pnl") or 0) for t in trades]
    if not pnls:
        return {
            "winRate": 0.0,
            "profit": 0.0,
            "trades": 0,
            "maxDrawdown": 0.0,
            "profitFactor": 1.0,
            "sharpeRatio": 0.0,
            "sortinoRatio": 0.0,
        }
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    win_rate = len(wins) / n
    profit = sum(pnls)
    gross_profit = sum(wins)
    gross_loss = abs(sum(losses))
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else (10.0 if gross_profit > 0 else 1.0)
    # Equity curve drawdown: walk PnL cumulatively, track peak-to-trough.
    cum = 0.0
    peak = 0.0
    max_dd = 0.0
    for p in pnls:
        cum += p
        if cum > peak:
            peak = cum
        if peak > 0:
            dd = (peak - cum) / peak
            if dd > max_dd:
                max_dd = dd
    # Sharpe / Sortino on per-trade returns (pnl / |entry × size| when known,
    # else use raw pnl / median |pnl| as a scale-free proxy so a 50-trade
    # sample still produces a meaningful ratio).
    if len(pnls) > 1:
        sd = statistics.stdev(pnls)
        if sd > 0:
            sharpe = (statistics.mean(pnls) / sd) * math.sqrt(252)
        else:
            sharpe = 0.0
        downside = [p for p in pnls if p < 0]
        if len(downside) > 1:
            dsd = statistics.stdev(downside)
            sortino = (statistics.mean(pnls) / dsd) * math.sqrt(252) if dsd > 0 else 0.0
        else:
            sortino = 0.0
    else:
        sharpe = 0.0
        sortino = 0.0
    return {
        "winRate": round(win_rate * 100, 2),
        "profit": round(profit, 4),
        "trades": n,
        "maxDrawdown": round(max_dd, 4),
        "profitFactor": round(profit_factor, 4),
        "sharpeRatio": round(max(-10.0, min(10.0, sharpe)), 4),
        "sortinoRatio": round(max(-10.0, min(10.0, sortino)), 4),
    }


def synthesize_rows_from_closed_trades(
    instrument_id: str,
    closed_trades: list[dict],
    *,
    timeframe: str = "M5",
    regime: str = "live",
    instrument_symbol: str | None = None,
    min_trades: int = 5,
) -> list[dict]:
    """Turn a closed-trade ledger into backtest-row-shaped samples grouped by
    strategy. Rows with fewer than ``min_trades`` are dropped so the trainer
    isn't fed noisy single-trade rows.

    The output rows carry ``dataSource='live'`` so the trainer can weight
    live data above synthetic backtest rows when both are present.
    """
    if not closed_trades:
        return []
    by_strategy = _split_by_strategy(closed_trades)
    rows: list[dict] = []
    for sid, trades in by_strategy.items():
        if len(trades) < min_trades:
            logger.debug(
                "synthesize_rows_from_closed_trades: skip strategy=%s n=%d (< min %d)",
                sid, len(trades), min_trades,
            )
            continue
        metrics = _aggregate_metrics(trades)
        # Use the median open / close timestamps from the trades to anchor
        # ``dataEndTime`` so the purged walk-forward sees a sensible time.
        last = max(trades, key=lambda t: t.get("closedAt") or "")
        rows.append({
            "instrumentId": instrument_id,
            "instrumentSymbol": instrument_symbol or instrument_id,
            "strategyId": sid,
            "strategyName": sid,
            "timeframe": timeframe,
            "regime": regime,
            "scope": "live",
            **metrics,
            "status": "completed",
            "completedAt": last.get("closedAt"),
            "dataEndTime": last.get("closedAt"),
            "dataSource": "live",
        })
    return rows


def synthesize_rows_from_paper_trades(
    instrument_id: str,
    paper_trades: list[dict],
    *,
    timeframe: str = "M5",
    regime: str = "paper",
    instrument_symbol: str | None = None,
    min_trades: int = 5,
) -> list[dict]:
    """Same as ``synthesize_rows_from_closed_trades`` but operates on the
    paper-trade ledger emitted by ``paper_trades.PaperTradeStore``.

    Paper trades carry the same ``pnl`` / ``side`` shape as live closed
    trades after ``advance()`` resolves them, so the conversion is identical
    apart from labelling the regime as ``paper`` (so the trainer can give
    real trades higher weight than paper ones if it ever wants to)."""
    if not paper_trades:
        return []
    # Paper trades use snake_case keys; normalise to the closed-trade shape.
    normalised: list[dict] = []
    for p in paper_trades:
        if p.get("closed_at") is None:
            continue  # still open — no label yet
        normalised.append({
            "strategyId": "paper",
            "type": p.get("side"),
            "pnl": p.get("pnl") or 0,
            "openedAt": p.get("opened_at"),
            "closedAt": p.get("closed_at"),
            "instrumentId": p.get("instrument_id") or instrument_id,
        })
    return synthesize_rows_from_closed_trades(
        instrument_id,
        normalised,
        timeframe=timeframe,
        regime=regime,
        instrument_symbol=instrument_symbol,
        min_trades=min_trades,
    )


def merge_training_sources(
    backtest_rows: list[dict],
    closed_trades_by_bot: dict[str, list[dict]] | None = None,
    paper_trades_by_bot: dict[str, list[dict]] | None = None,
    *,
    instrument_symbol_map: dict[str, str] | None = None,
) -> list[dict]:
    """Combine backtest, live closed-trade, and paper-trade rows into a single
    list ready for ``shadow_train_tabular`` / ``train``. Backtest rows are
    kept first (chronologically) then live + paper rows are appended; the
    purged walk-forward in ``train.py`` uses ``dataEndTime`` to slice them
    correctly."""
    out = list(backtest_rows or [])
    sym_map = instrument_symbol_map or {}
    for bot_id, trades in (closed_trades_by_bot or {}).items():
        if not trades:
            continue
        # Use the first trade's instrumentId; bots target a single instrument.
        inst_id = trades[0].get("instrumentId") or bot_id
        rows = synthesize_rows_from_closed_trades(
            inst_id,
            trades,
            instrument_symbol=sym_map.get(inst_id),
        )
        out.extend(rows)
    for bot_id, trades in (paper_trades_by_bot or {}).items():
        if not trades:
            continue
        inst_id = trades[0].get("instrument_id") or bot_id
        rows = synthesize_rows_from_paper_trades(
            inst_id,
            trades,
            instrument_symbol=sym_map.get(inst_id),
        )
        out.extend(rows)
    return out
