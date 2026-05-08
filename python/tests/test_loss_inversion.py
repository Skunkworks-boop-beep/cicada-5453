"""Stage 2B: loss inversion (spec phase 4).

Pinned guarantees:

* Every losing trade produces exactly one INVERSION at the same entry price.
* Winning trades produce no event.
* The inverted PnL has the opposite sign of the original (ignoring spread).
* Output rows always carry ``event_type="INVERSION"``.
"""

from __future__ import annotations

import pytest

from cicada_nn.loss_inversion import InversionEvent, invert_losing_trades


def _trade(trade_id: str, side: str, entry: float, exit_: float, *, t0: float = 1_700_000_000) -> dict:
    return {
        "trade_id": trade_id,
        "side": side,
        "entry_time": t0,
        "entry_price": entry,
        "exit_time": t0 + 60,
        "exit_price": exit_,
    }


def test_losing_long_emits_one_short_inversion():
    trades = [_trade("t1", "LONG", 1.10, 1.09)]  # long lost
    events = invert_losing_trades(trades)
    assert len(events) == 1
    e = events[0]
    assert e.event_type == "INVERSION"
    assert e.original_side == "LONG"
    assert e.inverted_side == "SHORT"
    assert e.entry_price == pytest.approx(1.10)
    assert e.exit_price == pytest.approx(1.09)
    # SHORT pnl = entry - exit = 0.01 (mirror of the long's -0.01).
    assert e.pnl_synth == pytest.approx(0.01)


def test_losing_short_emits_one_long_inversion():
    trades = [_trade("t2", "SHORT", 1.10, 1.11)]  # short lost
    events = invert_losing_trades(trades)
    assert len(events) == 1
    e = events[0]
    assert e.original_side == "SHORT"
    assert e.inverted_side == "LONG"
    # LONG pnl = exit - entry.
    assert e.pnl_synth == pytest.approx(0.01)


def test_winning_trades_produce_no_inversions():
    trades = [
        _trade("w1", "LONG", 1.10, 1.20),
        _trade("w2", "SHORT", 1.20, 1.10),
    ]
    assert invert_losing_trades(trades) == []


def test_break_even_trades_produce_no_inversions():
    trades = [_trade("be", "LONG", 1.10, 1.10)]
    assert invert_losing_trades(trades) == []


def test_inverted_pnl_opposite_sign_of_original():
    """Across a mixed batch the synthetic PnL of every inversion is the
    negative of the original (zero spread/slippage assumed at this stage)."""
    trades = [
        _trade("a", "LONG", 1.10, 1.05),    # original pnl -0.05
        _trade("b", "SHORT", 1.10, 1.13),   # original pnl -0.03
    ]
    events = invert_losing_trades(trades)
    assert len(events) == 2
    expected = {"a": 0.05, "b": 0.03}
    for e in events:
        assert e.pnl_synth == pytest.approx(expected[e.trade_id])


def test_malformed_trades_are_skipped_silently():
    """Closed trades come from the daemon; missing fields shouldn't crash
    the inversion pipeline. Skip and move on."""
    trades = [
        {"trade_id": "ok", "side": "LONG", "entry_time": 1, "entry_price": 1.10,
         "exit_time": 2, "exit_price": 1.05},
        {"trade_id": "missing_side"},
        {"trade_id": "bad_price", "side": "LONG", "entry_time": 1, "entry_price": "x",
         "exit_time": 2, "exit_price": 1.05},
    ]
    events = invert_losing_trades(trades)
    assert len(events) == 1
    assert events[0].trade_id == "ok"


def test_event_type_constant():
    """The 4-class NN treats INVERSION rows as a label-proxy stream; it
    relies on the constant string."""
    events = invert_losing_trades([_trade("x", "LONG", 1.0, 0.99)])
    assert all(e.event_type == "INVERSION" for e in events)
    assert all("event_type" in e.to_dict() for e in events)


def test_entry_time_preserved():
    """Context-layer joins on bar timestamp, so entry_time must round-trip."""
    trades = [_trade("p", "LONG", 1.10, 1.05, t0=1_750_000_000)]
    events = invert_losing_trades(trades)
    assert events[0].entry_time == 1_750_000_000
    assert events[0].exit_time == 1_750_000_000 + 60
