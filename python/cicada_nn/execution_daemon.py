"""
Server-side bot execution daemon.

Replaces the front-end ``runBotExecution`` loop. Each deployed bot has its own
worker that:

1. Pulls OHLC bars (currently from the in-memory cache populated by the
   research/backtest streams; longer-term this will hit MT5 / Deriv directly).
2. Runs ``detect_regime_series`` for the latest window.
3. Calls ``/predict`` (the same model used by the FE).
4. Runs ``ensemble_decision`` to combine the NN with a strategy signal.
5. Runs ``try_open_position`` (full risk library, vol-target, correlation
   penalty).
6. Submits the order through the broker abstraction (currently logs an event
   while the live broker connectors are being ported).
7. Publishes a structured event so the FE SSE channel can update.

The daemon is intentionally lightweight (one thread per bot) so the same code
runs unchanged on a 4-core laptop or a 32-core workstation. Compute-heavy
operations (training, research) live on the JOB_MANAGER + ProcessPoolExecutor
elsewhere.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Iterable, Optional

from .event_bus import EVENT_BUS
from .regime_detection import RegimeConfig, detect_regime_series
from .risk import (
    BotRiskParams,
    PortfolioState,
    PositionLite,
    ensemble_decision,
    try_open_position,
)
from . import sl_tp_manager
from .sl_tp_manager import PositionLifecycleState
from .trade_modes import (
    OrderSignal,
    RejectReason,
    TRADE_MODES,
    TradeModeRules,
    validate_order,
)


logger = logging.getLogger(__name__)


# Tick interval per scope (seconds). Mirrors the FE constants.
SCOPE_TICK_S: dict[str, float] = {
    "scalp": 15.0,
    "day": 30.0,
    "swing": 60.0,
    "position": 120.0,
}


@dataclass
class BotRuntimeConfig:
    """Just enough to drive the daemon loop. Sourced from the persisted bot
    record + per-instrument metadata.

    Mode fields mirror the FE BotConfig so server-side scope selection matches
    what the user picked in the UI:
      - ``scope_mode``: 'auto' (dynamic) or 'manual' (use ``fixed_scope``).
      - ``fixed_scope``: single scope to use when scope_mode == 'manual'.
      - ``allowed_scopes``: candidate set when scope_mode == 'auto'. Default
        is ['scalp', 'day', 'swing'] (matches FE).
    """
    bot_id: str
    instrument_id: str
    instrument_symbol: str
    instrument_type: str
    primary_timeframe: str = "M5"
    scope: str = "day"
    risk_params: BotRiskParams = field(default_factory=BotRiskParams)
    max_positions: int = 2
    # Per-instrument cap. ``None`` means "no separate cap — bounded only by
    # max_positions"; previously hardcoded to 2 inside _tick_once with no
    # config knob. Spec §4 defines per-mode max_concurrent (a different
    # concept) but not a per-instrument cap; this knob is here so operators
    # can still pin one explicitly when running a multi-instrument bot.
    max_positions_per_instrument: Optional[int] = None
    # Strategy IDs this bot trades — primary strategy is strategy_ids[0]; the
    # rest are reserved for an ensemble vote once the daemon implements
    # multi-strategy aggregation. Empty list means "no strategy configured" —
    # the daemon will fall back to a neutral signal rather than guess.
    strategy_ids: list[str] = field(default_factory=list)
    # Timeframes this bot was BUILT on — the scope selector intersects
    # ``allowed_scopes`` with the modes whose TRADE_MODES[s].timeframes
    # overlap this list, so a bot trained on H1-W1 can't suddenly trade
    # SCALPING (M1-M5). Empty = no constraint (legacy bots).
    bot_timeframes: list[str] = field(default_factory=list)
    nn_feature_vector: list[float] = field(default_factory=list)
    nn_detection_timeframe: Optional[str] = None
    nn_detection_bar_window: Optional[int] = None
    target_daily_vol_pct: float = 0.01
    scope_mode: str = "manual"   # 'auto' | 'manual'
    fixed_scope: Optional[str] = None
    allowed_scopes: list[str] = field(default_factory=lambda: ["scalp", "day", "swing"])
    # Resolved trade style for per-mode rules (validation, SL/TP management).
    # When None, the daemon falls back to the default rule set (scope-aligned).
    trade_style: Optional[str] = None


@dataclass
class PositionMeta:
    """Per-position lifecycle state used by the SL/TP manager and the
    min-hold gate. Lives in BotState (not in PositionLite) so PositionLite
    stays a portfolio-snapshot row owned by the broker reconciliation layer.
    """
    side: str                 # "LONG" | "SHORT"
    entry_price: float
    initial_sl: float
    initial_tp: float
    current_sl: float
    bars_since_open: int = 0
    partial_taken: bool = False
    ticket: Optional[int] = None
    # Phase 3: running MFE/MAE since entry, in price units. Updated each tick
    # in _advance_open_positions; fed into the exit head's position_scalars
    # so the NN can reason about "we're up 2x ATR — should we lock in?"
    mfe_price: float = 0.0
    mae_price: float = 0.0


@dataclass
class BotState:
    config: BotRuntimeConfig
    enabled: bool = True
    last_tick_ts: float = 0.0
    last_event: Optional[dict[str, Any]] = None
    positions: list[PositionLite] = field(default_factory=list)
    # ticket → PositionMeta. Bug-1 (immediate close) and bug-2 (no dynamic SL)
    # both need per-position state that survives across ticks. The portfolio
    # snapshot is rebuilt every tick from the broker, so we can't hang this on
    # PositionLite — it has to live here.
    position_meta: dict[int, PositionMeta] = field(default_factory=dict)


# Pluggable predict / order callables so the daemon can be unit-tested without
# spinning up a real broker.
PredictFn = Callable[[BotRuntimeConfig, list[dict], str, float, float], dict]
StrategySignalFn = Callable[[BotRuntimeConfig, list[dict], str], int]
# OrderFn signature: (cfg, side, size, entry, stop, target, meta) -> dict.
# ``meta`` carries fields the order callable needs to write the right
# order_records row (style, magic, validation outcome, tick capture). The
# legacy 6-arg form is supported via TypeError fallback in _tick_once.
OrderFn = Callable[..., dict]
# Hook the daemon can call once per SL change so the runtime can record the
# move + push it to MT5. Signature: (bot_id, ticket, kind, sl, tp, price, note).
SLEventFn = Callable[..., None]
# Stage 9: live-tick provider. Returns ``{bid, ask, spread, time}`` or None
# if the bridge can't resolve the symbol. Daemon falls back to bar close on
# None so a momentary symbol gap doesn't halt the bot.
TickProviderFn = Callable[[str], Optional[dict]]
# Stage 9: intra-bar close. Called when the daemon detects the live tick has
# breached a registered SL/TP — belt-and-suspenders against broker-side SL
# slippage. Signature: (ticket) -> None. Raises propagate; the daemon catches
# and logs.
ClosePositionFn = Callable[[int], None]


class ExecutionDaemon:
    """Lifecycle manager for per-bot execution loops."""

    def __init__(
        self,
        portfolio_provider: Callable[[], PortfolioState],
        bars_provider: Callable[[str, str, int], list[dict]],
        predict_fn: PredictFn,
        strategy_signal_fn: StrategySignalFn,
        order_fn: OrderFn,
        sl_event_fn: Optional[SLEventFn] = None,
        tick_provider: Optional[TickProviderFn] = None,
        close_position_fn: Optional[ClosePositionFn] = None,
        # Phase 3: per-position HOLD/EXIT predictor. Called from
        # _advance_open_positions for every open position; "EXIT" closes via
        # close_position_fn. Returns "HOLD" by default (no checkpoint or
        # exit head missing) so the per-mode SL/TP policy remains the
        # safety floor.
        exit_predictor_fn: Optional[
            Callable[..., str]
        ] = None,
    ):
        self._lock = threading.Lock()
        self._sl_event_fn: Optional[SLEventFn] = sl_event_fn
        self._workers: dict[str, threading.Thread] = {}
        self._states: dict[str, BotState] = {}
        self._stop_flags: dict[str, threading.Event] = {}
        self._portfolio = portfolio_provider
        self._bars = bars_provider
        self._predict = predict_fn
        self._strategy_signal = strategy_signal_fn
        self._submit_order = order_fn
        self._tick_provider: Optional[TickProviderFn] = tick_provider
        self._close_position_fn: Optional[ClosePositionFn] = close_position_fn
        self._exit_predictor_fn: Optional[Callable[..., str]] = exit_predictor_fn

    # ── Lifecycle ────────────────────────────────────────────────────────

    def deploy(self, config: BotRuntimeConfig) -> None:
        with self._lock:
            if config.bot_id in self._workers:
                logger.info("daemon redeploy bot=%s — replacing existing worker", config.bot_id)
                self._stop_locked(config.bot_id)
            stop = threading.Event()
            state = BotState(config=config)
            self._stop_flags[config.bot_id] = stop
            self._states[config.bot_id] = state
            t = threading.Thread(
                target=self._run_loop,
                name=f"daemon-{config.bot_id}",
                args=(state, stop),
                daemon=True,
            )
            self._workers[config.bot_id] = t
            t.start()
        EVENT_BUS.publish(
            "bot",
            kind="deployed",
            bot_id=config.bot_id,
            instrument_id=config.instrument_id,
            scope=config.scope,
        )

    def stop(self, bot_id: str) -> bool:
        with self._lock:
            return self._stop_locked(bot_id)

    def _stop_locked(self, bot_id: str) -> bool:
        flag = self._stop_flags.pop(bot_id, None)
        if flag is None:
            return False
        flag.set()
        self._workers.pop(bot_id, None)
        self._states.pop(bot_id, None)
        EVENT_BUS.publish("bot", kind="stopped", bot_id=bot_id)
        return True

    def stop_all(self) -> None:
        with self._lock:
            for bot_id in list(self._stop_flags.keys()):
                self._stop_locked(bot_id)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            out: list[dict[str, Any]] = []
            for bot_id, state in self._states.items():
                out.append(
                    {
                        "bot_id": bot_id,
                        "enabled": state.enabled,
                        "last_tick_ts": state.last_tick_ts,
                        "instrument_id": state.config.instrument_id,
                        "scope": state.config.scope,
                        "last_event": state.last_event,
                    }
                )
            return out

    def set_enabled(self, bot_id: str, enabled: bool) -> bool:
        with self._lock:
            state = self._states.get(bot_id)
            if state is None:
                return False
            state.enabled = enabled
        EVENT_BUS.publish("bot", kind="enabled" if enabled else "disabled", bot_id=bot_id)
        return True

    # ── Loop body ────────────────────────────────────────────────────────

    def _run_loop(self, state: BotState, stop: threading.Event) -> None:
        cfg = state.config
        tick_s = SCOPE_TICK_S.get(cfg.scope, 30.0)
        logger.info("daemon start bot=%s tick_s=%.1f", cfg.bot_id, tick_s)
        while not stop.is_set():
            try:
                if state.enabled:
                    self._tick_once(state)
            except Exception:
                logger.exception("daemon tick error bot=%s", cfg.bot_id)
                EVENT_BUS.publish(
                    "log",
                    bot_id=cfg.bot_id,
                    level="error",
                    message="daemon tick raised",
                )
            # Sleep in small slices so a stop request is honoured fast.
            slept = 0.0
            while slept < tick_s and not stop.is_set():
                time.sleep(min(0.5, tick_s - slept))
                slept += 0.5
        logger.info("daemon stop bot=%s", cfg.bot_id)

    @staticmethod
    def _select_scope(cfg: BotRuntimeConfig, regime: str, regime_conf: float, equity: float, drawdown_pct: float, atr_pct: float) -> Optional[str]:
        """Server-side mirror of the TS ``selectScopeForTick``.

        Manual mode: respect ``fixed_scope`` if it's in ``allowed_scopes``,
        otherwise return None (paused — the user pinned a scope that's not
        permitted for this bot).
        Auto mode: filter ``allowed_scopes`` by equity floor, drawdown, and
        volatility, then score the remaining candidates against the regime.
        """
        if cfg.scope_mode == "manual" and cfg.fixed_scope:
            return cfg.fixed_scope if cfg.fixed_scope in cfg.allowed_scopes else None

        candidates = list(cfg.allowed_scopes) if cfg.allowed_scopes else ["scalp", "day", "swing"]
        # Timeframe binding (spec §4: each mode is defined for specific TFs).
        # A bot trained on H1-W1 should not be allowed to SCALP (M1-M5) just
        # because the regime selector scores scalp high — the model has no
        # signal at those timeframes. Intersect candidates with modes whose
        # TRADE_MODES[*].timeframes overlap the bot's training timeframes.
        if cfg.bot_timeframes:
            bot_tfs = {t.upper() for t in cfg.bot_timeframes}
            scope_to_style = {"scalp": "scalping", "day": "day",
                              "swing": "swing", "position": "swing"}
            compat: list[str] = []
            for s in candidates:
                rules = TRADE_MODES.get(scope_to_style.get(s, s))
                if rules and (set(rules.timeframes) & bot_tfs):
                    compat.append(s)
            candidates = compat
        # Soft drawdown gates (mirror DEFAULT_SCOPE_SELECTOR_CONFIG defaults).
        if drawdown_pct >= 0.20:
            return None
        if drawdown_pct >= 0.10:
            candidates = [s for s in candidates if s == "scalp"]
        if equity < 50:
            candidates = [s for s in candidates if s == "scalp"]
        elif equity < 500:
            candidates = [s for s in candidates if s in ("scalp", "day")]
        if atr_pct > 0.03:
            candidates = [s for s in candidates if s != "scalp"]
        if not candidates:
            return None

        # Regime-aware scoring: longer scopes prefer trending high-conf regimes.
        scores: dict[str, float] = {}
        for s in candidates:
            base = 0.5
            if s in ("swing", "position") and regime in ("trending_bull", "trending_bear") and regime_conf >= 0.7:
                base = 0.95
            elif s == "day" and regime in ("ranging", "trending_bull", "trending_bear"):
                base = 0.8
            elif s == "scalp" and regime in ("ranging", "reversal_bull", "reversal_bear"):
                base = 0.85
            scores[s] = base
        return max(scores, key=lambda k: scores[k])

    def _tick_once(self, state: BotState) -> None:
        cfg = state.config
        # Record every tick attempt — not just events — so /daemon/list and the
        # dashboard can show "yes, the daemon is alive" even when no signal
        # fired. Previously last_tick_ts only updated inside _publish_event, so
        # a bot that hit a silent return (insufficient bars, predict failure,
        # ensemble NEUTRAL with no caller of _publish_event upstream) looked
        # frozen at last_tick_ts=0 forever.
        state.last_tick_ts = time.time()
        portfolio = self._portfolio()
        bar_window = cfg.nn_detection_bar_window or 60
        bars = self._bars(cfg.instrument_id, cfg.nn_detection_timeframe or cfg.primary_timeframe, max(100, bar_window + 20))
        if not bars or len(bars) < 50:
            logger.info("daemon tick bot=%s skipped: insufficient bars (%d)", cfg.bot_id, len(bars) if bars else 0)
            return
        regime_series = detect_regime_series(bars, lookback=50)
        regime = regime_series[-1] if regime_series else "unknown"
        confidence = 0.6 if regime != "unknown" else 0.4
        latest = bars[-1]
        signal_price = float(latest.get("close") or 0.0)  # bar-close at signal time
        if signal_price <= 0:
            return

        # Stage 9: live tick. Used for the intra-bar SL/TP gate (run BEFORE we
        # advance open-position lifecycle, so a stop that breached this tick
        # closes here rather than waiting for the next bar) and for the
        # entry-price snapshot at submit time. None when the bridge can't
        # resolve the symbol — every downstream consumer falls back to bar
        # close in that case.
        tick = self._fetch_tick(cfg.instrument_symbol)
        if tick is not None:
            self._check_intrabar_exits(state, tick)

        # ATR-as-fraction proxy for volatility scaling
        atr_pct = self._atr_pct(bars, lookback=14)

        # Use the tick mid for SL/TP advancement so trailing stops and
        # breakeven triggers respond to the live market, not to whichever bar
        # last closed. Falls back to bar close when no tick is available.
        live_price = self._tick_mid(tick) or signal_price
        # ── Bug-2 fix: advance per-position SL/TP lifecycle BEFORE attempting
        # new entries. This is the only place SL trail / breakeven / partial
        # decisions are made; the daemon's submit_order call handles broker IO.
        rules = self._resolve_rules(cfg)
        atr_price = atr_pct * live_price
        self._advance_open_positions(state, rules, live_price, atr_price)
        # Variable kept for downstream try_open_position / validate_order
        # below — the values they care about are the bar-close-derived risk
        # numbers (signal_price), with the tick acting only on entry fill.
        price = signal_price

        # Trade-mode aware scope selection. Honour fixed_scope in manual mode;
        # do equity / drawdown / volatility filtering + regime scoring in auto.
        active_scope = self._select_scope(
            cfg, regime, confidence, portfolio.equity, portfolio.drawdown_pct, atr_pct
        )
        if active_scope is None:
            self._publish_event(state, kind="scope_paused", reason="manual scope not in allowed set or all candidates filtered")
            return

        # Rebind ``rules`` from the SELECTED scope so SL clamping and
        # validate_order use the mode the selector actually picked — not the
        # bot's static ``trade_style`` from config. The advance_open_positions
        # call above still uses the cfg-derived rules; per-position mode
        # tracking is a separate (bigger) fix.
        _scope_to_style = {"scalp": "scalping", "day": "day", "swing": "swing", "position": "swing"}
        rules = TRADE_MODES[_scope_to_style.get(active_scope, "day")]

        # NN predict
        try:
            pred = self._predict(cfg, bars, regime, confidence, price)
        except Exception as e:
            logger.warning("daemon tick bot=%s predict failed: %s", cfg.bot_id, e, exc_info=True)
            EVENT_BUS.publish("log", bot_id=cfg.bot_id, level="warning", message=f"predict failed: {e}")
            return
        nn_action = int(pred.get("action", 2))
        nn_conf = float(pred.get("confidence", 0.5))
        # New (preferred) — SL as ATR multiplier, matches spec §4.
        nn_sl_atr_mult = pred.get("sl_atr_mult")
        sl_pct = float(pred.get("sl_pct", cfg.risk_params.default_stop_loss_pct))
        tp_r = float(pred.get("tp_r", cfg.risk_params.default_risk_reward_ratio))

        # Strategy signal (-1, 0, 1)
        strat = self._strategy_signal(cfg, bars, regime)

        decision = ensemble_decision(
            nn_action=nn_action,
            nn_confidence=nn_conf,
            strategy_signal=strat,
            # 0.7 (was 0.6) — a fired strategy is meaningful enough to clear
            # day mode's 0.65 confidence_threshold on its own when the NN
            # abstains. With abstention-aware ensemble weighting (risk.py),
            # strategy-alone scores 1.0 × 0.7 = 0.7 → passes day, fails
            # sniper (0.80) which is correct architecturally — sniper
            # demands joint conviction. Trade-mode thresholds in spec §4
            # are the source of truth here.
            strategy_reliability=0.7,
            regime_confidence=confidence,
        )
        if decision.action == "NEUTRAL":
            # Surface what the components actually said so a chain of NEUTRAL
            # events is diagnosable from /daemon/list alone — previously the
            # event only carried 'low_confidence' and the operator had no way
            # to tell whether the NN, the strategy, the regime gate, or the
            # min_confidence floor was the cause.
            self._publish_event(
                state,
                kind="ensemble",
                action="NEUTRAL",
                reason=decision.reason,
                nn_action={0: "LONG", 1: "SHORT", 2: "NEUTRAL"}.get(nn_action, "UNK"),
                nn_confidence=round(nn_conf, 3),
                strategy_id=(cfg.strategy_ids[0] if cfg.strategy_ids else None),
                strategy_signal={1: "LONG", -1: "SHORT", 0: "NEUTRAL"}.get(int(strat), "UNK"),
                regime=regime,
                regime_confidence=round(confidence, 3),
                ensemble_confidence=round(float(decision.confidence), 3),
            )
            return

        side = decision.action
        # SL distance — prefer the NN's ATR-relative hint (clamped to the
        # active mode's [min_sl_atr, max_sl_atr] so the order always satisfies
        # spec §4) and fall back to the legacy %-of-price path when no
        # mult is provided. atr_price = atr_pct × live_price (computed above).
        if nn_sl_atr_mult is not None and atr_price > 0:
            mult = max(rules.min_sl_atr, min(rules.max_sl_atr, float(nn_sl_atr_mult)))
            sl_distance = mult * atr_price
        else:
            sl_distance = price * sl_pct
        stop_loss = price - sl_distance if side == "LONG" else price + sl_distance
        try_result = try_open_position(
            portfolio=portfolio,
            bot_params=cfg.risk_params,
            instrument_id=cfg.instrument_id,
            instrument_symbol=cfg.instrument_symbol,
            instrument_type=cfg.instrument_type,
            entry_price=price,
            stop_loss_price=stop_loss,
            side=side,  # type: ignore[arg-type]
            existing_positions=portfolio.positions,
            scope=cfg.scope,  # type: ignore[arg-type]
            volatility_pct=atr_pct,
            regime=regime,
            bot_id=cfg.bot_id,
            max_positions_per_bot=cfg.max_positions,
            max_positions_per_instrument=cfg.max_positions_per_instrument,
            tp_r=tp_r,
            target_daily_vol_pct=cfg.target_daily_vol_pct,
        )
        if not try_result.allowed:
            self._publish_event(
                state,
                kind="risk_block",
                reason=try_result.reason,
                rule=try_result.rule_id,
                style=rules.style,
                active_scope=active_scope,
            )
            return

        # ── Bug-3 fix: per-mode validation. The validator is pure and never
        # mutates parameters. On reject we publish + return; the daemon order
        # path (in daemon_runtime) is responsible for writing the REJECTED row
        # to order_records (it owns the storage handle).
        n_concurrent = sum(
            1 for p in portfolio.positions if p.instrument_id == cfg.instrument_id
        )
        bars_since_last_open = self._bars_since_last_open(state)
        signal = OrderSignal(
            side=side,                       # type: ignore[arg-type]
            entry_price=price,
            stop_loss=try_result.stop_loss,
            take_profit=try_result.take_profit,
            # Use the ENSEMBLE's combined confidence — not the NN's raw
            # confidence. validate_order's per-mode gate (signal.confidence
            # vs rules.confidence_threshold, spec §4) tests "how confident
            # is the decision system", and the ensemble IS the decision
            # system. Previously the daemon passed nn_conf, which means
            # a strategy-only SHORT decision (NN abstaining at 0.42) would
            # be gated against the NN's NEUTRAL probability — guaranteed
            # to fail the day-mode 0.65 floor even when the strategy
            # fired with 0.7 reliability.
            confidence=float(decision.confidence),
        )
        validation = validate_order(
            rules,
            signal,
            atr=atr_price,
            n_concurrent=n_concurrent,
            bars_since_last_open=bars_since_last_open,
        )
        if not validation.ok:
            self._publish_event(
                state,
                kind="validate_reject",
                reason=validation.reason.value,
                detail=validation.detail,
                style=rules.style,
            )
            # Hand the rejection to the order callable so the runtime can log
            # it to the append-only order store. The order callable knows how
            # to short-circuit on a rejected status.
            try:
                self._submit_order(
                    cfg,
                    side,
                    try_result.size,
                    price,
                    try_result.stop_loss,
                    try_result.take_profit,
                    {
                        "rejected": True,
                        "reason": validation.reason.value,
                        "detail": validation.detail,
                        "confidence": nn_conf,
                        "style": rules.style,
                    },
                )
            except TypeError:
                # Older order_fn signature without the meta param — ignore.
                pass
            except Exception as e:
                self._publish_event(state, kind="order_error", reason=str(e))
            return

        # Stage 9: tick-aware fill price. Use ask for LONG, bid for SHORT
        # so we record the actual price the broker would fill at, not the
        # bar close that triggered the signal. Falls back to bar close on
        # bridge unreachable / unknown symbol.
        entry_price = self._fill_price(side, tick) or price
        slippage = self._slippage_price(side, signal_price, entry_price)
        order_meta: dict[str, Any] = {
            "rejected": False,
            "confidence": nn_conf,
            "style": rules.style,
            "magic": rules.mt5_magic,
            "signal_price": signal_price,
            "tick_bid_at_signal": float(tick["bid"]) if tick else None,
            "tick_ask_at_signal": float(tick["ask"]) if tick else None,
            "realized_slippage_pips": slippage,
        }
        try:
            order = self._submit_order(
                cfg,
                side,
                try_result.size,
                entry_price,
                try_result.stop_loss,
                try_result.take_profit,
                order_meta,
            )
        except TypeError:
            # Backwards-compat for legacy order callables (no meta param).
            try:
                order = self._submit_order(
                    cfg, side, try_result.size, entry_price, try_result.stop_loss, try_result.take_profit
                )
            except Exception as e:
                self._publish_event(state, kind="order_error", reason=str(e))
                return
        except Exception as e:
            self._publish_event(state, kind="order_error", reason=str(e))
            return

        # Track the new position so SL/TP manager can drive it on subsequent
        # ticks. Use the broker ticket if returned; otherwise a synthetic id.
        ticket = int(order.get("ticket") or order.get("order") or 0) if isinstance(order, dict) else 0
        if ticket > 0:
            state.position_meta[ticket] = PositionMeta(
                side=side,
                entry_price=entry_price,
                initial_sl=try_result.stop_loss,
                initial_tp=try_result.take_profit,
                current_sl=try_result.stop_loss,
                bars_since_open=0,
                ticket=ticket,
            )
        self._publish_event(
            state,
            kind="order",
            side=side,
            size=try_result.size,
            entry=entry_price,
            signal_price=signal_price,
            slippage=slippage,
            stop=try_result.stop_loss,
            target=try_result.take_profit,
            reason=decision.reason,
            # Expose the ACTUAL executed style (rules.style — what the
            # validator gated against, may be "scalping" or "day" etc.)
            # AND the active scope (what the scope selector chose, may
            # differ from cfg.scope). Lets the dashboard show the real
            # mode used for this trade instead of the bot's static config.
            style=rules.style,
            active_scope=active_scope,
            order=order,
        )

    # ── Per-mode helpers (Stage 1: bug 1, 2, 3) ─────────────────────────

    @staticmethod
    def _resolve_rules(cfg: BotRuntimeConfig) -> TradeModeRules:
        """Resolve trade-mode rules. Prefer explicit ``trade_style``; fall back
        to the scope default so legacy bots keep working without forcing a
        migration of every persisted record on first deploy."""
        if cfg.trade_style and cfg.trade_style in TRADE_MODES:
            return TRADE_MODES[cfg.trade_style]
        scope_to_default: dict[str, str] = {
            "scalp": "scalping",
            "day": "day",
            "swing": "swing",
            "position": "swing",
        }
        return TRADE_MODES[scope_to_default.get(cfg.scope, "day")]

    def _bars_since_last_open(self, state: BotState) -> Optional[int]:
        """Lowest ``bars_since_open`` across this bot's open positions, or None
        when the bot has no open positions yet (the min-hold gate is then
        skipped — there's nothing to hold)."""
        if not state.position_meta:
            return None
        return min(m.bars_since_open for m in state.position_meta.values())

    def _advance_open_positions(
        self,
        state: BotState,
        rules: TradeModeRules,
        current_price: float,
        atr_price: float,
    ) -> None:
        """Bump bar counter and run the per-mode SL/TP policy for every open
        position. Each SL move is recorded via the optional ``sl_event_fn``
        hook (the runtime layer writes it to order_records and pushes it to
        MT5). Pure logic stays in ``sl_tp_manager``; this method is the I/O
        bridge."""
        if not state.position_meta:
            return
        for ticket, meta in list(state.position_meta.items()):
            meta.bars_since_open += 1
            # Update running MFE/MAE in price units. The exit head reads these
            # normalised by ATR.
            move = (current_price - meta.entry_price) * (1.0 if meta.side == "LONG" else -1.0)
            if move > 0:
                meta.mfe_price = max(meta.mfe_price, move)
            else:
                meta.mae_price = max(meta.mae_price, -move)

            # Phase 3: ask the NN's exit head whether to close this position
            # NOW. EXIT short-circuits the per-mode SL/TP policy (which still
            # runs as a safety floor when the predictor says HOLD or fails).
            if self._exit_predictor_fn is not None and self._close_position_fn is not None:
                try:
                    mfe_atr = meta.mfe_price / atr_price if atr_price > 0 else 0.0
                    mae_atr = meta.mae_price / atr_price if atr_price > 0 else 0.0
                    decision = self._exit_predictor_fn(
                        state.config,
                        bars=None,  # daemon_predict_exit re-fetches its own bars below
                        side=meta.side,
                        entry_price=meta.entry_price,
                        bars_since_open=meta.bars_since_open,
                        mfe_atr=mfe_atr,
                        mae_atr=mae_atr,
                    )
                    if str(decision).upper() == "EXIT":
                        try:
                            self._close_position_fn(int(ticket))
                        except Exception as e:  # noqa: BLE001
                            logger.warning(
                                "exit head close failed bot=%s ticket=%s: %s",
                                state.config.bot_id, ticket, e,
                            )
                        else:
                            self._publish_event(
                                state,
                                kind="trade_close",
                                ticket=ticket,
                                reason="exit_head_signal",
                                mfe_atr=round(mfe_atr, 3),
                                mae_atr=round(mae_atr, 3),
                                bars_since_open=meta.bars_since_open,
                            )
                            state.position_meta.pop(ticket, None)
                            continue  # don't run SL trail for a closed position
                except Exception as e:  # noqa: BLE001
                    logger.debug("exit_predictor_fn failed bot=%s ticket=%s: %s",
                                 state.config.bot_id, ticket, e)

            life = PositionLifecycleState(
                side=meta.side,
                entry_price=meta.entry_price,
                initial_sl=meta.initial_sl,
                initial_tp=meta.initial_tp,
                current_sl=meta.current_sl,
                bars_since_open=meta.bars_since_open,
                partial_taken=meta.partial_taken,
            )
            sl_decision = sl_tp_manager.evaluate_sl(rules, life, current_price, atr_price)
            if sl_decision.new_sl is not None and sl_decision.new_sl != meta.current_sl:
                kind = "move_be" if "move_be" in sl_decision.note else "trail"
                meta.current_sl = sl_decision.new_sl
                self._emit_sl_event(
                    state,
                    ticket=ticket,
                    kind=kind,
                    sl=sl_decision.new_sl,
                    price=current_price,
                    note=sl_decision.note,
                )
            tp_decision = sl_tp_manager.evaluate_tp(rules, life, current_price)
            if tp_decision.take_partial_fraction is not None and not meta.partial_taken:
                meta.partial_taken = True
                self._emit_sl_event(
                    state,
                    ticket=ticket,
                    kind="partial_tp",
                    price=current_price,
                    note=tp_decision.note,
                )

    def _emit_sl_event(
        self,
        state: BotState,
        *,
        ticket: int,
        kind: str,
        sl: Optional[float] = None,
        tp: Optional[float] = None,
        price: Optional[float] = None,
        note: str = "",
    ) -> None:
        cfg = state.config
        if self._sl_event_fn is not None:
            try:
                self._sl_event_fn(
                    bot_id=cfg.bot_id,
                    ticket=ticket,
                    kind=kind,
                    sl=sl,
                    tp=tp,
                    price=price,
                    note=note,
                )
            except Exception as e:
                logger.warning("sl_event_fn failed bot=%s ticket=%s kind=%s: %s",
                               cfg.bot_id, ticket, kind, e)
        self._publish_event(state, kind=f"sl_{kind}", ticket=ticket, sl=sl, tp=tp, note=note)

    # ── Stage 9: tick helpers ───────────────────────────────────────────

    def _fetch_tick(self, symbol: Optional[str]) -> Optional[dict]:
        """Pull a fresh bid/ask snapshot via the injected provider. Returns
        None on no provider, no symbol, or any provider error — the daemon
        falls back to bar close in that case."""
        if not symbol or self._tick_provider is None:
            return None
        try:
            t = self._tick_provider(symbol)
        except Exception as e:
            logger.debug("tick provider raised symbol=%s: %s", symbol, e)
            return None
        if not isinstance(t, dict):
            return None
        if not t.get("bid") or not t.get("ask"):
            return None
        return t

    @staticmethod
    def _tick_mid(tick: Optional[dict]) -> Optional[float]:
        if tick is None:
            return None
        bid = float(tick.get("bid") or 0.0)
        ask = float(tick.get("ask") or 0.0)
        if bid <= 0 or ask <= 0:
            return None
        return (bid + ask) / 2.0

    @staticmethod
    def _fill_price(side: str, tick: Optional[dict]) -> Optional[float]:
        """Tick-derived fill price: ask for LONG, bid for SHORT. None if no
        tick — caller falls back to bar close."""
        if tick is None:
            return None
        if side == "LONG":
            v = float(tick.get("ask") or 0.0)
        else:
            v = float(tick.get("bid") or 0.0)
        return v if v > 0 else None

    @staticmethod
    def _slippage_price(side: str, signal_price: float, entry_price: float) -> float:
        """Signed price delta between the bar-close signal and the live fill.
        Positive = unfavourable for the bot's side (LONG paid more, SHORT got
        less). Stored as ``realized_slippage_pips`` — for forex 5-digit pairs
        downstream can convert via × 10_000; for others it's a raw price
        delta and the UI labels it accordingly."""
        if signal_price <= 0 or entry_price <= 0:
            return 0.0
        delta = entry_price - signal_price
        return delta if side == "LONG" else -delta

    def _check_intrabar_exits(self, state: BotState, tick: dict) -> None:
        """Belt-and-suspenders intra-bar SL/TP gate. Compares the live tick to
        each open position's current_sl / initial_tp. On breach: emit a
        ``sl_hit`` / ``tp_hit`` event and — if a close callable was injected —
        fire the close so we don't depend solely on the broker's server-side
        SL execution. The broker's registered SL is still in force; this is
        an additional safety net for max-deviation rejects + transient
        broker hiccups."""
        if not state.position_meta:
            return
        bid = float(tick.get("bid") or 0.0)
        ask = float(tick.get("ask") or 0.0)
        if bid <= 0 or ask <= 0:
            return
        for ticket, meta in list(state.position_meta.items()):
            # LONG: exit at bid (broker pays bid to close); SL hit when bid <= SL,
            # TP hit when bid >= TP. SHORT: exit at ask; SL hit when ask >= SL,
            # TP hit when ask <= TP.
            sl_hit = False
            tp_hit = False
            exit_price = 0.0
            if meta.side == "LONG":
                if meta.current_sl > 0 and bid <= meta.current_sl:
                    sl_hit, exit_price = True, bid
                elif meta.initial_tp > 0 and bid >= meta.initial_tp:
                    tp_hit, exit_price = True, bid
            else:  # SHORT
                if meta.current_sl > 0 and ask >= meta.current_sl:
                    sl_hit, exit_price = True, ask
                elif meta.initial_tp > 0 and ask <= meta.initial_tp:
                    tp_hit, exit_price = True, ask
            if not (sl_hit or tp_hit):
                continue
            kind = "sl_hit" if sl_hit else "tp_hit"
            self._emit_sl_event(
                state,
                ticket=ticket,
                kind=kind,
                price=exit_price,
                note=f"intrabar tick {bid:.5f}/{ask:.5f}",
            )
            # Belt-and-suspenders close. Tolerated: on broker error the
            # registered SL still fires server-side; we just lose the
            # local visibility into the ms-level exit.
            if self._close_position_fn is not None:
                try:
                    self._close_position_fn(int(ticket))
                except Exception as e:
                    logger.warning(
                        "intrabar close failed ticket=%s kind=%s: %s",
                        ticket, kind, e,
                    )
            # Drop from local position_meta so subsequent ticks don't keep
            # firing. Reconciler will re-create or confirm closure.
            state.position_meta.pop(ticket, None)

    @staticmethod
    def _atr_pct(bars: list[dict], lookback: int = 14) -> float:
        if len(bars) < lookback + 1:
            return 0.0
        trs: list[float] = []
        prev_close = float(bars[-lookback - 1].get("close") or bars[-1].get("close") or 0.0)
        for i in range(-lookback, 0):
            b = bars[i]
            h = float(b.get("high") or b.get("close") or 0.0)
            lo = float(b.get("low") or b.get("close") or 0.0)
            tr = max(h - lo, abs(h - prev_close), abs(lo - prev_close))
            trs.append(tr)
            prev_close = float(b.get("close") or prev_close)
        atr = sum(trs) / max(1, len(trs))
        last = float(bars[-1].get("close") or 0.0)
        if last <= 0:
            return 0.0
        return atr / last

    def _publish_event(self, state: BotState, **payload: Any) -> None:
        cfg = state.config
        ev = {
            "bot_id": cfg.bot_id,
            "instrument_id": cfg.instrument_id,
            "instrument_symbol": cfg.instrument_symbol,
            "scope": cfg.scope,
            "ts": time.time(),
            **payload,
        }
        state.last_tick_ts = time.time()
        state.last_event = ev
        EVENT_BUS.publish("bot_tick", **ev)
