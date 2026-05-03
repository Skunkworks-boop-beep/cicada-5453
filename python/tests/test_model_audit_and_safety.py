"""Regression tests for the turnaround pass.

Locks in:
* The promotion floor (val_accuracy below random + 4 pp ⇒ ``safe_to_use=False``).
* The class-weight cap (≤ 5×) that prevents the runaway "predict the rare
  class" failure mode that triggered the production losses.
* The audit endpoint correctly classifies missing / inverted / below-floor
  models from their meta files.
* The triple-barrier defaults are now symmetric.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.model_audit import (
    PROMOTION_FLOOR,
    RANDOM_BASELINE,
    audit_checkpoints,
    audit_summary,
)
from cicada_nn.train_detection import _class_weights_from_labels


# ── Class-weight cap ────────────────────────────────────────────────────────


def test_class_weights_capped_at_five():
    # Heavy imbalance: 99% short, 0.5% long, 0.5% neutral.
    labels = np.zeros(2000, dtype=np.int64)
    labels[:10] = 1
    labels[10:20] = 2
    weights = _class_weights_from_labels(labels)
    assert weights.max().item() <= 5.0 + 1e-6
    assert weights.min().item() >= 1.0 / 5.0 - 1e-6


def test_class_weights_balanced_when_data_is_balanced():
    labels = np.tile(np.arange(3), 333)
    weights = _class_weights_from_labels(labels)
    # All three weights should be ≈ 1.0 (balanced data).
    assert all(abs(w - 1.0) < 1e-2 for w in weights.tolist())


# ── Audit classification ────────────────────────────────────────────────────


def _write_meta(tmp_path: Path, name: str, **fields) -> Path:
    p = tmp_path / f"instrument_detection_{name}_meta.json"
    p.write_text(json.dumps(fields))
    return p


def test_audit_marks_inverted_below_half_random(tmp_path):
    _write_meta(tmp_path, "test1", val_accuracy=0.005, instrument_id="inst-x")
    summary = audit_summary(audit_checkpoints(tmp_path))
    assert summary["total"] == 1
    assert summary["unsafe"] == 1
    assert summary["inverted"] == 1
    assert summary["entries"][0]["verdict"] == "inverted"


def test_audit_marks_below_floor_when_close_to_random(tmp_path):
    _write_meta(tmp_path, "test2", val_accuracy=0.30, instrument_id="inst-x")
    summary = audit_summary(audit_checkpoints(tmp_path))
    assert summary["entries"][0]["verdict"] == "below_floor"
    assert summary["unsafe"] == 1


def test_audit_marks_ok_when_above_promotion_floor(tmp_path):
    _write_meta(tmp_path, "test3", val_accuracy=0.45, instrument_id="inst-x")
    summary = audit_summary(audit_checkpoints(tmp_path))
    assert summary["entries"][0]["verdict"] == "ok"
    assert summary["ok"] == 1


def test_audit_handles_missing_metric(tmp_path):
    _write_meta(tmp_path, "test4", instrument_id="inst-x")
    summary = audit_summary(audit_checkpoints(tmp_path))
    assert summary["entries"][0]["verdict"] == "missing_metric"
    assert summary["unsafe"] == 1


def test_audit_promotion_floor_is_4pp_above_random():
    # Sanity: the floor is one third of decisions plus a 4 pp safety margin.
    assert RANDOM_BASELINE == pytest.approx(1.0 / 3.0)
    assert PROMOTION_FLOOR == pytest.approx(RANDOM_BASELINE + 0.04)


def test_audit_explicit_safe_flag_overrides_value(tmp_path):
    # Newer trainer writes safe_to_use=False when val_acc < floor; respect it
    # even if the value alone might pass.
    _write_meta(tmp_path, "test5", val_accuracy=0.50, safe_to_use=False, instrument_id="inst-x")
    summary = audit_summary(audit_checkpoints(tmp_path))
    assert summary["entries"][0]["safe_to_use"] is False


# ── Triple-barrier symmetric default ────────────────────────────────────────


def test_train_detection_default_barriers_symmetric():
    """Locks in the symmetric (1.0, 1.0) default that fixes the SHORT-skewed
    label distribution that triggered the failure mode."""
    import inspect
    from cicada_nn.train_detection import train_detection
    sig = inspect.signature(train_detection)
    assert sig.parameters["tp_mult"].default == 1.0
    assert sig.parameters["sl_mult"].default == 1.0
