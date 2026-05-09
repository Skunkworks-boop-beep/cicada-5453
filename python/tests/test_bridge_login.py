"""Stage 7: bridge POST /login + mt5_client.connect round-trip."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))


def _stub_mt5_with_login(*, login_succeeds: bool = True, account: int = 12345):
    """Build a stub MetaTrader5 module that supports login() at runtime."""
    state = {"current_login": account, "login_called_with": None}

    def login(account_id, password=None, server=None):
        state["login_called_with"] = (account_id, password, server)
        if not login_succeeds:
            return False
        state["current_login"] = int(account_id)
        return True

    def account_info():
        if state.get("current_login") is None:
            return None
        return types.SimpleNamespace(
            login=int(state["current_login"]),
            server="TestBroker-Demo",
            currency="USD",
            balance=10_000.0,
            equity=10_100.0,
            leverage=200,
            margin=0.0,
            margin_free=10_100.0,
            profit=100.0,
            trade_allowed=True,
            company="Test Broker",
        )

    return types.SimpleNamespace(
        ORDER_TYPE_BUY=0, ORDER_TYPE_SELL=1,
        TRADE_ACTION_DEAL=1, TRADE_ACTION_SLTP=6,
        TRADE_RETCODE_DONE=10009, COPY_TICKS_ALL=0,
        TIMEFRAME_M1=1, TIMEFRAME_M5=5, TIMEFRAME_M15=15, TIMEFRAME_M30=30,
        TIMEFRAME_H1=16385, TIMEFRAME_H4=16388, TIMEFRAME_D1=16408, TIMEFRAME_W1=32769,
        symbol_info_tick=lambda s: None,
        order_send=lambda r: None,
        positions_get=lambda ticket=None: [],
        copy_ticks_range=lambda *a: [],
        copy_rates_range=lambda *a: [],
        login=login,
        account_info=account_info,
        last_error=lambda: (10004, "Invalid credentials"),
        _state=state,
    ), state


@pytest.fixture
def bridge_app_with_login():
    """Spin up the bridge with a stub MT5 that supports login()."""
    for mod in list(sys.modules):
        if mod.startswith("bridge"):
            sys.modules.pop(mod, None)
    sys.modules.pop("MetaTrader5", None)

    stub, state = _stub_mt5_with_login()
    sys.modules["MetaTrader5"] = stub  # type: ignore[assignment]

    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")

    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    from bridge import server as srv  # type: ignore  # noqa: E402
    from fastapi.testclient import TestClient  # type: ignore
    return TestClient(srv.app), stub, state


def test_login_success_returns_account(bridge_app_with_login):
    client, _, state = bridge_app_with_login
    r = client.post("/login", json={"login": 99999, "password": "secret", "server": "Demo-Live"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    assert body["account"] == "99999"
    assert body["server"] == "TestBroker-Demo"
    assert body["company"] == "Test Broker"
    assert body["error"] is None
    # The stub recorded the credentials it was called with — proves they
    # actually reached mt5.login() rather than being silently dropped.
    assert state["login_called_with"] == (99999, "secret", "Demo-Live")


def test_login_failure_returns_retcode_and_error():
    """When mt5.login() returns False, the bridge surfaces last_error()."""
    for mod in list(sys.modules):
        if mod.startswith("bridge"):
            sys.modules.pop(mod, None)
    sys.modules.pop("MetaTrader5", None)
    stub, _ = _stub_mt5_with_login(login_succeeds=False)
    sys.modules["MetaTrader5"] = stub  # type: ignore[assignment]

    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))
    from bridge import server as srv  # type: ignore  # noqa: E402
    from fastapi.testclient import TestClient  # type: ignore
    client = TestClient(srv.app)
    r = client.post("/login", json={"login": 1, "password": "wrong", "server": ""})
    body = r.json()
    assert body["success"] is False
    assert body["retcode"] == 10004
    assert "Invalid credentials" in (body["error"] or "")


def test_mt5_client_connect_uses_login_endpoint():
    """The host-side mt5_client.connect() now POSTs /login instead of
    just probing /health. Wire the bridge HTTP layer to a fake transport
    so we can assert the request shape."""
    from cicada_nn import mt5_bridge
    from cicada_nn.mt5_bridge import MT5Bridge
    from cicada_nn import mt5_client

    calls: list[tuple[str, str, dict | None]] = []

    def fake_http(method, url, body, _timeout):
        calls.append((method, url, body))
        if url.endswith("/login"):
            return {"success": True, "account": "12345", "server": "Demo", "company": "Test"}
        if url.endswith("/account"):
            return {"login": "12345", "server": "Demo", "currency": "USD",
                    "balance": 10_000.0, "equity": 10_100.0, "leverage": 200,
                    "margin": 0.0, "margin_free": 10_100.0, "profit": 100.0,
                    "trade_allowed": True, "company": "Test"}
        # /health is no longer the primary auth probe.
        return {"status": "ok", "mt5_connected": True, "account": "12345"}

    bridge = MT5Bridge(base_url="http://test", http=fake_http)
    mt5_bridge.set_bridge(bridge)
    try:
        ok, info = mt5_client.connect("12345", "secret", "Demo")
        assert ok is True
        assert info["login"] == "12345"
        assert info["balance"] == 10_000.0
        # /login was hit with the typed credentials.
        login_calls = [c for c in calls if c[1].endswith("/login")]
        assert len(login_calls) == 1
        assert login_calls[0][2] == {"login": 12345, "password": "secret", "server": "Demo"}
    finally:
        mt5_bridge.set_bridge(None)


def test_mt5_client_connect_reports_login_failure():
    from cicada_nn import mt5_bridge
    from cicada_nn.mt5_bridge import MT5Bridge
    from cicada_nn import mt5_client

    def fake_http(method, url, body, _timeout):
        if url.endswith("/login"):
            return {"success": False, "retcode": 10004, "error": "Invalid credentials"}
        return {}

    bridge = MT5Bridge(base_url="http://test", http=fake_http)
    mt5_bridge.set_bridge(bridge)
    try:
        ok, info = mt5_client.connect("99999", "wrong", "Demo")
        assert ok is False
        assert "Invalid credentials" in (info.get("error") or "")
        assert info.get("retcode") == 10004
    finally:
        mt5_bridge.set_bridge(None)


def test_non_numeric_login_rejected_before_bridge_call():
    from cicada_nn import mt5_client

    ok, info = mt5_client.connect("not-a-number", "x", None)
    assert ok is False
    assert "numeric" in (info.get("error") or "").lower()
