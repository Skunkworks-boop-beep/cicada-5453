"""Loss inversion (spec phase 4).

Re-enter every losing trade at the same price point in the opposite
direction. On closed historical bars the fill is guaranteed (we own the
clock); the resulting ``INVERSION`` event row is what the context layer
turns into a fourth-class label proxy.

This module produces events; it does NOT write to SQLite. The context
layer (step 7) is the single sink so the append-only invariant is
enforced in one place.

A "losing" trade is a closed trade with negative realised PnL (long: exit
< entry; short: exit > entry). Spread / slippage is ignored at this stage —
the inversion is a synthetic counterfactual on closed history, not a
broker order.

Exit policy: the inversion exits at the original trade's exit time. This
keeps the synthetic outcome aligned with the geometry the original trade
saw, so the context layer can join cleanly on the bar timestamp.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Sequence


@dataclass(frozen=True)
class InversionEvent:
    """One synthetic counter-trade. Schema is closed: only these fields go
    downstream into ``context_layer.py``."""
    trade_id: str
    original_side: str  # "LONG" / "SHORT"
    inverted_side: str
    entry_time: float
    entry_price: float
    exit_time: float
    exit_price: float
    pnl_synth: float
    event_type: str = "INVERSION"

    def to_dict(self) -> dict:
        return asdict(self)


def _is_losing(side: str, entry: float, exit_: float) -> bool:
    """Closed-trade PnL is loss when long-exit < long-entry or short-exit > short-entry."""
    if entry <= 0 or exit_ <= 0:
        return False
    if side.upper() == "LONG":
        return exit_ < entry
    if side.upper() == "SHORT":
        return exit_ > entry
    return False


def _opposite(side: str) -> str:
    return "SHORT" if side.upper() == "LONG" else "LONG"


def _synth_pnl(inverted_side: str, entry: float, exit_: float) -> float:
    """PnL of the inverted trade. Symmetric to the original under no
    spread/slippage; positive when the inversion would have made money."""
    if inverted_side == "LONG":
        return exit_ - entry
    return entry - exit_


def invert_losing_trades(closed_trades: Sequence[dict]) -> list[InversionEvent]:
    """Walk each closed trade, emit one INVERSION event per losing entry.

    Expected fields per trade dict:
      ``trade_id``, ``side``, ``entry_time``, ``entry_price``,
      ``exit_time``, ``exit_price``.
    Missing fields cause the trade to be skipped silently — the input is
    trusted upstream (closed trades are produced by the daemon, not user
    input).
    """
    out: list[InversionEvent] = []
    for t in closed_trades:
        try:
            tid = str(t["trade_id"])
            side = str(t["side"]).upper()
            entry = float(t["entry_price"])
            exit_ = float(t["exit_price"])
            entry_time = float(t["entry_time"])
            exit_time = float(t["exit_time"])
        except (KeyError, TypeError, ValueError):
            continue
        if not _is_losing(side, entry, exit_):
            continue
        inv_side = _opposite(side)
        out.append(
            InversionEvent(
                trade_id=tid,
                original_side=side,
                inverted_side=inv_side,
                entry_time=entry_time,
                entry_price=entry,
                exit_time=exit_time,
                exit_price=exit_,
                pnl_synth=_synth_pnl(inv_side, entry, exit_),
            )
        )
    return out
