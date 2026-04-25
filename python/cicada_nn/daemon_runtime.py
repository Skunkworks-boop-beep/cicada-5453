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
from .risk import BotRiskParams, PortfolioState, PositionLite
from .storage import StorageService
from . import mt5_client


logger = logging.getLogger(__name__)


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
    sym = _INSTRUMENT_SYMBOL_MAP.get(instrument_id) or _legacy_symbol_from_id(instrument_id)
    sym = (sym or "").replace("/", "").upper()
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
        return bars or []
    except Exception as e:
        logger.debug("daemon bars fetch failed inst=%s sym=%s tf=%s: %s", instrument_id, sym, timeframe, e)
        return []


def _legacy_symbol_from_id(instrument_id: str) -> str:
    """Fallback ``inst-eurusd`` → ``EURUSD`` derivation when no explicit symbol
    map exists. Matches the heuristic used by ``backtest_server``."""
    return instrument_id.replace("inst-", "").replace("-", "").upper()


# Optional caller-supplied symbol map (instrument_id → broker symbol). The FE
# publishes this whenever it pushes daemon configs, so the bar fetch can use
# the right Exness suffix (``EURUSDm`` / ``EURUSDr`` / ``EURUSDz``) for the
# user's account type rather than the bare ``EURUSD``.
_INSTRUMENT_SYMBOL_MAP: dict[str, str] = {}


def set_instrument_symbol_map(mapping: dict[str, str]) -> None:
    """Replace the daemon's instrument-id → broker-symbol map. Idempotent."""
    _INSTRUMENT_SYMBOL_MAP.clear()
    for k, v in (mapping or {}).items():
        if isinstance(k, str) and isinstance(v, str) and v.strip():
            _INSTRUMENT_SYMBOL_MAP[k] = v.strip()


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
    det_path = ckpt_dir / f"instrument_detection_{safe}.pt"
    pt_path = ckpt_dir / f"instrument_bot_nn_{safe}.pt"

    # Detection model (V3) preferred when available.
    if det_path.exists() and len(bars) >= (cfg.nn_detection_bar_window or 60):
        from .bar_features import BarFeatureConfig, window_features
        from .model import build_detection_model_from_checkpoint

        ckpt = torch.load(det_path, map_location="cpu", weights_only=True)
        meta = ckpt.get("meta", {})
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
        }

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
    neutral when no strategy is configured or the call fails."""
    from .signals import get_signal

    # The bot config may carry a strategy id in meta; for now use a neutral
    # default. Once the daemon exposes its own /deploy endpoint with explicit
    # strategy_id, this will read from there.
    strategy_id = getattr(cfg, "strategy_id", None) or "ind-rsi"
    try:
        return int(get_signal(strategy_id, bars, len(bars) - 1, regime, None))
    except Exception:
        return 0


# ── Order placement: events-only stub (real broker plumbing in next round) ──


def daemon_submit_order(
    cfg: BotRuntimeConfig,
    side: str,
    size: float,
    entry: float,
    stop: float,
    target: float,
) -> dict:
    """Submit an order. Today: emit an event so the FE can show the intent.
    Wire to MT5/Deriv brokers in the next pass; the entry point is intentionally
    one function so swap-in is mechanical."""
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
    )
    return {"status": "queued", "side": side, "size": size, "entry": entry}


# ── Lifecycle ──────────────────────────────────────────────────────────────

def _auto_daemon_enabled() -> bool:
    """Backend daemon is opt-in until all broker bar/order paths are server-side.

    The browser loop already handles Deriv/eXness/MT5 data paths. Auto-starting
    the backend daemon for a Deriv bot currently starves it of bars (MT5-only
    provider), making the UI wait forever. Operators can still opt in explicitly
    with CICADA_ENABLE_EXECUTION_DAEMON=1 for backend-owned experiments.
    """
    return (os.environ.get("CICADA_ENABLE_EXECUTION_DAEMON") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


_DAEMON: Optional[ExecutionDaemon] = None


def get_daemon() -> ExecutionDaemon:
    global _DAEMON
    if _DAEMON is None:
        _DAEMON = ExecutionDaemon(
            portfolio_provider=get_portfolio_snapshot,
            bars_provider=fetch_bars_for_daemon,
            predict_fn=daemon_predict,
            strategy_signal_fn=daemon_strategy_signal,
            order_fn=daemon_submit_order,
        )
    return _DAEMON


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
    for raw in bots:
        try:
            if (raw.get("status") or "").lower() != "deployed":
                continue
            # Map persisted bot record into the daemon's BotRuntimeConfig. The
            # mapping is intentionally tolerant — missing fields fall back to
            # safe defaults rather than refusing to deploy.
            risk = (raw.get("riskParams") or {})
            cfg = BotRuntimeConfig(
                bot_id=str(raw.get("id") or ""),
                instrument_id=str(raw.get("instrumentId") or ""),
                instrument_symbol=str(raw.get("instrumentSymbol") or raw.get("instrument") or ""),
                instrument_type=str(raw.get("instrumentType") or "fiat"),
                primary_timeframe=str((raw.get("timeframes") or ["M5"])[0]),
                scope=str(raw.get("fixedScope") or "day"),
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
                nn_feature_vector=list(raw.get("nnFeatureVector") or []),
                nn_detection_timeframe=raw.get("nnDetectionTimeframe"),
                nn_detection_bar_window=raw.get("nnDetectionBarWindow"),
            )
            if not cfg.bot_id or not cfg.instrument_id:
                continue
            daemon.deploy(cfg)
            launched += 1
        except Exception as e:
            logger.warning("daemon hydrate skip bot=%r: %s", raw.get("id"), e)
    if launched:
        logger.info("daemon hydrated %d bot(s) from storage", launched)
    return launched


def shutdown_daemon() -> None:
    """Stop all daemon workers (called on uvicorn shutdown)."""
    global _DAEMON
    if _DAEMON is not None:
        _DAEMON.stop_all()
