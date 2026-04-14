"""
Modular filesystem storage for backend persistence.

Provides small repository helpers with atomic writes and per-file locks so
frontend state, bots, positions, settings, and execution logs can be stored
without browser localStorage.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any


class JsonFileStore:
    """Thread-safe JSON file storage with atomic replace writes."""

    def __init__(self, path: Path, default: Any):
        self.path = path
        self.default = default
        self._lock = threading.RLock()

    def read(self) -> Any:
        with self._lock:
            if not self.path.exists():
                return self.default
            try:
                with open(self.path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                return data
            except Exception:
                return self.default

    def write(self, data: Any) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(prefix=self.path.name + ".", dir=str(self.path.parent))
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=0)
                os.replace(tmp_path, self.path)
            finally:
                try:
                    if os.path.exists(tmp_path):
                        os.unlink(tmp_path)
                except Exception:
                    pass


class StorageService:
    """All backend-backed stores in one modular container."""

    def __init__(self, base_dir: Path):
        self.base_dir = base_dir
        self.bots = JsonFileStore(base_dir / "bots.json", [])
        self.positions = JsonFileStore(base_dir / "positions.json", {"positions": [], "closedTradesByBot": {}})
        self.execution_log = JsonFileStore(base_dir / "execution_log.json", [])
        self.app_state = JsonFileStore(base_dir / "app_state.json", {})
        self.settings = JsonFileStore(base_dir / "settings.json", {})
