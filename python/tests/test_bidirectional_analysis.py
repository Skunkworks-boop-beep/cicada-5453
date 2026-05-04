"""Stage 2B: bidirectional analysis (spec phase 5).

Pinned guarantees:

* Lookback feature timestamps ≤ entry time T for every row.
* Forward labels' minimum timestamp > T (the look-forward starts at T+1).
* Forced leak (a feature derived from t > T) raises LookaheadLeakError.
* No label column name overlaps the feature column list.
"""

from __future__ import annotations

from unittest import mock

import numpy as np
import pytest

from cicada_nn import bidirectional_analysis as bda
from cicada_nn.bidirectional_analysis import (
    LABEL_COLUMNS,
    LOOKBACK_FEATURES,
    BidirectionalRow,
    build_bidirectional,
)
from cicada_nn.lookahead_validator import LookaheadLeakError


# ── Fixtures ─────────────────────────────────────────────────────────────


def _bars(n: int = 200) -> list[dict]:
    rng = np.random.default_rng(3)
    t0 = 1_700_000_000
    base = 1.10
    bars: list[dict] = []
    for i in range(n):
        base += 0.0001 * float(rng.normal())
        bars.append(
            {
                "time": t0 + i * 60,
                "open": base - 0.00002,
                "high": base + 0.0003,
                "low": base - 0.0003,
                "close": base,
                "volume": 100 + (i % 10),
            }
        )
    return bars


def _trades(bars: list[dict]) -> list[dict]:
    """Three trades at evenly spaced bars."""
    indices = [50, 100, 150]
    out = []
    for i, idx in enumerate(indices):
        side = "LONG" if i % 2 == 0 else "SHORT"
        out.append(
            {
                "trade_id": f"t{i}",
                "side": side,
                "entry_time": float(bars[idx]["time"]),
                "entry_price": float(bars[idx]["close"]),
                "exit_time": float(bars[min(idx + 10, len(bars) - 1)]["time"]),
                "exit_price": float(bars[min(idx + 10, len(bars) - 1)]["close"]),
            }
        )
    return out


# ── Lookback timestamps ≤ T ──────────────────────────────────────────────


def test_lookback_feature_t_never_exceeds_row_t():
    bars = _bars()
    trades = _trades(bars)
    rows = build_bidirectional(trades, bars)
    assert len(rows) == len(trades)
    for r in rows:
        assert r.lookback_feature_t <= r.row_t


def test_label_columns_disjoint_from_feature_columns():
    """The frozen schema constants are the contract; the validator catches
    any name collision but the test pins the column list shape too."""
    assert set(LOOKBACK_FEATURES).isdisjoint(set(LABEL_COLUMNS))


def test_look_forward_starts_strictly_after_entry():
    bars = _bars()
    trades = _trades(bars)
    rows = build_bidirectional(trades, bars)
    for r in rows:
        assert r.look_forward_t_min > r.row_t


# ── Leak detection ───────────────────────────────────────────────────────


def test_forced_leak_raises():
    """Patch ``_lookback_features`` to deliberately return a future
    timestamp; the validator must raise."""
    bars = _bars()
    trades = _trades(bars)

    real = bda._lookback_features

    def _bad(bars_arg, end_idx, window):
        feats, _max_t = real(bars_arg, end_idx, window)
        # Emit a max_t one bar in the future — a real leak.
        future_t = float(bars_arg[min(end_idx + 1, len(bars_arg) - 1)].get("time") or 0.0)
        return feats, future_t

    with mock.patch.object(bda, "_lookback_features", _bad):
        with pytest.raises(LookaheadLeakError) as excinfo:
            build_bidirectional(trades, bars)
    assert "feature_t" in str(excinfo.value) and "row_t" in str(excinfo.value)


# ── Empty / malformed inputs ─────────────────────────────────────────────


def test_no_trades_returns_empty_no_raise():
    rows = build_bidirectional([], _bars())
    assert rows == []


def test_no_bars_returns_empty_no_raise():
    rows = build_bidirectional(_trades(_bars()), [])
    assert rows == []


def test_malformed_trade_skipped():
    bars = _bars()
    trades = _trades(bars) + [{"trade_id": "bad"}]  # missing fields
    rows = build_bidirectional(trades, bars)
    assert len(rows) == 3  # only the 3 well-formed trades


def test_outcome_class_in_valid_range():
    bars = _bars()
    trades = _trades(bars)
    rows = build_bidirectional(trades, bars)
    for r in rows:
        oc = int(r.labels["outcome_class"])
        assert oc in {0, 1, 2, 3}


def test_lookback_features_have_all_columns():
    bars = _bars()
    rows = build_bidirectional(_trades(bars), bars)
    for r in rows:
        assert set(r.lookback.keys()) == set(LOOKBACK_FEATURES)


def test_labels_have_all_columns():
    bars = _bars()
    rows = build_bidirectional(_trades(bars), bars)
    for r in rows:
        assert set(r.labels.keys()) == set(LABEL_COLUMNS)
