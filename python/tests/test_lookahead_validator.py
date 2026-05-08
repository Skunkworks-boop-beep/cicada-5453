"""Stage 2B: look-ahead bias validator (spec section 5).

These tests pin the contract every Stage 2B module shape-tests against:

* a clean fixture passes silently;
* a deliberately leaked timestamp raises `LookaheadLeakError` with the
  offending row index and column name in the message;
* a label-name collision in the feature column list also raises.
"""

from __future__ import annotations

import pytest

from cicada_nn.lookahead_validator import (
    LookaheadLeakError,
    assert_clean,
    validate_features,
    validate_no_label_in_features,
)


# ── Fixtures ─────────────────────────────────────────────────────────────


def _clean_inputs():
    """3 rows, 2 features. Every feature_t equals row_t; clean."""
    feats = [[1.0, 2.0], [1.5, 2.5], [2.0, 3.0]]
    feat_ts = [[10.0, 10.0], [11.0, 11.0], [12.0, 12.0]]
    row_ts = [10.0, 11.0, 12.0]
    return feats, feat_ts, row_ts


# ── validate_features ────────────────────────────────────────────────────


def test_clean_inputs_pass_silently():
    feats, feat_ts, row_ts = _clean_inputs()
    validate_features(
        feature_matrix=feats,
        feature_timestamps=feat_ts,
        row_timestamps=row_ts,
        feature_columns=["mom", "vol"],
    )


def test_leaked_cell_raises_with_row_and_col():
    feats, feat_ts, row_ts = _clean_inputs()
    # Row 1, col `mom` reads from a future bar at t=20 while row_t=11.
    feat_ts[1][0] = 20.0
    with pytest.raises(LookaheadLeakError) as excinfo:
        validate_features(
            feature_matrix=feats,
            feature_timestamps=feat_ts,
            row_timestamps=row_ts,
            feature_columns=["mom", "vol"],
        )
    msg = str(excinfo.value)
    assert "row=1" in msg
    assert "'mom'" in msg
    assert "feature_t=20" in msg
    assert "row_t=11" in msg


def test_leak_without_column_names_uses_indexed_label():
    feats, feat_ts, row_ts = _clean_inputs()
    feat_ts[2][1] = 99.0
    with pytest.raises(LookaheadLeakError) as excinfo:
        validate_features(
            feature_matrix=feats,
            feature_timestamps=feat_ts,
            row_timestamps=row_ts,
        )
    msg = str(excinfo.value)
    assert "row=2" in msg
    assert "'col_1'" in msg


def test_first_leak_wins_deterministically():
    """Two leaks on different rows: validator must report the lower-indexed
    one first so test fixtures can pin against an exact (row, col)."""
    feats, feat_ts, row_ts = _clean_inputs()
    feat_ts[2][0] = 30.0
    feat_ts[1][1] = 20.0
    with pytest.raises(LookaheadLeakError) as excinfo:
        validate_features(
            feature_matrix=feats,
            feature_timestamps=feat_ts,
            row_timestamps=row_ts,
            feature_columns=["mom", "vol"],
        )
    assert "row=1" in str(excinfo.value)


def test_shape_mismatch_raises():
    feats = [[1.0, 2.0], [1.5, 2.5]]
    feat_ts = [[10.0, 10.0]]  # too few rows
    row_ts = [10.0, 11.0]
    with pytest.raises(LookaheadLeakError) as excinfo:
        validate_features(
            feature_matrix=feats,
            feature_timestamps=feat_ts,
            row_timestamps=row_ts,
        )
    assert "shape mismatch" in str(excinfo.value)


def test_empty_inputs_pass():
    validate_features(
        feature_matrix=[],
        feature_timestamps=[],
        row_timestamps=[],
        feature_columns=[],
    )


def test_equal_timestamps_pass():
    """feature_t == row_t is allowed (the feature is derived from the row's
    own bar at close)."""
    feats = [[1.0]]
    feat_ts = [[10.0]]
    row_ts = [10.0]
    validate_features(
        feature_matrix=feats,
        feature_timestamps=feat_ts,
        row_timestamps=row_ts,
    )


# ── validate_no_label_in_features ────────────────────────────────────────


def test_no_label_collision_passes():
    validate_no_label_in_features(
        feature_columns=["mom", "vol", "rsi"],
        label_columns=["LONG", "SHORT", "NEUTRAL", "FAKEOUT_REVERSAL"],
    )


def test_label_in_features_raises_with_name():
    with pytest.raises(LookaheadLeakError) as excinfo:
        validate_no_label_in_features(
            feature_columns=["mom", "LONG", "rsi"],
            label_columns=["LONG", "SHORT", "NEUTRAL"],
        )
    msg = str(excinfo.value)
    assert "label columns leaked into features" in msg
    assert "LONG" in msg


# ── assert_clean composite ───────────────────────────────────────────────


def test_assert_clean_passes_clean_fixture():
    feats, feat_ts, row_ts = _clean_inputs()
    assert_clean(
        feature_matrix=feats,
        feature_timestamps=feat_ts,
        row_timestamps=row_ts,
        feature_columns=["mom", "vol"],
        label_columns=["LONG", "SHORT"],
    )


def test_assert_clean_catches_label_collision_before_timestamp_check():
    """Label name collision is the cheapest check; the composite should
    surface it first so the error is the most actionable one."""
    feats, feat_ts, row_ts = _clean_inputs()
    feat_ts[0][0] = 999.0  # also a leak; should not be the reported error
    with pytest.raises(LookaheadLeakError) as excinfo:
        assert_clean(
            feature_matrix=feats,
            feature_timestamps=feat_ts,
            row_timestamps=row_ts,
            feature_columns=["mom", "LONG"],
            label_columns=["LONG", "SHORT"],
        )
    assert "label columns leaked into features" in str(excinfo.value)


def test_assert_clean_catches_timestamp_leak_when_no_name_collision():
    feats, feat_ts, row_ts = _clean_inputs()
    feat_ts[0][1] = 50.0
    with pytest.raises(LookaheadLeakError) as excinfo:
        assert_clean(
            feature_matrix=feats,
            feature_timestamps=feat_ts,
            row_timestamps=row_ts,
            feature_columns=["mom", "vol"],
            label_columns=["LONG", "SHORT"],
        )
    msg = str(excinfo.value)
    assert "row=0" in msg
    assert "'vol'" in msg
