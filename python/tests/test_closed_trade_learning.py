"""Regression tests for the closed-trade → training-row synthesizer.

The bot now learns from every placed trade. These tests lock the conversion
in: aggregation correctness, paper-trade normalisation, min-trade filtering,
and the multi-source merge that backs ``shadow_train_*``.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.closed_trade_learning import (
    merge_training_sources,
    synthesize_rows_from_closed_trades,
    synthesize_rows_from_paper_trades,
)


def _trade(pnl: float, **kw) -> dict:
    base = {"strategyId": "ind-rsi", "type": "LONG", "instrumentId": "inst-eurusd",
            "openedAt": "2026-04-26T11:00:00.000Z",
            "closedAt": "2026-04-26T11:05:00.000Z"}
    base.update(kw)
    base["pnl"] = pnl
    return base


# ── Aggregation ────────────────────────────────────────────────────────────


def test_synth_drops_under_min_trades():
    rows = synthesize_rows_from_closed_trades("inst-eurusd", [_trade(1)])
    assert rows == []  # default min_trades=5


def test_synth_aggregates_winrate_and_profit():
    trades = [_trade(10), _trade(-5), _trade(20), _trade(-3), _trade(8), _trade(-2)]
    rows = synthesize_rows_from_closed_trades("inst-eurusd", trades, min_trades=3)
    assert len(rows) == 1
    r = rows[0]
    assert r["trades"] == 6
    assert r["winRate"] == pytest.approx(50.0)  # 3 wins / 6
    assert r["profit"] == pytest.approx(28.0)
    # PF = 38 / 10 = 3.8
    assert r["profitFactor"] == pytest.approx(3.8, rel=1e-3)
    assert r["dataSource"] == "live"


def test_synth_caps_pf_when_no_losses():
    trades = [_trade(10) for _ in range(10)]
    rows = synthesize_rows_from_closed_trades("inst-eurusd", trades, min_trades=3)
    assert rows[0]["profitFactor"] == 10.0


def test_synth_groups_by_strategy_id():
    trades = [_trade(5, strategyId="a") for _ in range(5)] + [_trade(-3, strategyId="b") for _ in range(5)]
    rows = synthesize_rows_from_closed_trades("inst-eurusd", trades, min_trades=3)
    assert len(rows) == 2
    assert {r["strategyId"] for r in rows} == {"a", "b"}


def test_synth_drawdown_walks_equity_curve():
    # Three wins, then a five-trade losing streak that draws the equity down.
    trades = [_trade(10), _trade(10), _trade(10), _trade(-8), _trade(-8), _trade(-8), _trade(-8), _trade(-8)]
    rows = synthesize_rows_from_closed_trades("inst-eurusd", trades, min_trades=3)
    # peak = 30, trough = -10, max_dd = 40/30 ≈ 1.33 (capped above 1.0 is fine; field is unitless)
    assert rows[0]["maxDrawdown"] > 0


# ── Paper trades ───────────────────────────────────────────────────────────


def test_paper_trades_skip_open_records():
    paper = [
        {"id": "p1", "side": "LONG", "pnl": 5.0, "opened_at": 1, "closed_at": 2, "instrument_id": "inst-eurusd"},
        {"id": "p2", "side": "LONG", "pnl": 0.0, "opened_at": 3, "closed_at": None, "instrument_id": "inst-eurusd"},
    ]
    rows = synthesize_rows_from_paper_trades("inst-eurusd", paper, min_trades=1)
    # Only the closed paper trade should produce a row; p2 (open) is ignored.
    assert rows[0]["trades"] == 1


def test_paper_trades_label_regime_paper():
    paper = [
        {"id": f"p{i}", "side": "LONG", "pnl": 3.0, "opened_at": 1, "closed_at": 2, "instrument_id": "inst-x"}
        for i in range(5)
    ]
    rows = synthesize_rows_from_paper_trades("inst-x", paper, min_trades=3)
    assert rows[0]["regime"] == "paper"


# ── Merge ──────────────────────────────────────────────────────────────────


def test_merge_appends_live_and_paper_to_backtest():
    backtest = [{"x": 1}, {"x": 2}]
    closed = {"bot1": [_trade(5) for _ in range(6)]}
    paper = {"bot1": [{"id": f"p{i}", "side": "LONG", "pnl": 1, "opened_at": 1, "closed_at": 2, "instrument_id": "inst-eurusd"} for i in range(6)]}
    merged = merge_training_sources(backtest, closed, paper)
    # 2 backtest + 1 closed-trade row + 1 paper-trade row.
    assert len(merged) == 4
    sources = [r.get("dataSource") for r in merged if "dataSource" in r]
    assert "live" in sources
