"""
CICADA-5453 neural network models (PyTorch).

Three architectures coexist for backward compatibility:

* ``InstrumentBotNN`` (V1): legacy MLP, still loadable for old checkpoints.
* ``InstrumentBotNNV2`` (V2): residual blocks + multi-head attention. Still the
  workhorse for tabular (feature-vector) inference.
* ``StrategyDetectionNN`` (V3): sequence detection model used by
  ``train_detection`` — a small conv + attention tower that consumes
  scale-invariant bar-window features.

All new models expose:

* A temperature-scaling parameter for post-hoc calibration.
* Deterministic ``forward`` and an MC-dropout ``forward_mc`` for uncertainty.

The build-from-checkpoint helper dispatches on ``model_version`` so existing
``.pt`` files keep working.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

import torch  # type: ignore[reportMissingImports]
import torch.nn as nn  # type: ignore[reportMissingImports]
import torch.nn.functional as F  # type: ignore[reportMissingImports]


NUM_REGIMES = 9
NUM_TIMEFRAMES = 8
NUM_STYLES = 5
INSTRUMENT_TYPES = 4  # fiat, crypto, synthetic_deriv, indices_exness

DEFAULT_SIZE_MULTIPLIER = 1.0
DEFAULT_SL_PCT = 0.02
DEFAULT_TP_R = 2.0


# ─── Tabular architecture (V1 / V2) ──────────────────────────────────────────


@dataclass
class ModelConfig:
    """Dynamic model configuration for robustness and flexibility."""

    strategy_feature_dim: int = 256
    hidden_dim: int = 256
    num_layers: int = 4
    num_heads: int = 4
    num_output_heads: int = 5
    num_strategies: int = 0
    dropout: float = 0.2
    use_attention: bool = True
    use_residual: bool = True
    instrument_embed_dim: int = 32
    ffn_multiplier: int = 2
    num_tokens: int = 8


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
    """Multi-head self-attention across feature tokens."""

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
    """Feature-vector model used for strategy selection and meta-learning."""

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
        self.heads = nn.ModuleList([nn.Linear(cfg.hidden_dim, 3) for _ in range(cfg.num_output_heads)])
        self.num_strategies = cfg.num_strategies
        self.strategy_head = nn.Linear(cfg.hidden_dim, cfg.num_strategies) if cfg.num_strategies > 0 else None
        self.regression_head = nn.Sequential(
            nn.Linear(cfg.hidden_dim, cfg.hidden_dim),
            nn.GELU(),
            nn.Dropout(cfg.dropout),
            nn.Linear(cfg.hidden_dim, 3),
            nn.Sigmoid(),
        )
        # Temperature-scaling parameter (learned post-hoc; 1.0 == no scaling).
        self.log_temperature = nn.Parameter(torch.zeros(1))

    @property
    def temperature(self) -> torch.Tensor:
        return self.log_temperature.exp().clamp(min=0.25, max=4.0)

    def _encode(self, x: torch.Tensor) -> torch.Tensor:
        cfg = self.config
        x = self.input_proj(x)
        x = x.view(x.size(0), self.num_tokens, cfg.hidden_dim)
        for block in self.blocks:
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
        logits = torch.stack([head(h) for head in self.heads], dim=1)
        return logits / self.temperature

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
        logits = torch.stack([head(h) for head in self.heads], dim=1) / self.temperature
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


# ─── Sequence detection architecture (V3) ────────────────────────────────────


@dataclass
class DetectionConfig:
    """Configuration for the V3 bar-window detection network."""

    window: int = 60
    per_bar_features: int = 4
    context_features: int = 4  # rsi/atr/boll/slope
    hidden_dim: int = 96
    num_conv_blocks: int = 2
    num_attention_heads: int = 4
    num_classes: int = 3
    dropout: float = 0.2
    conv_kernel: int = 5

    @property
    def input_dim(self) -> int:
        return self.window * self.per_bar_features + self.context_features


class CausalConvBlock(nn.Module):
    """1-D temporal conv with LayerNorm, GELU, and a residual connection. Causal
    via left padding so the model only sees past bars."""

    def __init__(self, dim: int, kernel: int, dropout: float):
        super().__init__()
        self.pad = kernel - 1
        self.conv = nn.Conv1d(dim, dim, kernel)
        self.norm = nn.LayerNorm(dim)
        self.drop = nn.Dropout(dropout)
        self.ff = nn.Sequential(
            nn.Linear(dim, dim * 2),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(dim * 2, dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, L, D) -> (B, D, L)
        y = x.transpose(1, 2)
        y = F.pad(y, (self.pad, 0))
        y = self.conv(y)
        y = y.transpose(1, 2)
        y = self.drop(F.gelu(y))
        x = self.norm(x + y)
        x = x + self.ff(x)
        return x


class StrategyDetectionNN(nn.Module):
    """Sequence classifier with optional MC dropout and temperature scaling."""

    def __init__(self, config: Optional[DetectionConfig] = None):
        super().__init__()
        cfg = config or DetectionConfig()
        self.config = cfg
        self.per_bar_features = cfg.per_bar_features
        self.window = cfg.window
        self.context_features = cfg.context_features

        self.bar_embed = nn.Sequential(
            nn.Linear(cfg.per_bar_features, cfg.hidden_dim),
            nn.GELU(),
        )
        self.positional = nn.Parameter(torch.randn(cfg.window, cfg.hidden_dim) * 0.02)

        self.conv_blocks = nn.ModuleList([
            CausalConvBlock(cfg.hidden_dim, cfg.conv_kernel, cfg.dropout)
            for _ in range(cfg.num_conv_blocks)
        ])
        self.attn = FeatureAttention(cfg.hidden_dim, cfg.num_attention_heads, cfg.dropout)

        ctx_dim = max(1, cfg.context_features)
        self.context_proj = (
            nn.Sequential(nn.Linear(ctx_dim, cfg.hidden_dim), nn.GELU())
            if cfg.context_features > 0
            else None
        )

        self.norm = nn.LayerNorm(cfg.hidden_dim)
        self.cls_head = nn.Linear(cfg.hidden_dim, cfg.num_classes)
        self.regression_head = nn.Sequential(
            nn.Linear(cfg.hidden_dim, cfg.hidden_dim),
            nn.GELU(),
            nn.Dropout(cfg.dropout),
            nn.Linear(cfg.hidden_dim, 3),
            nn.Sigmoid(),
        )
        self.log_temperature = nn.Parameter(torch.zeros(1))

    @property
    def temperature(self) -> torch.Tensor:
        return self.log_temperature.exp().clamp(min=0.25, max=4.0)

    def _split(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor | None]:
        seq = x[:, : self.window * self.per_bar_features].view(
            x.size(0), self.window, self.per_bar_features
        )
        ctx = None
        if self.context_features > 0:
            ctx = x[:, self.window * self.per_bar_features :]
            if ctx.size(1) < self.context_features:
                ctx = F.pad(ctx, (0, self.context_features - ctx.size(1)))
            elif ctx.size(1) > self.context_features:
                ctx = ctx[:, : self.context_features]
        return seq, ctx

    def _encode(self, x: torch.Tensor) -> torch.Tensor:
        seq, ctx = self._split(x)
        h = self.bar_embed(seq) + self.positional.unsqueeze(0)
        for block in self.conv_blocks:
            h = block(h)
        h = self.attn(h)
        h = self.norm(h)
        last = h[:, -1, :]
        if ctx is not None and self.context_proj is not None:
            last = last + self.context_proj(ctx)
        return last

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = self._encode(x)
        return self.cls_head(h) / self.temperature

    def forward_with_regression(
        self, x: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor]:
        h = self._encode(x)
        logits = self.cls_head(h) / self.temperature
        reg = self.regression_head(h)
        return logits, reg

    @torch.no_grad()
    def forward_mc(
        self, x: torch.Tensor, samples: int = 20
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """Monte-Carlo dropout: return mean probabilities and predictive entropy.

        The caller enables dropout by calling ``.train()`` on the module before
        invocation (dropout layers must be active to get a posterior). Entropy
        is shannon-style in nats and is a good general-purpose uncertainty
        proxy: values near ln(3)≈1.1 mean the model is maximally uncertain."""
        probs_sum = None
        for _ in range(max(1, samples)):
            logits = self(x)
            probs = F.softmax(logits, dim=-1)
            probs_sum = probs if probs_sum is None else probs_sum + probs
        mean = probs_sum / float(samples)
        entropy = -(mean.clamp_min(1e-9) * mean.clamp_min(1e-9).log()).sum(dim=-1)
        return mean, entropy


# ─── Legacy V1 ───────────────────────────────────────────────────────────────


class InstrumentBotNN(nn.Module):
    """Legacy model for backward compatibility with V1 checkpoints."""

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


# ─── Factory helpers ─────────────────────────────────────────────────────────


def build_default_model(strategy_feature_dim: int = 256, use_v2: bool = True) -> nn.Module:
    """Build a tabular model. ``use_v2=True`` for the robust default."""
    if use_v2:
        cfg = ModelConfig(strategy_feature_dim=strategy_feature_dim)
        return InstrumentBotNNV2(cfg)
    return InstrumentBotNN(strategy_feature_dim=strategy_feature_dim)


def build_model_from_checkpoint(checkpoint: dict) -> nn.Module:
    """Build a tabular model from a saved state. Chooses V1 or V2 by version."""
    model_version = checkpoint.get("model_version", 1)
    feat_dim = checkpoint.get("strategy_feature_dim", 256)
    if model_version >= 2:
        config_dict = checkpoint.get("model_config", {})
        config_dict["strategy_feature_dim"] = feat_dim
        valid = {k: v for k, v in config_dict.items() if k in ModelConfig.__dataclass_fields__}
        cfg = ModelConfig(**valid)
        return InstrumentBotNNV2(cfg)
    return InstrumentBotNN(strategy_feature_dim=feat_dim)


def build_detection_model_from_checkpoint(checkpoint: dict) -> StrategyDetectionNN:
    """Build a V3 detection model from a saved state."""
    cfg_dict = checkpoint.get("detection_config") or checkpoint.get("meta") or {}
    # Older checkpoints stored only window / bar_feature_dim; infer sensible defaults.
    window = int(cfg_dict.get("window") or cfg_dict.get("bar_window") or 60)
    context = int(cfg_dict.get("context_features", cfg_dict.get("context_feature_dim", 4)))
    per_bar = int(cfg_dict.get("per_bar_features", 4))
    hidden = int(cfg_dict.get("hidden_dim", 96))
    num_classes = int(cfg_dict.get("num_classes", 3))
    dropout = float(cfg_dict.get("dropout", 0.2))
    cfg = DetectionConfig(
        window=window,
        per_bar_features=per_bar,
        context_features=context,
        hidden_dim=hidden,
        num_classes=num_classes,
        dropout=dropout,
    )
    return StrategyDetectionNN(cfg)
