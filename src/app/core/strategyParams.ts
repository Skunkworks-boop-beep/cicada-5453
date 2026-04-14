/**
 * Strategy parameter optimization: param ranges per strategy family, grid generation.
 * Enables both combinatorial search (instrument × strategy × timeframe × regime)
 * and parameter grid search within each strategy.
 * Industry-grade: Wilder, Appel, Connors, MDPI research, institutional defaults.
 * Expanded for robust research: ~500k combos per family (matches regime scale).
 */

import type { StrategyParams } from './types';

/** Re-export — single source: ./gridConfig.ts (VITE_PARAM_COMBOS_LIMIT, ~500k full-grid docs). */
export {
  APPROX_FULL_GRID_COMBOS_PER_FAMILY,
  DEFAULT_BACKTEST_PARAM_COMBOS_LIMIT,
  DEFAULT_PARAM_COMBOS_LIMIT,
  DEFAULT_RESEARCH_PARAM_TUNE_MAX_RISK,
  DEFAULT_RESEARCH_PARAM_TUNE_MAX_STRAT,
  DEFAULT_RESEARCH_REGIME_GRID_MAX,
} from './gridConfig';

/** Param ranges for grid search. Keys = param name, values = candidate values. */
export type ParamRanges = Record<string, number[]>;

function irange(start: number, stop: number, count: number): number[] {
  if (count <= 1) return count === 1 ? [start] : [];
  const step = (stop - start) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(start + i * step));
}

function frange(start: number, stop: number, count: number, roundDigits = 4): number[] {
  if (count <= 1) return count === 1 ? [start] : [];
  const step = (stop - start) / (count - 1);
  const f = 10 ** roundDigits;
  return Array.from({ length: count }, (_, i) => Math.round((start + i * step) * f) / f);
}

/** Strategy-specific default overrides (non-simplified: each strategy gets correct params). */
export const STRATEGY_DEFAULT_OVERRIDES: Record<string, StrategyParams> = {
  'ind-ema-cross-9-21': { fast: 9, slow: 21 },
  'ind-ema-cross-50-200': { fast: 50, slow: 200 },
  'ind-ema-ribbon': { fast: 8, slow: 55 },
};

/** Strategies that use fixed params (no grid search) — return single config. */
const FIXED_PARAM_STRATEGIES = new Set(['ind-ema-cross-9-21', 'ind-ema-cross-50-200', 'ind-ema-ribbon']);

/** Default param values (Wilder/industry standard). Used when no range defined. */
export const DEFAULT_PARAMS: Record<string, StrategyParams> = {
  rsi: { period: 14, overbought: 70, oversold: 30 },  // Wilder (1978)
  macd: { fast: 12, slow: 26, signal: 9 },  // Appel (1979)
  ema: { fast: 9, slow: 21 },
  bb: { period: 20, stdMult: 2 },
  atr: { period: 14, mult: 1.5 },
  stoch: { kPeriod: 14, dPeriod: 3, overbought: 80, oversold: 20 },
  structure: { lookback: 10, rsiPeriod: 14, bbPeriod: 20, atrPeriod: 14, donchianPeriod: 20 },
  cci: { period: 20 },
  williamsR: { period: 14 },
  roc: { period: 12 },
  adx: { period: 14 },
  keltner: { emaPeriod: 20, atrPeriod: 10, mult: 2 },
  donchian: { period: 20 },
  dpo: { period: 20 },
  trix: { period: 15 },
  candlestick: { bodyPct: 0.1, wickPct: 0.6 },
  mfi: { period: 14, overbought: 80, oversold: 20 },
  vwap: { tolerance: 0.001 },
  vwapBands: { period: 20, stdMult: 2 },
  cmf: { period: 20 },
  cmo: { period: 14, overbought: 50, oversold: -50 },
  tsi: { longPeriod: 25, shortPeriod: 13 },
  ultimateOsc: { overbought: 70, oversold: 30 },
  obv: { lookback: 5 },
  forceIndex: { period: 2 },
  eom: { period: 14 },
  vpt: { lookback: 5 },
  coppock: { roc1: 14, roc2: 11, smooth: 10 },
  nviPvi: { lookback: 5 },
  accumulation: { lookback: 5 },
  pivotPoints: { tolerance: 0.001 },
  camarilla: { tolerance: 0.001 },
  fibPivot: { tolerance: 0.001 },
  zigzag: { thresholdPct: 0.001, tolerance: 0.002 },
  fractals: {},
};

/**
 * Param ranges for strategies that support grid search.
 * ~500k combos per family (matches regime scale). Mirrors backend strategy_params.py.
 */
export const STRATEGY_PARAM_RANGES: Record<string, ParamRanges> = {
  rsi: { period: irange(5, 85, 80), overbought: frange(65, 90, 80, 1), oversold: frange(10, 35, 80, 1) },
  macd: { fast: irange(6, 86, 80), slow: irange(17, 97, 80), signal: irange(7, 87, 80) },
  ema: { fast: irange(6, 714, 708), slow: irange(18, 726, 708) },
  bb: { period: irange(12, 720, 708), stdMult: frange(1.5, 2.5, 708) },
  atr: { period: irange(8, 716, 708), mult: frange(1.25, 2.5, 708) },
  stoch: {
    kPeriod: irange(8, 35, 27),
    dPeriod: irange(3, 30, 27),
    overbought: irange(75, 95, 27),
    oversold: irange(15, 35, 27),
  },
  structure: { lookback: irange(3, 711, 708), donchianPeriod: irange(12, 720, 708) },
  cci: { period: irange(10, 90, 80) },
  williamsR: { period: irange(8, 88, 80) },
  roc: { period: irange(8, 88, 80) },
  adx: { period: irange(10, 90, 80) },
  keltner: { emaPeriod: irange(15, 95, 80), atrPeriod: irange(8, 88, 80), mult: frange(1.5, 2.5, 80) },
  donchian: { period: irange(12, 92, 80) },
  dpo: { period: irange(12, 92, 80) },
  trix: { period: irange(10, 90, 80) },
  candlestick: { bodyPct: frange(0.06, 0.15, 708), wickPct: frange(0.5, 0.7, 708) },
  mfi: { period: irange(10, 90, 80), overbought: irange(75, 95, 80), oversold: irange(15, 35, 80) },
  vwap: { tolerance: frange(0.0003, 0.002, 80) },
  vwapBands: { period: irange(12, 720, 708), stdMult: frange(1.5, 2.5, 708) },
  cmf: { period: irange(10, 90, 80) },
  cmo: { period: irange(8, 88, 80), overbought: irange(45, 60, 80), oversold: frange(-55, -40, 80, 0) },
  tsi: { longPeriod: irange(18, 98, 80), shortPeriod: irange(8, 88, 80) },
  ultimateOsc: { overbought: irange(65, 95, 80), oversold: irange(25, 45, 80) },
  obv: { lookback: irange(3, 83, 80) },
  forceIndex: { period: irange(2, 82, 80) },
  eom: { period: irange(8, 88, 80) },
  vpt: { lookback: irange(3, 83, 80) },
  coppock: { roc1: irange(11, 91, 80), roc2: irange(11, 91, 80), smooth: irange(8, 88, 80) },
  nviPvi: { lookback: irange(3, 83, 80) },
  accumulation: { lookback: irange(3, 83, 80) },
  pivotPoints: { tolerance: frange(0.0003, 0.002, 80) },
  camarilla: { tolerance: frange(0.0003, 0.002, 80) },
  fibPivot: { tolerance: frange(0.0003, 0.002, 80) },
  zigzag: { thresholdPct: frange(0.0003, 0.002, 708), tolerance: frange(0.0008, 0.002, 708) },
  fractals: {},
};

/** Map strategy id to param family for grid search. cp-* and cs-* use prefix match in getParamCombinations. */
export const STRATEGY_TO_PARAM_FAMILY: Record<string, string> = {
  // Chart patterns (cp-*) — structure-based
  'cp-head-shoulders': 'structure',
  'cp-inverse-h-s': 'structure',
  'cp-double-top': 'structure',
  'cp-double-bottom': 'structure',
  'cp-triangle-sym': 'structure',
  'cp-triangle-asc': 'structure',
  'cp-triangle-desc': 'structure',
  'cp-flag-bull': 'structure',
  'cp-flag-bear': 'structure',
  'cp-pennant': 'structure',
  'cp-wedge-rising': 'structure',
  'cp-wedge-falling': 'structure',
  'cp-rectangle': 'structure',
  'cp-channel-up': 'structure',
  'cp-channel-down': 'structure',
  'ind-rsi-div': 'rsi',
  'ind-rsi-overbought': 'rsi',
  'ind-rsi-oversold': 'rsi',
  'ind-rsi-trend': 'rsi',
  'ind-macd-cross': 'macd',
  'ind-macd-hist-div': 'macd',
  'ind-macd-zero': 'macd',
  'ind-ema-ribbon': 'ema',
  'ind-ema-cross-9-21': 'ema',
  'ind-ema-cross-50-200': 'ema',
  'ind-bb-squeeze': 'bb',
  'ind-bb-walk': 'bb',
  'ind-bb-reversion': 'bb',
  'ind-atr-breakout': 'atr',
  'ind-atr-trail': 'atr',
  'ind-stoch-overbought': 'stoch',
  'ind-stoch-oversold': 'stoch',
  'ind-stoch-div': 'stoch',
  'pa-bos': 'structure',
  'pa-breakout-retest': 'structure',
  'pa-liquidity-sweep': 'structure',
  'pa-liquidity-pool': 'structure',
  'pa-inducement': 'structure',
  'pa-stop-hunt': 'structure',
  'ind-cci-overbought': 'cci',
  'ind-cci-oversold': 'cci',
  'ind-williams-r': 'williamsR',
  'ind-mfi': 'mfi',
  'ind-roc': 'roc',
  'ind-adx-trend': 'adx',
  'ind-adx-breakout': 'adx',
  'ind-keltner': 'keltner',
  'ind-donchian': 'donchian',
  'ind-dpo': 'dpo',
  'ind-trix': 'trix',
  'ind-vwap': 'vwap',
  'ind-vwap-bands': 'vwapBands',
  'ind-vwap-anchor': 'vwap',
  'ind-cmf': 'cmf',
  'ind-cmo': 'cmo',
  'ind-tsi': 'tsi',
  'ind-ultimate-osc': 'ultimateOsc',
  'ind-obv-div': 'obv',
  'ind-obv-breakout': 'obv',
  'ind-force-index': 'forceIndex',
  'ind-eom': 'eom',
  'ind-vpt': 'vpt',
  'ind-coppock': 'coppock',
  'ind-nvi-pvi': 'nviPvi',
  'ind-accumulation': 'accumulation',
  'ind-pivot-points': 'pivotPoints',
  'ind-camarilla': 'camarilla',
  'ind-fib-pivot': 'fibPivot',
  'ind-zigzag': 'zigzag',
  'ind-fractals': 'fractals',
};

/**
 * Generate Cartesian product of param ranges. Returns full list of param configs.
 * If family has no ranges or strategy not found, returns single default config.
 */
export function getParamCombinations(strategyId: string): StrategyParams[] {
  if (FIXED_PARAM_STRATEGIES.has(strategyId)) {
    return [getDefaultParams(strategyId)];
  }
  let family = STRATEGY_TO_PARAM_FAMILY[strategyId];
  if (!family && strategyId.startsWith('cp-')) family = 'structure';
  if (!family && strategyId.startsWith('cs-')) family = 'candlestick';
  const ranges = family ? STRATEGY_PARAM_RANGES[family] : null;
  const defaults = family ? DEFAULT_PARAMS[family] ?? {} : {};
  const overrides = STRATEGY_DEFAULT_OVERRIDES[strategyId];

  if (!ranges || Object.keys(ranges).length === 0) {
    return [{ ...defaults, ...overrides }];
  }

  const keys = Object.keys(ranges);
  const values = keys.map((k) => ranges[k]);

  function cartesian<T>(arr: T[][]): T[][] {
    if (arr.length === 0) return [[]];
    const [first, ...rest] = arr;
    const restCombos = cartesian(rest);
    return first.flatMap((v) => restCombos.map((r) => [v, ...r]));
  }

  const combos = cartesian(values);
  const ov = STRATEGY_DEFAULT_OVERRIDES[strategyId];
  return combos.map((vals) => {
    const cfg: StrategyParams = { ...defaults, ...ov };
    keys.forEach((k, i) => { cfg[k] = vals[i]; });
    return cfg;
  });
}

/** Sweep order per family — mirrors python/cicada_nn/strategy_params.py PARAM_KEY_ORDER. */
export const PARAM_KEY_ORDER: Record<string, string[]> = {
  structure: ['lookback', 'donchianPeriod'],
  rsi: ['period', 'overbought', 'oversold'],
  macd: ['fast', 'slow', 'signal'],
  ema: ['fast', 'slow'],
  bb: ['period', 'stdMult'],
  atr: ['period', 'mult'],
  stoch: ['kPeriod', 'dPeriod', 'overbought', 'oversold'],
  cci: ['period'],
  williamsR: ['period'],
  roc: ['period'],
  adx: ['period'],
  keltner: ['emaPeriod', 'atrPeriod', 'mult'],
  donchian: ['period'],
  dpo: ['period'],
  trix: ['period'],
  candlestick: ['bodyPct', 'wickPct'],
  mfi: ['period', 'overbought', 'oversold'],
  vwap: ['tolerance'],
  vwapBands: ['period', 'stdMult'],
  cmf: ['period'],
  cmo: ['period', 'overbought', 'oversold'],
  tsi: ['longPeriod', 'shortPeriod'],
  ultimateOsc: ['overbought', 'oversold'],
  obv: ['lookback'],
  forceIndex: ['period'],
  eom: ['period'],
  vpt: ['lookback'],
  coppock: ['roc1', 'roc2', 'smooth'],
  nviPvi: ['lookback'],
  accumulation: ['lookback'],
  pivotPoints: ['tolerance'],
  camarilla: ['tolerance'],
  fibPivot: ['tolerance'],
  zigzag: ['thresholdPct', 'tolerance'],
};

function orderedKeysForFamily(family: string, rangeKeys: string[]): string[] {
  const order = PARAM_KEY_ORDER[family];
  if (!order) return rangeKeys;
  const first = order.filter((k) => rangeKeys.includes(k));
  const rest = rangeKeys.filter((k) => !first.includes(k));
  return [...first, ...rest];
}

function evenlySpacedIndices(n: number, count: number): number[] {
  if (count <= 0 || n <= 0) return [];
  if (count >= n) return Array.from({ length: n }, (_, i) => i);
  if (count === 1) return [Math.floor(n / 2)];
  const idxs: number[] = [];
  for (let i = 0; i < count; i++) {
    idxs.push(Math.min(Math.round((i * (n - 1)) / (count - 1)), n - 1));
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (const i of idxs) {
    if (!seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
  return out;
}

function buildIterativeParamSets(
  keys: string[],
  ranges: ParamRanges,
  defaults: StrategyParams,
  maxCombinations: number
): StrategyParams[] {
  const out: StrategyParams[] = [];
  const seen = new Set<string>();
  const addCfg = (cfg: StrategyParams) => {
    const key = JSON.stringify(
      Object.keys(cfg)
        .sort()
        .map((k) => [k, cfg[k]])
    );
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ ...cfg });
    }
  };
  addCfg({ ...defaults });
  if (maxCombinations <= 1) return out;

  const budget = maxCombinations - 1;
  const nKeys = keys.length;
  if (nKeys === 0) return out;

  const slotsPer = Array(nKeys).fill(Math.floor(budget / nKeys));
  for (let i = 0; i < budget % nKeys; i++) slotsPer[i] += 1;

  for (let ki = 0; ki < keys.length; ki++) {
    const key = keys[ki];
    const vals = ranges[key];
    if (!vals?.length) continue;
    const want = slotsPer[ki];
    const idxs = evenlySpacedIndices(vals.length, Math.min(want, vals.length));
    for (const idx of idxs) {
      if (out.length >= maxCombinations) break;
      const cfg = { ...defaults, [key]: vals[idx] };
      addCfg(cfg);
    }
    if (out.length >= maxCombinations) break;
  }
  return out.slice(0, maxCombinations);
}

/**
 * Param grid for backtest: family defaults when max=1; full grid when max<=0 or grid is small;
 * otherwise **iterative axis sweeps** — first sweep defaults, then evenly spaced values along `lookback`
 * (and other keys in PARAM_KEY_ORDER), one dimension at a time with others at defaults.
 * Mirrors Python `get_param_combinations` (not random Cartesian subsampling).
 */
export function getParamCombinationsLimited(
  strategyId: string,
  maxCombinations: number
): StrategyParams[] {
  if (FIXED_PARAM_STRATEGIES.has(strategyId)) {
    return [getDefaultParams(strategyId)];
  }
  let family = STRATEGY_TO_PARAM_FAMILY[strategyId];
  if (!family && strategyId.startsWith('cp-')) family = 'structure';
  if (!family && strategyId.startsWith('cs-')) family = 'candlestick';
  const ranges = family ? STRATEGY_PARAM_RANGES[family] : null;
  if (!ranges || Object.keys(ranges).length === 0) {
    return [getDefaultParams(strategyId)];
  }
  const defaults = getDefaultParams(strategyId);
  const keys = orderedKeysForFamily(family, Object.keys(ranges));

  let total = 1;
  for (const k of keys) {
    total *= Math.max(1, ranges[k]?.length ?? 0);
  }

  if (maxCombinations <= 0 || total <= maxCombinations) {
    return getParamCombinations(strategyId);
  }
  if (maxCombinations === 1) {
    return [defaults];
  }
  return buildIterativeParamSets(keys, ranges, defaults, maxCombinations);
}

/** Get default params for a strategy (single config, no grid). */
export function getDefaultParams(strategyId: string): StrategyParams {
  let family = STRATEGY_TO_PARAM_FAMILY[strategyId];
  if (!family && strategyId.startsWith('cp-')) family = 'structure';
  if (!family && strategyId.startsWith('cs-')) family = 'candlestick';
  const defaults = family ? DEFAULT_PARAMS[family] ?? {} : {};
  const overrides = STRATEGY_DEFAULT_OVERRIDES[strategyId];
  return { ...defaults, ...overrides };
}
