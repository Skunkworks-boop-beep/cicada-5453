"""Stage 2B: 4-class context-layer NN training (spec phase 7).

Pinned guarantees:

* ``ContextLayerNN`` outputs (B, T, 4) — softmax sums to ~1 per row.
* ``train_context_layer`` calls the lookahead validator before any tensor
  construction; injecting a leak raises before training starts.
* ``bidirectional_labels`` maps context-layer rows into the 4-class
  scheme; FAKEOUT_REVERSAL beats LONG/SHORT when both fire.
* End-to-end training on a tiny fixture saves a checkpoint.
"""

from __future__ import annotations

import math

import numpy as np
import pytest
import torch

from cicada_nn.context_layer import FEATURE_COLUMNS, LABEL_COLUMNS, build_context_layer
from cicada_nn.fakeout_detection import FakeoutEvent
from cicada_nn.geometric_map import GeometricMap, GeometricMapMeta, SRLevel, SwingPoint, VolumeNode
from cicada_nn.labeling import (
    LABEL_FAKEOUT_REVERSAL,
    LABEL_LONG,
    LABEL_NEUTRAL,
    LABEL_SHORT,
    NUM_BIDIRECTIONAL_CLASSES,
    bidirectional_labels,
)
from cicada_nn.lookahead_validator import LookaheadLeakError
from cicada_nn.model import ContextLayerConfig, ContextLayerNN
from cicada_nn.train import train_context_layer


# ── Bidirectional label mapping ──────────────────────────────────────────


def test_bidirectional_labels_priority_order():
    rows = [
        {"labels": {"LONG": 1.0, "SHORT": 0.0, "NEUTRAL": 0.0, "FAKEOUT_REVERSAL": 0.0}},
        {"labels": {"LONG": 0.0, "SHORT": 1.0, "NEUTRAL": 0.0, "FAKEOUT_REVERSAL": 0.0}},
        {"labels": {"LONG": 0.0, "SHORT": 0.0, "NEUTRAL": 1.0, "FAKEOUT_REVERSAL": 0.0}},
        {"labels": {"LONG": 1.0, "SHORT": 0.0, "NEUTRAL": 0.0, "FAKEOUT_REVERSAL": 1.0}},  # rare-event wins
    ]
    arr = bidirectional_labels(rows)
    assert arr.tolist() == [LABEL_LONG, LABEL_SHORT, LABEL_NEUTRAL, LABEL_FAKEOUT_REVERSAL]


def test_bidirectional_labels_dtype():
    arr = bidirectional_labels([{"labels": {"NEUTRAL": 1.0}}])
    assert arr.dtype == np.int64


# ── Model surface ────────────────────────────────────────────────────────


def test_model_outputs_4_class_softmax():
    cfg = ContextLayerConfig(feature_dim=12)
    model = ContextLayerNN(cfg)
    x = torch.zeros(2, 30, cfg.feature_dim)
    logits = model(x)
    assert logits.shape == (2, 30, NUM_BIDIRECTIONAL_CLASSES)
    probs = torch.softmax(logits, dim=-1)
    sums = probs.sum(dim=-1)
    assert torch.allclose(sums, torch.ones_like(sums), atol=1e-5)


def test_temperature_initialised_to_one():
    model = ContextLayerNN(ContextLayerConfig(feature_dim=12))
    assert math.isclose(float(model.temperature.item()), 1.0, abs_tol=1e-5)


def test_predict_classes_deterministic_under_eval():
    """Same input → same predictions when model is in eval mode."""
    cfg = ContextLayerConfig(feature_dim=12)
    torch.manual_seed(7)
    model = ContextLayerNN(cfg)
    model.eval()
    x = torch.randn(1, 16, cfg.feature_dim)
    a = model.predict_classes(x)
    b = model.predict_classes(x)
    assert torch.equal(a, b)


# ── End-to-end training ──────────────────────────────────────────────────


def _bars(n: int = 30) -> list[dict]:
    out: list[dict] = []
    t0 = 1_700_000_000
    for i in range(n):
        c = 1.10 + 0.001 * np.sin(i * 0.4)
        out.append(
            {
                "time": t0 + i * 60,
                "open": c - 0.0001,
                "high": c + 0.0006,
                "low": c - 0.0006,
                "close": float(c),
                "volume": 100,
            }
        )
    return out


def _gmap(bars: list[dict]) -> GeometricMap:
    return GeometricMap(
        symbol="EURUSD",
        bins=[1.099, 1.100, 1.101, 1.102],
        volume_nodes=[VolumeNode(price=1.100, score=2.0)],
        swing_highs=[SwingPoint(idx=5, time=float(bars[5]["time"]), price=float(bars[5]["high"]))],
        swing_lows=[SwingPoint(idx=12, time=float(bars[12]["time"]), price=float(bars[12]["low"]))],
        support_levels=[SRLevel(price=1.099, kind="support", confirmations=2, score=2.0)],
        resistance_levels=[SRLevel(price=1.101, kind="resistance", confirmations=2, score=2.0)],
        meta=GeometricMapMeta(
            version=1, symbol="EURUSD", n_bars=len(bars),
            bar_first_time=float(bars[0]["time"]),
            bar_last_time=float(bars[-1]["time"]),
            atr_at_build=0.001,
            input_sha="0" * 64,
        ),
    )


def test_train_context_layer_end_to_end(tmp_path):
    bars = _bars()
    fakeouts = [
        FakeoutEvent(
            bar_idx=10,
            bar_time=float(bars[10]["time"]),
            level_price=1.101,
            level_kind="resistance",
            breach_magnitude=0.0005,
            time_beyond_bars=1,
            volume_contraction=True,
            wick_rejection=True,
            reversal_velocity=0.7,
        )
    ]
    rows = build_context_layer(bars=bars, geometric_map=_gmap(bars), fakeouts=fakeouts)
    save_path, metrics = train_context_layer(
        context_rows=rows,
        instrument_id="inst-eurusd",
        output_dir=tmp_path,
        epochs=3,
        seed=0,
    )
    assert save_path.exists()
    assert save_path.name == "context_layer_inst-eurusd.pt"
    assert metrics["n_rows"] == len(rows)
    assert math.isfinite(metrics["final_loss"])
    assert 0.0 <= metrics["accuracy"] <= 1.0
    # Temperature is finite and positive (initialised to 1.0; small drift OK).
    assert metrics["temperature"] > 0.0
    # Checkpoint carries the contextv1 marker so the loader can dispatch.
    cp = torch.load(save_path, map_location="cpu", weights_only=False)
    assert cp["model_version"] == "contextv1"
    assert cp["num_classes"] == 4


def test_train_context_layer_blocks_on_leak(tmp_path):
    """Hand-craft a row whose feature_t is in the future relative to row.t.
    The trainer must call the validator and abort before any tensor work."""
    bars = _bars(n=30)
    rows = build_context_layer(bars=bars, geometric_map=_gmap(bars))
    # Convert to dict shape so we can corrupt one feature_t cleanly.
    leaked_rows = [
        {
            "features": dict(r.features),
            "feature_t": dict(r.feature_t),
            "labels": dict(r.labels),
            "t": r.t,
        }
        for r in rows
    ]
    leaked_rows[0]["feature_t"]["close"] = leaked_rows[0]["t"] + 999.0
    with pytest.raises(LookaheadLeakError):
        train_context_layer(
            context_rows=leaked_rows,
            instrument_id="inst-bad",
            output_dir=tmp_path,
            epochs=1,
        )


def test_train_context_layer_rejects_empty():
    with pytest.raises(ValueError):
        train_context_layer(context_rows=[], instrument_id="inst-empty")
