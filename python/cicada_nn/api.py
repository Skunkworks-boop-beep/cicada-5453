"""
FastAPI service for CICADA-5453 NN: build (train) bot from backtest results, MT5 connect, predict actions.
Run: uvicorn cicada_nn.api:app --reload --host 0.0.0.0 --port 8000
"""

import json
import logging
import os
from datetime import datetime, timezone
from threading import RLock
from typing import Any

logger = logging.getLogger(__name__)
import tempfile
from pathlib import Path

import numpy as np
import torch

from .train import _safe_instrument_id
from fastapi import Body, Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse


# ── Optional API key auth ─────────────────────────────────────────────────────
# When CICADA_API_KEY is set in the environment, mutating endpoints (build,
# state writes, MT5 order/close-partial) require the X-API-Key header to match.
# Read-only endpoints stay open so the dashboard works without configuring auth.
# Empty / unset → auth disabled (preserves current developer experience).
_API_KEY = (os.environ.get("CICADA_API_KEY") or "").strip()


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    if not _API_KEY:
        return
    if x_api_key != _API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")

# Use CUDA for inference when available (e.g. RTX 2070)
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
_MODEL_CACHE_LOCK = RLock()
_DETECTION_MODEL_CACHE: dict[str, dict[str, Any]] = {}
_TABULAR_MODEL_CACHE: dict[str, dict[str, Any]] = {}
try:
    _DETECTION_MC_SAMPLES = max(0, int(os.environ.get("CICADA_DETECTION_MC_SAMPLES", "4")))
except ValueError:
    _DETECTION_MC_SAMPLES = 4
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .model import InstrumentBotNN, NUM_REGIMES, NUM_TIMEFRAMES
from .train import backtest_rows_to_features, instrument_type_to_idx, train
from . import mt5_client
from .backtest_server import run_backtest as run_server_backtest, run_backtest_stream as run_server_backtest_stream, MIN_BARS_REQUIRED_BACKTEST
from .grid_config import (
    DEFAULT_PARAM_COMBOS_LIMIT,
    DEFAULT_RESEARCH_PARAM_TUNE_MAX_RISK,
    DEFAULT_RESEARCH_PARAM_TUNE_MAX_STRAT,
    DEFAULT_RESEARCH_REGIME_GRID_MAX,
    normalize_param_combos_limit,
)
from .research_server import run_grid_research, run_grid_research_with_progress, MIN_BARS_REQUIRED_RESEARCH
from .backward_validation import run_backward_validation
from .storage import StorageService
from .daemon_runtime import (
    get_daemon,
    hydrate_and_launch_from_storage,
    hydrate_portfolio_from_storage,
    set_instrument_symbol_map,
    set_portfolio_snapshot,
    shutdown_daemon,
)
from .event_bus import EVENT_BUS
from .execution_daemon import BotRuntimeConfig
from .job_manager import JOB_MANAGER
from .risk import BotRiskParams
from .shadow_training import (
    PromotionGate,
    ShadowRegistry,
    abort_shadow,
    can_promote_shadow,
    promote_shadow_atomically,
    shadow_train_detection,
    shadow_train_tabular,
)

app = FastAPI(title="CICADA-5453 NN API", version="0.1.0")

# CORS origins: comma-separated list in CICADA_CORS_ORIGINS (default "*").
# Keeping default open preserves the demo-mode developer experience on a local
# machine; production deployments should set it to the dashboard origin.
_cors_env = (os.environ.get("CICADA_CORS_ORIGINS") or "*").strip()
_cors_origins = [o.strip() for o in _cors_env.split(",") if o.strip()] or ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*", "X-API-Key"],
)


@app.on_event("startup")
def _configure_logging():
    """Install the structured JSON formatter and set sensible levels per module."""
    from .logging_setup import configure_logging
    from .compute import configure_torch_for_speed, get_compute_config
    configure_logging()
    configure_torch_for_speed()
    get_compute_config()  # warm the cache + emit the one-line config log


@app.on_event("startup")
def _bootstrap_daemon():
    """Hydrate persisted bots and launch the execution daemon. After this hook,
    the backend owns the live trade loop — the frontend's job is purely to
    display state and post user intent."""
    try:
        # Stale shadow jobs from the previous process must be cleared first;
        # their workers died with that process so they cannot still be
        # ``running`` even though the file says so.
        cleared = SHADOW_REGISTRY.mark_interrupted_active(
            "interrupted by backend restart"
        )
        if cleared:
            logger.info("cleared %d stale shadow job(s) on startup", cleared)
        hydrate_portfolio_from_storage(STORAGE)
        launched = hydrate_and_launch_from_storage(STORAGE)
        EVENT_BUS.publish("daemon", kind="boot", launched=launched, stale_shadow_cleared=cleared)
    except Exception:
        logger.exception("daemon bootstrap failed; bots will not auto-trade until /daemon/deploy is called")


@app.on_event("startup")
def _mark_interrupted_jobs():
    """Surface jobs that cannot survive a backend restart as stopped/cancelled."""
    try:
        stopped_shadow = SHADOW_REGISTRY.mark_interrupted_active()
        if stopped_shadow:
            logger.info("marked %d shadow job(s) interrupted by backend restart", stopped_shadow)
    except Exception:
        logger.exception("failed to mark interrupted shadow jobs")


@app.on_event("shutdown")
def _shutdown_daemon_hook():
    """Stop daemon workers cleanly so uvicorn restarts don't leak threads."""
    try:
        JOB_MANAGER.mark_active_stopped("stopped because backend shutdown/reload occurred")
    except Exception:
        logger.exception("job shutdown marking error")
    try:
        shutdown_daemon()
    except Exception:
        logger.exception("daemon shutdown error")


# ── Daemon control surface ────────────────────────────────────────────────
# The execution daemon now owns live bot trading. The FE calls these endpoints
# to deploy / stop / enable bots; the daemon publishes events on the bus and
# the FE subscribes via /events.

class DaemonDeployRequest(BaseModel):
    bot_id: str
    instrument_id: str
    instrument_symbol: str
    instrument_type: str = "fiat"
    primary_timeframe: str = "M5"
    scope: str = "day"
    # Trade-mode fields (mirror the FE BotConfig). When ``scope_mode`` is
    # 'manual' the daemon honours ``fixed_scope`` if it's in
    # ``allowed_scopes``; otherwise the bot pauses. When 'auto', the daemon
    # picks among ``allowed_scopes`` per tick using regime / equity / DD /
    # volatility filters.
    scope_mode: str = "manual"
    fixed_scope: str | None = None
    allowed_scopes: list[str] = ["scalp", "day", "swing"]
    max_positions: int = 2
    nn_feature_vector: list[float] = []
    nn_detection_timeframe: str | None = None
    nn_detection_bar_window: int | None = None
    risk_per_trade_pct: float = 0.01
    max_drawdown_pct: float = 0.15
    use_kelly: bool = True
    kelly_fraction: float = 0.25
    max_correlated_exposure: float = 1.5
    default_stop_loss_pct: float = 0.02
    default_risk_reward_ratio: float = 2.0


class DaemonPortfolioPush(BaseModel):
    equity: float
    drawdown_pct: float = 0.0
    # Frontend can keep posting positions for display; daemon uses this snapshot
    # to size the next entry.


@app.get("/daemon/list")
def daemon_list():
    """List the bots the daemon is currently running."""
    return {"bots": get_daemon().list()}


@app.post("/daemon/deploy", dependencies=[Depends(require_api_key)])
def daemon_deploy(req: DaemonDeployRequest):
    cfg = BotRuntimeConfig(
        bot_id=req.bot_id,
        instrument_id=req.instrument_id,
        instrument_symbol=req.instrument_symbol,
        instrument_type=req.instrument_type,
        primary_timeframe=req.primary_timeframe,
        scope=req.scope,
        scope_mode=req.scope_mode,
        fixed_scope=req.fixed_scope,
        allowed_scopes=list(req.allowed_scopes) if req.allowed_scopes else ["scalp", "day", "swing"],
        max_positions=req.max_positions,
        nn_feature_vector=list(req.nn_feature_vector),
        nn_detection_timeframe=req.nn_detection_timeframe,
        nn_detection_bar_window=req.nn_detection_bar_window,
        risk_params=BotRiskParams(
            risk_per_trade_pct=req.risk_per_trade_pct,
            max_drawdown_pct=req.max_drawdown_pct,
            use_kelly=req.use_kelly,
            kelly_fraction=req.kelly_fraction,
            max_correlated_exposure=req.max_correlated_exposure,
            default_stop_loss_pct=req.default_stop_loss_pct,
            default_risk_reward_ratio=req.default_risk_reward_ratio,
        ),
    )
    get_daemon().deploy(cfg)
    return {"deployed": cfg.bot_id}


@app.post("/daemon/{bot_id}/stop", dependencies=[Depends(require_api_key)])
def daemon_stop(bot_id: str):
    if not get_daemon().stop(bot_id):
        raise HTTPException(status_code=404, detail="bot not running")
    return {"stopped": bot_id}


@app.post("/daemon/{bot_id}/enable", dependencies=[Depends(require_api_key)])
def daemon_enable(bot_id: str):
    if not get_daemon().set_enabled(bot_id, True):
        raise HTTPException(status_code=404, detail="bot not running")
    return {"enabled": bot_id}


@app.post("/daemon/{bot_id}/disable", dependencies=[Depends(require_api_key)])
def daemon_disable(bot_id: str):
    if not get_daemon().set_enabled(bot_id, False):
        raise HTTPException(status_code=404, detail="bot not running")
    return {"disabled": bot_id}


@app.post("/daemon/portfolio", dependencies=[Depends(require_api_key)])
def daemon_portfolio_push(req: DaemonPortfolioPush):
    """Update the daemon's portfolio snapshot. Called by the FE whenever it
    syncs balance from a broker so the daemon's sizing uses the freshest equity."""
    set_portfolio_snapshot(req.equity, req.drawdown_pct)
    return {"ok": True, "equity": req.equity}


class DaemonSymbolMapRequest(BaseModel):
    """Map instrument_id → broker symbol. Lets the daemon use the correct
    Exness suffix (``EURUSDm`` / ``EURUSDz``) per account type rather than
    guessing from the instrument id."""
    symbols: dict[str, str]


@app.post("/daemon/symbols", dependencies=[Depends(require_api_key)])
def daemon_set_symbols(req: DaemonSymbolMapRequest):
    set_instrument_symbol_map(req.symbols)
    return {"ok": True, "count": len(req.symbols)}


# ── SSE event stream ───────────────────────────────────────────────────────
# The frontend opens GET /events once and receives every state-change event
# (trades, bot ticks, jobs, shadow promotions, log lines) in real time. The
# old model — frontend running its own execution loop — is replaced by this
# single push channel.

import asyncio  # late import is fine; uvicorn already pulls asyncio in


@app.get("/events")
async def sse_events(topics: str = ""):
    """Server-Sent Events: subscribe to backend state changes.

    ?topics=trade,bot,portfolio,shadow,job,log filters; empty = all.
    """
    topic_set = {t.strip() for t in topics.split(",") if t.strip()} or None
    sub = EVENT_BUS.subscribe(topic_set)
    queue_ref = sub.queue

    async def stream():
        # Initial nudge so the client knows the connection is live.
        from .event_bus import Event
        yield Event(topic="hello", payload={"connected": True}).to_sse()
        try:
            while True:
                # Drain in small batches for low latency without busy-spinning.
                try:
                    ev = await asyncio.get_event_loop().run_in_executor(
                        None, lambda: queue_ref.get(timeout=15.0)
                    )
                    yield ev.to_sse()
                except Exception:
                    # 15s heartbeat keeps proxies happy.
                    yield ": heartbeat\n\n"
        finally:
            EVENT_BUS.unsubscribe(sub)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Cross-request job registry ───────────────────────────────────────────
# UI calls /jobs to see all in-flight backtests / research / shadow training
# across sessions. /jobs/cancel sets the cooperative cancel token.

@app.get("/jobs")
def list_jobs(kind: str | None = None, active_only: bool = False):
    """Return the registered jobs (queued/running/finished). Filter by kind/active."""
    rows = JOB_MANAGER.list(kind=kind, active_only=active_only)
    jobs = [r.to_dict() for r in rows]
    if kind in (None, "shadow"):
        jobs.extend(_shadow_jobs_as_job_records(active_only=active_only))
    jobs.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return {"jobs": jobs}


def _shadow_jobs_as_job_records(active_only: bool = False) -> list[dict]:
    status_map = {
        "queued": "queued",
        "running": "running",
        "ready": "succeeded",
        "promoted": "succeeded",
        "failed": "failed",
        "aborted": "cancelled",
    }
    out: list[dict] = []
    for row in SHADOW_REGISTRY.list_jobs():
        raw_status = str(row.get("status") or "queued")
        status = status_map.get(raw_status, "failed")
        if active_only and status not in {"queued", "running"}:
            continue
        instrument_id = str(row.get("instrument_id") or "")
        kind = str(row.get("kind") or "shadow")
        progress = 100.0 if status in {"succeeded", "failed", "cancelled"} else (5.0 if status == "running" else 0.0)
        out.append({
            "job_id": str(row.get("job_id") or f"shadow-{instrument_id}"),
            "kind": "shadow",
            "title": f"shadow {kind} {instrument_id}".strip(),
            "status": status,
            "progress": progress,
            "message": row.get("message") or raw_status,
            "started_at": row.get("started_at"),
            "finished_at": row.get("finished_at"),
            "created_at": row.get("started_at") or row.get("finished_at") or "",
            "meta": {
                "instrument": instrument_id,
                "shadow_kind": kind,
                "raw_status": raw_status,
                "oos_accuracy": row.get("oos_accuracy"),
                "parent_oos_accuracy": row.get("parent_oos_accuracy"),
            },
            "error": row.get("error"),
        })
    return out


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    rec = JOB_MANAGER.get(job_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="unknown job_id")
    return rec.to_dict()


@app.post("/jobs/{job_id}/cancel", dependencies=[Depends(require_api_key)])
def cancel_job(job_id: str):
    ok = JOB_MANAGER.cancel(job_id)
    if not ok:
        raise HTTPException(status_code=404, detail="job not found or already finished")
    return {"cancelled": True, "job_id": job_id}


@app.get("/compute")
def compute_info():
    """Report resolved compute config so the UI can show GPU / worker usage."""
    from .compute import get_compute_config
    cfg = get_compute_config()
    return {
        "cpu_count": cfg.cpu_count,
        "backtest_workers": cfg.backtest_workers,
        "research_workers": cfg.research_workers,
        "torch_num_threads": cfg.torch_num_threads,
        "use_cuda": cfg.use_cuda,
        "device": cfg.device_str,
        "cuda_device_count": cfg.cuda_device_count,
        "cuda_devices": cfg.cuda_devices,
        "use_multi_gpu": cfg.use_multi_gpu,
        "tf32": cfg.enable_tf32,
        "dataloader_workers": cfg.dataloader_workers,
        "pin_memory": cfg.pin_memory,
        "shadow_workers": _DEFAULT_SHADOW_WORKERS,
    }

CHECKPOINT_DIR = Path(os.environ.get("CICADA_NN_CHECKPOINTS", "checkpoints"))
STORAGE = StorageService(CHECKPOINT_DIR)
SHADOW_REGISTRY = ShadowRegistry(CHECKPOINT_DIR)

# Background-job executor for shadow training. Bounded so a flood of
# retrain requests can't exhaust the machine.
_DEFAULT_SHADOW_WORKERS = max(1, int(os.environ.get("CICADA_SHADOW_WORKERS", "2")))
import concurrent.futures as _cf_mod  # late import to keep top short

SHADOW_EXECUTOR = _cf_mod.ThreadPoolExecutor(
    max_workers=_DEFAULT_SHADOW_WORKERS,
    thread_name_prefix="cicada-shadow",
)


class BacktestResultItem(BaseModel):
    instrumentId: str
    strategyId: str
    strategyParams: dict[str, float] | None = None  # e.g. {"period": 14, "overbought": 70}
    timeframe: str
    regime: str
    winRate: float
    profit: float
    trades: int = 0
    maxDrawdown: float = 0.0
    profitFactor: float = 1.0
    sharpeRatio: float = 0.0
    sortinoRatio: float = 0.0
    dataEndTime: str | None = None  # ISO; used to avoid training data leakage


class BarItem(BaseModel):
    open: float
    high: float
    low: float
    close: float
    time: int | None = None


class BuildRequest(BaseModel):
    """Request to build (train) a bot from backtest results."""
    results: list[BacktestResultItem]
    instrument_types: dict[str, str] = {}  # instrumentId -> "fiat" | "crypto" | "synthetic_deriv" | "indices_exness"
    epochs: int = 50
    lr: float = 1e-3
    validation_results: list[BacktestResultItem] | None = None  # OOS validation rows (not used for training)
    bars: dict[str, list[BarItem]] | None = None  # "instrumentId|timeframe" -> OHLCV bars for detection training


class BuildResponse(BaseModel):
    success: bool
    message: str
    checkpoint_path: str | None = None
    feature_vector: list[float] | None = None  # 256-dim for first instrument; use for /predict with regime/timeframe
    oos_accuracy: float | None = None  # Out-of-sample accuracy on validation set (0–1)
    oos_sample_count: int | None = None  # Number of validation samples used
    detection_timeframe: str | None = None  # When detection model: timeframe NN was trained on (for bar fetch at predict)
    detection_bar_window: int | None = None  # When detection model: bar window size (for bar_window at predict)
    detection_models: dict[str, dict] | None = None  # timeframe -> detection model metadata


class ClosedTradeItem(BaseModel):
    """Closed trade for dynamic feature blending."""
    pnl: float
    # Optional: strategyId, timeframe, regime for per-strategy live stats (future)


# Scope → style index for NN output heads. Aligns with trade modes: scalp, day, swing, position.
# NN has 5 heads; we use 0–3 for scope, 4 for sniper (precision). Frontend maps scope → index.
SCOPE_TO_STYLE_INDEX: dict[str, int] = {
    "scalp": 0,
    "day": 1,
    "swing": 2,
    "position": 3,
}


class PredictRequest(BaseModel):
    """Request for NN action prediction with current regime and timeframe (so model is regime-aware)."""
    instrument_id: str  # Which instrument's model to load (one instrument = one model)
    feature_vector: list[float]  # 256-dim from build response (or blended with closed_trades)
    instrument_type: str  # "fiat" | "crypto" | "synthetic_deriv" | "indices_exness"
    regime: str  # e.g. "trending_bull", "ranging", "unknown"
    timeframe: str  # e.g. "M5", "H1"
    scope: str | None = None  # Optional: scalp/day/swing/position. When set, used for style_index (else derived from timeframe)
    closed_trades: list[ClosedTradeItem] | None = None  # Optional: blend live performance into features
    volatility_pct: float | None = None  # Optional: real-time volatility for context
    regime_confidence: float | None = None  # Optional: regime detection confidence (also gates multiple positions per instrument)
    bar_window: list[BarItem] | None = None  # Optional: last N OHLC bars for detection model (when trained on bars)


class PredictResponse(BaseModel):
    actions: list[int]  # one per style (5): 0=long, 1=short, 2=neutral
    style_names: list[str] = ["scalp", "day", "swing", "position", "sniper"]  # Trade modes; head 4 = sniper (precision)
    confidence: float = 0.5  # softmax prob of chosen action
    size_multiplier: float = 1.0  # 0.5-2
    sl_pct: float = 0.02  # stop loss as fraction
    tp_r: float = 2.0  # take profit as risk-reward ratio
    strategy_idx: int | None = None  # Selected strategy index
    strategy_id: str | None = None  # Selected strategy id (e.g. cp-fib-retracement)
    # Safety flags so the daemon can refuse to act on degenerate models.
    safe_to_use: bool = True
    val_accuracy: float | None = None
    inversion_score: float | None = None
    warning: str | None = None


def _load_detection_predictor(det_path: Path) -> dict[str, Any]:
    """Load and cache the bar-level detection model for low-latency live ticks."""
    key = str(det_path)
    mtime = det_path.stat().st_mtime_ns
    with _MODEL_CACHE_LOCK:
        cached = _DETECTION_MODEL_CACHE.get(key)
        if cached and cached.get("mtime") == mtime:
            return cached

    from .train_detection import StrategyDetectionMLPLegacy
    from .model import build_detection_model_from_checkpoint

    ckpt = torch.load(det_path, map_location=DEVICE, weights_only=True)
    meta = ckpt.get("meta", {})
    model_version = int(ckpt.get("model_version") or meta.get("model_version") or 0)
    if model_version >= 3:
        model = build_detection_model_from_checkpoint(ckpt).to(DEVICE)
    else:
        bar_window = int(meta.get("bar_window", 60))
        dim = int(meta.get("bar_feature_dim", bar_window * 4))
        model = StrategyDetectionMLPLegacy(input_dim=dim).to(DEVICE)
    model.load_state_dict(ckpt["model_state"], strict=True)
    model.eval()

    loaded = {"mtime": mtime, "checkpoint": ckpt, "meta": meta, "model": model, "model_version": model_version}
    with _MODEL_CACHE_LOCK:
        _DETECTION_MODEL_CACHE[key] = loaded
    return loaded


def _load_tabular_predictor(pt_path: Path, meta_path: Path) -> dict[str, Any]:
    """Load and cache the tabular bot model; invalidates when checkpoint/meta changes."""
    key = str(pt_path)
    pt_mtime = pt_path.stat().st_mtime_ns
    meta_mtime = meta_path.stat().st_mtime_ns if meta_path.exists() else 0
    with _MODEL_CACHE_LOCK:
        cached = _TABULAR_MODEL_CACHE.get(key)
        if cached and cached.get("pt_mtime") == pt_mtime and cached.get("meta_mtime") == meta_mtime:
            return cached

    checkpoint = torch.load(pt_path, map_location=DEVICE, weights_only=True)
    from .model import build_model_from_checkpoint

    model = build_model_from_checkpoint(checkpoint).to(DEVICE)
    state = checkpoint["model_state"]
    model.load_state_dict(state, strict=False)
    model.eval()
    meta: dict[str, Any] = {}
    if meta_path.exists():
        with open(meta_path) as mf:
            meta = json.load(mf)
    model_version = checkpoint.get("model_version", 1)
    has_regression = model_version >= 2 or any(k.startswith("regression_head.") for k in state.keys())

    loaded = {
        "pt_mtime": pt_mtime,
        "meta_mtime": meta_mtime,
        "checkpoint": checkpoint,
        "state": state,
        "model": model,
        "meta": meta,
        "model_version": model_version,
        "has_regression": has_regression,
    }
    with _MODEL_CACHE_LOCK:
        _TABULAR_MODEL_CACHE[key] = loaded
    return loaded


@app.get("/")
def root():
    """Root endpoint — API info."""
    return {"service": "cicada-nn", "status": "ok", "docs": "/docs", "health": "/health"}


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    """Avoid 404 when browser requests favicon."""
    from fastapi.responses import Response
    return Response(status_code=204)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "cicada-nn",
        "device": str(DEVICE),
        "cuda_available": torch.cuda.is_available(),
        "cuda_device_count": torch.cuda.device_count() if torch.cuda.is_available() else 0,
    }


@app.post("/build", response_model=BuildResponse, dependencies=[Depends(require_api_key)])
def build_bot(req: BuildRequest):
    """Train the instrument bot NN on provided backtest results. When bars are provided, trains detection model (NN recognizes strategy patterns)."""
    if not req.results:
        raise HTTPException(status_code=400, detail="results cannot be empty")
    rows = [r.model_dump() for r in req.results]
    result_instrument_ids = {r.get("instrumentId") for r in rows if r.get("instrumentId")}
    missing = result_instrument_ids - set(req.instrument_types or {})
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"instrument_types must include every instrument in results. Missing: {sorted(missing)}",
        )
    instrument_id = rows[0].get("instrumentId", "default") if rows else "default"

    detection_error: str | None = None
    # Detection mode: bars provided -> try NN signal recognition from price data.
    # If detection prep rejects rows (e.g. no qualifying configs), gracefully fall back
    # to tabular training so bot build still succeeds.
    if req.bars and len(req.bars) > 0:
        bars_by_key = {}
        for k, bar_list in req.bars.items():
            bars_by_key[k] = [b.model_dump() if hasattr(b, "model_dump") else dict(b) for b in bar_list]
        from .train_detection import train_detection
        detection_models: dict[str, dict] = {}
        detection_errors: list[str] = []
        for key in sorted(bars_by_key.keys()):
            try:
                key_inst, key_tf = key.split("|", 1)
            except ValueError:
                continue
            if key_inst != instrument_id:
                continue
            rows_for_tf = [
                r for r in rows
                if r.get("instrumentId") == key_inst and str(r.get("timeframe") or "").upper() == key_tf.upper()
            ] or [r for r in rows if r.get("instrumentId") == key_inst]
            if not rows_for_tf:
                continue
            suffix = f"__{_safe_instrument_id(key_tf.upper())}"
            try:
                det_path, det_meta = train_detection(
                    bars_by_key, rows_for_tf, instrument_id,
                    output_dir=str(CHECKPOINT_DIR), epochs=min(30, req.epochs), lr=req.lr,
                    checkpoint_suffix=suffix,
                )
                tf = str(det_meta.get("timeframe") or key_tf).upper()
                detection_models[tf] = {
                    "timeframe": tf,
                    "scope": det_meta.get("scope"),
                    "bar_window": det_meta.get("bar_window"),
                    "checkpoint_path": det_path,
                    "val_accuracy": det_meta.get("val_accuracy"),
                    "num_samples": det_meta.get("num_samples"),
                    "strategy_id": det_meta.get("strategy_id"),
                    "model_version": 3,
                }
            except Exception as e:
                detection_errors.append(f"{key}: {e}")
        if detection_models:
            manifest_path = CHECKPOINT_DIR / f"instrument_detection_{_safe_instrument_id(instrument_id)}_manifest.json"
            with open(manifest_path, "w") as mf:
                json.dump({
                    "instrument_id": instrument_id,
                    "trained_at_iso": datetime.now(timezone.utc).isoformat(),
                    "models": detection_models,
                }, mf, indent=2)
            first_tf = sorted(detection_models.keys())[0]
            first = detection_models[first_tf]
            feat_dim = 64
            feature_vector = [0.0] * feat_dim
            return BuildResponse(
                success=True,
                message=f"Detection models trained for {len(detection_models)} timeframe(s)"
                    + (f" ({len(detection_errors)} skipped)" if detection_errors else ""),
                checkpoint_path=first.get("checkpoint_path"),
                feature_vector=feature_vector,
                oos_accuracy=None,
                oos_sample_count=first.get("num_samples"),
                detection_timeframe=first.get("timeframe"),
                detection_bar_window=first.get("bar_window"),
                detection_models=detection_models,
            )
        if detection_errors:
            detection_error = "; ".join(detection_errors[:3])

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(rows, f)
        path = f.name
    try:
        val_rows = [r.model_dump() for r in req.validation_results] if req.validation_results else None
        checkpoint_path, oos_metrics = train(
            backtest_json_path=path,
            instrument_types_json=req.instrument_types,
            output_dir=str(CHECKPOINT_DIR),
            instrument_id=instrument_id,
            epochs=req.epochs,
            lr=req.lr,
            validation_rows=val_rows,
        )
        feature_vector = None
        safe_id = _safe_instrument_id(instrument_id)
        meta_path = CHECKPOINT_DIR / f"instrument_bot_nn_{safe_id}_meta.json"
        if meta_path.exists():
            with open(meta_path) as mf:
                meta = json.load(mf)
            s2i = meta.get("strategy_id_to_idx") or {}
            t2i = meta.get("timeframe_to_idx") or {}
            r2i = meta.get("regime_to_idx") or {}
            feat_dim = meta.get("strategy_feature_dim", 256)
            if s2i and t2i and r2i:
                feats, _ = backtest_rows_to_features(rows, s2i, t2i, r2i)
                if feats.size > 0:
                    vec = feats[0]
                    if vec.size < feat_dim:
                        vec = np.pad(vec, (0, feat_dim - vec.size), mode="constant", constant_values=0)
                    else:
                        vec = vec[:feat_dim]
                    feature_vector = vec.astype(float).tolist()
        return BuildResponse(
            success=True,
            message=("Model trained" if not detection_error else f"Model trained (detection skipped: {detection_error})"),
            checkpoint_path=checkpoint_path,
            feature_vector=feature_vector,
            oos_accuracy=oos_metrics.get("oos_accuracy"),
            oos_sample_count=oos_metrics.get("oos_sample_count"),
        )
    except Exception as e:
        return BuildResponse(success=False, message=str(e), checkpoint_path=None)
    finally:
        os.unlink(path)


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest):
    """
    Run NN inference with current regime and timeframe one-hot so decisions are regime-aware.
    When detection model exists and bar_window provided, uses bar-level detection (NN recognizes strategy).
    """
    safe_id = _safe_instrument_id(req.instrument_id)
    det_path = CHECKPOINT_DIR / f"instrument_detection_{safe_id}.pt"
    manifest_path = CHECKPOINT_DIR / f"instrument_detection_{safe_id}_manifest.json"
    if manifest_path.exists():
        try:
            with open(manifest_path) as mf:
                manifest = json.load(mf)
            model_info = (manifest.get("models") or {}).get(str(req.timeframe).upper())
            model_path = model_info.get("checkpoint_path") if isinstance(model_info, dict) else None
            if model_path:
                candidate = Path(model_path)
                if not candidate.exists() and not candidate.is_absolute():
                    candidate = CHECKPOINT_DIR / candidate.name
                if candidate.exists():
                    det_path = candidate
        except Exception:
            logger.debug("failed to resolve detection manifest for %s", req.instrument_id, exc_info=True)
    detection_skip_detail: str | None = None

    # Detection mode: bar-level model consumes raw bars and predicts future direction.
    if det_path.exists():
        from .train_detection import bars_to_features
        from .bar_features import BarFeatureConfig, window_features

        predictor = _load_detection_predictor(det_path)
        ckpt = predictor["checkpoint"]
        meta = predictor["meta"]
        model = predictor["model"]
        bar_window = meta.get("bar_window", 60)
        if not req.bar_window or len(req.bar_window) < bar_window:
            detection_skip_detail = (
                f"Detection model requires bar_window with at least {bar_window} bars. "
                f"Got {len(req.bar_window or [])}."
            )
        else:
            try:
                bars = [b.model_dump() if hasattr(b, "model_dump") else dict(b) for b in req.bar_window]
                model_version = int(ckpt.get("model_version") or meta.get("model_version") or 0)

                if model_version >= 3:
                    # V3: scale-invariant features + conv/attention tower with
                    # calibration & MC-dropout uncertainty.
                    ctx_dims = int(meta.get("context_features", 4))
                    feat_cfg = BarFeatureConfig(
                        window=bar_window, include_context=ctx_dims > 0
                    )
                    feat = window_features(bars, len(bars) - 1, feat_cfg)
                    x = torch.from_numpy(feat.astype(np.float32)).unsqueeze(0).to(DEVICE)
                    with _MODEL_CACHE_LOCK:
                        with torch.no_grad():
                            logits, reg = model.forward_with_regression(x)
                            probs = torch.softmax(logits, dim=1)
                            pred = int(logits.argmax(dim=1).item())
                            conf = float(probs[0, pred].item())
                            raw = reg[0].detach().cpu().numpy()
                        # MC-dropout uncertainty is useful, but live ticks must
                        # stay responsive. Keep this sample count small and
                        # configurable instead of doing 16 passes every tick.
                        if _DETECTION_MC_SAMPLES > 0:
                            try:
                                model.train()
                                mean_probs, entropy = model.forward_mc(x, samples=_DETECTION_MC_SAMPLES)
                                model.eval()
                                # Penalise confidence when predictive entropy is high.
                                entropy_pct = float(entropy[0].item()) / float(np.log(3))
                                conf = float(
                                    np.clip(conf * (1.0 - 0.5 * entropy_pct), 0.05, 0.99)
                                )
                            except Exception:
                                model.eval()
                                pass  # MC dropout is best-effort; keep raw conf.

                    # V3 labels: 0=short, 1=long, 2=neutral (mirrors labeling.py).
                    # Map to response actions: 0=long, 1=short, 2=neutral.
                    action = 1 if pred == 0 else (0 if pred == 1 else 2)

                    # ── Safety floor on per-TF detection model ──────────────
                    # When the trained model failed to clear the random-baseline
                    # promotion floor we *do not* let it trade. The action is
                    # forced to NEUTRAL and ``safe_to_use=False`` is returned so
                    # the daemon can short-circuit and surface a warning. This
                    # is the gate that catches the "val_acc=0.7%" failure mode
                    # the operator hit in production.
                    safe_flag = bool(meta.get("safe_to_use", True))
                    val_acc = meta.get("val_accuracy")
                    inversion = meta.get("inversion_score")
                    warning_msg: str | None = None
                    if not safe_flag:
                        warning_msg = (
                            f"Model rejected: val_accuracy={val_acc} below promotion floor "
                            f"{meta.get('promotion_floor')}. Re-train this bot before trading."
                        )
                        action = 2  # neutral

                    actions_list = [action] * 5
                    size_mult = float(0.5 + 1.5 * raw[0])
                    sl_pct = float(0.01 + 0.04 * raw[1])
                    tp_r = float(1.0 + 2.0 * raw[2])
                    strategy_id = meta.get("strategy_id")
                    return PredictResponse(
                        actions=actions_list,
                        confidence=round(conf, 4),
                        size_multiplier=round(size_mult, 4),
                        sl_pct=round(sl_pct, 4),
                        tp_r=round(tp_r, 4),
                        strategy_idx=0,
                        strategy_id=strategy_id,
                        safe_to_use=safe_flag,
                        val_accuracy=val_acc,
                        inversion_score=inversion,
                        warning=warning_msg,
                    )

                # Legacy MLP detection (model_version < 3): keep loading for
                # previously-trained checkpoints.
                feat = bars_to_features(bars, len(bars) - 1, bar_window)
                x = torch.from_numpy(feat.astype(np.float32)).unsqueeze(0).to(DEVICE)
                with _MODEL_CACHE_LOCK:
                    with torch.no_grad():
                        logits = model(x)
                        probs = torch.softmax(logits, dim=1)
                        pred = int(logits.argmax(dim=1).item())
                        conf = float(probs[0, pred].item())
                # Legacy labels: 0=neutral, 1=short, 2=long -> actions: 0=long, 1=short, 2=neutral.
                action = 2 if pred == 0 else (1 if pred == 1 else 0)
                actions_list = [action] * 5
                strategy_id = meta.get("strategy_id")
                return PredictResponse(
                    actions=actions_list,
                    confidence=round(conf, 4),
                    size_multiplier=1.0,
                    sl_pct=0.02,
                    tp_r=2.0,
                    strategy_idx=0,
                    strategy_id=strategy_id,
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Detection inference failed: {e}") from e

    if not req.feature_vector or len(req.feature_vector) == 0:
        raise HTTPException(status_code=400, detail="feature_vector is required and must be non-empty")
    pt_path = CHECKPOINT_DIR / f"instrument_bot_nn_{safe_id}.pt"
    meta_path = CHECKPOINT_DIR / f"instrument_bot_nn_{safe_id}_meta.json"
    if not pt_path.exists():
        if detection_skip_detail is not None:
            raise HTTPException(status_code=400, detail=detection_skip_detail)
        raise HTTPException(
            status_code=503,
            detail=f"No model for instrument {req.instrument_id}. Build that instrument's bot first.",
        )
    try:
        predictor = _load_tabular_predictor(pt_path, meta_path)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Checkpoint load failed: {e}") from e
    checkpoint = predictor["checkpoint"]
    model = predictor["model"]
    has_regression = bool(predictor["has_regression"])
    meta = predictor["meta"]

    # Regime and timeframe one-hot from saved mappings (same order as training)
    regime_idx = 0
    timeframe_idx = 0
    strategy_ids: list[str] = []
    if meta:
        r2i = meta.get("regime_to_idx") or {}
        t2i = meta.get("timeframe_to_idx") or {}
        regime_idx = r2i.get(req.regime, r2i.get("unknown", 0))
        timeframe_idx = t2i.get(req.timeframe, 0)
        strategy_ids = meta.get("strategy_ids") or []

    regime_onehot = np.zeros(NUM_REGIMES, dtype=np.float32)
    if regime_idx < NUM_REGIMES:
        regime_onehot[regime_idx] = 1.0
    # Regime one-hot is never scaled at serve time. Training always saw
    # {0,1}-valued one-hots, so scaling here used to introduce a silent
    # train-serve mismatch that degraded inference. We honour regime_confidence
    # elsewhere (feature blending and post-hoc confidence adjustment) instead.

    timeframe_onehot = np.zeros(NUM_TIMEFRAMES, dtype=np.float32)
    if timeframe_idx < NUM_TIMEFRAMES:
        timeframe_onehot[timeframe_idx] = 1.0

    feat_dim = checkpoint.get("strategy_feature_dim", 256)
    vec = np.array(req.feature_vector, dtype=np.float32)
    if vec.size != feat_dim:
        if vec.size < feat_dim:
            vec = np.pad(vec, (0, feat_dim - vec.size), mode="constant", constant_values=0)
        else:
            vec = vec[:feat_dim]

    # Dynamic features: blend live performance from closed_trades
    num_strategies = len(strategy_ids)
    if req.closed_trades and len(req.closed_trades) >= 3 and num_strategies > 0:
        trades = req.closed_trades[-50:]
        n = len(trades)
        wins = sum(1 for t in trades if t.pnl > 0)
        live_win = wins / n
        total_pnl = sum(t.pnl for t in trades)
        live_profit = np.tanh(total_pnl / 1000.0)
        alpha = min(0.4, n / 50 * 0.4)
        vec[0] = (1 - alpha) * vec[0] + alpha * live_win
        if vec.size > num_strategies:
            vec[num_strategies] = (1 - alpha) * vec[num_strategies] + alpha * live_profit

    # Real-time context: blend volatility when provided
    if req.volatility_pct is not None and vec.size >= 3:
        vol_norm = np.tanh(req.volatility_pct / 10.0)
        vec[2] = 0.7 * vec[2] + 0.3 * vol_norm

    inst_idx = instrument_type_to_idx(req.instrument_type)

    x = torch.from_numpy(vec).unsqueeze(0).to(DEVICE)
    inst = torch.tensor([inst_idx], dtype=torch.long, device=DEVICE)
    reg = torch.from_numpy(regime_onehot).unsqueeze(0).to(DEVICE)
    tf = torch.from_numpy(timeframe_onehot).unsqueeze(0).to(DEVICE)

    # Style index: scope → NN output head. Use req.scope when provided, else derive from timeframe.
    from .backtest_server import TF_TO_SCOPE
    scope = req.scope or TF_TO_SCOPE.get(req.timeframe.upper(), "day")
    style_index = min(SCOPE_TO_STYLE_INDEX.get(scope, timeframe_idx % 4), 4)

    strategy_idx: int | None = None
    strategy_id: str | None = None
    try:
        with torch.no_grad():
            if has_regression:
                result = model.predict_with_params(
                    x, inst, regime_onehot=reg, timeframe_onehot=tf, style_index=style_index
                )
                if len(result) == 6:
                    actions, confidence, size_mult, sl_pct, tp_r, strategy_idx = result
                else:
                    actions, confidence, size_mult, sl_pct, tp_r = result
                actions_list = actions[0].tolist()
                if strategy_idx is not None and 0 <= strategy_idx < len(strategy_ids):
                    strategy_id = strategy_ids[strategy_idx]
                # Downweight confidence when the regime detector is unsure.
                # We do this *after* the network runs, so training stays honest.
                if req.regime_confidence is not None and 0.0 < req.regime_confidence < 1.0:
                    confidence = float(np.clip(confidence * req.regime_confidence, 0.0, 1.0))
                return PredictResponse(
                    actions=actions_list,
                    confidence=round(confidence, 4),
                    size_multiplier=round(size_mult, 4),
                    sl_pct=round(sl_pct, 4),
                    tp_r=round(tp_r, 4),
                    strategy_idx=strategy_idx,
                    strategy_id=strategy_id,
                )
            actions = model.predict_actions(x, inst, regime_onehot=reg, timeframe_onehot=tf)
            actions_list = actions[0].tolist()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference failed: {e}") from e
    return PredictResponse(actions=actions_list)


# ---------- Shadow training + hot-swap ----------
#
# The frontend kicks off a retrain while the bot is still executing: training
# runs in a thread-pool, writes to a shadow checkpoint, and only after passing
# the promotion gate is the live checkpoint atomically replaced. Execution
# picks up the new model on the next /predict call without any downtime.

class ShadowTrainRequest(BaseModel):
    """Request to start a shadow-training job for a deployed bot."""
    instrument_id: str
    results: list[BacktestResultItem]
    instrument_types: dict[str, str] = {}
    epochs: int = 30
    lr: float = 1e-3
    # "tabular" (meta-selector) or "detection" (bar-window direction model).
    kind: str = "detection"
    # Bars required for detection kind; key "instrumentId|timeframe" -> bars.
    bars: dict[str, list[BarItem]] | None = None


class ShadowTrainResponse(BaseModel):
    job_id: str
    status: str
    instrument_id: str
    kind: str
    message: str | None = None


class ShadowPromoteRequest(BaseModel):
    job_id: str
    # Optional gate overrides per-instrument; values are clamped server-side.
    min_oos_accuracy: float | None = None
    accuracy_tolerance: float | None = None
    warmup_seconds: float | None = None


def _run_shadow_job_async(
    kind: str,
    instrument_id: str,
    rows: list[dict],
    instrument_types: dict[str, str],
    bars_by_key: dict[str, list[dict]] | None,
    epochs: int,
    lr: float,
) -> None:
    """Runs inside the ThreadPoolExecutor; exceptions are recorded in the registry."""
    try:
        if kind == "detection":
            if not bars_by_key:
                raise ValueError("Detection shadow training requires bars")
            shadow_train_detection(
                registry=SHADOW_REGISTRY,
                checkpoint_dir=CHECKPOINT_DIR,
                instrument_id=instrument_id,
                bars_by_key=bars_by_key,
                rows=rows,
                epochs=epochs,
                lr=lr,
            )
        else:
            shadow_train_tabular(
                registry=SHADOW_REGISTRY,
                checkpoint_dir=CHECKPOINT_DIR,
                instrument_id=instrument_id,
                rows=rows,
                instrument_types=instrument_types,
                epochs=epochs,
                lr=lr,
            )
    except Exception:
        # start_shadow_training already records the failure on the registry.
        logger.exception("shadow job background failure")


@app.post("/shadow/train", response_model=ShadowTrainResponse, dependencies=[Depends(require_api_key)])
def shadow_train(req: ShadowTrainRequest):
    """Kick off a shadow training job; returns immediately with a job id."""
    rows = [r.model_dump() for r in req.results]
    if not rows:
        raise HTTPException(status_code=400, detail="results must be non-empty")
    bars_by_key: dict[str, list[dict]] | None = None
    if req.bars:
        bars_by_key = {
            k: [b.model_dump() for b in v] for k, v in req.bars.items()
        }
    # Seed a 'queued' row so the UI can display immediately even before the
    # worker picks up the job.
    from .shadow_training import ShadowJobState
    seed = ShadowJobState(
        job_id=f"shadow-{req.instrument_id}-{int(__import__('datetime').datetime.now(__import__('datetime').timezone.utc).timestamp())}",
        instrument_id=req.instrument_id,
        kind=req.kind,
        status="queued",
        started_at=__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat().replace("+00:00", "Z"),
    )
    SHADOW_REGISTRY.upsert(seed)
    SHADOW_EXECUTOR.submit(
        _run_shadow_job_async,
        req.kind,
        req.instrument_id,
        rows,
        req.instrument_types,
        bars_by_key,
        req.epochs,
        req.lr,
    )
    return ShadowTrainResponse(
        job_id=seed.job_id,
        status=seed.status,
        instrument_id=seed.instrument_id,
        kind=seed.kind,
        message="queued",
    )


@app.get("/shadow/jobs")
def shadow_jobs(instrument_id: str | None = None):
    """List shadow training jobs (optionally filtered to one instrument)."""
    return {"jobs": SHADOW_REGISTRY.list_jobs(instrument_id)}


@app.post("/shadow/promote", dependencies=[Depends(require_api_key)])
def shadow_promote(req: ShadowPromoteRequest):
    """Apply safety gates and atomically promote a shadow checkpoint."""
    job = SHADOW_REGISTRY.get(req.job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown job_id")
    gate = PromotionGate(
        min_oos_accuracy=req.min_oos_accuracy if req.min_oos_accuracy is not None else 0.40,
        accuracy_tolerance=req.accuracy_tolerance if req.accuracy_tolerance is not None else 0.02,
        warmup_seconds=req.warmup_seconds if req.warmup_seconds is not None else 60.0,
    )
    ok, reason = can_promote_shadow(job, gate=gate)
    if not ok:
        return {"promoted": False, "reason": reason}
    ok, reason = promote_shadow_atomically(CHECKPOINT_DIR, job["instrument_id"], job["kind"])
    if not ok:
        return {"promoted": False, "reason": reason}
    # Reflect promotion in registry for the UI.
    from .shadow_training import ShadowJobState
    promoted = ShadowJobState(
        job_id=job["job_id"],
        instrument_id=job["instrument_id"],
        kind=job["kind"],
        status="promoted",
        started_at=job["started_at"],
        finished_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z") if False else job.get("finished_at"),
        oos_accuracy=job.get("oos_accuracy"),
        parent_oos_accuracy=job.get("parent_oos_accuracy"),
        message="promoted",
    )
    SHADOW_REGISTRY.upsert(promoted)
    return {"promoted": True, "reason": reason, "job_id": job["job_id"]}


@app.post("/shadow/abort", dependencies=[Depends(require_api_key)])
def shadow_abort(req: ShadowPromoteRequest):
    """Abort a shadow job; removes artefacts and marks the record."""
    job = SHADOW_REGISTRY.get(req.job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown job_id")
    abort_shadow(CHECKPOINT_DIR, job["instrument_id"], job["kind"])
    from .shadow_training import ShadowJobState
    aborted = ShadowJobState(
        job_id=job["job_id"],
        instrument_id=job["instrument_id"],
        kind=job["kind"],
        status="aborted",
        started_at=job["started_at"],
        finished_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z") if False else job.get("finished_at"),
        message="aborted via API",
    )
    SHADOW_REGISTRY.upsert(aborted)
    return {"aborted": True, "job_id": job["job_id"]}


# ---------- Bots: persist bot configs for restore across sessions/devices ----------

def _load_bots() -> list[dict]:
    """Load bots from storage."""
    data = STORAGE.bots.read()
    return data if isinstance(data, list) else []


def _save_bots(bots: list[dict]) -> None:
    """Persist bots to storage."""
    STORAGE.bots.write(bots)


@app.get("/bots")
def get_bots():
    """Fetch persisted bot configs. Used by frontend on load to restore bots across sessions."""
    return {"bots": _load_bots()}


@app.post("/bots", dependencies=[Depends(require_api_key)])
def post_bots(bots: list[dict] = Body(...)):
    """Save bot configs. Called by frontend after build/deploy/update so bots persist on backend."""
    if not isinstance(bots, list):
        raise HTTPException(status_code=400, detail="bots must be a list")
    _save_bots(bots)
    return {"saved": len(bots)}


# ---------- Portfolio positions: persist open positions + closed trades for full restore ----------

def _load_positions() -> dict:
    """Load positions, closed trades, balance, and P/L from storage."""
    data = STORAGE.positions.read()
    if not isinstance(data, dict):
        data = {}
    out = {
        "positions": data.get("positions", []) if isinstance(data.get("positions"), list) else [],
        "closedTradesByBot": data.get("closedTradesByBot", {}) if isinstance(data.get("closedTradesByBot"), dict) else {},
    }
    if "balance" in data and data["balance"] is not None:
        out["balance"] = float(data["balance"])
    if "peakEquity" in data and data["peakEquity"] is not None:
        out["peakEquity"] = float(data["peakEquity"])
    if "totalPnl" in data and data["totalPnl"] is not None:
        out["totalPnl"] = float(data["totalPnl"])
    if "totalPnlPercent" in data and data["totalPnlPercent"] is not None:
        out["totalPnlPercent"] = float(data["totalPnlPercent"])
    if "realizedPnl" in data and data["realizedPnl"] is not None:
        out["realizedPnl"] = float(data["realizedPnl"])
    return out


def _save_positions(payload: dict) -> None:
    """Persist positions, closed trades, balance, and P/L."""
    to_save = {
        "positions": payload.get("positions", []),
        "closedTradesByBot": payload.get("closedTradesByBot", {}),
    }
    for key in ("balance", "peakEquity", "totalPnl", "totalPnlPercent", "realizedPnl"):
        if key in payload and payload[key] is not None:
            to_save[key] = payload[key]
    STORAGE.positions.write(to_save)


def _load_app_state() -> dict:
    """Load full frontend app state snapshot from storage."""
    data = STORAGE.app_state.read()
    return data if isinstance(data, dict) else {}


def _save_app_state(payload: dict) -> None:
    """Persist full frontend app state snapshot (large backtest/research results included)."""
    STORAGE.app_state.write(payload)


@app.get("/positions")
def get_positions():
    """Fetch persisted positions and closed trades. Used by frontend on load for full restore."""
    return _load_positions()


@app.post("/positions", dependencies=[Depends(require_api_key)])
def post_positions(payload: dict = Body(...)):
    """Save positions, closed trades, balance, and P/L. Called by frontend on persist for backend backup."""
    positions = payload.get("positions", [])
    closed_trades = payload.get("closedTradesByBot", {})
    if not isinstance(positions, list):
        raise HTTPException(status_code=400, detail="positions must be a list")
    if not isinstance(closed_trades, dict):
        raise HTTPException(status_code=400, detail="closedTradesByBot must be an object")
    _save_positions(payload)
    return {"saved": len(positions), "closedBots": len(closed_trades)}


@app.get("/state")
def get_state():
    """Fetch persisted frontend app snapshot (replaces browser localStorage for heavy state)."""
    return {"state": _load_app_state()}


@app.post("/state", dependencies=[Depends(require_api_key)])
def post_state(payload: dict = Body(...)):
    """Save frontend app snapshot to backend filesystem."""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="state payload must be an object")
    _save_app_state(payload)
    return {"saved": True, "keys": len(payload.keys())}


@app.get("/settings")
def get_settings():
    """Fetch backend settings object (used to avoid browser localStorage)."""
    data = STORAGE.settings.read()
    return {"settings": data if isinstance(data, dict) else {}}


@app.post("/settings", dependencies=[Depends(require_api_key)])
def post_settings(payload: dict = Body(...)):
    """Save backend settings object (used to avoid browser localStorage)."""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="settings payload must be an object")
    STORAGE.settings.write(payload)
    return {"saved": True, "keys": len(payload.keys())}


# ---------- Execution log: persist bot execution events for lookback/audit ----------

EXECUTION_LOG_MAX = 500


class ExecutionLogEvent(BaseModel):
    id: str
    timestamp: str
    botId: str
    symbol: str
    phase: str
    outcome: str
    message: str
    details: dict | None = None


class ExecutionLogAppendRequest(BaseModel):
    events: list[ExecutionLogEvent]


def _load_execution_log() -> list[dict]:
    data = STORAGE.execution_log.read()
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        events = data.get("events", [])
        return events if isinstance(events, list) else []
    return []


def _save_execution_log(events: list[dict]) -> None:
    STORAGE.execution_log.write(events[-EXECUTION_LOG_MAX:])


@app.post("/execution-log/append", dependencies=[Depends(require_api_key)])
def execution_log_append(req: ExecutionLogAppendRequest):
    """Append bot execution events. Used by frontend to persist lookback data."""
    if not req.events:
        return {"appended": 0, "total": len(_load_execution_log())}
    events = _load_execution_log()
    for e in req.events:
        events.append(e.model_dump())
    _save_execution_log(events)
    return {"appended": len(req.events), "total": len(events)}


@app.get("/execution-log")
def execution_log_get(limit: int = 100, symbol: str | None = None):
    """Fetch recent execution log events. Optional symbol filter."""
    events = _load_execution_log()
    if symbol:
        sym_upper = symbol.upper().replace("/", "")
        events = [e for e in events if (e.get("symbol") or "").upper().replace("/", "") == sym_upper]
    events = events[-limit:][::-1]
    return {"events": events, "count": len(events)}


# ---------- MT5: login credentials connect to MT5 account in backend ----------

class Mt5ConnectRequest(BaseModel):
    """MT5 login credentials (sent from login page)."""
    login: str  # account number
    password: str
    server: str = ""  # broker server name; empty = use default/last


class Mt5ConnectResponse(BaseModel):
    connected: bool
    message: str
    account: dict | None = None  # login, server, balance, currency, etc.


@app.post("/mt5/connect", response_model=Mt5ConnectResponse)
def mt5_connect(req: Mt5ConnectRequest):
    """Connect to MetaTrader 5 with the given account credentials."""
    success, data = mt5_client.connect(
        login=req.login.strip(),
        password=req.password,
        server=req.server.strip() or None,
    )
    if success:
        return Mt5ConnectResponse(connected=True, message="Connected to MT5", account=data)
    return Mt5ConnectResponse(connected=False, message=data.get("error", "Connection failed"), account=None)


@app.get("/mt5/status")
def mt5_status():
    """Return whether the backend is currently connected to MT5.

    Includes structured health: package install, last-error, balance/equity
    snapshot when connected, and ``has_credentials`` so the FE can offer a
    one-click reconnect after a transient drop.
    """
    return {
        "mt5_available": mt5_client.MT5_AVAILABLE,
        "connected": mt5_client.is_connected(),
        **mt5_client.connection_status(),
    }


class Mt5ReconnectResponse(BaseModel):
    connected: bool
    message: str
    account: dict | None = None


@app.post("/mt5/reconnect", response_model=Mt5ReconnectResponse, dependencies=[Depends(require_api_key)])
def mt5_reconnect():
    """Reconnect to MT5 using the credentials cached at the previous /mt5/connect.

    Convenient when the broker drops the link mid-session and the FE doesn't
    want to prompt the user for credentials again. Returns the same shape as
    /mt5/connect.
    """
    success, data = mt5_client.reconnect()
    if success:
        return Mt5ReconnectResponse(connected=True, message="Reconnected to MT5", account=data)
    return Mt5ReconnectResponse(connected=False, message=data.get("error", "Reconnect failed"))


@app.get("/mt5/account")
def mt5_account():
    """Return current account balance/equity if MT5 is connected. No reconnect."""
    if not mt5_client.is_connected():
        return {"connected": False, "account": None}
    info = mt5_client.get_account()
    return {"connected": True, "account": info}


# Full history cap for backtests (MT5 may return fewer depending on broker).
MT5_OHLC_FULL_HISTORY_CAP = 50_000


@app.get("/mt5/ohlc")
def mt5_ohlc(
    symbol: str,
    timeframe: str = "M5",
    count: int = 50_000,
    dateFrom: str = "",
    dateTo: str = "",
):
    """
    Get OHLCV bars from MT5. Requires MT5 connected.
    symbol: MT5 symbol (e.g. EURUSD, BTCUSD).
    timeframe: M1, M5, M15, M30, H1, H4, D1, W1.
    count: Number of bars (default 50k). Ignored when dateFrom/dateTo provided.
    dateFrom, dateTo: Optional YYYY-MM-DD range for backtest (uses copy_rates_range).
    """
    if not mt5_client.is_connected():
        return {"error": "MT5 not connected", "bars": None}
    sym = symbol.replace("/", "").strip().upper()
    if not sym:
        return {"error": "Invalid symbol", "bars": None}
    df = dateFrom.strip() if dateFrom else None
    dt = dateTo.strip() if dateTo else None
    bars = mt5_client.get_rates(
        sym,
        timeframe,
        count=min(count, MT5_OHLC_FULL_HISTORY_CAP),
        date_from=df or None,
        date_to=dt or None,
    )
    if bars is None:
        return {"error": "No data or invalid symbol/timeframe", "bars": None}
    return {"bars": bars, "symbol": sym, "timeframe": timeframe}


class BacktestRunRequest(BaseModel):
    """Request to run backtest on the server (offload). Same shape as frontend BacktestRunRequest."""
    instrumentIds: list[str] = []
    strategyIds: list[str] = []
    timeframes: list[str] = []
    regimes: list[str] = []
    dateFrom: str = ""
    dateTo: str = ""
    instrument_symbols: dict[str, str] = {}  # instrumentId -> MT5 symbol
    strategy_names: dict[str, str] = {}  # strategyId -> display name
    # Optional: bars fetched by client from Deriv/eXness/MT5. Key: "instrumentId|timeframe"
    bars: dict[str, list[dict]] = {}
    # Optional: instrumentId -> spread (points). When set, uses live broker spreads.
    instrument_spreads: dict[str, float] = {}
    # Optional: backtest config overrides (risk, stop, target, regime lookback)
    risk_per_trade_pct: float | None = None
    stop_loss_pct: float | None = None
    take_profit_r: float | None = None
    regime_lookback: int | None = None
    initial_equity: float | None = None
    slippage_pct: float | None = None
    # Optional: instrumentId -> { riskPerTradePct?, stopLossPct?, takeProfitR? }
    instrument_risk_overrides: dict[str, dict[str, float]] | None = None
    # Optional: "instrumentId|strategyId" -> { riskPerTradePct?, stopLossPct?, takeProfitR? } (takes precedence)
    job_risk_overrides: dict[str, dict[str, float]] | None = None
    # Max param combos per strategy (1 = family defaults only; default = iterative sweeps). <=0 = full Cartesian grid (~500k+ for some families).
    param_combos_limit: int = DEFAULT_PARAM_COMBOS_LIMIT
    # Optional: instrumentId -> regimeConfig (from research). Regime detection tuned per instrument from its own behavior.
    regime_tunes: dict[str, dict[str, float]] | None = None
    # None = auto: use HTF-mapped regime when HTF bars present (key instrumentId|HTF); False = LTF regime only.
    prefer_htf_regime: bool | None = None
    # Optional: instrumentId -> instrument type; enables per-type cost model.
    instrument_types: dict[str, str] = {}
    # When true, fan jobs out to a process pool (see compute.py). Falls back
    # to serial when true but the job count is too small to amortise.
    parallel: bool = True
    # Cap worker count for this specific request (0 = use server default).
    workers: int = 0


@app.post("/backtest")
def backtest_run(req: BacktestRunRequest):
    """
    Run backtest on the server. When bars are provided, all required data must exist with sufficient depth;
    otherwise halt with descriptive error. No inference or skip.
    """
    if not req.instrumentIds or not req.strategyIds:
        raise HTTPException(status_code=400, detail="instrumentIds and strategyIds required")
    timeframes = req.timeframes or ["M5", "H1"]
    regimes = req.regimes or ["trending_bull", "trending_bear", "ranging"]
    bars_provided = req.bars or {}

    # When bars are provided: validate all required keys exist with sufficient depth before running
    if bars_provided:
        missing: list[str] = []
        insufficient: list[tuple[str, int]] = []
        for inst_id in req.instrumentIds:
            symbol = (req.instrument_symbols or {}).get(inst_id) or inst_id.replace("inst-", "").replace("-", "").upper()
            if not symbol:
                missing.append(f"{inst_id} (no symbol)")
                continue
            for tf in timeframes:
                key = f"{inst_id}|{tf}"
                bar_list = bars_provided.get(key)
                if not bar_list:
                    missing.append(f"{symbol} {tf}")
                elif len(bar_list) < MIN_BARS_REQUIRED_BACKTEST:
                    insufficient.append((f"{symbol} {tf}", len(bar_list)))
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"Missing bars for {len(missing)} instrument×timeframe(s). Fetch all required data before running. Missing: {', '.join(missing[:5])}{'...' if len(missing) > 5 else ''}. Process halted.",
            )
        if insufficient:
            details = "; ".join(f"{k}: got {n}, need {MIN_BARS_REQUIRED_BACKTEST}" for k, n in insufficient[:5])
            if len(insufficient) > 5:
                details += f"... (+{len(insufficient) - 5} more)"
            raise HTTPException(
                status_code=400,
                detail=f"Insufficient bars: {details}. Process halted.",
            )
    backtest_config = {}
    if req.risk_per_trade_pct is not None:
        backtest_config["risk_per_trade_pct"] = req.risk_per_trade_pct
    if req.stop_loss_pct is not None:
        backtest_config["stop_loss_pct"] = req.stop_loss_pct
    if req.take_profit_r is not None:
        backtest_config["take_profit_r"] = req.take_profit_r
    if req.regime_lookback is not None:
        backtest_config["regime_lookback"] = req.regime_lookback
    if req.initial_equity is not None:
        backtest_config["initial_equity"] = req.initial_equity
    if req.slippage_pct is not None:
        backtest_config["slippage_pct"] = req.slippage_pct

    results = run_server_backtest(
        instrument_ids=req.instrumentIds,
        strategy_ids=req.strategyIds,
        strategy_names=req.strategy_names,
        timeframes=timeframes,
        regimes=regimes,
        instrument_symbols=req.instrument_symbols,
        date_from=req.dateFrom or "",
        date_to=req.dateTo or "",
        bars=req.bars or {},
        instrument_spreads=req.instrument_spreads or {},
        backtest_config=backtest_config or None,
        instrument_risk_overrides=req.instrument_risk_overrides or None,
        job_risk_overrides=getattr(req, "job_risk_overrides", None) or None,
        param_combos_limit=normalize_param_combos_limit(req.param_combos_limit),
        regime_tunes=getattr(req, "regime_tunes", None) or None,
        prefer_htf_regime=getattr(req, "prefer_htf_regime", None),
        instrument_types=getattr(req, "instrument_types", None) or None,
    )
    # Add id for frontend BacktestResultRow
    import uuid
    for r in results:
        r["id"] = f"bt-server-{uuid.uuid4().hex[:12]}"
    return {"results": results, "status": "completed"}


@app.post("/backtest/stream")
def backtest_run_stream(req: BacktestRunRequest):
    """
    Stream backtest progress/results as NDJSON.
    Emits:
      - progress chunks with completed/total
      - row chunks for each completed row
      - done chunk with all results
    """
    if not req.instrumentIds or not req.strategyIds:
        raise HTTPException(status_code=400, detail="instrumentIds and strategyIds required")
    timeframes = req.timeframes or ["M5", "H1"]
    regimes = req.regimes or ["trending_bull", "trending_bear", "ranging"]
    bars_provided = req.bars or {}

    if bars_provided:
        missing: list[str] = []
        insufficient: list[tuple[str, int]] = []
        for inst_id in req.instrumentIds:
            symbol = (req.instrument_symbols or {}).get(inst_id) or inst_id.replace("inst-", "").replace("-", "").upper()
            if not symbol:
                missing.append(f"{inst_id} (no symbol)")
                continue
            for tf in timeframes:
                key = f"{inst_id}|{tf}"
                bar_list = bars_provided.get(key)
                if not bar_list:
                    missing.append(f"{symbol} {tf}")
                elif len(bar_list) < MIN_BARS_REQUIRED_BACKTEST:
                    insufficient.append((f"{symbol} {tf}", len(bar_list)))
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"Missing bars for {len(missing)} instrument×timeframe(s). Fetch all required data before running. Missing: {', '.join(missing[:5])}{'...' if len(missing) > 5 else ''}. Process halted.",
            )
        if insufficient:
            details = "; ".join(f"{k}: got {n}, need {MIN_BARS_REQUIRED_BACKTEST}" for k, n in insufficient[:5])
            if len(insufficient) > 5:
                details += f"... (+{len(insufficient) - 5} more)"
            raise HTTPException(
                status_code=400,
                detail=f"Insufficient bars: {details}. Process halted.",
            )

    backtest_config = {}
    if req.risk_per_trade_pct is not None:
        backtest_config["risk_per_trade_pct"] = req.risk_per_trade_pct
    if req.stop_loss_pct is not None:
        backtest_config["stop_loss_pct"] = req.stop_loss_pct
    if req.take_profit_r is not None:
        backtest_config["take_profit_r"] = req.take_profit_r
    if req.regime_lookback is not None:
        backtest_config["regime_lookback"] = req.regime_lookback
    if req.initial_equity is not None:
        backtest_config["initial_equity"] = req.initial_equity
    if req.slippage_pct is not None:
        backtest_config["slippage_pct"] = req.slippage_pct

    job = JOB_MANAGER.create(
        kind="backtest",
        title=f"backtest {len(req.instrumentIds)}×{len(req.strategyIds)}×{len(timeframes)}×{len(regimes)}",
        meta={
            "instruments": req.instrumentIds,
            "strategies": req.strategyIds,
            "timeframes": timeframes,
            "regimes": regimes,
            "parallel": bool(getattr(req, "parallel", True)),
        },
    )
    JOB_MANAGER.mark_running(job.job_id)

    def generate():
        import uuid
        from .compute import get_compute_config
        from .backtest_parallel import run_backtest_parallel
        results: list[dict] = []
        # Parallel path requires bars to be provided (workers don't hit MT5).
        use_parallel = bool(getattr(req, "parallel", True)) and bool(req.bars)
        max_workers = int(getattr(req, "workers", 0) or 0) or get_compute_config().backtest_workers
        # Emit the job id so the client can call /jobs/{id}/cancel.
        yield json.dumps({"type": "job", "job_id": job.job_id}) + "\n"
        try:
            job_stream = (
                run_backtest_parallel(
                    instrument_ids=req.instrumentIds,
                    strategy_ids=req.strategyIds,
                    strategy_names=req.strategy_names,
                    timeframes=timeframes,
                    regimes=regimes,
                    instrument_symbols=req.instrument_symbols,
                    bars=req.bars or {},
                    instrument_spreads=req.instrument_spreads or {},
                    backtest_config=backtest_config or None,
                    instrument_risk_overrides=req.instrument_risk_overrides or None,
                    job_risk_overrides=getattr(req, "job_risk_overrides", None) or None,
                    param_combos_limit=normalize_param_combos_limit(req.param_combos_limit),
                    regime_tunes=getattr(req, "regime_tunes", None) or None,
                    prefer_htf_regime=getattr(req, "prefer_htf_regime", None),
                    instrument_types=getattr(req, "instrument_types", None) or None,
                    max_workers=max_workers,
                )
                if use_parallel
                else run_server_backtest_stream(
                    instrument_ids=req.instrumentIds,
                    strategy_ids=req.strategyIds,
                    strategy_names=req.strategy_names,
                    timeframes=timeframes,
                    regimes=regimes,
                    instrument_symbols=req.instrument_symbols,
                    date_from=req.dateFrom or "",
                    date_to=req.dateTo or "",
                    bars=req.bars or {},
                    instrument_spreads=req.instrument_spreads or {},
                    backtest_config=backtest_config or None,
                    instrument_risk_overrides=req.instrument_risk_overrides or None,
                    job_risk_overrides=getattr(req, "job_risk_overrides", None) or None,
                    param_combos_limit=normalize_param_combos_limit(req.param_combos_limit),
                    regime_tunes=getattr(req, "regime_tunes", None) or None,
                    prefer_htf_regime=getattr(req, "prefer_htf_regime", None),
                    instrument_types=getattr(req, "instrument_types", None) or None,
                )
            )
            for row, completed, total in job_stream:
                if JOB_MANAGER.should_cancel(job.job_id):
                    JOB_MANAGER.mark_done(
                        job.job_id, succeeded=False, message="cancelled by client"
                    )
                    yield json.dumps({"type": "cancelled", "results": results}) + "\n"
                    return
                row["id"] = f"bt-server-{uuid.uuid4().hex[:12]}"
                results.append(row)
                progress = int((completed / total) * 100) if total > 0 else 100
                JOB_MANAGER.update_progress(
                    job.job_id, progress, f"{completed}/{total}"
                )
                yield json.dumps({
                    "type": "progress",
                    "completed": completed,
                    "total": total,
                    "progress": progress,
                    "phase": f"Processing on server... ({completed}/{total})",
                }) + "\n"
                yield json.dumps({
                    "type": "row",
                    "row": row,
                    "completed": completed,
                    "total": total,
                    "progress": progress,
                }) + "\n"
            JOB_MANAGER.mark_done(job.job_id, succeeded=True, message=f"{len(results)} rows")
            yield json.dumps({"type": "done", "results": results, "status": "completed"}) + "\n"
        except Exception as e:
            JOB_MANAGER.mark_done(job.job_id, succeeded=False, error=str(e))
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


class ResearchGridRequest(BaseModel):
    """Request for pre-backtest grid research: regime calibration + param tune per instrument × regime."""
    instrumentIds: list[str] = []
    strategyIds: list[str] = []
    timeframes: list[str] = []
    regimes: list[str] = []
    dateFrom: str = ""
    dateTo: str = ""
    instrument_symbols: dict[str, str] = {}
    strategy_names: dict[str, str] = {}
    bars: dict[str, list[dict]] = {}
    instrument_spreads: dict[str, float] = {}
    regime_grid_max: int = DEFAULT_RESEARCH_REGIME_GRID_MAX
    param_tune_max_strat: int = DEFAULT_RESEARCH_PARAM_TUNE_MAX_STRAT
    param_tune_max_risk: int = DEFAULT_RESEARCH_PARAM_TUNE_MAX_RISK
    robust_mode: bool = False
    calibration_hints: dict[str, dict] | None = None  # From backward validation: instrumentId -> { regimeConfig, strategyId, score }


@app.post("/research/grid")
def research_grid(req: ResearchGridRequest):
    """
    Run grid research before backtest: calibrate regime detection per instrument,
    tune strategy + risk params per instrument × regime. Returns regimeTunes and paramTunes
    for use in backtest (job_risk_overrides, regime_config).
    """
    if not req.instrumentIds or not req.strategyIds:
        raise HTTPException(status_code=400, detail="instrumentIds and strategyIds required")
    timeframes = req.timeframes or ["M5", "H1"]
    result = run_grid_research(
        instrument_ids=req.instrumentIds,
        strategy_ids=req.strategyIds,
        strategy_names=req.strategy_names,
        timeframes=timeframes,
        instrument_symbols=req.instrument_symbols,
        bars=req.bars or {},
        instrument_spreads=req.instrument_spreads or {},
        regimes=req.regimes or None,
        regime_grid_max=max(1, req.regime_grid_max),
        param_tune_max_strat=max(1, req.param_tune_max_strat),
        param_tune_max_risk=max(1, req.param_tune_max_risk),
        date_from=req.dateFrom or "",
        date_to=req.dateTo or "",
        calibration_hints=req.calibration_hints or None,
    )
    return {"status": "completed", **result}


FULL_DEPTH_TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"]


@app.post("/research/grid/stream")
def research_grid_stream(req: ResearchGridRequest):
    """
    Same as /research/grid but streams NDJSON progress. Each line: {"type":"progress","message":"..."} or {"type":"done",...}
    All required data must be fetched before process runs; otherwise halt with descriptive error.
    """
    if not req.instrumentIds or not req.strategyIds:
        raise HTTPException(status_code=400, detail="instrumentIds and strategyIds required")
    timeframes = req.timeframes if req.timeframes else FULL_DEPTH_TIMEFRAMES
    bars = req.bars or {}

    # Validate all required bars exist with sufficient depth before starting — no inference or skip
    missing: list[str] = []
    insufficient: list[tuple[str, int]] = []
    for inst_id in req.instrumentIds:
        symbol = (req.instrument_symbols or {}).get(inst_id) or inst_id.replace("inst-", "").replace("-", "").upper()
        if not symbol:
            missing.append(f"{inst_id} (no symbol)")
            continue
        for tf in timeframes:
            key = f"{inst_id}|{tf}"
            bar_list = bars.get(key)
            if not bar_list:
                missing.append(f"{symbol} {tf}")
            elif len(bar_list) < MIN_BARS_REQUIRED_RESEARCH:
                insufficient.append((f"{symbol} {tf}", len(bar_list)))
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Missing data for {len(missing)} instrument×timeframe(s). Fetch all required bars before running. Missing: {', '.join(missing[:5])}{'...' if len(missing) > 5 else ''}. Process halted — no inference or skip.",
        )
    if insufficient:
        details = "; ".join(f"{k}: got {n}, need {MIN_BARS_REQUIRED_RESEARCH}" for k, n in insufficient[:5])
        if len(insufficient) > 5:
            details += f"... (+{len(insufficient) - 5} more)"
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient bars: {details}. Process halted — no inference or skip.",
        )

    job = JOB_MANAGER.create(
        kind="research",
        title=f"research grid {len(req.instrumentIds)}×{len(req.strategyIds)}",
        meta={
            "instruments": req.instrumentIds,
            "strategies": req.strategyIds,
            "timeframes": timeframes,
            "robust": bool(req.robust_mode),
        },
    )
    JOB_MANAGER.mark_running(job.job_id)

    def generate():
        # Emit job id first so the UI can wire its cancel button.
        yield json.dumps({"type": "job", "job_id": job.job_id}) + "\n"
        try:
            for chunk in run_grid_research_with_progress(
                instrument_ids=req.instrumentIds,
                strategy_ids=req.strategyIds,
                strategy_names=req.strategy_names,
                timeframes=timeframes,
                instrument_symbols=req.instrument_symbols,
                bars=bars,
                instrument_spreads=req.instrument_spreads or {},
                regimes=req.regimes or None,
                regime_grid_max=max(1, req.regime_grid_max),
                param_tune_max_strat=max(1, req.param_tune_max_strat),
                param_tune_max_risk=max(1, req.param_tune_max_risk),
                date_from=req.dateFrom or "",
                date_to=req.dateTo or "",
                robust_mode=req.robust_mode,
                calibration_hints=req.calibration_hints or None,
                job_id=job.job_id,
            ):
                if JOB_MANAGER.should_cancel(job.job_id):
                    JOB_MANAGER.mark_done(job.job_id, succeeded=False, message="cancelled by client")
                    yield json.dumps({"type": "cancelled"}) + "\n"
                    return
                # Heuristic progress from the chunk's percent if present.
                if isinstance(chunk, dict) and "progress" in chunk:
                    JOB_MANAGER.update_progress(
                        job.job_id, float(chunk.get("progress") or 0), str(chunk.get("message") or "")
                    )
                yield json.dumps(chunk) + "\n"
            JOB_MANAGER.mark_done(job.job_id, succeeded=True)
        except Exception as e:
            JOB_MANAGER.mark_done(job.job_id, succeeded=False, error=str(e))
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class ClosedTradeForValidation(BaseModel):
    """Closed trade for backward validation."""
    instrumentId: str = ""
    botId: str = ""
    type: str = ""  # LONG | SHORT
    pnl: float = 0.0
    entryPrice: float | None = None
    openedAt: str | None = None
    closedAt: str = ""
    scope: str | None = None
    nnSlPct: float | None = None
    nnTpR: float | None = None


class BackwardValidationRequest(BaseModel):
    """Request for backward validation from closed trades."""
    closed_trades: list[ClosedTradeForValidation] = []
    bars: dict[str, list[dict]] = {}  # "instrumentId|timeframe" -> OHLCV bars
    instrument_symbols: dict[str, str] = {}
    strategy_ids: list[str] = []


@app.post("/research/backward-validate")
def research_backward_validate(req: BackwardValidationRequest):
    """
    Backward validation: analyze closed trades to find calibrations that would have been most profitable.
    For losses: analyze the opposite direction and verify by simulating. Returns calibration hints
    per instrument for use in regime/param tuning.
    """
    logger.info(
        "backward_validate request trades=%d bars_keys=%d strategies=%d",
        len(req.closed_trades), len(req.bars or {}), len(req.strategy_ids or []),
    )
    if not req.closed_trades:
        logger.debug("backward_validate empty trades, returning empty result")
        return {
            "validatedTrades": [],
            "calibrationHints": {},
            "summary": {"total": 0, "verified": 0, "skipped": 0},
        }
    strategy_ids = req.strategy_ids or []
    if not strategy_ids:
        logger.warning("backward_validate missing strategy_ids, returning error")
        return {
            "validatedTrades": [],
            "calibrationHints": {},
            "summary": {"total": len(req.closed_trades), "verified": 0, "skipped": len(req.closed_trades)},
            "error": "strategy_ids required for backward validation",
        }
    trades = [
        {
            "instrumentId": t.instrumentId,
            "botId": t.botId,
            "type": t.type,
            "pnl": t.pnl,
            "entryPrice": t.entryPrice,
            "openedAt": t.openedAt,
            "closedAt": t.closedAt,
            "scope": t.scope,
            "nnSlPct": t.nnSlPct,
            "nnTpR": t.nnTpR,
        }
        for t in req.closed_trades
    ]
    result = run_backward_validation(
        closed_trades=trades,
        bars_by_key=req.bars or {},
        instrument_symbols=req.instrument_symbols or {},
        strategy_ids=strategy_ids,
        strategy_names={},
    )
    logger.info(
        "backward_validate result verified=%d skipped=%d hints=%d",
        result.get("summary", {}).get("verified", 0),
        result.get("summary", {}).get("skipped", 0),
        len(result.get("calibrationHints", {})),
    )
    return result


@app.get("/mt5/prices")
def mt5_prices(symbols: str = ""):
    """
    Get current bid/ask for symbols (live position P/L). Requires MT5 connected.
    symbols: Comma-separated list (e.g. EURUSD,BTCUSD,US30).
    """
    if not mt5_client.is_connected():
        return {"error": "MT5 not connected", "prices": {}}
    sym_list = [s.strip() for s in symbols.split(",") if s.strip()]
    if not sym_list:
        return {"prices": {}}
    prices = mt5_client.get_prices(sym_list)
    return {"prices": prices}


@app.get("/mt5/symbols_spread")
def mt5_symbols_spread(symbols: str = ""):
    """
    Get live spread in points for symbols (from broker). Requires MT5 connected.
    symbols: Comma-separated list (e.g. EURUSD,BTCUSD,US30).
    """
    if not mt5_client.is_connected():
        return {"error": "MT5 not connected", "spreads": {}}
    sym_list = [s.strip() for s in symbols.split(",") if s.strip()]
    if not sym_list:
        return {"spreads": {}}
    spreads = mt5_client.get_symbol_spreads(sym_list)
    return {"spreads": spreads}


class Mt5OrderRequest(BaseModel):
    """Request to place a market order via MT5."""
    symbol: str
    side: str  # "buy" or "sell"
    volume: float
    sl: float | None = None
    tp: float | None = None


class Mt5ClosePartialRequest(BaseModel):
    """Request to partially close an MT5 position."""
    ticket: int
    symbol: str
    volume: float
    position_type: int  # 0=buy, 1=sell


@app.post("/mt5/close-partial", dependencies=[Depends(require_api_key)])
def mt5_close_partial(req: Mt5ClosePartialRequest):
    """
    Partially close an MT5 position by ticket.
    Returns { success, ticket?, volume?, error? }.
    """
    if not mt5_client.is_connected():
        raise HTTPException(status_code=503, detail="MT5 not connected")
    ok, result = mt5_client.position_close_partial(
        ticket=req.ticket,
        symbol=req.symbol,
        volume=req.volume,
        position_type=req.position_type,
    )
    if ok:
        return {"success": True, "ticket": result.get("ticket"), "volume": result.get("volume"), "price": result.get("price")}
    raise HTTPException(status_code=400, detail=result.get("error", "Close failed"))


@app.post("/mt5/order", dependencies=[Depends(require_api_key)])
def mt5_order(req: Mt5OrderRequest):
    """
    Place a market order via MT5. Requires MT5 connected.
    Returns { success, order?, ticket?, error? }.
    """
    if not mt5_client.is_connected():
        raise HTTPException(status_code=503, detail="MT5 not connected")
    ok, result = mt5_client.order_send(
        symbol=req.symbol,
        side=req.side,
        volume=req.volume,
        sl=req.sl,
        tp=req.tp,
    )
    if ok:
        return {"success": True, "order": result.get("order"), "ticket": result.get("ticket"), "price": result.get("price"), "volume": result.get("volume")}
    raise HTTPException(status_code=400, detail=result.get("error", "Order failed"))


@app.get("/mt5/positions")
def mt5_positions():
    """
    Get open positions from MT5 so the app can display broker positions.
    Returns list of { ticket, symbol, type (0=buy, 1=sell), volume, price_open, price_current, profit, sl, tp, time }.
    """
    if not mt5_client.is_connected():
        return {"error": "MT5 not connected", "positions": []}
    positions = mt5_client.get_positions()
    return {"positions": positions}
