"""FastAPI bridge — runs inside the Windows VM, wraps the MetaTrader5 package.

Spec lines 1129-1206. Endpoints exactly as specified:
    GET  /health
    POST /order/place
    POST /order/modify_sl
    POST /order/close
    GET  /positions
    GET  /ticks
    GET  /history

This is the only file in the entire codebase allowed to ``import MetaTrader5``.
The Ubuntu host's trading code calls the public surface via HTTP only — see
``python/cicada_nn/mt5_bridge.py``.

Runs at ``localhost:5000`` via:
    uvicorn bridge.server:app --host 0.0.0.0 --port 5000

For Linux contract tests (``bridge/test_bridge_contract.py``) a stub MetaTrader5
is injected into ``sys.modules`` before this file is imported; ``MT5_AVAILABLE``
then reflects the stub's presence and the endpoints exercise the same shape.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


# ── MT5 import (the ONLY allowed location) ──────────────────────────────────

MT5_AVAILABLE = False
try:
    import MetaTrader5 as mt5  # type: ignore
    MT5_AVAILABLE = True
except ImportError:
    mt5 = None  # type: ignore


_TF_MAP: dict[str, Any] = {}
if MT5_AVAILABLE and mt5 is not None:
    for name in ("M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"):
        const = getattr(mt5, f"TIMEFRAME_{name}", None)
        if const is not None:
            _TF_MAP[name] = const


# ── Request / response models ────────────────────────────────────────────────


class HealthResponse(BaseModel):
    status: str
    mt5_connected: bool
    account: Optional[str] = None


class AccountResponse(BaseModel):
    """Stage 2B fix C: real account snapshot from ``mt5.account_info()``.

    Replaces the placeholder zeros previously synthesised by
    ``mt5_client.get_account``. Architectural review §3.4."""
    login: str
    server: str = ""
    currency: str = ""
    balance: float = 0.0
    equity: float = 0.0
    leverage: int = 0
    margin: float = 0.0
    margin_free: float = 0.0
    profit: float = 0.0
    trade_allowed: bool = True
    company: str = ""


class OrderPlaceRequest(BaseModel):
    symbol: str
    direction: str = Field(pattern="^(LONG|SHORT)$")
    volume: float
    sl: float = 0.0
    tp: float = 0.0
    magic: int = 0
    comment: str = "cicada-5453"
    deviation: int = 20


class OrderPlaceResponse(BaseModel):
    success: bool
    ticket: int = 0
    fill_price: float = 0.0
    fill_time: str = ""
    retcode: int = 0
    error: Optional[str] = None


class ModifySLRequest(BaseModel):
    ticket: int
    new_sl: float
    new_tp: Optional[float] = None


class ModifySLResponse(BaseModel):
    success: bool
    retcode: int = 0
    error: Optional[str] = None


class CloseRequest(BaseModel):
    ticket: int
    volume: Optional[float] = None


class CloseResponse(BaseModel):
    success: bool
    close_price: float = 0.0
    close_time: str = ""
    retcode: int = 0
    error: Optional[str] = None


class PositionRow(BaseModel):
    ticket: int
    symbol: str
    direction: str
    volume: float
    open_price: float
    open_time: str
    sl: float
    tp: float
    profit: float
    magic: int
    comment: str


class TickRow(BaseModel):
    time: int
    bid: float
    ask: float
    volume: float
    spread: float


class BarRow(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float


# ── Helpers ──────────────────────────────────────────────────────────────────


def _require_mt5() -> Any:
    if not MT5_AVAILABLE or mt5 is None:
        raise HTTPException(status_code=503, detail="MetaTrader5 package not installed inside VM")
    return mt5


def _direction_to_order_type(direction: str) -> int:
    m = _require_mt5()
    return int(m.ORDER_TYPE_BUY if direction == "LONG" else m.ORDER_TYPE_SELL)


def _account_login_str() -> Optional[str]:
    if not MT5_AVAILABLE or mt5 is None:
        return None
    info = mt5.account_info()
    if info is None:
        return None
    return str(getattr(info, "login", "") or "")


def _utc_iso(epoch: int | float | None) -> str:
    if not epoch:
        return ""
    try:
        return datetime.fromtimestamp(float(epoch), tz=timezone.utc).isoformat()
    except (OSError, ValueError, TypeError):
        return ""


# ── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="CICADA-5453 MT5 Bridge", version="0.1.0")


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    if not MT5_AVAILABLE or mt5 is None:
        return HealthResponse(status="ok", mt5_connected=False, account=None)
    info = mt5.account_info()
    return HealthResponse(
        status="ok",
        mt5_connected=info is not None,
        account=(str(getattr(info, "login", "")) if info is not None else None),
    )


@app.get("/account", response_model=AccountResponse)
def account() -> AccountResponse:
    """Stage 2B fix C: full ``mt5.account_info()`` snapshot.

    Returns 503 when MT5 isn't installed inside the VM (``_require_mt5``
    raises) and 503 + detail when MT5 is installed but no account is
    logged in (``account_info()`` returns ``None``)."""
    m = _require_mt5()
    info = m.account_info()
    if info is None:
        raise HTTPException(status_code=503, detail="MT5 not connected inside VM")
    return AccountResponse(
        login=str(getattr(info, "login", "")),
        server=str(getattr(info, "server", "") or ""),
        currency=str(getattr(info, "currency", "") or ""),
        balance=float(getattr(info, "balance", 0.0) or 0.0),
        equity=float(getattr(info, "equity", 0.0) or 0.0),
        leverage=int(getattr(info, "leverage", 0) or 0),
        margin=float(getattr(info, "margin", 0.0) or 0.0),
        margin_free=float(getattr(info, "margin_free", 0.0) or 0.0),
        profit=float(getattr(info, "profit", 0.0) or 0.0),
        trade_allowed=bool(getattr(info, "trade_allowed", True)),
        company=str(getattr(info, "company", "") or ""),
    )


@app.post("/order/place", response_model=OrderPlaceResponse)
def order_place(req: OrderPlaceRequest) -> OrderPlaceResponse:
    m = _require_mt5()
    sym = req.symbol.replace("/", "").strip().upper()
    tick = m.symbol_info_tick(sym)
    if tick is None:
        return OrderPlaceResponse(success=False, retcode=-1, error=f"symbol {sym} not found")
    price = float(tick.ask if req.direction == "LONG" else tick.bid)
    request = {
        "action": int(m.TRADE_ACTION_DEAL),
        "symbol": sym,
        "volume": round(float(req.volume), 2),
        "type": _direction_to_order_type(req.direction),
        "price": price,
        "deviation": int(req.deviation),
        "magic": int(req.magic),
        "comment": req.comment,
    }
    if req.sl and req.sl > 0:
        request["sl"] = round(float(req.sl), 5)
    if req.tp and req.tp > 0:
        request["tp"] = round(float(req.tp), 5)
    result = m.order_send(request)
    if result is None:
        err = m.last_error()
        return OrderPlaceResponse(success=False, retcode=-1, error=(err[1] if err else "unknown"))
    retcode = int(getattr(result, "retcode", 0) or 0)
    if retcode != int(m.TRADE_RETCODE_DONE):
        return OrderPlaceResponse(success=False, retcode=retcode, error=str(getattr(result, "comment", "")))
    return OrderPlaceResponse(
        success=True,
        ticket=int(getattr(result, "order", 0) or 0),
        fill_price=float(getattr(result, "price", 0.0) or 0.0),
        fill_time=_utc_iso(getattr(result, "time", 0)),
        retcode=retcode,
        error=None,
    )


@app.post("/order/modify_sl", response_model=ModifySLResponse)
def order_modify_sl(req: ModifySLRequest) -> ModifySLResponse:
    m = _require_mt5()
    request = {
        "action": int(m.TRADE_ACTION_SLTP),
        "position": int(req.ticket),
        "sl": round(float(req.new_sl), 5),
    }
    if req.new_tp is not None and req.new_tp > 0:
        request["tp"] = round(float(req.new_tp), 5)
    result = m.order_send(request)
    if result is None:
        err = m.last_error()
        return ModifySLResponse(success=False, retcode=-1, error=(err[1] if err else "unknown"))
    retcode = int(getattr(result, "retcode", 0) or 0)
    if retcode != int(m.TRADE_RETCODE_DONE):
        return ModifySLResponse(success=False, retcode=retcode, error=str(getattr(result, "comment", "")))
    return ModifySLResponse(success=True, retcode=retcode, error=None)


@app.post("/order/close", response_model=CloseResponse)
def order_close(req: CloseRequest) -> CloseResponse:
    m = _require_mt5()
    positions = m.positions_get(ticket=int(req.ticket))
    if not positions:
        return CloseResponse(success=False, retcode=-1, error=f"position {req.ticket} not found")
    p = positions[0]
    sym = str(getattr(p, "symbol", ""))
    pos_type = int(getattr(p, "type", 0))
    volume = float(req.volume) if req.volume is not None else float(getattr(p, "volume", 0.0) or 0.0)
    tick = m.symbol_info_tick(sym)
    if tick is None:
        return CloseResponse(success=False, retcode=-1, error=f"symbol {sym} not found")
    close_type = int(m.ORDER_TYPE_SELL if pos_type == 0 else m.ORDER_TYPE_BUY)
    price = float(tick.bid if pos_type == 0 else tick.ask)
    request = {
        "action": int(m.TRADE_ACTION_DEAL),
        "symbol": sym,
        "volume": round(volume, 2),
        "type": close_type,
        "position": int(req.ticket),
        "price": price,
        "deviation": 20,
        "magic": int(getattr(p, "magic", 0) or 0),
        "comment": "cicada-5453-close",
    }
    result = m.order_send(request)
    if result is None:
        err = m.last_error()
        return CloseResponse(success=False, retcode=-1, error=(err[1] if err else "unknown"))
    retcode = int(getattr(result, "retcode", 0) or 0)
    if retcode != int(m.TRADE_RETCODE_DONE):
        return CloseResponse(success=False, retcode=retcode, error=str(getattr(result, "comment", "")))
    return CloseResponse(
        success=True,
        close_price=float(getattr(result, "price", 0.0) or 0.0),
        close_time=_utc_iso(getattr(result, "time", 0)),
        retcode=retcode,
        error=None,
    )


@app.get("/positions", response_model=list[PositionRow])
def positions() -> list[PositionRow]:
    m = _require_mt5()
    rows = m.positions_get()
    if not rows:
        return []
    out: list[PositionRow] = []
    for p in rows:
        ptype = int(getattr(p, "type", 0))
        out.append(
            PositionRow(
                ticket=int(getattr(p, "ticket", 0) or 0),
                symbol=str(getattr(p, "symbol", "")),
                direction=("LONG" if ptype == 0 else "SHORT"),
                volume=float(getattr(p, "volume", 0.0) or 0.0),
                open_price=float(getattr(p, "price_open", 0.0) or 0.0),
                open_time=_utc_iso(getattr(p, "time", 0)),
                sl=float(getattr(p, "sl", 0.0) or 0.0),
                tp=float(getattr(p, "tp", 0.0) or 0.0),
                profit=float(getattr(p, "profit", 0.0) or 0.0),
                magic=int(getattr(p, "magic", 0) or 0),
                comment=str(getattr(p, "comment", "") or ""),
            )
        )
    return out


@app.get("/ticks", response_model=list[TickRow])
def ticks(symbol: str, from_ts: int, to_ts: int) -> list[TickRow]:
    m = _require_mt5()
    sym = symbol.replace("/", "").strip().upper()
    if hasattr(m, "copy_ticks_range"):
        raw = m.copy_ticks_range(sym, datetime.fromtimestamp(from_ts, tz=timezone.utc),
                                 datetime.fromtimestamp(to_ts, tz=timezone.utc),
                                 getattr(m, "COPY_TICKS_ALL", 0))
    else:
        raw = m.copy_ticks_from(sym, datetime.fromtimestamp(from_ts, tz=timezone.utc),
                                100_000, getattr(m, "COPY_TICKS_ALL", 0))
    if raw is None:
        return []
    out: list[TickRow] = []
    for r in raw:
        bid = float(r["bid"]) if "bid" in r.dtype.names else 0.0
        ask = float(r["ask"]) if "ask" in r.dtype.names else 0.0
        vol = float(r["volume"]) if "volume" in r.dtype.names else 0.0
        out.append(TickRow(time=int(r["time"]), bid=bid, ask=ask, volume=vol, spread=max(0.0, ask - bid)))
    return out


@app.get("/history", response_model=list[BarRow])
def history(symbol: str, timeframe: str, from_ts: int, to_ts: int) -> list[BarRow]:
    m = _require_mt5()
    sym = symbol.replace("/", "").strip().upper()
    tf = _TF_MAP.get(timeframe.upper())
    if tf is None:
        raise HTTPException(status_code=400, detail=f"unknown timeframe {timeframe}")
    raw = m.copy_rates_range(sym, tf,
                             datetime.fromtimestamp(from_ts, tz=timezone.utc),
                             datetime.fromtimestamp(to_ts, tz=timezone.utc))
    if raw is None:
        return []
    out: list[BarRow] = []
    for r in raw:
        vol = 0.0
        if "tick_volume" in r.dtype.names:
            vol = float(r["tick_volume"])
        elif "real_volume" in r.dtype.names:
            vol = float(r["real_volume"])
        out.append(BarRow(time=int(r["time"]), open=float(r["open"]), high=float(r["high"]),
                          low=float(r["low"]), close=float(r["close"]), volume=vol))
    return out
