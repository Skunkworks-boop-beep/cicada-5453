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
    nn_feature_vector: list[float] = field(default_factory=list)
    nn_detection_timeframe: Optional[str] = None
    nn_detection_bar_window: Optional[int] = None
    target_daily_vol_pct: float = 0.01
    scope_mode: str = "manual"   # 'auto' | 'manual'
    fixed_scope: Optional[str] = None
    allowed_scopes: list[str] = field(default_factory=lambda: ["scalp", "day", "swing"])


@dataclass
class BotState:
    config: BotRuntimeConfig
    enabled: bool = True
    last_tick_ts: float = 0.0
    last_event: Optional[dict[str, Any]] = None
    positions: list[PositionLite] = field(default_factory=list)


# Pluggable predict / order callables so the daemon can be unit-tested without
# spinning up a real broker.
PredictFn = Callable[[BotRuntimeConfig, list[dict], str, float, float], dict]
StrategySignalFn = Callable[[BotRuntimeConfig, list[dict], str], int]
OrderFn = Callable[[BotRuntimeConfig, str, float, float, float, float], dict]


class ExecutionDaemon:
    """Lifecycle manager for per-bot execution loops."""

    def __init__(
        self,
        portfolio_provider: Callable[[], PortfolioState],
        bars_provider: Callable[[str, str, int], list[dict]],
        predict_fn: PredictFn,
        strategy_signal_fn: StrategySignalFn,
        order_fn: OrderFn,
    ):
        self._lock = threading.Lock()
        self._workers: dict[str, threading.Thread] = {}
        self._states: dict[str, BotState] = {}
        self._stop_flags: dict[str, threading.Event] = {}
        self._portfolio = portfolio_provider
        self._bars = bars_provider
        self._predict = predict_fn
        self._strategy_signal = strategy_signal_fn
        self._submit_order = order_fn

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
        portfolio = self._portfolio()
        bar_window = cfg.nn_detection_bar_window or 60
        bars = self._bars(cfg.instrument_id, cfg.nn_detection_timeframe or cfg.primary_timeframe, max(100, bar_window + 20))
        if not bars or len(bars) < 50:
            return
        regime_series = detect_regime_series(bars, lookback=50)
        regime = regime_series[-1] if regime_series else "unknown"
        confidence = 0.6 if regime != "unknown" else 0.4
        latest = bars[-1]
        price = float(latest.get("close") or 0.0)
        if price <= 0:
            return

        # ATR-as-fraction proxy for volatility scaling
        atr_pct = self._atr_pct(bars, lookback=14)

        # Trade-mode aware scope selection. Honour fixed_scope in manual mode;
        # do equity / drawdown / volatility filtering + regime scoring in auto.
        active_scope = self._select_scope(
            cfg, regime, confidence, portfolio.equity, portfolio.drawdown_pct, atr_pct
        )
        if active_scope is None:
            self._publish_event(state, kind="scope_paused", reason="manual scope not in allowed set or all candidates filtered")
            return

        # NN predict
        try:
            pred = self._predict(cfg, bars, regime, confidence, price)
        except Exception as e:
            EVENT_BUS.publish("log", bot_id=cfg.bot_id, level="warning", message=f"predict failed: {e}")
            return
        nn_action = int(pred.get("action", 2))
        nn_conf = float(pred.get("confidence", 0.5))
        sl_pct = float(pred.get("sl_pct", cfg.risk_params.default_stop_loss_pct))
        tp_r = float(pred.get("tp_r", cfg.risk_params.default_risk_reward_ratio))

        # Strategy signal (-1, 0, 1)
        strat = self._strategy_signal(cfg, bars, regime)

        decision = ensemble_decision(
            nn_action=nn_action,
            nn_confidence=nn_conf,
            strategy_signal=strat,
            strategy_reliability=0.6,
            regime_confidence=confidence,
        )
        if decision.action == "NEUTRAL":
            self._publish_event(state, kind="ensemble", action="NEUTRAL", reason=decision.reason)
            return

        side = decision.action
        stop_loss = price * (1 - sl_pct) if side == "LONG" else price * (1 + sl_pct)
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
            max_positions_per_instrument=2,
            tp_r=tp_r,
            target_daily_vol_pct=cfg.target_daily_vol_pct,
        )
        if not try_result.allowed:
            self._publish_event(state, kind="risk_block", reason=try_result.reason, rule=try_result.rule_id)
            return

        try:
            order = self._submit_order(
                cfg, side, try_result.size, price, try_result.stop_loss, try_result.take_profit
            )
        except Exception as e:
            self._publish_event(state, kind="order_error", reason=str(e))
            return
        self._publish_event(
            state,
            kind="order",
            side=side,
            size=try_result.size,
            entry=price,
            stop=try_result.stop_loss,
            target=try_result.take_profit,
            reason=decision.reason,
            order=order,
        )

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
