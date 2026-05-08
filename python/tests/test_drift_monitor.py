"""Stage 3: drift_monitor — every Section 7 row produces the expected action."""

from __future__ import annotations

from pathlib import Path
import sys

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.daemon_guards import DaemonGuards
from cicada_nn.drift_monitor import (
    CONFIDENCE_DROP_LOOKBACK,
    DriftAction,
    DriftContext,
    DriftMonitor,
    confidence_drop_rule,
    drift_monitor_enabled,
    drawdown_breach_rule,
    fakeout_rate_rule,
    prediction_error_rule,
    volatility_regime_rule,
)
from cicada_nn.order_records import OrderRecordStore


# ── Pure rule tests ─────────────────────────────────────────────────


def test_confidence_drop_triggers_when_all_below_threshold():
    ctx = DriftContext(recent_confidences=[0.40] * CONFIDENCE_DROP_LOOKBACK)
    r = confidence_drop_rule(ctx)
    assert r.triggered is True
    assert r.action == DriftAction.HALT_NEW_ORDERS


def test_confidence_drop_does_not_trigger_when_one_above():
    series = [0.40] * (CONFIDENCE_DROP_LOOKBACK - 1) + [0.65]
    r = confidence_drop_rule(DriftContext(recent_confidences=series))
    assert r.triggered is False


def test_confidence_drop_returns_none_with_too_few_samples():
    ctx = DriftContext(recent_confidences=[0.40] * 5)
    r = confidence_drop_rule(ctx)
    assert r.triggered is False
    assert "insufficient" in r.reason


def test_prediction_error_triggers_above_2x_baseline():
    ctx = DriftContext(recent_errors=[0.5] * 50, error_baseline=0.2)  # 0.5 > 0.4
    r = prediction_error_rule(ctx)
    assert r.triggered is True
    assert r.action == DriftAction.CLOSE_ALL


def test_prediction_error_safe_at_baseline():
    ctx = DriftContext(recent_errors=[0.2] * 50, error_baseline=0.2)
    r = prediction_error_rule(ctx)
    assert r.triggered is False


def test_volatility_regime_triggers_above_2_sigma():
    ctx = DriftContext(current_atr=0.025, training_atr_mean=0.010, training_atr_stdev=0.005)
    # z = (0.025 - 0.010) / 0.005 = 3 > 2
    r = volatility_regime_rule(ctx)
    assert r.triggered is True
    assert r.action == DriftAction.SUSPEND_PLACEMENT


def test_volatility_regime_no_trigger_within_2_sigma():
    ctx = DriftContext(current_atr=0.018, training_atr_mean=0.010, training_atr_stdev=0.005)
    # z = 1.6 ≤ 2
    r = volatility_regime_rule(ctx)
    assert r.triggered is False


def test_fakeout_rate_triggers_above_3x_historical():
    ctx = DriftContext(recent_fakeout_rate=0.40, historical_fakeout_rate=0.10)
    r = fakeout_rate_rule(ctx)
    assert r.triggered is True
    assert r.action == DriftAction.SOFT_RETRAIN


def test_fakeout_rate_returns_none_with_no_baseline():
    ctx = DriftContext(recent_fakeout_rate=0.40, historical_fakeout_rate=None)
    assert fakeout_rate_rule(ctx).triggered is False


def test_drawdown_breach_triggers_above_3x_expected():
    ctx = DriftContext(live_drawdown_pct=0.20, expected_drawdown_pct=0.05)
    r = drawdown_breach_rule(ctx)
    assert r.triggered is True
    assert r.action == DriftAction.EMERGENCY_STOP


def test_drawdown_breach_no_trigger_at_expected():
    ctx = DriftContext(live_drawdown_pct=0.05, expected_drawdown_pct=0.05)
    assert drawdown_breach_rule(ctx).triggered is False


# ── Orchestrator severity ordering ──────────────────────────────────


def test_orchestrator_picks_most_severe_when_multiple_trigger(tmp_path: Path):
    """Both confidence and drawdown trigger → drawdown (EMERGENCY_STOP) wins."""
    s = OrderRecordStore(tmp_path / "orders.sqlite")
    guards = DaemonGuards()
    closed: list[int] = []
    monitor = DriftMonitor(
        s,
        guards=guards,
        bridge_get_positions=lambda: [],
        bridge_close_position=lambda t: closed.append(t),
    )
    ctx = DriftContext(
        recent_confidences=[0.40] * CONFIDENCE_DROP_LOOKBACK,
        live_drawdown_pct=0.20,
        expected_drawdown_pct=0.05,
    )
    snap = monitor.evaluate(ctx)
    assert snap.chosen_action == DriftAction.EMERGENCY_STOP
    assert guards.emergency_stopped is True


def test_orchestrator_close_all_calls_bridge_close(tmp_path: Path):
    s = OrderRecordStore(tmp_path / "orders.sqlite")
    guards = DaemonGuards()
    closed: list[int] = []
    monitor = DriftMonitor(
        s,
        guards=guards,
        bridge_get_positions=lambda: [{"ticket": 1}, {"ticket": 2}],
        bridge_close_position=lambda t: closed.append(t),
    )
    ctx = DriftContext(recent_errors=[0.5] * 50, error_baseline=0.2)
    monitor.evaluate(ctx)
    assert closed == [1, 2]
    assert guards.new_orders_halted is True


def test_orchestrator_no_triggers_no_action(tmp_path: Path):
    s = OrderRecordStore(tmp_path / "orders.sqlite")
    guards = DaemonGuards()
    monitor = DriftMonitor(s, guards=guards, bridge_get_positions=lambda: [])
    ctx = DriftContext()  # all None / empty
    snap = monitor.evaluate(ctx)
    assert snap.chosen_action == DriftAction.NONE
    assert guards.new_orders_halted is False
    assert guards.emergency_stopped is False


def test_orchestrator_soft_retrain_calls_hook(tmp_path: Path):
    s = OrderRecordStore(tmp_path / "orders.sqlite")
    guards = DaemonGuards()
    fired: list[str] = []
    monitor = DriftMonitor(
        s, guards=guards,
        bridge_get_positions=lambda: [],
        soft_retrain_hook=lambda reason: fired.append(reason),
    )
    ctx = DriftContext(recent_fakeout_rate=0.40, historical_fakeout_rate=0.10)
    monitor.evaluate(ctx)
    assert len(fired) == 1
    assert "fakeout" in fired[0].lower()


# ── Env gate ────────────────────────────────────────────────────────


def test_drift_monitor_enabled_default_on(monkeypatch):
    monkeypatch.delenv("CICADA_DISABLE_DRIFT", raising=False)
    assert drift_monitor_enabled() is True


@pytest.mark.parametrize("val", ["1", "true", "yes", "on"])
def test_drift_monitor_disabled_when_env_set(monkeypatch, val: str):
    monkeypatch.setenv("CICADA_DISABLE_DRIFT", val)
    assert drift_monitor_enabled() is False
