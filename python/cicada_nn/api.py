"""
FastAPI service for CICADA-5453 NN: build (train) bot from backtest results, MT5 connect, predict actions.
Run: uvicorn cicada_nn.api:app --reload --host 0.0.0.0 --port 8000
"""

import json
import logging
import os

logger = logging.getLogger(__name__)
import tempfile
from pathlib import Path

import numpy as np
import torch

from .train import _safe_instrument_id
from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import StreamingResponse

# Use CUDA for inference when available (e.g. RTX 2070)
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
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

app = FastAPI(title="CICADA-5453 NN API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
def _configure_logging():
    """Ensure cicada_nn modules log at INFO for research/backward-validation visibility."""
    for name in ("cicada_nn", "cicada_nn.research_server", "cicada_nn.backward_validation"):
        log = logging.getLogger(name)
        if log.level == logging.NOTSET:
            log.setLevel(logging.INFO)

CHECKPOINT_DIR = Path(os.environ.get("CICADA_NN_CHECKPOINTS", "checkpoints"))
STORAGE = StorageService(CHECKPOINT_DIR)


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
    }


@app.post("/build", response_model=BuildResponse)
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
        try:
            from .train_detection import train_detection
            det_path, det_meta = train_detection(
                bars_by_key, rows, instrument_id,
                output_dir=str(CHECKPOINT_DIR), epochs=min(30, req.epochs), lr=req.lr,
            )
            # Detection model uses bar_window at predict, not feature_vector. Return zero vector for API shape.
            # Predict handler checks det_path first and uses bars_to_features(bar_window) for inference.
            feat_dim = 64
            feature_vector = [0.0] * feat_dim  # Unused in detection mode; real features from bar_window at predict
            return BuildResponse(
                success=True,
                message=f"Detection model trained on {det_meta.get('num_samples', 0)} bars for {det_meta.get('strategy_id', '?')}",
                checkpoint_path=det_path,
                feature_vector=feature_vector,
                oos_accuracy=None,
                oos_sample_count=det_meta.get("num_samples"),
                detection_timeframe=det_meta.get("timeframe"),
                detection_bar_window=det_meta.get("bar_window"),
            )
        except Exception as e:
            detection_error = str(e)

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
    detection_skip_detail: str | None = None

    # Detection mode: bar-level model recognizes strategy signals
    if det_path.exists():
        from .train_detection import StrategyDetectionNN, bars_to_features
        ckpt = torch.load(det_path, map_location=DEVICE, weights_only=True)
        meta = ckpt.get("meta", {})
        bar_window = meta.get("bar_window", 60)
        if not req.bar_window or len(req.bar_window) < bar_window:
            detection_skip_detail = (
                f"Detection model requires bar_window with at least {bar_window} bars. "
                f"Got {len(req.bar_window or [])}."
            )
        else:
            try:
                bars = [b.model_dump() if hasattr(b, "model_dump") else dict(b) for b in req.bar_window]
                feat = bars_to_features(bars, len(bars) - 1, bar_window)
                dim = meta.get("bar_feature_dim", bar_window * 4)
                model = StrategyDetectionNN(input_dim=dim).to(DEVICE)
                model.load_state_dict(ckpt["model_state"], strict=True)
                model.eval()
                x = torch.from_numpy(feat.astype(np.float32)).unsqueeze(0).to(DEVICE)
                with torch.no_grad():
                    logits = model(x)
                    probs = torch.softmax(logits, dim=1)
                    pred = logits.argmax(dim=1).item()
                    conf = probs[0, pred].item()
                # Class 0=neutral, 1=short, 2=long -> actions: 0=long, 1=short, 2=neutral
                action = 2 if pred == 0 else (1 if pred == 1 else 0)
                actions_list = [action] * 5  # Same for all styles
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
        checkpoint = torch.load(pt_path, map_location=DEVICE, weights_only=True)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Checkpoint load failed: {e}") from e
    from .model import build_model_from_checkpoint
    model = build_model_from_checkpoint(checkpoint).to(DEVICE)
    state = checkpoint["model_state"]
    model.load_state_dict(state, strict=False)
    model.eval()

    model_version = checkpoint.get("model_version", 1)
    has_regression = model_version >= 2 or any(k.startswith("regression_head.") for k in state.keys())

    # Regime and timeframe one-hot from saved mappings (same order as training)
    regime_idx = 0
    timeframe_idx = 0
    strategy_ids: list[str] = []
    if meta_path.exists():
        with open(meta_path) as mf:
            meta = json.load(mf)
        r2i = meta.get("regime_to_idx") or {}
        t2i = meta.get("timeframe_to_idx") or {}
        regime_idx = r2i.get(req.regime, r2i.get("unknown", 0))
        timeframe_idx = t2i.get(req.timeframe, 0)
        strategy_ids = meta.get("strategy_ids") or []

    regime_onehot = np.zeros(NUM_REGIMES, dtype=np.float32)
    if regime_idx < NUM_REGIMES:
        regime_onehot[regime_idx] = 1.0
    if req.regime_confidence is not None and req.regime_confidence > 0:
        regime_onehot = (regime_onehot * np.clip(req.regime_confidence, 0, 1)).astype(np.float32)

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


@app.post("/bots")
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


@app.post("/positions")
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


@app.post("/state")
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


@app.post("/settings")
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


@app.post("/execution-log/append")
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
    """Return whether the backend is currently connected to MT5."""
    return {
        "mt5_available": mt5_client.MT5_AVAILABLE,
        "connected": mt5_client.is_connected(),
    }


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

    def generate():
        import uuid
        results: list[dict] = []
        try:
            for row, completed, total in run_server_backtest_stream(
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
            ):
                row["id"] = f"bt-server-{uuid.uuid4().hex[:12]}"
                results.append(row)
                progress = int((completed / total) * 100) if total > 0 else 100
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
            yield json.dumps({"type": "done", "results": results, "status": "completed"}) + "\n"
        except Exception as e:
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

    def generate():
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
        ):
            yield json.dumps(chunk) + "\n"

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


@app.post("/mt5/close-partial")
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


@app.post("/mt5/order")
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
