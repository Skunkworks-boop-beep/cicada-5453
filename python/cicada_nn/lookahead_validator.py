"""Look-ahead bias validator (spec section 5).

Mandatory pre-train pipeline step. For every row at time T:
  1. Every feature column's source timestamp must be ≤ T.
  2. No label column may appear in the feature matrix.

A model that leaks future data backtests perfectly and fails immediately
in live trading; the spec is explicit that this check is not optional.

Two surfaces:

* :func:`validate_features` — array/dataframe input. Accepts a 2-D feature
  matrix plus a parallel timestamp matrix (same shape) so each cell can be
  checked column-by-column. Pure numpy; no torch dep.
* :func:`validate_no_label_in_features` — string set comparison.

:func:`assert_clean` is the convenience composite that every Stage 2B
module calls before returning a frame.
"""

from __future__ import annotations

from typing import Iterable, Sequence


class LookaheadLeakError(AssertionError):
    """Raised when feature timestamps exceed the row time, or a label name
    leaks into the feature columns. Inherits from AssertionError so the
    same except clauses callers already use for assertion-based contracts
    catch it; new callers should prefer this concrete type."""


def _to_2d_floats(name: str, data) -> list[list[float]]:
    """Coerce a list-of-lists / numpy array / dataframe into a 2-D list of
    floats. Keeps the validator usable without pandas at runtime."""
    if hasattr(data, "to_numpy"):  # pandas.DataFrame
        return [[float(v) for v in row] for row in data.to_numpy().tolist()]
    if hasattr(data, "tolist"):  # numpy.ndarray
        as_list = data.tolist()
    else:
        as_list = list(data)
    out: list[list[float]] = []
    for r, row in enumerate(as_list):
        if not hasattr(row, "__iter__"):
            raise TypeError(f"{name}: row {r} is scalar; expected 2-D shape")
        out.append([float(v) for v in row])
    return out


def _to_1d_floats(name: str, data) -> list[float]:
    if hasattr(data, "to_numpy"):
        return [float(v) for v in data.to_numpy().tolist()]
    if hasattr(data, "tolist"):
        return [float(v) for v in data.tolist()]
    return [float(v) for v in list(data)]


def validate_features(
    *,
    feature_matrix,
    feature_timestamps,
    row_timestamps,
    feature_columns: Sequence[str] | None = None,
) -> None:
    """Assert ``feature_timestamps[r, c] <= row_timestamps[r]`` for every cell.

    Parameters
    ----------
    feature_matrix:
        2-D array (rows × features) — the actual feature values. Used only
        for shape validation; not inspected for content.
    feature_timestamps:
        2-D array of the same shape giving the source-bar timestamp for
        each cell. A feature derived from bar k carries ``bars[k]['time']``.
    row_timestamps:
        1-D array giving the row's time T (length = number of rows).
    feature_columns:
        Optional column names so the error message can name the offender.
        When omitted, columns are reported as ``col_<index>``.

    Raises
    ------
    LookaheadLeakError
        If any cell's feature timestamp is strictly greater than its row's
        timestamp. The error message identifies the row index, column name,
        and the offending values for the first leak found (deterministic).
    """
    feats = _to_2d_floats("feature_matrix", feature_matrix)
    feat_ts = _to_2d_floats("feature_timestamps", feature_timestamps)
    row_ts = _to_1d_floats("row_timestamps", row_timestamps)

    n_rows = len(feats)
    if len(feat_ts) != n_rows:
        raise LookaheadLeakError(
            f"shape mismatch: feature_matrix has {n_rows} rows but "
            f"feature_timestamps has {len(feat_ts)}"
        )
    if len(row_ts) != n_rows:
        raise LookaheadLeakError(
            f"shape mismatch: feature_matrix has {n_rows} rows but "
            f"row_timestamps has {len(row_ts)}"
        )
    if n_rows == 0:
        return

    n_cols = len(feats[0])
    for r in range(n_rows):
        if len(feat_ts[r]) != n_cols:
            raise LookaheadLeakError(
                f"shape mismatch: feature_matrix row {r} has {n_cols} cols "
                f"but feature_timestamps row {r} has {len(feat_ts[r])}"
            )
        if feature_columns is not None and len(feature_columns) != n_cols:
            raise LookaheadLeakError(
                f"feature_columns has {len(feature_columns)} names but "
                f"feature_matrix row {r} has {n_cols} cols"
            )

    # First-leak-wins: deterministic error so test fixtures can pin row+col.
    for r in range(n_rows):
        T = row_ts[r]
        for c in range(n_cols):
            if feat_ts[r][c] > T:
                col_name = (
                    feature_columns[c]
                    if feature_columns is not None
                    else f"col_{c}"
                )
                raise LookaheadLeakError(
                    f"look-ahead leak: row={r} col={col_name!r} "
                    f"feature_t={feat_ts[r][c]} > row_t={T}"
                )


def validate_no_label_in_features(
    *,
    feature_columns: Iterable[str],
    label_columns: Iterable[str],
) -> None:
    """Assert no label column name appears among the feature columns.

    Spec section 5 — labels are derived from data > T; if one of those
    columns ends up in the feature matrix the model has trivial access to
    its own target. ``train.py`` already guards against this for the
    legacy 3-class label, but the 4-class context-layer schema multiplies
    the surface area, so the check is centralised here.
    """
    feats = list(feature_columns)
    labels = set(label_columns)
    leaks = [c for c in feats if c in labels]
    if leaks:
        raise LookaheadLeakError(
            f"label columns leaked into features: {sorted(leaks)}"
        )


def assert_clean(
    *,
    feature_matrix,
    feature_timestamps,
    row_timestamps,
    feature_columns: Sequence[str] | None = None,
    label_columns: Sequence[str] | None = None,
) -> None:
    """Run both checks. Modules call this immediately before returning a
    feature frame to the trainer. Failure aborts training loudly."""
    if feature_columns is not None and label_columns is not None:
        validate_no_label_in_features(
            feature_columns=feature_columns, label_columns=label_columns
        )
    validate_features(
        feature_matrix=feature_matrix,
        feature_timestamps=feature_timestamps,
        row_timestamps=row_timestamps,
        feature_columns=feature_columns,
    )
