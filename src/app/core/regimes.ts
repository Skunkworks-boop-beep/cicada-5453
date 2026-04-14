/**
 * Market regime detection from OHLCV and indicators.
 *
 * Method: custom rule-based (not HMM). Uses:
 * - Trend strength: linear regression slope over closes (lookback).
 * - Volatility: ATR(14) as % of price (high vol → volatile, low vol + weak trend → consolidation).
 * - Momentum: RSI(14) for overbought/oversold (reversal_bear / reversal_bull).
 *
 * Mislabeled regimes hurt NN training. When confidence is below REGIME_CONFIDENCE_MIN,
 * we return 'unknown' so backtest/training do not attribute performance to a wrong regime.
 */

import type { MarketRegime, RegimeState } from './types';
import type { OHLCVBar } from './ohlcv';
import { atr, donchian, linearRegressionSlope, rsi } from './indicators';

export const ALL_REGIMES: MarketRegime[] = [
  'trending_bull',
  'trending_bear',
  'ranging',
  'reversal_bull',
  'reversal_bear',
  'volatile',
  'breakout',
  'consolidation',
  'unknown',
  /** Bypass regime filter — enter whenever strategy signals. Produces non-zero results when regime-specific jobs show $0. */
  'any',
];

/** Below this confidence we label regime as 'unknown' to avoid mislabeling. */
export const REGIME_CONFIDENCE_MIN = 0.55;

export function getRegimeLabel(regime: MarketRegime): string {
  if (regime === 'any') return 'Any (no filter)';
  const labels: Record<Exclude<MarketRegime, 'any'>, string> = {
    trending_bull: 'Trending Bull',
    trending_bear: 'Trending Bear',
    ranging: 'Ranging',
    reversal_bull: 'Reversal Bull',
    reversal_bear: 'Reversal Bear',
    volatile: 'Volatile',
    breakout: 'Breakout',
    consolidation: 'Consolidation',
    unknown: 'Unknown',
  };
  return labels[regime] ?? regime;
}

const TREND_THRESHOLD = 0.00015;
const VOLATILITY_PCT_THRESHOLD_HIGH = 0.02;
const VOLATILITY_PCT_THRESHOLD_LOW = 0.004;
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;
const DONCHIAN_BOUNDARY_FRAC = 0.998;

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Compute confidence from distance from decision boundary.
 * clarity in [0,1]: 0 = at boundary, 1 = far from boundary.
 * Returns confidence in [REGIME_CONFIDENCE_MIN, 0.95].
 */
function confidenceFromClarity(clarity: number): number {
  return REGIME_CONFIDENCE_MIN + (0.95 - REGIME_CONFIDENCE_MIN) * clamp(clarity, 0, 1);
}

/**
 * Detect current regime from OHLCV series using trend strength (linear regression slope),
 * volatility (ATR as % of price), and momentum (RSI). Returns regime and confidence.
 * Confidence is computed dynamically from distance of signals from decision boundaries.
 */
export function detectRegime(bars: OHLCVBar[], lookback: number = 50): RegimeState {
  if (!Number.isFinite(lookback) || lookback <= 0 || !bars.length || bars.length < lookback) {
    return {
      regime: 'unknown',
      confidence: 0,
      trendStrength: 0,
      volatilityPercent: 0,
      momentum: 0,
      detectedAt: new Date().toISOString(),
    };
  }
  const slice = bars.slice(-lookback);
  const closes = slice.map((b) => b.close);
  const price = closes[closes.length - 1] ?? 0;

  const slopes = linearRegressionSlope(closes, Math.min(20, lookback));
  const slopeRaw = slopes[slopes.length - 1] ?? 0;
  const trendStrength = price > 0 ? slopeRaw / price : 0;

  const atrSeries = atr(slice, 14);
  const atrVal = atrSeries[atrSeries.length - 1];
  const volatilityPercent = price > 0 && atrVal != null ? atrVal / price : 0;

  const rsiSeries = rsi(closes, 14);
  const rsiVal = rsiSeries[rsiSeries.length - 1];
  const momentum = rsiVal != null ? (rsiVal - 50) / 50 : 0;

  const { upper, lower } = donchian(slice, 20);
  const u = upper[upper.length - 1];
  const l = lower[lower.length - 1];
  const range = u != null && l != null && u > l ? u - l : 0;
  const mid = u != null && l != null ? (u + l) / 2 : price;

  let regime: MarketRegime = 'unknown';
  let confidence = 0.5;

  if (volatilityPercent >= VOLATILITY_PCT_THRESHOLD_HIGH) {
    regime = 'volatile';
    const clarity = (volatilityPercent - VOLATILITY_PCT_THRESHOLD_HIGH) / VOLATILITY_PCT_THRESHOLD_HIGH;
    confidence = confidenceFromClarity(clarity);
  } else if (volatilityPercent <= VOLATILITY_PCT_THRESHOLD_LOW && Math.abs(trendStrength) < TREND_THRESHOLD) {
    const uBound = u != null ? u * DONCHIAN_BOUNDARY_FRAC : 0;
    const lBound = l != null ? l * (2 - DONCHIAN_BOUNDARY_FRAC) : 0;
    const atUpperBound = u != null && price >= uBound;
    const atLowerBound = l != null && price <= lBound;
    if (atUpperBound || atLowerBound) {
      regime = 'breakout';
      const denom = atUpperBound && u != null ? u - uBound : (l != null ? lBound - l : 0);
      const priceExcess = atUpperBound && u != null ? (price - uBound) / denom : (l != null ? (lBound - price) / denom : 0);
      const clarity = denom > 0 && Number.isFinite(priceExcess) ? clamp(priceExcess, 0, 1) : 0.5;
      confidence = confidenceFromClarity(clarity);
    } else {
      regime = 'consolidation';
      const volClarity = 1 - volatilityPercent / VOLATILITY_PCT_THRESHOLD_LOW;
      const trendClarity = 1 - Math.abs(trendStrength) / TREND_THRESHOLD;
      const clarity = (volClarity + trendClarity) / 2;
      confidence = confidenceFromClarity(clarity);
    }
  } else if (trendStrength > TREND_THRESHOLD) {
    if (rsiVal != null && rsiVal >= RSI_OVERBOUGHT) {
      regime = 'reversal_bear';
      const clarity = (rsiVal - RSI_OVERBOUGHT) / (100 - RSI_OVERBOUGHT);
      confidence = confidenceFromClarity(clarity);
    } else {
      regime = 'trending_bull';
      const clarity = (trendStrength - TREND_THRESHOLD) / TREND_THRESHOLD;
      confidence = confidenceFromClarity(clarity);
    }
  } else if (trendStrength < -TREND_THRESHOLD) {
    if (rsiVal != null && rsiVal <= RSI_OVERSOLD) {
      regime = 'reversal_bull';
      const clarity = (RSI_OVERSOLD - rsiVal) / RSI_OVERSOLD;
      confidence = confidenceFromClarity(clarity);
    } else {
      regime = 'trending_bear';
      const clarity = (Math.abs(trendStrength) - TREND_THRESHOLD) / TREND_THRESHOLD;
      confidence = confidenceFromClarity(clarity);
    }
  } else {
    if (u != null && l != null && price > 0 && range > 0) {
      const uBound = u * DONCHIAN_BOUNDARY_FRAC;
      const lBound = l * (2 - DONCHIAN_BOUNDARY_FRAC);
      if (price >= uBound) {
        regime = 'breakout';
        const clarity = (price - uBound) / (u - uBound);
        confidence = confidenceFromClarity(clarity);
      } else if (price <= lBound) {
        regime = 'breakout';
        const clarity = (lBound - price) / (lBound - l);
        confidence = confidenceFromClarity(clarity);
      } else {
        regime = 'ranging';
        const distFromCenter = (2 * Math.abs(price - mid)) / range;
        const clarity = 1 - distFromCenter;
        confidence = confidenceFromClarity(clarity);
      }
    } else {
      regime = 'ranging';
      confidence = REGIME_CONFIDENCE_MIN;
    }
  }

  if (confidence < REGIME_CONFIDENCE_MIN) {
    regime = 'unknown';
    confidence = 0.5;
  }

  return {
    regime,
    confidence,
    trendStrength,
    volatilityPercent,
    momentum,
    detectedAt: new Date().toISOString(),
  };
}

/**
 * Classify regime for a full series at each bar (for backtest). Uses same logic as detectRegime on rolling window.
 */
export function detectRegimeSeries(bars: OHLCVBar[], lookback: number = 50): RegimeState[] {
  if (!Number.isFinite(lookback) || lookback <= 0) {
    return bars.map(() => ({
      regime: 'unknown' as const,
      confidence: 0,
      trendStrength: 0,
      volatilityPercent: 0,
      momentum: 0,
      detectedAt: new Date().toISOString(),
    }));
  }
  const result: RegimeState[] = [];
  for (let i = 0; i < bars.length; i++) {
    const window = bars.slice(Math.max(0, i - lookback), i + 1);
    result.push(detectRegime(window, lookback));
  }
  return result;
}
