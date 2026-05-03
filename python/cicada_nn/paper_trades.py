"""
Paper-trade tracker for "learn while idle" mode.

The frontend already runs the full pipeline (fetch → regime → predict →
ensemble → risk) when execution is paused but the bot is deployed; today the
order placement is the only thing skipped. The signals that fired are
emitted as ``order skip — execution_paused_observe`` events but no follow-up
exit is recorded — so the system has *no labels* for what would have happened
if the trade had been opened.

This module fixes that. Every "would-have-entered" signal becomes an open
paper-trade record. On every subsequent tick the tracker advances each open
paper trade with the latest bar (close, high, low) and closes it when the
stop or target levels are hit, or when ``max_hold_bars`` elapses. The closed
paper-trade ledger feeds the closed-trade based shadow-training pipeline so
the model gets real OOS labels even when the bot wasn't allowed to trade.

Persistence: same atomic JsonFileStore used everywhere else (paper_trades.json
in the checkpoints dir). Crash-safe across restarts.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

from .storage import JsonFileStore


logger = logging.getLogger(__name__)


@dataclass
class PaperTrade:
    """A single observe-mode "would-have-entered" record."""

    id: str
    bot_id: str
    instrument_id: str
    instrument_symbol: str
    side: str  # 'LONG' | 'SHORT'
    entry_price: float
    stop_loss: float
    take_profit: float
    size: float
    timeframe: str
    scope: str
    opened_at: float = field(default_factory=lambda: time.time())
    closed_at: float | None = None
    exit_price: float | None = None
    exit_reason: str | None = None  # 'stop' | 'target' | 'time' | 'forced'
    pnl: float | None = None
    pnl_pct: float | None = None
    hold_bars: int = 0
    # Optional: NN confidence + warning at the time of decision.
    nn_confidence: float | None = None
    nn_warning: str | None = None

    @property
    def is_open(self) -> bool:
        return self.closed_at is None


class PaperTradeStore:
    """Thread-safe paper-trade ledger backed by an atomic JSON file."""

    DEFAULT_MAX_OPEN = 200
    DEFAULT_MAX_HISTORY = 2000

    def __init__(self, checkpoint_dir: Path):
        self._lock = threading.RLock()
        self._store = JsonFileStore(
            Path(checkpoint_dir) / "paper_trades.json",
            default_factory=lambda: {"open": [], "closed": []},
        )

    # ── CRUD ────────────────────────────────────────────────────────────

    def open(self, trade: PaperTrade) -> None:
        with self._lock:
            data = self._store.read() or {"open": [], "closed": []}
            data["open"].append(asdict(trade))
            data["open"] = data["open"][-self.DEFAULT_MAX_OPEN :]
            self._store.write(data)

    def list_open(self, bot_id: str | None = None) -> list[PaperTrade]:
        with self._lock:
            data = self._store.read() or {"open": [], "closed": []}
            rows = [PaperTrade(**r) for r in data.get("open", [])]
        if bot_id:
            rows = [r for r in rows if r.bot_id == bot_id]
        return rows

    def list_closed(self, bot_id: str | None = None, limit: int = 200) -> list[PaperTrade]:
        with self._lock:
            data = self._store.read() or {"open": [], "closed": []}
            rows = [PaperTrade(**r) for r in data.get("closed", [])]
        if bot_id:
            rows = [r for r in rows if r.bot_id == bot_id]
        return rows[-limit:]

    def close(self, trade: PaperTrade) -> None:
        with self._lock:
            data = self._store.read() or {"open": [], "closed": []}
            data["open"] = [r for r in data.get("open", []) if r.get("id") != trade.id]
            data["closed"].append(asdict(trade))
            data["closed"] = data["closed"][-self.DEFAULT_MAX_HISTORY :]
            self._store.write(data)

    # ── Tick advance ────────────────────────────────────────────────────

    def advance(
        self,
        bot_id: str,
        latest_bar: dict[str, Any],
        max_hold_bars: int = 50,
    ) -> list[PaperTrade]:
        """Walk every open paper trade for ``bot_id`` forward by one bar.

        Closes trades that hit stop or target during the bar (intrabar high
        triggers target for LONG, intrabar low triggers stop; mirrored for
        SHORT). Time-stops trades older than ``max_hold_bars`` ticks. Returns
        the newly-closed trades for upstream emission to the event bus."""
        h = float(latest_bar.get("high") or 0.0)
        lo = float(latest_bar.get("low") or 0.0)
        c = float(latest_bar.get("close") or 0.0)
        if h <= 0 and lo <= 0 and c <= 0:
            return []

        closed_now: list[PaperTrade] = []
        with self._lock:
            data = self._store.read() or {"open": [], "closed": []}
            still_open: list[dict] = []
            for raw in data.get("open", []):
                if raw.get("bot_id") != bot_id:
                    still_open.append(raw)
                    continue
                t = PaperTrade(**raw)
                t.hold_bars += 1
                exit_price: float | None = None
                exit_reason: str | None = None
                if t.side == "LONG":
                    if lo <= t.stop_loss:
                        exit_price, exit_reason = t.stop_loss, "stop"
                    elif h >= t.take_profit:
                        exit_price, exit_reason = t.take_profit, "target"
                else:  # SHORT
                    if h >= t.stop_loss:
                        exit_price, exit_reason = t.stop_loss, "stop"
                    elif lo <= t.take_profit:
                        exit_price, exit_reason = t.take_profit, "target"
                if exit_price is None and t.hold_bars >= max_hold_bars:
                    exit_price, exit_reason = c, "time"
                if exit_price is None:
                    raw["hold_bars"] = t.hold_bars
                    still_open.append(raw)
                    continue
                t.closed_at = time.time()
                t.exit_price = exit_price
                t.exit_reason = exit_reason
                if t.side == "LONG":
                    t.pnl = (exit_price - t.entry_price) * t.size
                else:
                    t.pnl = (t.entry_price - exit_price) * t.size
                t.pnl_pct = (t.pnl / (t.entry_price * t.size)) * 100 if t.entry_price * t.size else 0.0
                data["closed"].append(asdict(t))
                closed_now.append(t)
            data["open"] = still_open
            data["closed"] = data["closed"][-self.DEFAULT_MAX_HISTORY :]
            self._store.write(data)
        return closed_now

    # ── Stats helpers ───────────────────────────────────────────────────

    def stats(self, bot_id: str | None = None) -> dict[str, Any]:
        """Win-rate / PnL summary for the closed paper-trade ledger.
        Used by the FE to show "if execution had been on" preview."""
        closed = self.list_closed(bot_id=bot_id, limit=self.DEFAULT_MAX_HISTORY)
        if not closed:
            return {"n": 0, "win_rate": 0.0, "total_pnl": 0.0, "avg_pnl": 0.0}
        wins = [t for t in closed if (t.pnl or 0) > 0]
        losses = [t for t in closed if (t.pnl or 0) < 0]
        total = sum((t.pnl or 0) for t in closed)
        return {
            "n": len(closed),
            "win_rate": len(wins) / len(closed),
            "total_pnl": total,
            "avg_pnl": total / len(closed),
            "wins": len(wins),
            "losses": len(losses),
            "open": len(self.list_open(bot_id=bot_id)),
        }
