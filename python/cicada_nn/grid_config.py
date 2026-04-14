"""
Grid / research limits — single source of truth. Mirrors src/app/core/gridConfig.ts.

Env (optional):
  CICADA_PARAM_COMBOS_LIMIT — backtest param sets per strategy (default 12). Use 0 for full Cartesian grid.
  CICADA_RESEARCH_REGIME_GRID_MAX — max regime configs per instrument (default 9).
  CICADA_RESEARCH_PARAM_TUNE_MAX_STRAT — strategy param combos per regime in research (default 2).
  CICADA_RESEARCH_PARAM_TUNE_MAX_RISK — risk param configs per regime (default 6).

Full grids: STRATEGY_PARAM_RANGES in strategy_params.py; largest families ~500k combos
(e.g. structure 708×708 ≈ 501k). See APPROX_FULL_GRID_COMBOS_PER_FAMILY.
"""

from __future__ import annotations

import os

APPROX_FULL_GRID_COMBOS_PER_FAMILY = 500_000  # aligns with ~501k for 708² structure grid


def _int_env(key: str, default: int) -> int:
    v = os.environ.get(key)
    if v is None or v == "":
        return default
    try:
        return int(v)
    except ValueError:
        return default


DEFAULT_PARAM_COMBOS_LIMIT = _int_env("CICADA_PARAM_COMBOS_LIMIT", 12)
DEFAULT_RESEARCH_REGIME_GRID_MAX = _int_env("CICADA_RESEARCH_REGIME_GRID_MAX", 9)
DEFAULT_RESEARCH_PARAM_TUNE_MAX_STRAT = _int_env("CICADA_RESEARCH_PARAM_TUNE_MAX_STRAT", 2)
DEFAULT_RESEARCH_PARAM_TUNE_MAX_RISK = _int_env("CICADA_RESEARCH_PARAM_TUNE_MAX_RISK", 6)


def normalize_param_combos_limit(n: int | None) -> int:
    """
    None → default. <=0 → 0 (full Cartesian grid in get_param_combinations).
    >=1 → that many combos.
    """
    if n is None:
        return DEFAULT_PARAM_COMBOS_LIMIT
    if n <= 0:
        return 0
    return max(1, n)
