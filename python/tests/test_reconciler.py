"""Stage 3: position reconciler — fixture-driven, no real bridge."""

from __future__ import annotations

from pathlib import Path
import sys

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.daemon_guards import DaemonGuards, reset_guards
from cicada_nn.order_records import OrderRecordStore, OrderStatus
from cicada_nn.reconciler import Reconciler, reconciler_enabled


# ── Helpers ─────────────────────────────────────────────────────────


def _store(tmp_path: Path) -> OrderRecordStore:
    return OrderRecordStore(tmp_path / "orders.sqlite")


def _make_filled(store: OrderRecordStore, *, ticket: int, bot_id: str = "bot-1",
                 sl: float = 1.19, tp: float = 1.22, size: float = 0.10) -> int:
    return store.append_order(
        bot_id=bot_id,
        instrument_id="inst-eurusd",
        instrument_symbol="EURUSD",
        style="day",
        side="LONG",
        size=size,
        entry_price=1.20,
        stop_loss=sl,
        take_profit=tp,
        confidence=0.7,
        status=OrderStatus.FILLED,
        ticket=ticket,
    )


def _bridge_returns(positions: list[dict]):
    return lambda: positions


def _fresh_guards() -> DaemonGuards:
    """Tests must not see state from each other or from the module-level GUARDS."""
    return DaemonGuards()


# ── Env gate ────────────────────────────────────────────────────────


def test_reconciler_enabled_default_on(monkeypatch):
    monkeypatch.delenv("CICADA_DISABLE_RECONCILER", raising=False)
    assert reconciler_enabled() is True


@pytest.mark.parametrize("val", ["1", "true", "yes", "on", "TRUE"])
def test_reconciler_disabled_when_env_set(monkeypatch, val: str):
    monkeypatch.setenv("CICADA_DISABLE_RECONCILER", val)
    assert reconciler_enabled() is False


# ── Discrepancy taxonomy ────────────────────────────────────────────


def test_no_discrepancies_when_aligned(tmp_path: Path):
    s = _store(tmp_path)
    _make_filled(s, ticket=42)
    guards = _fresh_guards()
    r = Reconciler(
        s,
        guards=guards,
        bridge_get_positions=_bridge_returns([
            {"ticket": 42, "symbol": "EURUSD", "direction": "LONG", "volume": 0.10,
             "open_price": 1.20, "sl": 1.19, "tp": 1.22, "profit": 0, "magic": 1002, "comment": ""},
        ]),
    )
    snap = r.run_once()
    assert snap.mt5_position_count == 1
    assert snap.tracked_position_count == 1
    assert snap.discrepancies == []
    assert guards.new_orders_halted is False


def test_ghost_position_halts_orders_and_records_audit_row(tmp_path: Path):
    """MT5 has a position our orders table doesn't know about → halt + audit."""
    s = _store(tmp_path)
    guards = _fresh_guards()
    r = Reconciler(
        s,
        guards=guards,
        bridge_get_positions=_bridge_returns([
            {"ticket": 9999, "symbol": "EURUSD", "direction": "LONG", "volume": 0.05,
             "open_price": 1.21, "sl": 0, "tp": 0, "profit": 0, "magic": 0, "comment": "external"},
        ]),
    )
    snap = r.run_once()
    assert len(snap.discrepancies) == 1
    d = snap.discrepancies[0]
    assert d.kind == "GHOST"
    assert d.ticket == 9999
    assert guards.new_orders_halted is True
    assert "ghost" in (guards.halt_reason or "").lower()
    # Audit row was appended.
    rows = s.list_orders()
    assert any(r2.bot_id == "__reconciler__" and r2.ticket == 9999 for r2 in rows)


def test_implicit_close_appends_closed_row_and_sl_tp_event(tmp_path: Path):
    """Order ticket vanished from MT5 → append closed + reconcile_close event."""
    s = _store(tmp_path)
    _make_filled(s, ticket=42)
    r = Reconciler(s, guards=_fresh_guards(), bridge_get_positions=_bridge_returns([]))
    snap = r.run_once()
    assert any(d.kind == "IMPLICIT_CLOSE" and d.ticket == 42 for d in snap.discrepancies)
    rows = s.list_orders()
    closed = [r2 for r2 in rows if r2.status == OrderStatus.CLOSED.value and r2.ticket == 42]
    assert len(closed) == 1
    assert (closed[0].reason or "") == "reconcile_implied"
    events = s.list_sl_tp_events(ticket=42)
    assert any("reconcile_close" in (e.note or "") for e in events)


def test_divergent_volume_logged_no_halt(tmp_path: Path):
    """Same ticket but different volume → DIVERGENT log entry, no halt."""
    s = _store(tmp_path)
    _make_filled(s, ticket=42, size=0.10)
    guards = _fresh_guards()
    r = Reconciler(
        s,
        guards=guards,
        bridge_get_positions=_bridge_returns([
            {"ticket": 42, "symbol": "EURUSD", "direction": "LONG", "volume": 0.05,
             "open_price": 1.20, "sl": 1.19, "tp": 1.22, "profit": 0, "magic": 1002, "comment": ""},
        ]),
    )
    snap = r.run_once()
    assert any(d.kind == "DIVERGENT" and "volume" in d.detail for d in snap.discrepancies)
    assert guards.new_orders_halted is False


def test_bridge_failure_records_error_no_crash(tmp_path: Path):
    s = _store(tmp_path)
    from cicada_nn.mt5_bridge import BridgeError

    def boom() -> list[dict]:
        raise BridgeError("test: bridge offline")

    r = Reconciler(s, guards=_fresh_guards(), bridge_get_positions=boom)
    snap = r.run_once()
    assert snap.last_error is not None
    assert "test: bridge offline" in snap.last_error


def test_halt_persists_across_passes(tmp_path: Path):
    """Once a ghost halt fires, subsequent clean passes don't auto-resume."""
    s = _store(tmp_path)
    guards = _fresh_guards()
    fetch_state: list[list[dict]] = [
        [{"ticket": 9999, "symbol": "EURUSD", "direction": "LONG", "volume": 0.05,
          "open_price": 1.21, "sl": 0, "tp": 0, "profit": 0, "magic": 0, "comment": ""}],
        [],   # second pass: ghost is gone
    ]

    def fetch() -> list[dict]:
        return fetch_state.pop(0) if fetch_state else []

    r = Reconciler(s, guards=guards, bridge_get_positions=fetch)
    r.run_once()
    assert guards.new_orders_halted is True
    r.run_once()
    # The reconciler does not auto-clear halts — operator must resume.
    assert guards.new_orders_halted is True
