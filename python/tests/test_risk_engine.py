"""Regression tests for the backend risk engine port.

Each test mirrors the parity scenario the TypeScript ``ensemble.test.ts`` and
``risk.ts`` paths cover, so we know the daemon's behaviour matches the legacy
front-end behaviour while we migrate computation off the browser.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.risk import (  # noqa: E402
    BotRiskParams,
    EnsembleDecision,
    PortfolioState,
    PositionLite,
    apply_kelly_cap,
    compute_currency_exposure,
    correlation_scale,
    decompose_currency_legs,
    ensemble_decision,
    evaluate_risk_library,
    kelly_fraction,
    position_size_from_risk,
    try_open_position,
    volatility_target_scale,
)


def _portfolio(equity: float = 10_000, drawdown: float = 0.0) -> PortfolioState:
    return PortfolioState(equity=equity, drawdown_pct=drawdown)


# ── Kelly + sizing ───────────────────────────────────────────────────────────


def test_kelly_fraction_matches_textbook_formula():
    # 60% win rate, 2:1 reward/risk -> f* = (0.6*2 - 0.4)/2 = 0.4
    assert kelly_fraction(0.6, 2.0) == pytest.approx(0.4, abs=1e-9)
    # Negative-edge bet -> 0
    assert kelly_fraction(0.4, 1.0) == 0.0
    # Degenerate -> 0
    assert kelly_fraction(0.0, 1.0) == 0.0
    assert kelly_fraction(1.0, 1.0) == 0.0


def test_position_size_from_risk_uses_risk_per_unit():
    size = position_size_from_risk(equity=10_000, risk_per_trade_pct=0.01, entry_price=100, stop_loss_price=98)
    # risk amount = 100, risk per unit = 2 -> size 50
    assert size == pytest.approx(50.0, abs=1e-9)


def test_apply_kelly_cap_never_exceeds_kellysize():
    capped = apply_kelly_cap(size=1000, equity=10_000, win_rate=0.55, avg_win_loss_ratio=1.5, kelly_fraction_cap=0.25)
    f_star = kelly_fraction(0.55, 1.5)
    expected_max = 10_000 * 0.25 * f_star
    assert capped == pytest.approx(min(1000, expected_max), abs=1e-6)


# ── Correlation + currency exposure ─────────────────────────────────────────


def test_decompose_currency_legs_handles_slash_and_no_slash():
    assert decompose_currency_legs("EUR/USD", "fiat") == ("EUR", "USD")
    assert decompose_currency_legs("EURUSD", "fiat") == ("EUR", "USD")
    assert decompose_currency_legs("BTC/USD", "crypto") is None
    assert decompose_currency_legs("", "fiat") is None


def test_compute_currency_exposure_nets_long_short_per_leg():
    positions = [
        PositionLite("inst-eurusd", "EUR/USD", "fiat", "LONG", 1.0, 1.10, 1.10, risk_amount=100),
        PositionLite("inst-gbpusd", "GBP/USD", "fiat", "LONG", 1.0, 1.30, 1.30, risk_amount=100),
    ]
    exp = compute_currency_exposure(positions)
    assert exp["USD"] == pytest.approx(-(1.10 + 1.30), abs=1e-9)


def test_correlation_scale_penalises_already_loaded_currency():
    positions = [
        PositionLite("inst-eurusd", "EUR/USD", "fiat", "LONG", 5_000.0, 1.10, 1.10, risk_amount=100),
    ]
    scale = correlation_scale(equity=10_000, positions=positions, target_symbol="GBP/USD", target_type="fiat", side="LONG")
    assert 0.3 <= scale <= 1.0
    # Adding another USD-short trade on top of a heavy USD-short bucket → less than 1.
    assert scale < 1.0


def test_correlation_scale_returns_one_for_non_fiat():
    positions = [
        PositionLite("inst-btc", "BTCUSD", "crypto", "LONG", 1.0, 60_000, 60_000, risk_amount=100),
    ]
    assert correlation_scale(10_000, positions, "BTC/USD", "crypto", "LONG") == 1.0


# ── Volatility scaling ──────────────────────────────────────────────────────


def test_volatility_target_scale_clamps_extremes():
    s_low = volatility_target_scale(10_000, 0.001, 100, 100)
    s_high = volatility_target_scale(10_000, 0.10, 100, 100)
    assert 0.25 <= s_high <= 2.5
    assert 0.25 <= s_low <= 2.5


def test_volatility_target_scale_returns_one_for_invalid_inputs():
    assert volatility_target_scale(10_000, None, 100, 50) == 1.0
    assert volatility_target_scale(0, 0.01, 100, 50) == 1.0
    assert volatility_target_scale(10_000, 0.01, 0, 50) == 1.0


# ── Risk library / try_open_position ────────────────────────────────────────


def test_try_open_position_blocks_when_drawdown_capped():
    p = _portfolio(equity=1_000, drawdown=0.20)
    result = try_open_position(
        portfolio=p,
        bot_params=BotRiskParams(max_drawdown_pct=0.15),
        instrument_id="inst-eurusd",
        instrument_symbol="EUR/USD",
        instrument_type="fiat",
        entry_price=1.10,
        stop_loss_price=1.08,
        side="LONG",
        existing_positions=[],
    )
    assert not result.allowed
    assert result.reason and "drawdown" in result.reason.lower()


def test_try_open_position_blocks_when_min_equity_floor_hit():
    p = _portfolio(equity=10)  # below the $50 floor in the library
    result = try_open_position(
        portfolio=p,
        bot_params=BotRiskParams(),
        instrument_id="inst-eurusd",
        instrument_symbol="EUR/USD",
        instrument_type="fiat",
        entry_price=1.10,
        stop_loss_price=1.09,
        side="LONG",
        existing_positions=[],
    )
    assert not result.allowed
    assert result.rule_id == "cap-min-equity"


def test_try_open_position_returns_size_and_levels_when_ok():
    p = _portfolio(equity=10_000)
    result = try_open_position(
        portfolio=p,
        bot_params=BotRiskParams(),
        instrument_id="inst-eurusd",
        instrument_symbol="EUR/USD",
        instrument_type="fiat",
        entry_price=1.10,
        stop_loss_price=1.08,
        side="LONG",
        existing_positions=[],
        scope="day",
    )
    assert result.allowed
    assert result.size > 0
    assert result.take_profit > result.stop_loss
    assert result.risk_amount > 0


def test_evaluate_risk_library_blocks_extreme_volatility():
    ctx_args = dict(
        portfolio=_portfolio(),
        bot_params=BotRiskParams(),
        instrument_id="inst-eurusd",
        instrument_symbol="EUR/USD",
        instrument_type="fiat",
        scope="day",
        new_position_risk_amount=100.0,
        new_position_size=1.0,
        entry_price=1.10,
        stop_loss_price=1.08,
        side="LONG",
        existing_positions=[],
        volatility_pct=0.20,
    )
    from cicada_nn.risk import RiskRuleContext
    res = evaluate_risk_library(RiskRuleContext(**ctx_args))
    assert not res.allowed
    assert res.rule_id == "vol-extreme"


# ── Ensemble (parity with FE) ───────────────────────────────────────────────


def test_ensemble_agree_high_confidence():
    d = ensemble_decision(nn_action=0, nn_confidence=0.8, strategy_signal=1, strategy_reliability=0.7)
    assert d.action == "LONG"
    assert d.reason == "agree_high_conf"
    assert d.confidence > 0.5


def test_ensemble_resolves_conflict_in_favour_of_weighted_voter():
    d = ensemble_decision(nn_action=1, nn_confidence=0.9, strategy_signal=1, strategy_reliability=0.3, nn_weight=0.7)
    assert d.action == "SHORT"
    assert d.reason == "conflict_resolved_nn"


def test_ensemble_suppresses_below_min_confidence():
    d = ensemble_decision(nn_action=0, nn_confidence=0.3, strategy_signal=0, strategy_reliability=0.3, min_confidence=0.6)
    assert d.action == "NEUTRAL"
    assert d.reason == "low_confidence"


def test_ensemble_damps_with_low_regime_confidence():
    high = ensemble_decision(0, 0.9, 1, 0.7, regime_confidence=1.0)
    low = ensemble_decision(0, 0.9, 1, 0.7, regime_confidence=0.3)
    assert high.confidence > low.confidence
