"""Stage 2A: HTTP client to the MT5 bridge.

Tests use a fake ``http`` callable injected into ``MT5Bridge`` so we cover the
client surface without needing a network stack or a real bridge."""

from __future__ import annotations

from typing import Any, Optional

import pytest

from cicada_nn.mt5_bridge import (
    BridgeError,
    BridgeRetcodeError,
    BridgeUnreachableError,
    MT5Bridge,
)


# ── Fake HTTP ────────────────────────────────────────────────────────────


class _FakeHttp:
    """Records calls and returns canned responses keyed by (method, path-suffix)."""

    def __init__(self, responses: dict[tuple[str, str], Any]):
        self.responses = responses
        self.calls: list[tuple[str, str, Optional[dict], float]] = []

    def __call__(self, method: str, url: str, body: Optional[dict], timeout: float) -> Any:
        self.calls.append((method, url, body, timeout))
        for (m, suffix), payload in self.responses.items():
            if m == method and url.endswith(suffix) or (m == method and suffix in url):
                if isinstance(payload, Exception):
                    raise payload
                return payload
        raise AssertionError(f"unexpected http call: {method} {url}")


def _bridge_with(responses: dict) -> tuple[MT5Bridge, _FakeHttp]:
    fake = _FakeHttp(responses)
    return MT5Bridge(base_url="http://test", http=fake), fake


# ── /health ──────────────────────────────────────────────────────────────


def test_health_check_returns_payload():
    b, fake = _bridge_with({("GET", "/health"): {"status": "ok", "mt5_connected": True, "account": "12345"}})
    out = b.health_check()
    assert out == {"status": "ok", "mt5_connected": True, "account": "12345"}
    assert fake.calls[0][0] == "GET"
    assert fake.calls[0][1].endswith("/health")


def test_health_check_unreachable_raises():
    b, _ = _bridge_with({("GET", "/health"): BridgeUnreachableError("connection refused")})
    with pytest.raises(BridgeUnreachableError):
        b.health_check()


# ── /order/place ─────────────────────────────────────────────────────────


def test_place_order_success_returns_full_payload():
    payload = {"success": True, "ticket": 999, "fill_price": 1.2345, "fill_time": "2026-05-03T10:00:00+00:00", "retcode": 10009}
    b, fake = _bridge_with({("POST", "/order/place"): payload})
    out = b.place_order(symbol="EURUSD", direction="LONG", volume=0.10, sl=1.2300, tp=1.2400, magic=1004)
    assert out["ticket"] == 999
    assert fake.calls[-1][2]["direction"] == "LONG"
    assert fake.calls[-1][2]["volume"] == 0.10
    assert fake.calls[-1][2]["magic"] == 1004


def test_place_order_failure_raises_retcode_error():
    payload = {"success": False, "retcode": 10006, "error": "no money"}
    b, _ = _bridge_with({("POST", "/order/place"): payload})
    with pytest.raises(BridgeRetcodeError) as exc:
        b.place_order(symbol="EURUSD", direction="LONG", volume=0.10)
    assert exc.value.retcode == 10006
    assert "no money" in exc.value.detail


def test_place_order_unreachable_raises():
    b, _ = _bridge_with({("POST", "/order/place"): BridgeUnreachableError("VM down")})
    with pytest.raises(BridgeUnreachableError):
        b.place_order(symbol="EURUSD", direction="LONG", volume=0.10)


# ── /order/modify_sl ─────────────────────────────────────────────────────


def test_modify_sl_passes_new_sl_and_tp():
    b, fake = _bridge_with({("POST", "/order/modify_sl"): {"success": True, "retcode": 10009}})
    b.modify_sl(ticket=42, new_sl=1.2310, new_tp=1.2400)
    body = fake.calls[-1][2]
    assert body == {"ticket": 42, "new_sl": 1.2310, "new_tp": 1.2400}


def test_modify_sl_omits_tp_when_none():
    b, fake = _bridge_with({("POST", "/order/modify_sl"): {"success": True, "retcode": 10009}})
    b.modify_sl(ticket=42, new_sl=1.2310)
    body = fake.calls[-1][2]
    assert "new_tp" not in body
    assert body["new_sl"] == 1.2310


def test_modify_sl_failure_raises_retcode_error():
    payload = {"success": False, "retcode": 10027, "error": "invalid stops"}
    b, _ = _bridge_with({("POST", "/order/modify_sl"): payload})
    with pytest.raises(BridgeRetcodeError) as exc:
        b.modify_sl(ticket=42, new_sl=1.0)
    assert exc.value.retcode == 10027


# ── /order/close ─────────────────────────────────────────────────────────


def test_close_position_success():
    b, fake = _bridge_with({("POST", "/order/close"): {"success": True, "close_price": 1.2350, "close_time": "x", "retcode": 10009}})
    out = b.close_position(ticket=42, volume=0.05)
    body = fake.calls[-1][2]
    assert body == {"ticket": 42, "volume": 0.05}
    assert out["close_price"] == 1.2350


def test_close_position_failure_raises():
    payload = {"success": False, "retcode": -1, "error": "position not found"}
    b, _ = _bridge_with({("POST", "/order/close"): payload})
    with pytest.raises(BridgeRetcodeError):
        b.close_position(ticket=99)


# ── /positions, /ticks, /history ─────────────────────────────────────────


def test_get_positions_returns_list():
    rows = [{"ticket": 1, "symbol": "EURUSD", "direction": "LONG", "volume": 0.1, "open_price": 1.2,
             "open_time": "x", "sl": 0, "tp": 0, "profit": 0, "magic": 0, "comment": ""}]
    b, _ = _bridge_with({("GET", "/positions"): rows})
    out = b.get_positions()
    assert out == rows


def test_get_ticks_passes_query_params():
    b, fake = _bridge_with({("GET", "/ticks"): []})
    b.get_ticks(symbol="EURUSD", from_ts=1000, to_ts=2000)
    url = fake.calls[-1][1]
    assert "symbol=EURUSD" in url
    assert "from_ts=1000" in url
    assert "to_ts=2000" in url


def test_get_history_passes_timeframe_and_range():
    b, fake = _bridge_with({("GET", "/history"): []})
    b.get_history(symbol="EURUSD", timeframe="H1", from_ts=1000, to_ts=2000)
    url = fake.calls[-1][1]
    assert "symbol=EURUSD" in url
    assert "timeframe=H1" in url
    assert "from_ts=1000" in url
    assert "to_ts=2000" in url


def test_unexpected_response_type_raises_bridge_error():
    b, _ = _bridge_with({("POST", "/order/place"): "not-a-dict"})
    with pytest.raises(BridgeError):
        b.place_order(symbol="EURUSD", direction="LONG", volume=0.10)


# ── Stage 2B fix C: MT5Bridge.get_account ────────────────────────────────


def test_get_account_round_trips_real_payload():
    """The Bridge surface must round-trip the full /account payload so
    mt5_client can surface real balance/equity to the dashboard."""
    payload = {
        "login": "12345",
        "server": "MetaQuotes-Demo",
        "currency": "USD",
        "balance": 10_000.0,
        "equity": 10_100.0,
        "leverage": 200,
        "margin": 0.0,
        "margin_free": 10_100.0,
        "profit": 100.0,
        "trade_allowed": True,
        "company": "MetaQuotes",
    }
    b, fake = _bridge_with({("GET", "/account"): payload})
    out = b.get_account()
    assert out == payload
    assert fake.calls[0][:2] == ("GET", "http://test/account")


def test_get_account_unreachable_raises():
    b, _ = _bridge_with({("GET", "/account"): BridgeUnreachableError("vm down")})
    with pytest.raises(BridgeUnreachableError):
        b.get_account()


# ── Stage 2B fix A: TTL cache on is_reachable ────────────────────────────


def test_is_reachable_caches_within_ttl():
    """Within the TTL window, two calls to ``is_reachable`` must result
    in exactly one underlying HTTP probe. Architectural review §3.1."""
    from cicada_nn import mt5_bridge as br

    fake = _FakeHttp({("GET", "/health"): {"status": "ok", "mt5_connected": True}})
    bridge = MT5Bridge(base_url="http://test", http=fake)
    br.set_bridge(bridge)
    try:
        assert br.is_reachable(timeout_s=1.0) is True
        assert br.is_reachable(timeout_s=1.0) is True
        assert len(fake.calls) == 1
    finally:
        br.set_bridge(None)
        br._reachable_cache_clear()


def test_is_reachable_re_probes_after_ttl(monkeypatch):
    from cicada_nn import mt5_bridge as br

    fake = _FakeHttp({("GET", "/health"): {"status": "ok", "mt5_connected": False}})
    bridge = MT5Bridge(base_url="http://test", http=fake)
    br.set_bridge(bridge)
    try:
        # Force a 0s TTL so we don't sleep in tests.
        monkeypatch.setattr(br, "_REACHABLE_TTL_S", 0.0)
        br._reachable_cache_clear()
        br.is_reachable()
        br.is_reachable()
        assert len(fake.calls) == 2
    finally:
        br.set_bridge(None)
        br._reachable_cache_clear()


def test_set_bridge_clears_reachable_cache():
    """Injecting a fresh bridge must invalidate any cached reachability so
    tests don't leak state across cases."""
    from cicada_nn import mt5_bridge as br

    fake_ok = _FakeHttp({("GET", "/health"): {"status": "ok", "mt5_connected": True}})
    bridge_ok = MT5Bridge(base_url="http://test", http=fake_ok)
    br.set_bridge(bridge_ok)
    try:
        assert br.is_reachable() is True
        # Swap to a bridge that fails — cache must invalidate so the second
        # probe returns False rather than the stale True.
        fake_bad = _FakeHttp({("GET", "/health"): BridgeUnreachableError("vm down")})
        br.set_bridge(MT5Bridge(base_url="http://test", http=fake_bad))
        assert br.is_reachable() is False
    finally:
        br.set_bridge(None)
        br._reachable_cache_clear()
