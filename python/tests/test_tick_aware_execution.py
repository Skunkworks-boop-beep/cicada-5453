"""Stage 9: tick-aware execution.

These tests cover the daemon's tick helpers + the intra-bar SL/TP gate.
The full _tick_once flow is not exercised here — that needs a portfolio
harness and lives in higher-level integration tests; the helpers tested
here are the load-bearing pieces.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.execution_daemon import (
    BotRuntimeConfig,
    BotState,
    ExecutionDaemon,
    PositionMeta,
)


def _make_daemon(*, tick_provider=None, close_position_fn=None) -> ExecutionDaemon:
    """Build an ExecutionDaemon with no-op providers everywhere except the
    tick + close pieces under test."""
    return ExecutionDaemon(
        portfolio_provider=lambda: None,    # type: ignore[arg-type]
        bars_provider=lambda *_a: [],
        predict_fn=lambda *_a: {"action": 2, "confidence": 0.0, "sl_pct": 0.01, "tp_r": 1.0},
        strategy_signal_fn=lambda *_a: 0,
        order_fn=lambda *_a, **_kw: {"ticket": 0},
        sl_event_fn=None,
        tick_provider=tick_provider,
        close_position_fn=close_position_fn,
    )


def _state_with_position(side: str, sl: float, tp: float) -> BotState:
    cfg = BotRuntimeConfig(
        bot_id="b1",
        instrument_id="inst-eurusd",
        instrument_symbol="EURUSD",
        instrument_type="fiat",
    )
    state = BotState(config=cfg)
    state.position_meta[101] = PositionMeta(
        side=side,
        entry_price=1.1000,
        initial_sl=sl,
        initial_tp=tp,
        current_sl=sl,
        bars_since_open=0,
        ticket=101,
    )
    return state


# ── Tick fetch helpers ────────────────────────────────────────────────────


def test_fetch_tick_returns_none_when_no_provider():
    d = _make_daemon(tick_provider=None)
    assert d._fetch_tick("EURUSD") is None


def test_fetch_tick_returns_none_when_symbol_blank():
    d = _make_daemon(tick_provider=lambda s: {"bid": 1.0, "ask": 1.0001})
    assert d._fetch_tick("") is None


def test_fetch_tick_returns_provider_payload():
    payload = {"bid": 1.0925, "ask": 1.0926, "spread": 0.0001, "time": 1700000000}
    d = _make_daemon(tick_provider=lambda s: payload)
    assert d._fetch_tick("EURUSD") == payload


def test_fetch_tick_swallows_provider_exception():
    def raiser(_s: str):
        raise RuntimeError("vm down")
    d = _make_daemon(tick_provider=raiser)
    assert d._fetch_tick("EURUSD") is None


def test_fetch_tick_rejects_zero_bid_or_ask():
    d = _make_daemon(tick_provider=lambda s: {"bid": 0.0, "ask": 1.0})
    assert d._fetch_tick("EURUSD") is None


# ── Fill price ────────────────────────────────────────────────────────────


def test_fill_price_long_uses_ask():
    assert ExecutionDaemon._fill_price("LONG", {"bid": 1.0, "ask": 1.0002}) == 1.0002


def test_fill_price_short_uses_bid():
    assert ExecutionDaemon._fill_price("SHORT", {"bid": 1.0, "ask": 1.0002}) == 1.0


def test_fill_price_returns_none_on_no_tick():
    assert ExecutionDaemon._fill_price("LONG", None) is None


# ── Slippage ───────────────────────────────────────────────────────────────


def test_slippage_long_positive_when_paid_more():
    """Long signal at 1.0000, fill at 1.0002 → +0.0002 (unfavourable)."""
    assert ExecutionDaemon._slippage_price("LONG", 1.0000, 1.0002) == pytest.approx(0.0002)


def test_slippage_short_positive_when_got_less():
    """Short signal at 1.0000, fill at 0.9998 → +0.0002 (unfavourable)."""
    assert ExecutionDaemon._slippage_price("SHORT", 1.0000, 0.9998) == pytest.approx(0.0002)


def test_slippage_negative_when_favourable():
    assert ExecutionDaemon._slippage_price("LONG", 1.0002, 1.0000) == pytest.approx(-0.0002)


def test_slippage_zero_when_no_tick_fallback():
    assert ExecutionDaemon._slippage_price("LONG", 1.0, 1.0) == 0.0


# ── Intra-bar SL/TP gate ──────────────────────────────────────────────────


def test_intrabar_long_sl_breach_fires_close():
    closed: list[int] = []
    d = _make_daemon(close_position_fn=closed.append)
    state = _state_with_position("LONG", sl=1.0950, tp=1.1100)
    # Bid drops below SL → close should fire at the bid.
    d._check_intrabar_exits(state, {"bid": 1.0945, "ask": 1.0946})
    assert closed == [101]
    assert 101 not in state.position_meta


def test_intrabar_long_tp_breach_fires_close():
    closed: list[int] = []
    d = _make_daemon(close_position_fn=closed.append)
    state = _state_with_position("LONG", sl=1.0950, tp=1.1100)
    d._check_intrabar_exits(state, {"bid": 1.1110, "ask": 1.1111})
    assert closed == [101]


def test_intrabar_short_sl_breach_fires_close():
    closed: list[int] = []
    d = _make_daemon(close_position_fn=closed.append)
    state = _state_with_position("SHORT", sl=1.1050, tp=1.0900)
    # Ask rises above SHORT SL → close.
    d._check_intrabar_exits(state, {"bid": 1.1054, "ask": 1.1055})
    assert closed == [101]


def test_intrabar_short_tp_breach_fires_close():
    closed: list[int] = []
    d = _make_daemon(close_position_fn=closed.append)
    state = _state_with_position("SHORT", sl=1.1050, tp=1.0900)
    d._check_intrabar_exits(state, {"bid": 1.0890, "ask": 1.0891})
    assert closed == [101]


def test_intrabar_no_breach_no_close():
    closed: list[int] = []
    d = _make_daemon(close_position_fn=closed.append)
    state = _state_with_position("LONG", sl=1.0950, tp=1.1100)
    d._check_intrabar_exits(state, {"bid": 1.1000, "ask": 1.1001})
    assert closed == []
    assert 101 in state.position_meta


def test_intrabar_close_without_callable_still_emits_event():
    """No close_position_fn injected (e.g. the daemon is in observe-only
    mode). The position_meta entry should still be removed and the
    intra-bar gate should not raise."""
    d = _make_daemon(close_position_fn=None)
    state = _state_with_position("LONG", sl=1.0950, tp=1.1100)
    d._check_intrabar_exits(state, {"bid": 1.0900, "ask": 1.0901})
    # Without a close callable we still drop the local position from the
    # daemon's view so we don't keep firing on the same breach.
    assert 101 not in state.position_meta


def test_intrabar_close_failure_is_swallowed():
    """If the close callable raises (e.g. bridge transient error), the
    daemon must not propagate — broker-side SL is still in force."""
    def bad_close(_t: int) -> None:
        raise RuntimeError("bridge dropped")
    d = _make_daemon(close_position_fn=bad_close)
    state = _state_with_position("LONG", sl=1.0950, tp=1.1100)
    # Should not raise.
    d._check_intrabar_exits(state, {"bid": 1.0900, "ask": 1.0901})
    assert 101 not in state.position_meta


def test_intrabar_zero_tick_skips_gate():
    """Bid/ask of 0 means no quote — gate should no-op rather than treat 0
    as 'price collapsed below SL'."""
    closed: list[int] = []
    d = _make_daemon(close_position_fn=closed.append)
    state = _state_with_position("LONG", sl=1.0950, tp=1.1100)
    d._check_intrabar_exits(state, {"bid": 0.0, "ask": 0.0})
    assert closed == []
    assert 101 in state.position_meta
