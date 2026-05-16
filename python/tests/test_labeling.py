"""Tests for cicada_nn.labeling — focused on the regression-target function
added in Phase 1 of the 'fully bot-driven' work. Without these labels,
the StrategyDetectionNN's regression head outputs random values and the
daemon has to clamp them to mode bounds (see daemon_runtime.daemon_predict).
"""

from __future__ import annotations

import numpy as np

from cicada_nn.labeling import mfe_mae_regression_labels


def _make_bars(closes, *, atr=1.0):
    """Build a list of OHLC bars from a closing-price array. high/low set to
    close ± atr/2 so _atr_proxy returns ~atr per bar."""
    return [
        {
            "open": float(c),
            "high": float(c) + atr / 2,
            "low": float(c) - atr / 2,
            "close": float(c),
            "volume": 1.0,
        }
        for c in closes
    ]


def test_regression_labels_shape_and_range():
    """Output is shape (n, 3) with every value in [0, 1] (sigmoid range)."""
    bars = _make_bars(list(range(100, 200)), atr=2.0)
    labels = np.array([1 if i % 3 == 0 else 0 if i % 3 == 1 else 2 for i in range(len(bars))], dtype=np.int64)
    reg = mfe_mae_regression_labels(bars, labels, horizon_bars=10)
    assert reg.shape == (len(bars), 3)
    assert reg.dtype == np.float32
    assert (reg >= 0.0).all()
    assert (reg <= 1.0).all()


def test_regression_labels_long_in_uptrend_has_large_tp():
    """A bar labelled LONG inside a strong uptrend should produce a high
    tp_r target (MFE >> MAE) and a small sl_atr_mult target (MAE is tiny)."""
    # Linearly rising price — pure favourable excursion for a long.
    bars = _make_bars([100.0 + i * 0.5 for i in range(40)], atr=1.0)
    labels = np.full(len(bars), 1, dtype=np.int64)  # long everywhere
    reg = mfe_mae_regression_labels(bars, labels, horizon_bars=20)
    # Bar 5: 20 bars of pure uptrend ahead → big MFE, near-zero MAE.
    # sl_atr_mult should hit its floor (small), tp_r should hit its ceiling.
    size_label, sl_label, tp_label = reg[5]
    # sl_label = (sl_atr_mult - 0.3) / 3.7 — floor 0.3 → label 0.0
    assert sl_label < 0.05, f"expected sl_label near 0 (tight SL), got {sl_label}"
    # tp_label = (tp_r - 1.0) / 2.0 — ceil 3.0 → label 1.0
    assert tp_label > 0.95, f"expected tp_label near 1 (large TP), got {tp_label}"
    # size_label = (size_mult - 0.5) / 1.5 — MFE > 2×MAE → size_mult=1.5 → label ≈ 0.67
    assert size_label > 0.5, f"expected aggressive size, got {size_label}"


def test_regression_labels_long_in_downtrend_has_wide_sl():
    """A bar labelled LONG inside a downtrend has large MAE and small MFE,
    so the optimal SL target should be wide and TP modest."""
    bars = _make_bars([100.0 - i * 0.5 for i in range(40)], atr=1.0)
    labels = np.full(len(bars), 1, dtype=np.int64)  # long everywhere (counter to trend)
    reg = mfe_mae_regression_labels(bars, labels, horizon_bars=20)
    size_label, sl_label, tp_label = reg[5]
    # Lots of adverse excursion → sl_atr_mult target hits the ceiling 4.0
    # → label = (4.0 - 0.3) / 3.7 = 1.0
    assert sl_label > 0.9, f"expected sl_label near 1 (wide SL), got {sl_label}"
    # MFE ≈ 0 → tp_r = MFE / MAE ≈ 0 → clamped to floor 1.0 → label 0.0
    assert tp_label < 0.05, f"expected tp_label near 0 (minimum TP), got {tp_label}"


def test_regression_labels_neutral_gets_defaults():
    """Bars labelled NEUTRAL (class 2) should leave the conservative defaults
    in place — the classification head will route them to ignore, but the
    MSE loss still pulls towards sane values to keep the head well-behaved."""
    bars = _make_bars([100.0 + i * 0.1 for i in range(20)])
    labels = np.full(len(bars), 2, dtype=np.int64)  # all neutral
    reg = mfe_mae_regression_labels(bars, labels, horizon_bars=10)
    # Defaults: size=0.5 → label 0.0; sl=1.0 → label (1.0-0.3)/3.7 ≈ 0.189;
    #           tp=1.5 → label (1.5-1.0)/2.0 = 0.25
    np.testing.assert_allclose(reg[0], [0.0, (1.0 - 0.3) / 3.7, 0.25], atol=1e-4)
    np.testing.assert_allclose(reg[10], [0.0, (1.0 - 0.3) / 3.7, 0.25], atol=1e-4)


def test_regression_labels_short_in_downtrend_has_large_tp():
    """Mirror of the long-uptrend test — a SHORT in a downtrend captures
    the move; SL stays tight, TP hits its ceiling."""
    bars = _make_bars([100.0 - i * 0.5 for i in range(40)], atr=1.0)
    labels = np.full(len(bars), 0, dtype=np.int64)  # short everywhere
    reg = mfe_mae_regression_labels(bars, labels, horizon_bars=20)
    size_label, sl_label, tp_label = reg[5]
    assert sl_label < 0.05
    assert tp_label > 0.95
    assert size_label > 0.5


# ── Phase 2: simulated position states ───────────────────────────────────────


from cicada_nn.labeling import simulate_position_states  # noqa: E402


def test_simulated_position_states_track_open_count():
    """When every other bar is a LONG signal, the open-count grows
    monotonically until the first virtual exit at bar=horizon, then plateaus."""
    n = 30
    horizon = 5
    labels = np.array([1 if i % 2 == 0 else 2 for i in range(n)], dtype=np.int64)
    states, _ = simulate_position_states(labels, horizon_bars=horizon)
    assert len(states) == n
    # Bar 0: no priors → all zeros
    assert states[0]["n_open_long"] == 0
    assert states[0]["n_open_short"] == 0
    # Bar 2: position from bar 0 still open (closes at bar 5) → 1 long
    assert states[2]["n_open_long"] == 1
    # Bar 4: positions from 0, 2 still open → 2 longs (soft_cap=3 default; not yet hit)
    assert states[4]["n_open_long"] == 2
    # Bar 6: position from 0 closed (exit at bar 5); 2 + 4 still open
    assert states[6]["n_open_long"] == 2
    # Always 0 shorts (no short signals in labels)
    assert all(s["n_open_short"] == 0 for s in states)


def test_simulated_position_states_split_long_short():
    """Mixed long/short signals populate both counts independently — and
    once same-side count hits soft_cap, further same-side entries are
    blocked and their labels rewritten to NEUTRAL."""
    labels = np.array([1, 0, 1, 0, 1, 0, 1, 0, 2, 2], dtype=np.int64)
    states, eff = simulate_position_states(labels, horizon_bars=10, soft_cap=3)
    # By bar 6 (BEFORE its decision): longs from 0/2/4, shorts from 1/3/5
    assert states[6]["n_open_long"] == 3
    assert states[6]["n_open_short"] == 3
    # Bar 6 wanted LONG but n_long==3==soft_cap → blocked → effective label = NEUTRAL
    assert eff[6] == 2
    # Bar 7 wanted SHORT but n_short==3==soft_cap → blocked → NEUTRAL
    assert eff[7] == 2
    # First 6 bars all entered normally (under cap)
    assert list(eff[:6]) == [1, 0, 1, 0, 1, 0]


def test_simulated_position_states_bars_since_last_entry():
    """bars_since_last_entry tracks the most-recent directional signal."""
    labels = np.array([2, 2, 1, 2, 2, 2, 2, 2, 2, 2], dtype=np.int64)
    states, _ = simulate_position_states(labels, horizon_bars=5)
    # Before bar 2: no entries yet → big sentinel
    assert states[0]["bars_since_last_entry"] >= 100
    assert states[2]["bars_since_last_entry"] >= 100  # bar 2's state is BEFORE the bar-2 entry
    # Bar 3: 1 bar after the bar-2 entry
    assert states[3]["bars_since_last_entry"] == 1
    # Bar 5: 3 bars after
    assert states[5]["bars_since_last_entry"] == 3
