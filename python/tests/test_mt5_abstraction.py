"""Section 7 abstraction: ``import MetaTrader5`` lives in ONE file only."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[1] / "cicada_nn"


def _imports_mt5(path: Path) -> bool:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="ignore"))
    except SyntaxError:
        return False
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "MetaTrader5" or alias.name.startswith("MetaTrader5."):
                    return True
        elif isinstance(node, ast.ImportFrom):
            if node.module == "MetaTrader5" or (node.module or "").startswith("MetaTrader5."):
                return True
    return False


def test_metatrader5_not_imported_anywhere_in_cicada_nn():
    """Stage 2A: the only file in the entire repo allowed to ``import
    MetaTrader5`` is ``bridge/server.py`` (which lives outside ``cicada_nn``
    and runs inside the Windows VM). The Ubuntu trading code routes every
    MT5 call through ``mt5_bridge.py`` over HTTP."""
    importers: list[str] = []
    for path in PKG.rglob("*.py"):
        if _imports_mt5(path):
            importers.append(path.relative_to(PKG).as_posix())
    assert importers == [], (
        "No file under cicada_nn may import MetaTrader5 — that import lives "
        f"only in bridge/server.py. Found in: {importers}"
    )
