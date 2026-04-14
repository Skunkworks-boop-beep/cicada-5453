"""
CICADA-5453 Neural network model (PyTorch).
Industry-researched architecture: residual blocks, LayerNorm, multi-head attention,
GELU activation, configurable depth/width. Supports both legacy and V2 checkpoints.
"""

from dataclasses import dataclass
from typing import Optional, Tuple

import torch  # type: ignore[reportMissingImports]
import torch.nn as nn  # type: ignore[reportMissingImports]
import torch.nn.functional as F  # type: ignore[reportMissingImports]

# Instrument type embedding; number of regimes, timeframes, styles (align with frontend)
NUM_REGIMES = 9
NUM_TIMEFRAMES = 8
NUM_STYLES = 5
INSTRUMENT_TYPES = 4  # fiat, crypto, synthetic_deriv, indices_exness

DEFAULT_SIZE_MULTIPLIER = 1.0
DEFAULT_SL_PCT = 0.02
DEFAULT_TP_R = 2.0


@dataclass
class ModelConfig:
    """Dynamic model configuration for robustness and flexibility."""
    strategy_feature_dim: int = 256
    hidden_dim: int = 256
    num_layers: int = 4
    num_heads: int = 4
    num_output_heads: int = 5
    num_strategies: int = 0  # Strategy selection head; 0 = disabled
    dropout: float = 0.2
    use_attention: bool = True
    use_residual: bool = True
    instrument_embed_dim: int = 32
    ffn_multiplier: int = 2
    num_tokens: int = 8  # For attention over feature segments


class ResidualBlock(nn.Module):
    """Pre-norm residual block with GELU. Supports (B,D) and (B,L,D)."""

    def __init__(self, dim: int, dropout: float = 0.1):
        super().__init__()
        self.norm = nn.LayerNorm(dim)
        self.ff = nn.Sequential(
            nn.Linear(dim, dim * 2),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(dim * 2, dim),
            nn.Dropout(dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x + self.ff(self.norm(x))


class FeatureAttention(nn.Module):
    """Multi-head self-attention over feature dimension. Captures cross-feature relationships."""

    def __init__(self, dim: int, num_heads: int = 4, dropout: float = 0.1):
        super().__init__()
        assert dim % num_heads == 0
        self.num_heads = num_heads
        self.head_dim = dim // num_heads
        self.scale = self.head_dim ** -0.5
        self.qkv = nn.Linear(dim, dim * 3)
        self.proj = nn.Linear(dim, dim)
        self.dropout = nn.Dropout(dropout)
        self.norm = nn.LayerNorm(dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, L, D = x.shape
        qkv = self.qkv(self.norm(x)).reshape(B, L, 3, self.num_heads, self.head_dim).permute(2, 0, 3, 1, 4)
        q, k, v = qkv[0], qkv[1], qkv[2]
        attn = (q @ k.transpose(-2, -1)) * self.scale
        attn = attn.softmax(dim=-1)
        attn = self.dropout(attn)
        out = (attn @ v).transpose(1, 2).reshape(B, L, D)
        return x + self.dropout(self.proj(out))


class InstrumentBotNNV2(nn.Module):
    """
    Robust, dynamic DNN for trading decisions.
    - Residual blocks with LayerNorm + GELU
    - Multi-head self-attention over features
    - Configurable depth/width
    - Separate action and regression heads
    """

    def __init__(self, config: Optional[ModelConfig] = None):
        super().__init__()
        cfg = config or ModelConfig()
        self.config = cfg
        self.strategy_feature_dim = cfg.strategy_feature_dim
        input_dim = cfg.strategy_feature_dim + cfg.instrument_embed_dim + NUM_REGIMES + NUM_TIMEFRAMES

        self.instrument_embed = nn.Embedding(INSTRUMENT_TYPES, cfg.instrument_embed_dim)
        self.num_tokens = cfg.num_tokens
        self.input_proj = nn.Sequential(
            nn.Linear(input_dim, cfg.num_tokens * cfg.hidden_dim),
            nn.GELU(),
            nn.Dropout(cfg.dropout),
        )

        self.blocks = nn.ModuleList()
        for _ in range(cfg.num_layers):
            if cfg.use_attention:
                self.blocks.append(FeatureAttention(cfg.hidden_dim, cfg.num_heads, cfg.dropout))
            self.blocks.append(ResidualBlock(cfg.hidden_dim, cfg.dropout))

        self.output_norm = nn.LayerNorm(cfg.hidden_dim)
        self.pool = nn.Linear(self.num_tokens * cfg.hidden_dim, cfg.hidden_dim)
        self.heads = nn.ModuleList([
            nn.Linear(cfg.hidden_dim, 3) for _ in range(cfg.num_output_heads)
        ])
        self.num_strategies = cfg.num_strategies
        self.strategy_head = nn.Linear(cfg.hidden_dim, cfg.num_strategies) if cfg.num_strategies > 0 else None
        self.regression_head = nn.Sequential(
            nn.Linear(cfg.hidden_dim, cfg.hidden_dim),
            nn.GELU(),
            nn.Dropout(cfg.dropout),
            nn.Linear(cfg.hidden_dim, 3),
            nn.Sigmoid(),
        )

    def _encode(self, x: torch.Tensor) -> torch.Tensor:
        cfg = self.config
        x = self.input_proj(x)
        x = x.view(x.size(0), self.num_tokens, cfg.hidden_dim)
        for block in self.blocks:
            if isinstance(block, FeatureAttention):
                x = block(x)
            else:
                x = block(x)
        x = x.flatten(1)
        x = self.pool(x)
        return self.output_norm(x)

    def forward(
        self,
        backtest_features: torch.Tensor,
        instrument_type_idx: torch.Tensor,
        regime_onehot: Optional[torch.Tensor] = None,
        timeframe_onehot: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        B = backtest_features.size(0)
        dev = backtest_features.device
        inst_emb = self.instrument_embed(instrument_type_idx)
        if regime_onehot is None:
            regime_onehot = torch.zeros(B, NUM_REGIMES, device=dev)
        if timeframe_onehot is None:
            timeframe_onehot = torch.zeros(B, NUM_TIMEFRAMES, device=dev)

        x = torch.cat([backtest_features, inst_emb, regime_onehot, timeframe_onehot], dim=1)
        h = self._encode(x)
        return torch.stack([head(h) for head in self.heads], dim=1)

    def predict_actions(self, *args, **kwargs) -> torch.Tensor:
        logits = self.forward(*args, **kwargs)
        return logits.argmax(dim=-1)

    def predict_with_params(
        self,
        backtest_features: torch.Tensor,
        instrument_type_idx: torch.Tensor,
        regime_onehot: Optional[torch.Tensor] = None,
        timeframe_onehot: Optional[torch.Tensor] = None,
        style_index: int = 0,
    ) -> Tuple[torch.Tensor, float, float, float, float, Optional[int]]:
        B = backtest_features.size(0)
        dev = backtest_features.device
        inst_emb = self.instrument_embed(instrument_type_idx)
        if regime_onehot is None:
            regime_onehot = torch.zeros(B, NUM_REGIMES, device=dev)
        if timeframe_onehot is None:
            timeframe_onehot = torch.zeros(B, NUM_TIMEFRAMES, device=dev)

        x = torch.cat([backtest_features, inst_emb, regime_onehot, timeframe_onehot], dim=1)
        h = self._encode(x)

        logits = torch.stack([head(h) for head in self.heads], dim=1)
        actions = logits.argmax(dim=-1)
        probs = F.softmax(logits, dim=-1)
        confidence = float(probs[0, style_index, actions[0, style_index]].item())

        raw = self.regression_head(h)
        r = raw[0]
        size_mult = float(0.5 + 1.5 * r[0].item())
        sl_pct = float(0.01 + 0.04 * r[1].item())
        tp_r = float(1.0 + 2.0 * r[2].item())

        strategy_idx: Optional[int] = None
        if self.strategy_head is not None:
            strat_logits = self.strategy_head(h)
            strategy_idx = int(strat_logits[0].argmax().item())

        return actions, confidence, size_mult, sl_pct, tp_r, strategy_idx


# ─── Legacy model (backward compatibility) ────────────────────────────────────


class InstrumentBotNN(nn.Module):
    """
    Legacy model for backward compatibility with existing checkpoints.
    Use InstrumentBotNNV2 for new builds.
    """

    def __init__(
        self,
        strategy_feature_dim: int = 256,
        hidden_dims: Optional[list] = None,
        num_output_heads: int = 5,
        dropout: float = 0.2,
    ):
        super().__init__()
        hidden_dims = hidden_dims or [256, 128, 64]
        self.strategy_feature_dim = strategy_feature_dim
        self.num_output_heads = num_output_heads

        self.instrument_embed = nn.Embedding(INSTRUMENT_TYPES, 16)
        self.feature_encoder = nn.Sequential(
            nn.Linear(strategy_feature_dim + 16 + NUM_REGIMES + NUM_TIMEFRAMES, 256),
            nn.ReLU(),
            nn.BatchNorm1d(256),
            nn.Dropout(dropout),
            nn.Linear(256, 256),
            nn.ReLU(),
            nn.BatchNorm1d(256),
            nn.Dropout(dropout),
        )

        layers = []
        in_d = 256
        for h in hidden_dims:
            layers += [
                nn.Linear(in_d, h),
                nn.ReLU(),
                nn.BatchNorm1d(h),
                nn.Dropout(dropout),
            ]
            in_d = h
        self.backbone = nn.Sequential(*layers)
        self.heads = nn.ModuleList([nn.Linear(in_d, 3) for _ in range(num_output_heads)])
        self.regression_head = nn.Sequential(
            nn.Linear(in_d, 32),
            nn.ReLU(),
            nn.Linear(32, 3),
            nn.Sigmoid(),
        )

    def forward(
        self,
        backtest_features: torch.Tensor,
        instrument_type_idx: torch.Tensor,
        regime_onehot: Optional[torch.Tensor] = None,
        timeframe_onehot: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        B = backtest_features.size(0)
        dev = backtest_features.device
        inst_emb = self.instrument_embed(instrument_type_idx)
        if regime_onehot is None:
            regime_onehot = torch.zeros(B, NUM_REGIMES, device=dev)
        if timeframe_onehot is None:
            timeframe_onehot = torch.zeros(B, NUM_TIMEFRAMES, device=dev)

        x = torch.cat([backtest_features, inst_emb, regime_onehot, timeframe_onehot], dim=1)
        x = self.feature_encoder(x)
        x = self.backbone(x)
        return torch.stack([head(x) for head in self.heads], dim=1)

    def predict_actions(self, *args, **kwargs) -> torch.Tensor:
        logits = self.forward(*args, **kwargs)
        return logits.argmax(dim=-1)

    def predict_with_params(
        self,
        backtest_features: torch.Tensor,
        instrument_type_idx: torch.Tensor,
        regime_onehot: Optional[torch.Tensor] = None,
        timeframe_onehot: Optional[torch.Tensor] = None,
        style_index: int = 0,
    ) -> Tuple[torch.Tensor, float, float, float, float]:
        B = backtest_features.size(0)
        dev = backtest_features.device
        inst_emb = self.instrument_embed(instrument_type_idx)
        if regime_onehot is None:
            regime_onehot = torch.zeros(B, NUM_REGIMES, device=dev)
        if timeframe_onehot is None:
            timeframe_onehot = torch.zeros(B, NUM_TIMEFRAMES, device=dev)

        x = torch.cat([backtest_features, inst_emb, regime_onehot, timeframe_onehot], dim=1)
        x = self.feature_encoder(x)
        x = self.backbone(x)

        logits = torch.stack([head(x) for head in self.heads], dim=1)
        actions = logits.argmax(dim=-1)
        probs = F.softmax(logits, dim=-1)
        confidence = float(probs[0, style_index, actions[0, style_index]].item())

        raw = self.regression_head(x)
        r = raw[0]
        size_mult = float(0.5 + 1.5 * r[0].item())
        sl_pct = float(0.01 + 0.04 * r[1].item())
        tp_r = float(1.0 + 2.0 * r[2].item())
        return actions, confidence, size_mult, sl_pct, tp_r


def build_default_model(strategy_feature_dim: int = 256, use_v2: bool = True) -> nn.Module:
    """Build model. use_v2=True for new robust architecture."""
    if use_v2:
        cfg = ModelConfig(strategy_feature_dim=strategy_feature_dim)
        return InstrumentBotNNV2(cfg)
    return InstrumentBotNN(strategy_feature_dim=strategy_feature_dim)


def build_model_from_checkpoint(checkpoint: dict) -> nn.Module:
    """Build model from checkpoint, choosing V1 or V2 based on saved config."""
    model_version = checkpoint.get("model_version", 1)
    feat_dim = checkpoint.get("strategy_feature_dim", 256)
    if model_version >= 2:
        config_dict = checkpoint.get("model_config", {})
        config_dict["strategy_feature_dim"] = feat_dim
        valid = {k: v for k, v in config_dict.items() if k in ModelConfig.__dataclass_fields__}
        cfg = ModelConfig(**valid)
        return InstrumentBotNNV2(cfg)
    return InstrumentBotNN(strategy_feature_dim=feat_dim)
