# Verification Audit: Derived vs Hardcoded

This document lists what is **derived from backtest data** vs **hardcoded** so you can verify completeness.

## ✅ Derived from Backtest (Data-Driven)

| Component | Location | What's Derived |
|-----------|----------|----------------|
| **ModelConfig** | `train.py` → `derive_model_config_from_backtest()` | `strategy_feature_dim`, `hidden_dim`, `num_layers`, `num_heads`, `num_tokens`, `dropout` from `feature_dim`, `num_strategies`, `num_timeframes`, `num_regimes`, `num_samples` |
| **Feature dimension** | `train.py` | `feature_dim = num_strategies*2 + num_tf*num_reg*2` from backtest rows; clamped 32–512 |
| **Strategy/timeframe/regime mappings** | `train.py` | `strategy_id_to_idx`, `timeframe_to_idx`, `regime_to_idx` from unique values in rows |
| **Training rows** | `train.py` → `filter_best_results_for_build()` | Keeps `profitFactor >= 1` or `profit >= 0`; fallback top 75% by profit |
| **Feature vector for build response** | `api.py` | Padded/truncated to `strategy_feature_dim` from meta (saved at train time) |

## ⚠️ Intentional Constants (Not Hardcoded Arbitrarily)

| Constant | Location | Reason |
|----------|----------|--------|
| `32` min / `512` max feature dim | `train.py` | Sanity bounds; model architecture limits |
| `0.5`, `0.75` in filter | `train.py` | Threshold 50% pass rate; top 75% fallback (matches frontend) |
| `0.25`, `0.5` regression targets | `train.py` | Sigmoid mapping for sl_pct, tp_r (fixed output ranges) |
| `NUM_REGIMES=9`, `NUM_TIMEFRAMES=8` | `model.py` | Fixed regime/timeframe vocab (align with frontend) |
| `5` output heads | `model.py` | One per trade style (scalp, day, swing, position, scalp_only) |

## 🔧 Fixed: Frontend 256 Hardcode

Previously the frontend required `feature_vector.length === 256`. This is now `>= 32 && <= 512` to support variable dimensions from the derived config.

## How to Verify

```bash
# 1. Frontend build
npm run build

# 2. Python train + load + predict
cd python && source venv/bin/activate
python -c "
import json, tempfile, os
from cicada_nn.train import train
from cicada_nn.model import build_model_from_checkpoint
import torch
rows = [{'instrumentId':'X','strategyId':'S1','timeframe':'M5','regime':'ranging','winRate':55,'profit':100,'profitFactor':1.2,'status':'completed'}]
with tempfile.NamedTemporaryFile(mode='w',suffix='.json',delete=False) as f:
    json.dump(rows, f)
    path = f.name
out = train(backtest_json_path=path, output_dir='_v', epochs=2)
ck = torch.load(out, map_location='cpu', weights_only=True)
assert ck['strategy_feature_dim'] == 32  # derived, not 256
model = build_model_from_checkpoint(ck)
model.load_state_dict(ck['model_state'], strict=False)
print('OK: strategy_feature_dim=', ck['strategy_feature_dim'])
os.unlink(path)
import shutil; shutil.rmtree('_v')
"
```
