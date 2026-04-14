/**
 * Instrument-specific configuration for each strategy.
 * Maps strategy + instrument type to risk overrides, suitability, and preferred settings.
 * Use for backtest, build, and live trading to apply instrument-appropriate config.
 */

import type { InstrumentRiskParams } from './instrumentRisk';
import { getAllStrategies } from './registries';

/** Instrument type derived from symbol (aligns with registries and instrumentRisk). */
export type InstrumentType =
  | 'volatility_deriv'   // R_10, R_25, R_50, R_75, R_100
  | 'crash_boom'         // CRASH*, BOOM*
  | 'step_deriv'         // 1HZ*
  | 'jump_deriv'         // jump_*
  | 'range_break_deriv'  // range_break_*
  | 'world_deriv'        // WLD*
  | 'fiat'               // forex pairs
  | 'crypto'             // BTC/USD, etc.
  | 'indices'            // US30, AUS200, etc.
  | 'unknown';           // unmatched symbol — no inference; use conservative defaults

/** Per-strategy, per-instrument overrides (risk, stop, target). Merged with instrument defaults. */
export interface StrategyInstrumentOverrides extends Partial<InstrumentRiskParams> {
  /** Preferred timeframes for this strategy+instrument (optional filter). */
  preferredTimeframes?: string[];
  /** Whether this strategy is recommended for this instrument type. */
  recommended?: boolean;
}

/** Instrument type patterns (order matters: first match wins). */
const INSTRUMENT_TYPE_PATTERNS: Array<{ pattern: RegExp; type: InstrumentType }> = [
  { pattern: /^R_\d+$/i, type: 'volatility_deriv' },
  { pattern: /^CRASH|^BOOM/i, type: 'crash_boom' },
  { pattern: /^1HZ/i, type: 'step_deriv' },
  { pattern: /^JUMP_/i, type: 'jump_deriv' },
  { pattern: /^RANGE_BREAK/i, type: 'range_break_deriv' },
  { pattern: /^WLD/i, type: 'world_deriv' },
  { pattern: /^(US|AU|EU|UK|DE|JP|CH|STOXX|NAS|USTEC|HK)\d{2,3}$|^[A-Z]{2,4}\d{2,}$/i, type: 'indices' },
  { pattern: /\/USD|\/EUR|\/GBP|\/JPY|\/CHF|\/AUD|\/CAD|\/NZD/i, type: 'fiat' },
  { pattern: /^(BTC|ETH|SOL|XRP|DOGE)\//i, type: 'crypto' },
];

/** Default risk params per instrument type (used when no strategy-specific override). */
const INSTRUMENT_TYPE_RISK: Record<InstrumentType, InstrumentRiskParams> = {
  volatility_deriv: { stopLossPct: 0.04, riskPerTradePct: 0.005, takeProfitR: 1.5 },
  crash_boom: { stopLossPct: 0.05, riskPerTradePct: 0.005, takeProfitR: 1.5 },
  step_deriv: { stopLossPct: 0.035, riskPerTradePct: 0.006, takeProfitR: 1.5 },
  jump_deriv: { stopLossPct: 0.035, riskPerTradePct: 0.006, takeProfitR: 1.5 },
  range_break_deriv: { stopLossPct: 0.035, riskPerTradePct: 0.006, takeProfitR: 1.5 },
  world_deriv: { stopLossPct: 0.04, riskPerTradePct: 0.005, takeProfitR: 1.5 },
  fiat: { stopLossPct: 0.02, riskPerTradePct: 0.01, takeProfitR: 2 },
  crypto: { stopLossPct: 0.03, riskPerTradePct: 0.008, takeProfitR: 1.5 },
  indices: { stopLossPct: 0.025, riskPerTradePct: 0.008, takeProfitR: 2 },
  unknown: { stopLossPct: 0.02, riskPerTradePct: 0.005, takeProfitR: 1.5 }, // conservative when symbol unmatched
};

/**
 * Infer instrument type from symbol.
 * Unknown symbols: log and return 'unknown' — no inference; use conservative defaults.
 */
export function getInstrumentType(symbol: string): InstrumentType {
  const sym = symbol.toUpperCase().replace(/\s+/g, '');
  for (const { pattern, type } of INSTRUMENT_TYPE_PATTERNS) {
    if (pattern.test(sym)) return type;
  }
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(`[strategyInstrumentConfig] Unknown symbol "${symbol}" — no inference; using conservative defaults`);
  }
  return 'unknown';
}

/**
 * Strategy + instrument overrides.
 * Keys: strategyId. Values: per-instrument-type overrides.
 * Strategies not listed use instrument-type defaults only.
 */
const STRATEGY_INSTRUMENT_OVERRIDES: Record<string, Partial<Record<InstrumentType, StrategyInstrumentOverrides>>> = {
  // ─── Volatility (R_*) — oscillators, squeeze, structure work well ───
  'ind-rsi-oversold': {
    volatility_deriv: { recommended: true, stopLossPct: 0.045, riskPerTradePct: 0.005, takeProfitR: 1.5 },
    crash_boom: { recommended: false },
  },
  'ind-rsi-overbought': {
    volatility_deriv: { recommended: true, stopLossPct: 0.045, riskPerTradePct: 0.005, takeProfitR: 1.5 },
    crash_boom: { recommended: false },
  },
  'ind-bb-squeeze': {
    volatility_deriv: { recommended: true, stopLossPct: 0.04, riskPerTradePct: 0.005, takeProfitR: 1.5 },
    crash_boom: { recommended: false },
  },
  'ind-bb-reversion': {
    volatility_deriv: { recommended: true },
    crash_boom: { recommended: false },
  },
  'ind-stoch-oversold': { volatility_deriv: { recommended: true } },
  'ind-stoch-overbought': { volatility_deriv: { recommended: true } },
  'ind-cci-oversold': { volatility_deriv: { recommended: true } },
  'ind-cci-overbought': { volatility_deriv: { recommended: true } },
  'ind-mfi': { volatility_deriv: { recommended: true } },
  'ind-cmo': { volatility_deriv: { recommended: true } },
  'ind-ultimate-osc': { volatility_deriv: { recommended: true } },
  'ind-williams-r': { volatility_deriv: { recommended: true } },
  'ind-atr-breakout': {
    volatility_deriv: { recommended: true, stopLossPct: 0.05, riskPerTradePct: 0.005 },
    crash_boom: { recommended: true, stopLossPct: 0.06, riskPerTradePct: 0.004 },
  },
  'ind-donchian': {
    volatility_deriv: { recommended: true },
    crash_boom: { recommended: true, stopLossPct: 0.06 },
  },
  'ind-keltner': { volatility_deriv: { recommended: true } },
  'ind-fractals': { volatility_deriv: { recommended: true } },

  // ─── Price action — ICT / structure; good for volatility ───
  'pa-fvg': {
    volatility_deriv: { recommended: true, preferredTimeframes: ['M5', 'M15', 'H1'] },
    crash_boom: { recommended: true, stopLossPct: 0.06, preferredTimeframes: ['M1', 'M5'] },
  },
  'pa-bos': { volatility_deriv: { recommended: true } },
  'pa-liquidity-sweep': {
    volatility_deriv: { recommended: true, stopLossPct: 0.045 },
    crash_boom: { recommended: true, stopLossPct: 0.06 },
  },
  'pa-breakout-retest': {
    volatility_deriv: { recommended: true },
    crash_boom: { recommended: true },
  },
  'pa-order-block-bull': { volatility_deriv: { recommended: true } },
  'pa-order-block-bear': { volatility_deriv: { recommended: true } },
  'pa-choch': { volatility_deriv: { recommended: true } },
  'pa-confluence-zone': { volatility_deriv: { recommended: true } },
  'pa-squeeze-momentum': {
    volatility_deriv: { recommended: true },
    crash_boom: { recommended: true },
  },
  'pa-tight-consolidation': { volatility_deriv: { recommended: true } },
  'pa-range-expansion': { volatility_deriv: { recommended: true }, crash_boom: { recommended: true } },
  'pa-opening-range': {
    volatility_deriv: { recommended: true, preferredTimeframes: ['M5', 'M15'] },
    crash_boom: { recommended: true, preferredTimeframes: ['M1', 'M5'] },
  },

  // ─── Chart patterns — need structure; better for forex/indices ───
  'cp-fib-retracement': {
    volatility_deriv: { recommended: true },
    fiat: { recommended: true },
    indices: { recommended: true },
  },
  'cp-double-top': { fiat: { recommended: true }, indices: { recommended: true } },
  'cp-double-bottom': { fiat: { recommended: true }, indices: { recommended: true } },
  'cp-flag-bull': { volatility_deriv: { recommended: true }, fiat: { recommended: true } },
  'cp-flag-bear': { volatility_deriv: { recommended: true }, fiat: { recommended: true } },
  'cp-pennant': { volatility_deriv: { recommended: true } },
  'cp-inside-bar': {
    volatility_deriv: { recommended: true, preferredTimeframes: ['M5', 'M15'] },
    fiat: { recommended: true },
  },
  'cp-outside-bar': { volatility_deriv: { recommended: true } },

  // ─── Candlestick — work across instruments ───
  'cs-engulfing-bull': { volatility_deriv: { recommended: true }, fiat: { recommended: true } },
  'cs-engulfing-bear': { volatility_deriv: { recommended: true }, fiat: { recommended: true } },
  'cs-pin-bar-bull': { volatility_deriv: { recommended: true } },
  'cs-pin-bar-bear': { volatility_deriv: { recommended: true } },
  'cs-hammer': { volatility_deriv: { recommended: true } },
  'cs-doji': { volatility_deriv: { recommended: true } },

  // ─── Trend — better for forex/indices; wider stops for volatility ───
  'ind-ema-ribbon': {
    fiat: { recommended: true },
    indices: { recommended: true },
    volatility_deriv: { stopLossPct: 0.05, riskPerTradePct: 0.004 },
  },
  'ind-macd-cross': {
    fiat: { recommended: true },
    indices: { recommended: true },
    volatility_deriv: { stopLossPct: 0.05, preferredTimeframes: ['M15', 'H1', 'H4'] },
  },
  'ind-adx-trend': { fiat: { recommended: true }, indices: { recommended: true } },
  'ind-bb-walk': { fiat: { recommended: true }, volatility_deriv: { stopLossPct: 0.05 } },

  // ─── Crash/Boom — only breakout/volatile strategies ───
  'pa-fakeout': { crash_boom: { recommended: true, stopLossPct: 0.06 } },
  'pa-exhaustion': { crash_boom: { recommended: true } },
  'pa-capitulation': { crash_boom: { recommended: true, stopLossPct: 0.07 } },
  'ind-swing-index': { crash_boom: { recommended: true } },
};

/**
 * Get instrument-specific config for a strategy.
 * Returns merged risk params (strategy override > instrument type default > fallback).
 */
export function getStrategyInstrumentConfig(
  strategyId: string,
  instrumentSymbol: string
): StrategyInstrumentOverrides & InstrumentRiskParams {
  const instType = getInstrumentType(instrumentSymbol);
  const typeRisk = INSTRUMENT_TYPE_RISK[instType];
  const strategyOverrides = STRATEGY_INSTRUMENT_OVERRIDES[strategyId]?.[instType];

  const base: InstrumentRiskParams = {
    stopLossPct: strategyOverrides?.stopLossPct ?? typeRisk.stopLossPct,
    riskPerTradePct: strategyOverrides?.riskPerTradePct ?? typeRisk.riskPerTradePct,
    takeProfitR: strategyOverrides?.takeProfitR ?? typeRisk.takeProfitR,
  };

  return {
    ...base,
    recommended: strategyOverrides?.recommended ?? true,
    preferredTimeframes: strategyOverrides?.preferredTimeframes,
  };
}

/**
 * Get risk params for strategy + instrument (for backtest/build).
 * Use this when you need InstrumentRiskParams specifically.
 */
export function getStrategyInstrumentRisk(
  strategyId: string,
  instrumentSymbol: string
): InstrumentRiskParams {
  const cfg = getStrategyInstrumentConfig(strategyId, instrumentSymbol);
  return {
    stopLossPct: cfg.stopLossPct,
    riskPerTradePct: cfg.riskPerTradePct,
    takeProfitR: cfg.takeProfitR,
  };
}

/** Human-readable labels for instrument types (for hover/tooltips). */
const INSTRUMENT_TYPE_LABELS: Record<InstrumentType, string> = {
  volatility_deriv: 'Volatility (R_10, R_25, R_50…)',
  crash_boom: 'Crash/Boom',
  step_deriv: 'Step (1HZ)',
  jump_deriv: 'Jump',
  range_break_deriv: 'Range Break',
  world_deriv: 'World indices',
  fiat: 'Forex',
  crypto: 'Crypto',
  indices: 'Indices (US30, AUS200…)',
  unknown: 'Unknown (unmatched symbol)',
};

/**
 * Get human-readable list of instrument types where this strategy is best applied.
 * Used for strategy hover tooltips.
 */
export function getStrategyBestApplied(strategyId: string): string[] {
  const overrides = STRATEGY_INSTRUMENT_OVERRIDES[strategyId];
  if (!overrides) return ['All instruments'];
  const recommended: string[] = [];
  const notRecommended: InstrumentType[] = [];
  for (const [type, cfg] of Object.entries(overrides) as [InstrumentType, StrategyInstrumentOverrides][]) {
    if (cfg?.recommended === true) recommended.push(INSTRUMENT_TYPE_LABELS[type]);
    else if (cfg?.recommended === false) notRecommended.push(type);
  }
  if (recommended.length === 0 && notRecommended.length === 0) return ['All instruments'];
  if (recommended.length === 0) return ['General purpose (excludes ' + notRecommended.map((t) => INSTRUMENT_TYPE_LABELS[t]).join(', ') + ')'];
  return recommended;
}

/**
 * Check if a strategy is recommended for an instrument type.
 */
export function isStrategyRecommendedForInstrument(strategyId: string, instrumentSymbol: string): boolean {
  const cfg = getStrategyInstrumentConfig(strategyId, instrumentSymbol);
  return cfg.recommended !== false;
}

/**
 * Get all strategies recommended for an instrument.
 */
export function getRecommendedStrategiesForInstrument(instrumentSymbol: string): string[] {
  const strategies = getAllStrategies();
  return strategies
    .filter((s) => isStrategyRecommendedForInstrument(s.id, instrumentSymbol))
    .map((s) => s.id);
}

/**
 * Build job risk overrides from grid research paramTunes.
 * Prefers OOS profit when available (research ranks by OOS); falls back to sharpeInSample.
 * Skips param tunes with negative OOS profit when we have at least one with positive OOS.
 * Key format: "instrumentId|strategyId|timeframe" when timeframe present, else "instrumentId|strategyId".
 */
export function buildJobRiskOverridesFromParamTunes(
  paramTunes: Array<{
    instrumentId: string;
    strategyId: string;
    timeframe?: string;
    sharpeInSample?: number;
    profitOOS?: number;
    tradesOOS?: number;
    riskParams: { stopLossPct: number; riskPerTradePct: number; takeProfitR: number };
  }>
): Record<string, InstrumentRiskParams> {
  const byKey = new Map<string, { profitOOS: number; tradesOOS: number; sharpe: number; risk: InstrumentRiskParams }>();
  for (const t of paramTunes) {
    const key = t.timeframe ? `${t.instrumentId}|${t.strategyId}|${t.timeframe}` : `${t.instrumentId}|${t.strategyId}`;
    const profitOOS = t.profitOOS ?? -Infinity;
    const tradesOOS = t.tradesOOS ?? 0;
    const sharpe = t.sharpeInSample ?? 0;
    const existing = byKey.get(key);
    const isBetter =
      !existing ||
      (profitOOS > existing.profitOOS) ||
      (profitOOS === existing.profitOOS && tradesOOS > existing.tradesOOS) ||
      (profitOOS === existing.profitOOS && tradesOOS === existing.tradesOOS && sharpe > existing.sharpe);
    if (isBetter) {
      byKey.set(key, { profitOOS, tradesOOS, sharpe, risk: t.riskParams });
    }
  }
  // When best tune has negative OOS profit, skip override — use defaults instead (avoids applying losing configs)
  const filtered = Array.from(byKey.entries()).filter(([, v]) => v.profitOOS > 0 || (v.profitOOS === -Infinity && v.sharpe > 0));
  return Object.fromEntries(filtered.map(([k, v]) => [k, v.risk]));
}

/**
 * Build per-job risk overrides for backtest.
 * Key format: "instrumentId|strategyId" for job-level overrides.
 * Backend checks this key first, then falls back to instrumentId-only.
 */
export function buildJobRiskOverrides(
  strategyIds: string[],
  instrumentIds: string[],
  instrumentSymbols: Record<string, string>
): Record<string, InstrumentRiskParams> {
  const out: Record<string, InstrumentRiskParams> = {};
  for (const instId of instrumentIds) {
    const symbol = instrumentSymbols[instId] ?? instId;
    for (const strategyId of strategyIds) {
      const key = `${instId}|${strategyId}`;
      out[key] = getStrategyInstrumentRisk(strategyId, symbol);
    }
  }
  return out;
}
