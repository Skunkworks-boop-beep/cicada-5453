"""
Canonical trade-mode rules for CICADA-5453.

Single source of truth for the five trade styles (scalping / day / medium_swing
/ swing / sniper). Mirrored in TypeScript at ``src/app/core/tradeModes.ts``;
parity verified by ``scripts/verify-trade-mode-parity.ts`` (run via
``npm run verify-all``).

Modes were previously sharing one validation path (the daemon's risk gate),
which let a parameter set picked for SCALPING coerce a SWING signal. This
module replaces that with strict per-mode rules and a pure ``validate_order``
function that returns a dataclass result — never silently mutates the order.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Literal


TradeStyle = Literal["scalping", "day", "medium_swing", "swing", "sniper"]


class SLManagement(str, Enum):
    STATIC = "static"
    TRAIL_AFTER_1R = "trail_after_1r"
    BE_THEN_TRAIL = "be_then_trail"          # breakeven at +1R, then trail
    TRAIL_FROM_ENTRY = "trail_from_entry"


class TPManagement(str, Enum):
    FIXED = "fixed"
    PARTIAL_1R_REST_TP = "partial_1r_rest_tp"
    PARTIAL_1R_REST_2R = "partial_1r_rest_2r"


@dataclass(frozen=True)
class TradeModeRules:
    style: TradeStyle
    timeframes: tuple[str, ...]
    min_hold_bars: int
    min_tp_atr: float
    min_sl_atr: float
    max_sl_atr: float
    sl_management: SLManagement
    tp_management: TPManagement
    entry_confirmation: str
    exit_trigger: str
    max_concurrent: int
    confidence_threshold: float
    mt5_magic: int


TRADE_MODES: dict[TradeStyle, TradeModeRules] = {
    "scalping": TradeModeRules(
        style="scalping",
        timeframes=("M1", "M5"),
        min_hold_bars=3,
        min_tp_atr=0.5,
        min_sl_atr=0.3,
        max_sl_atr=1.0,
        sl_management=SLManagement.STATIC,
        tp_management=TPManagement.FIXED,
        entry_confirmation="PA + map zone",
        exit_trigger="TP/SL/reversal after min hold",
        max_concurrent=3,
        confidence_threshold=0.60,
        mt5_magic=1001,
    ),
    "day": TradeModeRules(
        style="day",
        timeframes=("M15", "M30", "H1"),
        min_hold_bars=6,
        min_tp_atr=1.0,
        min_sl_atr=0.6,
        max_sl_atr=2.0,
        sl_management=SLManagement.TRAIL_AFTER_1R,
        tp_management=TPManagement.PARTIAL_1R_REST_TP,
        entry_confirmation="PA + map zone + 1 indicator",
        exit_trigger="TP/SL/regime break",
        max_concurrent=2,
        confidence_threshold=0.65,
        mt5_magic=1002,
    ),
    "medium_swing": TradeModeRules(
        style="medium_swing",
        timeframes=("H1", "H4"),
        min_hold_bars=8,
        min_tp_atr=1.5,
        min_sl_atr=0.8,
        max_sl_atr=3.0,
        sl_management=SLManagement.BE_THEN_TRAIL,
        tp_management=TPManagement.PARTIAL_1R_REST_2R,
        entry_confirmation="Map zone + momentum",
        exit_trigger="TP/SL/structure break",
        max_concurrent=2,
        confidence_threshold=0.70,
        mt5_magic=1003,
    ),
    "swing": TradeModeRules(
        style="swing",
        timeframes=("H4", "D1"),
        min_hold_bars=12,
        min_tp_atr=2.0,
        min_sl_atr=1.0,
        max_sl_atr=4.0,
        sl_management=SLManagement.BE_THEN_TRAIL,
        tp_management=TPManagement.PARTIAL_1R_REST_2R,
        entry_confirmation="Map zone + momentum + structure",
        exit_trigger="TP/SL/structure break",
        max_concurrent=2,
        confidence_threshold=0.70,
        mt5_magic=1004,
    ),
    "sniper": TradeModeRules(
        style="sniper",
        timeframes=("M15", "M30", "H1"),
        min_hold_bars=6,
        min_tp_atr=1.5,
        min_sl_atr=0.8,
        max_sl_atr=2.5,
        sl_management=SLManagement.TRAIL_FROM_ENTRY,
        tp_management=TPManagement.FIXED,
        entry_confirmation="2+ S/R confluence + map zone",
        exit_trigger="TP or SL only",
        max_concurrent=1,
        confidence_threshold=0.80,
        mt5_magic=1005,
    ),
}


ALL_STYLES: tuple[TradeStyle, ...] = ("scalping", "day", "medium_swing", "swing", "sniper")


def get_rules(style: str) -> TradeModeRules:
    if style not in TRADE_MODES:
        raise KeyError(f"Unknown trade style: {style!r}. Known: {list(TRADE_MODES)}")
    return TRADE_MODES[style]  # type: ignore[index]


# ─── Validation ─────────────────────────────────────────────────────────────


class RejectReason(str, Enum):
    OK = "ok"
    TP_TOO_TIGHT = "tp_too_tight"
    SL_TOO_TIGHT = "sl_too_tight"
    SL_TOO_WIDE = "sl_too_wide"
    CONFIDENCE_BELOW_THRESHOLD = "confidence_below_threshold"
    MAX_CONCURRENT_EXCEEDED = "max_concurrent_exceeded"
    MIN_HOLD_NOT_ELAPSED = "min_hold_not_elapsed"
    INVALID_SIGNAL = "invalid_signal"
    # Stage 2A: latency-aware gates per spec lines 1418-1431.
    BASELINE_NOT_ESTABLISHED = "baseline_not_established"
    RTT_STALE = "rtt_stale"
    LATENCY_ELEVATED = "latency_elevated"
    LATENCY_ANOMALY = "latency_anomaly"
    LATENCY_SEVERE = "latency_severe"
    LATENCY_EXTREME = "latency_extreme"
    UNKNOWN_LATENCY_REASON = "unknown_latency_reason"


# Map the string reasons returned by ``LatencyModel.get_trade_gate`` to typed
# ``RejectReason`` values. Kept here (rather than in latency_model) so the
# validation contract has a single source of truth.
_LATENCY_REASON_MAP: dict[str, RejectReason] = {
    "OK": RejectReason.OK,
    "BASELINE_NOT_ESTABLISHED": RejectReason.BASELINE_NOT_ESTABLISHED,
    "RTT_STALE": RejectReason.RTT_STALE,
    "LATENCY_ELEVATED": RejectReason.LATENCY_ELEVATED,
    "LATENCY_ANOMALY": RejectReason.LATENCY_ANOMALY,
    "LATENCY_SEVERE": RejectReason.LATENCY_SEVERE,
    "LATENCY_EXTREME": RejectReason.LATENCY_EXTREME,
}


def latency_reason_to_reject(reason: str) -> RejectReason:
    """Translate a ``TradeGate.reason`` string to a ``RejectReason``."""
    return _LATENCY_REASON_MAP.get(reason, RejectReason.UNKNOWN_LATENCY_REASON)


@dataclass(frozen=True)
class OrderSignal:
    """Pure data sent to ``validate_order`` — no mutation, no I/O."""

    side: Literal["LONG", "SHORT"]
    entry_price: float
    stop_loss: float
    take_profit: float
    confidence: float


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    reason: RejectReason
    detail: str = ""

    @classmethod
    def accept(cls) -> "ValidationResult":
        return cls(ok=True, reason=RejectReason.OK)

    @classmethod
    def reject(cls, reason: RejectReason, detail: str = "") -> "ValidationResult":
        return cls(ok=False, reason=reason, detail=detail)


def _abs_distance(a: float, b: float) -> float:
    return abs(a - b)


def validate_order(
    rules: TradeModeRules,
    signal: OrderSignal,
    atr: float,
    n_concurrent: int,
    bars_since_last_open: int | None = None,
    *,
    latency_baseline_valid: bool | None = None,
    latency_gate_allowed: bool | None = None,
    latency_gate_reason: str | None = None,
    latency_gate_detail: str | None = None,
) -> ValidationResult:
    """Validate an order against per-mode rules.

    Pure function — never mutates ``signal`` or ``rules``. Caller must log a
    ``REJECTED`` row when ``ok is False`` and never coerce the order to fit.

    :param rules: Mode rules from ``TRADE_MODES``.
    :param signal: The order intent.
    :param atr: Current ATR (in price units, same as entry/stop/TP).
    :param n_concurrent: How many positions this bot already has open in this
        mode. Caller enforces this against ``max_concurrent``.
    :param bars_since_last_open: Bars elapsed since the last entry on this
        bot. ``None`` skips the gate (e.g., fresh bot with no prior position).
    :param latency_baseline_valid: Result of
        ``latency_model.is_baseline_valid()`` — spec check #6. ``None``
        skips (used in unit tests not exercising live latency).
    :param latency_gate_allowed: Result of
        ``latency_model.get_trade_gate(mode).allowed`` — spec check #7.
        ``None`` skips. When ``False``, ``latency_gate_reason`` provides the
        typed rejection.
    :param latency_gate_reason: ``TradeGate.reason`` string from
        ``latency_model``. Used to map to a ``RejectReason`` when check #7
        fails.
    :param latency_gate_detail: Optional human-readable detail (e.g. the
        gate's ``recommendation`` field) carried into the rejection.
    """
    if signal.entry_price <= 0 or atr <= 0:
        return ValidationResult.reject(
            RejectReason.INVALID_SIGNAL,
            f"entry_price={signal.entry_price}, atr={atr}",
        )

    if signal.confidence < rules.confidence_threshold:
        return ValidationResult.reject(
            RejectReason.CONFIDENCE_BELOW_THRESHOLD,
            f"{signal.confidence:.3f} < {rules.confidence_threshold:.3f}",
        )

    if n_concurrent >= rules.max_concurrent:
        return ValidationResult.reject(
            RejectReason.MAX_CONCURRENT_EXCEEDED,
            f"{n_concurrent} >= {rules.max_concurrent}",
        )

    if bars_since_last_open is not None and bars_since_last_open < rules.min_hold_bars:
        return ValidationResult.reject(
            RejectReason.MIN_HOLD_NOT_ELAPSED,
            f"{bars_since_last_open} < {rules.min_hold_bars}",
        )

    sl_distance = _abs_distance(signal.entry_price, signal.stop_loss)
    tp_distance = _abs_distance(signal.entry_price, signal.take_profit)
    sl_atr_mult = sl_distance / atr
    tp_atr_mult = tp_distance / atr

    if tp_atr_mult < rules.min_tp_atr:
        return ValidationResult.reject(
            RejectReason.TP_TOO_TIGHT,
            f"{tp_atr_mult:.3f}xATR < {rules.min_tp_atr:.3f}",
        )
    if sl_atr_mult < rules.min_sl_atr:
        return ValidationResult.reject(
            RejectReason.SL_TOO_TIGHT,
            f"{sl_atr_mult:.3f}xATR < {rules.min_sl_atr:.3f}",
        )
    if sl_atr_mult > rules.max_sl_atr:
        return ValidationResult.reject(
            RejectReason.SL_TOO_WIDE,
            f"{sl_atr_mult:.3f}xATR > {rules.max_sl_atr:.3f}",
        )

    # ── Stage 2A: latency gates (spec lines 1418-1431). Run AFTER the
    # mode-shape checks so a tight TP doesn't get masked by a latency
    # spike — the operator wants the structural reason first.
    if latency_baseline_valid is False:
        return ValidationResult.reject(
            RejectReason.BASELINE_NOT_ESTABLISHED,
            latency_gate_detail or "latency baseline still warming up",
        )
    if latency_gate_allowed is False:
        reason = latency_reason_to_reject(latency_gate_reason or "")
        return ValidationResult.reject(
            reason,
            latency_gate_detail or (latency_gate_reason or "latency gate blocked"),
        )

    return ValidationResult.accept()
