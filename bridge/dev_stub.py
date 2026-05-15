"""DEV-ONLY: stub MT5 bridge runnable on Linux/macOS for UI verification.

Spec says the bridge runs inside a Windows VM (only place MetaTrader5 can
import). For development on a non-Windows host we use a fake MetaTrader5
module — same surface the contract tests use — so the dashboard sees a
working bridge end-to-end without operator VM setup.

USAGE
-----
    python -m bridge.dev_stub                 # listens on localhost:5000
    python -m bridge.dev_stub --port 5000     # explicit port
    python -m bridge.dev_stub --account 12345 # custom account login

The stub:
  - Reports MT5 connected with the configured account.
  - /account returns realistic balance/equity/leverage values.
  - /positions returns empty by default.
  - /order/place returns a deterministic ticket sequence.
  - /ticks and /history return small synthetic series so the UI renders.

LIMITATIONS
-----------
  * No real broker behind it — placed orders are confirmed but no money
    moves.
  * No real ticks — synthetic random walk.
  * Sufficient for: dashboard verification, Beehive rendering, bot
    deploy flow, latency monitor populating, drift/reconcile UI.
  * NOT sufficient for: actual paper trading, backtests against real
    history, model training.

For real demo-account testing you need the production bridge running
inside a Windows VM with MT5 logged into a broker demo account. See
``bridge/SETUP_RUNBOOK.md``.
"""

from __future__ import annotations

import argparse
import math
import sys
import time
import types
from datetime import datetime, timezone
from pathlib import Path


def _build_stub_mt5(account_login: str = "12345", balance: float = 10_000.0) -> types.SimpleNamespace:
    """Mirror of bridge/test_bridge_contract.py:_build_stub_mt5 with a few
    extras for live UI behaviour (ticks + bars + account_info return real
    numbers instead of the test placeholders)."""

    state: dict = {
        "positions": [],
        "next_ticket": 1000,
        "balance": balance,
        "equity": balance,
        "profit": 0.0,
    }

    class _Tick:
        def __init__(self, bid: float, ask: float):
            self.bid = bid
            self.ask = ask

    def symbol_info_tick(symbol: str):
        # Synthetic price — slow random walk centered on 1.0.
        t = time.time()
        bid = 1.0 + 0.001 * math.sin(t / 47) + 0.0003 * math.cos(t / 11)
        ask = bid + 0.00015
        return _Tick(bid=bid, ask=ask)

    def order_send(req: dict):
        retcode = 10009  # TRADE_RETCODE_DONE
        ticket = state["next_ticket"]
        state["next_ticket"] += 1
        action = int(req.get("action") or 0)
        # 1 = TRADE_ACTION_DEAL, 6 = TRADE_ACTION_SLTP
        if action == 1:
            # Open a new position OR close one (when 'position' field present).
            if "position" in req:
                # Close — drop the matching ticket from positions.
                ticket_to_close = int(req.get("position") or 0)
                state["positions"] = [p for p in state["positions"] if int(getattr(p, "ticket", 0)) != ticket_to_close]
            else:
                # New position.
                tick_now = symbol_info_tick(req.get("symbol", "EURUSD"))
                price = float(tick_now.ask if int(req.get("type") or 0) == 0 else tick_now.bid)
                p = types.SimpleNamespace(
                    ticket=ticket,
                    symbol=str(req.get("symbol") or "EURUSD"),
                    type=int(req.get("type") or 0),
                    volume=float(req.get("volume") or 0.0),
                    price_open=price,
                    sl=float(req.get("sl") or 0.0),
                    tp=float(req.get("tp") or 0.0),
                    profit=0.0,
                    magic=int(req.get("magic") or 0),
                    comment=str(req.get("comment") or ""),
                    time=int(time.time()),
                )
                state["positions"].append(p)
        elif action == 6:
            # SL/TP modify — update the existing position.
            ticket_id = int(req.get("position") or 0)
            for p in state["positions"]:
                if int(getattr(p, "ticket", 0)) == ticket_id:
                    if req.get("sl") is not None:
                        p.sl = float(req["sl"])
                    if req.get("tp") is not None:
                        p.tp = float(req["tp"])
                    break
        return types.SimpleNamespace(
            retcode=retcode,
            order=ticket,
            price=float(req.get("price") or 1.0),
            volume=float(req.get("volume") or 0.0),
            time=int(time.time()),
            comment="dev-stub fill",
        )

    def positions_get(ticket: int | None = None):
        if ticket is not None:
            return [p for p in state["positions"] if int(getattr(p, "ticket", 0)) == int(ticket)]
        return list(state["positions"])

    def copy_ticks_range(symbol, dt_from, dt_to, _flags):
        # Generate one synthetic tick per second across the range.
        from_ts = int(dt_from.timestamp())
        to_ts = int(dt_to.timestamp())
        out = []
        # Cap to ~5,000 ticks to keep the response small.
        step = max(1, (to_ts - from_ts) // 5_000)
        for ts in range(from_ts, to_ts, step):
            base = 1.0 + 0.001 * math.sin(ts / 47)
            out.append({"time": ts, "bid": base, "ask": base + 0.00015, "volume": 1.0})
        return _AsRecArray(out, ["time", "bid", "ask", "volume"])

    def copy_rates_range(symbol, _tf, dt_from, dt_to):
        from_ts = int(dt_from.timestamp())
        to_ts = int(dt_to.timestamp())
        # 1m bars across the range.
        step = 60
        out = []
        for ts in range(from_ts, to_ts, step):
            base = 1.0 + 0.001 * math.sin(ts / 47)
            wobble = 0.0003 * math.cos(ts / 11)
            out.append({
                "time": ts,
                "open": base,
                "high": base + abs(wobble),
                "low": base - abs(wobble),
                "close": base + wobble,
                "tick_volume": 100,
            })
        return _AsRecArray(out, ["time", "open", "high", "low", "close", "tick_volume"])

    def account_info():
        # Fluctuating equity for a livelier dashboard.
        equity = state["balance"] + state["profit"] + 0.5 * math.sin(time.time() / 30)
        return types.SimpleNamespace(
            login=int(state.get("current_login") or account_login) if str(state.get("current_login") or account_login).isdigit() else 12345,
            server=str(state.get("current_server") or "DevStub-Demo"),
            currency="USD",
            balance=state["balance"],
            equity=round(equity, 2),
            leverage=200,
            margin=0.0,
            margin_free=round(equity, 2),
            profit=state["profit"],
            trade_allowed=True,
            company="Cicada Dev Stub",
        )

    def login(account_id, password=None, server=None):
        """Stage 7 dev-stub login — accepts any non-empty creds + a
        password that doesn't contain 'wrong'/'bad'/'fail' so the
        operator can deliberately exercise the failure path. Real
        broker validation requires the production bridge inside a
        Windows VM with MT5 logged into a broker account.

        Stage 8: also sets a meaningful ``last_error`` tuple so the
        dashboard's failure banner shows something useful instead of
        the previous '(0, "ok")' placeholder."""
        if not account_id or str(account_id).strip() in ("", "0"):
            state["last_error"] = (10004, "Invalid account: account number is empty or zero")
            return False
        if password and any(t in str(password).lower() for t in ("wrong", "bad", "fail")):
            state["last_error"] = (10004, "Invalid credentials: password rejected by stub")
            return False
        try:
            n = int(str(account_id).strip())
            if n < 1000:
                state["last_error"] = (10004, f"Invalid account: {n} is below the stub minimum (1000)")
                return False
        except ValueError:
            state["last_error"] = (10004, f"Invalid account: {account_id!r} is not numeric")
            return False
        state["current_login"] = str(account_id)
        if server:
            state["current_server"] = str(server)
        state["last_error"] = (0, "Success")
        return True

    def last_error():
        return state.get("last_error", (0, "ok"))

    stub = types.SimpleNamespace(
        # Constants chosen to mirror real MT5 values where the bridge's
        # responses depend on them.
        ORDER_TYPE_BUY=0,
        ORDER_TYPE_SELL=1,
        TRADE_ACTION_DEAL=1,
        TRADE_ACTION_SLTP=6,
        TRADE_RETCODE_DONE=10009,
        COPY_TICKS_ALL=0,
        TIMEFRAME_M1=1, TIMEFRAME_M5=5, TIMEFRAME_M15=15, TIMEFRAME_M30=30,
        TIMEFRAME_H1=16385, TIMEFRAME_H4=16388, TIMEFRAME_D1=16408, TIMEFRAME_W1=32769,
        symbol_info_tick=symbol_info_tick,
        order_send=order_send,
        positions_get=positions_get,
        copy_ticks_range=copy_ticks_range,
        copy_rates_range=copy_rates_range,
        copy_rates_from_pos=lambda sym, _tf, _pos, n: copy_rates_range(sym, _tf, datetime.fromtimestamp(time.time() - n * 60, tz=timezone.utc), datetime.fromtimestamp(time.time(), tz=timezone.utc)),
        account_info=account_info,
        login=login,
        last_error=last_error,
        symbol_select=lambda *_a, **_k: True,
    )
    return stub


class _FakeRow:
    """One row of an MT5 structured array. Mimics numpy field access via
    ``r['name']`` and exposes ``r.dtype.names`` so server.py iteration
    works against the stub the same way it does against real MT5
    output."""

    def __init__(self, fields: dict, names: tuple):
        self._fields = fields
        self.dtype = types.SimpleNamespace(names=names)

    def __getitem__(self, k):
        return self._fields[k]

    def __contains__(self, k):
        return k in self._fields


class _AsRecArray:
    """Mimic numpy structured array surface that bridge/server.py iterates.
    Exposes ``dtype.names`` and ``__iter__`` over rows that themselves
    behave like structured-array rows."""

    def __init__(self, rows: list[dict], names: list[str]):
        self._names = tuple(names)
        self._rows = [_FakeRow(r, self._names) for r in rows]
        self.dtype = types.SimpleNamespace(names=self._names)

    def __iter__(self):
        return iter(self._rows)

    def __len__(self):
        return len(self._rows)


def main() -> int:
    ap = argparse.ArgumentParser(description="DEV-ONLY stub MT5 bridge")
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--account", default="12345")
    ap.add_argument("--balance", type=float, default=10_000.0)
    args = ap.parse_args()

    # Inject the stub BEFORE bridge.server imports MetaTrader5.
    stub = _build_stub_mt5(account_login=args.account, balance=args.balance)
    sys.modules["MetaTrader5"] = stub  # type: ignore[assignment]

    # Repo root → sys.path so `from bridge import server` works.
    repo_root = Path(__file__).resolve().parents[1]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    print(f"[dev-stub] starting fake MT5 bridge on {args.host}:{args.port}")
    print(f"[dev-stub] account={args.account}  balance={args.balance:.2f}  server=DevStub-Demo")
    print(f"[dev-stub] WARNING: fake fills only — no real broker behind this.")
    print(f"[dev-stub] for real demo trading, use bridge/SETUP_RUNBOOK.md\n")

    import uvicorn
    from bridge import server as srv  # type: ignore  # noqa: E402
    uvicorn.run(srv.app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
