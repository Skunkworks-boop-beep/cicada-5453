"""Bridge endpoint contract tests — runnable on Linux without MetaTrader5.

A stub MetaTrader5 module is injected into ``sys.modules`` BEFORE
``bridge.server`` is imported. The endpoints then exercise the same code
paths that run in the VM, against deterministic stub returns.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest


# ── Stub MetaTrader5 ─────────────────────────────────────────────────────


def _build_stub_mt5() -> types.SimpleNamespace:
    """Minimal stub: constants + the few callables the server uses.

    Constants chosen to mirror real MT5 values where the bridge's responses
    depend on numeric comparisons; everything else is opaque ints."""

    state: dict = {
        "positions": [],
        "ticks": [],
        "rates": [],
        "last_send_result": types.SimpleNamespace(retcode=10009, order=42, price=1.2345, time=1700000000, comment=""),
    }

    class _Tick:
        def __init__(self, bid: float, ask: float):
            self.bid = bid
            self.ask = ask

    def symbol_info_tick(symbol: str):
        return _Tick(bid=1.2340, ask=1.2350)

    def order_send(req: dict):
        return state["last_send_result"]

    def positions_get(ticket: int | None = None):
        rows = state["positions"]
        if ticket is not None:
            return [p for p in rows if int(getattr(p, "ticket", 0)) == int(ticket)]
        return rows

    def copy_ticks_range(symbol, dt_from, dt_to, flags):
        return state["ticks"]

    def copy_rates_range(symbol, tf, dt_from, dt_to):
        return state["rates"]

    def account_info():
        # Stage 2B fix C: return the full real-account snapshot the new
        # /account endpoint surfaces.
        return types.SimpleNamespace(
            login=12345,
            server="MetaQuotes-Demo",
            currency="USD",
            balance=10_000.0,
            equity=10_125.50,
            leverage=200,
            margin=125.0,
            margin_free=10_000.50,
            profit=125.50,
            trade_allowed=True,
            company="MetaQuotes Software Corp.",
        )

    def last_error():
        return (0, "ok")

    stub = types.SimpleNamespace(
        ORDER_TYPE_BUY=0,
        ORDER_TYPE_SELL=1,
        TRADE_ACTION_DEAL=1,
        TRADE_ACTION_SLTP=6,
        TRADE_RETCODE_DONE=10009,
        COPY_TICKS_ALL=0,
        TIMEFRAME_M1=1, TIMEFRAME_M5=5, TIMEFRAME_M15=15, TIMEFRAME_M30=30,
        TIMEFRAME_H1=16385, TIMEFRAME_H4=16388, TIMEFRAME_D1=16408, TIMEFRAME_W1=32769,
        symbol_info_tick=symbol_info_tick,
        order_send=order_send,
        positions_get=positions_get,
        copy_ticks_range=copy_ticks_range,
        copy_rates_range=copy_rates_range,
        account_info=account_info,
        last_error=last_error,
    )
    stub._state = state  # type: ignore[attr-defined]
    return stub


@pytest.fixture
def bridge_app(tmp_path: Path):
    """Set up a fresh bridge.server import with stub MT5 in sys.modules."""
    # Drop any prior caching
    for mod in list(sys.modules):
        if mod.startswith("bridge"):
            sys.modules.pop(mod, None)
    sys.modules.pop("MetaTrader5", None)

    stub = _build_stub_mt5()
    sys.modules["MetaTrader5"] = stub  # type: ignore[assignment]

    fastapi = pytest.importorskip("fastapi")
    httpx = pytest.importorskip("httpx")

    repo_root = Path(__file__).resolve().parents[1]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    from bridge import server as srv  # type: ignore  # noqa: E402

    from fastapi.testclient import TestClient  # type: ignore
    return TestClient(srv.app), stub, srv


# ── /health ──────────────────────────────────────────────────────────────


def test_health_reports_mt5_connected(bridge_app):
    client, stub, _ = bridge_app
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["mt5_connected"] is True
    assert body["account"] == "12345"


# ── /account (Stage 2B fix C) ────────────────────────────────────────────


def test_account_returns_full_snapshot(bridge_app):
    """The /account endpoint must surface the real balance / equity /
    currency / leverage values from mt5.account_info() — no placeholder
    zeros. Architectural review §3.4."""
    client, _, _ = bridge_app
    r = client.get("/account")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["login"] == "12345"
    assert body["server"] == "MetaQuotes-Demo"
    assert body["currency"] == "USD"
    assert body["balance"] == 10_000.0
    assert body["equity"] == 10_125.50
    assert body["leverage"] == 200
    assert body["margin"] == 125.0
    assert body["margin_free"] == 10_000.50
    assert body["profit"] == 125.50
    assert body["trade_allowed"] is True
    assert body["company"] == "MetaQuotes Software Corp."


def test_account_503_when_no_login(bridge_app):
    """When MT5 is installed but no account is logged in, /account must
    return 503 (not synthesise zeros). The mt5_client proxy then maps
    that into ``None`` which the dashboard renders as a clear empty state."""
    client, stub, _ = bridge_app
    # Patch the stub so account_info returns None — simulates no login.
    stub.account_info = lambda: None
    r = client.get("/account")
    assert r.status_code == 503


# ── /order/place ─────────────────────────────────────────────────────────


def test_order_place_success(bridge_app):
    client, _, _ = bridge_app
    r = client.post("/order/place", json={
        "symbol": "EURUSD",
        "direction": "LONG",
        "volume": 0.1,
        "sl": 1.2300,
        "tp": 1.2400,
        "magic": 1004,
        "comment": "test",
        "deviation": 20,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    assert body["ticket"] == 42
    assert body["fill_price"] == 1.2345
    assert body["retcode"] == 10009


def test_order_place_failure_returns_retcode(bridge_app):
    client, stub, _ = bridge_app
    import types as _t
    stub._state["last_send_result"] = _t.SimpleNamespace(retcode=10006, order=0, price=0, time=0, comment="no money")
    r = client.post("/order/place", json={"symbol": "EURUSD", "direction": "LONG", "volume": 0.1})
    body = r.json()
    assert body["success"] is False
    assert body["retcode"] == 10006
    assert "no money" in (body["error"] or "")


# ── /order/modify_sl ─────────────────────────────────────────────────────


def test_modify_sl_success(bridge_app):
    client, _, _ = bridge_app
    r = client.post("/order/modify_sl", json={"ticket": 42, "new_sl": 1.2310, "new_tp": 1.2400})
    body = r.json()
    assert body["success"] is True
    assert body["retcode"] == 10009


def test_modify_sl_omitting_tp(bridge_app):
    client, _, _ = bridge_app
    r = client.post("/order/modify_sl", json={"ticket": 42, "new_sl": 1.2310})
    body = r.json()
    assert body["success"] is True


# ── /positions ───────────────────────────────────────────────────────────


def test_positions_empty_when_no_positions(bridge_app):
    client, _, _ = bridge_app
    r = client.get("/positions")
    assert r.status_code == 200
    assert r.json() == []


def test_positions_returns_known_shape(bridge_app):
    client, stub, _ = bridge_app
    import types as _t
    stub._state["positions"] = [
        _t.SimpleNamespace(
            ticket=42, symbol="EURUSD", type=0, volume=0.1, price_open=1.20, time=1700000000,
            sl=1.19, tp=1.22, profit=5.0, magic=1004, comment="cicada-5453",
        )
    ]
    r = client.get("/positions")
    body = r.json()
    assert len(body) == 1
    p = body[0]
    assert p["ticket"] == 42
    assert p["symbol"] == "EURUSD"
    assert p["direction"] == "LONG"
    assert p["volume"] == 0.1
    assert p["sl"] == 1.19
    assert p["tp"] == 1.22


# ── /history ─────────────────────────────────────────────────────────────


def test_history_unknown_timeframe_400(bridge_app):
    client, _, _ = bridge_app
    r = client.get("/history?symbol=EURUSD&timeframe=X1&from_ts=1&to_ts=2")
    assert r.status_code == 400
