"""Regression tests for the post-overhaul NN pipeline.

The previous training pipeline had a subtle label-leak (targets derived from
the same slice of features the network consumed) and used raw close/base
ratios for detection features, which gave the model a scale-dependent view of
the market. This test suite locks in the honest split and the scale-invariant
features so the fixes do not regress.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import pytest
import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))


from cicada_nn.bar_features import BarFeatureConfig, feature_dim, window_features  # noqa: E402
from cicada_nn.labeling import (  # noqa: E402
    TripleBarrierConfig,
    label_distribution,
    triple_barrier_labels,
    uniqueness_weights,
)
from cicada_nn.model import (  # noqa: E402
    DetectionConfig,
    StrategyDetectionNN,
    build_detection_model_from_checkpoint,
    build_model_from_checkpoint,
)
from cicada_nn.train import _purged_feature_label_split, train  # noqa: E402
from cicada_nn.train_detection import train_detection  # noqa: E402


def _synthetic_bars(n: int = 300, seed: int = 7) -> list[dict]:
    rng = np.random.default_rng(seed)
    price = 100.0
    out = []
    for i in range(n):
        drift = rng.normal(0.0005, 0.002)
        price *= 1 + drift
        hi = price * (1 + abs(rng.normal(0, 0.001)))
        lo = price * (1 - abs(rng.normal(0, 0.001)))
        op = price * (1 + rng.normal(0, 0.0005))
        out.append({"time": i * 60, "open": op, "high": hi, "low": lo, "close": price})
    return out


def _synthetic_rows(instrument: str = "inst-eurusd", n: int = 8) -> list[dict]:
    rows = []
    for i in range(n):
        rows.append(
            {
                "instrumentId": instrument,
                "strategyId": "ind-rsi",
                "timeframe": "M5",
                "regime": "trending_bull",
                "winRate": 55 + i * 2,
                "profit": 100 + i * 40,
                "trades": 20,
                "profitFactor": 1.2 + i * 0.05,
                "sharpeRatio": 0.5 + i * 0.1,
                "maxDrawdown": 0.05,
                "dataEndTime": f"2024-0{(i % 9) + 1}-01T00:00:00Z",
                "status": "completed",
            }
        )
    return rows


# ───────────────────────── labeling ─────────────────────────


def test_triple_barrier_labels_shape_and_classes():
    bars = _synthetic_bars(200)
    labels = triple_barrier_labels(bars, TripleBarrierConfig(horizon_bars=10))
    assert labels.shape == (200,)
    assert set(labels.tolist()) <= {0, 1, 2}


def test_triple_barrier_returns_direction_on_trending_data():
    """A monotonically rising series should produce long-dominant labels."""
    bars = [
        {"time": i * 60, "open": 100 + i, "high": 100.5 + i, "low": 99.5 + i, "close": 100 + i}
        for i in range(80)
    ]
    labels = triple_barrier_labels(bars, TripleBarrierConfig(horizon_bars=10, tp_mult=0.5, sl_mult=2.0))
    dist = label_distribution(labels)
    assert dist["long"] > dist["short"], dist


def test_uniqueness_weights_normalised():
    w = uniqueness_weights(100, 10)
    # Weights should average to 1 (normalised), and all be positive.
    assert pytest.approx(float(w.mean()), abs=1e-5) == 1.0
    assert (w > 0).all()


# ───────────────────────── features ─────────────────────────


def test_bar_features_are_bounded():
    """Features should stay in a narrow numeric range regardless of price level."""
    bars = _synthetic_bars(120)
    cfg = BarFeatureConfig(window=60, include_context=True)
    feat = window_features(bars, len(bars) - 1, cfg)
    assert feat.shape == (feature_dim(cfg),)
    assert np.all(np.abs(feat) <= 1.0), feat[np.abs(feat) > 1.0]


def test_bar_features_are_scale_invariant():
    """Features should barely change when the whole price series is scaled ×1000."""
    bars = _synthetic_bars(120)
    bars_scaled = [
        {**b, "open": b["open"] * 1000, "high": b["high"] * 1000, "low": b["low"] * 1000, "close": b["close"] * 1000}
        for b in bars
    ]
    cfg = BarFeatureConfig(window=60, include_context=True)
    f1 = window_features(bars, len(bars) - 1, cfg)
    f2 = window_features(bars_scaled, len(bars_scaled) - 1, cfg)
    # Price-relative features (log returns, ranges, body fraction) should match
    # within float noise. Context features (RSI, ATR%) may differ slightly due
    # to precision, so we use a generous tolerance.
    assert np.allclose(f1, f2, atol=1e-5), np.max(np.abs(f1 - f2))


# ───────────────────────── purged split ─────────────────────────


def test_purged_split_uses_future_only_for_labels():
    rows = _synthetic_rows(n=10)
    feat_slice, label_slice = _purged_feature_label_split(rows, label_fraction=0.3)
    assert feat_slice and label_slice
    # Label slice's earliest dataEndTime must be strictly after the feature
    # slice's latest dataEndTime (the purge takes care of boundary overlap).
    latest_feature_time = max((r.get("dataEndTime", "") for r in feat_slice))
    earliest_label_time = min((r.get("dataEndTime", "") for r in label_slice))
    assert earliest_label_time > latest_feature_time


# ───────────────────────── model / training ─────────────────────────


def test_detection_training_produces_v3_checkpoint():
    bars = _synthetic_bars(260)
    rows = _synthetic_rows()
    with tempfile.TemporaryDirectory() as td:
        path, meta = train_detection(
            {"inst-eurusd|M5": bars}, rows, "inst-eurusd", output_dir=td, epochs=3
        )
        ckpt = torch.load(path, weights_only=True)
        assert ckpt.get("model_version") == 3
        model = build_detection_model_from_checkpoint(ckpt)
        model.load_state_dict(ckpt["model_state"], strict=True)
        # Model must emit 3 classes.
        cfg = BarFeatureConfig(window=meta["bar_window"], include_context=True)
        feat = window_features(bars, len(bars) - 1, cfg)
        with torch.no_grad():
            logits, reg = model.forward_with_regression(torch.from_numpy(feat).float().unsqueeze(0))
        assert logits.shape == (1, 3)
        assert reg.shape == (1, 3)
        assert 0.0 <= float(reg.min()) and float(reg.max()) <= 1.0


def test_tabular_training_does_not_use_features_as_labels():
    """Regression guard: the tabular model must train from a held-out label slice."""
    rows = _synthetic_rows(n=20)
    with tempfile.TemporaryDirectory() as td:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(rows, f)
            p = f.name
        try:
            save_path, _ = train(
                p, {"inst-eurusd": "fiat"}, output_dir=td, instrument_id="inst-eurusd", epochs=3
            )
            meta_path = Path(td) / "instrument_bot_nn_inst-eurusd_meta.json"
            meta = json.loads(meta_path.read_text())
            assert meta.get("supervised_meta_selector") is True
            assert meta.get("label_slice_rows", 0) > 0
            assert meta.get("feature_slice_rows", 0) > 0
            ckpt = torch.load(save_path, weights_only=True)
            model = build_model_from_checkpoint(ckpt)
            assert model is not None
        finally:
            os.unlink(p)


def test_detection_mc_dropout_returns_entropy_bounds():
    cfg = DetectionConfig(window=60)
    model = StrategyDetectionNN(cfg)
    x = torch.zeros(1, cfg.input_dim)
    model.train()  # dropout on for MC
    with torch.no_grad():
        mean, entropy = model.forward_mc(x, samples=8)
    # Entropy for 3 classes is bounded in [0, ln(3)].
    assert 0.0 <= float(entropy[0]) <= float(np.log(3)) + 1e-5
    # Mean probabilities sum to 1 within tolerance.
    assert abs(float(mean[0].sum()) - 1.0) < 1e-4
