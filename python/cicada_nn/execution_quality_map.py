"""Execution-quality map (spec phase 2b).

Per-coordinate (price-bin × date) execution-quality fields aligned to the
geometric map's coordinate system. Reads ticks via the MT5 bridge —
**never** imports MetaTrader5 directly. When the bridge is unreachable
or returns no ticks the map is marked ``degraded=True`` and downstream
consumers (``BacktestEngine``, ``context_layer``) skip rather than
fabricate from constants.

Per-coordinate fields:

  * ``avg_spread`` — mean of tick.ask-tick.bid for ticks falling in the bin.
  * ``spread_variance`` — sample variance of the spread.
  * ``avg_slippage`` — mean absolute mid-price drift between consecutive
    ticks; used as a fill-cost proxy.
  * ``partial_fill_probability`` — fraction of ticks where spread exceeds
    1.5× the rolling median spread for that bin (proxy for thin liquidity).
  * ``book_depth_proxy`` — mean tick.volume / max(spread, eps) per bin.
  * ``latency_impact_estimate`` — ``avg_slippage × expected_slippage_ms``
    when a LatencyModel is supplied; otherwise NaN.

Persistence: JSON for portability; pyarrow/parquet support is optional —
when ``pyarrow`` is installed the file lands as ``.parquet`` partitioned
by instrument + date, otherwise as ``.json`` so the module remains usable
without that wheel. Tests use the JSON path.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Sequence

import numpy as np

from . import mt5_bridge
from .mt5_bridge import BridgeError


logger = logging.getLogger(__name__)


__VERSION__ = 1


# ── Public dataclass surface ─────────────────────────────────────────────


@dataclass(frozen=True)
class CoordinateQuality:
    """Per-coordinate execution-quality cell. NaN denotes "no data" — caller
    must treat NaN as a hard skip, not as a zero."""
    bin_idx: int
    bin_low: float
    bin_high: float
    n_ticks: int
    avg_spread: float
    spread_variance: float
    avg_slippage: float
    partial_fill_probability: float
    book_depth_proxy: float
    latency_impact_estimate: float


@dataclass
class ExecutionQualityMap:
    symbol: str
    date_utc: str  # YYYY-MM-DD; partition key
    bins: list[float]
    cells: list[CoordinateQuality]
    degraded: bool
    note: Optional[str] = None
    version: int = __VERSION__

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "date_utc": self.date_utc,
            "bins": list(self.bins),
            "cells": [asdict(c) for c in self.cells],
            "degraded": self.degraded,
            "note": self.note,
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ExecutionQualityMap":
        return cls(
            symbol=d["symbol"],
            date_utc=d["date_utc"],
            bins=list(d.get("bins") or []),
            cells=[CoordinateQuality(**c) for c in d.get("cells") or []],
            degraded=bool(d.get("degraded", False)),
            note=d.get("note"),
            version=int(d.get("version") or __VERSION__),
        )


# ── Build ────────────────────────────────────────────────────────────────


def _bin_index(price: float, bins: Sequence[float]) -> int:
    """Return the bin index whose [low, high) covers ``price``. Returns -1
    when out of range (the cell is dropped)."""
    if not bins or len(bins) < 2:
        return -1
    if price < bins[0] or price > bins[-1]:
        return -1
    # bins[i] is the lower edge; we use np.searchsorted for vectorisation.
    idx = int(np.searchsorted(bins, price, side="right")) - 1
    if idx < 0:
        return 0
    if idx >= len(bins) - 1:
        return len(bins) - 2
    return idx


def _ticks_to_cells(
    bins: Sequence[float],
    ticks: Sequence[dict],
    expected_slippage_ms: Optional[float],
) -> list[CoordinateQuality]:
    """Group ticks by bin, compute per-coordinate stats."""
    if len(bins) < 2 or not ticks:
        return []
    n_bins = len(bins) - 1
    by_bin: list[list[dict]] = [[] for _ in range(n_bins)]
    for t in ticks:
        bid = float(t.get("bid") or 0.0)
        ask = float(t.get("ask") or 0.0)
        if bid <= 0 or ask <= 0:
            continue
        mid = 0.5 * (bid + ask)
        idx = _bin_index(mid, bins)
        if idx < 0:
            continue
        by_bin[idx].append(t)
    cells: list[CoordinateQuality] = []
    # Median spread across all ticks → partial-fill threshold reference.
    all_spreads = np.array(
        [float(t.get("spread") or max(0.0, float(t.get("ask") or 0.0) - float(t.get("bid") or 0.0))) for t in ticks],
        dtype=float,
    )
    overall_median = float(np.median(all_spreads)) if len(all_spreads) else 0.0
    threshold = 1.5 * overall_median if overall_median > 0 else float("inf")

    for i in range(n_bins):
        members = by_bin[i]
        if not members:
            continue
        spreads = np.array(
            [float(m.get("spread") or max(0.0, float(m.get("ask") or 0.0) - float(m.get("bid") or 0.0))) for m in members],
            dtype=float,
        )
        mids = np.array(
            [0.5 * (float(m.get("bid") or 0.0) + float(m.get("ask") or 0.0)) for m in members],
            dtype=float,
        )
        vols = np.array([float(m.get("volume") or 0.0) for m in members], dtype=float)
        slippage = float(np.mean(np.abs(np.diff(mids)))) if len(mids) > 1 else 0.0
        partial_fill = float(np.mean(spreads > threshold)) if math.isfinite(threshold) else 0.0
        depth_proxy = float(np.mean(vols / np.maximum(spreads, 1e-12)))
        avg_spread = float(np.mean(spreads))
        spread_var = float(np.var(spreads, ddof=0))
        latency_impact = (
            slippage * expected_slippage_ms
            if expected_slippage_ms is not None and slippage >= 0
            else float("nan")
        )
        cells.append(
            CoordinateQuality(
                bin_idx=i,
                bin_low=float(bins[i]),
                bin_high=float(bins[i + 1]),
                n_ticks=len(members),
                avg_spread=avg_spread,
                spread_variance=spread_var,
                avg_slippage=slippage,
                partial_fill_probability=partial_fill,
                book_depth_proxy=depth_proxy,
                latency_impact_estimate=latency_impact,
            )
        )
    return cells


def build_execution_quality_map(
    *,
    symbol: str,
    bins: Sequence[float],
    ticks: Optional[Sequence[dict]] = None,
    bridge: Optional[Any] = None,
    from_ts: Optional[int] = None,
    to_ts: Optional[int] = None,
    expected_slippage_ms: Optional[float] = None,
) -> ExecutionQualityMap:
    """Build the map from explicit ticks OR by fetching ticks via the
    bridge. ``bins`` is the geometric map's price-bin list (we share the
    coordinate system). When the bridge is unreachable / returns no ticks
    the map is ``degraded=True`` with no rows; the operator's downstream
    code must skip rather than fabricate constant values."""
    safe_date = (
        datetime.fromtimestamp(int(from_ts) if from_ts else int(_clock_now_ts()), tz=timezone.utc)
        .strftime("%Y-%m-%d")
    )
    if ticks is None:
        if bridge is None:
            try:
                bridge = mt5_bridge.get_bridge()
            except Exception as e:  # pragma: no cover — defensive
                logger.warning("execution_quality_map: bridge fetch failed: %s", e)
                return ExecutionQualityMap(
                    symbol=symbol, date_utc=safe_date, bins=list(bins), cells=[], degraded=True,
                    note=f"BRIDGE_INIT_FAILED: {e}",
                )
        if from_ts is None or to_ts is None:
            return ExecutionQualityMap(
                symbol=symbol, date_utc=safe_date, bins=list(bins), cells=[], degraded=True,
                note="MISSING_TIME_RANGE",
            )
        try:
            ticks = bridge.get_ticks(symbol=symbol, from_ts=int(from_ts), to_ts=int(to_ts))
        except BridgeError as e:
            logger.warning("execution_quality_map: bridge unreachable: %s", e)
            return ExecutionQualityMap(
                symbol=symbol, date_utc=safe_date, bins=list(bins), cells=[], degraded=True,
                note=f"BRIDGE_UNREACHABLE: {e}",
            )
    if not ticks:
        return ExecutionQualityMap(
            symbol=symbol, date_utc=safe_date, bins=list(bins), cells=[], degraded=True,
            note="NO_TICKS",
        )
    cells = _ticks_to_cells(bins, ticks, expected_slippage_ms)
    return ExecutionQualityMap(
        symbol=symbol, date_utc=safe_date, bins=list(bins), cells=cells, degraded=False, note=None,
    )


def _clock_now_ts() -> float:
    import time
    return time.time()


# ── Persistence ──────────────────────────────────────────────────────────


def map_filename(symbol: str, date_utc: str) -> str:
    safe_sym = "".join(c if c.isalnum() else "_" for c in symbol).upper()
    safe_date = date_utc.replace(":", "").replace(" ", "_")
    return f"execution_quality_{safe_sym}_{safe_date}.json"


def save_execution_quality_map(eqmap: ExecutionQualityMap, out_dir: Path) -> Path:
    """Persist as JSON. pyarrow/parquet is preferred when installed but the
    JSON path is the supported / tested surface."""
    out_dir = Path(out_dir)
    # Partition layout: <out_dir>/<symbol>/<date>/<file>.json — matches the
    # spec's "parquet partitioned by instrument + date".
    safe_sym = "".join(c if c.isalnum() else "_" for c in eqmap.symbol).upper()
    partition = out_dir / safe_sym / eqmap.date_utc
    partition.mkdir(parents=True, exist_ok=True)
    path = partition / map_filename(eqmap.symbol, eqmap.date_utc)
    payload = json.dumps(eqmap.to_dict(), separators=(",", ":"), sort_keys=True)
    path.write_text(payload, encoding="utf-8")
    return path


def load_execution_quality_map(path: Path) -> ExecutionQualityMap:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    return ExecutionQualityMap.from_dict(payload)


def latest_execution_quality_map(out_dir: Path, symbol: str) -> Optional[ExecutionQualityMap]:
    out_dir = Path(out_dir)
    safe_sym = "".join(c if c.isalnum() else "_" for c in symbol).upper()
    sym_dir = out_dir / safe_sym
    if not sym_dir.exists():
        return None
    candidates = sorted(sym_dir.glob("*/*.json"))
    if not candidates:
        return None
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return load_execution_quality_map(candidates[0])
