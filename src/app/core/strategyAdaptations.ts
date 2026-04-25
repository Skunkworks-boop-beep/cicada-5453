/**
 * Automatic strategy × instrument adaptations.
 *
 * The hand-curated `STRATEGY_INSTRUMENT_OVERRIDES` map covers ~40 strategies.
 * The other ~196 strategies fall through to bare instrument-type defaults —
 * fine for forex but a poor fit for synthetic indices that move 100x as fast,
 * or for crypto that needs wider stops to survive funding-driven wicks.
 *
 * This module classifies each of the 236 strategies into a *behavioural
 * family* (trend / mean-reversion / breakout / momentum / pattern / candle /
 * volatility) by id heuristic, then derives instrument-aware defaults from
 * the family × instrument-type matrix below. The result is a single
 * `getAdaptiveDefaults(strategyId, instrumentType)` callable that any caller
 * (backtest, build, daemon) can use to get sensible per-(strategy, instrument)
 * stop / risk / reward / preferred-timeframe defaults without manual upkeep.
 *
 * Hand-tuned overrides in `STRATEGY_INSTRUMENT_OVERRIDES` still win — this is
 * a *fallback* layer for strategies that haven't been manually tuned yet.
 */

import type { InstrumentRiskParams } from './instrumentRisk';
import type { Timeframe } from './types';
import type { InstrumentType as TaggedInstrumentType } from './strategyInstrumentConfig';

export type StrategyFamily =
  | 'trend'           // EMA cross, MACD, ADX trend, Ichimoku
  | 'mean_reversion'  // RSI extremes, BB reversion, stochastic, CCI
  | 'breakout'        // Donchian, BB squeeze, ATR breakout, opening range
  | 'momentum'        // ROC, MFI, TSI, MACD-hist, Awesome Osc
  | 'pattern'         // chart patterns: head & shoulders, triangles, flags, fib
  | 'candle'          // candlestick patterns
  | 'price_action'    // ICT/SMC: FVG, BOS, CHoCH, liquidity sweep, order blocks
  | 'volatility'      // ATR, BB walk, Keltner, Supertrend
  | 'mixed';          // unclear; treat as conservative blend

export interface AdaptiveDefaults extends InstrumentRiskParams {
  family: StrategyFamily;
  preferredTimeframes: Timeframe[];
  /** True when this combination is well-suited (used for UI badges). */
  recommended: boolean;
}

const TF_SCALP_DAY: Timeframe[] = ['M1', 'M5', 'M15'];
const TF_DAY: Timeframe[] = ['M15', 'M30', 'H1'];
const TF_DAY_SWING: Timeframe[] = ['H1', 'H4', 'D1'];
const TF_SWING: Timeframe[] = ['H4', 'D1'];
const TF_POSITION: Timeframe[] = ['D1', 'W1'];
const TF_ALL: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];

/**
 * Classify any of the 236 strategy ids into a behavioural family by id pattern.
 * Used as the join key into the family × instrument matrix below.
 */
export function classifyStrategy(strategyId: string): StrategyFamily {
  const id = strategyId.toLowerCase();

  // Indicator strategies have explicit hints in the id. Order matters: more
  // specific patterns (divergence, walk, hist) are checked first so they win
  // over the broader prefix patterns that follow.
  if (id.startsWith('ind-')) {
    if (/(rsi-div|stoch-div|macd-hist-div)/.test(id)) return 'mean_reversion';
    if (/(macd-hist|roc|tsi|awesome|momentum-osc|swing-index|coppock|pvo|nvi|pvi)/.test(id)) return 'momentum';
    if (/bb-walk/.test(id)) return 'volatility';
    if (/(rsi-(over|trend)|bb-reversion|stoch|cci|williams|mfi|cmo|ultimate)/.test(id)) return 'mean_reversion';
    if (/(bb-squeeze|donchian|atr-breakout|keltner|aroon-cross|fractals)/.test(id)) return 'breakout';
    if (/(ema|macd|kst|ichimoku|adx-trend|trix|sar|supertrend|ribbon)/.test(id)) return 'trend';
    if (/(atr|vix|chaikin|vol-burst|garch)/.test(id)) return 'volatility';
    return 'mixed';
  }
  if (id.startsWith('cs-')) return 'candle';
  if (id.startsWith('cp-')) return 'pattern';
  if (id.startsWith('pa-')) return 'price_action';
  return 'mixed';
}

/**
 * Family × instrument adaptation matrix. Each cell holds:
 *   - stop  (fraction of price; tighter for fast-moving synthetics)
 *   - risk  (fraction of equity per trade; smaller for volatile asset classes)
 *   - tpR   (risk:reward target; trend families get a bigger target than reversion)
 *   - tfs   (preferred timeframes; reversion likes shorter, trend likes longer)
 *   - rec   (whether this family is a sensible default for this asset)
 *
 * Sources for the numbers:
 *   - Forex: 1% of price ≈ 100 pips on EUR/USD — typical day-trade stop = 20-40 pips → 0.2-0.4% (we use 2% as a wider safety default).
 *   - Synthetic R_*: average ATR runs 1-3% of price; a 4-5% stop is one daily ATR.
 *   - Crash/Boom: spike instruments — only meaningful via wider 5-7% stops, smaller risk %.
 *   - Crypto: BTC ATR often >2%; wider stops and smaller size.
 *   - Indices: ATR rarely exceeds 1.5%; stops can be tighter than synthetics.
 */
const ADAPTATION_MATRIX: Record<
  StrategyFamily,
  Partial<Record<TaggedInstrumentType, { stop: number; risk: number; tpR: number; tfs: Timeframe[]; rec: boolean }>>
> = {
  trend: {
    fiat:               { stop: 0.020, risk: 0.010, tpR: 2.5, tfs: TF_DAY_SWING, rec: true },
    indices:            { stop: 0.022, risk: 0.008, tpR: 2.5, tfs: TF_DAY_SWING, rec: true },
    crypto:             { stop: 0.040, risk: 0.006, tpR: 2.5, tfs: TF_SWING,    rec: true },
    volatility_deriv:   { stop: 0.045, risk: 0.005, tpR: 2.0, tfs: TF_DAY,      rec: true },
    crash_boom:         { stop: 0.060, risk: 0.004, tpR: 2.0, tfs: TF_DAY,      rec: false },
    step_deriv:         { stop: 0.035, risk: 0.006, tpR: 2.0, tfs: TF_SCALP_DAY,rec: true },
    jump_deriv:         { stop: 0.045, risk: 0.005, tpR: 2.0, tfs: TF_DAY,      rec: false },
    range_break_deriv:  { stop: 0.040, risk: 0.005, tpR: 2.0, tfs: TF_DAY,      rec: false },
    world_deriv:        { stop: 0.030, risk: 0.006, tpR: 2.0, tfs: TF_DAY_SWING,rec: true },
  },
  mean_reversion: {
    fiat:               { stop: 0.015, risk: 0.010, tpR: 1.5, tfs: TF_SCALP_DAY,rec: true },
    indices:            { stop: 0.020, risk: 0.008, tpR: 1.5, tfs: TF_DAY,      rec: true },
    crypto:             { stop: 0.030, risk: 0.006, tpR: 1.5, tfs: TF_DAY,      rec: false },
    volatility_deriv:   { stop: 0.040, risk: 0.005, tpR: 1.5, tfs: TF_SCALP_DAY,rec: true },
    crash_boom:         { stop: 0.060, risk: 0.003, tpR: 1.2, tfs: TF_DAY,      rec: false },
    step_deriv:         { stop: 0.030, risk: 0.006, tpR: 1.5, tfs: TF_SCALP_DAY,rec: true },
    jump_deriv:         { stop: 0.045, risk: 0.004, tpR: 1.3, tfs: TF_DAY,      rec: false },
    range_break_deriv:  { stop: 0.035, risk: 0.005, tpR: 1.5, tfs: TF_DAY,      rec: true },
    world_deriv:        { stop: 0.025, risk: 0.006, tpR: 1.5, tfs: TF_DAY,      rec: true },
  },
  breakout: {
    fiat:               { stop: 0.025, risk: 0.010, tpR: 2.5, tfs: TF_DAY,      rec: true },
    indices:            { stop: 0.025, risk: 0.008, tpR: 2.5, tfs: TF_DAY,      rec: true },
    crypto:             { stop: 0.045, risk: 0.006, tpR: 3.0, tfs: TF_DAY_SWING,rec: true },
    volatility_deriv:   { stop: 0.050, risk: 0.005, tpR: 2.0, tfs: TF_SCALP_DAY,rec: true },
    crash_boom:         { stop: 0.070, risk: 0.004, tpR: 2.5, tfs: TF_SCALP_DAY,rec: true },
    step_deriv:         { stop: 0.040, risk: 0.006, tpR: 2.0, tfs: TF_SCALP_DAY,rec: true },
    jump_deriv:         { stop: 0.060, risk: 0.004, tpR: 2.5, tfs: TF_DAY,      rec: true },
    range_break_deriv:  { stop: 0.035, risk: 0.006, tpR: 2.5, tfs: TF_DAY,      rec: true },
    world_deriv:        { stop: 0.030, risk: 0.006, tpR: 2.0, tfs: TF_DAY,      rec: true },
  },
  momentum: {
    fiat:               { stop: 0.020, risk: 0.010, tpR: 2.0, tfs: TF_DAY,      rec: true },
    indices:            { stop: 0.022, risk: 0.008, tpR: 2.0, tfs: TF_DAY,      rec: true },
    crypto:             { stop: 0.035, risk: 0.006, tpR: 2.0, tfs: TF_DAY,      rec: true },
    volatility_deriv:   { stop: 0.045, risk: 0.005, tpR: 2.0, tfs: TF_DAY,      rec: true },
    crash_boom:         { stop: 0.060, risk: 0.004, tpR: 2.0, tfs: TF_DAY,      rec: false },
    step_deriv:         { stop: 0.035, risk: 0.006, tpR: 2.0, tfs: TF_SCALP_DAY,rec: true },
    jump_deriv:         { stop: 0.045, risk: 0.005, tpR: 2.0, tfs: TF_DAY,      rec: false },
    range_break_deriv:  { stop: 0.035, risk: 0.005, tpR: 2.0, tfs: TF_DAY,      rec: false },
    world_deriv:        { stop: 0.025, risk: 0.006, tpR: 2.0, tfs: TF_DAY,      rec: true },
  },
  pattern: {
    fiat:               { stop: 0.020, risk: 0.010, tpR: 2.0, tfs: TF_DAY_SWING,rec: true },
    indices:            { stop: 0.022, risk: 0.008, tpR: 2.0, tfs: TF_DAY_SWING,rec: true },
    crypto:             { stop: 0.040, risk: 0.006, tpR: 2.0, tfs: TF_SWING,    rec: true },
    volatility_deriv:   { stop: 0.045, risk: 0.005, tpR: 2.0, tfs: TF_DAY,      rec: false },
    crash_boom:         { stop: 0.060, risk: 0.003, tpR: 2.0, tfs: TF_DAY,      rec: false },
    step_deriv:         { stop: 0.035, risk: 0.005, tpR: 1.8, tfs: TF_DAY,      rec: false },
    jump_deriv:         { stop: 0.050, risk: 0.004, tpR: 2.0, tfs: TF_DAY,      rec: false },
    range_break_deriv:  { stop: 0.035, risk: 0.005, tpR: 2.0, tfs: TF_DAY,      rec: false },
    world_deriv:        { stop: 0.025, risk: 0.006, tpR: 2.0, tfs: TF_DAY_SWING,rec: true },
  },
  candle: {
    fiat:               { stop: 0.015, risk: 0.010, tpR: 1.5, tfs: TF_SCALP_DAY,rec: true },
    indices:            { stop: 0.018, risk: 0.008, tpR: 1.5, tfs: TF_DAY,      rec: true },
    crypto:             { stop: 0.030, risk: 0.006, tpR: 1.5, tfs: TF_DAY,      rec: false },
    volatility_deriv:   { stop: 0.035, risk: 0.005, tpR: 1.5, tfs: TF_SCALP_DAY,rec: false },
    crash_boom:         { stop: 0.055, risk: 0.003, tpR: 1.3, tfs: TF_DAY,      rec: false },
    step_deriv:         { stop: 0.025, risk: 0.006, tpR: 1.5, tfs: TF_SCALP_DAY,rec: true },
    jump_deriv:         { stop: 0.040, risk: 0.004, tpR: 1.3, tfs: TF_DAY,      rec: false },
    range_break_deriv:  { stop: 0.030, risk: 0.005, tpR: 1.5, tfs: TF_DAY,      rec: false },
    world_deriv:        { stop: 0.020, risk: 0.006, tpR: 1.5, tfs: TF_DAY,      rec: true },
  },
  price_action: {
    fiat:               { stop: 0.020, risk: 0.010, tpR: 2.0, tfs: TF_DAY,      rec: true },
    indices:            { stop: 0.022, risk: 0.008, tpR: 2.0, tfs: TF_DAY,      rec: true },
    crypto:             { stop: 0.040, risk: 0.006, tpR: 2.0, tfs: TF_DAY,      rec: true },
    volatility_deriv:   { stop: 0.040, risk: 0.005, tpR: 2.0, tfs: TF_DAY,      rec: true },
    crash_boom:         { stop: 0.060, risk: 0.004, tpR: 2.0, tfs: TF_SCALP_DAY,rec: true },
    step_deriv:         { stop: 0.035, risk: 0.006, tpR: 2.0, tfs: TF_SCALP_DAY,rec: true },
    jump_deriv:         { stop: 0.050, risk: 0.005, tpR: 2.0, tfs: TF_DAY,      rec: true },
    range_break_deriv:  { stop: 0.035, risk: 0.005, tpR: 2.0, tfs: TF_DAY,      rec: true },
    world_deriv:        { stop: 0.025, risk: 0.006, tpR: 2.0, tfs: TF_DAY,      rec: true },
  },
  volatility: {
    fiat:               { stop: 0.025, risk: 0.008, tpR: 2.0, tfs: TF_DAY_SWING,rec: true },
    indices:            { stop: 0.028, risk: 0.007, tpR: 2.0, tfs: TF_DAY_SWING,rec: true },
    crypto:             { stop: 0.050, risk: 0.005, tpR: 2.0, tfs: TF_SWING,    rec: true },
    volatility_deriv:   { stop: 0.060, risk: 0.004, tpR: 2.0, tfs: TF_DAY,      rec: true },
    crash_boom:         { stop: 0.080, risk: 0.003, tpR: 2.0, tfs: TF_DAY,      rec: true },
    step_deriv:         { stop: 0.040, risk: 0.005, tpR: 2.0, tfs: TF_SCALP_DAY,rec: true },
    jump_deriv:         { stop: 0.060, risk: 0.004, tpR: 2.0, tfs: TF_DAY,      rec: true },
    range_break_deriv:  { stop: 0.040, risk: 0.005, tpR: 2.0, tfs: TF_DAY,      rec: true },
    world_deriv:        { stop: 0.030, risk: 0.006, tpR: 2.0, tfs: TF_DAY,      rec: true },
  },
  mixed: {
    // Conservative across the board: when we don't know what kind of strategy
    // it is, halve the risk and pick wide stops.
    fiat:               { stop: 0.020, risk: 0.005, tpR: 1.8, tfs: TF_ALL,      rec: false },
    indices:            { stop: 0.025, risk: 0.005, tpR: 1.8, tfs: TF_ALL,      rec: false },
    crypto:             { stop: 0.040, risk: 0.004, tpR: 1.8, tfs: TF_ALL,      rec: false },
    volatility_deriv:   { stop: 0.050, risk: 0.004, tpR: 1.8, tfs: TF_ALL,      rec: false },
    crash_boom:         { stop: 0.070, risk: 0.003, tpR: 1.8, tfs: TF_ALL,      rec: false },
    step_deriv:         { stop: 0.040, risk: 0.005, tpR: 1.8, tfs: TF_ALL,      rec: false },
    jump_deriv:         { stop: 0.055, risk: 0.004, tpR: 1.8, tfs: TF_ALL,      rec: false },
    range_break_deriv:  { stop: 0.040, risk: 0.004, tpR: 1.8, tfs: TF_ALL,      rec: false },
    world_deriv:        { stop: 0.030, risk: 0.005, tpR: 1.8, tfs: TF_ALL,      rec: false },
  },
};

/**
 * Get adaptive defaults for a (strategy, instrument-type) pair. Returns risk
 * params + preferred timeframes + recommendation flag. Use this at:
 *   - Backtest job-config build (to seed `riskPerTradePct`/`stopLossPct`/`takeProfitR`).
 *   - Bot daemon entry sizing (when no NN regression head was trained).
 *   - UI badges ("recommended for this instrument").
 */
export function getAdaptiveDefaults(
  strategyId: string,
  instrumentType: TaggedInstrumentType
): AdaptiveDefaults {
  const family = classifyStrategy(strategyId);
  const cell = ADAPTATION_MATRIX[family]?.[instrumentType] ?? ADAPTATION_MATRIX.mixed.fiat!;
  return {
    family,
    stopLossPct: cell.stop,
    riskPerTradePct: cell.risk,
    takeProfitR: cell.tpR,
    preferredTimeframes: cell.tfs,
    recommended: cell.rec,
  };
}

/**
 * Bulk: produce the full adaptation matrix for every strategy in the registry.
 * Useful for the UI strategy library to render "best for X" badges.
 */
export function buildAdaptationMatrix(
  strategyIds: readonly string[]
): Array<{ strategyId: string; family: StrategyFamily; perInstrument: Record<TaggedInstrumentType, AdaptiveDefaults> }> {
  const types: TaggedInstrumentType[] = [
    'fiat',
    'crypto',
    'indices',
    'volatility_deriv',
    'crash_boom',
    'step_deriv',
    'jump_deriv',
    'range_break_deriv',
    'world_deriv',
  ];
  return strategyIds.map((id) => {
    const family = classifyStrategy(id);
    const perInstrument = {} as Record<TaggedInstrumentType, AdaptiveDefaults>;
    for (const t of types) perInstrument[t] = getAdaptiveDefaults(id, t);
    return { strategyId: id, family, perInstrument };
  });
}
