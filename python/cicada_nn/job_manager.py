"""
Cross-request job registry for long-running backend tasks.

Used by research + backtest streaming endpoints and the shadow-training
workers to give the UI a single view of "what's running now, where, and for
whom". Previously these were each their own ad-hoc progress state; the front-
end could see its own job but could not see another session's.

Design:

* In-memory registry guarded by a single lock (FastAPI runs one worker by
  default; multi-worker deployments share the storage-backed snapshot).
* Every job has a ``cancel_token`` (an ``threading.Event``) that workers
  should check periodically. ``cancel_job(id)`` sets the event.
* Progress/percent/status updates push back into the registry so the UI can
  poll ``/jobs`` every second or two.
* Registry survives in-process; restart clears non-persistent jobs but the
  ``SHADOW_REGISTRY`` (filesystem JSON) carries shadow jobs across restarts.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Optional

from .storage import JsonFileStore


logger = logging.getLogger(__name__)


JobKind = str  # "backtest" | "research" | "shadow" | "backward_validation" | ...
JobStatus = str  # "queued" | "running" | "succeeded" | "failed" | "cancelled"


@dataclass
class JobRecord:
    job_id: str
    kind: JobKind
    title: str
    status: JobStatus = "queued"
    progress: float = 0.0  # 0..100
    message: str = ""
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    created_at: str = ""
    meta: dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class JobManager:
    """Thread-safe in-memory job registry with cooperative cancellation."""

    MAX_JOBS = 500

    def __init__(self) -> None:
        self._lock = threading.RLock()
        checkpoint_dir = Path(os.environ.get("CICADA_NN_CHECKPOINTS", "checkpoints"))
        self._store = JsonFileStore(checkpoint_dir / "jobs.json", default_factory=list)
        self._jobs: dict[str, JobRecord] = {}
        self._cancel_tokens: dict[str, threading.Event] = {}
        self._load_persisted()

    # ── Lifecycle ────────────────────────────────────────────────────────

    def create(self, kind: JobKind, title: str, meta: dict[str, Any] | None = None) -> JobRecord:
        job_id = f"{kind}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
        now = _iso_now()
        rec = JobRecord(
            job_id=job_id,
            kind=kind,
            title=title,
            status="queued",
            created_at=now,
            meta=dict(meta or {}),
        )
        with self._lock:
            self._jobs[job_id] = rec
            self._cancel_tokens[job_id] = threading.Event()
            # Evict old finished jobs if we've exceeded the cap.
            if len(self._jobs) > self.MAX_JOBS:
                self._evict_oldest_finished()
            self._persist_locked()
        logger.info("job created", extra={"job_id": job_id, "kind": kind})
        return rec

    def mark_running(self, job_id: str, message: str = "") -> None:
        self._update(job_id, status="running", started_at=_iso_now(), message=message)
        _publish_event("job", kind="running", job_id=job_id, message=message)

    def update_progress(self, job_id: str, progress: float, message: str = "") -> None:
        with self._lock:
            rec = self._jobs.get(job_id)
            if rec is None:
                return
            rec.progress = max(0.0, min(100.0, float(progress)))
            if message:
                rec.message = message
            self._persist_locked()
        # Throttling at the bus level avoids saturating slow consumers.
        _publish_event("job", kind="progress", job_id=job_id, progress=progress, message=message)

    def mark_done(self, job_id: str, *, succeeded: bool = True, error: str | None = None, message: str = "") -> None:
        self._update(
            job_id,
            status="succeeded" if succeeded else "failed",
            finished_at=_iso_now(),
            error=error,
            message=message or ("completed" if succeeded else "failed"),
            progress=100.0 if succeeded else None,
        )
        with self._lock:
            ev = self._cancel_tokens.pop(job_id, None)
            if ev:
                ev.set()  # wake any waiter
        _publish_event(
            "job",
            kind="succeeded" if succeeded else "failed",
            job_id=job_id,
            error=error,
            message=message,
        )

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            rec = self._jobs.get(job_id)
            if rec is None or rec.status in {"succeeded", "failed", "cancelled"}:
                return False
            ev = self._cancel_tokens.get(job_id)
            if ev is not None:
                ev.set()
            rec.status = "cancelled"
            rec.finished_at = _iso_now()
            rec.message = "cancelled"
            self._persist_locked()
        logger.info("job cancelled", extra={"job_id": job_id})
        return True

    def mark_active_stopped(self, reason: str = "backend shutdown") -> int:
        """Mark in-flight jobs as cancelled because this process is stopping.

        Streaming jobs cannot continue after uvicorn shuts down. Persisting this
        state prevents the monitor from showing ghost "running" jobs after a
        restart and gives the operator a clear audit trail.
        """
        now = _iso_now()
        stopped = 0
        with self._lock:
            for rec in self._jobs.values():
                if rec.status in {"queued", "running"}:
                    rec.status = "cancelled"
                    rec.finished_at = rec.finished_at or now
                    rec.message = reason
                    rec.error = rec.error or reason
                    stopped += 1
            if stopped:
                self._persist_locked()
        if stopped:
            logger.info("marked %s active job(s) stopped: %s", stopped, reason)
        return stopped

    def cancel_token(self, job_id: str) -> threading.Event:
        with self._lock:
            return self._cancel_tokens.setdefault(job_id, threading.Event())

    def should_cancel(self, job_id: str) -> bool:
        with self._lock:
            ev = self._cancel_tokens.get(job_id)
            return bool(ev and ev.is_set())

    # ── Queries ──────────────────────────────────────────────────────────

    def get(self, job_id: str) -> Optional[JobRecord]:
        with self._lock:
            rec = self._jobs.get(job_id)
            return JobRecord(**asdict(rec)) if rec else None

    def list(self, kind: Optional[JobKind] = None, active_only: bool = False) -> list[JobRecord]:
        with self._lock:
            rows = list(self._jobs.values())
        if kind:
            rows = [r for r in rows if r.kind == kind]
        if active_only:
            rows = [r for r in rows if r.status in {"queued", "running"}]
        rows.sort(key=lambda r: r.created_at or "", reverse=True)
        return [JobRecord(**asdict(r)) for r in rows]

    # ── Internals ────────────────────────────────────────────────────────

    def _update(self, job_id: str, **fields: Any) -> None:
        with self._lock:
            rec = self._jobs.get(job_id)
            if rec is None:
                return
            for key, value in fields.items():
                if value is None:
                    continue
                setattr(rec, key, value)
            self._persist_locked()

    def _evict_oldest_finished(self) -> None:
        finished = [
            (r.created_at, r.job_id)
            for r in self._jobs.values()
            if r.status in {"succeeded", "failed", "cancelled"}
        ]
        finished.sort()
        for _, jid in finished[: max(0, len(self._jobs) - self.MAX_JOBS)]:
            self._jobs.pop(jid, None)
            self._cancel_tokens.pop(jid, None)

    def _load_persisted(self) -> None:
        rows = self._store.read() or []
        if not isinstance(rows, list):
            return
        now = _iso_now()
        loaded = 0
        for row in rows[-self.MAX_JOBS:]:
            if not isinstance(row, dict):
                continue
            try:
                rec = JobRecord(
                    job_id=str(row.get("job_id") or ""),
                    kind=str(row.get("kind") or "unknown"),
                    title=str(row.get("title") or "untitled job"),
                    status=str(row.get("status") or "queued"),
                    progress=float(row.get("progress") or 0.0),
                    message=str(row.get("message") or ""),
                    started_at=row.get("started_at"),
                    finished_at=row.get("finished_at"),
                    created_at=str(row.get("created_at") or now),
                    meta=dict(row.get("meta") or {}),
                    error=row.get("error"),
                )
            except (TypeError, ValueError):
                logger.debug("skipping malformed persisted job row: %r", row)
                continue
            if not rec.job_id:
                continue
            if rec.status in {"queued", "running"}:
                rec.status = "cancelled"
                rec.finished_at = rec.finished_at or now
                rec.message = rec.message or "interrupted by backend restart"
                rec.error = rec.error or "backend restarted before this job completed"
            self._jobs[rec.job_id] = rec
            loaded += 1
        if loaded:
            self._persist_locked()
            logger.info("loaded %s persisted job(s)", loaded)

    def _persist_locked(self) -> None:
        rows = list(self._jobs.values())
        rows.sort(key=lambda r: r.created_at or "")
        if len(rows) > self.MAX_JOBS:
            rows = rows[-self.MAX_JOBS:]
            self._jobs = {r.job_id: r for r in rows}
        self._store.write([r.to_dict() for r in rows])


def _iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _publish_event(topic: str, **payload: Any) -> None:
    """Bridge job lifecycle changes to the SSE bus without making the manager
    care whether the bus exists. Best-effort — never raises."""
    try:
        from .event_bus import EVENT_BUS
        EVENT_BUS.publish(topic, **payload)
    except Exception:
        logger.debug("publish event failed", exc_info=True)


# Process-wide singleton used by the FastAPI routes.
JOB_MANAGER = JobManager()
