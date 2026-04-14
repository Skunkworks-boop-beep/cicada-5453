"""
Training script for CICADA-5453 instrument bot NN.
Reads backtest-style data (strategy × timeframe × regime → win rate, profit, etc.),
builds feature vectors, and trains the model to predict profitable actions.
"""

import argparse
import json
import math
import os
import re
from pathlib import Path
from typing import Optional


def _safe_instrument_id(instrument_id: str) -> str:
    """Sanitize instrument_id for use in filenames."""
    return re.sub(r"[^\w\-]", "_", instrument_id)

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

from .model import InstrumentBotNNV2, ModelConfig, NUM_REGIMES, NUM_TIMEFRAMES

# Use CUDA when available (e.g. RTX 2070); falls back to CPU
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


def derive_model_config_from_backtest(
    feature_dim: int,
    num_strategies: int,
    num_timeframes: int,
    num_regimes: int,
    num_samples: int = 0,
) -> ModelConfig:
    """
    Derive ModelConfig from backtest metadata so the architecture matches the data.
    Replaces hardcoded defaults with data-driven choices.
    """
    # Hidden dim: scale with feature complexity; must be divisible by num_heads (4 or 8)
    complexity = num_strategies + num_timeframes * num_regimes
    base_hidden = max(64, min(512, 32 * ((feature_dim + 31) // 32)))
    hidden_dim = max(64, min(512, base_hidden))
    if hidden_dim % 8 != 0:
        hidden_dim = ((hidden_dim + 7) // 8) * 8

    # Layers: more strategies/regimes/timeframes -> deeper model
    num_layers = max(2, min(6, 2 + (complexity // 8)))

    # Heads: hidden_dim must be divisible; 4 or 8 typical
    num_heads = 8 if hidden_dim % 8 == 0 else 4

    # Tokens for attention: relate to strategy/regime structure; must divide evenly into projected dim
    num_tokens = max(2, min(16, num_strategies + 1))

    # Dropout: higher for small datasets to reduce overfitting
    dropout = 0.25 if num_samples < 100 else (0.2 if num_samples < 500 else 0.15)

    # Strategy feature dim: use actual backtest dimension; clamp for sanity
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


MIN_TRADES_FOR_CONFIG = 1  # Configs with fewer trades are unreliable

def _safe_float(x, default: float = 0.0) -> float:
    if x is None:
        return default
    try:
        v = float(x)
        return v if not (v != v) else default  # NaN check
    except (TypeError, ValueError):
        return default


def _robust_score(r: dict) -> float:
    """Risk-adjusted score for config ranking: profit * profitFactor * Sharpe when available."""
    profit = _safe_float(r.get("profit"), 0)
    pf = _safe_float(r.get("profitFactor"), 1)
    sharpe = _safe_float(r.get("sharpeRatio"), 0)
    trades = int(r.get("trades", 0) or 0)
    if trades < MIN_TRADES_FOR_CONFIG:
        return -1e9  # Exclude low-trade configs
    # Prefer profitFactor >= 1; penalize drawdown
    dd = _safe_float(r.get("maxDrawdown"), 0)
    dd_penalty = 1.0 - min(0.5, dd) if dd > 0 else 1.0
    score = profit * max(0.1, pf) * (1.0 + 0.1 * sharpe) * dd_penalty
    return score


def filter_best_results_for_build(rows: list) -> list:
    """
    Filter to best backtest results for NN training: profitable or good risk-adjusted configs.
    - Requires minimum trades (MIN_TRADES_FOR_CONFIG) for reliability.
    - Ranks by robust score (profit * profitFactor * Sharpe) when available.
    - Keeps profitFactor >= 1 or profit >= 0; fallback: top 75% by robust score.
    """
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
    """Composite key: strategyId + params for param-optimized backtest results."""
    sid = r.get("strategyId", "")
    params = r.get("strategyParams")
    if params and isinstance(params, dict) and params:
        param_str = "|".join(sorted(f"{k}={v}" for k, v in params.items()))
        return f"{sid}|{param_str}"
    return sid


def backtest_rows_to_features(rows: list, strategy_id_to_idx: dict, timeframe_to_idx: dict, regime_to_idx: dict):
    """
    Convert list of backtest result rows into a fixed-size feature vector per instrument (aggregated).
    Features: per-strategy (win, profit, profit_factor, sharpe) + per-tf×regime (win, profit).
    Richer features help NN learn which configs are robust for prediction.
    """
    num_strategies = len(strategy_id_to_idx)
    num_tf = len(timeframe_to_idx)
    num_reg = len(regime_to_idx)
    feature_dim = num_strategies * 4 + num_tf * num_reg * 2
    instruments = {}
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
        pf = np.tanh((_safe_float(r.get("profitFactor"), 1) - 1) / 2.0)  # ~[-1,1] for pf 0..3
        sharpe = np.tanh(_safe_float(r.get("sharpeRatio"), 0) / 2.0)  # ~[-1,1] for sharpe -2..2
        instruments[inst_id]["strategy_win"][s_idx] += win
        instruments[inst_id]["strategy_profit"][s_idx] += profit
        instruments[inst_id]["strategy_pf"][s_idx] += pf
        instruments[inst_id]["strategy_sharpe"][s_idx] += sharpe
        instruments[inst_id]["strategy_count"][s_idx] += 1
        instruments[inst_id]["tf_reg_win"][tf_idx, reg_idx] += win
        instruments[inst_id]["tf_reg_profit"][tf_idx, reg_idx] += profit
        instruments[inst_id]["tf_reg_count"][tf_idx, reg_idx] += 1

    vecs = []
    instrument_ids = []
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
        return np.zeros((1, feature_dim), dtype=np.float32), ["default"]
    return np.stack(vecs), instrument_ids


def instrument_type_to_idx(it: str) -> int:
    m = {"fiat": 0, "crypto": 1, "synthetic_deriv": 2, "indices_exness": 3}
    return m.get(it, 0)


OOS_TRAIN_FRACTION = 0.8


def _compute_oos_metrics(
    model: "InstrumentBotNNV2",
    val_features: np.ndarray,
    val_inst_idx: np.ndarray,
    strategy_id_to_idx: dict,
    regime_to_idx: dict,
    timeframe_to_idx: dict,
) -> dict:
    """Compute out-of-sample accuracy on validation set."""
    if val_features.size == 0 or len(val_features) == 0:
        return {"oos_accuracy": 0.0, "oos_sample_count": 0}
    from .model import NUM_REGIMES, NUM_TIMEFRAMES

    model.eval()
    num_strategies = len(strategy_id_to_idx)
    targets = np.zeros(len(val_features), dtype=np.int64)
    if val_features.shape[0] > 0:
        s_profit = val_features[:, num_strategies : 2 * num_strategies] if val_features.shape[1] >= 2 * num_strategies else val_features[:, :num_strategies]
        mean_profit = s_profit.mean(axis=1)
        targets = np.where(mean_profit > 0.1, 0, np.where(mean_profit < -0.1, 1, 2)).astype(np.int64)

    X = torch.from_numpy(val_features).float().to(DEVICE)
    I = torch.from_numpy(val_inst_idx).long().to(DEVICE)
    reg = torch.zeros(X.size(0), NUM_REGIMES, device=DEVICE)
    tf = torch.zeros(X.size(0), NUM_TIMEFRAMES, device=DEVICE)

    with torch.no_grad():
        logits = model(X, I, regime_onehot=reg, timeframe_onehot=tf)
        preds = logits[:, 0].argmax(dim=-1).cpu().numpy()

    correct = (preds == targets).sum()
    return {"oos_accuracy": float(correct) / len(targets) if len(targets) else 0.0, "oos_sample_count": len(targets)}


def train(
    backtest_json_path: Optional[str] = None,
    instrument_types_json: Optional[dict] = None,
    output_dir: str = "checkpoints",
    instrument_id: Optional[str] = None,
    epochs: int = 50,
    batch_size: int = 32,
    lr: float = 1e-3,
    validation_rows: Optional[list] = None,
):
    """
    Train from scratch (no incremental). Full retrain avoids catastrophic forgetting
    but does not retain historical context; each run uses only the provided backtest data.
    """
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
    else:
        strategy_ids = sorted(set(_strategy_config_key(r) for r in rows))
        timeframes = sorted(set(r.get("timeframe", "M5") for r in rows))
        regimes = sorted(set(r.get("regime", "unknown") for r in rows))
        strategy_id_to_idx = {s: i for i, s in enumerate(strategy_ids)}
        timeframe_to_idx = {t: i for i, t in enumerate(timeframes)}
        regime_to_idx = {r: i for i, r in enumerate(regimes)}

    features, instrument_ids = backtest_rows_to_features(rows, strategy_id_to_idx, timeframe_to_idx, regime_to_idx)
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
    inst_type_idx = np.array([instrument_type_to_idx(inst_type_map.get(i, "fiat")) for i in instrument_ids], dtype=np.int64)

    # Targets from strategy profit: profitable = long (0), unprofitable = short (1), else neutral (2)
    targets = np.zeros(max(1, len(features)), dtype=np.int64)
    if features.shape[0] > 0:
        s_profit = features[:, num_strategies : 2 * num_strategies]
        mean_profit = s_profit.mean(axis=1)
        targets = np.where(mean_profit > 0.1, 0, np.where(mean_profit < -0.1, 1, 2)).astype(np.int64)

    # Regression targets: size_mult (0.5-2), sl_pct (0.01-0.05), tp_r (1-3)
    # size_mult: higher win rate -> larger size
    s_win = features[:, :num_strategies]
    win_rates = s_win.mean(axis=1) if features.shape[0] > 0 else np.array([0.5])
    size_mult_raw = np.clip((win_rates - 0.5) / 0.5 + 0.5, 0, 1)  # map to [0,1]
    reg_targets = np.zeros((max(1, len(features)), 3), dtype=np.float32)
    reg_targets[:, 0] = size_mult_raw
    reg_targets[:, 1] = 0.25  # sl_pct 0.02 -> sigmoid 0.25
    reg_targets[:, 2] = 0.5   # tp_r 2.0 -> sigmoid 0.5

    # Strategy selection targets: which strategy had best risk-adjusted performance
    strategy_targets = np.zeros(max(1, len(features)), dtype=np.int64)
    if features.shape[0] > 0 and num_strategies > 0:
        s_profit = features[:, num_strategies : 2 * num_strategies]
        s_pf = features[:, 2 * num_strategies : 3 * num_strategies] if features.shape[1] >= 3 * num_strategies else np.zeros_like(s_profit)
        score = s_profit + 0.2 * s_pf  # Prefer configs with good profit factor
        strategy_targets = np.argmax(score, axis=1).astype(np.int64)

    # BatchNorm1d needs batch size >= 2; duplicate single sample so training doesn't fail
    n = features.shape[0]
    if n == 1:
        features = np.concatenate([features, features], axis=0)
        inst_type_idx = np.concatenate([inst_type_idx, inst_type_idx], axis=0)
        targets = np.concatenate([targets, targets], axis=0)
        reg_targets = np.concatenate([reg_targets, reg_targets], axis=0)
        strategy_targets = np.concatenate([strategy_targets, strategy_targets], axis=0)
        n = 2

    X = torch.from_numpy(features).float().to(DEVICE)
    I = torch.from_numpy(inst_type_idx).long().to(DEVICE)
    Y = torch.from_numpy(targets).long().unsqueeze(1).expand(-1, 5).to(DEVICE)
    Y_reg = torch.from_numpy(reg_targets).float().to(DEVICE)
    Y_strat = torch.from_numpy(strategy_targets).long().to(DEVICE)

    dataset = TensorDataset(X, I, Y, Y_reg, Y_strat)
    loader = DataLoader(dataset, batch_size=min(batch_size, len(dataset)), shuffle=True)

    model = InstrumentBotNNV2(cfg).to(DEVICE)
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
            reg = torch.zeros(B, NUM_REGIMES, device=dev)
            tf = torch.zeros(B, NUM_TIMEFRAMES, device=dev)
            logits = model(x, i, regime_onehot=reg, timeframe_onehot=tf)
            ce_loss = sum(loss_fn(logits[:, j], y[:, j]) for j in range(5))
            inst_emb = model.instrument_embed(i)
            enc_in = torch.cat([x, inst_emb, reg, tf], dim=1)
            h = model._encode(enc_in)
            reg_out = model.regression_head(h)
            reg_loss = mse_fn(reg_out, y_reg)
            strat_loss = torch.tensor(0.0, device=dev)
            if model.strategy_head is not None and num_strategies > 0:
                strat_logits = model.strategy_head(h)
                strat_loss = loss_fn(strat_logits, y_strat)
            loss = ce_loss + 0.5 * reg_loss + 0.3 * strat_loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            opt.step()
            total_loss += loss.item()
        if (epoch + 1) % 10 == 0:
            print(f"Epoch {epoch+1}/{epochs} loss={total_loss/len(loader):.4f} [device={DEVICE}]")

    # One instrument = one model: save per-instrument checkpoint (no sharing)
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
    torch.save({
        "model_state": model.state_dict(),
        "strategy_feature_dim": target_dim,
        "model_version": 2,
        "model_config": config_dict,
    }, save_path)
    # Audit metadata + mappings for inference (regime/timeframe one-hot and optional feature build)
    from datetime import datetime, timezone
    data_end_times = [r.get("dataEndTime") or r.get("completedAt") for r in rows if isinstance(r, dict)]
    data_end_times = [t for t in data_end_times if t is not None]
    strategy_ids = [k for k, _ in sorted(strategy_id_to_idx.items(), key=lambda x: x[1])]
    meta = {
        "instrument_id": instrument_id,
        "trained_at_iso": datetime.now(timezone.utc).isoformat(),
        "data_end_min": min(data_end_times) if data_end_times else None,
        "data_end_max": max(data_end_times) if data_end_times else None,
        "num_rows": len(rows),
        "from_scratch": True,
        "strategy_feature_dim": target_dim,
        "strategy_id_to_idx": strategy_id_to_idx,
        "strategy_ids": strategy_ids,
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
                    val_features, ((0, 0), (0, target_dim - val_features.shape[1])), mode="constant", constant_values=0
                )
            else:
                val_features = val_features[:, :target_dim]
            val_inst_idx = np.array(
                [instrument_type_to_idx(inst_type_map.get(i, "fiat")) for i in val_inst_ids], dtype=np.int64
            )
            oos_metrics = _compute_oos_metrics(
                model, val_features, val_inst_idx, strategy_id_to_idx, regime_to_idx, timeframe_to_idx
            )
            print(f"OOS validation: accuracy={oos_metrics['oos_accuracy']:.2%} (n={oos_metrics['oos_sample_count']})")

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
