"""HTTP client for the MT5 bridge running inside the Windows VM.

This is the **only** Ubuntu-side module that talks to MT5 — every other
file in ``cicada_nn`` calls into here (or via ``mt5_client``) instead of
importing MetaTrader5 directly. Spec lines 894-1224 ("EXECUTION
ARCHITECTURE — Ubuntu host + KVM Windows VM + native MT5") and Section 7
("MT5 Integration").

Connection failures are typed (``BridgeUnreachableError``,
``BridgeRetcodeError``) and never silently swallowed: a stale model that
trades through a dead bridge is a worse failure than visibly halting.
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional
from urllib.error import URLError
from urllib.request import Request, urlopen
import json


DEFAULT_BASE_URL = os.environ.get("CICADA_BRIDGE_URL", "http://localhost:5000")
DEFAULT_TIMEOUT_S = float(os.environ.get("CICADA_BRIDGE_TIMEOUT_S", "5.0"))

# Stage 2B fix A (architectural review §3.1): cache the reachability probe
# for a short TTL so daemon hot-paths (``mt5_client.is_connected`` /
# ``MT5_AVAILABLE``) don't pay an HTTP roundtrip on every access. With a
# 5s TTL the daemon ticks at scope intervals (15-120s) pay at most ONE
# bridge probe per 5-second window instead of N probes per tick.
_REACHABLE_TTL_S = float(os.environ.get("CICADA_BRIDGE_REACHABLE_TTL_S", "5.0"))
_REACHABLE_LOCK = threading.Lock()
_REACHABLE_CACHE: dict[str, Any] = {"ok": None, "expires": 0.0}


def _reachable_cache_clear() -> None:
    """Reset the reachability cache (used by tests to bypass TTL)."""
    with _REACHABLE_LOCK:
        _REACHABLE_CACHE["ok"] = None
        _REACHABLE_CACHE["expires"] = 0.0


class BridgeError(Exception):
    """Base for all bridge-side failures."""


class BridgeUnreachableError(BridgeError):
    """The bridge HTTP endpoint did not respond (VM down, network down)."""


class BridgeRetcodeError(BridgeError):
    """Bridge responded but MT5 rejected the call (broker-side retcode)."""

    def __init__(self, retcode: int, detail: str) -> None:
        super().__init__(f"retcode={retcode}: {detail}")
        self.retcode = retcode
        self.detail = detail


# Indirection for tests: ``_HTTP`` is callable(method, url, body, timeout) -> dict.
# Default uses urllib so we don't add a hard dependency on `requests`.
def _default_http(method: str, url: str, body: Optional[dict], timeout: float) -> dict:
    data: Optional[bytes] = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as resp:
            payload = resp.read()
    except URLError as e:
        raise BridgeUnreachableError(str(e)) from e
    except OSError as e:  # connection refused, etc.
        raise BridgeUnreachableError(str(e)) from e
    if not payload:
        return {}
    try:
        return json.loads(payload.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise BridgeError(f"non-json response: {e}") from e


HTTPCallable = Callable[[str, str, Optional[dict], float], Any]


@dataclass
class MT5Bridge:
    """HTTP client. One instance per process; thread-safe (urllib is)."""

    base_url: str = DEFAULT_BASE_URL
    timeout_s: float = DEFAULT_TIMEOUT_S
    http: HTTPCallable = _default_http  # injectable for tests

    # ── Public surface (mirrors mt5_client.py method names) ────────────────

    def health_check(self) -> dict:
        return self.http("GET", f"{self.base_url}/health", None, self.timeout_s)

    def get_account(self) -> dict:
        """Stage 2B fix C: full account snapshot from the bridge's
        ``GET /account``. Raises ``BridgeError`` when MT5 isn't connected
        inside the VM (the bridge returns 503 in that case)."""
        return self.http("GET", f"{self.base_url}/account", None, self.timeout_s)

    def login(self, *, account: int, password: str, server: str = "") -> dict:
        """Stage 7: runtime re-authentication. Calls the bridge's
        ``POST /login`` which in turn calls ``mt5.login()`` inside the
        VM. Returns the response payload (``success`` + account info or
        retcode + error). Caller decides what to do with success=False."""
        body = {"login": int(account), "password": password, "server": server}
        return self.http("POST", f"{self.base_url}/login", body, self.timeout_s)

    def place_order(
        self,
        *,
        symbol: str,
        direction: str,
        volume: float,
        sl: float = 0.0,
        tp: float = 0.0,
        magic: int = 0,
        comment: str = "cicada-5453",
        deviation: int = 20,
    ) -> dict:
        body = {
            "symbol": symbol,
            "direction": direction,
            "volume": float(volume),
            "sl": float(sl),
            "tp": float(tp),
            "magic": int(magic),
            "comment": comment,
            "deviation": int(deviation),
        }
        resp = self.http("POST", f"{self.base_url}/order/place", body, self.timeout_s)
        self._raise_if_failed(resp, default_op="place_order")
        return resp

    def modify_sl(self, *, ticket: int, new_sl: float, new_tp: Optional[float] = None) -> dict:
        body: dict[str, Any] = {"ticket": int(ticket), "new_sl": float(new_sl)}
        if new_tp is not None:
            body["new_tp"] = float(new_tp)
        resp = self.http("POST", f"{self.base_url}/order/modify_sl", body, self.timeout_s)
        self._raise_if_failed(resp, default_op="modify_sl")
        return resp

    def close_position(self, *, ticket: int, volume: Optional[float] = None) -> dict:
        body: dict[str, Any] = {"ticket": int(ticket)}
        if volume is not None:
            body["volume"] = float(volume)
        resp = self.http("POST", f"{self.base_url}/order/close", body, self.timeout_s)
        self._raise_if_failed(resp, default_op="close_position")
        return resp

    def get_positions(self) -> list[dict]:
        resp = self.http("GET", f"{self.base_url}/positions", None, self.timeout_s)
        if isinstance(resp, list):
            return resp
        return []

    def get_tick(self, *, symbol: str) -> dict:
        """Single-tick snapshot for live fill-price discovery + intra-bar
        SL/TP checks. Returns ``{symbol, time, bid, ask, spread, server_time_ms}``.
        Raises ``BridgeUnreachableError`` on connect failure and ``BridgeError``
        when the symbol is unknown — callers should catch the latter and fall
        back to bar close so a momentary symbol gap doesn't halt the bot."""
        from urllib.parse import urlencode
        qs = urlencode({"symbol": symbol})
        url = f"{self.base_url}/tick?{qs}"
        resp = self.http("GET", url, None, self.timeout_s)
        if not isinstance(resp, dict):
            raise BridgeError(f"get_tick: unexpected response type {type(resp).__name__}")
        return resp

    def get_ticks(self, *, symbol: str, from_ts: int, to_ts: int) -> list[dict]:
        # Symbol may contain spaces (e.g. "Volatility 10 Index") so query
        # params MUST be url-encoded — raw interpolation 500s the bridge.
        from urllib.parse import urlencode
        qs = urlencode({"symbol": symbol, "from_ts": int(from_ts), "to_ts": int(to_ts)})
        url = f"{self.base_url}/ticks?{qs}"
        resp = self.http("GET", url, None, self.timeout_s)
        return resp if isinstance(resp, list) else []

    def get_history(self, *, symbol: str, timeframe: str, from_ts: int, to_ts: int) -> list[dict]:
        from urllib.parse import urlencode
        qs = urlencode({
            "symbol": symbol,
            "timeframe": timeframe,
            "from_ts": int(from_ts),
            "to_ts": int(to_ts),
        })
        url = f"{self.base_url}/history?{qs}"
        resp = self.http("GET", url, None, self.timeout_s)
        return resp if isinstance(resp, list) else []

    # ── Internals ──────────────────────────────────────────────────────────

    @staticmethod
    def _raise_if_failed(resp: Any, *, default_op: str) -> None:
        if not isinstance(resp, dict):
            raise BridgeError(f"{default_op}: unexpected response type {type(resp).__name__}")
        if resp.get("success") is False:
            retcode = int(resp.get("retcode") or 0)
            detail = str(resp.get("error") or default_op)
            raise BridgeRetcodeError(retcode, detail)


# ── Module-level singleton (lazy) ────────────────────────────────────────────

_BRIDGE: Optional[MT5Bridge] = None


def get_bridge() -> MT5Bridge:
    """Return the shared MT5Bridge for this process."""
    global _BRIDGE
    if _BRIDGE is None:
        _BRIDGE = MT5Bridge()
    return _BRIDGE


def set_bridge(bridge: Optional[MT5Bridge]) -> None:
    """Inject a bridge (typically from tests). ``None`` resets to default.
    Also clears the reachability cache so a freshly-injected bridge is
    probed on the next ``is_reachable`` call regardless of TTL."""
    global _BRIDGE
    _BRIDGE = bridge
    _reachable_cache_clear()


def is_reachable(timeout_s: float = 1.0) -> bool:
    """Cheap probe used by the UI's connection pill and the daemon's startup.

    Stage 2B fix A: the result is cached for ``_REACHABLE_TTL_S`` seconds
    (5s by default) so the daemon's hot path doesn't pay a network round-
    trip on every access. The cache lives in module state guarded by a
    lock so concurrent callers see consistent results."""
    now = time.time()
    with _REACHABLE_LOCK:
        cached_ok = _REACHABLE_CACHE.get("ok")
        if cached_ok is not None and now < float(_REACHABLE_CACHE.get("expires") or 0.0):
            return bool(cached_ok)
    # Save/restore the singleton's timeout — previously this overwrote
    # ``bridge.timeout_s = timeout_s`` and left it clamped to ~1s, so any
    # subsequent large /history response (e.g. 50k M1 bars ≈ 5 MB, ~1s)
    # timed out and surfaced as a spurious "No data" error in /mt5/ohlc.
    bridge = get_bridge()
    original_timeout = bridge.timeout_s
    try:
        bridge.timeout_s = timeout_s
        bridge.health_check()
        ok = True
    except BridgeError:
        ok = False
    finally:
        bridge.timeout_s = original_timeout
    with _REACHABLE_LOCK:
        _REACHABLE_CACHE["ok"] = ok
        _REACHABLE_CACHE["expires"] = now + _REACHABLE_TTL_S
    return ok
