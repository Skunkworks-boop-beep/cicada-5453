"""
Structured logging setup for CICADA-5453.

The backend previously relied on bare ``print()`` calls and a handful of
``logger.info`` statements with no consistent formatter. Under uvicorn those
ended up with inconsistent timestamps, no request ids, and zero correlation
across build/predict/backtest endpoints.

This module installs a JSON-ish structured formatter and exposes a ``bind_context``
helper so endpoints can attach request/instrument context to every log record
they emit. It is safe to import more than once — only one handler is ever added
to the root logger.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from contextvars import ContextVar
from typing import Any


_CONTEXT: ContextVar[dict[str, Any]] = ContextVar("cicada_log_context", default={})
_INSTALLED = False


class _StructuredFormatter(logging.Formatter):
    """Render records as single-line JSON so log shippers can parse directly."""

    def format(self, record: logging.LogRecord) -> str:  # noqa: D401
        base: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        ctx = _CONTEXT.get({})
        if ctx:
            base["ctx"] = ctx
        if record.exc_info:
            base["exc"] = self.formatException(record.exc_info)
        # Attach any extra fields that callers set via ``logger.info(..., extra={...})``.
        for key, value in record.__dict__.items():
            if key in {
                "args",
                "asctime",
                "created",
                "exc_info",
                "exc_text",
                "filename",
                "funcName",
                "levelname",
                "levelno",
                "lineno",
                "module",
                "msecs",
                "message",
                "msg",
                "name",
                "pathname",
                "process",
                "processName",
                "relativeCreated",
                "stack_info",
                "thread",
                "threadName",
            }:
                continue
            if key.startswith("_"):
                continue
            try:
                json.dumps(value)
            except (TypeError, ValueError):
                value = repr(value)
            base[key] = value
        return json.dumps(base, default=str, separators=(",", ":"))


def configure_logging(level: str | int | None = None) -> None:
    """Install the structured formatter on the root logger (idempotent)."""
    global _INSTALLED
    if _INSTALLED:
        return
    lvl = level or os.environ.get("CICADA_LOG_LEVEL", "INFO")
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(_StructuredFormatter())
    root = logging.getLogger()
    # Replace any existing handlers under our module prefix; keep uvicorn's ones.
    root.setLevel(lvl)
    # Attach only if our formatter isn't already present.
    already_attached = any(
        isinstance(h.formatter, _StructuredFormatter) for h in root.handlers
    )
    if not already_attached:
        root.addHandler(handler)
    for name in ("cicada_nn", "cicada_nn.api", "cicada_nn.research_server", "cicada_nn.backward_validation"):
        lg = logging.getLogger(name)
        lg.setLevel(lvl)
    _INSTALLED = True


class bind_context:
    """Context manager that layers extra fields onto every log record emitted
    within the block. Nested binds merge rather than replace."""

    def __init__(self, **fields: Any):
        self._fields = fields
        self._token = None

    def __enter__(self) -> "bind_context":
        existing = _CONTEXT.get({})
        merged = {**existing, **self._fields}
        self._token = _CONTEXT.set(merged)
        return self

    def __exit__(self, *_exc: Any) -> None:
        if self._token is not None:
            _CONTEXT.reset(self._token)
