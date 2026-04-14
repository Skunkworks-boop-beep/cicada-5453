/**
 * Single source of truth for strategy / research grid limits and the ~500k family scale.
 * Mirrors python/cicada_nn/grid_config.py — keep defaults and env var names aligned.
 *
 * Full Cartesian grids are defined in STRATEGY_PARAM_RANGES (strategyParams.ts / strategy_params.py).
 * Largest families are on the order of ~500k combos (e.g. structure: 708×708 ≈ 501k).
 * Practical runs use DEFAULT_PARAM_COMBOS_LIMIT (iterative sweeps) unless you set limit ≤ 0 for full grid.
 */

const ENV = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : ({} as Record<string, string | undefined>);

const _int = (v: string | undefined, def: number): number => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
};

/** Documented scale for the largest 2-parameter families (708² ≈ 501k). Not a runtime cap. */
export const APPROX_FULL_GRID_COMBOS_PER_FAMILY = 500_000;

/**
 * Max strategy param sets per strategy in one backtest (iterative axis sweeps when < full grid).
 * Set VITE_PARAM_COMBOS_LIMIT. Use 0 or negative for full Cartesian grid (can be ~500k+ per strategy — very slow).
 */
export const DEFAULT_PARAM_COMBOS_LIMIT = _int(ENV.VITE_PARAM_COMBOS_LIMIT, 12);

/** Alias — same as DEFAULT_PARAM_COMBOS_LIMIT */
export const DEFAULT_BACKTEST_PARAM_COMBOS_LIMIT = DEFAULT_PARAM_COMBOS_LIMIT;

/** Research: max regime configs evaluated per instrument (grid). VITE_RESEARCH_REGIME_GRID_MAX */
export const DEFAULT_RESEARCH_REGIME_GRID_MAX = _int(ENV.VITE_RESEARCH_REGIME_GRID_MAX, 9);

/** Research: max strategy param combos per regime when tuning. VITE_RESEARCH_PARAM_TUNE_MAX_STRAT */
export const DEFAULT_RESEARCH_PARAM_TUNE_MAX_STRAT = _int(ENV.VITE_RESEARCH_PARAM_TUNE_MAX_STRAT, 2);

/** Research: max risk param configs per regime. VITE_RESEARCH_PARAM_TUNE_MAX_RISK */
export const DEFAULT_RESEARCH_PARAM_TUNE_MAX_RISK = _int(ENV.VITE_RESEARCH_PARAM_TUNE_MAX_RISK, 6);
