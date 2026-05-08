"""MT5 access for CICADA-5453, routed through the bridge in the Windows VM.

Public surface kept stable so existing callers (``daemon_runtime``,
``execution_daemon``, ``api``) keep working unchanged. Every method delegates
to ``mt5_bridge.MT5Bridge`` over HTTP — ``import MetaTrader5`` no longer
appears anywhere in ``cicada_nn``. See ``bridge/server.py`` for the VM-side
implementation and the spec at lines 894-1224.

Failure modes:
  * Bridge unreachable → mt5_bridge raises BridgeUnreachableError; we map it
    to the legacy ``(False, {"error": ...})`` shape so callers don't need
    to learn a new exception type yet. The validate_order pipeline picks
    up the unhealthy state via the latency-model trade gate.
  * Broker retcode → mapped to ``(False, {"error": ..., "retcode": ...})``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from . import mt5_bridge
from .mt5_bridge import BridgeError, BridgeRetcodeError, BridgeUnreachableError, get_bridge


logger = logging.getLogger(__name__)


# ── Compat constants (kept for callers that still reference them) ─────────

MT5_POINT_FALLBACK = 1e-5

# Only the names; the bridge maps each to its own MT5 constant inside the VM.
_TF_NAMES = ("M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1")
TF_MAP: dict[str, str] = {n: n for n in _TF_NAMES}

# Exness/MT5 symbol suffixes by account type. The bridge owns symbol
# resolution now, but the constants are exported for any callers still
# iterating them; keep until they're proven dead.
MT5_SYMBOL_SUFFIXES = ("", "m", "c", "r", "z")


def _bridge_available() -> bool:
    """Lightweight reachability probe used by the legacy ``MT5_AVAILABLE`` flag."""
    return mt5_bridge.is_reachable(timeout_s=1.0)


def __getattr__(name: str) -> Any:
    """``MT5_AVAILABLE`` is computed on access so callers see live bridge state."""
    if name == "MT5_AVAILABLE":
        return _bridge_available()
    raise AttributeError(name)


# ── Connection ────────────────────────────────────────────────────────────


_LAST_CREDS: dict[str, Any] = {}


def connect(
    login: int | str,
    password: str,
    server: str | None = None,
    path: str | None = None,
    timeout: int = 60000,
) -> tuple[bool, dict[str, Any]]:
    """Verify the bridge can reach a logged-in MT5 inside the VM.

    The VM's MT5 manages broker credentials (the bridge spec puts login at
    VM startup, not on every API call). This function therefore reduces to
    a health check + credential cache for the legacy ``reconnect()`` path.
    """
    remember_credentials(login, password, server, path)
    try:
        h = get_bridge().health_check()
    except BridgeUnreachableError as e:
        return False, {"error": f"bridge unreachable: {e}"}
    except BridgeError as e:
        return False, {"error": str(e)}
    if not h.get("mt5_connected"):
        return False, {"error": "bridge ok but MT5 not connected inside VM"}
    return True, {
        "login": h.get("account") or login,
        "server": server or "",
        "balance": 0.0,
        "equity": 0.0,
        "currency": "",
        "leverage": 0,
        "trade_allowed": True,
        "company": "",
    }


def get_account() -> dict | None:
    """Account snapshot. Stage 2B fix C (review §3.4): proxies the bridge's
    ``GET /account`` so balance/equity/currency are real values, not
    placeholder zeros. Returns ``None`` when the bridge is unreachable or
    MT5 isn't logged in inside the VM."""
    try:
        info = get_bridge().get_account()
    except BridgeError:
        return None
    if not isinstance(info, dict) or not info.get("login"):
        return None
    # Mirror the legacy field set so existing callers don't break, but
    # surface the real numbers from MT5 instead of placeholder zeros.
    return {
        "login": str(info.get("login") or ""),
        "server": str(info.get("server") or ""),
        "balance": float(info.get("balance") or 0.0),
        "equity": float(info.get("equity") or 0.0),
        "currency": str(info.get("currency") or ""),
        "leverage": int(info.get("leverage") or 0),
        "margin": float(info.get("margin") or 0.0),
        "margin_free": float(info.get("margin_free") or 0.0),
        "profit": float(info.get("profit") or 0.0),
        "trade_allowed": bool(info.get("trade_allowed", True)),
        "company": str(info.get("company") or ""),
    }


def disconnect() -> None:
    """No-op — connection lifecycle lives in the VM."""
    return None


def is_connected() -> bool:
    try:
        h = get_bridge().health_check()
    except BridgeError:
        return False
    return bool(h.get("mt5_connected"))


def remember_credentials(
    login: int | str,
    password: str,
    server: str | None = None,
    path: str | None = None,
) -> None:
    """Cache login parameters in memory so ``reconnect()`` can rebuild a
    bridge handshake. Credentials never reach disk on the host."""
    _LAST_CREDS.update({"login": login, "password": password, "server": server, "path": path})


def reconnect() -> tuple[bool, dict[str, Any]]:
    if not _LAST_CREDS:
        return False, {"error": "no cached credentials; call /mt5/connect first"}
    return connect(
        _LAST_CREDS.get("login"),
        _LAST_CREDS.get("password", ""),
        _LAST_CREDS.get("server"),
        _LAST_CREDS.get("path"),
    )


def connection_status() -> dict[str, Any]:
    """Structured status for the UI's Brokers panel — now bridge-shaped."""
    try:
        h = get_bridge().health_check()
    except BridgeUnreachableError as e:
        return {
            "installed": False,
            "connected": False,
            "bridge_reachable": False,
            "error": f"bridge unreachable: {e}",
            "has_credentials": bool(_LAST_CREDS),
        }
    except BridgeError as e:
        return {
            "installed": False,
            "connected": False,
            "bridge_reachable": True,
            "error": str(e),
            "has_credentials": bool(_LAST_CREDS),
        }
    if not h.get("mt5_connected"):
        return {
            "installed": True,
            "connected": False,
            "bridge_reachable": True,
            "last_error": "MT5 not connected inside VM",
            "has_credentials": bool(_LAST_CREDS),
        }
    # Stage 2B fix C: pull the real account snapshot from /account so the
    # dashboard's brokers panel shows real balance/equity instead of
    # placeholder zeros. Failure here is non-fatal — fall back to the
    # account login from /health.
    real_balance = 0.0
    real_equity = 0.0
    real_server = ""
    real_currency = ""
    real_leverage = 0
    real_company = ""
    real_login = h.get("account")
    real_trade_allowed = True
    try:
        info = get_bridge().get_account()
        if isinstance(info, dict) and info.get("login"):
            real_balance = float(info.get("balance") or 0.0)
            real_equity = float(info.get("equity") or 0.0)
            real_server = str(info.get("server") or "")
            real_currency = str(info.get("currency") or "")
            real_leverage = int(info.get("leverage") or 0)
            real_company = str(info.get("company") or "")
            real_login = str(info.get("login") or h.get("account") or "")
            real_trade_allowed = bool(info.get("trade_allowed", True))
    except BridgeError:
        pass  # /account is best-effort; /health already confirmed connectivity
    return {
        "installed": True,
        "connected": True,
        "bridge_reachable": True,
        "login": real_login,
        "server": real_server,
        "currency": real_currency,
        "leverage": real_leverage,
        "balance": real_balance,
        "equity": real_equity,
        "trade_allowed": real_trade_allowed,
        "company": real_company,
    }


# ── Market data ───────────────────────────────────────────────────────────


def _parse_date_utc(date_str: str, end_of_day: bool = False) -> datetime | None:
    if not date_str or not isinstance(date_str, str):
        return None
    try:
        parts = date_str.strip().split("-")
        if len(parts) != 3:
            return None
        y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
        if end_of_day:
            return datetime(y, m, d, 23, 59, 59, tzinfo=timezone.utc)
        return datetime(y, m, d, tzinfo=timezone.utc)
    except (ValueError, IndexError) as e:
        logger.warning("Date parse failed for %r: %s", date_str, e)
        return None


def get_rates(
    symbol: str,
    timeframe: str,
    count: int = 50_000,
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[dict[str, Any]] | None:
    """OHLCV bars via the bridge's ``GET /history``."""
    tf = timeframe.upper()
    if tf not in TF_MAP:
        return None

    if date_from and date_to:
        dt_from = _parse_date_utc(date_from, end_of_day=False)
        dt_to = _parse_date_utc(date_to, end_of_day=True)
        if not dt_from or not dt_to or dt_from > dt_to:
            return None
        from_ts = int(dt_from.timestamp())
        to_ts = int(dt_to.timestamp())
    else:
        now = datetime.now(timezone.utc)
        # Pull a wide window; bridge will trim to whatever MT5 actually has.
        to_ts = int(now.timestamp())
        from_ts = to_ts - count * 60  # rough lower bound; bridge filters
    try:
        rows = get_bridge().get_history(symbol=symbol, timeframe=tf, from_ts=from_ts, to_ts=to_ts)
    except BridgeError as e:
        logger.warning("get_rates: bridge error: %s", e)
        return None
    if not rows:
        return None
    return [
        {
            "time": int(r["time"]),
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "volume": int(r.get("volume") or 0),
        }
        for r in rows[-count:]
    ]


def get_symbol_spreads(symbols: list[str]) -> dict[str, float]:
    """Live spread fetch is not currently exposed on the bridge.

    Spec Phase 2b puts spread data on the per-coordinate execution-quality
    map (built from real ticks). For the dashboard's spread strip we'd
    add ``/symbol/spread`` to the bridge in a follow-up. Until then this
    returns an empty dict and callers degrade gracefully (the legacy code
    already handled the "MT5 not available" zero result)."""
    return {}


def get_prices(symbols: list[str]) -> dict[str, dict[str, float]]:
    """As above — current bid/ask is not yet on the bridge surface."""
    return {}


# ── Orders ────────────────────────────────────────────────────────────────


def order_send(
    symbol: str,
    side: str,
    volume: float,
    sl: float | None = None,
    tp: float | None = None,
    magic: int = 0,
    comment: str | None = None,
) -> tuple[bool, dict[str, Any]]:
    direction = "LONG" if side.lower() == "buy" else "SHORT"
    try:
        resp = get_bridge().place_order(
            symbol=symbol,
            direction=direction,
            volume=float(volume),
            sl=float(sl or 0.0),
            tp=float(tp or 0.0),
            magic=int(magic),
            comment=comment or "cicada-5453",
        )
    except BridgeUnreachableError as e:
        return False, {"error": f"bridge unreachable: {e}"}
    except BridgeRetcodeError as e:
        return False, {"error": e.detail, "retcode": e.retcode}
    except BridgeError as e:
        return False, {"error": str(e)}
    return True, {
        "order": int(resp.get("ticket") or 0),
        "ticket": int(resp.get("ticket") or 0),
        "price": float(resp.get("fill_price") or 0.0),
        "volume": float(volume),
    }


def modify_sl(
    ticket: int,
    symbol: str,
    new_sl: float,
    new_tp: float | None = None,
) -> tuple[bool, dict[str, Any]]:
    """Modify SL (and optionally TP) of an open position via the bridge."""
    try:
        get_bridge().modify_sl(
            ticket=int(ticket),
            new_sl=float(new_sl),
            new_tp=(float(new_tp) if new_tp is not None and new_tp > 0 else None),
        )
    except BridgeUnreachableError as e:
        return False, {"error": f"bridge unreachable: {e}"}
    except BridgeRetcodeError as e:
        return False, {"error": e.detail, "retcode": e.retcode}
    except BridgeError as e:
        return False, {"error": str(e)}
    return True, {"ticket": int(ticket), "sl": new_sl, "tp": new_tp}


def position_close_partial(
    ticket: int,
    symbol: str,
    volume: float,
    position_type: int,
) -> tuple[bool, dict[str, Any]]:
    """Close part of a position via the bridge."""
    try:
        resp = get_bridge().close_position(ticket=int(ticket), volume=float(volume))
    except BridgeUnreachableError as e:
        return False, {"error": f"bridge unreachable: {e}"}
    except BridgeRetcodeError as e:
        return False, {"error": e.detail, "retcode": e.retcode}
    except BridgeError as e:
        return False, {"error": str(e)}
    return True, {
        "ticket": int(ticket),
        "volume": float(volume),
        "price": float(resp.get("close_price") or 0.0),
    }


def get_positions() -> list[dict[str, Any]]:
    try:
        rows = get_bridge().get_positions()
    except BridgeError as e:
        logger.warning("get_positions: bridge error: %s", e)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        try:
            ptype = 0 if str(r.get("direction")) == "LONG" else 1
            out.append(
                {
                    "ticket": int(r.get("ticket") or 0),
                    "symbol": str(r.get("symbol") or ""),
                    "type": ptype,
                    "volume": float(r.get("volume") or 0.0),
                    "price_open": float(r.get("open_price") or 0.0),
                    "price_current": float(r.get("open_price") or 0.0),  # bridge omits live mark
                    "profit": float(r.get("profit") or 0.0),
                    "sl": (float(r.get("sl") or 0.0) or None),
                    "tp": (float(r.get("tp") or 0.0) or None),
                    "time": 0,
                }
            )
        except (TypeError, ValueError) as e:
            logger.warning("get_positions parse failed: %s", e)
            continue
    return out
