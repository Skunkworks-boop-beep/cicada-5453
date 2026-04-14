/**
 * Strategy signal generation from OHLCV and indicators.
 *
 * Flow: Strategy library (registries) → getAllStrategies() → backtest uses strategyIds
 * → runSingleBacktest(strategyId, strategyParams) → getSignalFn(strategyId, params) → signal per bar (1 / -1 / 0).
 *
 * Each strategy id maps to a signal function. Params enable grid search (RSI period, MACD fast/slow, etc.).
 */

import type { OHLCVBar } from './ohlcv';
import type { RegimeState, StrategyParams, Timeframe } from './types';
import { safeDiv } from './mathUtils';
import { rsi, macd, ema, atr, bollingerBands, stochastic, cci, williamsR, roc, adx, keltner, donchian, awesomeOscillator, acceleratorOscillator, dpo, trix, mfi, vwap, vwapBands, cmf, cmo, tsi, ultimateOscillator, obv, forceIndex, eom, vpt, coppock, nvi, pvi, accumulationDistribution, pivotPoints, camarillaPivots, fibPivot, zigzag, fractals, kst, pvo, swingIndex, supertrend, parabolicSar, ichimoku, alligator, gatorOscillator } from './indicators';
import {
  detectFvg,
  detectLiquiditySweep,
  detectLiquidityPool,
  detectInducement,
  detectStopHunt,
  detectBos,
  detectBreakoutRetest,
  detectOrderBlock,
  detectDoubleTop,
  detectDoubleBottom,
  detectTripleTop,
  detectTripleBottom,
  detectHhHl,
  detectLhLl,
  detectHeadAndShoulders,
  detectInverseHeadAndShoulders,
  detectCupAndHandle,
  detectInverseCupAndHandle,
  detectBroadening,
  detectWedgeRising,
  detectWedgeFalling,
  detectDiamond,
  detectRoundingBottom,
  detectRoundingTop,
  detectInsideBar,
  detectOutsideBar,
  detectKeyReversal,
  detectIslandReversal,
  detectChannelUp,
  detectChannelDown,
  detectFibRetracement,
  detectTriangleSymmetric,
  detectTriangleAscending,
  detectTriangleDescending,
  detectFlagBull,
  detectFlagBear,
  detectPennant,
  detectRectangle,
  detectGapUp,
  detectGapDown,
  detectRisingWindow,
  detectFallingWindow,
  detectBumpAndRun,
  detectFakeout,
  detectEqualHighsLows,
  detectSrFlip,
  detectTrendlineBreak,
  detectGapFill,
  detectSwingFailure,
  detectTurtleSoup,
  detectExhaustion,
  detectCapitulation,
  detectNewsSpike,
  detectCloseBeyond,
  detectTightConsolidation,
  detectAbsorption,
  detectOpeningRange,
  detectAsianRange,
  detectScalpBreak,
  detectChoch,
  detectStructureBreak,
  detectSwingHighLow,
  detectElliottAbc,
  detectElliottImpulse,
  detectFanLines,
  detectAscendingBroadening,
  detectDescendingBroadening,
  detectHarmonicGartley,
  detectHarmonicBat,
  detectHarmonicButterfly,
  detectHarmonicCrab,
  detectHarmonicShark,
  detectCypher,
  detectThreeDrives,
} from './patternDetection';
import {
  signalEngulfingBull,
  signalEngulfingBear,
  signalHammer,
  signalInvertedHammer,
  signalHangingMan,
  signalShootingStar,
  signalMorningStar,
  signalEveningStar,
  signalDoji,
  signalDragonflyDoji,
  signalGravestoneDoji,
  signalPinBarBull,
  signalPinBarBear,
  signalThreeSoldiers,
  signalThreeCrows,
  signalThreeWhiteCrows,
  signalAdvanceBlock,
  signalDeliberation,
  signalTwoCrows,
  signalThreeInside,
  signalThreeOutside,
  signalAbandonedBabyBull,
  signalAbandonedBabyBear,
  signalKickingBull,
  signalKickingBear,
  signalLadderBottom,
  signalMatHold,
  signalRisingThree,
  signalFallingThree,
  signalTasukiGapUp,
  signalTasukiGapDown,
  signalOnNeck,
  signalInNeck,
  signalThrusting,
  signalStickSandwich,
  signalThreeStarsSouth,
  signalTriStar,
  signalIdenticalThreeCrows,
  signalMorningDojiStar,
  signalEveningDojiStar,
  signalHaramiBull,
  signalHaramiBear,
  signalHaramiCrossBull,
  signalHaramiCrossBear,
  signalPiercing,
  signalDarkCloud,
  signalTweezerTop,
  signalTweezerBottom,
  signalMarubozuWhite,
  signalMarubozuBlack,
  signalSpinningTopBull,
  signalSpinningTopBear,
  signalHighWave,
  signalBeltHoldBull,
  signalBeltHoldBear,
  signalBreakawayBull,
  signalBreakawayBear,
  signalConcealingBaby,
  signalUniqueThreeRiver,
  signalTwoRabbits,
  signalThreeLineStrikeBull,
  signalThreeLineStrikeBear,
  signalThreeRiverBull,
  signalNorthernDoji,
  signalSouthernDoji,
} from './candlestickSignals';

export type Signal = 1 | -1 | 0;

/**
 * Optional multi-timeframe context: real HTF series + per-LTF-bar index into HTF.
 * When absent, HTF-style strategies fall back to single-series EMA proxy (legacy).
 */
export interface SignalContext {
  htfBars?: OHLCVBar[];
  /** htfIndexByLtfBar[i] = HTF bar index for LTF bar i, or -1. */
  htfIndexByLtfBar?: Int32Array;
  htfTimeframe?: Timeframe;
  ltfTimeframe?: Timeframe;
}

/**
 * Signal generator signature: (bars, regimeAtBar, barIndex, params?, ctx?) => signal.
 * params: optional strategy params for grid search (period, overbought, etc.).
 */
export type SignalFn = (
  bars: OHLCVBar[],
  regimeAtBar: RegimeState | null,
  barIndex: number,
  params?: StrategyParams,
  ctx?: SignalContext
) => Signal;

const closes = (bars: OHLCVBar[]) => bars.map((b) => b.close);

const p = (params: StrategyParams | undefined, key: string, def: number) =>
  (params && params[key] != null) ? params[key] : def;

/** RSI oversold/overbought with regime filter. Params: period, overbought, oversold. */
export const signalRsi: SignalFn = (bars, regime, i, params) => {
  const period = p(params, 'period', 14);
  const ob = p(params, 'overbought', 70);
  const os = p(params, 'oversold', 30);
  const c = closes(bars);
  const series = rsi(c, period);
  const v = series[i];
  if (v == null) return 0;
  if (regime?.regime === 'reversal_bull' || regime?.regime === 'trending_bear') {
    if (v <= os) return 1;
    if (v >= ob) return -1;
  } else if (regime?.regime === 'reversal_bear' || regime?.regime === 'trending_bull') {
    if (v >= ob) return -1;
    if (v <= os) return 1;
  } else {
    if (v <= os) return 1;
    if (v >= ob) return -1;
  }
  return 0;
};

/** RSI divergence: price higher high + RSI lower high = bearish; price lower low + RSI higher low = bullish. */
export const signalRsiDiv: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 14);
  const lookback = p(params, 'lookback', 10);
  if (period < 1 || lookback < 2 || i < period + lookback + 2) return 0;
  const c = closes(bars);
  const series = rsi(c, period);
  const v = series[i];
  if (v == null) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  const priceHighs = slice.map((b) => b.high);
  const priceLows = slice.map((b) => b.low);
  const rsiSlice = series.slice(i - lookback, i + 1);
  const mid = Math.floor(lookback / 2);
  const pH1Arr = priceHighs.slice(0, mid);
  const pH2Arr = priceHighs.slice(mid);
  if (pH1Arr.length === 0 || pH2Arr.length === 0) return 0;
  const pH1 = Math.max(...pH1Arr);
  const pH2 = Math.max(...pH2Arr);
  const pL1Arr = priceLows.slice(0, mid);
  const pL2Arr = priceLows.slice(mid);
  if (pL1Arr.length === 0 || pL2Arr.length === 0) return 0;
  const pL1 = Math.min(...pL1Arr);
  const pL2 = Math.min(...pL2Arr);
  const rH1Arr = rsiSlice.slice(0, mid).filter((x): x is number => x != null);
  const rH2Arr = rsiSlice.slice(mid).filter((x): x is number => x != null);
  const rL1Arr = rsiSlice.slice(0, mid).filter((x): x is number => x != null);
  const rL2Arr = rsiSlice.slice(mid).filter((x): x is number => x != null);
  if (rH1Arr.length === 0 || rH2Arr.length === 0 || rL1Arr.length === 0 || rL2Arr.length === 0) return 0;
  const rH1 = Math.max(...rH1Arr);
  const rH2 = Math.max(...rH2Arr);
  const rL1 = Math.min(...rL1Arr);
  const rL2 = Math.min(...rL2Arr);
  if (pH2 > pH1 && rH2 < rH1 && bars[i].close < bars[i].open) return -1;
  if (pL2 < pL1 && rL2 > rL1 && bars[i].close > bars[i].open) return 1;
  return 0;
};

/** RSI overbought: cross below 70 with bearish candle = short. */
export const signalRsiOverbought: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 14);
  const ob = p(params, 'overbought', 70);
  if (i < period + 2) return 0;
  const c = closes(bars);
  const series = rsi(c, period);
  const prev = series[i - 1];
  const curr = series[i];
  if (prev == null || curr == null) return 0;
  if (prev >= ob && curr < ob && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** RSI oversold: cross above 30 with bullish candle = long. */
export const signalRsiOversold: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 14);
  const os = p(params, 'oversold', 30);
  if (i < period + 2) return 0;
  const c = closes(bars);
  const series = rsi(c, period);
  const prev = series[i - 1];
  const curr = series[i];
  if (prev == null || curr == null) return 0;
  if (prev <= os && curr > os && bars[i].close > bars[i].open) return 1;
  return 0;
};

/** RSI trend filter: only long when RSI > 40; only short when RSI < 60. Uses Donchian breakout for direction. */
export const signalRsiTrend: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 14);
  const donchianPeriod = p(params, 'donchianPeriod', 20);
  if (i < Math.max(period, donchianPeriod) + 2) return 0;
  const c = closes(bars);
  const series = rsi(c, period);
  const v = series[i];
  const { upper, lower } = donchian(bars, donchianPeriod);
  const u = upper[i];
  const l = lower[i];
  if (v == null || u == null || l == null) return 0;
  const cur = c[i] ?? 0;
  if (cur >= u * 0.998 && v > 40) return 1;
  if (cur <= l * 1.002 && v < 60) return -1;
  return 0;
};

/** MACD crossover. Params: fast, slow, signal. */
export const signalMacd: SignalFn = (bars, _, i, params) => {
  const fast = p(params, 'fast', 12);
  const slow = p(params, 'slow', 26);
  const sig = p(params, 'signal', 9);
  if (i < Math.max(35, slow + sig)) return 0;
  const c = closes(bars);
  const { macd: m, signal: s } = macd(c, fast, slow, sig);
  const prevM = m[i - 1], prevS = s[i - 1];
  const currM = m[i], currS = s[i];
  if (prevM == null || prevS == null || currM == null || currS == null) return 0;
  if (prevM <= prevS && currM > currS) return 1;
  if (prevM >= prevS && currM < currS) return -1;
  return 0;
};

/** MACD histogram divergence: price higher high + hist lower high = bearish; price lower low + hist higher low = bullish. */
export const signalMacdHistDiv: SignalFn = (bars, _, i, params) => {
  const fast = p(params, 'fast', 12);
  const slow = p(params, 'slow', 26);
  const sig = p(params, 'signal', 9);
  const lookback = p(params, 'lookback', 10);
  if (lookback < 2 || i < Math.max(35, slow + sig) + lookback) return 0;
  const c = closes(bars);
  const { histogram: h } = macd(c, fast, slow, sig);
  const mid = Math.floor(lookback / 2);
  const pH1Slice = bars.slice(i - lookback, i - mid).map((b) => b.high);
  const pH2Slice = bars.slice(i - mid, i + 1).map((b) => b.high);
  const pL1Slice = bars.slice(i - lookback, i - mid).map((b) => b.low);
  const pL2Slice = bars.slice(i - mid, i + 1).map((b) => b.low);
  if (pH1Slice.length === 0 || pH2Slice.length === 0 || pL1Slice.length === 0 || pL2Slice.length === 0) return 0;
  const pH1 = Math.max(...pH1Slice);
  const pH2 = Math.max(...pH2Slice);
  const pL1 = Math.min(...pL1Slice);
  const pL2 = Math.min(...pL2Slice);
  const histVals = (start: number, end: number) => h.slice(start, end).filter((x): x is number => x != null);
  const v1 = histVals(i - lookback, i - mid);
  const v2 = histVals(i - mid, i + 1);
  if (v1.length === 0 || v2.length === 0) return 0;
  const hH1 = Math.max(...v1);
  const hH2 = Math.max(...v2);
  const hL1 = Math.min(...v1);
  const hL2 = Math.min(...v2);
  if (pH2 > pH1 && hH2 < hH1 && bars[i].close < bars[i].open) return -1;
  if (pL2 < pL1 && hL2 > hL1 && bars[i].close > bars[i].open) return 1;
  return 0;
};

/** MACD zero line rejection: MACD bounces at zero in trend. Cross above zero = long; cross below = short. */
export const signalMacdZero: SignalFn = (bars, _, i, params) => {
  const fast = p(params, 'fast', 12);
  const slow = p(params, 'slow', 26);
  const sig = p(params, 'signal', 9);
  if (i < Math.max(35, slow + sig) + 2) return 0;
  const c = closes(bars);
  const { macd: m } = macd(c, fast, slow, sig);
  const prev = m[i - 1];
  const curr = m[i];
  if (prev == null || curr == null) return 0;
  if (prev <= 0 && curr > 0 && bars[i].close > bars[i].open) return 1;
  if (prev >= 0 && curr < 0 && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** EMA crossover. Params: fast, slow. */
export const signalEmaCross: SignalFn = (bars, _, i, params) => {
  const fastP = p(params, 'fast', 9);
  const slowP = p(params, 'slow', 21);
  if (i < slowP) return 0;
  const c = closes(bars);
  const fast = ema(c, fastP);
  const slow = ema(c, slowP);
  const pF = fast[i - 1], pS = slow[i - 1];
  const nF = fast[i], nS = slow[i];
  if (pF == null || pS == null || nF == null || nS == null) return 0;
  if (pF <= pS && nF > nS) return 1;
  if (pF >= pS && nF < nS) return -1;
  return 0;
};

/** EMA ribbon: multiple EMAs (8,13,21,34,55) in order; price above/below ribbon. */
export const signalEmaRibbon: SignalFn = (bars, _, i, params) => {
  const periods = [8, 13, 21, 34, 55];
  const maxP = Math.max(...periods);
  if (i < maxP) return 0;
  const c = closes(bars);
  const emas = periods.map((p) => ema(c, p));
  const vals = emas.map((e) => e[i]);
  if (vals.some((v) => v == null)) return 0;
  const ordered = vals.every((v, j) => j === 0 || (vals[j - 1] != null && v! >= vals[j - 1]!));
  const orderedDown = vals.every((v, j) => j === 0 || (vals[j - 1] != null && v! <= vals[j - 1]!));
  const price = c[i] ?? 0;
  const top = vals[vals.length - 1]!;
  const bot = vals[0]!;
  if (ordered && price > top && bars[i].close > bars[i].open) return 1;
  if (orderedDown && price < bot && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Bollinger band touch (mean reversion). Params: period, stdMult. */
export const signalBB: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 20);
  const stdMult = p(params, 'stdMult', 2);
  if (i < period) return 0;
  const c = closes(bars);
  const { upper, lower } = bollingerBands(c, period, stdMult);
  const price = c[i];
  const u = upper[i], l = lower[i];
  if (u == null || l == null) return 0;
  if (price >= u) return -1;
  if (price <= l) return 1;
  return 0;
};

/** BB Squeeze: narrow bands (BB inside Keltner) then expansion breakout. */
export const signalBBSqueeze: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 20);
  const stdMult = p(params, 'stdMult', 2);
  const keltnerMult = p(params, 'keltnerMult', 2);
  if (i < period + 5) return 0;
  const c = closes(bars);
  const { upper: bbU, lower: bbL } = bollingerBands(c, period, stdMult);
  const { upper: kU, lower: kL } = keltner(bars, period, 10, keltnerMult);
  const prevSqueeze = (bbU[i - 1] ?? 0) < (kU[i - 1] ?? Infinity) && (bbL[i - 1] ?? 0) > (kL[i - 1] ?? -Infinity);
  const currBreak = (bbU[i] ?? 0) >= (kU[i] ?? 0) || (bbL[i] ?? 0) <= (kL[i] ?? 0);
  if (!prevSqueeze || !currBreak) return 0;
  const price = c[i] ?? 0;
  const mid = (bbU[i]! + bbL[i]!) / 2;
  if (price > mid && bars[i].close > bars[i].open) return 1;
  if (price < mid && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** BB Walk: price walks upper band in uptrend (touch upper, continuation) or lower in downtrend. */
export const signalBBWalk: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 20);
  const stdMult = p(params, 'stdMult', 2);
  const lookback = p(params, 'lookback', 5);
  if (lookback <= 0 || i < period + lookback) return 0;
  const c = closes(bars);
  const { upper, lower } = bollingerBands(c, period, stdMult);
  const price = c[i];
  const u = upper[i], l = lower[i];
  if (u == null || l == null) return 0;
  const prevSlice = c.slice(i - lookback, i);
  if (prevSlice.length === 0) return 0;
  const prevHigh = Math.max(...prevSlice);
  const prevLow = Math.min(...prevSlice);
  const tol = (u - l) * 0.02;
  const first = c.slice(Math.max(0, i - lookback * 2), i - lookback);
  const uptrend = first.length > 0 && prevHigh > Math.max(...first);
  const downtrend = first.length > 0 && prevLow < Math.min(...first);
  if (price >= u - tol && price <= u + tol && uptrend && bars[i].close > bars[i].open) return 1;
  if (price >= l - tol && price <= l + tol && downtrend && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** BB Reversion: mean reversion at band. Entry at band, target middle. */
export const signalBBReversion: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 20);
  const stdMult = p(params, 'stdMult', 2);
  if (i < period) return 0;
  const c = closes(bars);
  const { upper, lower, middle } = bollingerBands(c, period, stdMult);
  const price = c[i];
  const u = upper[i], l = lower[i], m = middle[i];
  if (u == null || l == null || m == null) return 0;
  if (price >= u * 0.998 && bars[i].close < bars[i].open) return -1;
  if (price <= l * 1.002 && bars[i].close > bars[i].open) return 1;
  return 0;
};

/**
 * Price structure + regime-specific logic. Trades all regimes objectively for structured filter.
 * Params: lookback, rsiPeriod, bbPeriod, atrPeriod, donchianPeriod.
 */
export const signalStructure: SignalFn = (bars, regime, i, params) => {
  const lookback = p(params, 'lookback', 5);
  const rsiPeriod = p(params, 'rsiPeriod', 14);
  const bbPeriod = p(params, 'bbPeriod', 20);
  const atrPeriod = p(params, 'atrPeriod', 14);
  const donchianPeriod = p(params, 'donchianPeriod', 20);
  const atrMult = p(params, 'atrMult', 1.5);
  if (lookback <= 0 || i < Math.max(lookback + 1, bbPeriod, atrPeriod, donchianPeriod, rsiPeriod) + 2) return 0;
  const c = closes(bars);
  const cur = c[i];
  const prevSlice = c.slice(i - lookback, i);
  if (prevSlice.length === 0) return 0;
  const prevHigh = Math.max(...prevSlice);
  const prevLow = Math.min(...prevSlice);
  const r = regime?.regime ?? 'unknown';

  // trending_bull: higher high → long
  if (r === 'trending_bull' && cur > prevHigh) return 1;
  // trending_bear: lower low → short
  if (r === 'trending_bear' && cur < prevLow) return -1;

  // ranging: BB mean reversion — upper band → short, lower band → long
  if (r === 'ranging') {
    const { upper, lower } = bollingerBands(c, bbPeriod, 2);
    const u = upper[i], l = lower[i];
    if (u != null && l != null) {
      if (cur >= u * 0.998) return -1;
      if (cur <= l * 1.002) return 1;
    }
  }

  // reversal_bull: RSI oversold → long
  if (r === 'reversal_bull') {
    const rsiSeries = rsi(c, rsiPeriod);
    const v = rsiSeries[i];
    if (v != null && v <= 30) return 1;
  }
  // reversal_bear: RSI overbought → short
  if (r === 'reversal_bear') {
    const rsiSeries = rsi(c, rsiPeriod);
    const v = rsiSeries[i];
    if (v != null && v >= 70) return -1;
  }

  // volatile: ATR breakout — big range bar, direction of close
  if (r === 'volatile') {
    const atrSeries = atr(bars, atrPeriod);
    const a = atrSeries[i];
    if (a != null) {
      const range = bars[i].high - bars[i].low;
      if (range > a * atrMult) return bars[i].close > bars[i].open ? 1 : -1;
    }
  }

  // breakout: Donchian break — upper → long, lower → short
  if (r === 'breakout') {
    const { upper, lower } = donchian(bars, donchianPeriod);
    const u = upper[i], l = lower[i];
    if (u != null && l != null) {
      if (cur >= u * 0.998) return 1;
      if (cur <= l * 1.002) return -1;
    }
  }

  // consolidation: narrow range then break — use Donchian
  if (r === 'consolidation') {
    const atrSeries = atr(bars, atrPeriod);
    const a = atrSeries[i];
    const price = c[i] ?? 0;
    const volPct = price > 0 && a != null ? a / price : 0;
    if (volPct < 0.008) {
      const { upper, lower } = donchian(bars, donchianPeriod);
      const u = upper[i], l = lower[i];
      if (u != null && l != null) {
        if (cur >= u * 0.998) return 1;
        if (cur <= l * 1.002) return -1;
      }
    }
  }

  // unknown: trend continuation (higher high / lower low)
  if (r === 'unknown') {
    if (cur > prevHigh) return 1;
    if (cur < prevLow) return -1;
  }

  return 0;
};

/** ATR trailing stop: price crosses ATR trail from below (long) or above (short). */
export const signalAtrTrail: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 14);
  const mult = p(params, 'mult', 2);
  if (i < period + 4) return 0;
  const atrSeries = atr(bars, period);
  const a = atrSeries[i];
  if (a == null) return 0;
  const prevBars = bars.slice(i - 3, i);
  if (prevBars.length === 0) return 0;
  const prevLow = Math.min(...prevBars.map((b) => b.low));
  const prevHigh = Math.max(...prevBars.map((b) => b.high));
  const trailLong = prevLow - a * mult;
  const trailShort = prevHigh + a * mult;
  const cur = bars[i].close;
  const prev = bars[i - 1].close;
  if (prev <= trailLong && cur > trailLong && bars[i].close > bars[i].open) return 1;
  if (prev >= trailShort && cur < trailShort && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** ATR breakout (volatility expansion). Params: period, mult. */
export const signalAtrBreakout: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 14);
  const mult = p(params, 'mult', 1.5);
  if (i < period + 5) return 0;
  const atrSeries = atr(bars, period);
  const a = atrSeries[i];
  if (a == null) return 0;
  const range = bars[i].high - bars[i].low;
  const prevClose = bars[i - 1].close;
  if (range > a * mult && bars[i].close > prevClose) return 1;
  if (range > a * mult && bars[i].close < prevClose) return -1;
  return 0;
};

/** Range expansion: narrow range (consolidation) then expansion bar; direction from close. */
export const signalRangeExpansion: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 14);
  const mult = p(params, 'mult', 1.5);
  const consolBars = p(params, 'consolBars', 5);
  if (i < period + consolBars + 1 || consolBars <= 0) return 0;
  const atrSeries = atr(bars, period);
  const a = atrSeries[i];
  if (a == null) return 0;
  const prevRanges = bars.slice(i - consolBars, i).map((b) => b.high - b.low);
  if (prevRanges.length === 0) return 0;
  const avgPrevRange = prevRanges.reduce((s, r) => s + r, 0) / prevRanges.length;
  const curRange = bars[i].high - bars[i].low;
  if (avgPrevRange >= a * 0.8 || curRange <= a * mult) return 0;
  if (bars[i].close > bars[i].open) return 1;
  if (bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Momentum shift: prior trend (HH/HL or LH/LL) reverses with expansion. */
export const signalMomentumShift: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 5);
  const atrPeriod = p(params, 'atrPeriod', 14);
  if (lookback <= 0 || i < lookback * 2 + atrPeriod) return 0;
  const hh = detectHhHl(bars, i - 1, lookback);
  const lh = detectLhLl(bars, i - 1, lookback);
  const atrSeries = atr(bars, atrPeriod);
  const a = atrSeries[i];
  if (a == null) return 0;
  const curRange = bars[i].high - bars[i].low;
  if (curRange < a * 1.2) return 0;
  if (hh === 1 && bars[i].close < bars[i].open) return -1;
  if (lh === -1 && bars[i].close > bars[i].open) return 1;
  return 0;
};

/** Stochastic overbought: %K was >= overbought, crosses below %D. Bearish. */
export const signalStochOverbought: SignalFn = (bars, _, i, params) => {
  const kPeriod = p(params, 'kPeriod', 14);
  const dPeriod = p(params, 'dPeriod', 3);
  const ob = p(params, 'overbought', 80);
  if (i < kPeriod + dPeriod) return 0;
  const { k, d } = stochastic(bars, kPeriod, dPeriod);
  const kCur = k[i], dCur = d[i], kPrev = k[i - 1];
  if (kCur == null || dCur == null || kPrev == null) return 0;
  if (kPrev >= ob && kCur < dCur) return -1;
  return 0;
};

/** Stochastic oversold: %K was <= oversold, crosses above %D. Bullish. */
export const signalStochOversold: SignalFn = (bars, _, i, params) => {
  const kPeriod = p(params, 'kPeriod', 14);
  const dPeriod = p(params, 'dPeriod', 3);
  const os = p(params, 'oversold', 20);
  if (i < kPeriod + dPeriod) return 0;
  const { k, d } = stochastic(bars, kPeriod, dPeriod);
  const kCur = k[i], dCur = d[i], kPrev = k[i - 1];
  if (kCur == null || dCur == null || kPrev == null) return 0;
  if (kPrev <= os && kCur > dCur) return 1;
  return 0;
};

/** Stochastic divergence: price higher high + stoch lower high = bearish; price lower low + stoch higher low = bullish. */
export const signalStochDiv: SignalFn = (bars, _, i, params) => {
  const kPeriod = p(params, 'kPeriod', 14);
  const dPeriod = p(params, 'dPeriod', 3);
  const lookback = p(params, 'lookback', 10);
  if (lookback < 2 || i < kPeriod + dPeriod + lookback) return 0;
  const { k } = stochastic(bars, kPeriod, dPeriod);
  const slice = bars.slice(i - lookback, i + 1);
  const priceHighs = slice.map((b) => b.high);
  const priceLows = slice.map((b) => b.low);
  const kSlice = k.slice(i - lookback, i + 1).filter((x): x is number => x != null);
  const mid = Math.floor(lookback / 2);
  const pH1Arr = priceHighs.slice(0, mid);
  const pH2Arr = priceHighs.slice(mid);
  const pL1Arr = priceLows.slice(0, mid);
  const pL2Arr = priceLows.slice(mid);
  const k1 = kSlice.slice(0, mid);
  const k2 = kSlice.slice(mid);
  if (k1.length === 0 || k2.length === 0 || pH1Arr.length === 0 || pH2Arr.length === 0 || pL1Arr.length === 0 || pL2Arr.length === 0) return 0;
  const pH1 = Math.max(...pH1Arr);
  const pH2 = Math.max(...pH2Arr);
  const pL1 = Math.min(...pL1Arr);
  const pL2 = Math.min(...pL2Arr);
  const kH1 = Math.max(...k1);
  const kH2 = Math.max(...k2);
  const kL1 = Math.min(...k1);
  const kL2 = Math.min(...k2);
  if (pH2 > pH1 && kH2 < kH1 && bars[i].close < bars[i].open) return -1;
  if (pL2 < pL1 && kL2 > kL1 && bars[i].close > bars[i].open) return 1;
  return 0;
};

/** Stochastic: overbought cross down = short, oversold cross up = long. Dedicated logic (no proxy). */
export const signalStoch: SignalFn = (bars, _, i, params) => {
  const kPeriod = p(params, 'kPeriod', 14);
  const dPeriod = p(params, 'dPeriod', 3);
  const ob = p(params, 'overbought', 80);
  const os = p(params, 'oversold', 20);
  if (i < kPeriod + dPeriod) return 0;
  const { k, d } = stochastic(bars, kPeriod, dPeriod);
  const kCur = k[i], dCur = d[i], kPrev = k[i - 1];
  if (kCur == null || dCur == null || kPrev == null) return 0;
  if (kPrev >= ob && kCur < dCur && bars[i].close < bars[i].open) return -1;
  if (kPrev <= os && kCur > dCur && bars[i].close > bars[i].open) return 1;
  return 0;
};

/**
 * Candlestick-based signal (cs-* strategies). Detects engulfing, hammer/inverted hammer,
 * doji, pin bar from OHLC of current and previous bar(s). No params (pattern-based).
 */
export const signalCandlestick: SignalFn = (bars, _regime, i) => {
  if (i < 2) return 0;
  const cur = bars[i];
  const prev = bars[i - 1];
  const o = cur.open;
  const h = cur.high;
  const l = cur.low;
  const c = cur.close;
  const body = Math.abs(c - o);
  const range = h - l;
  const upperWick = range > 0 ? (h - Math.max(o, c)) / range : 0;
  const lowerWick = range > 0 ? (Math.min(o, c) - l) / range : 0;
  const bodyPct = range > 0 ? body / range : 0;

  // Doji: very small body
  if (bodyPct < 0.1) {
    if (lowerWick > 0.6) return 1;
    if (upperWick > 0.6) return -1;
    return 0;
  }

  // Bullish engulfing: current green body engulfs previous red
  const prevBody = Math.abs(prev.close - prev.open);
  if (c > o && prev.close < prev.open && c > prev.open && o < prev.close && body > prevBody * 1.1) return 1;
  // Bearish engulfing
  if (c < o && prev.close > prev.open && c < prev.open && o > prev.close && body > prevBody * 1.1) return -1;

  // Hammer (long lower wick, small body at top): bullish at support
  if (lowerWick >= 0.6 && bodyPct <= 0.3 && upperWick < 0.2) return 1;
  // Inverted hammer / shooting star (long upper wick): bearish at resistance
  if (upperWick >= 0.6 && bodyPct <= 0.3 && lowerWick < 0.2) return -1;

  // Pin bar: long single wick
  if (lowerWick >= 0.65 && bodyPct <= 0.35) return 1;
  if (upperWick >= 0.65 && bodyPct <= 0.35) return -1;

  return 0;
};

/** CCI overbought: cross below 100 with bearish candle. */
export const signalCciOverbought: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 20);
  const ob = p(params, 'overbought', 100);
  if (i < period + 1) return 0;
  const series = cci(bars, period);
  const prev = series[i - 1];
  const curr = series[i];
  if (prev == null || curr == null) return 0;
  if (prev >= ob && curr < ob && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** CCI oversold: cross above -100 with bullish candle. */
export const signalCciOversold: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 20);
  const os = p(params, 'oversold', -100);
  if (i < period + 1) return 0;
  const series = cci(bars, period);
  const prev = series[i - 1];
  const curr = series[i];
  if (prev == null || curr == null) return 0;
  if (prev <= os && curr > os && bars[i].close > bars[i].open) return 1;
  return 0;
};

/** CCI: overbought cross below 100 = short, oversold cross above -100 = long. Dedicated logic (no proxy). */
export const signalCci: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 20);
  const ob = p(params, 'overbought', 100);
  const os = p(params, 'oversold', -100);
  if (i < period + 1) return 0;
  const series = cci(bars, period);
  const prev = series[i - 1];
  const curr = series[i];
  if (prev == null || curr == null) return 0;
  if (prev >= ob && curr < ob && bars[i].close < bars[i].open) return -1;
  if (prev <= os && curr > os && bars[i].close > bars[i].open) return 1;
  return 0;
};

/** Money Flow Index: volume-weighted RSI. Params: period, overbought, oversold. */
export const signalMfi: SignalFn = (bars, regime, i, params) => {
  const period = p(params, 'period', 14);
  const ob = p(params, 'overbought', 80);
  const os = p(params, 'oversold', 20);
  if (i < period) return 0;
  const series = mfi(bars, period);
  const v = series[i];
  if (v == null) return 0;
  if (regime?.regime === 'reversal_bull' || regime?.regime === 'trending_bear') {
    if (v <= os) return 1;
    if (v >= ob) return -1;
  } else if (regime?.regime === 'reversal_bear' || regime?.regime === 'trending_bull') {
    if (v >= ob) return -1;
    if (v <= os) return 1;
  } else {
    if (v <= os) return 1;
    if (v >= ob) return -1;
  }
  return 0;
};

/** Williams %R. Params: period. -20 overbought, -80 oversold. */
export const signalWilliamsR: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 14);
  if (i < period) return 0;
  const series = williamsR(bars, period);
  const v = series[i];
  if (v == null) return 0;
  if (v >= -20) return -1;
  if (v <= -80) return 1;
  return 0;
};

/** ROC zero-line cross. Params: period. */
export const signalRoc: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 12);
  if (i < period + 1) return 0;
  const c = closes(bars);
  const series = roc(c, period);
  const v = series[i];
  const prev = series[i - 1];
  if (v == null || prev == null) return 0;
  if (prev < 0 && v > 0) return 1;
  if (prev > 0 && v < 0) return -1;
  return 0;
};

/** ADX trend: ADX > 25, +DI > -DI = long, -DI > +DI = short. Params: period. */
export const signalAdx: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 14);
  if (i < period * 2) return 0;
  const { adx: adxVal, plusDi, minusDi } = adx(bars, period);
  const a = adxVal[i];
  const pDi = plusDi[i];
  const mDi = minusDi[i];
  if (a == null || pDi == null || mDi == null) return 0;
  if (a < 25) return 0;
  if (pDi > mDi) return 1;
  if (mDi > pDi) return -1;
  return 0;
};

/** ADX breakout: ADX crosses above 20 from below + price break. New trend start. */
export const signalAdxBreakout: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 14);
  const threshold = p(params, 'adxThreshold', 20);
  if (i < period * 2 + 2) return 0;
  const { adx: adxVal, plusDi, minusDi } = adx(bars, period);
  const a = adxVal[i];
  const aPrev = adxVal[i - 1];
  const pDi = plusDi[i];
  const mDi = minusDi[i];
  if (a == null || aPrev == null || pDi == null || mDi == null) return 0;
  if (aPrev < threshold && a >= threshold) {
    const c = closes(bars);
    const cur = c[i] ?? 0;
    const adxPrevSlice = c.slice(i - 5, i);
    if (adxPrevSlice.length === 0) return 0;
    const prevHigh = Math.max(...adxPrevSlice);
    const prevLow = Math.min(...adxPrevSlice);
    if (pDi > mDi && cur > prevHigh && bars[i].close > bars[i].open) return 1;
    if (mDi > pDi && cur < prevLow && bars[i].close < bars[i].open) return -1;
  }
  return 0;
};

/** Accelerator Oscillator: AC = AO - SMA(AO,5). Zero-line cross. */
export const signalAc: SignalFn = (bars, _, i) => {
  if (i < 40) return 0;
  const series = acceleratorOscillator(bars);
  const v = series[i];
  const prev = series[i - 1];
  if (v == null || prev == null) return 0;
  if (prev < 0 && v > 0) return 1;
  if (prev > 0 && v < 0) return -1;
  return 0;
};

/** Keltner: band touch mean reversion. Params: emaPeriod, atrPeriod, mult. */
export const signalKeltner: SignalFn = (bars, _, i, params) => {
  const emaP = p(params, 'emaPeriod', 20);
  const atrP = p(params, 'atrPeriod', 10);
  const mult = p(params, 'mult', 2);
  if (i < emaP + atrP) return 0;
  const { upper, lower } = keltner(bars, emaP, atrP, mult);
  const price = bars[i].close;
  const u = upper[i], l = lower[i];
  if (u == null || l == null) return 0;
  if (price >= u) return -1;
  if (price <= l) return 1;
  return 0;
};

/** Donchian breakout. Params: period. */
export const signalDonchian: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 20);
  if (i < period) return 0;
  const { upper, lower } = donchian(bars, period);
  const price = bars[i].close;
  const u = upper[i], l = lower[i];
  if (u == null || l == null) return 0;
  if (price >= u) return 1;
  if (price <= l) return -1;
  return 0;
};

/** Awesome Oscillator zero-line cross. */
export const signalAo: SignalFn = (bars, _, i) => {
  if (i < 35) return 0;
  const series = awesomeOscillator(bars);
  const v = series[i];
  const prev = series[i - 1];
  if (v == null || prev == null) return 0;
  if (prev < 0 && v > 0) return 1;
  if (prev > 0 && v < 0) return -1;
  return 0;
};

/** DPO zero-line cross. Params: period. */
export const signalDpo: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 20);
  const c = closes(bars);
  const series = dpo(c, period);
  const v = series[i];
  const prev = series[i - 1];
  if (v == null || prev == null) return 0;
  if (prev < 0 && v > 0) return 1;
  if (prev > 0 && v < 0) return -1;
  return 0;
};

/** TRIX zero-line cross. Params: period. */
export const signalTrix: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 15);
  if (i < period * 3 + 2) return 0;
  const c = closes(bars);
  const series = trix(c, period);
  const v = series[i];
  const prev = series[i - 1];
  if (v == null || prev == null) return 0;
  if (prev < 0 && v > 0) return 1;
  if (prev > 0 && v < 0) return -1;
  return 0;
};

/** KST: Know Sure Thing. Signal line cross. */
export const signalKst: SignalFn = (bars, _, i) => {
  if (i < 55) return 0;
  const c = closes(bars);
  const { kst: kstLine, signal } = kst(c);
  const k = kstLine[i], s = signal[i];
  const kPrev = kstLine[i - 1], sPrev = signal[i - 1];
  if (k == null || s == null || kPrev == null || sPrev == null) return 0;
  if (kPrev < sPrev && k > s) return 1;
  if (kPrev > sPrev && k < s) return -1;
  return 0;
};

/** PVO: Price Volume Oscillator. Histogram cross of signal. */
export const signalPvo: SignalFn = (bars, _, i) => {
  if (i < 35) return 0;
  const { histogram } = pvo(bars);
  const h = histogram[i], hPrev = histogram[i - 1];
  if (h == null || hPrev == null) return 0;
  if (hPrev < 0 && h > 0) return 1;
  if (hPrev > 0 && h < 0) return -1;
  return 0;
};

/** Elder Impulse: EMA(13) trend + MACD histogram momentum. Green=both up, Red=both down. */
export const signalElderImpulse: SignalFn = (bars, _, i, params) => {
  const emaP = p(params, 'emaPeriod', 13);
  if (i < emaP + 30) return 0;
  const c = closes(bars);
  const ema13 = ema(c, emaP);
  const { histogram } = macd(c, 12, 26, 9);
  const e = ema13[i], ePrev = ema13[i - 1];
  const h = histogram[i], hPrev = histogram[i - 1];
  if (e == null || ePrev == null || h == null || hPrev == null) return 0;
  if (e > ePrev && h > hPrev) return 1;
  if (e < ePrev && h < hPrev) return -1;
  return 0;
};

/** Swing Index: Wilder's SI. Zero-line cross (ASI-style: cumulate for trend, or use raw SI cross). */
export const signalSwingIndex: SignalFn = (bars, _, i) => {
  if (i < 2) return 0;
  const si = swingIndex(bars);
  const v = si[i], prev = si[i - 1];
  if (v == null || prev == null) return 0;
  if (prev < 0 && v > 0) return 1;
  if (prev > 0 && v < 0) return -1;
  return 0;
};

/** Supertrend: flip from bearish to bullish = long, bullish to bearish = short. */
export const signalSupertrend: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 10);
  const mult = p(params, 'mult', 3);
  if (i < period + 2) return 0;
  const { direction } = supertrend(bars, period, mult);
  const d = direction[i], dPrev = direction[i - 1];
  if (dPrev === -1 && d === 1) return 1;
  if (dPrev === 1 && d === -1) return -1;
  return 0;
};

/** Parabolic SAR: flip from below price to above = short, above to below = long. */
export const signalParabolic: SignalFn = (bars, _, i, params) => {
  if (i < 3) return 0;
  const sar = parabolicSar(bars);
  const s = sar[i], sPrev = sar[i - 1];
  const c = bars[i].close, cPrev = bars[i - 1].close;
  if (s == null || sPrev == null) return 0;
  if (sPrev < cPrev && s > c) return -1;
  if (sPrev > cPrev && s < c) return 1;
  return 0;
};

/** Ichimoku Cloud: Tenkan/Kijun cross above cloud = long, below cloud = short. */
export const signalIchimokuCloud: SignalFn = (bars, _, i) => {
  if (i < 52) return 0;
  const { tenkan, kijun, senkouA, senkouB } = ichimoku(bars);
  const t = tenkan[i], k = kijun[i], sa = senkouA[i], sb = senkouB[i];
  const tPrev = tenkan[i - 1], kPrev = kijun[i - 1];
  if (t == null || k == null || sa == null || sb == null || tPrev == null || kPrev == null) return 0;
  const cloudTop = Math.max(sa, sb);
  const cloudBot = Math.min(sa, sb);
  const price = bars[i].close;
  if (tPrev <= kPrev && t > k && price > cloudTop) return 1;
  if (tPrev >= kPrev && t < k && price < cloudBot) return -1;
  return 0;
};

/** Ichimoku Chikou: Chikou (close shifted -26) breaks above price from 26 bars ago = long. */
export const signalIchimokuChikou: SignalFn = (bars, _, i) => {
  if (i < 28) return 0;
  const c = closes(bars);
  const chikouNow = c[i];
  const price26Ago = c[i - 26];
  const chikouPrev = c[i - 1];
  const price27Ago = c[i - 27];
  if (chikouNow == null || price26Ago == null || chikouPrev == null || price27Ago == null) return 0;
  if (chikouPrev <= price27Ago && chikouNow > price26Ago) return 1;
  if (chikouPrev >= price27Ago && chikouNow < price26Ago) return -1;
  return 0;
};

/** Alligator: Lips cross above Teeth/Jaw = long, below = short. Lines separate in direction. */
export const signalAlligator: SignalFn = (bars, _, i) => {
  if (i < 30) return 0;
  const { jaw, teeth, lips } = alligator(bars);
  const j = jaw[i], t = teeth[i], l = lips[i];
  const jPrev = jaw[i - 1], tPrev = teeth[i - 1], lPrev = lips[i - 1];
  if (j == null || t == null || l == null || jPrev == null || tPrev == null || lPrev == null) return 0;
  if (lPrev <= tPrev && l > t && l > j) return 1;
  if (lPrev >= tPrev && l < t && l < j) return -1;
  return 0;
};

/** Gator Oscillator: expansion (upper+lower growing) with direction. */
export const signalGator: SignalFn = (bars, _, i) => {
  if (i < 35) return 0;
  const { upper, lower } = gatorOscillator(bars);
  const u = upper[i], l = lower[i];
  const uPrev = upper[i - 1], lPrev = lower[i - 1];
  const { lips, teeth } = alligator(bars);
  const lip = lips[i], teethVal = teeth[i];
  if (u == null || l == null || uPrev == null || lPrev == null || lip == null || teethVal == null) return 0;
  const expanding = (u + l) > (uPrev + lPrev);
  if (!expanding) return 0;
  if (lip > teethVal) return 1;
  if (lip < teethVal) return -1;
  return 0;
};

/** Triangle symmetric — dedicated pattern detection. */
export const signalTriangleSymmetric: SignalFn = (bars, _, i, params) =>
  detectTriangleSymmetric(bars, i, p(params, 'lookback', 24));

/** Triangle ascending — dedicated pattern detection. */
export const signalTriangleAscending: SignalFn = (bars, _, i, params) =>
  detectTriangleAscending(bars, i, p(params, 'lookback', 24));

/** Triangle descending — dedicated pattern detection. */
export const signalTriangleDescending: SignalFn = (bars, _, i, params) =>
  detectTriangleDescending(bars, i, p(params, 'lookback', 24));

/** Flag bull — dedicated pattern detection. */
export const signalFlagBull: SignalFn = (bars, _, i, params) =>
  detectFlagBull(bars, i, p(params, 'lookback', 18));

/** Flag bear — dedicated pattern detection. */
export const signalFlagBear: SignalFn = (bars, _, i, params) =>
  detectFlagBear(bars, i, p(params, 'lookback', 18));

/** Pennant — dedicated pattern detection. */
export const signalPennant: SignalFn = (bars, _, i, params) =>
  detectPennant(bars, i, p(params, 'lookback', 18));

/** Rectangle — dedicated pattern detection. */
export const signalRectangle: SignalFn = (bars, _, i, params) =>
  detectRectangle(bars, i, p(params, 'lookback', 24));

/** Gap up — dedicated pattern detection. */
export const signalGapUp: SignalFn = (bars, _, i) => detectGapUp(bars, i);

/** Gap down — dedicated pattern detection. */
export const signalGapDown: SignalFn = (bars, _, i) => detectGapDown(bars, i);

/** Rising window — dedicated pattern detection. */
export const signalRisingWindow: SignalFn = (bars, _, i) => detectRisingWindow(bars, i);

/** Falling window — dedicated pattern detection. */
export const signalFallingWindow: SignalFn = (bars, _, i) => detectFallingWindow(bars, i);

/** Bump and run — dedicated pattern detection. */
export const signalBumpAndRun: SignalFn = (bars, _, i, params) =>
  detectBumpAndRun(bars, i, p(params, 'lookback', 28));

/** Fakeout — false breakout then reversal. */
export const signalFakeout: SignalFn = (bars, _, i, params) =>
  detectFakeout(bars, i, p(params, 'lookback', 12));

/** Equal highs/lows — double top/bottom at key level. */
export const signalEqualHighsLows: SignalFn = (bars, _, i, params) =>
  detectEqualHighsLows(bars, i, p(params, 'lookback', 18));

/** S/R flip — support becomes resistance or vice versa. */
export const signalSrFlip: SignalFn = (bars, _, i, params) =>
  detectSrFlip(bars, i, p(params, 'lookback', 12));

/** Trendline break — price breaks linear trendline. */
export const signalTrendlineBreak: SignalFn = (bars, _, i, params) =>
  detectTrendlineBreak(bars, i, p(params, 'lookback', 18));

/** Gap fill — price returns to fill prior gap. */
export const signalGapFill: SignalFn = (bars, _, i, params) =>
  detectGapFill(bars, i, p(params, 'lookback', 6));

/** Swing failure — failed break of swing level. */
export const signalSwingFailure: SignalFn = (bars, _, i, params) =>
  detectSwingFailure(bars, i, p(params, 'lookback', 10));

/** Turtle soup — breakout fails, reversal. */
export const signalTurtleSoup: SignalFn = (bars, _, i, params) =>
  detectTurtleSoup(bars, i, p(params, 'lookback', 12));

/** Exhaustion — high range then reversal. */
export const signalExhaustion: SignalFn = (bars, _, i, params) =>
  detectExhaustion(bars, i, p(params, 'lookback', 6));

/** Capitulation — selling/buying climax. */
export const signalCapitulation: SignalFn = (bars, _, i, params) =>
  detectCapitulation(bars, i, p(params, 'lookback', 6));

/** News spike — large range, direction from close. */
export const signalNewsSpike: SignalFn = (bars, _, i, params) =>
  detectNewsSpike(bars, i, p(params, 'lookback', 12));

/** Close beyond — dedicated. */
export const signalCloseBeyond: SignalFn = (bars, _, i, params) =>
  detectCloseBeyond(bars, i, p(params, 'lookback', 12));

/** Tight consolidation — dedicated. */
export const signalTightConsolidation: SignalFn = (bars, _, i, params) =>
  detectTightConsolidation(bars, i, p(params, 'lookback', 10));

/** Absorption — dedicated. */
export const signalAbsorption: SignalFn = (bars, _, i, params) =>
  detectAbsorption(bars, i, p(params, 'lookback', 12));

/** Opening range — dedicated. */
export const signalOpeningRange: SignalFn = (bars, _, i, params) =>
  detectOpeningRange(bars, i, p(params, 'orBars', 5));

/** Asian range — dedicated. */
export const signalAsianRange: SignalFn = (bars, _, i, params) =>
  detectAsianRange(bars, i, p(params, 'rangeBars', 8));

/** Scalp break — dedicated. */
export const signalScalpBreak: SignalFn = (bars, _, i, params) =>
  detectScalpBreak(bars, i, p(params, 'lookback', 3));

/** CHoCH — Change of Character. */
export const signalChoch: SignalFn = (bars, _, i, params) =>
  detectChoch(bars, i, p(params, 'lookback', 10));

/** Structure break — dedicated. */
export const signalStructureBreak: SignalFn = (bars, _, i, params) =>
  detectStructureBreak(bars, i, p(params, 'lookback', 10));

/** Swing high/low — dedicated. */
export const signalSwingHighLow: SignalFn = (bars, _, i, params) =>
  detectSwingHighLow(bars, i, p(params, 'lookback', 12));

/** Imbalance: FVG or order block (liquidity void). */
export const signalImb: SignalFn = (bars, _, i, params) => {
  if (i < 4) return 0;
  const fvg = detectFvg(bars, i);
  if (fvg !== 0) return fvg;
  return detectOrderBlock(bars, i);
};

/** Fair Value Gap — real FVG detection. */
export const signalFvg: SignalFn = (bars, regime, i, params) => {
  const lookback = p(params, 'lookback', 5);
  if (lookback <= 0 || i < lookback + 2) return 0;
  return detectFvg(bars, i);
};

/** Liquidity sweep — sweep then reversal. */
export const signalLiquiditySweep: SignalFn = (bars, regime, i, params) => {
  const lookback = p(params, 'lookback', 8);
  return detectLiquiditySweep(bars, i, lookback);
};

/** Liquidity pool — sweep of liquidity cluster (2+ swing points in zone). Dedicated logic. */
export const signalLiquidityPool: SignalFn = (bars, _, i, params) =>
  detectLiquidityPool(bars, i, p(params, 'lookback', 14));

/** Inducement — quick fake-out sweep with wick rejection. Dedicated logic. */
export const signalInducement: SignalFn = (bars, _, i, params) =>
  detectInducement(bars, i, p(params, 'lookback', 8));

/** Stop hunt — sweep of key swing level. Dedicated logic. */
export const signalStopHunt: SignalFn = (bars, _, i, params) =>
  detectStopHunt(bars, i, p(params, 'lookback', 10));

/** Break of Structure — HH/LL in trend. */
export const signalBos: SignalFn = (bars, regime, i, params) => {
  const lookback = p(params, 'lookback', 10);
  return detectBos(bars, i, lookback);
};

/** Breakout & retest — break level, pullback, continue. */
export const signalBreakoutRetest: SignalFn = (bars, regime, i, params) => {
  const period = p(params, 'donchianPeriod', 20);
  return detectBreakoutRetest(bars, i, period);
};

/** Order Block — last opposite candle before strong move. */
export const signalOrderBlock: SignalFn = (bars, regime, i) => detectOrderBlock(bars, i);

/** Order block bull: demand zone only. Returns 1 when bullish OB detected. */
export const signalOrderBlockBull: SignalFn = (bars, _, i) => {
  const r = detectOrderBlock(bars, i);
  return r === 1 ? 1 : 0;
};

/** Order block bear: supply zone only. Returns -1 when bearish OB detected. */
export const signalOrderBlockBear: SignalFn = (bars, _, i) => {
  const r = detectOrderBlock(bars, i);
  return r === -1 ? -1 : 0;
};

/** Double top only — bearish reversal. Dedicated. */
export const signalDoubleTop: SignalFn = (bars, _, i, params) =>
  detectDoubleTop(bars, i, p(params, 'lookback', 28));

/** Double bottom only — bullish reversal. Dedicated. */
export const signalDoubleBottom: SignalFn = (bars, _, i, params) =>
  detectDoubleBottom(bars, i, p(params, 'lookback', 28));

/** Double top/bottom — combined chart pattern detection. */
export const signalDoubleTopBottom: SignalFn = (bars, regime, i, params) => {
  const lookback = p(params, 'lookback', 28);
  const dt = detectDoubleTop(bars, i, lookback);
  if (dt !== 0) return dt;
  return detectDoubleBottom(bars, i, lookback);
};

/** HH/HL structure — uptrend. */
export const signalHhHl: SignalFn = (bars, regime, i, params) => {
  const lookback = p(params, 'lookback', 10);
  return detectHhHl(bars, i, lookback);
};

/** LH/LL structure — downtrend. */
export const signalLhLl: SignalFn = (bars, regime, i, params) => {
  const lookback = p(params, 'lookback', 10);
  return detectLhLl(bars, i, lookback);
};

/** VWAP: price vs cumulative VWAP; bounce = long, rejection = short. */
export const signalVwap: SignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const series = vwap(bars);
  const v = series[i];
  if (v == null) return 0;
  const price = bars[i].close;
  const tol = p(params, 'tolerance', 0.001);
  if (price <= v * (1 + tol) && price >= v * (1 - tol) && bars[i].close > bars[i].open) return 1;
  if (price <= v * (1 + tol) && price >= v * (1 - tol) && bars[i].close < bars[i].open) return -1;
  if (price < v * (1 - tol) && bars[i].close > bars[i].open) return 1;
  if (price > v * (1 + tol) && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** VWAP bands: touch upper = short, touch lower = long. */
export const signalVwapBands: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 20);
  const stdMult = p(params, 'stdMult', 2);
  if (i < period) return 0;
  const { upper, lower } = vwapBands(bars, period, stdMult);
  const price = bars[i].close;
  const u = upper[i], l = lower[i];
  if (u == null || l == null) return 0;
  if (price >= u) return -1;
  if (price <= l) return 1;
  return 0;
};

/** VWAP anchor: VWAP from anchor point (e.g. swing low). Uses last swing low in lookback as anchor. */
export const signalVwapAnchor: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 20);
  if (lookback <= 0 || i < lookback + 2) return 0;
  let anchorIdx = i - 1;
  let anchorLow = bars[i - 1].low;
  for (let j = i - 2; j >= Math.max(0, i - lookback); j--) {
    if (bars[j].low < anchorLow) {
      anchorLow = bars[j].low;
      anchorIdx = j;
    }
  }
  const slice = bars.slice(anchorIdx, i + 1);
  const cumTpV = slice.reduce((acc, b) => {
    const tp = (b.high + b.low + b.close) / 3;
    const vol = b.volume ?? 0;
    return { tpv: acc.tpv + tp * vol, vol: acc.vol + vol };
  }, { tpv: 0, vol: 0 });
  const anchoredVwap = cumTpV.vol > 0 ? cumTpV.tpv / cumTpV.vol : bars[i].close;
  const price = bars[i].close;
  const tol = (bars[i].high - bars[i].low) * 0.1 || price * 0.001;
  if (price <= anchoredVwap + tol && price >= anchoredVwap - tol && bars[i].close > bars[i].open) return 1;
  if (price <= anchoredVwap + tol && price >= anchoredVwap - tol && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Chaikin Money Flow: zero-line cross. Positive = accumulation, negative = distribution. */
export const signalCmf: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 20);
  if (i < period) return 0;
  const series = cmf(bars, period);
  const v = series[i];
  const prev = series[i - 1];
  if (v == null || prev == null) return 0;
  if (prev < 0 && v > 0) return 1;
  if (prev > 0 && v < 0) return -1;
  return 0;
};

/** Chande Momentum Oscillator: overbought > 50, oversold < -50. */
export const signalCmo: SignalFn = (bars, regime, i, params) => {
  const period = p(params, 'period', 14);
  const ob = p(params, 'overbought', 50);
  const os = p(params, 'oversold', -50);
  if (i < period) return 0;
  const c = closes(bars);
  const series = cmo(c, period);
  const v = series[i];
  if (v == null) return 0;
  if (regime?.regime === 'reversal_bull' || regime?.regime === 'trending_bear') {
    if (v <= os) return 1;
    if (v >= ob) return -1;
  } else if (regime?.regime === 'reversal_bear' || regime?.regime === 'trending_bull') {
    if (v >= ob) return -1;
    if (v <= os) return 1;
  } else {
    if (v <= os) return 1;
    if (v >= ob) return -1;
  }
  return 0;
};

/** True Strength Index: zero-line cross. */
export const signalTsi: SignalFn = (bars, _, i, params) => {
  const longP = p(params, 'longPeriod', 25);
  const shortP = p(params, 'shortPeriod', 13);
  if (i < longP + shortP) return 0;
  const c = closes(bars);
  const series = tsi(c, longP, shortP);
  const v = series[i];
  const prev = series[i - 1];
  if (v == null || prev == null) return 0;
  if (prev < 0 && v > 0) return 1;
  if (prev > 0 && v < 0) return -1;
  return 0;
};

/** Ultimate Oscillator: 30 oversold, 70 overbought. */
export const signalUltimateOsc: SignalFn = (bars, regime, i, params) => {
  if (i < 28) return 0;
  const series = ultimateOscillator(bars);
  const v = series[i];
  if (v == null) return 0;
  const ob = p(params, 'overbought', 70);
  const os = p(params, 'oversold', 30);
  if (regime?.regime === 'reversal_bull' || regime?.regime === 'trending_bear') {
    if (v <= os) return 1;
    if (v >= ob) return -1;
  } else if (regime?.regime === 'reversal_bear' || regime?.regime === 'trending_bull') {
    if (v >= ob) return -1;
    if (v <= os) return 1;
  } else {
    if (v <= os) return 1;
    if (v >= ob) return -1;
  }
  return 0;
};

/** OBV: zero-line cross of OBV slope. Slope = (OBV[i] - OBV[i-n]) / n. Bullish: slope crosses up; bearish: slope crosses down. */
export const signalObv: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 5);
  if (!Number.isFinite(lookback) || lookback <= 0 || i < lookback + 2) return 0;
  const series = obv(bars);
  const v = series[i];
  const vLag = series[i - lookback];
  const vPrev = series[i - 1];
  const vPrevLag = series[i - lookback - 1];
  if (v == null || vLag == null || vPrev == null || vPrevLag == null) return 0;
  const slope = (v - vLag) / lookback;
  const slopePrev = (vPrev - vPrevLag) / lookback;
  if (slopePrev <= 0 && slope > 0 && bars[i].close > bars[i].open) return 1;
  if (slopePrev >= 0 && slope < 0 && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** OBV divergence only: price vs OBV divergence. */
export const signalObvDiv: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 5);
  if (lookback <= 0 || i < lookback + 2) return 0;
  const series = obv(bars);
  const v = series[i];
  const prev = series[i - lookback];
  if (v == null || prev == null) return 0;
  const c = bars[i].close;
  const cPrev = bars[i - lookback].close;
  if (v > prev && c < cPrev) return 1; // OBV up, price down = bullish divergence
  if (v < prev && c > cPrev) return -1; // OBV down, price up = bearish divergence
  return 0;
};

/** OBV breakout: OBV breaks above/below prior level. */
export const signalObvBreakout: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 10);
  if (lookback <= 0 || i < lookback + 2) return 0;
  const series = obv(bars);
  const v = series[i];
  const prev = series[i - 1];
  const slice = series.slice(i - lookback, i).map((x) => x ?? 0);
  if (slice.length === 0) return 0;
  const levelHigh = Math.max(...slice);
  const levelLow = Math.min(...slice);
  if (v == null || prev == null) return 0;
  if (prev < levelHigh && v >= levelHigh && bars[i].close > bars[i].open) return 1;
  if (prev > levelLow && v <= levelLow && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Force Index: zero-line cross. */
export const signalForceIndex: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 2);
  if (i < period + 1) return 0;
  const series = forceIndex(bars, period);
  const v = series[i];
  const prev = series[i - 1];
  if (v == null || prev == null) return 0;
  if (prev < 0 && v > 0) return 1;
  if (prev > 0 && v < 0) return -1;
  return 0;
};

/** Ease of Movement: zero-line cross. */
export const signalEom: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 14);
  if (i < period + 1) return 0;
  const series = eom(bars, period);
  const v = series[i];
  const prev = series[i - 1];
  if (v == null || prev == null) return 0;
  if (prev < 0 && v > 0) return 1;
  if (prev > 0 && v < 0) return -1;
  return 0;
};

/** Volume Price Trend: slope/divergence. Zero-line cross of VPT change. */
export const signalVpt: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 5);
  if (lookback <= 0 || i < lookback + 2) return 0;
  const series = vpt(bars);
  const v = series[i];
  const prev = series[i - lookback];
  if (v == null || prev == null) return 0;
  const c = bars[i].close;
  const cPrev = bars[i - lookback].close;
  if (v > prev && c < cPrev) return 1;
  if (v < prev && c > cPrev) return -1;
  if (v > prev && c > cPrev) return 1;
  if (v < prev && c < cPrev) return -1;
  return 0;
};

/** Coppock Curve: turn up from negative = long; turn down from positive = short. */
export const signalCoppock: SignalFn = (bars, _, i, params) => {
  const roc1 = p(params, 'roc1', 14);
  const roc2 = p(params, 'roc2', 11);
  const smooth = p(params, 'smooth', 10);
  if (roc1 < 1 || roc2 < 1 || smooth < 1 || !Number.isFinite(roc1) || !Number.isFinite(roc2) || !Number.isFinite(smooth)) return 0;
  if (i < Math.max(roc1, roc2) + smooth) return 0;
  const c = closes(bars);
  const series = coppock(c, roc1, roc2, smooth);
  const v = series[i];
  const prev = series[i - 1];
  if (v == null || prev == null) return 0;
  if (prev < 0 && v > prev && v < 0) return 1; // turning up from negative
  if (prev > 0 && v < prev && v > 0) return -1; // turning down from positive
  if (prev < 0 && v >= 0) return 1; // cross above zero
  if (prev > 0 && v <= 0) return -1; // cross below zero
  return 0;
};

/** NVI/PVI: trend with price = follow; divergence = reversal. Combined: NVI up + price down = bullish; PVI down + price up = bearish. */
export const signalNviPvi: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 5);
  if (lookback <= 0 || i < lookback + 2) return 0;
  const nviSeries = nvi(bars);
  const pviSeries = pvi(bars);
  const nv = nviSeries[i];
  const pv = pviSeries[i];
  const nvPrev = nviSeries[i - lookback];
  const pvPrev = pviSeries[i - lookback];
  if (nv == null || pv == null || nvPrev == null || pvPrev == null) return 0;
  const c = bars[i].close;
  const cPrev = bars[i - lookback].close;
  if (nv > nvPrev && c < cPrev) return 1; // NVI bullish divergence
  if (pv < pvPrev && c > cPrev) return -1; // PVI bearish divergence
  if (nv > nvPrev && pv > pvPrev && c > cPrev) return 1; // both up, price up
  if (nv < nvPrev && pv < pvPrev && c < cPrev) return -1; // both down, price down
  return 0;
};

/** Accumulation/Distribution: divergence or trend. */
export const signalAccumulation: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 5);
  if (lookback <= 0 || i < lookback + 2) return 0;
  const series = accumulationDistribution(bars);
  const v = series[i];
  const prev = series[i - lookback];
  if (v == null || prev == null) return 0;
  const c = bars[i].close;
  const cPrev = bars[i - lookback].close;
  if (v > prev && c < cPrev) return 1; // bullish divergence
  if (v < prev && c > cPrev) return -1; // bearish divergence
  if (v > prev && c > cPrev) return 1;
  if (v < prev && c < cPrev) return -1;
  return 0;
};

/** Pivot points: touch S1/S2 = long; touch R1/R2 = short. */
export const signalPivotPoints: SignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const { pivot, r1, r2, s1, s2 } = pivotPoints(bars);
  const price = bars[i].close;
  const tol = p(params, 'tolerance', 0.001);
  const s1v = s1[i], s2v = s2[i], r1v = r1[i], r2v = r2[i];
  if (s1v == null || r1v == null || s2v == null || r2v == null) return 0;
  if (price <= s1v * (1 + tol) && price >= s2v * (1 - tol) && bars[i].close > bars[i].open) return 1;
  if (price >= r1v * (1 - tol) && price <= r2v * (1 + tol) && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Camarilla pivots: touch S1/S2 = long; touch R1/R2 = short. */
export const signalCamarilla: SignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const { r1, r2, s1, s2 } = camarillaPivots(bars);
  const price = bars[i].close;
  const tol = p(params, 'tolerance', 0.001);
  const s1v = s1[i], s2v = s2[i], r1v = r1[i], r2v = r2[i];
  if (s1v == null || r1v == null || s2v == null || r2v == null) return 0;
  if (price <= s1v * (1 + tol) && price >= s2v * (1 - tol) && bars[i].close > bars[i].open) return 1;
  if (price >= r1v * (1 - tol) && price <= r2v * (1 + tol) && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Fibonacci pivot: touch S1/S2 = long; touch R1/R2 = short. */
export const signalFibPivot: SignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const { r1, r2, s1, s2 } = fibPivot(bars);
  const price = bars[i].close;
  const tol = p(params, 'tolerance', 0.001);
  const s1v = s1[i], s2v = s2[i], r1v = r1[i], r2v = r2[i];
  if (s1v == null || r1v == null || s2v == null || r2v == null) return 0;
  if (price <= s1v * (1 + tol) && price >= s2v * (1 - tol) && bars[i].close > bars[i].open) return 1;
  if (price >= r1v * (1 - tol) && price <= r2v * (1 + tol) && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** ZigZag: price at ZigZag support (level, isHigh=false) + bullish candle = long; at resistance + bearish = short. */
export const signalZigzag: SignalFn = (bars, _, i, params) => {
  const thresh = p(params, 'thresholdPct', 0.001);
  if (i < 5) return 0;
  const { levels, isHigh } = zigzag(bars, thresh);
  const level = levels[i];
  if (level == null) return 0;
  const price = bars[i].close;
  const tol = p(params, 'tolerance', 0.002);
  if (!isHigh[i] && price >= level * (1 - tol) && price <= level * (1 + tol) && bars[i].close > bars[i].open) return 1;
  if (isHigh[i] && price >= level * (1 - tol) && price <= level * (1 + tol) && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Fractals: break above last high fractal = long; break below last low fractal = short. */
export const signalFractals: SignalFn = (bars, _, i, params) => {
  if (i < 5) return 0;
  const { highFractals, lowFractals } = fractals(bars);
  let lastHigh: number | null = null;
  let lastLow: number | null = null;
  for (let j = i - 1; j >= 0; j--) {
    if (highFractals[j] != null) { lastHigh = highFractals[j]; break; }
  }
  for (let j = i - 1; j >= 0; j--) {
    if (lowFractals[j] != null) { lastLow = lowFractals[j]; break; }
  }
  const price = bars[i].close;
  if (lastLow != null && price > lastLow * 1.001 && bars[i].close > bars[i].open) return 1;
  if (lastHigh != null && price < lastHigh * 0.999 && bars[i].close < bars[i].open) return -1;
  return 0;
};

// ─── Dedicated cp-* signals (no proxy) ────────────────────────────────────────
export const signalRoundingBottom: SignalFn = (bars, _, i, params) =>
  detectRoundingBottom(bars, i, p(params, 'lookback', 22));
export const signalRoundingTop: SignalFn = (bars, _, i, params) =>
  detectRoundingTop(bars, i, p(params, 'lookback', 22));
export const signalInsideBar: SignalFn = (bars, _, i) => detectInsideBar(bars, i);
export const signalOutsideBar: SignalFn = (bars, _, i) => detectOutsideBar(bars, i);
export const signalKeyReversal: SignalFn = (bars, _, i) => detectKeyReversal(bars, i);
export const signalIslandReversal: SignalFn = (bars, _, i) => detectIslandReversal(bars, i);
export const signalChannelUp: SignalFn = (bars, _, i, params) =>
  detectChannelUp(bars, i, p(params, 'lookback', 18));
export const signalChannelDown: SignalFn = (bars, _, i, params) =>
  detectChannelDown(bars, i, p(params, 'lookback', 18));
export const signalFibRetracement: SignalFn = (bars, _, i, params) =>
  detectFibRetracement(bars, i, p(params, 'lookback', 18));

/** Fib extension: price at 127.2% or 161.8% of swing; continuation. */
export const signalFibExtension: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 10);
  if (lookback < 2 || i < lookback + 2) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  if (slice.length === 0) return 0;
  const high = Math.max(...slice.map((b) => b.high));
  const low = Math.min(...slice.map((b) => b.low));
  const range = high - low;
  if (range <= 0) return 0;
  const price = bars[i].close;
  const ext127Up = low + range * 1.272;
  const ext161Up = low + range * 1.618;
  const ext127Dn = high - range * 1.272;
  const ext161Dn = high - range * 1.618;
  const tol = range * 0.03;
  if ((Math.abs(price - ext127Up) < tol || Math.abs(price - ext161Up) < tol) && bars[i].close > bars[i].open) return 1;
  if ((Math.abs(price - ext127Dn) < tol || Math.abs(price - ext161Dn) < tol) && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Speed lines: 1/3 and 2/3 from high/low; touch with confirmation. */
export const signalSpeedLines: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 15);
  if (lookback < 2 || i < lookback + 2) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  if (slice.length === 0) return 0;
  const high = Math.max(...slice.map((b) => b.high));
  const low = Math.min(...slice.map((b) => b.low));
  const range = high - low;
  if (range <= 0) return 0;
  const price = bars[i].close;
  const line13 = high - range / 3;
  const line23 = high - (range * 2) / 3;
  const line13L = low + range / 3;
  const line23L = low + (range * 2) / 3;
  const tol = range * 0.02;
  if ((Math.abs(price - line13) < tol || Math.abs(price - line23) < tol) && bars[i].close > bars[i].open) return 1;
  if ((Math.abs(price - line13L) < tol || Math.abs(price - line23L) < tol) && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Andrews pitchfork: median line from pivot P1 through midpoint of P2/P3. P1/P2/P3 = swing points. */
export const signalAndrewsPitchfork: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 15);
  if (lookback < 2 || i < lookback + 6) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  if (slice.length < 5) return 0;
  const swingHighs: { idx: number; high: number }[] = [];
  const swingLows: { idx: number; low: number }[] = [];
  for (let j = 2; j < slice.length - 2; j++) {
    const b = slice[j]!;
    if (b.high >= slice[j - 1]!.high && b.high >= slice[j - 2]!.high && b.high >= slice[j + 1]!.high && b.high >= slice[j + 2]!.high)
      swingHighs.push({ idx: j, high: b.high });
    if (b.low <= slice[j - 1]!.low && b.low <= slice[j - 2]!.low && b.low <= slice[j + 1]!.low && b.low <= slice[j + 2]!.low)
      swingLows.push({ idx: j, low: b.low });
  }
  if (swingHighs.length < 2 || swingLows.length < 2) return 0;
  const p1Idx = Math.min(swingHighs[0]!.idx, swingLows[0]!.idx);
  const p1 = (slice[p1Idx]!.high + slice[p1Idx]!.low) / 2;
  const p2 = swingHighs[1]!.high;
  const p3 = swingLows[1]!.low;
  const mid = (p2 + p3) / 2;
  const curIdx = slice.length - 1;
  const denom = Math.max(1, curIdx - p1Idx);
  const median = p1 + (mid - p1) * ((curIdx - p1Idx) / denom);
  const price = bars[i].close;
  const range = Math.max(...slice.map((b) => b.high)) - Math.min(...slice.map((b) => b.low));
  const tol = range * 0.03;
  if (Math.abs(price - median) < tol && bars[i].close > bars[i].open) return 1;
  if (Math.abs(price - median) < tol && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Harmonic Gartley: XABCD, B=0.618 XA, D=0.786 XA. Swing-based D zone. */
export const signalHarmonicGartley: SignalFn = (bars, _, i, params) =>
  detectHarmonicGartley(bars, i, p(params, 'lookback', 18));

/** Harmonic Bat: B shallow (0.382-0.5), D=0.886 XA. Swing-based D zone. */
export const signalHarmonicBat: SignalFn = (bars, _, i, params) =>
  detectHarmonicBat(bars, i, p(params, 'lookback', 18));

/** Harmonic Butterfly: B deep (0.786), D=1.27 or 1.618 extension. Swing-based. */
export const signalHarmonicButterfly: SignalFn = (bars, _, i, params) =>
  detectHarmonicButterfly(bars, i, p(params, 'lookback', 18));

/** Harmonic Crab: D=1.618 extension of XA. Swing-based. */
export const signalHarmonicCrab: SignalFn = (bars, _, i, params) =>
  detectHarmonicCrab(bars, i, p(params, 'lookback', 18));

/** Harmonic Shark: 1.41 or 2.24 extension. Swing-based. */
export const signalHarmonicShark: SignalFn = (bars, _, i, params) =>
  detectHarmonicShark(bars, i, p(params, 'lookback', 18));

/** Cypher: 0.382 XA, 0.786 BC. D = 0.786 of XC. Swing-based. */
export const signalCypher: SignalFn = (bars, _, i, params) =>
  detectCypher(bars, i, p(params, 'lookback', 18));

/** Three drives: three equal legs; 127% or 161.8% extension. Swing-based. */
export const signalThreeDrives: SignalFn = (bars, _, i, params) =>
  detectThreeDrives(bars, i, p(params, 'lookback', 14));

/** Elliott impulse: five-wave motive. Wave 2 retrace 0.382-0.618, wave 3 extension. */
export const signalElliottImpulse: SignalFn = (bars, _, i, params) =>
  detectElliottImpulse(bars, i, p(params, 'lookback', 24));

/** Elliott ABC: three-wave correction; C = 0.618 or 1.0 of A. */
export const signalElliottAbc: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 15);
  if (lookback <= 0) return 0;
  return detectElliottAbc(bars, i, lookback);
};

/** Fan lines: 3 trendlines from pivot; price at 1/3 or 2/3 line. */
export const signalFanLines: SignalFn = (bars, _, i, params) =>
  detectFanLines(bars, i, p(params, 'lookback', 22));
/** Ascending broadening: dedicated — both trendlines rising, breakout. */
export const signalAscendingBroadening: SignalFn = (bars, _, i, params) =>
  detectAscendingBroadening(bars, i, p(params, 'lookback', 18));

/** Descending broadening: both trendlines falling; breakout at extremes. Dedicated. */
export const signalDescendingBroadening: SignalFn = (bars, _, i, params) =>
  detectDescendingBroadening(bars, i, p(params, 'lookback', 18));
export const signalGannSquare: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 15);
  if (lookback <= 0 || i < lookback + 2) return 0;
  const price = bars[i].close;
  const base = Math.floor(Math.sqrt(price));
  const level = base * base;
  const tol = price * 0.01;
  if (Math.abs(price - level) < tol && bars[i].close > bars[i].open) return 1;
  if (Math.abs(price - level) < tol && bars[i].close < bars[i].open) return -1;
  return 0;
};
/** Schiff pitchfork: pivot at 2nd point (different from Andrews). */
export const signalSchiffPitchfork: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 15);
  if (lookback < 2 || i < lookback + 2) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  if (slice.length === 0) return 0;
  const pivotIdx = Math.floor(lookback / 3);
  const pivot = (slice[pivotIdx].high + slice[pivotIdx].low) / 2;
  const endH = slice[slice.length - 1].high;
  const endL = slice[slice.length - 1].low;
  const median = pivot + ((endH + endL) / 2 - pivot) * 0.5;
  const price = bars[i].close;
  const tol = Math.abs(endH - endL) * 0.05;
  if (Math.abs(price - median) < tol && bars[i].close > bars[i].open) return 1;
  if (Math.abs(price - median) < tol && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Wolfe Waves: 5-point pattern; price and time symmetry. Point 5 reversal. */
export const signalWolfeWaves: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 20);
  if (lookback < 2 || i < lookback + 2) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  const closes = slice.map((b) => b.close);
  const mid = Math.floor(slice.length / 2);
  const firstHalf = closes.slice(0, mid);
  if (firstHalf.length === 0) return 0;
  const p1 = Math.min(...firstHalf);
  const p5 = closes[closes.length - 1]!;
  const trend = p5 > p1;
  if (trend && bars[i].close > bars[i].open && bars[i].close > bars[i - 1].high) return 1;
  if (!trend && bars[i].close < bars[i].open && bars[i].close < bars[i - 1].low) return -1;
  return 0;
};

// ─── Dedicated pa-* signals (no proxy) ────────────────────────────────────────
/** Trendline touch: EMA as dynamic trendline; bounce with confirmation. */
export const signalTrendlineTouch: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 20);
  if (i < period + 2) return 0;
  const c = closes(bars);
  const e = ema(c, period);
  const v = e[i];
  if (v == null) return 0;
  const price = bars[i].close;
  const tolSlice = c.slice(Math.max(0, i - 5), i + 1);
  if (tolSlice.length === 0) return 0;
  const tol = (Math.max(...tolSlice) - Math.min(...tolSlice)) * 0.02;
  if (price <= v + tol && price >= v - tol && bars[i].close > bars[i].open) return 1;
  if (price <= v + tol && price >= v - tol && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Confluence zone: structure (HH/HL or LH/LL) + breakout/retest. */
export const signalConfluenceZone: SignalFn = (bars, regime, i, params) => {
  const hh = detectHhHl(bars, i, p(params, 'lookback', 10));
  if (hh === 1) return 1;
  const lh = detectLhLl(bars, i, p(params, 'lookback', 10));
  if (lh === -1) return -1;
  const br = detectBreakoutRetest(bars, i, p(params, 'donchianPeriod', 20));
  if (br !== 0) return br;
  return 0;
};

/** Two-legged pullback: ABC; C completion at Fib or OB. */
export const signalTwoLeggedPullback: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 10);
  if (lookback <= 0 || i < lookback + 2) return 0;
  const fr = detectFibRetracement(bars, i, lookback);
  if (fr !== 0) return fr;
  const ob = detectOrderBlock(bars, i);
  if (ob !== 0) return ob;
  return 0;
};

/** Run and gun: strong move (ATR) + shallow pullback + continuation. */
export const signalRunAndGun: SignalFn = (bars, _, i, params) => {
  const atrPeriod = p(params, 'atrPeriod', 14);
  const atrMult = p(params, 'atrMult', 1.5);
  if (i < atrPeriod + 3) return 0;
  const a = atr(bars, atrPeriod);
  const ai = a[i];
  if (ai == null) return 0;
  const prevRange = bars[i - 1].high - bars[i - 1].low;
  const curRange = bars[i].high - bars[i].low;
  if (prevRange > ai * atrMult && curRange < prevRange * 0.5) {
    if (bars[i - 1].close > bars[i - 1].open && bars[i].close > bars[i].open) return 1;
    if (bars[i - 1].close < bars[i - 1].open && bars[i].close < bars[i].open) return -1;
  }
  return 0;
};

/** Dynamic S/R: recent swing high/low as dynamic level; bounce with confirmation. */
export const signalDynamicSr: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 10);
  if (lookback <= 0 || i < lookback + 4) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  if (slice.length < 5) return 0;
  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  for (let j = 2; j < slice.length - 2; j++) {
    const b = slice[j]!;
    if (b.high >= slice[j - 1]!.high && b.high >= slice[j - 2]!.high && b.high >= slice[j + 1]!.high && b.high >= slice[j + 2]!.high)
      swingHighs.push(b.high);
    if (b.low <= slice[j - 1]!.low && b.low <= slice[j - 2]!.low && b.low <= slice[j + 1]!.low && b.low <= slice[j + 2]!.low)
      swingLows.push(b.low);
  }
  if (swingHighs.length === 0 || swingLows.length === 0) return 0;
  const res = Math.min(...swingHighs);
  const sup = Math.max(...swingLows);
  const price = bars[i].close;
  const range = res - sup;
  const tol = range * 0.02;
  if (price <= sup + tol && price >= sup - tol && bars[i].close > bars[i].open) return 1;
  if (price >= res - tol && price <= res + tol && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Multi-TF alignment: HTF trend filter + LTF EMA cross entry (real HTF bars when ctx provided). */
export const signalMultiTfAlignment: SignalFn = (bars, _, i, params, ctx) => {
  const fast = p(params, 'fast', 9);
  const slow = p(params, 'slow', 50);
  const htfBars = ctx?.htfBars;
  const htfIdx = ctx?.htfIndexByLtfBar?.[i];
  if (htfBars && htfIdx != null && htfIdx >= 0 && htfIdx >= slow) {
    const cH = closes(htfBars);
    const fH = ema(cH, fast);
    const sH = ema(cH, slow);
    const cL = closes(bars);
    const fL = ema(cL, fast);
    const sL = ema(cL, slow);
    const htfUp = (fH[htfIdx] ?? 0) > (sH[htfIdx] ?? 0);
    const htfDn = (fH[htfIdx] ?? 0) < (sH[htfIdx] ?? 0);
    const pfL = fL[i - 1], psL = sL[i - 1], nfL = fL[i], nsL = sL[i];
    if (pfL == null || psL == null || nfL == null || nsL == null) return 0;
    if (htfUp && pfL <= psL && nfL > nsL) return 1;
    if (htfDn && pfL >= psL && nfL < nsL) return -1;
    return 0;
  }
  if (i < slow + 2) return 0;
  const c = closes(bars);
  const f = ema(c, fast);
  const s = ema(c, slow);
  const pf = f[i - 1], ps = s[i - 1], nf = f[i], ns = s[i];
  if (pf == null || ps == null || nf == null || ns == null) return 0;
  if (pf <= ps && nf > ns) return 1;
  if (pf >= ps && nf < ns) return -1;
  return 0;
};

/** HTF bias: HTF EMA trend + LTF confirmation candle (real HTF when ctx provided). */
export const signalHtfBias: SignalFn = (bars, _, i, params, ctx) => {
  const fast = p(params, 'fast', 9);
  const slow = p(params, 'slow', 50);
  const htfBars = ctx?.htfBars;
  const htfIdx = ctx?.htfIndexByLtfBar?.[i];
  if (htfBars && htfIdx != null && htfIdx >= 0 && htfIdx >= slow) {
    const cH = closes(htfBars);
    const fH = ema(cH, fast);
    const sH = ema(cH, slow);
    const curH = cH[htfIdx] ?? 0;
    const sf = sH[htfIdx];
    const ff = fH[htfIdx];
    if (sf == null || ff == null) return 0;
    if (ff > sf && curH > sf && bars[i].close > bars[i].open) return 1;
    if (ff < sf && curH < sf && bars[i].close < bars[i].open) return -1;
    return 0;
  }
  if (i < slow + 2) return 0;
  const c = closes(bars);
  const f = ema(c, fast);
  const s = ema(c, slow);
  const cur = c[i];
  const sf = s[i], ff = f[i];
  if (sf == null || ff == null) return 0;
  if (cur > sf && ff > sf && bars[i].close > bars[i].open) return 1;
  if (cur < sf && ff < sf && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** LTF trigger: LTF fast/slow cross near HTF slow EMA as level (real HTF when ctx provided). */
export const signalLtfTrigger: SignalFn = (bars, _, i, params, ctx) => {
  const fast = p(params, 'fast', 9);
  const slow = p(params, 'slow', 21);
  const htfBars = ctx?.htfBars;
  const htfIdx = ctx?.htfIndexByLtfBar?.[i];
  if (htfBars && htfIdx != null && htfIdx >= 0 && htfIdx >= slow) {
    const cH = closes(htfBars);
    const sH = ema(cH, slow);
    const level = sH[htfIdx];
    const cL = closes(bars);
    const fL = ema(cL, fast);
    const sL = ema(cL, slow);
    if (level == null) return 0;
    const price = bars[i].close;
    const tol = level * 0.002;
    const crossUp = (fL[i - 1] ?? 0) <= (sL[i - 1] ?? 0) && (fL[i] ?? 0) > (sL[i] ?? 0);
    const crossDn = (fL[i - 1] ?? 0) >= (sL[i - 1] ?? 0) && (fL[i] ?? 0) < (sL[i] ?? 0);
    if (Math.abs(price - level) < tol && crossUp && bars[i].close > bars[i].open) return 1;
    if (Math.abs(price - level) < tol && crossDn && bars[i].close < bars[i].open) return -1;
    return 0;
  }
  if (i < slow + 2) return 0;
  const c = closes(bars);
  const f = ema(c, fast);
  const s = ema(c, slow);
  const level = s[i];
  if (level == null) return 0;
  const price = bars[i].close;
  const tol = level * 0.002;
  const crossUp = (f[i - 1] ?? 0) <= (s[i - 1] ?? 0) && (f[i] ?? 0) > (s[i] ?? 0);
  const crossDn = (f[i - 1] ?? 0) >= (s[i - 1] ?? 0) && (f[i] ?? 0) < (s[i] ?? 0);
  if (Math.abs(price - level) < tol && crossUp && bars[i].close > bars[i].open) return 1;
  if (Math.abs(price - level) < tol && crossDn && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Auction theory: balance (narrow range) then imbalance (breakout). */
export const signalAuctionTheory: SignalFn = (bars, _, i, params) => {
  const atrPeriod = p(params, 'atrPeriod', 14);
  const donchianPeriod = p(params, 'donchianPeriod', 20);
  if (i < Math.max(atrPeriod, donchianPeriod) + 2) return 0;
  const a = atr(bars, atrPeriod);
  const ai = a[i];
  const c = closes(bars);
  const cur = c[i] ?? 0;
  if (ai == null) return 0;
  const volPct = cur > 0 ? ai / cur : 0;
  if (volPct < 0.01) {
    const { upper, lower } = donchian(bars, donchianPeriod);
    const u = upper[i], l = lower[i];
    if (u != null && l != null) {
      if (cur >= u * 0.998) return 1;
      if (cur <= l * 1.002) return -1;
    }
  }
  return 0;
};

/** Squeeze momentum: BB inside Keltner (squeeze) then first bar of momentum burst. */
export const signalSqueezeMomentum: SignalFn = (bars, _, i, params) => {
  const period = p(params, 'period', 20);
  const bbMult = p(params, 'stdMult', 2);
  const keltnerMult = p(params, 'keltnerMult', 2);
  if (i < period + 5) return 0;
  const c = closes(bars);
  const { upper: bbU, lower: bbL } = bollingerBands(c, period, bbMult);
  const { upper: kU, lower: kL } = keltner(bars, period, 10, keltnerMult);
  const wasSqueezed = (bbU[i - 1] ?? 0) <= (kU[i - 1] ?? Infinity) && (bbL[i - 1] ?? 0) >= (kL[i - 1] ?? -Infinity);
  const nowBreak = (bbU[i] ?? 0) > (kU[i] ?? 0) || (bbL[i] ?? 0) < (kL[i] ?? 0);
  if (!wasSqueezed || !nowBreak) return 0;
  if (bars[i].close > bars[i].open) return 1;
  if (bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Value Area: VAH/VAL (volume profile). Without VP: VWAP ± ATR as value edges. Touch VAL = long, VAH = short. */
export const signalValueArea: SignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const v = vwap(bars);
  const vv = v[i];
  if (vv == null) return 0;
  const a = atr(bars, p(params, 'atrPeriod', 14));
  const ai = a[i];
  if (ai == null) return 0;
  const vah = vv + ai;
  const val = vv - ai;
  const price = bars[i].close;
  const tol = ai * 0.3;
  if (price <= val + tol && price >= val - tol && bars[i].close > bars[i].open) return 1;
  if (price <= vah + tol && price >= vah - tol && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** HVN/LVN: price clusters. VWAP ± ATR as nodes. */
export const signalHvnLvn: SignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const v = vwap(bars);
  const vv = v[i];
  if (vv == null) return 0;
  const a = atr(bars, p(params, 'atrPeriod', 14));
  const ai = a[i];
  if (ai == null) return 0;
  const price = bars[i].close;
  const tol = ai * 0.5;
  if (price <= vv + tol && price >= vv - tol && bars[i].close > bars[i].open) return 1;
  if (price <= vv + tol && price >= vv - tol && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Value area: VWAP ± ATR zone. */

/** POC: VWAP touch. */
export const signalPoc: SignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const v = vwap(bars);
  const vv = v[i];
  if (vv == null) return 0;
  const price = bars[i].close;
  const tol = (bars[i].high - bars[i].low) * 0.1;
  if (price <= vv + tol && price >= vv - tol && bars[i].close > bars[i].open) return 1;
  if (price <= vv + tol && price >= vv - tol && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Session high/low: rolling high/low of last N bars. */
export const signalSessionHighLow: SignalFn = (bars, _, i, params) => {
  const n = p(params, 'sessionBars', 24);
  if (n <= 0 || i < n + 2) return 0;
  const slice = bars.slice(i - n, i);
  if (slice.length === 0) return 0;
  const sessionHigh = Math.max(...slice.map((b) => b.high));
  const sessionLow = Math.min(...slice.map((b) => b.low));
  const price = bars[i].close;
  const tol = (sessionHigh - sessionLow) * 0.02;
  if (price <= sessionLow + tol && bars[i].close > bars[i].open) return 1;
  if (price >= sessionHigh - tol && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Three-legged: Fib retracement completion at 0.382/0.5/0.618. Dedicated — no fallback. */
export const signalThreeLegged: SignalFn = (bars, _, i, params) =>
  detectFibRetracement(bars, i, p(params, 'lookback', 18));

/** Session overlap: high volatility expansion. */
export const signalSessionOverlap: SignalFn = (bars, _, i, params) => {
  const atrPeriod = p(params, 'atrPeriod', 14);
  const atrMult = p(params, 'atrMult', 1.5);
  if (i < atrPeriod + 2) return 0;
  const a = atr(bars, atrPeriod);
  const ai = a[i];
  if (ai == null) return 0;
  const range = bars[i].high - bars[i].low;
  if (range > ai * atrMult) return bars[i].close > bars[i].open ? 1 : -1;
  return 0;
};

/** Custom combo: user-defined confluence. Without custom config returns 0. Dedicated logic (no proxy). */
export const signalCustomCombo: SignalFn = (bars, regime, i, params) => {
  const hasCustomConfig = params && (params.customFactors != null || params.comboRules != null);
  if (!hasCustomConfig) return 0;
  const lookback = p(params, 'lookback', 5);
  const donchianPeriod = p(params, 'donchianPeriod', 20);
  const hh = detectHhHl(bars, i, lookback);
  if (hh === 1) return 1;
  const lh = detectLhLl(bars, i, lookback);
  if (lh === -1) return -1;
  const br = detectBreakoutRetest(bars, i, donchianPeriod);
  if (br !== 0) return br;
  return 0;
};

/** Channel touch: channel boundary. */
export const signalChannelTouch: SignalFn = (bars, _, i, params) => {
  const cu = detectChannelUp(bars, i, p(params, 'lookback', 18));
  if (cu !== 0) return cu;
  return detectChannelDown(bars, i, p(params, 'lookback', 18));
};

/** P-shape: single peak profile; trend day. Strong trend bar. */
export const signalPShape: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 5);
  if (lookback <= 0 || i < lookback + 2) return 0;
  const c = closes(bars);
  const cur = c[i] ?? 0;
  const prevSlice = c.slice(i - lookback, i);
  if (prevSlice.length === 0) return 0;
  const prevHigh = Math.max(...prevSlice);
  const prevLow = Math.min(...prevSlice);
  const range = bars[i].high - bars[i].low;
  const body = Math.abs(bars[i].close - bars[i].open);
  if (body > range * 0.7 && cur > prevHigh && bars[i].close > bars[i].open) return 1;
  if (body > range * 0.7 && cur < prevLow && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** B-shape: two peaks; balanced/range day. */
export const signalBShape: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 10);
  if (lookback <= 0 || i < lookback + 2) return 0;
  const c = closes(bars);
  const mid = Math.floor(lookback / 2);
  const first = c.slice(i - lookback, i - mid);
  const second = c.slice(i - mid, i + 1);
  if (first.length === 0 || second.length === 0) return 0;
  const max1 = Math.max(...first);
  const max2 = Math.max(...second);
  const min1 = Math.min(...first);
  const min2 = Math.min(...second);
  const maxOk = max1 > 0 && max2 >= 0 && safeDiv(Math.abs(max1 - max2), max1) < 0.01;
  const minOk = min1 > 0 && min2 >= 0 && safeDiv(Math.abs(min1 - min2), min1) < 0.01;
  if (maxOk && minOk) {
    const cur = c[i] ?? 0;
    const midPrice = (max1 + min1) / 2;
    if (cur < midPrice && bars[i].close > bars[i].open) return 1;
    if (cur > midPrice && bars[i].close < bars[i].open) return -1;
  }
  return 0;
};

/** Double distribution: two value areas; trend then range. */
export const signalDoubleDistribution: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 20);
  if (i < lookback + 2 || lookback < 2) return 0;
  const mid = Math.floor(lookback / 2);
  const first = bars.slice(i - lookback, i - mid);
  const second = bars.slice(i - mid, i + 1);
  if (first.length <= 0 || second.length <= 0) return 0;
  const v1 = first.reduce((s, b) => s + (b.high + b.low) / 2, 0) / first.length;
  const v2 = second.reduce((s, b) => s + (b.high + b.low) / 2, 0) / second.length;
  const price = bars[i].close;
  if (v2 > v1 * 1.01 && bars[i].close > bars[i].open) return 1;
  if (v2 < v1 * 0.99 && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Wick rejection: long wick at level; rejection. Pin bar at S/R. */
export const signalWickRejection: SignalFn = (bars, _, i) => {
  const b = bars[i];
  const range = b.high - b.low;
  if (range <= 0) return 0;
  const lowerWick = Math.min(b.open, b.close) - b.low;
  const upperWick = b.high - Math.max(b.open, b.close);
  if (lowerWick > range * 0.6 && bars[i].close > bars[i].open) return 1;
  if (upperWick > range * 0.6 && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Touch and go: quick touch of level and rejection. Small body, long wick. */
export const signalTouchAndGo: SignalFn = (bars, _, i) => {
  const b = bars[i];
  const range = b.high - b.low;
  if (range <= 0) return 0;
  const body = Math.abs(b.close - b.open);
  const lowerWick = Math.min(b.open, b.close) - b.low;
  const upperWick = b.high - Math.max(b.open, b.close);
  if (body < range * 0.3 && lowerWick > range * 0.5 && bars[i].close > bars[i].open) return 1;
  if (body < range * 0.3 && upperWick > range * 0.5 && bars[i].close < bars[i].open) return -1;
  return 0;
};

/** Head & Shoulders only. No cascade. */
export const signalHeadAndShoulders: SignalFn = (bars, _, i, params) =>
  detectHeadAndShoulders(bars, i, p(params, 'lookback', 35));
/** Inverse H&S only. */
export const signalInverseHeadAndShoulders: SignalFn = (bars, _, i, params) =>
  detectInverseHeadAndShoulders(bars, i, p(params, 'lookback', 35));
/** Rising wedge only. */
export const signalWedgeRising: SignalFn = (bars, _, i, params) =>
  detectWedgeRising(bars, i, p(params, 'lookback', 22));
/** Falling wedge only. */
export const signalWedgeFalling: SignalFn = (bars, _, i, params) =>
  detectWedgeFalling(bars, i, p(params, 'lookback', 22));
/** Cup and handle only. */
export const signalCupAndHandle: SignalFn = (bars, _, i, params) =>
  detectCupAndHandle(bars, i, p(params, 'lookback', 35));
/** Inverse cup and handle only. */
export const signalInverseCupAndHandle: SignalFn = (bars, _, i, params) =>
  detectInverseCupAndHandle(bars, i, p(params, 'lookback', 35));
/** Broadening formation only. */
export const signalBroadening: SignalFn = (bars, _, i, params) =>
  detectBroadening(bars, i, p(params, 'lookback', 18));
/** Diamond only. */
export const signalDiamond: SignalFn = (bars, _, i, params) =>
  detectDiamond(bars, i, p(params, 'lookback', 28));
/** Triple top only — bearish reversal. Dedicated. */
export const signalTripleTop: SignalFn = (bars, _, i, params) =>
  detectTripleTop(bars, i, p(params, 'lookback', 28));

/** Triple bottom only — bullish reversal. Dedicated. */
export const signalTripleBottom: SignalFn = (bars, _, i, params) =>
  detectTripleBottom(bars, i, p(params, 'lookback', 28));

/** Triple top/bottom — combined chart pattern detection. */
export const signalTripleTopBottom: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 28);
  const tt = detectTripleTop(bars, i, lookback);
  if (tt !== 0) return tt;
  return detectTripleBottom(bars, i, lookback);
};

/** Chart patterns: full cascade for unknown cp-* only. No proxy — returns 0 when no pattern matches. */
export const signalChartPattern: SignalFn = (bars, _, i, params) => {
  const lookback = p(params, 'lookback', 22);
  const rb = detectRoundingBottom(bars, i, lookback);
  if (rb !== 0) return rb;
  const rt = detectRoundingTop(bars, i, lookback);
  if (rt !== 0) return rt;
  const ib = detectInsideBar(bars, i);
  if (ib !== 0) return ib;
  const ob = detectOutsideBar(bars, i);
  if (ob !== 0) return ob;
  const kr = detectKeyReversal(bars, i);
  if (kr !== 0) return kr;
  const ir = detectIslandReversal(bars, i);
  if (ir !== 0) return ir;
  const cu = detectChannelUp(bars, i, lookback);
  if (cu !== 0) return cu;
  const cd = detectChannelDown(bars, i, lookback);
  if (cd !== 0) return cd;
  const fr = detectFibRetracement(bars, i, lookback);
  if (fr !== 0) return fr;
  const dt = detectDoubleTop(bars, i, lookback);
  if (dt !== 0) return dt;
  const db = detectDoubleBottom(bars, i, lookback);
  if (db !== 0) return db;
  const tt = detectTripleTop(bars, i, lookback);
  if (tt !== 0) return tt;
  const tb = detectTripleBottom(bars, i, lookback);
  if (tb !== 0) return tb;
  const hs = detectHeadAndShoulders(bars, i, lookback);
  if (hs !== 0) return hs;
  const ihs = detectInverseHeadAndShoulders(bars, i, lookback);
  if (ihs !== 0) return ihs;
  const cup = detectCupAndHandle(bars, i, lookback);
  if (cup !== 0) return cup;
  const icup = detectInverseCupAndHandle(bars, i, lookback);
  if (icup !== 0) return icup;
  const broad = detectBroadening(bars, i, lookback);
  if (broad !== 0) return broad;
  const wedgeUp = detectWedgeRising(bars, i, lookback);
  if (wedgeUp !== 0) return wedgeUp;
  const wedgeDn = detectWedgeFalling(bars, i, lookback);
  if (wedgeDn !== 0) return wedgeDn;
  const diamond = detectDiamond(bars, i, lookback);
  if (diamond !== 0) return diamond;
  return 0;
};

const SIGNAL_MAP: Record<string, SignalFn> = {
  'ind-rsi-div': signalRsiDiv,
  'ind-rsi-overbought': signalRsiOverbought,
  'ind-rsi-oversold': signalRsiOversold,
  'ind-rsi-trend': signalRsiTrend,
  'ind-macd-cross': signalMacd,
  'ind-macd-hist-div': signalMacdHistDiv,
  'ind-macd-zero': signalMacdZero,
  'ind-ema-ribbon': signalEmaRibbon,
  'ind-ema-cross-9-21': signalEmaCross,
  'ind-ema-cross-50-200': signalEmaCross,
  'ind-bb-squeeze': signalBBSqueeze,
  'ind-bb-walk': signalBBWalk,
  'ind-bb-reversion': signalBBReversion,
  'ind-atr-breakout': signalAtrBreakout,
  'ind-atr-trail': signalAtrTrail,
  'ind-stoch-overbought': signalStochOverbought,
  'ind-stoch-oversold': signalStochOversold,
  'ind-stoch-div': signalStochDiv,
  'ind-cci-overbought': signalCciOverbought,
  'ind-cci-oversold': signalCciOversold,
  'ind-williams-r': signalWilliamsR,
  'ind-roc': signalRoc,
  'ind-adx-trend': signalAdx,
  'ind-adx-breakout': signalAdxBreakout,
  'ind-keltner': signalKeltner,
  'ind-donchian': signalDonchian,
  'ind-ao': signalAo,
  'ind-ac': signalAc,
  'ind-dpo': signalDpo,
  'ind-trix': signalTrix,
  'ind-vwap': signalVwap,
  'ind-vwap-bands': signalVwapBands,
  'ind-vwap-anchor': signalVwapAnchor,
  'ind-mfi': signalMfi,
  'ind-cmf': signalCmf,
  'ind-cmo': signalCmo,
  'ind-tsi': signalTsi,
  'ind-ultimate-osc': signalUltimateOsc,
  'ind-kst': signalKst,
  'ind-pvo': signalPvo,
  'ind-obv-div': signalObvDiv,
  'ind-obv-breakout': signalObvBreakout,
  'ind-force-index': signalForceIndex,
  'ind-eom': signalEom,
  'ind-vpt': signalVpt,
  'ind-nvi-pvi': signalNviPvi,
  'ind-elder-impulse': signalElderImpulse,
  'ind-coppock': signalCoppock,
  'ind-swing-index': signalSwingIndex,
  'ind-accumulation': signalAccumulation,
  'ind-supertrend': signalSupertrend,
  'ind-parabolic': signalParabolic,
  'ind-ichimoku-cloud': signalIchimokuCloud,
  'ind-ichimoku-chikou': signalIchimokuChikou,
  'ind-pivot-points': signalPivotPoints,
  'ind-camarilla': signalCamarilla,
  'ind-fib-pivot': signalFibPivot,
  'ind-zigzag': signalZigzag,
  'ind-fractals': signalFractals,
  'ind-alligator': signalAlligator,
  'ind-gator': signalGator,
  'pa-bos': signalBos,
  'pa-liquidity-sweep': signalLiquiditySweep,
  'pa-breakout-retest': signalBreakoutRetest,
  'pa-fvg': signalFvg,
  'pa-order-block-bull': signalOrderBlockBull,
  'pa-order-block-bear': signalOrderBlockBear,
  'pa-higher-high-higher-low': signalHhHl,
  'pa-lower-high-lower-low': signalLhLl,
  'pa-fakeout': signalFakeout,
  'pa-equal-highs-lows': signalEqualHighsLows,
  'pa-sr-flip': signalSrFlip,
  'pa-structure-break': signalStructureBreak,
  'pa-trendline-touch': signalTrendlineTouch,
  'pa-trendline-break': signalTrendlineBreak,
  'pa-swing-high-low': signalSwingHighLow,
  'pa-imb': signalImb,
  'pa-gap-fill': signalGapFill,
  'pa-mitigation-block': signalOrderBlock,
  'pa-liquidity-pool': signalLiquidityPool,
  'pa-inducement': signalInducement,
  'pa-wick-rejection': signalWickRejection,
  'pa-close-beyond': signalCloseBeyond,
  'pa-tight-consolidation': signalTightConsolidation,
  'pa-range-expansion': signalRangeExpansion,
  'pa-squeeze-momentum': signalSqueezeMomentum,
  'pa-confluence-zone': signalConfluenceZone,
  'pa-two-legged-pullback': signalTwoLeggedPullback,
  'pa-swing-failure': signalSwingFailure,
  'pa-turtle-soup': signalTurtleSoup,
  'pa-absorption': signalAbsorption,
  'pa-stop-hunt': signalStopHunt,
  'pa-momentum-shift': signalMomentumShift,
  'pa-run-and-gun': signalRunAndGun,
  'pa-dynamic-sr': signalDynamicSr,
  'pa-multi-tf-alignment': signalMultiTfAlignment,
  'pa-htf-bias': signalHtfBias,
  'pa-ltf-trigger': signalLtfTrigger,
  'pa-auction-theory': signalAuctionTheory,
  'pa-hvn-lvn': signalHvnLvn,
  'pa-value-area': signalValueArea,
  'pa-poc': signalPoc,
  'pa-session-high-low': signalSessionHighLow,
  'pa-opening-range': signalOpeningRange,
  'pa-asian-range': signalAsianRange,
  'pa-choch': signalChoch,
  'pa-exhaustion': signalExhaustion,
  'pa-capitulation': signalCapitulation,
  'pa-three-legged': signalThreeLegged,
  'pa-touch-and-go': signalTouchAndGo,
  'pa-news-spike': signalNewsSpike,
  'pa-session-overlap': signalSessionOverlap,
  'pa-custom-combo': signalCustomCombo,
  'pa-scalp-break': signalScalpBreak,
  'pa-channel-touch': signalChannelTouch,
  'pa-p-shape': signalPShape,
  'pa-b-shape': signalBShape,
  'pa-double-distribution': signalDoubleDistribution,
  'cp-double-top': signalDoubleTop,
  'cp-double-bottom': signalDoubleBottom,
  'cp-triple-top': signalTripleTop,
  'cp-triple-bottom': signalTripleBottom,
  'cp-head-shoulders': signalHeadAndShoulders,
  'cp-inverse-h-s': signalInverseHeadAndShoulders,
  'cp-triangle-sym': signalTriangleSymmetric,
  'cp-triangle-asc': signalTriangleAscending,
  'cp-triangle-desc': signalTriangleDescending,
  'cp-flag-bull': signalFlagBull,
  'cp-flag-bear': signalFlagBear,
  'cp-pennant': signalPennant,
  'cp-wedge-rising': signalWedgeRising,
  'cp-wedge-falling': signalWedgeFalling,
  'cp-rectangle': signalRectangle,
  'cp-channel-up': signalChannelUp,
  'cp-channel-down': signalChannelDown,
  'cp-fib-retracement': signalFibRetracement,
  'cp-fib-extension': signalFibExtension,
  'cp-cup-handle': signalCupAndHandle,
  'cp-inverse-cup': signalInverseCupAndHandle,
  'cp-broadening': signalBroadening,
  'cp-diamond': signalDiamond,
  'cp-rounding-bottom': signalRoundingBottom,
  'cp-rounding-top': signalRoundingTop,
  'cp-gap-up': signalGapUp,
  'cp-gap-down': signalGapDown,
  'cp-tweezer-tops': signalTweezerTop,
  'cp-tweezer-bottoms': signalTweezerBottom,
  'cp-rising-window': signalRisingWindow,
  'cp-falling-window': signalFallingWindow,
  'cp-bump-run': signalBumpAndRun,
  'cp-fan-lines': signalFanLines,
  'cp-speed-lines': signalSpeedLines,
  'cp-andrews-pitchfork': signalAndrewsPitchfork,
  'cp-harmonic-gartley': signalHarmonicGartley,
  'cp-harmonic-bat': signalHarmonicBat,
  'cp-harmonic-butterfly': signalHarmonicButterfly,
  'cp-harmonic-crab': signalHarmonicCrab,
  'cp-harmonic-shark': signalHarmonicShark,
  'cp-cypher': signalCypher,
  'cp-three-drives': signalThreeDrives,
  'cp-elliott-impulse': signalElliottImpulse,
  'cp-elliott-abc': signalElliottAbc,
  'cp-ascending-broadening': signalAscendingBroadening,
  'cp-descending-broadening': signalDescendingBroadening,
  'cp-gann-square': signalGannSquare,
  'cp-schiff-pitchfork': signalSchiffPitchfork,
  'cp-wolfe-waves': signalWolfeWaves,
  'cp-island-reversal': signalIslandReversal,
  'cp-key-reversal': signalKeyReversal,
  'cp-inside-bar': signalInsideBar,
  'cp-outside-bar': signalOutsideBar,
  // Candlestick patterns — each has distinct detection logic
  'cs-engulfing-bull': signalEngulfingBull,
  'cs-engulfing-bear': signalEngulfingBear,
  'cs-hammer': signalHammer,
  'cs-inverted-hammer': signalInvertedHammer,
  'cs-hanging-man': signalHangingMan,
  'cs-shooting-star': signalShootingStar,
  'cs-morning-star': signalMorningStar,
  'cs-evening-star': signalEveningStar,
  'cs-doji': signalDoji,
  'cs-dragonfly-doji': signalDragonflyDoji,
  'cs-gravestone-doji': signalGravestoneDoji,
  'cs-pin-bar-bull': signalPinBarBull,
  'cs-pin-bar-bear': signalPinBarBear,
  'cs-three-soldiers': signalThreeSoldiers,
  'cs-three-crows': signalThreeCrows,
  'cs-three-white-crows': signalThreeWhiteCrows,
  'cs-advance-block': signalAdvanceBlock,
  'cs-deliberation': signalDeliberation,
  'cs-two-crows': signalTwoCrows,
  'cs-three-inside': signalThreeInside,
  'cs-three-outside': signalThreeOutside,
  'cs-abandoned-baby-bull': signalAbandonedBabyBull,
  'cs-abandoned-baby-bear': signalAbandonedBabyBear,
  'cs-kicking-bull': signalKickingBull,
  'cs-kicking-bear': signalKickingBear,
  'cs-ladder-bottom': signalLadderBottom,
  'cs-mat-hold': signalMatHold,
  'cs-rising-three': signalRisingThree,
  'cs-falling-three': signalFallingThree,
  'cs-tasuki-gap-up': signalTasukiGapUp,
  'cs-tasuki-gap-down': signalTasukiGapDown,
  'cs-on-neck': signalOnNeck,
  'cs-in-neck': signalInNeck,
  'cs-thrusting': signalThrusting,
  'cs-stick-sandwich': signalStickSandwich,
  'cs-three-stars-south': signalThreeStarsSouth,
  'cs-tri-star': signalTriStar,
  'cs-identical-three-crows': signalIdenticalThreeCrows,
  'cs-morning-doji-star': signalMorningDojiStar,
  'cs-evening-doji-star': signalEveningDojiStar,
  'cs-harami-bull': signalHaramiBull,
  'cs-harami-bear': signalHaramiBear,
  'cs-harami-cross-bull': signalHaramiCrossBull,
  'cs-harami-cross-bear': signalHaramiCrossBear,
  'cs-piercing': signalPiercing,
  'cs-dark-cloud': signalDarkCloud,
  'cs-tweezer-top': signalTweezerTop,
  'cs-tweezer-bottom': signalTweezerBottom,
  'cs-marubozu-white': signalMarubozuWhite,
  'cs-marubozu-black': signalMarubozuBlack,
  'cs-spinning-top-bull': signalSpinningTopBull,
  'cs-spinning-top-bear': signalSpinningTopBear,
  'cs-high-wave': signalHighWave,
  'cs-belt-hold-bull': signalBeltHoldBull,
  'cs-belt-hold-bear': signalBeltHoldBear,
  'cs-breakaway-bull': signalBreakawayBull,
  'cs-breakaway-bear': signalBreakawayBear,
  'cs-concealing-baby': signalConcealingBaby,
  'cs-unique-three-river': signalUniqueThreeRiver,
  'cs-two-rabbits': signalTwoRabbits,
  'cs-three-line-strike-bull': signalThreeLineStrikeBull,
  'cs-three-line-strike-bear': signalThreeLineStrikeBear,
  'cs-three-river-bull': signalThreeRiverBull,
  'cs-northern-doji': signalNorthernDoji,
  'cs-southern-doji': signalSouthernDoji,
};

/**
 * Get signal function for strategy id. Params are passed through to param-aware signals.
 * Strategies without param support ignore the 4th arg (candlestick, etc.).
 */
const noopSignal: SignalFn = () => 0;

/** Check if strategy has a real signal implementation (not noop). */
export function hasSignalForStrategy(strategyId: string): boolean {
  return strategyId in SIGNAL_MAP;
}

export function getSignalFn(
  strategyId: string,
  instrumentId?: string,
  instrumentSymbol?: string
): SignalFn {
  const exact = SIGNAL_MAP[strategyId];
  const base = exact ?? noopSignal;
  if (!exact && typeof console !== 'undefined' && console.warn) {
    console.warn(`[signals] Unregistered strategy "${strategyId}" — no SIGNAL_MAP entry. Using noop (no trades). Add explicit mapping.`);
  }
  return base;
}
