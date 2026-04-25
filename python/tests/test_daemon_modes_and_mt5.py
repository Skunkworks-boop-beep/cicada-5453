"""Tests for daemon scope-mode selection + MT5 connection helpers."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.execution_daemon import BotRuntimeConfig, ExecutionDaemon
from cicada_nn import mt5_client


def _cfg(**overrides) -> BotRuntimeConfig:
    base = dict(
        bot_id="b1",
        instrument_id="inst-eurusd",
        instrument_symbol="EURUSD",
        instrument_type="fiat",
        scope="day",
    )
    base.update(overrides)
    return BotRuntimeConfig(**base)


# ── Manual mode ────────────────────────────────────────────────────────────


def test_manual_fixed_scope_in_allowed_returns_scope():
    cfg = _cfg(scope_mode="manual", fixed_scope="day", allowed_scopes=["scalp", "day"])
    assert ExecutionDaemon._select_scope(cfg, "ranging", 0.7, 10_000, 0.0, 0.01) == "day"


def test_manual_fixed_scope_not_in_allowed_pauses():
    cfg = _cfg(scope_mode="manual", fixed_scope="swing", allowed_scopes=["scalp", "day"])
    assert ExecutionDaemon._select_scope(cfg, "ranging", 0.7, 10_000, 0.0, 0.01) is None


# ── Auto mode filters ──────────────────────────────────────────────────────


def test_auto_drawdown_pause_returns_none():
    cfg = _cfg(scope_mode="auto", allowed_scopes=["scalp", "day", "swing"])
    assert ExecutionDaemon._select_scope(cfg, "ranging", 0.7, 10_000, 0.25, 0.01) is None


def test_auto_low_equity_locks_scalp():
    cfg = _cfg(scope_mode="auto", allowed_scopes=["scalp", "day", "swing"])
    assert ExecutionDaemon._select_scope(cfg, "trending_bull", 0.8, 30, 0.0, 0.01) == "scalp"


def test_auto_high_volatility_filters_scalp():
    cfg = _cfg(scope_mode="auto", allowed_scopes=["scalp", "day", "swing"])
    out = ExecutionDaemon._select_scope(cfg, "ranging", 0.7, 10_000, 0.05, 0.06)
    assert out != "scalp"


def test_auto_trending_high_confidence_prefers_swing():
    cfg = _cfg(scope_mode="auto", allowed_scopes=["scalp", "day", "swing"])
    assert ExecutionDaemon._select_scope(cfg, "trending_bull", 0.85, 10_000, 0.0, 0.01) == "swing"


def test_auto_returns_none_when_filters_empty_candidates():
    # Auto + low equity (scalp-only) but scalp not in allowed → None.
    cfg = _cfg(scope_mode="auto", allowed_scopes=["day", "swing"])
    assert ExecutionDaemon._select_scope(cfg, "ranging", 0.7, 30, 0.0, 0.01) is None


# ── MT5 connection helpers ─────────────────────────────────────────────────


def test_mt5_status_when_package_missing():
    """When the MetaTrader5 package isn't installed (true on this CI), status
    must report ``installed=False`` and never raise."""
    status = mt5_client.connection_status()
    assert "installed" in status
    if not mt5_client.MT5_AVAILABLE:
        assert status["installed"] is False
        assert status["connected"] is False
        assert "MetaTrader5 package not installed" in status["error"]


def test_mt5_reconnect_without_credentials_returns_error():
    if mt5_client.MT5_AVAILABLE:
        pytest.skip("Skipping when MT5 is actually present (would mutate live session)")
    ok, data = mt5_client.reconnect()
    assert not ok
    assert "error" in data
