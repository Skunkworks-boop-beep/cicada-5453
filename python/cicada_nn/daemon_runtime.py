"""
Glue between the FastAPI process and the ExecutionDaemon.

Responsibilities:
* Hydrate persisted bots from STORAGE on API startup; deploy them.
* Provide the daemon with a portfolio snapshot, bar fetcher, predict callable,
  strategy-signal callable, and order callable that all live in this process.
* Persist position changes back to STORAGE so the daemon survives restarts.
* Stop all daemons cleanly on shutdown.

The daemon itself (`execution_daemon.py`) is broker-agnostic. This module is
where we wire it to MT5 / Deriv. To keep the change surface bounded we currently
log orders to the event bus instead of placing them on a live broker; switching
to real fills is a one-call swap once the broker abstraction here is reviewed.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from .compute import get_compute_config
from .event_bus import EVENT_BUS
from .execution_daemon import BotRuntimeConfig, ExecutionDaemon
from .daemon_guards import get_guards
from .order_records import OrderRecordStore, OrderStatus, SLTPEventKind
from .risk import BotRiskParams, PortfolioState, PositionLite
from .storage import StorageService
from .trade_modes import TRADE_MODES
from . import mt5_client


logger = logging.getLogger(__name__)


def _warn_with_event(category: str, message: str, **fields: object) -> None:
    """Stage 8 (review §4.3): log a warning AND surface it on the event bus.

    The 48 broad ``except Exception`` blocks across the daemon path
    previously logged to stderr only — operators never saw failures in
    BotExecutionLog. This helper emits both: ``logger.warning`` for ops
    grep/grafana + ``EVENT_BUS.publish('log', level='warning', ...)`` so
    the dashboard surfaces the failure immediately. Use at every safety-
    critical except site in the order placement / SL-event paths."""
    logger.warning(message, *fields.values())
    try:
        EVENT_BUS.publish(
            "log",
            level="warning",
            category=category,
            message=message % tuple(fields.values()) if fields else message,
            **fields,
        )
    except Exception:
        # If the event bus itself is broken we don't want to mask the
        # original failure; the logger.warning already happened.
        pass


# ── In-process portfolio + bars cache ────────────────────────────────────────


_portfolio_lock = threading.Lock()
_portfolio: PortfolioState = PortfolioState(equity=10_000.0)


def get_portfolio_snapshot() -> PortfolioState:
    """Return the current portfolio. Daemon worker calls this every tick."""
    with _portfolio_lock:
        # Return a copy so the daemon can't mutate the cache.
        return PortfolioState(
            equity=_portfolio.equity,
            drawdown_pct=_portfolio.drawdown_pct,
            positions=list(_portfolio.positions),
        )


def set_portfolio_snapshot(equity: float, drawdown_pct: float = 0.0, positions: Optional[Iterable[PositionLite]] = None) -> None:
    """Update the portfolio snapshot. Called when:
    - Frontend posts /positions (legacy path).
    - Broker sync produces a new equity.
    - Daemon submits an order (we adjust the cache locally so the next tick
      sees the new position immediately, before broker confirmation).
    """
    with _portfolio_lock:
        _portfolio.equity = float(equity)
        _portfolio.drawdown_pct = max(0.0, float(drawdown_pct))
        if positions is not None:
            _portfolio.positions = list(positions)


def hydrate_portfolio_from_storage(storage: StorageService) -> None:
    """Populate the portfolio cache from the persisted STORAGE.positions file.
    Tolerant of missing fields — falls back to neutral defaults."""
    data = storage.positions.read() or {}
    equity = float(data.get("balance") or data.get("totalEquity") or 10_000)
    drawdown = float(data.get("drawdownPct") or 0.0)
    raw_positions = data.get("positions") or []
    positions: list[PositionLite] = []
    for r in raw_positions:
        try:
            positions.append(
                PositionLite(
                    instrument_id=str(r.get("instrumentId") or ""),
                    instrument_symbol=str(r.get("instrument") or r.get("symbol") or ""),
                    instrument_type=str(r.get("instrumentType") or "fiat"),
                    side="LONG" if (r.get("type") or "LONG").upper() == "LONG" else "SHORT",
                    size=float(r.get("size") or 0),
                    entry_price=float(r.get("entryPrice") or 0),
                    current_price=float(r.get("currentPrice") or r.get("entryPrice") or 0),
                    risk_amount=float(r.get("riskAmount") or 0),
                    pnl=float(r.get("pnl") or 0),
                )
            )
        except (TypeError, ValueError) as e:
            logger.debug("daemon hydrate: skipping malformed position %r: %s", r, e)
    set_portfolio_snapshot(equity, drawdown, positions)


# ── Bars provider: pulls from MT5 when connected, otherwise empty ───────────


def fetch_bars_for_daemon(instrument_id: str, timeframe: str, count: int) -> list[dict]:
    """Bar source for the daemon.

    Strategy:
      1. Resolve the symbol via ``_INSTRUMENT_SYMBOL_MAP`` (populated by the FE
         when it pushes the daemon config). Falls back to the legacy heuristic.
      2. If MT5 is connected, fetch from MT5 (full ``count``).
      3. If MT5 is *not* connected but credentials are cached, attempt a single
         silent reconnect — handles broker drops without dropping the loop.
      4. Otherwise return [] and let the daemon skip the tick.
    """
    sym = get_instrument_symbol_map().get(instrument_id) or _legacy_symbol_from_id(instrument_id)
    # Preserve case + internal spaces — MT5 synthetic-index names like
    # 'Volatility 10 Index' are case-sensitive, and uppercasing them turned
    # every daemon tick on synthetics into a no-op (empty bars → early return),
    # which is why deployed bots on synthetic indices appeared to "wait
    # forever" with last_tick_ts=0 and no events ever fired. Only forex
    # slashes are normalised; everything else passes through.
    sym = (sym or "").replace("/", "").strip()
    if not sym:
        return []

    if not mt5_client.is_connected():
        # Best-effort transparent reconnect when we have credentials.
        if getattr(mt5_client, "_LAST_CREDS", None):
            ok, _ = mt5_client.reconnect()
            if not ok:
                return []
        else:
            return []

    try:
        bars = mt5_client.get_rates(sym, timeframe, count=count)
        n = len(bars) if bars else 0
        # Temporary diagnostic: surface per-fetch result so a silent "no bars"
        # path doesn't look like a hung daemon. Drop to .debug once the
        # deploy/hydrate symbol-map path is verified in the wild.
        logger.info("daemon fetch inst=%s sym=%r tf=%s count=%d → %d bars", instrument_id, sym, timeframe, count, n)
        return bars or []
    except Exception as e:
        logger.warning("daemon bars fetch failed inst=%s sym=%r tf=%s: %s", instrument_id, sym, timeframe, e)
        return []


def _legacy_symbol_from_id(instrument_id: str) -> str:
    """Fallback ``inst-eurusd`` → ``EURUSD`` derivation when no explicit symbol
    map exists. Matches the heuristic used by ``backtest_server``."""
    return instrument_id.replace("inst-", "").replace("-", "").upper()


# Optional caller-supplied symbol map (instrument_id → broker symbol). The FE
# publishes this whenever it pushes daemon configs, so the bar fetch can use
# the right Exness suffix (``EURUSDm`` / ``EURUSDr`` / ``EURUSDz``) for the
# user's account type rather than the bare ``EURUSD``.
#
# Stage 4 (review §4.1): atomic-swap pattern. Worker threads read the map
# during ticks; the FE updates it via set_instrument_symbol_map at any
# time. The clear-then-populate pattern in the old code briefly exposed
# an empty dict to readers. We now build the new dict locally and bind
# it in a single assignment under a lock so readers always see either
# the old map or the fully-populated new one.
_INSTRUMENT_SYMBOL_MAP: dict[str, str] = {}
_INSTRUMENT_SYMBOL_MAP_LOCK = threading.Lock()


def set_instrument_symbol_map(mapping: dict[str, str]) -> None:
    """Replace the daemon's instrument-id → broker-symbol map atomically."""
    new_map: dict[str, str] = {}
    for k, v in (mapping or {}).items():
        if isinstance(k, str) and isinstance(v, str) and v.strip():
            new_map[k] = v.strip()
    global _INSTRUMENT_SYMBOL_MAP
    with _INSTRUMENT_SYMBOL_MAP_LOCK:
        _INSTRUMENT_SYMBOL_MAP = new_map


def get_instrument_symbol_map() -> dict[str, str]:
    """Return a copy of the current map. Use this from worker threads
    rather than reading ``_INSTRUMENT_SYMBOL_MAP`` directly."""
    with _INSTRUMENT_SYMBOL_MAP_LOCK:
        return dict(_INSTRUMENT_SYMBOL_MAP)


# ── NN predict: call the existing /predict logic in-process ─────────────────


def daemon_predict(
    cfg: BotRuntimeConfig,
    bars: list[dict],
    regime: str,
    confidence: float,
    price: float,
) -> dict:
    """Inline /predict path.

    We bypass the HTTP layer because we're already in the same process. Falls
    back to a neutral decision when the bot has no checkpoint yet."""
    import os
    from pathlib import Path
    import numpy as np
    import torch

    from .train import _safe_instrument_id

    safe = _safe_instrument_id(cfg.instrument_id)
    ckpt_dir = Path(os.environ.get("CICADA_NN_CHECKPOINTS", "checkpoints"))
    manifest_path = ckpt_dir / f"instrument_detection_{safe}_manifest.json"
    pt_path = ckpt_dir / f"instrument_bot_nn_{safe}.pt"

    # Prefer the per-TF checkpoint listed in the manifest — /build writes
    # ``instrument_detection_<safe>__<TF>.pt`` with a manifest pointing at it,
    # so the old no-suffix ``instrument_detection_<safe>.pt`` is typically a
    # stale artifact from a previous build process and a load-time crash
    # (different model architecture). Resolution order:
    #   1. manifest[primary_tf or nn_detection_timeframe] if present
    #   2. any manifest entry (pick the highest val_accuracy)
    #   3. legacy no-suffix path (last resort; usually stale)
    det_path: Path | None = None
    det_bar_window: int | None = None
    if manifest_path.exists():
        try:
            import json as _json
            manifest = _json.loads(manifest_path.read_text())
            models = (manifest.get("models") or {})
            wanted_tf = str(cfg.nn_detection_timeframe or cfg.primary_timeframe or "").upper()
            chosen = models.get(wanted_tf)
            if chosen is None and models:
                # Highest val_accuracy across whatever the manifest holds.
                chosen = max(models.values(), key=lambda m: float(m.get("val_accuracy") or 0.0))
            if isinstance(chosen, dict) and chosen.get("checkpoint_path"):
                # Manifest stores e.g. "checkpoints/instrument_detection_<inst>__H1.pt"
                # — a path relative to the backend's CWD. Resolve by basename
                # against our known ckpt_dir so we work regardless of how the
                # backend was launched.
                candidate = ckpt_dir / Path(chosen["checkpoint_path"]).name
                if candidate.exists():
                    det_path = candidate
                    bw = chosen.get("bar_window")
                    if bw is not None:
                        det_bar_window = int(bw)
        except Exception as e:  # noqa: BLE001 — manifest parsing is best-effort
            logger.warning("daemon predict: manifest parse failed (%s); trying legacy no-suffix path", e)
    if det_path is None:
        legacy = ckpt_dir / f"instrument_detection_{safe}.pt"
        if legacy.exists():
            det_path = legacy

    # Detection model (V3) preferred when available. Wrapped in try/except
    # so a stale or mis-architected checkpoint (e.g. an older save with
    # ``net.0/3/6`` keys when the current StrategyDetectionNN expects
    # ``conv_blocks/attn/positional``) doesn't crash the daemon tick on every
    # iteration — we fall through to the tabular path or final NEUTRAL.
    required_bars = det_bar_window or cfg.nn_detection_bar_window or 60
    if det_path is not None and det_path.exists() and len(bars) >= required_bars:
      try:
        from .bar_features import BarFeatureConfig, window_features
        from .model import build_detection_model_from_checkpoint

        ckpt = torch.load(det_path, map_location="cpu", weights_only=True)
        meta = ckpt.get("meta", {})
        # ── Aggressive safety gate (kill switch) ────────────────────────────
        # Operator confirmed: this aggressive NEUTRAL gate is the configuration
        # that produced the +$348 / 42-wins demo run. Softening it to "halve
        # size + tighten stop" added losing trades. Models below the val_acc
        # floor return NEUTRAL — the daemon never opens a position on their
        # raw signal. Strategy-signal fallbacks and the ensemble-confirmed
        # path can still fire when they agree independently.
        if meta.get("safe_to_use") is False:
            logger.warning(
                "daemon predict refused: bot=%s val_acc=%s below promotion floor",
                cfg.bot_id, meta.get("val_accuracy"),
            )
            return {
                "action": 2,
                "confidence": 0.0,
                "sl_pct": cfg.risk_params.default_stop_loss_pct,
                "tp_r": cfg.risk_params.default_risk_reward_ratio,
                "size_multiplier": 1.0,
                "safe_to_use": False,
                "warning": "model unsafe (val_acc below floor)",
            }
        bar_window = int(meta.get("bar_window", cfg.nn_detection_bar_window or 60))
        feat_cfg = BarFeatureConfig(window=bar_window, include_context=True)
        feat = window_features(bars, len(bars) - 1, feat_cfg)
        model = build_detection_model_from_checkpoint(ckpt)
        model.load_state_dict(ckpt["model_state"], strict=True)
        model.eval()
        with torch.no_grad():
            logits, reg = model.forward_with_regression(
                torch.from_numpy(feat.astype(np.float32)).unsqueeze(0)
            )
            probs = torch.softmax(logits, dim=1)
            pred = int(logits.argmax(dim=1).item())
            conf = float(probs[0, pred].item())
            raw = reg[0].detach().cpu().numpy()
        # V3 labels: 0=short, 1=long, 2=neutral → response action: 0=long, 1=short, 2=neutral.
        action = 1 if pred == 0 else (0 if pred == 1 else 2)
        return {
            "action": action,
            "confidence": conf,
            "sl_pct": float(0.01 + 0.04 * raw[1]),
            "tp_r": float(1.0 + 2.0 * raw[2]),
            "size_multiplier": float(0.5 + 1.5 * raw[0]),
            "safe_to_use": True,
        }
      except (RuntimeError, KeyError) as e:
        # Stale checkpoint (architecture mismatch / missing keys) — log once
        # per tick at WARNING (the daemon will keep ticking) and fall through
        # to the tabular path. The fix is to rebuild the bot, which produces a
        # fresh checkpoint compatible with the current model class.
        logger.warning(
            "daemon predict: detection checkpoint %s is incompatible (%s); "
            "falling back to tabular. Rebuild the bot to refresh.",
            det_path.name, type(e).__name__,
        )

    # Tabular fallback when no detection checkpoint exists yet.
    if pt_path.exists() and cfg.nn_feature_vector:
        from .model import NUM_REGIMES, NUM_TIMEFRAMES, build_model_from_checkpoint
        from .train import instrument_type_to_idx

        ckpt = torch.load(pt_path, map_location="cpu", weights_only=True)
        model = build_model_from_checkpoint(ckpt)
        model.load_state_dict(ckpt["model_state"], strict=False)
        model.eval()
        feat = np.array(cfg.nn_feature_vector, dtype=np.float32)
        feat_dim = ckpt.get("strategy_feature_dim", 256)
        if feat.size != feat_dim:
            if feat.size < feat_dim:
                feat = np.pad(feat, (0, feat_dim - feat.size))
            else:
                feat = feat[:feat_dim]
        x = torch.from_numpy(feat).unsqueeze(0)
        inst = torch.tensor([instrument_type_to_idx(cfg.instrument_type)], dtype=torch.long)
        with torch.no_grad():
            try:
                actions, conf, size_mult, sl_pct, tp_r, _ = model.predict_with_params(
                    x, inst,
                    regime_onehot=torch.zeros(1, NUM_REGIMES),
                    timeframe_onehot=torch.zeros(1, NUM_TIMEFRAMES),
                    style_index=0,
                )
            except Exception:
                actions = model.predict_actions(
                    x, inst,
                    regime_onehot=torch.zeros(1, NUM_REGIMES),
                    timeframe_onehot=torch.zeros(1, NUM_TIMEFRAMES),
                )
                conf, sl_pct, tp_r = 0.5, cfg.risk_params.default_stop_loss_pct, cfg.risk_params.default_risk_reward_ratio
        return {
            "action": int(actions[0, 0].item()),
            "confidence": float(conf),
            "sl_pct": float(sl_pct),
            "tp_r": float(tp_r),
        }

    # No model yet → neutral. The daemon will skip the trade.
    return {"action": 2, "confidence": 0.0, "sl_pct": cfg.risk_params.default_stop_loss_pct, "tp_r": cfg.risk_params.default_risk_reward_ratio}


# ── Strategy signal: thin wrapper over signals.py ───────────────────────────


def daemon_strategy_signal(cfg: BotRuntimeConfig, bars: list[dict], regime: str) -> int:
    """Return the strategy signal for the bot's primary strategy. Default to
    neutral when no strategy is configured or the call fails.

    Reads from ``cfg.strategy_ids[0]`` — populated by /daemon/deploy and the
    storage hydrator. The previous version hard-coded ``ind-rsi`` because the
    config didn't carry strategies, so a bot deployed with ``cp-double-top``
    silently ran the RSI signal instead — meaning the ensemble never saw the
    user's actual strategy and the bot effectively always traded RSI."""
    from .signals import get_signal

    ids = getattr(cfg, "strategy_ids", None) or []
    if not ids:
        return 0
    try:
        return int(get_signal(ids[0], bars, len(bars) - 1, regime, None))
    except Exception:
        return 0


# ── Order placement: events-only stub (real broker plumbing in next round) ──


# Lazy storage handle so tests can swap an isolated tmp dir in.
_ORDER_STORE: Optional[OrderRecordStore] = None


def set_order_store(store: Optional[OrderRecordStore]) -> None:
    """Inject (or clear) the OrderRecordStore the daemon writes to. Called by
    the API startup hook with ``StorageService.orders``."""
    global _ORDER_STORE
    _ORDER_STORE = store


def get_order_store() -> Optional[OrderRecordStore]:
    return _ORDER_STORE


def daemon_submit_order(
    cfg: BotRuntimeConfig,
    side: str,
    size: float,
    entry: float,
    stop: float,
    target: float,
    meta: Optional[dict] = None,
) -> dict:
    """Submit an order. Writes a row to the append-only ``orders`` store, then
    either publishes a stub event (current behaviour, no live MT5 placement
    from the daemon yet) or — when MT5 is connected and the bot is wired for
    live execution — calls ``mt5_client.order_send`` with the per-mode magic.

    ``meta`` is supplied by the daemon and carries the validation outcome,
    confidence, style, and magic. When ``meta['rejected']`` is True we record
    a REJECTED row and return without touching the broker."""
    meta = meta or {}
    store = _ORDER_STORE
    style = str(meta.get("style") or cfg.trade_style or "day")
    magic = int(meta.get("magic") or 0)
    confidence = meta.get("confidence")
    # Stage 9: tick capture from execution_daemon. None on bridge unreachable;
    # the order row stores NULL in that case so reads stay safe on legacy data.
    sig_price = meta.get("signal_price")
    tick_bid = meta.get("tick_bid_at_signal")
    tick_ask = meta.get("tick_ask_at_signal")
    slip_pips = meta.get("realized_slippage_pips")
    tick_kwargs: dict[str, Any] = {
        "signal_price": float(sig_price) if sig_price is not None else None,
        "tick_bid_at_signal": float(tick_bid) if tick_bid is not None else None,
        "tick_ask_at_signal": float(tick_ask) if tick_ask is not None else None,
        "realized_slippage_pips": float(slip_pips) if slip_pips is not None else None,
    }

    # Stage 3: guard the entry path against active halts (reconciler ghost
    # detection, drift halt, emergency stop). The min-hold / per-mode
    # validation already gated us; guards are the *system-wide* halt that
    # supersedes per-bot validation. Reject loud, never silent.
    guards = get_guards()
    if guards.emergency_stopped:
        reason = f"emergency_stop:{guards.emergency_reason or 'unknown'}"
        if store is not None:
            try:
                store.append_order(
                    bot_id=cfg.bot_id,
                    instrument_id=cfg.instrument_id,
                    instrument_symbol=cfg.instrument_symbol,
                    style=style,
                    side=side,
                    size=size,
                    entry_price=entry,
                    stop_loss=stop,
                    take_profit=target,
                    confidence=float(confidence) if confidence is not None else None,
                    status=OrderStatus.REJECTED,
                    reason=reason,
                    **tick_kwargs,
                )
            except Exception as e:
                _warn_with_event("order_record_emergency", "guards reject (emergency) append failed bot=%s: %s", bot_id=cfg.bot_id, error=str(e))
        EVENT_BUS.publish(
            "order", bot_id=cfg.bot_id, status="rejected", reason=reason, ts=time.time(),
        )
        return {"status": "rejected", "reason": reason}

    # Soft halt: block new entries, but the SL/TP manager is allowed to
    # keep advancing existing positions (its calls go through
    # daemon_sl_event, not here).
    if guards.new_orders_halted and not meta.get("rejected"):
        reason = f"halt_new_orders:{guards.halt_reason or 'unknown'}"
        if store is not None:
            try:
                store.append_order(
                    bot_id=cfg.bot_id,
                    instrument_id=cfg.instrument_id,
                    instrument_symbol=cfg.instrument_symbol,
                    style=style,
                    side=side,
                    size=size,
                    entry_price=entry,
                    stop_loss=stop,
                    take_profit=target,
                    confidence=float(confidence) if confidence is not None else None,
                    status=OrderStatus.REJECTED,
                    reason=reason,
                    **tick_kwargs,
                )
            except Exception as e:
                _warn_with_event("order_record_halt", "guards reject (halt) append failed bot=%s: %s", bot_id=cfg.bot_id, error=str(e))
        EVENT_BUS.publish(
            "order", bot_id=cfg.bot_id, status="rejected", reason=reason, ts=time.time(),
        )
        return {"status": "rejected", "reason": reason}

    if meta.get("rejected"):
        if store is not None:
            try:
                store.append_order(
                    bot_id=cfg.bot_id,
                    instrument_id=cfg.instrument_id,
                    instrument_symbol=cfg.instrument_symbol,
                    style=style,
                    side=side,
                    size=size,
                    entry_price=entry,
                    stop_loss=stop,
                    take_profit=target,
                    confidence=float(confidence) if confidence is not None else None,
                    status=OrderStatus.REJECTED,
                    reason=str(meta.get("reason") or "rejected"),
                    **tick_kwargs,
                )
            except Exception as e:
                _warn_with_event("order_record_rejected", "order_records append (rejected) failed bot=%s: %s", bot_id=cfg.bot_id, error=str(e))
        EVENT_BUS.publish(
            "order",
            bot_id=cfg.bot_id,
            instrument_id=cfg.instrument_id,
            instrument_symbol=cfg.instrument_symbol,
            side=side,
            size=size,
            entry=entry,
            stop=stop,
            target=target,
            ts=time.time(),
            broker="stub",
            status="rejected",
            reason=str(meta.get("reason") or "rejected"),
            detail=str(meta.get("detail") or ""),
        )
        return {"status": "rejected", "reason": meta.get("reason"), "detail": meta.get("detail")}

    # Record INTENT first so a broker error still leaves a trace.
    intent_id = None
    if store is not None:
        try:
            intent_id = store.append_order(
                bot_id=cfg.bot_id,
                instrument_id=cfg.instrument_id,
                instrument_symbol=cfg.instrument_symbol,
                style=style,
                side=side,
                size=size,
                entry_price=entry,
                stop_loss=stop,
                take_profit=target,
                confidence=float(confidence) if confidence is not None else None,
                status=OrderStatus.INTENT,
                **tick_kwargs,
            )
        except Exception as e:
            _warn_with_event("order_record_intent", "order_records append (intent) failed bot=%s: %s", bot_id=cfg.bot_id, error=str(e))

    ticket: int = 0
    broker = "stub"
    error: Optional[str] = None
    if mt5_client.is_connected() and (cfg.instrument_symbol or "").strip():
        try:
            ok, result = mt5_client.order_send(
                symbol=cfg.instrument_symbol,
                side="buy" if side == "LONG" else "sell",
                volume=float(size),
                sl=float(stop) if stop > 0 else None,
                tp=float(target) if target > 0 else None,
                magic=magic,
                comment=f"cicada-{style}",
            )
            broker = "mt5"
            if ok:
                ticket = int(result.get("ticket") or 0)
            else:
                error = str(result.get("error") or "order failed")
        except Exception as e:
            error = str(e)
            _warn_with_event("mt5_order_send", "mt5 order_send raised bot=%s: %s", bot_id=cfg.bot_id, error=str(e))

    if store is not None:
        try:
            if error is not None:
                store.append_order(
                    bot_id=cfg.bot_id,
                    instrument_id=cfg.instrument_id,
                    instrument_symbol=cfg.instrument_symbol,
                    style=style,
                    side=side,
                    size=size,
                    entry_price=entry,
                    stop_loss=stop,
                    take_profit=target,
                    confidence=float(confidence) if confidence is not None else None,
                    status=OrderStatus.BROKER_ERROR,
                    reason=error,
                    ticket=ticket if ticket > 0 else None,
                    **tick_kwargs,
                )
            else:
                final_status = OrderStatus.SUBMITTED if broker == "stub" else OrderStatus.FILLED
                store.append_order(
                    bot_id=cfg.bot_id,
                    instrument_id=cfg.instrument_id,
                    instrument_symbol=cfg.instrument_symbol,
                    style=style,
                    side=side,
                    size=size,
                    entry_price=entry,
                    stop_loss=stop,
                    take_profit=target,
                    confidence=float(confidence) if confidence is not None else None,
                    status=final_status,
                    ticket=ticket if ticket > 0 else None,
                    **tick_kwargs,
                )
                # Initial SL/TP is the first sl_tp_events row for this ticket.
                if ticket > 0:
                    store.append_sl_tp_event(
                        ticket=ticket,
                        bot_id=cfg.bot_id,
                        kind=SLTPEventKind.INITIAL,
                        sl=stop,
                        tp=target,
                        price=entry,
                        note=f"open {side} {style}",
                    )
        except Exception as e:
            _warn_with_event("order_record_final", "order_records append (final) failed bot=%s: %s", bot_id=cfg.bot_id, error=str(e))

    EVENT_BUS.publish(
        "order",
        bot_id=cfg.bot_id,
        instrument_id=cfg.instrument_id,
        instrument_symbol=cfg.instrument_symbol,
        side=side,
        size=size,
        entry=entry,
        stop=stop,
        target=target,
        ts=time.time(),
        broker=broker,
        ticket=ticket or None,
        status="error" if error else "queued",
        error=error,
    )
    return {
        "status": "error" if error else "queued",
        "side": side,
        "size": size,
        "entry": entry,
        "ticket": ticket if ticket > 0 else None,
        "error": error,
        "intent_id": intent_id,
    }


def daemon_sl_event(
    *,
    bot_id: str,
    ticket: int,
    kind: str,
    sl: Optional[float] = None,
    tp: Optional[float] = None,
    price: Optional[float] = None,
    note: str = "",
) -> None:
    """SL/TP-modification hook called from the daemon's per-tick lifecycle.
    Records the change in ``order_records.sl_tp_events`` (NEW row, never an
    update) and pushes the modification to MT5 when applicable."""
    store = _ORDER_STORE
    if store is not None:
        try:
            store.append_sl_tp_event(
                ticket=ticket,
                bot_id=bot_id,
                kind=kind,
                sl=sl,
                tp=tp,
                price=price,
                note=note,
            )
        except Exception as e:
            logger.warning("order_records append (sl event) failed bot=%s ticket=%s: %s",
                           bot_id, ticket, e)
    if sl is not None and mt5_client.is_connected():
        try:
            mt5_client.modify_sl(ticket=ticket, symbol="", new_sl=sl, new_tp=tp)
        except Exception as e:
            _warn_with_event("mt5_modify_sl", "mt5 modify_sl failed bot=%s ticket=%s: %s", bot_id=bot_id, ticket=ticket, error=str(e))
    EVENT_BUS.publish(
        "sl_tp_event",
        bot_id=bot_id,
        ticket=ticket,
        kind=kind,
        sl=sl,
        tp=tp,
        price=price,
        note=note,
        ts=time.time(),
    )


# ── Lifecycle ──────────────────────────────────────────────────────────────

def _auto_daemon_enabled() -> bool:
    """Backend daemon is the canonical owner of the live trade loop.

    Stage 2B+ took the position that the spec-aligned backend ExecutionDaemon
    owns trading: per-mode validation (bug 3), append-only order records
    (bug 4), SL/TP lifecycle (bug 2), min-hold gate (bug 1), latency gates
    (Stage 2A checks 6/7), and the geometric / execution-quality / fakeout
    pipeline (Stage 2B) all live here. The browser-side ``runBotExecution``
    loop has been removed; there is no longer a parallel path.

    Default ON. ``CICADA_DISABLE_EXECUTION_DAEMON=1`` is an emergency
    kill switch for ops (e.g. running just the API for inspection without
    spawning daemon threads). When disabled, deployed bots simply do not
    trade — there is no fallback.
    """
    raw = (os.environ.get("CICADA_DISABLE_EXECUTION_DAEMON") or "").strip().lower()
    return raw not in {"1", "true", "yes", "on"}


_DAEMON: Optional[ExecutionDaemon] = None


def _live_tick_provider(symbol: str) -> Optional[dict]:
    """Stage 9: live tick fetch for the daemon. Routes through mt5_client so
    every callsite shares the same Bridge*Error → None fallback. Returns
    None on bridge unreachable, unknown symbol, or any client error — the
    daemon falls back to bar close in that case."""
    if not symbol or not mt5_client.is_connected():
        return None
    try:
        return mt5_client.get_tick(str(symbol))
    except Exception as e:
        logger.debug("live tick fetch failed sym=%s: %s", symbol, e)
        return None


def _live_close_position(ticket: int) -> None:
    """Stage 9: belt-and-suspenders intra-bar close. Routes through
    mt5_client.close_position which already swallows BridgeError into a
    structured (False, ...) tuple. We re-raise on failure so the daemon
    can log it; the broker's registered SL is still in force regardless."""
    ok, info = mt5_client.close_position(ticket=int(ticket))
    if not ok:
        raise RuntimeError(str(info.get("error") or f"close ticket {ticket} failed"))


def get_daemon() -> ExecutionDaemon:
    global _DAEMON
    if _DAEMON is None:
        _DAEMON = ExecutionDaemon(
            portfolio_provider=get_portfolio_snapshot,
            bars_provider=fetch_bars_for_daemon,
            predict_fn=daemon_predict,
            strategy_signal_fn=daemon_strategy_signal,
            order_fn=daemon_submit_order,
            sl_event_fn=daemon_sl_event,
            tick_provider=_live_tick_provider,
            close_position_fn=_live_close_position,
        )
    return _DAEMON


# Map daemon event ``kind`` → ExecutionLogEvent phase + outcome so the
# dashboard's BotExecutionLog can render the right icon/colour.
_KIND_TO_PHASE: dict[str, tuple[str, str]] = {
    "scope_paused":      ("select_scope", "skip"),
    "ensemble":          ("predict",      "skip"),     # ensemble NEUTRAL — no order
    "risk_block":        ("risk_check",   "skip"),
    "validate_reject":   ("validate",     "fail"),
    "order":             ("order",        "success"),
    "order_error":       ("order",        "fail"),
    "sl_modify":         ("sl_modify",    "success"),
    "trade_open":        ("trade_open",   "success"),
    "trade_close":       ("trade_close",  "success"),
    "boot":              ("skipped",      "ignored"),
    "deployed":          ("skipped",      "ignored"),
    "enabled":           ("skipped",      "ignored"),
    "disabled":          ("skipped",      "ignored"),
}


def _bot_event_to_log_row(ev: dict[str, Any]) -> dict[str, Any]:
    """Convert a daemon EVENT_BUS payload into an ExecutionLogEvent row."""
    import uuid as _uuid
    from datetime import datetime as _dt, timezone as _tz
    kind = str(ev.get("kind") or "")
    phase, outcome = _KIND_TO_PHASE.get(kind, ("skipped", "ignored"))
    ts = float(ev.get("ts") or time.time())
    iso = _dt.fromtimestamp(ts, tz=_tz.utc).isoformat()
    # Compact message — the human-readable summary the BotExecutionLog row shows.
    message_bits: list[str] = [kind]
    for k in ("action", "side", "reason", "detail", "strategy_id", "strategy_signal",
              "nn_action", "regime"):
        v = ev.get(k)
        if v is not None and v != "":
            message_bits.append(f"{k}={v}")
    return {
        "id": _uuid.uuid4().hex,
        "timestamp": iso,
        "botId": str(ev.get("bot_id") or ""),
        "symbol": str(ev.get("instrument_symbol") or ""),
        "phase": phase,
        "outcome": outcome,
        "message": " ".join(message_bits)[:240],
        "details": ev,
    }


def start_execution_log_persister(storage: StorageService) -> threading.Thread:
    """Subscribe to bot_tick events and persist each one to the execution-log
    table so the dashboard's BotExecutionLog (which reads via GET /execution-log)
    sees daemon activity.

    Previously the daemon's events only existed in EVENT_BUS (in-memory) and
    SSE; no frontend code ever subscribed, so the UI's bot card sat on
    "Waiting for next tick…" even when the daemon was emitting events every
    30 s. This thread is the missing bridge between the daemon's bus and
    the persisted execution log."""
    from .event_bus import EVENT_BUS
    sub = EVENT_BUS.subscribe({"bot_tick"})
    log_max = 500  # matches EXECUTION_LOG_MAX in api.py

    def _loop() -> None:
        while True:
            try:
                ev = sub.queue.get(timeout=30.0)
            except Exception:
                continue
            try:
                row = _bot_event_to_log_row(ev.payload)
                existing = storage.execution_log.read() or []
                if not isinstance(existing, list):
                    existing = (existing.get("events") or []) if isinstance(existing, dict) else []
                existing.append(row)
                storage.execution_log.write(existing[-log_max:])
            except Exception:
                logger.exception("execution-log persister: row write failed")

    t = threading.Thread(target=_loop, name="execution-log-persister", daemon=True)
    t.start()
    return t


def hydrate_and_launch_from_storage(storage: StorageService) -> int:
    """On API startup: read persisted bots, instantiate daemon workers for any
    that are deployed. Returns count of bots launched."""
    if not _auto_daemon_enabled():
        logger.info("daemon auto-hydration disabled; frontend execution loop remains owner")
        return 0
    bots = storage.bots.read() or []
    if not isinstance(bots, list):
        return 0
    daemon = get_daemon()
    launched = 0
    # Build the instrument→symbol map from the bots we're about to hydrate.
    # Without this the daemon's bar fetcher falls back to _legacy_symbol_from_id,
    # which mangles synthetic instrument ids ('inst-deriv-r10' → 'DERIVR10')
    # and breaks every deployed bot on a synthetic until the FE pushes the map
    # — which it doesn't currently do. See fetch_bars_for_daemon.
    symbol_map = dict(get_instrument_symbol_map())
    for raw in bots:
        try:
            if (raw.get("status") or "").lower() != "deployed":
                continue
            # Map persisted bot record into the daemon's BotRuntimeConfig. The
            # mapping is intentionally tolerant — missing fields fall back to
            # safe defaults rather than refusing to deploy.
            risk = (raw.get("riskParams") or {})
            # Resolve trade style: prefer explicit fixedStyle, fall back to
            # the first fixedStyles entry, then to the first style in the
            # bot's strategy mix. None means "use scope default" — the daemon
            # will resolve to a real TradeModeRules either way.
            trade_style = (
                raw.get("fixedStyle")
                or (raw.get("fixedStyles") or [None])[0]
                or (raw.get("styles") or [None])[0]
            )
            cfg = BotRuntimeConfig(
                bot_id=str(raw.get("id") or ""),
                instrument_id=str(raw.get("instrumentId") or ""),
                instrument_symbol=str(raw.get("instrumentSymbol") or raw.get("instrument") or ""),
                instrument_type=str(raw.get("instrumentType") or "fiat"),
                primary_timeframe=str((raw.get("timeframes") or ["M5"])[0]),
                scope=str(raw.get("fixedScope") or "day"),
                trade_style=str(trade_style) if trade_style else None,
                risk_params=BotRiskParams(
                    risk_per_trade_pct=float(risk.get("riskPerTradePct") or 0.01),
                    max_drawdown_pct=float(risk.get("maxDrawdownPct") or 0.15),
                    use_kelly=bool(risk.get("useKelly", True)),
                    kelly_fraction=float(risk.get("kellyFraction") or 0.25),
                    max_correlated_exposure=float(risk.get("maxCorrelatedExposure") or 1.5),
                    default_stop_loss_pct=float(risk.get("defaultStopLossPct") or 0.02),
                    default_risk_reward_ratio=float(risk.get("defaultRiskRewardRatio") or 2.0),
                ),
                max_positions=int(raw.get("maxPositions") or 2),
                strategy_ids=list(raw.get("strategyIds") or []),
                nn_feature_vector=list(raw.get("nnFeatureVector") or []),
                nn_detection_timeframe=raw.get("nnDetectionTimeframe"),
                nn_detection_bar_window=raw.get("nnDetectionBarWindow"),
            )
            if not cfg.bot_id or not cfg.instrument_id:
                continue
            if cfg.instrument_symbol:
                symbol_map[cfg.instrument_id] = cfg.instrument_symbol
            daemon.deploy(cfg)
            launched += 1
        except Exception as e:
            logger.warning("daemon hydrate skip bot=%r: %s", raw.get("id"), e)
    if symbol_map:
        set_instrument_symbol_map(symbol_map)
    if launched:
        logger.info("daemon hydrated %d bot(s) from storage", launched)
    return launched


def shutdown_daemon() -> None:
    """Stop all daemon workers (called on uvicorn shutdown)."""
    global _DAEMON
    if _DAEMON is not None:
        _DAEMON.stop_all()
