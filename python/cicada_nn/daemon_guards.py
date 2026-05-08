"""Shared thread-safe halt flags for the live trade loop.

Both ``reconciler.py`` (position discrepancy detected) and
``drift_monitor.py`` (drift threshold breached) raise halts that the
``daemon_runtime.daemon_submit_order`` path checks before placing any
new MT5 order. Lives in its own tiny module so the three files form a
clean diamond dependency rather than a cycle.

Design notes:
* ``new_orders_halted`` blocks fresh entries but lets the SL/TP manager
  keep advancing existing positions — exits should still fire.
* ``emergency_stopped`` is a harder halt: deploy is blocked, order
  modifications are blocked, and the daemon expects manual resume via
  ``POST /drift/resume`` (gated by ``CICADA_API_KEY`` when set).
* The ``reason`` is human-readable and surfaces on
  ``GET /drift/status`` + ``GET /reconcile/status`` so operators can
  see *why* trading stopped without spelunking logs.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class GuardEvent:
    """One halt event. Append-only history kept in ``DaemonGuards``."""

    ts: float
    kind: str  # 'halt_orders' | 'emergency_stop' | 'resume' | 'clear'
    source: str  # 'reconciler' | 'drift' | 'manual'
    reason: str


@dataclass
class DaemonGuards:
    """Thread-safe halt-flag container.

    A single shared instance lives at module level (see :data:`GUARDS`
    below); the daemon, reconciler, drift monitor, and API endpoints all
    read and write through it.
    """

    new_orders_halted: bool = False
    emergency_stopped: bool = False
    halt_reason: Optional[str] = None
    emergency_reason: Optional[str] = None
    history: list[GuardEvent] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # ── Mutators ───────────────────────────────────────────────────────

    def halt_new_orders(self, *, source: str, reason: str) -> None:
        with self._lock:
            self.new_orders_halted = True
            self.halt_reason = reason
            self.history.append(
                GuardEvent(ts=time.time(), kind="halt_orders", source=source, reason=reason)
            )

    def emergency_stop(self, *, source: str, reason: str) -> None:
        """Hard stop. Implies ``new_orders_halted`` too."""
        with self._lock:
            self.new_orders_halted = True
            self.emergency_stopped = True
            self.halt_reason = reason
            self.emergency_reason = reason
            self.history.append(
                GuardEvent(ts=time.time(), kind="emergency_stop", source=source, reason=reason)
            )

    def resume(self, *, source: str, reason: str = "manual resume") -> None:
        """Lift both halts. Logs the resume to history."""
        with self._lock:
            self.new_orders_halted = False
            self.emergency_stopped = False
            self.halt_reason = None
            self.emergency_reason = None
            self.history.append(
                GuardEvent(ts=time.time(), kind="resume", source=source, reason=reason)
            )

    def clear_halt_only(self, *, source: str, reason: str = "auto clear") -> None:
        """Lift the soft halt but leave any emergency_stop in place. Used
        by drift_monitor when its triggering condition normalises."""
        with self._lock:
            if self.emergency_stopped:
                # Don't auto-clear past an emergency — operator must resume.
                return
            self.new_orders_halted = False
            self.halt_reason = None
            self.history.append(
                GuardEvent(ts=time.time(), kind="clear", source=source, reason=reason)
            )

    # ── Read API (snapshots; callers should not pass these around) ────

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "new_orders_halted": self.new_orders_halted,
                "emergency_stopped": self.emergency_stopped,
                "halt_reason": self.halt_reason,
                "emergency_reason": self.emergency_reason,
                "history": [
                    {"ts": e.ts, "kind": e.kind, "source": e.source, "reason": e.reason}
                    for e in self.history[-50:]  # cap so the JSON stays small
                ],
            }


# ── Module-level singleton ───────────────────────────────────────────

GUARDS: DaemonGuards = DaemonGuards()


def get_guards() -> DaemonGuards:
    return GUARDS


def reset_guards() -> None:
    """Test helper. Resets the module-level instance."""
    global GUARDS
    GUARDS = DaemonGuards()
