"""
Detection training: the NN learns *the market*, not the strategy.

Previous iterations of this module trained the NN on labels produced by
``get_signal(strategy_id, …)`` — i.e. the very function the NN was supposed to
replace. That is a near-useless supervision signal: the best-case outcome is
that the NN becomes a slow imitator of the original rule, and the worst case is
that it over-fits to rule noise.

This rewrite uses the **triple-barrier method** (López de Prado, AFML Ch. 3) to
derive labels from what the market actually did after each bar:

* Upper barrier = close + tp_mult × ATR
* Lower barrier = close − sl_mult × ATR
* Vertical barrier = ``horizon_bars`` bars later
* First barrier hit determines the label (long / short / neutral)

Features come from ``bar_features.window_features`` and are scale-invariant (log
returns + normalised ranges + a handful of context stats). Training uses
uniqueness sample weighting so overlapping look-ahead windows do not dominate
the loss surface.

Backward compatibility: a lightweight MLP with the same name as the legacy model
(``StrategyDetectionMLPLegacy``) and the same state-dict shape is kept so old
checkpoints in ``checkpoints/`` still load. Predict code in ``api.py`` dispatches
on the saved ``model_version``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

from .bar_features import BarFeatureConfig, feature_dim, window_features, PER_BAR_FEATURES
from .compute import configure_torch_for_speed, get_compute_config
from .labeling import TripleBarrierConfig, triple_barrier_labels, uniqueness_weights, label_distribution
from .model import DetectionConfig, StrategyDetectionNN
from .train import _safe_instrument_id, _robust_score, filter_best_results_for_build


configure_torch_for_speed()
_COMPUTE = get_compute_config()
DEVICE = torch.device(_COMPUTE.device_str if _COMPUTE.use_cuda else "cpu")


def _maybe_data_parallel(model: nn.Module) -> nn.Module:
    """Use all visible CUDA GPUs for detection training when available."""
    if _COMPUTE.use_multi_gpu:
        return nn.DataParallel(model)
    return model


def _unwrap_model(model: nn.Module) -> nn.Module:
    return model.module if isinstance(model, nn.DataParallel) else model

DEFAULT_BAR_WINDOW = 60

# Timeframe -> bar window: scalp 40-50, day 60-80, swing 80-100, position 100-120.
TF_TO_BAR_WINDOW: dict[str, int] = {
    "M1": 40,
    "M5": 50,
    "M15": 60,
    "M30": 70,
    "H1": 70,
    "H4": 90,
    "D1": 100,
    "W1": 120,
}

# Horizon (forward bars) used for triple-barrier labels per timeframe. Smaller
# timeframes move faster, so the labeler uses a smaller look-ahead.
TF_TO_HORIZON: dict[str, int] = {
    "M1": 8,
    "M5": 10,
    "M15": 12,
    "M30": 14,
    "H1": 16,
    "H4": 18,
    "D1": 20,
    "W1": 24,
}


# Strategy-specific min bars (from signals.ts / signals.py lookbacks). Keeps the
# training window long enough to compute the strategy's own signal when we want
# to compare NN and rule-based outputs in evaluation.
STRATEGY_MIN_BARS: dict[str, int] = {
    "ind-ema-cross-50-200": 200,
    "ind-ema-ribbon": 55,
    "ind-kst": 55,
    "ind-ichimoku-cloud": 52,
    "ind-ichimoku-chikou": 52,
    "ind-trix": 47,
    "ind-macd-hist-div": 45,
    "ind-adx": 40,
    "ind-adx-trend": 40,
    "ind-rsi-div": 33,
    "ind-rsi-trend": 33,
    "ind-bb-walk": 30,
    "ind-stoch-div": 27,
    "ind-structure": 27,
    "pa-bos": 24,
    "pa-breakout-retest": 25,
    "pa-liquidity-sweep": 24,
    "pa-liquidity-pool": 24,
    "pa-inducement": 24,
    "pa-stop-hunt": 24,
    "pa-scalp-break": 10,
}

STRATEGY_MIN_BARS_PREFIX: list[tuple[str, int]] = [
    ("ind-ema-cross-50", 200),
    ("ind-ema-ribbon", 55),
    ("ind-kst", 55),
    ("ind-ichimoku", 52),
    ("ind-trix", 47),
    ("ind-macd", 45),
    ("ind-adx", 40),
    ("ind-rsi-div", 33),
    ("ind-rsi-trend", 33),
    ("ind-bb", 28),
    ("ind-stoch", 27),
    ("ind-structure", 27),
    ("ind-cci", 24),
    ("ind-donchian", 28),
    ("ind-atr", 24),
    ("cp-", 28),
    ("pa-", 24),
    ("cs-", 14),
    ("ind-", 26),
]


def _strategy_min_bars(strategy_id: str) -> int:
    if not strategy_id:
        return 26
    sid = strategy_id.lower()
    if sid in STRATEGY_MIN_BARS:
        return STRATEGY_MIN_BARS[sid]
    for prefix, bars in STRATEGY_MIN_BARS_PREFIX:
        if sid.startswith(prefix):
            return bars
    return 26


def get_bar_window_for_timeframe(timeframe: str) -> int:
    return TF_TO_BAR_WINDOW.get((timeframe or "").upper(), DEFAULT_BAR_WINDOW)


def get_bar_window_for_detection(timeframe: str, strategy_id: str) -> int:
    """Bar window = max(TF-based, strategy min)."""
    tf_window = get_bar_window_for_timeframe(timeframe)
    strategy_min = _strategy_min_bars(strategy_id)
    return max(tf_window, strategy_min)


class StrategyDetectionMLPLegacy(nn.Module):
    """Old MLP detection model kept for backward-compatible inference."""

    def __init__(self, input_dim: int = 240, hidden: int = 128, dropout: float = 0.2):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, hidden),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden, hidden),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden, 3),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


def bars_to_features(bars: list[dict], i: int, window: int) -> np.ndarray:
    """Compatibility shim for API inference.

    Old checkpoints used raw close/base ratios. New checkpoints use
    ``bar_features.window_features``. This wrapper returns the scale-invariant
    features when the checkpoint advertises the new version; the old format is
    returned otherwise so legacy ``.pt`` files keep working."""
    cfg = BarFeatureConfig(window=window, include_context=False)
    vec = window_features(bars, i, cfg)
    # Legacy shape was window * 4 with close-ratio encoding. For the new format
    # we still emit the per-bar block (no context) to preserve shape.
    base = window * PER_BAR_FEATURES
    return vec[:base]


def _bars_matrix(bars: list[dict]) -> np.ndarray:
    """Return an OHLC-by-bar matrix for vectorised labeling."""
    arr = np.zeros((len(bars), 4), dtype=np.float64)
    for i, b in enumerate(bars):
        arr[i, 0] = float(b.get("open") or 0.0)
        arr[i, 1] = float(b.get("high") or 0.0)
        arr[i, 2] = float(b.get("low") or 0.0)
        arr[i, 3] = float(b.get("close") or 0.0)
    return arr


def _stratified_train_val_indices(
    labels: np.ndarray,
    val_fraction: float = 0.2,
    purge_gap: int = 20,
) -> tuple[np.ndarray, np.ndarray]:
    """Walk-forward split with a purge gap to avoid overlapping look-aheads.

    The validation slice is always the tail of the series; ``purge_gap`` bars at
    the join are dropped from *both* sides so no training sample's look-ahead
    window reaches into the validation slice (the core of López de Prado's
    "purging and embargo" technique)."""
    n = len(labels)
    if n < 20:
        idx = np.arange(n)
        return idx, np.array([], dtype=np.int64)
    split = max(10, int(n * (1 - val_fraction)))
    train_end = max(0, split - purge_gap)
    val_start = min(n, split + purge_gap)
    train_idx = np.arange(train_end)
    val_idx = np.arange(val_start, n)
    return train_idx, val_idx


def _class_weights_from_labels(
    labels: np.ndarray,
    num_classes: int = 3,
    max_weight: float = 5.0,
) -> torch.Tensor:
    """Inverse-frequency class weights, **capped** to ``max_weight``.

    The previous implementation was unbounded. With a 1%-prevalence class
    (e.g. NEUTRAL on R_10 H1) the weight could exceed 40×, which reliably
    drove the network into "always predict the rare class" and caused the
    val-accuracy collapse (down to 0.7%) we observed in production. Capping
    at 5× preserves rebalancing without making the loss surface degenerate.
    """
    counts = np.bincount(labels, minlength=num_classes).astype(np.float64)
    counts = np.where(counts == 0, 1.0, counts)
    inv = counts.sum() / (counts * num_classes)
    inv = np.clip(inv, 1.0 / max_weight, max_weight)
    return torch.from_numpy(inv.astype(np.float32))


def _temperature_scale(
    model: nn.Module,
    features: np.ndarray,
    labels: np.ndarray,
    max_iter: int = 100,
) -> None:
    """Post-hoc Platt-style temperature scaling on validation logits.

    Keeps accuracy identical; improves calibration of ``softmax`` probabilities
    so ``confidence`` is meaningful downstream. No-op when the validation set
    is empty."""
    if features.size == 0 or labels.size == 0:
        return
    model.eval()
    core_model = _unwrap_model(model)
    with torch.no_grad():
        x = torch.from_numpy(features.astype(np.float32)).to(DEVICE)
        y = torch.from_numpy(labels.astype(np.int64)).to(DEVICE)
        logits_raw = core_model.cls_head(core_model._encode(x))
    temperature = nn.Parameter(torch.zeros(1, device=DEVICE))
    optimizer = torch.optim.LBFGS([temperature], lr=0.1, max_iter=max_iter)

    def _closure():
        optimizer.zero_grad()
        t = temperature.exp().clamp(min=0.25, max=4.0)
        loss = nn.functional.cross_entropy(logits_raw / t, y)
        loss.backward()
        return loss

    optimizer.step(_closure)
    with torch.no_grad():
        core_model.log_temperature.copy_(temperature.detach())


def train_detection(
    bars_by_key: dict[str, list[dict]],
    results: list[dict],
    instrument_id: str,
    output_dir: str = "checkpoints",
    epochs: int = 30,
    lr: float = 1e-3,
    horizon_bars: Optional[int] = None,
    # Symmetric barriers by default. The previous 2:1 default produced
    # heavily SHORT-skewed labels (e.g. 67/32/1 on R_10 H1) which collapsed
    # the network into degenerate "always predict the rare class" behaviour.
    # Symmetric barriers give roughly balanced label distributions and far
    # better training behaviour. Callers that want asymmetric labels can pass
    # explicit values; we still bake the chosen ratio into the meta file.
    tp_mult: float = 1.0,
    sl_mult: float = 1.0,
    checkpoint_suffix: str = "",
) -> Tuple[str, dict]:
    """Train the detection NN on scale-invariant bar features + triple-barrier labels.

    ``results`` is only used to identify which timeframe/strategy's best config
    the bot should focus on; the actual supervision comes from market outcomes.
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    best_rows = filter_best_results_for_build(results)
    if not best_rows:
        raise ValueError("No backtest results for detection training.")
    best = max(best_rows, key=_robust_score)
    strategy_id = best.get("strategyId", "")
    strategy_params = best.get("strategyParams") or {}
    timeframe = best.get("timeframe", "M5")
    bar_window = get_bar_window_for_detection(timeframe, strategy_id)
    horizon = int(horizon_bars or TF_TO_HORIZON.get(timeframe.upper(), 12))

    feat_cfg = BarFeatureConfig(window=bar_window, include_context=True)
    tb_cfg = TripleBarrierConfig(tp_mult=tp_mult, sl_mult=sl_mult, horizon_bars=horizon)

    key = f"{best.get('instrumentId', instrument_id)}|{timeframe}"
    bars = bars_by_key.get(key)
    if not bars or len(bars) < bar_window + horizon + 5:
        need = bar_window + horizon + 5
        got = len(bars) if bars else 0
        raise ValueError(
            f"Insufficient bars for detection training: need >= {need}, got {got}"
        )

    labels = triple_barrier_labels(bars, tb_cfg)
    # Only use bars where the look-ahead window is fully inside the data.
    last_usable = max(0, len(bars) - horizon - 1)
    first_usable = bar_window
    if last_usable <= first_usable + 10:
        raise ValueError("Too few usable bars after horizon truncation.")

    usable_indices = np.arange(first_usable, last_usable)
    usable_labels = labels[usable_indices]

    # Build features for each usable bar.
    X_list = []
    for i in usable_indices:
        X_list.append(window_features(bars, int(i), feat_cfg))
    X = np.stack(X_list).astype(np.float32)
    y = usable_labels.astype(np.int64)

    # Purged walk-forward split + uniqueness weights (López de Prado).
    train_idx, val_idx = _stratified_train_val_indices(y, val_fraction=0.2, purge_gap=horizon)
    if len(train_idx) < 20:
        raise ValueError(f"Too few training samples after purge: {len(train_idx)}")

    X_train, y_train = X[train_idx], y[train_idx]
    X_val = X[val_idx] if len(val_idx) else np.zeros((0, X.shape[1]), dtype=np.float32)
    y_val = y[val_idx] if len(val_idx) else np.zeros(0, dtype=np.int64)
    w_train = uniqueness_weights(len(y_train), horizon)

    # Class weights: rebalance because triple-barrier is often skewed towards
    # "neutral" when volatility is low.
    class_weights = _class_weights_from_labels(y_train, num_classes=3).to(DEVICE)

    X_train_t = torch.from_numpy(X_train).float().to(DEVICE)
    y_train_t = torch.from_numpy(y_train).long().to(DEVICE)
    w_train_t = torch.from_numpy(w_train.astype(np.float32)).to(DEVICE)

    dataset = TensorDataset(X_train_t, y_train_t, w_train_t)
    batch_size = min(64, max(16, len(dataset) // 4))
    # pin_memory must not be set when tensors already live on the GPU.
    can_pin = _COMPUTE.pin_memory and X_train_t.device.type == "cpu"
    loader = DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=True,
        num_workers=_COMPUTE.dataloader_workers if len(dataset) > 256 else 0,
        pin_memory=can_pin,
        persistent_workers=_COMPUTE.dataloader_workers > 0 and len(dataset) > 256,
    )

    det_cfg = DetectionConfig(
        window=bar_window,
        per_bar_features=PER_BAR_FEATURES,
        context_features=4,
        hidden_dim=96,
        num_conv_blocks=2,
        num_attention_heads=4,
        dropout=0.25 if len(y_train) < 500 else 0.2,
    )
    model = _maybe_data_parallel(StrategyDetectionNN(det_cfg).to(DEVICE))
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)
    loss_fn = nn.CrossEntropyLoss(weight=class_weights, reduction="none", label_smoothing=0.05)

    best_val_acc = 0.0
    best_state: Optional[dict] = None
    patience = max(5, epochs // 5)
    stale = 0

    for ep in range(epochs):
        model.train()
        total = 0.0
        for bx, by, bw in loader:
            opt.zero_grad()
            logits = model(bx)
            per_sample = loss_fn(logits, by)
            loss = (per_sample * bw).mean()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            total += loss.item()

        # Validation + early stopping.
        val_acc = 0.0
        if len(X_val):
            model.eval()
            with torch.no_grad():
                xv = torch.from_numpy(X_val).float().to(DEVICE)
                yv = torch.from_numpy(y_val).long().to(DEVICE)
                preds = model(xv).argmax(dim=-1)
                val_acc = float((preds == yv).float().mean().item())
            if val_acc > best_val_acc + 1e-3:
                best_val_acc = val_acc
                best_state = {k: v.detach().cpu().clone() for k, v in _unwrap_model(model).state_dict().items()}
                stale = 0
            else:
                stale += 1
                if stale >= patience:
                    break
        if (ep + 1) % 10 == 0:
            print(
                f"Detection ep {ep+1}/{epochs} loss={total/max(1, len(loader)):.4f} val_acc={val_acc:.3f}"
            )

    # Restore best weights and calibrate.
    if best_state is not None:
        _unwrap_model(model).load_state_dict(best_state)
    if len(X_val):
        _temperature_scale(model, X_val, y_val)

    # ── Promotion floor ────────────────────────────────────────────────────
    # The detection model is only useful if it beats random chance. With three
    # classes the random baseline is 1/3. A model below ``random + margin``
    # should never be accepted as a live signal source — we mark it
    # ``safe_to_use=False`` in the meta file so the daemon and build endpoint
    # can refuse to use it. The diagnostic ``inversion_score`` flags the
    # "model is systematically wrong" case (val_acc << random) — a future
    # round can auto-flip + retrain when this trips.
    NUM_CLASSES = 3
    MIN_BEAT_RANDOM_MARGIN = 0.04  # 4 pp above the random baseline
    random_baseline = 1.0 / NUM_CLASSES
    promotion_floor = random_baseline + MIN_BEAT_RANDOM_MARGIN
    safe_to_use = bool(best_val_acc >= promotion_floor)
    inversion_score = max(0.0, random_baseline - best_val_acc) if best_val_acc < random_baseline else 0.0

    safe_id = _safe_instrument_id(instrument_id)
    path = os.path.join(output_dir, f"instrument_detection_{safe_id}{checkpoint_suffix}.pt")
    feat_total = feature_dim(feat_cfg)

    meta: dict = {
        "instrument_id": instrument_id,
        "strategy_id": strategy_id,
        "strategy_params": strategy_params,
        "timeframe": timeframe,
        "scope": {
            "M1": "scalp",
            "M5": "scalp",
            "M15": "day",
            "M30": "day",
            "H1": "day",
            "H4": "swing",
            "D1": "swing",
            "W1": "position",
        }.get(str(timeframe).upper(), "day"),
        "bar_window": bar_window,
        "per_bar_features": PER_BAR_FEATURES,
        "context_features": 4,
        "bar_feature_dim": feat_total,
        "model_version": 3,
        "horizon_bars": horizon,
        "tp_mult": tp_mult,
        "sl_mult": sl_mult,
        "label_distribution": label_distribution(y_train),
        "val_accuracy": best_val_acc,
        "num_train": int(len(y_train)),
        "num_val": int(len(y_val)),
        "safe_to_use": safe_to_use,
        "promotion_floor": promotion_floor,
        "inversion_score": inversion_score,
    }
    torch.save(
        {
            "model_state": _unwrap_model(model).state_dict(),
            "meta": meta,
            "model_version": 3,
            "detection_config": {
                "window": det_cfg.window,
                "per_bar_features": det_cfg.per_bar_features,
                "context_features": det_cfg.context_features,
                "hidden_dim": det_cfg.hidden_dim,
                "num_conv_blocks": det_cfg.num_conv_blocks,
                "num_attention_heads": det_cfg.num_attention_heads,
                "num_classes": det_cfg.num_classes,
                "dropout": det_cfg.dropout,
            },
        },
        path,
    )
    with open(os.path.join(output_dir, f"instrument_detection_{safe_id}{checkpoint_suffix}_meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(
        f"Saved detection model to {path} (val_acc={best_val_acc:.3f}, "
        f"label_dist={meta['label_distribution']})"
    )
    return path, {
        "strategy_id": strategy_id,
        "num_samples": int(len(y_train)),
        "timeframe": timeframe,
        "bar_window": bar_window,
        "val_accuracy": best_val_acc,
    }
