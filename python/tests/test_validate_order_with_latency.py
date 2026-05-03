"""Stage 2A: validate_order checks 6 (baseline_valid) + 7 (trade_gate).

Spec lines 1418-1431.

Determinism: when multiple checks would fail, the EARLIER (mode-shape) one
fires. Latency gates run after the shape gates so the operator sees the
structural reason first."""

from __future__ import annotations

import pytest

from cicada_nn.trade_modes import (
    OrderSignal,
    RejectReason,
    get_rules,
    validate_order,
)


def _good_signal() -> OrderSignal:
    """A signal that passes every shape check for SWING (atr=1.0, entry=100,
    sl=99 → 1.0×ATR within [1.0, 4.0]; tp=102 → 2.0×ATR ≥ min_tp 2.0)."""
    return OrderSignal(side="LONG", entry_price=100.0, stop_loss=99.0, take_profit=102.0, confidence=0.8)


# ── Backward compatibility: latency args are optional ────────────────────


def test_no_latency_args_accepts_when_shape_is_valid():
    res = validate_order(get_rules("swing"), _good_signal(), atr=1.0, n_concurrent=0)
    assert res.ok
    assert res.reason == RejectReason.OK


# ── Check 6: baseline-valid ──────────────────────────────────────────────


def test_baseline_invalid_rejects():
    res = validate_order(
        get_rules("swing"),
        _good_signal(),
        atr=1.0,
        n_concurrent=0,
        latency_baseline_valid=False,
    )
    assert not res.ok
    assert res.reason == RejectReason.BASELINE_NOT_ESTABLISHED


def test_baseline_valid_passes_when_no_gate_set():
    res = validate_order(
        get_rules("swing"),
        _good_signal(),
        atr=1.0,
        n_concurrent=0,
        latency_baseline_valid=True,
    )
    assert res.ok


# ── Check 7: trade gate by reason ────────────────────────────────────────


@pytest.mark.parametrize(
    ("gate_reason", "expected"),
    [
        ("LATENCY_ELEVATED", RejectReason.LATENCY_ELEVATED),
        ("LATENCY_ANOMALY", RejectReason.LATENCY_ANOMALY),
        ("LATENCY_SEVERE", RejectReason.LATENCY_SEVERE),
        ("LATENCY_EXTREME", RejectReason.LATENCY_EXTREME),
        ("RTT_STALE", RejectReason.RTT_STALE),
        ("BASELINE_NOT_ESTABLISHED", RejectReason.BASELINE_NOT_ESTABLISHED),
    ],
)
def test_gate_disallowed_maps_to_typed_reason(gate_reason: str, expected: RejectReason):
    res = validate_order(
        get_rules("scalping"),
        _good_signal(),
        atr=1.0,
        n_concurrent=0,
        latency_baseline_valid=True,
        latency_gate_allowed=False,
        latency_gate_reason=gate_reason,
    )
    assert not res.ok
    assert res.reason == expected


def test_unknown_gate_reason_falls_back_to_unknown_typed():
    res = validate_order(
        get_rules("day"),
        _good_signal(),
        atr=1.0,
        n_concurrent=0,
        latency_baseline_valid=True,
        latency_gate_allowed=False,
        latency_gate_reason="ROBOT_LIGHTNING",
    )
    assert not res.ok
    assert res.reason == RejectReason.UNKNOWN_LATENCY_REASON


# ── Determinism: shape failures beat latency failures ────────────────────


def test_confidence_too_low_beats_latency_anomaly():
    """Both confidence and latency would fail; confidence (earlier) wins."""
    sig = OrderSignal(side="LONG", entry_price=100.0, stop_loss=99.0, take_profit=102.0, confidence=0.50)
    res = validate_order(
        get_rules("swing"),  # threshold 0.70
        sig,
        atr=1.0,
        n_concurrent=0,
        latency_baseline_valid=True,
        latency_gate_allowed=False,
        latency_gate_reason="LATENCY_ANOMALY",
    )
    assert not res.ok
    assert res.reason == RejectReason.CONFIDENCE_BELOW_THRESHOLD


def test_tp_too_tight_beats_baseline_not_established():
    sig = OrderSignal(side="LONG", entry_price=100.0, stop_loss=99.0, take_profit=100.5, confidence=0.8)
    res = validate_order(
        get_rules("swing"),  # min TP 2.0×ATR; tp_distance=0.5 with atr=1.0 → 0.5×
        sig,
        atr=1.0,
        n_concurrent=0,
        latency_baseline_valid=False,
    )
    assert not res.ok
    assert res.reason == RejectReason.TP_TOO_TIGHT


# ── Detail strings ───────────────────────────────────────────────────────


def test_detail_carries_recommendation_when_provided():
    res = validate_order(
        get_rules("scalping"),
        _good_signal(),
        atr=1.0,
        n_concurrent=0,
        latency_baseline_valid=True,
        latency_gate_allowed=False,
        latency_gate_reason="LATENCY_ANOMALY",
        latency_gate_detail="RTT 95ms > 1.5x p95 (50ms)",
    )
    assert "1.5x p95" in res.detail
