"""
Detection-based training: NN learns to recognize when selected strategies fire.
Backtest finds best configs → we train on bar-level data with strategy signals as labels.
Trades are made only when the NN recognizes the strategy it was trained on.
"""

import json
import math
import os
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

from .signals import get_signal
from .train import _safe_instrument_id, _robust_score, filter_best_results_for_build

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

# Default when timeframe unknown
DEFAULT_BAR_WINDOW = 60

# Timeframe -> bar window: scalp 40-50, day 60-80, swing 80-100, position 100-120
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

# Strategy-specific min bars (from signals.ts lookbacks). NN must see at least this many bars.
# Exact match first; then prefix. Derived from: MACD slow 26, EMA ribbon 55, Ichimoku 52, TRIX 47, etc.
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
# Prefix fallbacks (checked if no exact match)
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
    """Min bars required by this strategy (from signals.ts lookbacks)."""
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
    """Bar window by timeframe: scalp 40-50, day 60-80, swing 80-100, position 100-120."""
    return TF_TO_BAR_WINDOW.get((timeframe or "").upper(), DEFAULT_BAR_WINDOW)


def get_bar_window_for_detection(timeframe: str, strategy_id: str) -> int:
    """Bar window = max(TF-based, strategy min). Ensures NN sees enough context for the strategy."""
    tf_window = get_bar_window_for_timeframe(timeframe)
    strategy_min = _strategy_min_bars(strategy_id)
    return max(tf_window, strategy_min)


def bars_to_features(bars: list[dict], i: int, window: int) -> np.ndarray:
    """Extract normalized OHLC features from bars[i-window+1:i+1]. Returns window*4 dims."""
    feat_dim = window * 4
    start = max(0, i - window + 1)
    slice_bars = bars[start : i + 1]
    if len(slice_bars) < 2:
        return np.zeros(feat_dim, dtype=np.float32)
    # Normalize by first close
    base = slice_bars[0].get("close") or slice_bars[0].get("close", 1)
    if base <= 0:
        base = 1
    rows = []
    for b in slice_bars:
        o = (b.get("open") or b.get("close", 0)) / base
        h = (b.get("high") or b.get("close", 0)) / base
        l_ = (b.get("low") or b.get("close", 0)) / base
        c = (b.get("close") or 0) / base
        rows.extend([o, h, l_, c])
    arr = np.array(rows, dtype=np.float32)
    if len(arr) < feat_dim:
        arr = np.pad(arr, (0, feat_dim - len(arr)), mode="constant", constant_values=0)
    return arr[:feat_dim]


class StrategyDetectionNN(nn.Module):
    """Lightweight NN to detect strategy signals from bar features."""

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


def train_detection(
    bars_by_key: dict[str, list[dict]],
    results: list[dict],
    instrument_id: str,
    output_dir: str = "checkpoints",
    epochs: int = 30,
    lr: float = 1e-3,
) -> tuple[str, dict]:
    """
    Train NN to detect strategy signals from bar data.
    - results: backtest result rows (used to pick best strategy config)
    - bars_by_key: "instrumentId|timeframe" -> list of {open, high, low, close}
    Returns (checkpoint_path, meta).
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    best_rows = filter_best_results_for_build(results)
    if not best_rows:
        raise ValueError("No backtest results for detection training.")
    best = max(best_rows, key=_robust_score)
    strategy_id = best.get("strategyId", "")
    strategy_params = best.get("strategyParams") or {}
    timeframe = best.get("timeframe", "M5")
    regime_default = best.get("regime", "unknown")

    bar_window = get_bar_window_for_detection(timeframe, strategy_id)
    bar_feature_dim = bar_window * 4

    key = f"{best.get('instrumentId', instrument_id)}|{timeframe}"
    bars = bars_by_key.get(key)
    if not bars or len(bars) < bar_window + 5:
        raise ValueError(f"Insufficient bars for detection training: need >= {bar_window + 5}, got {len(bars) if bars else 0}")

    # Build (features, label) pairs: label = strategy signal at bar i
    X_list = []
    y_list = []
    for i in range(bar_window, len(bars) - 1):
        feat = bars_to_features(bars, i, bar_window)
        regime = regime_default  # Use config regime for label consistency
        try:
            signal = get_signal(strategy_id, bars, i, regime, strategy_params)
        except Exception:
            signal = 0
        # Class indices: 0=neutral, 1=short, 2=long
        label = 0 if signal == 0 else (1 if signal == -1 else 2)
        X_list.append(feat)
        y_list.append(label)

    X = np.stack(X_list, dtype=np.float32)
    y = np.array(y_list, dtype=np.int64)

    # Balance: oversample minority or weight
    n_neutral = (y == 0).sum()
    n_long = (y == 2).sum()
    n_short = (y == 1).sum()
    total = len(y)
    if total < 50:
        raise ValueError(f"Too few labeled bars for detection: {total}")

    X_t = torch.from_numpy(X).float().to(DEVICE)
    y_t = torch.from_numpy(y).long().to(DEVICE)
    dataset = TensorDataset(X_t, y_t)
    loader = DataLoader(dataset, batch_size=min(64, len(dataset)), shuffle=True)

    model = StrategyDetectionNN(input_dim=X.shape[1], hidden=128, dropout=0.25).to(DEVICE)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)
    loss_fn = nn.CrossEntropyLoss()

    for ep in range(epochs):
        model.train()
        total = 0.0
        for bx, by in loader:
            opt.zero_grad()
            logits = model(bx)
            loss = loss_fn(logits, by)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            total += loss.item()
        if (ep + 1) % 10 == 0:
            print(f"Detection epoch {ep+1}/{epochs} loss={total/len(loader):.4f}")

    safe_id = _safe_instrument_id(instrument_id)
    path = os.path.join(output_dir, f"instrument_detection_{safe_id}.pt")
    meta = {
        "instrument_id": instrument_id,
        "strategy_id": strategy_id,
        "strategy_params": strategy_params,
        "timeframe": timeframe,
        "bar_window": bar_window,
        "bar_feature_dim": bar_feature_dim,
        "num_samples": len(y),
    }
    torch.save({"model_state": model.state_dict(), "meta": meta}, path)
    with open(os.path.join(output_dir, f"instrument_detection_{safe_id}_meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"Saved detection model to {path}")
    return path, {"strategy_id": strategy_id, "num_samples": len(y), "timeframe": timeframe, "bar_window": bar_window}
