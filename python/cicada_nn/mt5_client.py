"""
MT5 connection client for CICADA-5453.
Uses the MetaTrader5 Python package to connect with login/password/server.
Requires MT5 terminal installed (or path). Optional dependency: install with pip install MetaTrader5.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta
from typing import Any

MT5_AVAILABLE = False
MT5_POINT_FALLBACK = 1e-5
try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    mt5 = None

# Map frontend timeframe names to MT5 constants (when MT5 is available)
TF_MAP: dict[str, Any] = {}
if MT5_AVAILABLE and mt5 is not None:
    TF_MAP = {
        "M1": mt5.TIMEFRAME_M1,
        "M5": mt5.TIMEFRAME_M5,
        "M15": mt5.TIMEFRAME_M15,
        "M30": mt5.TIMEFRAME_M30,
        "H1": mt5.TIMEFRAME_H1,
        "H4": mt5.TIMEFRAME_H4,
        "D1": mt5.TIMEFRAME_D1,
        "W1": mt5.TIMEFRAME_W1,
    }


def connect(
    login: int | str,
    password: str,
    server: str | None = None,
    path: str | None = None,
    timeout: int = 60000,
) -> tuple[bool, dict[str, Any]]:
    """
    Initialize MT5 and log in with the given credentials.
    :param login: MT5 account number (integer or string that can be converted).
    :param password: Account password.
    :param server: Broker server name (e.g. "Broker-Server" or "Broker-Live"). If None, uses last/default.
    :param path: Path to MetaTrader5 terminal exe. If None, terminal is auto-detected.
    :param timeout: Connection timeout in ms.
    :return: (success: bool, data: dict with account info on success or {"error": str} on failure).
    """
    if not MT5_AVAILABLE or mt5 is None:
        return False, {"error": "MetaTrader5 package not installed. pip install MetaTrader5"}

    login_int = int(login) if isinstance(login, str) and login.isdigit() else login
    if not isinstance(login_int, int):
        return False, {"error": "login must be a numeric account number"}

    if path:
        init_ok = mt5.initialize(path=path, login=login_int, password=password, server=server or "", timeout=timeout)
    else:
        init_ok = mt5.initialize()
        if init_ok and (login_int or password or server):
            init_ok = mt5.login(login_int, password=password, server=server or "")
    if not init_ok:
        err = mt5.last_error()
        err_msg = err[1] if err else "Unknown error"
        return False, {"error": err_msg}

    account = mt5.account_info()
    if account is None:
        mt5.shutdown()
        return False, {"error": "Connected but could not retrieve account info"}

    # Expose a minimal safe subset of account info (no sensitive data)
    info = {
        "login": account.login,
        "server": account.server,
        "balance": getattr(account, "balance", 0.0),
        "equity": getattr(account, "equity", None),  # balance + floating P/L when available
        "currency": getattr(account, "currency", ""),
        "leverage": getattr(account, "leverage", 0),
        "trade_allowed": getattr(account, "trade_allowed", False),
        "company": getattr(account, "company", ""),
    }
    if info["equity"] is None and info["balance"] is not None:
        info["equity"] = info["balance"]
    # Cache for reconnect() — kept only in process memory.
    remember_credentials(login_int, password, server, path)
    return True, info


def get_account() -> dict | None:
    """Return current account info (balance, equity) if connected. No reconnect."""
    if not MT5_AVAILABLE or mt5 is None:
        return None
    account = mt5.account_info()
    if account is None:
        return None
    info = {
        "login": account.login,
        "server": account.server,
        "balance": getattr(account, "balance", 0.0),
        "equity": getattr(account, "equity", None),
        "currency": getattr(account, "currency", ""),
        "leverage": getattr(account, "leverage", 0),
        "trade_allowed": getattr(account, "trade_allowed", False),
        "company": getattr(account, "company", ""),
    }
    if info["equity"] is None and info["balance"] is not None:
        info["equity"] = info["balance"]
    return info


def disconnect() -> None:
    """Shut down the MT5 connection."""
    if MT5_AVAILABLE and mt5 is not None:
        mt5.shutdown()


def is_connected() -> bool:
    """Return True if MT5 is initialized and we have account info."""
    if not MT5_AVAILABLE or mt5 is None:
        return False
    return mt5.account_info() is not None


# Last-known credentials for reconnect support. Persisted only in memory: a
# crashed worker is expected to be reconfigured by the FE on restart, so we
# never write credentials to disk.
_LAST_CREDS: dict[str, Any] = {}


def remember_credentials(login: int | str, password: str, server: str | None = None, path: str | None = None) -> None:
    """Cache login parameters in memory so ``reconnect()`` can restore the
    session after a transient broker disconnect without prompting the user."""
    _LAST_CREDS.update({"login": login, "password": password, "server": server, "path": path})


def reconnect() -> tuple[bool, dict[str, Any]]:
    """Attempt to reconnect using the last-known credentials. Returns the same
    shape as ``connect()``. Use after the broker drops the link."""
    if not MT5_AVAILABLE or mt5 is None:
        return False, {"error": "MetaTrader5 package not installed"}
    if not _LAST_CREDS:
        return False, {"error": "no cached credentials; call /mt5/connect first"}
    try:
        mt5.shutdown()
    except Exception:
        pass
    return connect(
        _LAST_CREDS.get("login"),
        _LAST_CREDS.get("password", ""),
        _LAST_CREDS.get("server"),
        _LAST_CREDS.get("path"),
    )


def connection_status() -> dict[str, Any]:
    """Structured connection status for the UI's Brokers panel.

    Includes whether the package is installed, whether a session is alive,
    last error from MT5 (if any), and a quick account snapshot when connected.
    """
    if not MT5_AVAILABLE or mt5 is None:
        return {
            "installed": False,
            "connected": False,
            "error": "MetaTrader5 package not installed",
        }
    try:
        last_err = mt5.last_error()
    except Exception:
        last_err = None
    account = mt5.account_info()
    if account is None:
        return {
            "installed": True,
            "connected": False,
            "last_error": (last_err[1] if last_err and isinstance(last_err, tuple) and len(last_err) > 1 else None),
            "has_credentials": bool(_LAST_CREDS),
        }
    return {
        "installed": True,
        "connected": True,
        "login": getattr(account, "login", None),
        "server": getattr(account, "server", ""),
        "currency": getattr(account, "currency", ""),
        "leverage": getattr(account, "leverage", 0),
        "balance": getattr(account, "balance", 0.0),
        "equity": getattr(account, "equity", None) or getattr(account, "balance", 0.0),
        "trade_allowed": getattr(account, "trade_allowed", False),
        "company": getattr(account, "company", ""),
    }


def _parse_date_utc(date_str: str, end_of_day: bool = False) -> datetime | None:
    """Parse YYYY-MM-DD to UTC datetime. end_of_day=True gives 23:59:59."""
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
        import logging
        logging.getLogger(__name__).warning("Date parse failed for %r: %s", date_str, e)
        return None


def get_rates(
    symbol: str,
    timeframe: str,
    count: int = 50_000,
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[dict[str, Any]] | None:
    """
    Get OHLCV bars from MT5 for the given symbol and timeframe.
    :param symbol: MT5 symbol (e.g. EURUSD, BTCUSD, US30).
    :param timeframe: One of M1, M5, M15, M30, H1, H4, D1, W1.
    :param count: Number of bars to return (default 50k for full history).
    :param date_from: Optional YYYY-MM-DD start of range (backtest).
    :param date_to: Optional YYYY-MM-DD end of range (backtest).
    :return: List of dicts with time, open, high, low, close, tick_volume; or None on error.
    """
    if not MT5_AVAILABLE or mt5 is None:
        return None
    tf = TF_MAP.get(timeframe.upper())
    if tf is None:
        return None

    if date_from and date_to:
        dt_from = _parse_date_utc(date_from, end_of_day=False)
        dt_to = _parse_date_utc(date_to, end_of_day=True)
        if dt_from and dt_to and dt_from <= dt_to:
            if hasattr(mt5, "copy_rates_range"):
                rates = mt5.copy_rates_range(symbol, tf, dt_from, dt_to)
            else:
                rates = mt5.copy_rates_from(symbol, tf, dt_to, count)
        else:
            rates = None
    else:
        utc_now = datetime.now(timezone.utc)
        rates = mt5.copy_rates_from(symbol, tf, utc_now, count)

    if rates is None or len(rates) == 0:
        return None
    out = []
    for r in rates:
        vol = 0
        try:
            vol = int(r["tick_volume"])
        except (KeyError, TypeError) as e:
            try:
                vol = int(r["real_volume"])
            except (KeyError, TypeError):
                logging.getLogger(__name__).warning("volume parse failed for bar %s: %s", r.get("time"), e)
        out.append({
            "time": int(r["time"]),
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "volume": vol,
        })
    return out


# Exness/MT5 symbol suffixes by account type (Exness Help: Account type suffixes).
# Pro: no suffix. Standard: m. Standard Cent: c. Raw Spread: r. Zero: z.
MT5_SYMBOL_SUFFIXES = ("", "m", "c", "r", "z")


def _try_symbol_spread(s: str) -> float | None:
    """Get spread for one MT5 symbol. Returns spread_points or None if symbol not available."""
    try:
        mt5.symbol_select(s, True)
    except Exception:
        pass
    info = mt5.symbol_info(s)
    if info is not None:
        spread_pts = getattr(info, "spread", None)
        if spread_pts is not None:
            return float(spread_pts)
        tick = mt5.symbol_info_tick(s)
        if tick is not None:
            bid = float(getattr(tick, "bid", 0) or 0)
            ask = float(getattr(tick, "ask", 0) or 0)
            if bid > 0 and ask > 0:
                point = float(getattr(info, "point", MT5_POINT_FALLBACK) or MT5_POINT_FALLBACK)
                if point > 0:
                    return (ask - bid) / point
    return None


def get_symbol_spreads(symbols: list[str]) -> dict[str, float]:
    """
    Get live spread in points for the given symbols (from broker).
    Uses symbol_info(symbol).spread or (ask-bid)/point from tick. Broker data only.
    For Exness: tries base symbol then suffixes (m, c, r, z) per account type.
    :param symbols: List of MT5 symbols (e.g. ["EURUSD", "BTCUSD"]).
    :return: Dict symbol -> spread_points. Missing symbols are omitted.
    """
    if not MT5_AVAILABLE or mt5 is None:
        return {}
    result: dict[str, float] = {}
    for sym in symbols:
        base = (sym or "").replace("/", "").strip().upper()
        if not base:
            continue
        for suffix in MT5_SYMBOL_SUFFIXES:
            s = base + suffix
            spread = _try_symbol_spread(s)
            if spread is not None and spread > 0:
                result[base] = spread
                break
    return result


def get_prices(symbols: list[str]) -> dict[str, dict[str, float]]:
    """
    Get current bid/ask for the given symbols (for live position P/L).
    For Exness: tries base symbol then suffixes (m, c, r, z) per account type.
    :param symbols: List of MT5 symbols (e.g. ["EURUSD", "BTCUSD"]).
    :return: Dict symbol -> {"bid": float, "ask": float}. Missing symbols are omitted.
    """
    if not MT5_AVAILABLE or mt5 is None:
        return {}
    result: dict[str, dict[str, float]] = {}
    for sym in symbols:
        base = (sym or "").replace("/", "").strip().upper()
        if not base:
            continue
        for suffix in MT5_SYMBOL_SUFFIXES:
            s = base + suffix
            tick = mt5.symbol_info_tick(s)
            if tick is None:
                continue
            try:
                bid = float(getattr(tick, "bid", 0) or 0)
                ask = float(getattr(tick, "ask", 0) or 0)
                if bid > 0 or ask > 0:
                    result[base] = {"bid": bid, "ask": ask}
                    break
            except (TypeError, ValueError) as e:
                import logging
                logging.getLogger(__name__).warning("get_prices parse failed for %s: %s", s, e)
    return result


def order_send(
    symbol: str,
    side: str,
    volume: float,
    sl: float | None = None,
    tp: float | None = None,
) -> tuple[bool, dict[str, Any]]:
    """
    Send a market order to MT5.
    :param symbol: MT5 symbol (e.g. EURUSD, BTCUSD).
    :param side: 'buy' or 'sell'.
    :param volume: Lot size (e.g. 0.01).
    :param sl: Stop loss price (optional).
    :param tp: Take profit price (optional).
    :return: (success, result dict with order/ticket or error).
    """
    if not MT5_AVAILABLE or mt5 is None:
        return False, {"error": "MetaTrader5 not available"}
    sym = (symbol or "").replace("/", "").strip().upper()
    if not sym:
        return False, {"error": "Invalid symbol"}
    tick = mt5.symbol_info_tick(sym)
    if tick is None:
        return False, {"error": f"Symbol {sym} not found"}
    price = float(tick.ask) if side.lower() == "buy" else float(tick.bid)
    order_type = mt5.ORDER_TYPE_BUY if side.lower() == "buy" else mt5.ORDER_TYPE_SELL
    request: dict[str, Any] = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": sym,
        "volume": round(volume, 2),
        "type": order_type,
        "price": price,
        "deviation": 20,
        "magic": 0,
        "comment": "cicada-5453",
    }
    if sl is not None and sl > 0:
        request["sl"] = round(sl, 5)
    if tp is not None and tp > 0:
        request["tp"] = round(tp, 5)
    result = mt5.order_send(request)
    if result is None:
        err = mt5.last_error()
        return False, {"error": err[1] if err else "Order failed"}
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return False, {"error": result.comment or f"retcode {result.retcode}", "retcode": result.retcode}
    return True, {"order": result.order, "ticket": result.order, "price": result.price, "volume": result.volume}


def position_close_partial(
    ticket: int,
    symbol: str,
    volume: float,
    position_type: int,
) -> tuple[bool, dict[str, Any]]:
    """
    Close part of an MT5 position by ticket.
    :param ticket: Position ticket from order_send or positions_get.
    :param symbol: MT5 symbol (e.g. EURUSD).
    :param volume: Lot size to close (e.g. 0.5).
    :param position_type: 0 = buy, 1 = sell (from position).
    :return: (success, result dict or error).
    """
    if not MT5_AVAILABLE or mt5 is None:
        return False, {"error": "MetaTrader5 not available"}
    sym = (symbol or "").replace("/", "").strip().upper()
    if not sym:
        return False, {"error": "Invalid symbol"}
    tick = mt5.symbol_info_tick(sym)
    if tick is None:
        return False, {"error": f"Symbol {sym} not found"}
    # Opposite type: close buy with sell, close sell with buy
    close_type = mt5.ORDER_TYPE_SELL if position_type == 0 else mt5.ORDER_TYPE_BUY
    price = float(tick.bid) if position_type == 0 else float(tick.ask)
    request: dict[str, Any] = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": sym,
        "volume": round(volume, 2),
        "type": close_type,
        "position": ticket,
        "price": price,
        "deviation": 20,
        "magic": 0,
        "comment": "cicada-5453-partial",
    }
    result = mt5.order_send(request)
    if result is None:
        err = mt5.last_error()
        return False, {"error": err[1] if err else "Close failed"}
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return False, {"error": result.comment or f"retcode {result.retcode}", "retcode": result.retcode}
    return True, {"ticket": result.order, "volume": result.volume, "price": result.price}


def get_positions() -> list[dict[str, Any]]:
    """
    Get all open positions from MT5.
    :return: List of dicts with ticket, symbol, type (0=buy, 1=sell), volume, price_open, price_current, profit, etc.
    """
    if not MT5_AVAILABLE or mt5 is None:
        return []
    positions = mt5.positions_get()
    if positions is None:
        return []
    out: list[dict[str, Any]] = []
    for p in positions:
        try:
            out.append({
                "ticket": int(getattr(p, "ticket", 0)),
                "symbol": str(getattr(p, "symbol", "")),
                "type": int(getattr(p, "type", 0)),
                "volume": float(getattr(p, "volume", 0)),
                "price_open": float(getattr(p, "price_open", 0)),
                "price_current": float(getattr(p, "price_current", 0)),
                "profit": float(getattr(p, "profit", 0)),
                "sl": float(getattr(p, "sl", 0)) or None,
                "tp": float(getattr(p, "tp", 0)) or None,
                "time": int(getattr(p, "time", 0)),
            })
        except (TypeError, ValueError) as e:
            import logging
            logging.getLogger(__name__).warning("get_positions parse failed for position: %s", e)
            continue
    return out
