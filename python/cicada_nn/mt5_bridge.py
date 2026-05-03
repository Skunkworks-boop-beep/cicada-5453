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
from dataclasses import dataclass
from typing import Any, Callable, Optional
from urllib.error import URLError
from urllib.request import Request, urlopen
import json


DEFAULT_BASE_URL = os.environ.get("CICADA_BRIDGE_URL", "http://localhost:5000")
DEFAULT_TIMEOUT_S = float(os.environ.get("CICADA_BRIDGE_TIMEOUT_S", "5.0"))


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

    def get_ticks(self, *, symbol: str, from_ts: int, to_ts: int) -> list[dict]:
        url = f"{self.base_url}/ticks?symbol={symbol}&from_ts={int(from_ts)}&to_ts={int(to_ts)}"
        resp = self.http("GET", url, None, self.timeout_s)
        return resp if isinstance(resp, list) else []

    def get_history(self, *, symbol: str, timeframe: str, from_ts: int, to_ts: int) -> list[dict]:
        url = (
            f"{self.base_url}/history"
            f"?symbol={symbol}&timeframe={timeframe}"
            f"&from_ts={int(from_ts)}&to_ts={int(to_ts)}"
        )
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
    """Inject a bridge (typically from tests). ``None`` resets to default."""
    global _BRIDGE
    _BRIDGE = bridge


def is_reachable(timeout_s: float = 1.0) -> bool:
    """Cheap probe used by the UI's connection pill and the daemon's startup."""
    bridge = get_bridge()
    try:
        bridge.timeout_s = timeout_s
        bridge.health_check()
        return True
    except BridgeError:
        return False
