"""Bridge supervisor — restart on crash.

Stage 7 / Stage 6: when bridge/server.py crashes inside the Windows VM,
the daemon's order placement stops with no visibility. This watchdog
runs alongside the bridge, polls ``/health`` every 5 seconds, and
restarts the bridge process after 3 consecutive failures.

USAGE
-----
Inside the Windows VM (or any host running the bridge):

    python -m bridge.watchdog \
        --uvicorn-cmd "uvicorn bridge.server:app --host 0.0.0.0 --port 5000" \
        --health-url "http://localhost:5000/health" \
        --log /var/log/cicada-bridge-watchdog.log

The watchdog spawns the bridge subprocess and supervises it. On three
consecutive failed health probes, it kills the subprocess and respawns.
Every restart is logged with a timestamp + reason.

Add as a recommended boot-time service in ``bridge/SETUP_RUNBOOK.md`` —
this script replaces the bare ``uvicorn bridge.server:app`` invocation
the runbook currently lists.
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import os
import shlex
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional
from urllib.error import URLError
from urllib.request import urlopen


logger = logging.getLogger("bridge.watchdog")


# ── Health probe ────────────────────────────────────────────────────


def probe_health(url: str, timeout_s: float = 3.0, *, opener=None) -> tuple[bool, str]:
    """Probe the bridge's GET /health. Returns (ok, detail).

    ``opener`` is the urlopen-shaped callable used to make the request;
    overridable in tests to avoid real network I/O. Default is the
    module-level urlopen."""
    fn = opener if opener is not None else urlopen
    try:
        with fn(url, timeout=timeout_s) as resp:
            if resp.status != 200:
                return False, f"http {resp.status}"
            body = resp.read().decode("utf-8", errors="replace")
            if '"status":"ok"' not in body and '"status": "ok"' not in body:
                return False, f"unexpected body: {body[:80]}"
            return True, "ok"
    except URLError as e:
        return False, f"unreachable: {e}"
    except OSError as e:
        return False, f"oserror: {e}"


# ── Subprocess supervision ─────────────────────────────────────────


class BridgeProcess:
    """Wraps the uvicorn subprocess. Spawn / kill / replace."""

    def __init__(self, cmd: list[str], cwd: Path | None = None):
        self._cmd = cmd
        self._cwd = cwd
        self._proc: Optional[subprocess.Popen] = None

    def start(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            return  # already running
        logger.info("starting bridge: %s", " ".join(self._cmd))
        self._proc = subprocess.Popen(
            self._cmd,
            cwd=self._cwd,
            stdout=sys.stdout,
            stderr=sys.stderr,
        )
        logger.info("bridge started pid=%d", self._proc.pid)

    def stop(self, *, grace_s: float = 5.0) -> None:
        if self._proc is None or self._proc.poll() is not None:
            return
        logger.info("stopping bridge pid=%d", self._proc.pid)
        try:
            self._proc.terminate()
            self._proc.wait(timeout=grace_s)
        except subprocess.TimeoutExpired:
            logger.warning("bridge did not exit in %.1fs; killing pid=%d", grace_s, self._proc.pid)
            self._proc.kill()
            self._proc.wait()
        self._proc = None

    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None


# ── Main loop ──────────────────────────────────────────────────────


def supervise(
    *,
    cmd: list[str],
    cwd: Path | None,
    health_url: str,
    poll_s: float,
    failure_threshold: int,
    max_restarts_per_hour: int,
) -> int:
    """Run the supervision loop. Returns exit code (0 on graceful Ctrl-C)."""
    bridge = BridgeProcess(cmd, cwd=cwd)
    bridge.start()

    consecutive_failures = 0
    restart_times: list[float] = []
    stopping = False

    def _on_signal(signum, _frame):
        nonlocal stopping
        logger.info("received signal %d; shutting down", signum)
        stopping = True

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    try:
        while not stopping:
            time.sleep(poll_s)
            if not bridge.alive():
                logger.warning("bridge subprocess exited unexpectedly; respawning")
                consecutive_failures = 0
                _record_restart(restart_times)
                if _restart_storm(restart_times, max_restarts_per_hour):
                    logger.error("restart storm: >%d in last hour; backing off 60s", max_restarts_per_hour)
                    time.sleep(60)
                bridge.start()
                continue

            ok, detail = probe_health(health_url, timeout_s=poll_s)
            if ok:
                if consecutive_failures > 0:
                    logger.info("bridge healthy again after %d failure(s)", consecutive_failures)
                consecutive_failures = 0
            else:
                consecutive_failures += 1
                logger.warning("health probe %d/%d failed: %s",
                               consecutive_failures, failure_threshold, detail)
                if consecutive_failures >= failure_threshold:
                    logger.error("restarting bridge after %d consecutive failures", consecutive_failures)
                    bridge.stop()
                    consecutive_failures = 0
                    _record_restart(restart_times)
                    if _restart_storm(restart_times, max_restarts_per_hour):
                        logger.error("restart storm: >%d in last hour; backing off 60s", max_restarts_per_hour)
                        time.sleep(60)
                    bridge.start()
    finally:
        bridge.stop()
    return 0


def _record_restart(times: list[float]) -> None:
    times.append(time.time())
    # Drop entries older than an hour.
    cutoff = time.time() - 3600
    while times and times[0] < cutoff:
        times.pop(0)


def _restart_storm(times: list[float], threshold: int) -> bool:
    return len(times) > threshold


# ── CLI ────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description="bridge supervisor / watchdog")
    ap.add_argument("--uvicorn-cmd", required=True,
                    help="full uvicorn command, e.g. 'uvicorn bridge.server:app --host 0.0.0.0 --port 5000'")
    ap.add_argument("--cwd", type=Path, default=None,
                    help="working directory for the bridge process (default: current)")
    ap.add_argument("--health-url", default="http://localhost:5000/health",
                    help="URL to probe (default: http://localhost:5000/health)")
    ap.add_argument("--poll-seconds", type=float, default=5.0,
                    help="seconds between health probes (default: 5)")
    ap.add_argument("--failure-threshold", type=int, default=3,
                    help="consecutive failures before restart (default: 3)")
    ap.add_argument("--max-restarts-per-hour", type=int, default=10,
                    help="if exceeded, back off 60s before respawning (default: 10)")
    ap.add_argument("--log", type=Path, default=None,
                    help="optional log file path; default: stderr")
    args = ap.parse_args()

    log_kwargs = {
        "level": logging.INFO,
        "format": "%(asctime)s %(levelname)s %(message)s",
        "datefmt": "%Y-%m-%dT%H:%M:%S%z",
    }
    if args.log is not None:
        args.log.parent.mkdir(parents=True, exist_ok=True)
        log_kwargs["filename"] = str(args.log)
    logging.basicConfig(**log_kwargs)

    cmd = shlex.split(args.uvicorn_cmd)
    return supervise(
        cmd=cmd,
        cwd=args.cwd,
        health_url=args.health_url,
        poll_s=args.poll_seconds,
        failure_threshold=args.failure_threshold,
        max_restarts_per_hour=args.max_restarts_per_hour,
    )


if __name__ == "__main__":
    sys.exit(main())
