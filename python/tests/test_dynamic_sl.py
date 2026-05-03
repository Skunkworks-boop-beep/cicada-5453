"""Regression for bug 2: SWING bot SL trails to BE then trails forward,
and every move is a NEW row in sl_tp_events (never an update)."""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.order_records import OrderRecordStore, SLTPEventKind
from cicada_nn.sl_tp_manager import PositionLifecycleState, evaluate_sl
from cicada_nn.trade_modes import get_rules


def _step_price(life: PositionLifecycleState, price: float, atr: float, store: OrderRecordStore,
                ticket: int) -> PositionLifecycleState:
    r = get_rules("swing")
    decision = evaluate_sl(r, life, current_price=price, atr=atr)
    if decision.new_sl is not None and decision.new_sl != life.current_sl:
        kind = SLTPEventKind.MOVE_BE if "be" in decision.note else SLTPEventKind.TRAIL
        store.append_sl_tp_event(
            ticket=ticket,
            bot_id="bot-1",
            kind=kind,
            sl=decision.new_sl,
            price=price,
            note=decision.note,
        )
        life = PositionLifecycleState(
            side=life.side, entry_price=life.entry_price, initial_sl=life.initial_sl,
            initial_tp=life.initial_tp, current_sl=decision.new_sl,
            bars_since_open=life.bars_since_open + 1, partial_taken=life.partial_taken,
        )
    else:
        life = PositionLifecycleState(
            side=life.side, entry_price=life.entry_price, initial_sl=life.initial_sl,
            initial_tp=life.initial_tp, current_sl=life.current_sl,
            bars_since_open=life.bars_since_open + 1, partial_taken=life.partial_taken,
        )
    return life


def test_swing_be_then_trail_writes_new_rows(tmp_path):
    store = OrderRecordStore(tmp_path / "orders.sqlite")
    ticket = 4242
    # Initial SL/TP recorded as one row.
    store.append_sl_tp_event(
        ticket=ticket, bot_id="bot-1", kind=SLTPEventKind.INITIAL,
        sl=98.0, tp=104.0, price=100.0, note="open LONG swing",
    )
    life = PositionLifecycleState(
        side="LONG", entry_price=100.0, initial_sl=98.0, initial_tp=104.0,
        current_sl=98.0, bars_since_open=12, partial_taken=False,
    )

    # Trajectory: 100 → 102 (+1R, BE) → 104 (trail) → 105 (trail) → 103 (no move)
    for price in (102.0, 104.0, 105.0, 103.0):
        life = _step_price(life, price=price, atr=1.0, store=store, ticket=ticket)

    rows = store.list_sl_tp_events(ticket=ticket)
    kinds = [r.kind for r in rows]
    assert kinds[0] == SLTPEventKind.INITIAL.value
    assert SLTPEventKind.MOVE_BE.value in kinds
    assert SLTPEventKind.TRAIL.value in kinds
    # SL must move forward only — every recorded sl is >= entry once we crossed BE.
    sls = [r.sl for r in rows if r.sl is not None and r.kind != SLTPEventKind.INITIAL.value]
    for i in range(1, len(sls)):
        assert sls[i] >= sls[i - 1] - 1e-9, f"SL went backwards: {sls}"


def test_swing_below_1r_keeps_sl_static(tmp_path):
    store = OrderRecordStore(tmp_path / "orders.sqlite")
    ticket = 1
    store.append_sl_tp_event(
        ticket=ticket, bot_id="bot-1", kind=SLTPEventKind.INITIAL,
        sl=98.0, tp=104.0, price=100.0,
    )
    life = PositionLifecycleState(
        side="LONG", entry_price=100.0, initial_sl=98.0, initial_tp=104.0,
        current_sl=98.0, bars_since_open=12,
    )
    for price in (100.5, 101.0, 101.5):  # all below +1R (1R = 2.0)
        life = _step_price(life, price=price, atr=1.0, store=store, ticket=ticket)
    rows = store.list_sl_tp_events(ticket=ticket)
    # Only the initial row exists.
    assert len(rows) == 1
    assert rows[0].kind == SLTPEventKind.INITIAL.value
