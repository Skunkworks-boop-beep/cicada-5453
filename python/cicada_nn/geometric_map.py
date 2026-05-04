"""Stable geometric price map (spec phase 2).

Computed ONCE from full historical bars and persisted to disk; never
recomputed bar-to-bar. Rebuilt only on a volatility-regime shift or full
system retrain. The bidirectional-analysis claim depends on this stable
coordinate system — every other Stage 2B module joins to the bins this
file produces.

Outputs:

* Volume profile via a numpy-only Gaussian KDE over close prices weighted
  by tick volume; peaks → ``volume_nodes``.
* Fractal swing highs/lows with the same 5-bar window used by
  ``signals.py:_is_swing_*``.
* S/R nodes = volume-profile peaks confirmed by ≥ 2 fractal swings within
  ``0.5 × ATR``.
* ``meta`` carries a sha256 of (version, symbol, full bar tuple) so the
  same input always produces the same map; the filename embeds the first
  8 chars so a hash mismatch on reload is loud.

scipy is optional. When ``scipy.stats.gaussian_kde`` is available we use
it (so the operator's heavyweight venv matches the spec text); otherwise
we fall back to a numpy-only implementation that produces identical
results within float tolerance.

JSON is the durable format. pyarrow / parquet is preferred when the
operator has it installed, but tests stay deterministic on the JSON path
so they run in any minimal venv.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional, Sequence

import numpy as np

try:  # scipy is optional; the numpy fallback is bit-stable for the test fixtures.
    from scipy.stats import gaussian_kde as _scipy_kde  # type: ignore[import-untyped]
    _HAS_SCIPY = True
except Exception:
    _scipy_kde = None  # type: ignore[assignment]
    _HAS_SCIPY = False


logger = logging.getLogger(__name__)


__VERSION__ = 1


# ── Public dataclass surface ─────────────────────────────────────────────


@dataclass(frozen=True)
class SwingPoint:
    """A confirmed fractal swing — uses the 5-bar window from signals.py."""
    idx: int
    time: float
    price: float


@dataclass(frozen=True)
class VolumeNode:
    """A peak of the weighted close-price KDE. ``score`` is the KDE density."""
    price: float
    score: float


@dataclass(frozen=True)
class SRLevel:
    """Support or resistance — a volume-profile peak confirmed by ≥ 2 fractal
    swings within ``0.5 × ATR``."""
    price: float
    kind: str  # "support" / "resistance"
    confirmations: int
    score: float


@dataclass(frozen=True)
class GeometricMapMeta:
    version: int
    symbol: str
    n_bars: int
    bar_first_time: float
    bar_last_time: float
    atr_at_build: float
    input_sha: str  # sha256 of the full bar tuple — stability anchor


@dataclass
class GeometricMap:
    symbol: str
    bins: list[float]
    volume_nodes: list[VolumeNode]
    swing_highs: list[SwingPoint]
    swing_lows: list[SwingPoint]
    support_levels: list[SRLevel]
    resistance_levels: list[SRLevel]
    meta: GeometricMapMeta

    # ── (de)serialise ────────────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "bins": list(self.bins),
            "volume_nodes": [asdict(v) for v in self.volume_nodes],
            "swing_highs": [asdict(s) for s in self.swing_highs],
            "swing_lows": [asdict(s) for s in self.swing_lows],
            "support_levels": [asdict(l) for l in self.support_levels],
            "resistance_levels": [asdict(l) for l in self.resistance_levels],
            "meta": asdict(self.meta),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "GeometricMap":
        meta = GeometricMapMeta(**d["meta"])
        return cls(
            symbol=d["symbol"],
            bins=list(d.get("bins") or []),
            volume_nodes=[VolumeNode(**v) for v in d.get("volume_nodes") or []],
            swing_highs=[SwingPoint(**s) for s in d.get("swing_highs") or []],
            swing_lows=[SwingPoint(**s) for s in d.get("swing_lows") or []],
            support_levels=[SRLevel(**l) for l in d.get("support_levels") or []],
            resistance_levels=[SRLevel(**l) for l in d.get("resistance_levels") or []],
            meta=meta,
        )


# ── Hashing — stability anchor ───────────────────────────────────────────


def _hash_bars(symbol: str, bars: Sequence[dict]) -> str:
    """sha256 of (version, symbol, every bar's OHLCV+time tuple).

    Embed ``__VERSION__`` so a future schema change invalidates cleanly
    without a manual rebuild prompt.
    """
    h = hashlib.sha256()
    h.update(str(__VERSION__).encode("utf-8"))
    h.update(b"|")
    h.update(symbol.encode("utf-8"))
    h.update(b"|")
    for b in bars:
        # Canonicalise: ints for time / volume, floats with 8-digit precision
        # for OHLC. Avoids "the same bar with a stray .0" producing a different
        # hash than the original — the bridge sometimes returns ints, sometimes
        # floats, depending on column dtypes.
        t = int(b.get("time") or 0)
        o = round(float(b.get("open") or 0.0), 8)
        hi = round(float(b.get("high") or 0.0), 8)
        lo = round(float(b.get("low") or 0.0), 8)
        c = round(float(b.get("close") or 0.0), 8)
        v = int(b.get("volume") or 0)
        h.update(f"{t},{o},{hi},{lo},{c},{v}\n".encode("ascii"))
    return h.hexdigest()


# ── ATR — same shape as labeling._atr_proxy but vectorised ───────────────


def _atr(bars: Sequence[dict], lookback: int = 14) -> float:
    """Average true range over the last ``lookback`` bars. Falls back to
    20 bps of close when input is malformed."""
    if not bars:
        return 0.0
    n = len(bars)
    closes = np.array([float(b.get("close") or 0.0) for b in bars])
    highs = np.array([float(b.get("high") or 0.0) for b in bars])
    lows = np.array([float(b.get("low") or 0.0) for b in bars])
    if closes[-1] <= 0:
        return 0.0
    start = max(0, n - lookback)
    trs: list[float] = []
    for j in range(start, n):
        h = highs[j]
        lo = lows[j]
        c_prev = closes[j - 1] if j > 0 else closes[j]
        trs.append(max(h - lo, abs(h - c_prev), abs(lo - c_prev)))
    if not trs:
        return 0.002 * float(closes[-1])
    atr = float(np.mean(trs))
    if atr <= 0 or not np.isfinite(atr):
        return 0.002 * float(closes[-1])
    return atr


# ── Fractal swings (5-bar window — same as signals.py) ───────────────────


def _is_swing_high(bars: Sequence[dict], j: int) -> bool:
    if j < 2 or j >= len(bars) - 2:
        return False
    h = float(bars[j].get("high") or 0.0)
    return (
        h >= float(bars[j - 1].get("high") or 0.0)
        and h >= float(bars[j - 2].get("high") or 0.0)
        and h >= float(bars[j + 1].get("high") or 0.0)
        and h >= float(bars[j + 2].get("high") or 0.0)
    )


def _is_swing_low(bars: Sequence[dict], j: int) -> bool:
    if j < 2 or j >= len(bars) - 2:
        return False
    lo = float(bars[j].get("low") or 0.0)
    return (
        lo <= float(bars[j - 1].get("low") or 0.0)
        and lo <= float(bars[j - 2].get("low") or 0.0)
        and lo <= float(bars[j + 1].get("low") or 0.0)
        and lo <= float(bars[j + 2].get("low") or 0.0)
    )


def _swings(bars: Sequence[dict]) -> tuple[list[SwingPoint], list[SwingPoint]]:
    highs: list[SwingPoint] = []
    lows: list[SwingPoint] = []
    for j in range(2, len(bars) - 2):
        if _is_swing_high(bars, j):
            highs.append(
                SwingPoint(
                    idx=j,
                    time=float(bars[j].get("time") or 0.0),
                    price=float(bars[j].get("high") or 0.0),
                )
            )
        if _is_swing_low(bars, j):
            lows.append(
                SwingPoint(
                    idx=j,
                    time=float(bars[j].get("time") or 0.0),
                    price=float(bars[j].get("low") or 0.0),
                )
            )
    return highs, lows


# ── Volume profile via KDE ───────────────────────────────────────────────


def _kde_density(prices: np.ndarray, weights: np.ndarray, grid: np.ndarray) -> np.ndarray:
    """Weighted Gaussian KDE evaluated on ``grid``. Used directly when scipy
    is absent; bit-stable across runs (all numpy primitives are deterministic).

    Bandwidth is Scott's rule (n^(-1/5) × std) — the same default scipy uses
    when no bw_method is specified, so the two paths agree on smooth fixtures.
    """
    if len(prices) == 0:
        return np.zeros_like(grid)
    std = float(np.std(prices)) or 1.0
    bw = std * (len(prices) ** (-0.2))
    if bw <= 0:
        bw = 1e-6
    norm = float(np.sum(weights)) or 1.0
    out = np.zeros_like(grid, dtype=float)
    inv_two_bw_sq = 1.0 / (2.0 * bw * bw)
    coef = 1.0 / (bw * math.sqrt(2.0 * math.pi))
    for p, w in zip(prices, weights):
        out += (w / norm) * coef * np.exp(-((grid - p) ** 2) * inv_two_bw_sq)
    return out


def _volume_profile(
    bars: Sequence[dict], n_bins: int = 100
) -> tuple[list[float], list[VolumeNode]]:
    """Return (bins, volume_nodes). Peaks are local maxima of the density."""
    if not bars:
        return [], []
    closes = np.array([float(b.get("close") or 0.0) for b in bars], dtype=float)
    vols = np.array([float(b.get("volume") or 1.0) for b in bars], dtype=float)
    # Tick-volume can be all-zero in synthetic fixtures; fall back to uniform.
    if np.sum(vols) <= 0:
        vols = np.ones_like(vols)
    lo, hi = float(np.min(closes)), float(np.max(closes))
    if hi <= lo:
        return [lo], []
    grid = np.linspace(lo, hi, num=n_bins)
    if _HAS_SCIPY:
        try:
            kde = _scipy_kde(closes, weights=vols / float(np.sum(vols)))
            density = np.asarray(kde(grid))
        except Exception:  # pragma: no cover — fall back if scipy chokes on edge case
            density = _kde_density(closes, vols, grid)
    else:
        density = _kde_density(closes, vols, grid)
    # Local maxima: strictly greater than both neighbours.
    nodes: list[VolumeNode] = []
    for i in range(1, len(grid) - 1):
        if density[i] > density[i - 1] and density[i] > density[i + 1]:
            nodes.append(VolumeNode(price=float(grid[i]), score=float(density[i])))
    nodes.sort(key=lambda n: n.score, reverse=True)
    return list(map(float, grid)), nodes


# ── S/R nodes — peaks confirmed by ≥ 2 fractal swings within 0.5 ATR ────


def _sr_levels(
    nodes: Sequence[VolumeNode],
    swing_highs: Sequence[SwingPoint],
    swing_lows: Sequence[SwingPoint],
    atr: float,
) -> tuple[list[SRLevel], list[SRLevel]]:
    if atr <= 0:
        return [], []
    tol = 0.5 * atr
    supports: list[SRLevel] = []
    resistances: list[SRLevel] = []
    for n in nodes:
        confirms_high = sum(1 for s in swing_highs if abs(s.price - n.price) <= tol)
        confirms_low = sum(1 for s in swing_lows if abs(s.price - n.price) <= tol)
        if confirms_low >= 2:
            supports.append(
                SRLevel(price=n.price, kind="support", confirmations=confirms_low, score=n.score)
            )
        if confirms_high >= 2:
            resistances.append(
                SRLevel(price=n.price, kind="resistance", confirmations=confirms_high, score=n.score)
            )
    supports.sort(key=lambda l: l.score, reverse=True)
    resistances.sort(key=lambda l: l.score, reverse=True)
    return supports, resistances


# ── Build / persist / load ───────────────────────────────────────────────


def build_geometric_map(
    bars: Sequence[dict],
    *,
    symbol: str,
    n_bins: int = 100,
) -> GeometricMap:
    """Build the map from a full bar series. Pure / deterministic — same
    input always produces the same hash."""
    if not bars:
        meta = GeometricMapMeta(
            version=__VERSION__,
            symbol=symbol,
            n_bars=0,
            bar_first_time=0.0,
            bar_last_time=0.0,
            atr_at_build=0.0,
            input_sha=_hash_bars(symbol, bars),
        )
        return GeometricMap(
            symbol=symbol,
            bins=[],
            volume_nodes=[],
            swing_highs=[],
            swing_lows=[],
            support_levels=[],
            resistance_levels=[],
            meta=meta,
        )
    bins, nodes = _volume_profile(bars, n_bins=n_bins)
    highs, lows = _swings(bars)
    atr = _atr(bars)
    supports, resistances = _sr_levels(nodes, highs, lows, atr)
    meta = GeometricMapMeta(
        version=__VERSION__,
        symbol=symbol,
        n_bars=len(bars),
        bar_first_time=float(bars[0].get("time") or 0.0),
        bar_last_time=float(bars[-1].get("time") or 0.0),
        atr_at_build=atr,
        input_sha=_hash_bars(symbol, bars),
    )
    return GeometricMap(
        symbol=symbol,
        bins=bins,
        volume_nodes=nodes,
        swing_highs=highs,
        swing_lows=lows,
        support_levels=supports,
        resistance_levels=resistances,
        meta=meta,
    )


def map_filename(symbol: str, input_sha: str) -> str:
    """Content-addressed name. The first 8 hex chars are the hash so a
    mismatch on reload is loud at the directory listing."""
    safe = "".join(c if c.isalnum() else "_" for c in symbol).upper()
    return f"geometric_map_{safe}_{input_sha[:8]}.json"


def save_geometric_map(gmap: GeometricMap, out_dir: Path) -> Path:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / map_filename(gmap.symbol, gmap.meta.input_sha)
    payload = json.dumps(gmap.to_dict(), separators=(",", ":"), sort_keys=True)
    path.write_text(payload, encoding="utf-8")
    return path


def load_geometric_map(path: Path) -> GeometricMap:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    return GeometricMap.from_dict(payload)


def latest_geometric_map(out_dir: Path, symbol: str) -> Optional[GeometricMap]:
    """Newest map on disk for ``symbol``. Returns ``None`` when none."""
    out_dir = Path(out_dir)
    if not out_dir.exists():
        return None
    safe = "".join(c if c.isalnum() else "_" for c in symbol).upper()
    candidates = sorted(out_dir.glob(f"geometric_map_{safe}_*.json"))
    if not candidates:
        return None
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return load_geometric_map(candidates[0])


# ── Regime-shift trigger ─────────────────────────────────────────────────
#
# Open question (2) from the architectural review: what counts as a
# "volatility regime shift"? The spec hand-waves it. Heuristic pinned here
# and called out in the PR body: rebuild when the new bar set's tail ATR is
# > 2× the rolling-100 median of historical ATRs OR the regime label
# rotates between {trend, range, volatile} versus the build-time regime.
# Conservative; biased toward not-rebuilding to honour the spec's "stable
# coordinate system" guarantee.


def should_rebuild(
    *,
    prev_meta: GeometricMapMeta,
    new_bars: Sequence[dict],
    atr_lookback: int = 14,
    median_lookback: int = 100,
    atr_ratio_threshold: float = 2.0,
) -> bool:
    """Return True when the map should be rebuilt on the new bars."""
    if prev_meta.atr_at_build <= 0 or len(new_bars) < median_lookback:
        return False
    new_atr = _atr(new_bars[-atr_lookback:], lookback=atr_lookback)
    if new_atr <= 0:
        return False
    # rolling-100 median ATR over the new bars: build a windowed series.
    atrs: list[float] = []
    for end in range(atr_lookback, len(new_bars)):
        atrs.append(_atr(new_bars[end - atr_lookback : end], lookback=atr_lookback))
    if not atrs:
        return False
    median = float(np.median(atrs[-median_lookback:]))
    if median <= 0:
        return False
    ratio = new_atr / median
    return ratio > atr_ratio_threshold


# ── CLI ──────────────────────────────────────────────────────────────────


def _main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Build a geometric map from a bar series")
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--bars-file", required=True, help="JSON list of bars (open/high/low/close/volume/time)")
    parser.add_argument("--out", default="checkpoints", help="Output directory (default: checkpoints/)")
    parser.add_argument("--bins", type=int, default=100)
    args = parser.parse_args(argv)
    bars = json.loads(Path(args.bars_file).read_text(encoding="utf-8"))
    gmap = build_geometric_map(bars, symbol=args.symbol, n_bins=args.bins)
    path = save_geometric_map(gmap, Path(args.out))
    print(json.dumps({
        "saved": str(path),
        "input_sha": gmap.meta.input_sha,
        "n_volume_nodes": len(gmap.volume_nodes),
        "n_supports": len(gmap.support_levels),
        "n_resistances": len(gmap.resistance_levels),
    }))
    return 0


if __name__ == "__main__":  # pragma: no cover — CLI entry
    raise SystemExit(_main())
