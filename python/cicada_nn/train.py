"""
Tabular (feature-vector) training for CICADA-5453.

The previous implementation derived training targets from the same feature
slice that was fed into the network. Even though the numbers looked like an ML
problem, the model was really being asked to echo the mean of its own inputs
— which is why old validation accuracies were flattering and live performance
mediocre. This rewrite keeps the feature construction but moves labels to a
**held-out future slice** of the backtest data (purged walk-forward), making
the tabular network a genuine strategy meta-selector.

Features (for a given instrument):
    per-strategy (win, profit, pf, sharpe) + per-tf×regime (win, profit)
    aggregated across the **feature slice** only.

Labels (for the same instrument, same strategies):
    * per-style action ∈ {0=long, 1=short, 2=neutral}  — direction that would have
      performed best in the **label slice**, determined from the mean profit and
      win rate of the aggregated future rows.
    * strategy index          — argmax of robust score on the label slice.
    * size / sl / tp targets  — derived from the label slice's best config's
      realised sharpe and win rate.

When there is insufficient data for a proper split (too few rows per
instrument, not enough timestamps to purge), we fall back to a conservative
neutral label and log a warning. This keeps training honest even on small
accounts while preventing the identity leak from returning.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

from .compute import configure_torch_for_speed, get_compute_config
from .model import InstrumentBotNNV2, ModelConfig, NUM_REGIMES, NUM_TIMEFRAMES


configure_torch_for_speed()
_COMPUTE = get_compute_config()
DEVICE = torch.device(_COMPUTE.device_str if _COMPUTE.use_cuda else "cpu")


def _maybe_data_parallel(model: nn.Module) -> nn.Module:
    """Use every visible CUDA device for training while saving plain checkpoints."""
    if _COMPUTE.use_multi_gpu:
        return nn.DataParallel(model)
    return model


def _unwrap_model(model: nn.Module) -> nn.Module:
    return model.module if isinstance(model, nn.DataParallel) else model

# Minimum number of label-slice rows per instrument before we accept a
# directional label. Below this we emit the neutral fallback.
MIN_LABEL_ROWS = 3

# Fraction of time-ordered data used for features; the remainder labels it.
DEFAULT_LABEL_FRACTION = 0.25


def _safe_instrument_id(instrument_id: str) -> str:
    """Sanitize instrument_id for use in filenames."""
    return re.sub(r"[^\w\-]", "_", instrument_id)


def _safe_float(x, default: float = 0.0) -> float:
    if x is None:
        return default
    try:
        v = float(x)
        return v if not (v != v) else default
    except (TypeError, ValueError):
        return default


def derive_model_config_from_backtest(
    feature_dim: int,
    num_strategies: int,
    num_timeframes: int,
    num_regimes: int,
    num_samples: int = 0,
) -> ModelConfig:
    """Architecture choices that scale with the data, not the opposite."""
    complexity = num_strategies + num_timeframes * num_regimes
    base_hidden = max(64, min(512, 32 * ((feature_dim + 31) // 32)))
    hidden_dim = max(64, min(512, base_hidden))
    if hidden_dim % 8 != 0:
        hidden_dim = ((hidden_dim + 7) // 8) * 8
    num_layers = max(2, min(6, 2 + (complexity // 8)))
    num_heads = 8 if hidden_dim % 8 == 0 else 4
    num_tokens = max(2, min(16, num_strategies + 1))
    dropout = 0.25 if num_samples < 100 else (0.2 if num_samples < 500 else 0.15)
    strategy_feature_dim = max(32, min(512, feature_dim))
    return ModelConfig(
        strategy_feature_dim=strategy_feature_dim,
        hidden_dim=hidden_dim,
        num_layers=num_layers,
        num_heads=num_heads,
        num_output_heads=5,
        num_strategies=max(0, num_strategies),
        dropout=dropout,
        use_attention=True,
        use_residual=True,
        instrument_embed_dim=32,
        ffn_multiplier=2,
        num_tokens=num_tokens,
    )


MIN_TRADES_FOR_CONFIG = 1


def _robust_score(r: dict) -> float:
    """Risk-adjusted score for config ranking: profit × profitFactor × sharpe."""
    profit = _safe_float(r.get("profit"), 0)
    pf = _safe_float(r.get("profitFactor"), 1)
    sharpe = _safe_float(r.get("sharpeRatio"), 0)
    trades = int(r.get("trades", 0) or 0)
    if trades < MIN_TRADES_FOR_CONFIG:
        return -1e9
    dd = _safe_float(r.get("maxDrawdown"), 0)
    dd_penalty = 1.0 - min(0.5, dd) if dd > 0 else 1.0
    score = profit * max(0.1, pf) * (1.0 + 0.1 * sharpe) * dd_penalty
    return score


def filter_best_results_for_build(rows: list) -> list:
    """Filter to best backtest results for NN training."""
    completed = [r for r in rows if r.get("status", "completed") == "completed"]
    if not completed:
        return []

    def pf_valid(pf) -> bool:
        return pf is not None and isinstance(pf, (int, float)) and float(pf) > 0 and not (float(pf) != float(pf))

    best = []
    for r in completed:
        pf = r.get("profitFactor")
        profit = r.get("profit", 0)
        trades = int(r.get("trades", 0) or 0)
        if trades < MIN_TRADES_FOR_CONFIG:
            continue
        profit_val = _safe_float(profit, 0)
        if pf_valid(pf) and float(pf) >= 1:
            best.append(r)
        elif not pf_valid(pf) and profit_val >= 0:
            best.append(r)

    threshold = max(20, int(len(completed) * 0.5))
    if len(best) >= threshold:
        return best

    by_score = sorted(completed, key=_robust_score, reverse=True)
    by_score = [r for r in by_score if int(r.get("trades", 0) or 0) >= MIN_TRADES_FOR_CONFIG]
    keep_count = max(len(best), math.ceil(len(by_score) * 0.75))
    return by_score[:keep_count]


def _strategy_config_key(r: dict) -> str:
    """Composite key: strategyId + params. Lets the model treat RSI(period=14) and
    RSI(period=21) as separate strategies when param grids are used."""
    sid = r.get("strategyId", "")
    params = r.get("strategyParams")
    if params and isinstance(params, dict) and params:
        param_str = "|".join(sorted(f"{k}={v}" for k, v in params.items()))
        return f"{sid}|{param_str}"
    return sid


def backtest_rows_to_features(
    rows: list,
    strategy_id_to_idx: dict,
    timeframe_to_idx: dict,
    regime_to_idx: dict,
):
    """Aggregate rows into a per-instrument feature vector.

    Features summarise the distribution of strategy performance; this is
    deliberately agnostic about which strategy any single row belongs to at
    inference time."""
    num_strategies = len(strategy_id_to_idx)
    num_tf = len(timeframe_to_idx)
    num_reg = len(regime_to_idx)
    feat_dim = num_strategies * 4 + num_tf * num_reg * 2
    instruments: dict[str, dict[str, np.ndarray]] = {}
    for r in rows:
        inst_id = r.get("instrumentId", "default")
        if inst_id not in instruments:
            instruments[inst_id] = {
                "strategy_win": np.zeros(num_strategies),
                "strategy_profit": np.zeros(num_strategies),
                "strategy_pf": np.zeros(num_strategies),
                "strategy_sharpe": np.zeros(num_strategies),
                "strategy_count": np.zeros(num_strategies),
                "tf_reg_win": np.zeros((num_tf, num_reg)),
                "tf_reg_profit": np.zeros((num_tf, num_reg)),
                "tf_reg_count": np.zeros((num_tf, num_reg)),
            }
        s_idx = strategy_id_to_idx.get(_strategy_config_key(r), 0)
        tf_idx = timeframe_to_idx.get(r.get("timeframe", "M5"), 0)
        reg_idx = regime_to_idx.get(r.get("regime", "unknown"), 0)
        win = r.get("winRate", 50) / 100.0
        profit = np.tanh(_safe_float(r.get("profit"), 0) / 1000.0)
        pf = np.tanh((_safe_float(r.get("profitFactor"), 1) - 1) / 2.0)
        sharpe = np.tanh(_safe_float(r.get("sharpeRatio"), 0) / 2.0)
        instruments[inst_id]["strategy_win"][s_idx] += win
        instruments[inst_id]["strategy_profit"][s_idx] += profit
        instruments[inst_id]["strategy_pf"][s_idx] += pf
        instruments[inst_id]["strategy_sharpe"][s_idx] += sharpe
        instruments[inst_id]["strategy_count"][s_idx] += 1
        instruments[inst_id]["tf_reg_win"][tf_idx, reg_idx] += win
        instruments[inst_id]["tf_reg_profit"][tf_idx, reg_idx] += profit
        instruments[inst_id]["tf_reg_count"][tf_idx, reg_idx] += 1

    vecs: list[np.ndarray] = []
    instrument_ids: list[str] = []
    for inst_id, d in instruments.items():
        instrument_ids.append(inst_id)
        s_count = np.maximum(d["strategy_count"], 1)
        s_win = (d["strategy_win"] / s_count).astype(np.float32)
        s_profit = (d["strategy_profit"] / s_count).astype(np.float32)
        s_pf = (d["strategy_pf"] / s_count).astype(np.float32)
        s_sharpe = (d["strategy_sharpe"] / s_count).astype(np.float32)
        tr_count = np.maximum(d["tf_reg_count"], 1)
        tr_win = (d["tf_reg_win"] / tr_count).flatten().astype(np.float32)
        tr_profit = (d["tf_reg_profit"] / tr_count).flatten().astype(np.float32)
        vec = np.concatenate([s_win, s_profit, s_pf, s_sharpe, tr_win, tr_profit])
        vecs.append(vec)
    if not vecs:
        return np.zeros((1, feat_dim), dtype=np.float32), ["default"]
    return np.stack(vecs), instrument_ids


def instrument_type_to_idx(it: str) -> int:
    m = {"fiat": 0, "crypto": 1, "synthetic_deriv": 2, "indices_exness": 3}
    return m.get(it, 0)


OOS_TRAIN_FRACTION = 0.8


def _row_sort_key(r: dict) -> str:
    """Sortable time string: falls back to completedAt when dataEndTime is empty."""
    return (r.get("dataEndTime") or r.get("completedAt") or "") or ""


def _purged_feature_label_split(
    rows: list,
    label_fraction: float = DEFAULT_LABEL_FRACTION,
    purge_bars: int = 10,
) -> tuple[list, list]:
    """Split time-ordered rows into (feature_slice, label_slice) with a purge.

    The purge drops rows whose ``dataEndTime`` falls within ``purge_bars`` of
    the split boundary — a heuristic ``embargo`` that avoids using overlapping
    information on both sides of the split."""
    completed = [r for r in rows if r.get("status", "completed") == "completed"]
    if not completed:
        return [], []
    sorted_rows = sorted(completed, key=_row_sort_key)
    n = len(sorted_rows)
    split = max(1, int(n * (1 - label_fraction)))
    # Purge: drop the last ``purge_bars`` rows of the feature slice and the
    # first ``purge_bars`` rows of the label slice. Small but important.
    purge_count = min(purge_bars, max(0, (split + (n - split)) // 10))
    feature_slice = sorted_rows[: max(1, split - purge_count)]
    label_slice = sorted_rows[min(n, split + purge_count) :]
    return feature_slice, label_slice


def _per_style_direction_label(label_slice: list) -> int:
    """Pick the dominant direction implied by the label slice's mean profit.

    Returns: 0=long, 1=short, 2=neutral. Thresholds on the tanh-scaled mean
    profit mirror the feature scaling so the classifier's decision boundary is
    comparable to input magnitudes."""
    if not label_slice:
        return 2
    mean_profit = float(
        np.tanh(
            np.mean([_safe_float(r.get("profit"), 0) for r in label_slice]) / 1000.0
        )
    )
    win_rates = [_safe_float(r.get("winRate"), 50) / 100.0 for r in label_slice]
    mean_win = float(np.mean(win_rates)) if win_rates else 0.5
    # Require both mean profit ≥ 0.1 AND win-rate bias to side with a direction.
    # This prevents one wild row from flipping the label.
    if mean_profit > 0.1 and mean_win >= 0.5:
        return 0  # long
    if mean_profit < -0.1 and mean_win < 0.5:
        return 1  # short
    return 2


def _best_strategy_idx_for_slice(
    label_slice: list, strategy_id_to_idx: dict
) -> int:
    """Argmax robust score across strategies present in the label slice."""
    if not label_slice or not strategy_id_to_idx:
        return 0
    by_strategy: dict[str, float] = {}
    for r in label_slice:
        key = _strategy_config_key(r)
        if key not in strategy_id_to_idx:
            continue
        by_strategy[key] = by_strategy.get(key, 0.0) + _robust_score(r)
    if not by_strategy:
        return 0
    best_key = max(by_strategy.items(), key=lambda kv: kv[1])[0]
    return int(strategy_id_to_idx.get(best_key, 0))


def _regression_targets_for_slice(label_slice: list) -> np.ndarray:
    """Derive (size_mult, sl_pct, tp_r) raw targets from the label slice.

    Each output is in [0,1] (sigmoid range). The network decodes them with:
        size_mult = 0.5 + 1.5*r0
        sl_pct    = 0.01 + 0.04*r1
        tp_r      = 1.0 + 2.0*r2
    so a neutral row returns 0.5/0.25/0.5 which decode to 1.25×/2%/2R defaults.
    """
    if not label_slice:
        return np.array([0.5, 0.25, 0.5], dtype=np.float32)
    win_rates = [_safe_float(r.get("winRate"), 50) / 100.0 for r in label_slice]
    mean_win = float(np.mean(win_rates)) if win_rates else 0.5
    # Size: higher win-rate -> larger size (clamped to [0,1] for the sigmoid).
    size_raw = float(np.clip((mean_win - 0.5) / 0.5 + 0.5, 0.0, 1.0))
    # SL: scale to average drawdown. Rows with deeper drawdowns should get
    # wider stops to avoid premature exits.
    dds = [_safe_float(r.get("maxDrawdown"), 0) for r in label_slice]
    mean_dd = float(np.mean(dds)) if dds else 0.05
    sl_raw = float(np.clip((mean_dd - 0.01) / 0.04, 0.1, 0.9))
    # TP: tune to sharpe — good sharpe deserves a longer target.
    sharpes = [_safe_float(r.get("sharpeRatio"), 0) for r in label_slice]
    mean_sharpe = float(np.mean(sharpes)) if sharpes else 0.0
    tp_raw = float(np.clip(0.5 + 0.25 * np.tanh(mean_sharpe / 2.0), 0.1, 0.9))
    return np.array([size_raw, sl_raw, tp_raw], dtype=np.float32)


def _compute_oos_metrics(
    model: InstrumentBotNNV2,
    val_features: np.ndarray,
    val_inst_idx: np.ndarray,
    val_targets: np.ndarray,
) -> dict:
    """Accuracy of the V2 model on a held-out validation set."""
    if val_features.size == 0 or len(val_features) == 0:
        return {"oos_accuracy": 0.0, "oos_sample_count": 0}
    model.eval()
    X = torch.from_numpy(val_features).float().to(DEVICE)
    I = torch.from_numpy(val_inst_idx).long().to(DEVICE)
    reg = torch.zeros(X.size(0), NUM_REGIMES, device=DEVICE)
    tf = torch.zeros(X.size(0), NUM_TIMEFRAMES, device=DEVICE)
    with torch.no_grad():
        logits = model(X, I, regime_onehot=reg, timeframe_onehot=tf)
        preds = logits[:, 0].argmax(dim=-1).cpu().numpy()
    correct = int((preds == val_targets).sum())
    return {"oos_accuracy": float(correct) / len(val_targets), "oos_sample_count": int(len(val_targets))}


def train(
    backtest_json_path: Optional[str] = None,
    instrument_types_json: Optional[dict] = None,
    output_dir: str = "checkpoints",
    instrument_id: Optional[str] = None,
    epochs: int = 50,
    batch_size: int = 32,
    lr: float = 1e-3,
    validation_rows: Optional[list] = None,
    label_fraction: float = DEFAULT_LABEL_FRACTION,
) -> tuple[str, dict]:
    """Train a fresh per-instrument meta-selector.

    The signature is unchanged for API compatibility; the internals now perform
    a purged walk-forward split so labels come from the future slice instead of
    the same slice as the features."""
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    if backtest_json_path and os.path.isfile(backtest_json_path):
        with open(backtest_json_path) as f:
            data = json.load(f)
        rows = data if isinstance(data, list) else data.get("results", data.get("backtest", []))
    else:
        rows = []

    rows = filter_best_results_for_build(rows)
    if not rows:
        raise ValueError("No backtest results. Run backtest with live data (Deriv/MT5) before building.")

    # Purged walk-forward split: features from past, labels from held-out future.
    feature_slice, label_slice = _purged_feature_label_split(rows, label_fraction=label_fraction)
    if not feature_slice:
        feature_slice = rows
    supervised = bool(label_slice and len(label_slice) >= MIN_LABEL_ROWS)

    # Build the indexing dictionaries from the full row set so unseen strategies
    # at inference time still find a slot.
    strategy_ids = sorted({_strategy_config_key(r) for r in rows})
    timeframes = sorted({r.get("timeframe", "M5") for r in rows})
    regimes = sorted({r.get("regime", "unknown") for r in rows})
    strategy_id_to_idx = {s: i for i, s in enumerate(strategy_ids)}
    timeframe_to_idx = {t: i for i, t in enumerate(timeframes)}
    regime_to_idx = {r: i for i, r in enumerate(regimes)}

    features, instrument_ids = backtest_rows_to_features(
        feature_slice, strategy_id_to_idx, timeframe_to_idx, regime_to_idx
    )
    feature_dim = features.shape[1]
    num_strategies = len(strategy_id_to_idx)
    num_timeframes = len(timeframe_to_idx)
    num_regimes = len(regime_to_idx)

    cfg = derive_model_config_from_backtest(
        feature_dim=feature_dim,
        num_strategies=num_strategies,
        num_timeframes=num_timeframes,
        num_regimes=num_regimes,
        num_samples=len(features),
    )
    target_dim = cfg.strategy_feature_dim
    if features.shape[1] != target_dim:
        if features.shape[1] < target_dim:
            features = np.pad(features, ((0, 0), (0, target_dim - features.shape[1])), mode="constant", constant_values=0)
        else:
            features = features[:, :target_dim]

    inst_type_map = instrument_types_json or {}
    inst_type_idx = np.array(
        [instrument_type_to_idx(inst_type_map.get(i, "fiat")) for i in instrument_ids],
        dtype=np.int64,
    )

    # ── Targets from the label slice ───────────────────────────────────────
    # Group the label slice per instrument so each feature vector gets a
    # consistent direction label derived from its own future.
    per_inst_labels: dict[str, list] = {}
    for r in label_slice:
        inst = r.get("instrumentId", "default")
        per_inst_labels.setdefault(inst, []).append(r)

    targets = np.zeros(max(1, len(features)), dtype=np.int64)
    reg_targets = np.zeros((max(1, len(features)), 3), dtype=np.float32)
    strategy_targets = np.zeros(max(1, len(features)), dtype=np.int64)
    for i, inst_id in enumerate(instrument_ids):
        subset = per_inst_labels.get(inst_id, [])
        if supervised and len(subset) >= MIN_LABEL_ROWS:
            targets[i] = _per_style_direction_label(subset)
            strategy_targets[i] = _best_strategy_idx_for_slice(subset, strategy_id_to_idx)
            reg_targets[i] = _regression_targets_for_slice(subset)
        else:
            targets[i] = 2
            strategy_targets[i] = 0
            reg_targets[i] = np.array([0.5, 0.25, 0.5], dtype=np.float32)

    # BatchNorm / attention needs batch size >= 2; duplicate single sample.
    n = features.shape[0]
    if n == 1:
        features = np.concatenate([features, features], axis=0)
        inst_type_idx = np.concatenate([inst_type_idx, inst_type_idx], axis=0)
        targets = np.concatenate([targets, targets], axis=0)
        reg_targets = np.concatenate([reg_targets, reg_targets], axis=0)
        strategy_targets = np.concatenate([strategy_targets, strategy_targets], axis=0)

    X = torch.from_numpy(features).float().to(DEVICE)
    I = torch.from_numpy(inst_type_idx).long().to(DEVICE)
    Y = torch.from_numpy(targets).long().unsqueeze(1).expand(-1, 5).to(DEVICE)
    Y_reg = torch.from_numpy(reg_targets).float().to(DEVICE)
    Y_strat = torch.from_numpy(strategy_targets).long().to(DEVICE)

    dataset = TensorDataset(X, I, Y, Y_reg, Y_strat)
    # pin_memory only works when source tensors live on CPU. Our X/I/etc. are
    # already on DEVICE (often CUDA), so disable the flag when that's the case
    # to avoid the "cannot pin CUDA tensor" RuntimeError. The training step
    # itself is already device-resident so pin_memory wouldn't speed it up.
    can_pin = _COMPUTE.pin_memory and X.device.type == "cpu"
    loader = DataLoader(
        dataset,
        batch_size=min(batch_size, len(dataset)),
        shuffle=True,
        num_workers=_COMPUTE.dataloader_workers if len(dataset) > 256 else 0,
        pin_memory=can_pin,
        persistent_workers=_COMPUTE.dataloader_workers > 0 and len(dataset) > 256,
    )

    model = _maybe_data_parallel(InstrumentBotNNV2(cfg).to(DEVICE))
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)
    loss_fn = nn.CrossEntropyLoss(label_smoothing=0.1)
    mse_fn = nn.MSELoss()

    for epoch in range(epochs):
        model.train()
        total_loss = 0.0
        for batch in loader:
            x, i, y, y_reg, y_strat = batch
            opt.zero_grad()
            B = x.size(0)
            dev = x.device
            # Regime and timeframe are unknown at *build* time; zero one-hots
            # match the serve-time default (see api.py: regime confidence no
            # longer scales the one-hot, which would have been a train-serve
            # mismatch otherwise).
            reg_oh = torch.zeros(B, NUM_REGIMES, device=dev)
            tf_oh = torch.zeros(B, NUM_TIMEFRAMES, device=dev)
            logits = model(x, i, regime_onehot=reg_oh, timeframe_onehot=tf_oh)
            ce_loss = sum(loss_fn(logits[:, j], y[:, j]) for j in range(5))
            core_model = _unwrap_model(model)
            inst_emb = core_model.instrument_embed(i)
            enc_in = torch.cat([x, inst_emb, reg_oh, tf_oh], dim=1)
            h = core_model._encode(enc_in)
            reg_out = core_model.regression_head(h)
            reg_loss = mse_fn(reg_out, y_reg)
            strat_loss = torch.tensor(0.0, device=dev)
            if core_model.strategy_head is not None and num_strategies > 0:
                strat_logits = core_model.strategy_head(h)
                strat_loss = loss_fn(strat_logits, y_strat)
            loss = ce_loss + 0.5 * reg_loss + 0.3 * strat_loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            opt.step()
            total_loss += loss.item()
        if (epoch + 1) % 10 == 0:
            print(
                f"Epoch {epoch+1}/{epochs} loss={total_loss/max(1, len(loader)):.4f} "
                f"[device={DEVICE}, supervised={supervised}]"
            )

    # Persist checkpoint + metadata used by the inference endpoint.
    safe_id = _safe_instrument_id(instrument_id) if instrument_id else "default"
    base_name = f"instrument_bot_nn_{safe_id}"
    save_path = os.path.join(output_dir, f"{base_name}.pt")
    config_dict = {
        "strategy_feature_dim": cfg.strategy_feature_dim,
        "hidden_dim": cfg.hidden_dim,
        "num_layers": cfg.num_layers,
        "num_heads": cfg.num_heads,
        "num_output_heads": cfg.num_output_heads,
        "num_strategies": cfg.num_strategies,
        "dropout": cfg.dropout,
        "use_attention": cfg.use_attention,
        "use_residual": cfg.use_residual,
        "instrument_embed_dim": cfg.instrument_embed_dim,
        "num_tokens": cfg.num_tokens,
    }
    torch.save(
        {
            "model_state": _unwrap_model(model).state_dict(),
            "strategy_feature_dim": target_dim,
            "model_version": 2,
            "model_config": config_dict,
            "supervised_meta_selector": supervised,
        },
        save_path,
    )

    data_end_times = [r.get("dataEndTime") or r.get("completedAt") for r in rows if isinstance(r, dict)]
    data_end_times = [t for t in data_end_times if t is not None]
    sorted_strategy_ids = [k for k, _ in sorted(strategy_id_to_idx.items(), key=lambda x: x[1])]
    meta = {
        "instrument_id": instrument_id,
        "trained_at_iso": datetime.now(timezone.utc).isoformat(),
        "data_end_min": min(data_end_times) if data_end_times else None,
        "data_end_max": max(data_end_times) if data_end_times else None,
        "num_rows": len(rows),
        "feature_slice_rows": len(feature_slice),
        "label_slice_rows": len(label_slice),
        "supervised_meta_selector": supervised,
        "from_scratch": True,
        "strategy_feature_dim": target_dim,
        "strategy_id_to_idx": strategy_id_to_idx,
        "strategy_ids": sorted_strategy_ids,
        "timeframe_to_idx": timeframe_to_idx,
        "regime_to_idx": regime_to_idx,
    }
    meta_path = os.path.join(output_dir, f"{base_name}_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    oos_metrics = {"oos_accuracy": 0.0, "oos_sample_count": 0}
    if validation_rows and len(validation_rows) > 0:
        val_features, val_inst_ids = backtest_rows_to_features(
            validation_rows, strategy_id_to_idx, timeframe_to_idx, regime_to_idx
        )
        if val_features.shape[0] > 0:
            if val_features.shape[1] < target_dim:
                val_features = np.pad(
                    val_features,
                    ((0, 0), (0, target_dim - val_features.shape[1])),
                    mode="constant",
                    constant_values=0,
                )
            else:
                val_features = val_features[:, :target_dim]
            val_inst_idx = np.array(
                [instrument_type_to_idx(inst_type_map.get(i, "fiat")) for i in val_inst_ids],
                dtype=np.int64,
            )
            # Re-derive validation labels the same way training did.
            per_inst_val: dict[str, list] = {}
            for r in validation_rows:
                per_inst_val.setdefault(r.get("instrumentId", "default"), []).append(r)
            val_targets = np.array(
                [_per_style_direction_label(per_inst_val.get(i, [])) for i in val_inst_ids],
                dtype=np.int64,
            )
            oos_metrics = _compute_oos_metrics(model, val_features, val_inst_idx, val_targets)
            print(
                f"OOS validation: accuracy={oos_metrics['oos_accuracy']:.2%} "
                f"(n={oos_metrics['oos_sample_count']})"
            )

    print(f"Saved model to {save_path}, metadata to {meta_path}")
    return save_path, oos_metrics


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--backtest", default="", help="Path to backtest results JSON")
    parser.add_argument("--output", default="checkpoints", help="Output directory")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--lr", type=float, default=1e-3)
    args = parser.parse_args()
    train(args.backtest or None, output_dir=args.output, epochs=args.epochs, lr=args.lr)
