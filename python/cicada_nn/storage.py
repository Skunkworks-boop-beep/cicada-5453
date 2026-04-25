"""
Filesystem persistence for CICADA-5453.

The previous implementation had tempfile + os.replace, which is good, but:

1. It left a window where a concurrent crash could leave an unlinked temp file
   lying next to the target; the ``finally`` block tried to clean it up but the
   cleanup raced with the ``replace`` itself.
2. It never ``fsync``'d the file before the atomic rename, so a hard crash
   could leave a zero-length target even after ``os.replace`` returned.
3. Inside-process locks covered only one Python worker; running uvicorn with
   ``--workers N`` could still interleave writes to the same path.

This module addresses all three: fsync before rename, no stray temp files on
the happy path, and an optional advisory ``fcntl.flock`` across processes
(graceful no-op on Windows). The public API (``JsonFileStore`` / ``StorageService``)
is unchanged so api.py didn't need to be touched.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Callable

try:  # Optional: cross-process advisory locks on POSIX.
    import fcntl  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - Windows path
    fcntl = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)


def _fsync_fd(fd: int) -> None:
    """Best-effort fsync; non-fatal on platforms/file systems without support."""
    try:
        os.fsync(fd)
    except OSError as e:  # e.g. EINVAL on some overlayfs / Docker tmpfs
        logger.debug("fsync(%s) skipped: %s", fd, e)


def _fsync_dir(path: Path) -> None:
    """fsync the parent directory so the atomic-rename result is durable."""
    try:
        dir_fd = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        _fsync_fd(dir_fd)
    finally:
        try:
            os.close(dir_fd)
        except OSError:
            pass


class _InterProcessLock:
    """Context manager wrapping advisory flock on POSIX, no-op elsewhere.

    We lock on a sibling ``.lock`` file rather than the data file itself so
    concurrent processes do not race to create the data file before its first
    write."""

    def __init__(self, path: Path):
        self._path = Path(str(path) + ".lock")
        self._fd: int | None = None

    def __enter__(self) -> "_InterProcessLock":
        if fcntl is None:
            return self
        self._path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self._fd = os.open(str(self._path), os.O_RDWR | os.O_CREAT, 0o644)
            fcntl.flock(self._fd, fcntl.LOCK_EX)
        except OSError as e:  # pragma: no cover - exotic filesystems
            logger.debug("flock(%s) skipped: %s", self._path, e)
            self._fd = None
        return self

    def __exit__(self, *exc: Any) -> None:
        if self._fd is None:
            return
        try:
            if fcntl is not None:
                fcntl.flock(self._fd, fcntl.LOCK_UN)
        finally:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None


class JsonFileStore:
    """Thread- and process-safe JSON store with durable atomic replace.

    A default-producing callable can be supplied via ``default_factory`` so the
    default value is not shared between callers (important when the default is
    a mutable dict/list)."""

    def __init__(
        self,
        path: Path,
        default: Any = None,
        default_factory: Callable[[], Any] | None = None,
    ):
        if default_factory is None and default is None:
            default_factory = dict  # mutable-safe default
        self.path = path
        self._default_factory = default_factory
        self._default_value = default
        self._lock = threading.RLock()

    @property
    def default(self) -> Any:
        if self._default_factory is not None:
            return self._default_factory()
        return self._default_value

    # ------------------------------------------------------------------
    def read(self) -> Any:
        with self._lock, _InterProcessLock(self.path):
            if not self.path.exists():
                return self.default
            try:
                with open(self.path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (OSError, json.JSONDecodeError) as e:
                logger.warning("JsonFileStore.read(%s) fell back to default: %s", self.path, e)
                return self.default

    def write(self, data: Any) -> None:
        with self._lock, _InterProcessLock(self.path):
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(
                prefix=self.path.name + ".",
                suffix=".tmp",
                dir=str(self.path.parent),
            )
            success = False
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=0)
                    f.flush()
                    _fsync_fd(f.fileno())
                os.replace(tmp_path, self.path)
                success = True
                _fsync_dir(self.path.parent)
            finally:
                if not success:
                    try:
                        if os.path.exists(tmp_path):
                            os.unlink(tmp_path)
                    except OSError as e:
                        logger.debug("Temp cleanup for %s failed: %s", tmp_path, e)


class StorageService:
    """All backend-backed stores in one modular container."""

    def __init__(self, base_dir: Path):
        self.base_dir = base_dir
        self.bots = JsonFileStore(base_dir / "bots.json", default_factory=list)
        self.positions = JsonFileStore(
            base_dir / "positions.json",
            default_factory=lambda: {"positions": [], "closedTradesByBot": {}},
        )
        self.execution_log = JsonFileStore(base_dir / "execution_log.json", default_factory=list)
        self.app_state = JsonFileStore(base_dir / "app_state.json", default_factory=dict)
        self.settings = JsonFileStore(base_dir / "settings.json", default_factory=dict)
