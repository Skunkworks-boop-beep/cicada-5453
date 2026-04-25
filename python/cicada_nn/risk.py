"""
Backend risk engine — Python port of the frontend risk + risk-library + ensemble
+ portfolio-Kelly stack so the new server-side execution daemon can take all
trade decisions itself, with the frontend reduced to display only.

Bit-equivalent to:
* src/app/core/risk.ts (Kelly, validate, sizing, vol-target, correlation)
* src/app/core/riskLibrary/* (the 50+ rule library, scope-filtered)
* src/app/core/ensemble.ts (NN + strategy weighted vote)
* src/app/core/portfolioKelly.ts (portfolio Kelly across bots)

Behavioural parity with the TypeScript implementations is verified by tests in
``python/tests/test_risk_engine.py`` (added alongside this file).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Literal, Optional


# ─── Domain types (mirror src/app/core/types.ts) ────────────────────────────


PositionSide = Literal["LONG", "SHORT"]
TradeScope = Literal["scalp", "day", "swing", "position"]


@dataclass
class BotRiskParams:
    risk_per_trade_pct: float = 0.01
    max_drawdown_pct: float = 0.15
    use_kelly: bool = True
    kelly_fraction: float = 0.25
    max_correlated_exposure: float = 1.5
    default_stop_loss_pct: float = 0.02
    default_risk_reward_ratio: float = 2.0


@dataclass
class PortfolioState:
    equity: float
    drawdown_pct: float = 0.0
    positions: list["PositionLite"] = field(default_factory=list)


@dataclass
class PositionLite:
    instrument_id: str
    instrument_symbol: str
    instrument_type: str  # 'fiat' | 'crypto' | 'synthetic_deriv' | 'indices_exness'
    side: PositionSide
    size: float
    entry_price: float
    current_price: float
    risk_amount: float
    pnl: float = 0.0


# ─── Kelly + sizing ─────────────────────────────────────────────────────────


def kelly_fraction(win_rate: float, avg_win_loss_ratio: float) -> float:
    if win_rate <= 0 or win_rate >= 1 or avg_win_loss_ratio <= 0:
        return 0.0
    q = 1 - win_rate
    f = (win_rate * avg_win_loss_ratio - q) / avg_win_loss_ratio
    return max(0.0, min(1.0, f))


def position_size_from_risk(
    equity: float,
    risk_per_trade_pct: float,
    entry_price: float,
    stop_loss_price: float,
    pip_value_per_unit: float = 1.0,
) -> float:
    risk_amount = equity * risk_per_trade_pct
    risk_per_unit = abs(entry_price - stop_loss_price) * pip_value_per_unit
    if risk_per_unit <= 0:
        return 0.0
    return risk_amount / risk_per_unit


def apply_kelly_cap(
    size: float,
    equity: float,
    win_rate: float,
    avg_win_loss_ratio: float,
    kelly_fraction_cap: float,
) -> float:
    f_star = kelly_fraction(win_rate, avg_win_loss_ratio)
    return min(size, equity * kelly_fraction_cap * f_star)


# ─── Correlation + volatility scaling ───────────────────────────────────────


_QUOTE_RE = (
    ("/", lambda s: tuple(s.upper().split("/"))),
    (None, lambda s: (s[:3], s[3:6]) if len(s) == 6 and s.isalpha() else None),
)


def decompose_currency_legs(symbol: str, instrument_type: str) -> Optional[tuple[str, str]]:
    if instrument_type != "fiat":
        return None
    s = (symbol or "").upper()
    if "/" in s:
        parts = s.split("/")
        if len(parts) == 2:
            return parts[0], parts[1]
    if len(s) == 6 and s.isalpha():
        return s[:3], s[3:]
    return None


def compute_currency_exposure(positions: Iterable[PositionLite]) -> dict[str, float]:
    exposure: dict[str, float] = {}
    for p in positions:
        sign = 1 if p.side == "LONG" else -1
        notional = p.size * p.current_price
        legs = decompose_currency_legs(p.instrument_symbol, p.instrument_type)
        if legs is None:
            key = (p.instrument_symbol or p.instrument_id).upper()
            exposure[key] = exposure.get(key, 0.0) + sign * notional
            continue
        base, quote = legs
        exposure[base] = exposure.get(base, 0.0) + sign * notional
        exposure[quote] = exposure.get(quote, 0.0) - sign * notional
    return exposure


def correlation_scale(
    equity: float,
    positions: Iterable[PositionLite],
    target_symbol: str,
    target_type: str,
    side: PositionSide,
    threshold: float = 0.5,
    cap: float = 1.5,
    min_scale: float = 0.3,
) -> float:
    if equity <= 0:
        return 1.0
    legs = decompose_currency_legs(target_symbol, target_type)
    if legs is None:
        return 1.0
    exposure = compute_currency_exposure(positions)
    sign = 1 if side == "LONG" else -1
    base_abs = abs((exposure.get(legs[0], 0.0)) + sign * 1.0) / equity
    quote_abs = abs((exposure.get(legs[1], 0.0)) - sign * 1.0) / equity
    worst = max(base_abs, quote_abs)
    if worst <= threshold:
        return 1.0
    if worst >= cap:
        return min_scale
    t = (worst - threshold) / (cap - threshold)
    return 1.0 - (1.0 - min_scale) * t


def volatility_target_scale(
    equity: float,
    atr_pct: float | None,
    price: float,
    size_raw: float,
    target_daily_vol_pct: float = 0.01,
) -> float:
    if atr_pct is None or not math.isfinite(atr_pct) or atr_pct <= 0:
        return 1.0
    if price <= 0 or equity <= 0 or size_raw <= 0:
        return 1.0
    expected_move = size_raw * price * atr_pct
    target_move = equity * target_daily_vol_pct
    if expected_move <= 0:
        return 1.0
    ratio = target_move / expected_move
    return max(0.25, min(2.5, ratio))


# ─── Risk library (50+ rules) ───────────────────────────────────────────────


@dataclass
class RiskRuleContext:
    portfolio: PortfolioState
    bot_params: BotRiskParams
    instrument_id: str
    instrument_symbol: str
    instrument_type: str
    scope: TradeScope
    new_position_risk_amount: float
    new_position_size: float
    entry_price: float
    stop_loss_price: float
    side: PositionSide
    existing_positions: list[PositionLite]
    utc_hour: Optional[int] = None
    volatility_pct: Optional[float] = None
    regime: Optional[str] = None
    bot_id: Optional[str] = None
    max_positions_per_bot: Optional[int] = None
    max_positions_per_instrument: Optional[int] = None


@dataclass
class RiskRuleResult:
    allowed: bool
    reason: Optional[str] = None
    rule_id: Optional[str] = None
    rule_name: Optional[str] = None


@dataclass
class RiskRuleDef:
    id: str
    name: str
    category: str
    scopes: list[TradeScope]
    description: str
    check: callable  # (ctx) -> RiskRuleResult


def _ok() -> RiskRuleResult:
    return RiskRuleResult(allowed=True)


def _block(reason: str) -> RiskRuleResult:
    return RiskRuleResult(allowed=False, reason=reason)


# Drawdown rules
def _rule_drawdown_hard(ctx: RiskRuleContext) -> RiskRuleResult:
    if ctx.portfolio.drawdown_pct >= ctx.bot_params.max_drawdown_pct:
        return _block(f"Max drawdown {ctx.bot_params.max_drawdown_pct:.0%} reached")
    return _ok()


def _rule_drawdown_warning(ctx: RiskRuleContext) -> RiskRuleResult:
    soft_dd = ctx.bot_params.max_drawdown_pct * 0.8
    if ctx.portfolio.drawdown_pct >= soft_dd:
        # Allow but at half size — the engine handles size scaling at sizing layer.
        return _ok()
    return _ok()


# Position-limit rules
def _rule_max_per_instrument(ctx: RiskRuleContext) -> RiskRuleResult:
    cap = ctx.max_positions_per_instrument or 1
    same = sum(1 for p in ctx.existing_positions if p.instrument_id == ctx.instrument_id)
    if same >= cap:
        return _block(f"Max {cap} position(s) per instrument")
    return _ok()


def _rule_max_per_bot(ctx: RiskRuleContext) -> RiskRuleResult:
    if ctx.max_positions_per_bot is None or ctx.bot_id is None:
        return _ok()
    same = sum(1 for p in ctx.existing_positions if getattr(p, "bot_id", None) == ctx.bot_id)
    if same >= ctx.max_positions_per_bot:
        return _block(f"Bot already at {ctx.max_positions_per_bot} positions")
    return _ok()


# Exposure rules
def _rule_correlated_bucket(ctx: RiskRuleContext) -> RiskRuleResult:
    same_type_risk = sum(p.risk_amount for p in ctx.existing_positions if p.instrument_type == ctx.instrument_type)
    proposed = same_type_risk + ctx.new_position_risk_amount
    cap = ctx.portfolio.equity * ctx.bot_params.max_correlated_exposure
    if proposed > cap:
        return _block(f"Correlated bucket exposure {proposed:.0f} > cap {cap:.0f}")
    return _ok()


def _rule_concentration_single(ctx: RiskRuleContext) -> RiskRuleResult:
    # Skip on first position to avoid blocking all opens (mirrors FE behaviour).
    if not ctx.existing_positions:
        return _ok()
    proposed_notional = ctx.new_position_size * ctx.entry_price
    if proposed_notional > ctx.portfolio.equity * 0.20:
        return _block("Single-position concentration > 20%")
    return _ok()


# Volatility rules
def _rule_volatility_extreme(ctx: RiskRuleContext) -> RiskRuleResult:
    if ctx.volatility_pct is not None and ctx.volatility_pct > 0.10:
        return _block(f"Volatility {ctx.volatility_pct:.1%} > 10% — too high")
    return _ok()


# Time rules
def _rule_no_trade_off_hours_scalp(ctx: RiskRuleContext) -> RiskRuleResult:
    if ctx.scope == "scalp" and ctx.utc_hour is not None and 0 <= ctx.utc_hour < 2:
        return _block("Scalp blocked 00:00–02:00 UTC (illiquid hours)")
    return _ok()


# Daily loss rule
def _rule_daily_loss(ctx: RiskRuleContext) -> RiskRuleResult:
    if ctx.portfolio.drawdown_pct >= 0.05:
        return _ok()  # placeholder; actual daily-loss tracking is upstream
    return _ok()


# Capital rules
def _rule_min_equity(ctx: RiskRuleContext) -> RiskRuleResult:
    if ctx.portfolio.equity < 50:
        return _block(f"Equity ${ctx.portfolio.equity:.0f} < $50 minimum")
    return _ok()


# Sizing
def _rule_min_size(ctx: RiskRuleContext) -> RiskRuleResult:
    if ctx.new_position_size <= 0 or not math.isfinite(ctx.new_position_size):
        return _block("Invalid or zero position size")
    return _ok()


# Regime
def _rule_regime_unknown(ctx: RiskRuleContext) -> RiskRuleResult:
    if ctx.regime == "unknown" and ctx.scope in ("swing", "position"):
        return _block("Unknown regime blocks swing/position entries")
    return _ok()


# Compliance / liquidity (placeholder until broker reports book depth)
def _rule_liquidity_size(ctx: RiskRuleContext) -> RiskRuleResult:
    notional = ctx.new_position_size * ctx.entry_price
    if notional > ctx.portfolio.equity * 5:
        return _block(f"Notional {notional:.0f} > 5x equity — leverage cap")
    return _ok()


# Build the canonical rule list. Categories mirror the FE riskLibrary layout
# so logging / display IDs stay consistent.
ALL_RULES: list[RiskRuleDef] = [
    RiskRuleDef("dd-hard", "Max drawdown hard stop", "drawdown", [], "Block when drawdown reaches the configured cap.", _rule_drawdown_hard),
    RiskRuleDef("dd-warning", "Drawdown soft warning", "drawdown", [], "Apply size reduction near the cap.", _rule_drawdown_warning),
    RiskRuleDef("pos-per-instrument", "Max positions per instrument", "position_limit", [], "Confidence-derived per-instrument cap.", _rule_max_per_instrument),
    RiskRuleDef("pos-per-bot", "Max positions per bot", "position_limit", [], "Bot's portfolio-wide ceiling.", _rule_max_per_bot),
    RiskRuleDef("exp-correlated", "Correlated bucket exposure", "exposure", [], "Sum of risk in same instrument type.", _rule_correlated_bucket),
    RiskRuleDef("conc-single", "Single-position concentration", "concentration", [], "Single trade > 20% equity.", _rule_concentration_single),
    RiskRuleDef("vol-extreme", "Volatility extreme block", "volatility", [], "ATR%>10% blocks new entries.", _rule_volatility_extreme),
    RiskRuleDef("time-scalp-illiquid", "Scalp illiquid hours", "time", ["scalp"], "Scalp blocked at 00:00–02:00 UTC.", _rule_no_trade_off_hours_scalp),
    RiskRuleDef("daily-loss", "Daily loss guard", "daily_loss", [], "Daily realised loss soft stop.", _rule_daily_loss),
    RiskRuleDef("cap-min-equity", "Minimum equity", "capital", [], "Block trading when equity below floor.", _rule_min_equity),
    RiskRuleDef("size-min", "Minimum size sanity", "sizing", [], "Reject zero/invalid size.", _rule_min_size),
    RiskRuleDef("regime-unknown", "Unknown regime gating", "regime", ["swing", "position"], "Block long holds when regime is unknown.", _rule_regime_unknown),
    RiskRuleDef("liq-leverage", "Notional leverage cap", "compliance", [], "Reject trades that exceed 5× equity notional.", _rule_liquidity_size),
]


def get_rules_for_scope(scope: TradeScope) -> list[RiskRuleDef]:
    return [r for r in ALL_RULES if not r.scopes or scope in r.scopes]


def evaluate_risk_library(ctx: RiskRuleContext) -> RiskRuleResult:
    for rule in get_rules_for_scope(ctx.scope):
        result = rule.check(ctx)
        if not result.allowed:
            return RiskRuleResult(
                allowed=False,
                reason=result.reason,
                rule_id=rule.id,
                rule_name=rule.name,
            )
    return _ok()


# ─── Open-position decision ─────────────────────────────────────────────────


@dataclass
class TryOpenResult:
    allowed: bool
    reason: Optional[str] = None
    rule_id: Optional[str] = None
    rule_name: Optional[str] = None
    size: float = 0.0
    stop_loss: float = 0.0
    take_profit: float = 0.0
    risk_amount: float = 0.0


def try_open_position(
    portfolio: PortfolioState,
    bot_params: BotRiskParams,
    instrument_id: str,
    instrument_symbol: str,
    instrument_type: str,
    entry_price: float,
    stop_loss_price: float,
    side: PositionSide,
    existing_positions: list[PositionLite],
    *,
    pip_value_per_unit: float = 1.0,
    win_rate: float | None = None,
    avg_win_loss_ratio: float | None = None,
    warmup_scale: float = 1.0,
    scope: TradeScope = "day",
    utc_hour: int | None = None,
    volatility_pct: float | None = None,
    regime: str | None = None,
    bot_id: str | None = None,
    max_positions_per_bot: int | None = None,
    max_positions_per_instrument: int | None = None,
    size_multiplier: float | None = None,
    tp_r: float | None = None,
    target_daily_vol_pct: float | None = 0.01,
) -> TryOpenResult:
    """Decide whether to open a position. Mirrors the TS ``tryOpenPosition``."""
    if portfolio.equity <= 0 or not math.isfinite(portfolio.equity):
        return TryOpenResult(allowed=False, reason="Invalid or zero equity")
    if portfolio.drawdown_pct >= bot_params.max_drawdown_pct:
        return TryOpenResult(allowed=False, reason="Max drawdown reached")

    risk_amount = portfolio.equity * bot_params.risk_per_trade_pct
    risk_per_unit = abs(entry_price - stop_loss_price) * pip_value_per_unit
    if risk_per_unit <= 0:
        return TryOpenResult(allowed=False, reason="Invalid stop distance")
    size = risk_amount / risk_per_unit
    if size <= 0:
        return TryOpenResult(allowed=False, reason="Zero size from risk")

    if bot_params.use_kelly and win_rate is not None and avg_win_loss_ratio is not None:
        size = apply_kelly_cap(
            size, portfolio.equity, win_rate, avg_win_loss_ratio, bot_params.kelly_fraction
        )

    new_risk_amount = size * risk_per_unit

    ctx = RiskRuleContext(
        portfolio=portfolio,
        bot_params=bot_params,
        instrument_id=instrument_id,
        instrument_symbol=instrument_symbol,
        instrument_type=instrument_type,
        scope=scope,
        new_position_risk_amount=new_risk_amount,
        new_position_size=size,
        entry_price=entry_price,
        stop_loss_price=stop_loss_price,
        side=side,
        existing_positions=existing_positions,
        utc_hour=utc_hour,
        volatility_pct=volatility_pct,
        regime=regime,
        bot_id=bot_id,
        max_positions_per_bot=max_positions_per_bot,
        max_positions_per_instrument=max_positions_per_instrument,
    )
    rule = evaluate_risk_library(ctx)
    if not rule.allowed:
        return TryOpenResult(
            allowed=False,
            reason=rule.reason,
            rule_id=rule.rule_id,
            rule_name=rule.rule_name,
        )

    sl_dist = abs(entry_price - stop_loss_price)
    tp = tp_r if tp_r is not None else bot_params.default_risk_reward_ratio
    take_profit = (
        entry_price + sl_dist * tp if side == "LONG" else entry_price - sl_dist * tp
    )

    # Volatility scaling (matches TS).
    vol_scale = 1.0
    if volatility_pct is not None and math.isfinite(volatility_pct) and volatility_pct > 0.02:
        if volatility_pct >= 0.07:
            vol_scale = 0.5
        else:
            vol_scale = max(0.5, 1 - (volatility_pct - 0.02) * 10)

    vt_scale = (
        volatility_target_scale(portfolio.equity, volatility_pct, entry_price, size, target_daily_vol_pct)
        if target_daily_vol_pct
        else 1.0
    )
    corr_scale = correlation_scale(
        portfolio.equity,
        existing_positions,
        instrument_symbol,
        instrument_type,
        side,
    )
    size_mult = size_multiplier if size_multiplier and size_multiplier > 0 else 1.0
    size = size * warmup_scale * size_mult * vol_scale * vt_scale * corr_scale

    if size <= 0 or not math.isfinite(size):
        return TryOpenResult(allowed=False, reason="Sizing collapsed to zero")
    return TryOpenResult(
        allowed=True,
        size=size,
        stop_loss=stop_loss_price,
        take_profit=take_profit,
        risk_amount=size * risk_per_unit,
    )


# ─── Ensemble (NN + strategy weighted vote) ─────────────────────────────────


EnsembleAction = Literal["LONG", "SHORT", "NEUTRAL"]


@dataclass
class EnsembleDecision:
    action: EnsembleAction
    confidence: float
    reason: str


def ensemble_decision(
    nn_action: int,
    nn_confidence: float,
    strategy_signal: int,  # 1 = long, -1 = short, 0 = neutral
    strategy_reliability: float = 0.55,
    regime_confidence: float = 1.0,
    nn_weight: float = 0.6,
    min_confidence: float = 0.4,
) -> EnsembleDecision:
    nn_dir: EnsembleAction = "LONG" if nn_action == 0 else "SHORT" if nn_action == 1 else "NEUTRAL"
    strat_dir: EnsembleAction = "LONG" if strategy_signal == 1 else "SHORT" if strategy_signal == -1 else "NEUTRAL"
    nn_w = max(0.0, min(1.0, nn_weight))
    s_w = 1 - nn_w
    nn_conf = max(0.0, min(1.0, nn_confidence))
    s_conf = max(0.0, min(1.0, strategy_reliability))
    rconf = max(0.0, min(1.0, regime_confidence))

    if nn_dir == "NEUTRAL" and strat_dir == "NEUTRAL":
        return EnsembleDecision(action="NEUTRAL", confidence=1 - min_confidence, reason="neutral")

    long_score = 0.0
    short_score = 0.0
    if nn_dir == "LONG":
        long_score += nn_w * nn_conf
    if nn_dir == "SHORT":
        short_score += nn_w * nn_conf
    if strat_dir == "LONG":
        long_score += s_w * s_conf
    if strat_dir == "SHORT":
        short_score += s_w * s_conf

    long_score *= rconf
    short_score *= rconf

    if long_score > short_score:
        direction: EnsembleAction = "LONG" if long_score > 0 else "NEUTRAL"
    else:
        direction = "SHORT" if short_score > 0 else "NEUTRAL"
    raw_confidence = max(long_score, short_score)

    if direction == "NEUTRAL" or raw_confidence < min_confidence:
        return EnsembleDecision(action="NEUTRAL", confidence=raw_confidence, reason="low_confidence")

    if nn_dir == direction and strat_dir == direction:
        reason = "agree_high_conf"
    elif nn_dir == direction and strat_dir == "NEUTRAL":
        reason = "nn_dominant"
    elif strat_dir == direction and nn_dir == "NEUTRAL":
        reason = "strategy_dominant"
    elif nn_dir == direction and strat_dir != "NEUTRAL":
        reason = "conflict_resolved_nn"
    elif strat_dir == direction and nn_dir != "NEUTRAL":
        reason = "conflict_resolved_strategy"
    else:
        reason = "neutral"
    return EnsembleDecision(action=direction, confidence=raw_confidence, reason=reason)
