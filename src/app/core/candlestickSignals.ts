/**
 * Individual candlestick pattern signal functions.
 * Each cs-* strategy has its own distinct detection logic — no shared placeholder.
 * Params: bodyPct (default 0.1), wickPct (default 0.6) for grid search.
 */

import type { OHLCVBar } from './ohlcv';
import { safeDiv } from './mathUtils';
import type { StrategyParams } from './types';

/** Compatible with SignalFn — avoids circular import from signals. */
type CandlestickSignalFn = (
  bars: OHLCVBar[],
  _regime: unknown,
  i: number,
  params?: StrategyParams
) => 1 | -1 | 0;

const p = (params: StrategyParams | undefined, key: string, def: number) =>
  (params && params[key] != null) ? params[key] : def;

function bodyPct(b: OHLCVBar): number {
  const range = b.high - b.low;
  return range > 0 ? Math.abs(b.close - b.open) / range : 0;
}

function upperWickPct(b: OHLCVBar): number {
  const range = b.high - b.low;
  return range > 0 ? (b.high - Math.max(b.open, b.close)) / range : 0;
}

function lowerWickPct(b: OHLCVBar): number {
  const range = b.high - b.low;
  return range > 0 ? (Math.min(b.open, b.close) - b.low) / range : 0;
}

function isBullish(b: OHLCVBar): boolean {
  return b.close > b.open;
}

function isBearish(b: OHLCVBar): boolean {
  return b.close < b.open;
}

function isDoji(b: OHLCVBar, bodyPctMax = 0.1): boolean {
  return bodyPct(b) < bodyPctMax;
}

function isMarubozu(b: OHLCVBar, wickMax = 0.05): boolean {
  const range = b.high - b.low;
  if (range <= 0) return false;
  const upperWick = (b.high - Math.max(b.open, b.close)) / range;
  const lowerWick = (Math.min(b.open, b.close) - b.low) / range;
  return upperWick <= wickMax && lowerWick <= wickMax;
}

function gapUp(prev: OHLCVBar, cur: OHLCVBar, tol = 0.0005): boolean {
  return cur.low > prev.high * (1 + tol);
}

function gapDown(prev: OHLCVBar, cur: OHLCVBar, tol = 0.0005): boolean {
  return cur.high < prev.low * (1 - tol);
}

// --- Engulfing ---
export const signalEngulfingBull: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 1) return 0;
  const prev = bars[i - 1], cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isBearish(prev) || !isBullish(cur)) return 0;
  const prevBody = Math.abs(prev.close - prev.open);
  const curBody = Math.abs(cur.close - cur.open);
  if (curBody <= prevBody * 1.1) return 0;
  if (cur.open < prev.close && cur.close > prev.open && bodyPct(cur) >= bp * 0.5) return 1;
  return 0;
};

export const signalEngulfingBear: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 1) return 0;
  const prev = bars[i - 1], cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isBullish(prev) || !isBearish(cur)) return 0;
  const prevBody = Math.abs(prev.close - prev.open);
  const curBody = Math.abs(cur.close - cur.open);
  if (curBody <= prevBody * 1.1) return 0;
  if (cur.open > prev.close && cur.close < prev.open && bodyPct(cur) >= bp * 0.5) return -1;
  return 0;
};

// --- Hammer / Inverted Hammer / Hanging Man / Shooting Star ---
export const signalHammer: CandlestickSignalFn = (bars, _, i, params) => {
  const cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  const wp = p(params, 'wickPct', 0.6);
  if (lowerWickPct(cur) >= wp && bodyPct(cur) <= Math.max(0.3, bp * 3) && upperWickPct(cur) < 0.2) return 1;
  return 0;
};

export const signalInvertedHammer: CandlestickSignalFn = (bars, _, i, params) => {
  const cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  const wp = p(params, 'wickPct', 0.6);
  if (upperWickPct(cur) >= wp && bodyPct(cur) <= Math.max(0.3, bp * 3) && lowerWickPct(cur) < 0.2) return 1;
  return 0;
};

export const signalHangingMan: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  const wp = p(params, 'wickPct', 0.6);
  const prev = bars[i - 1];
  if (!isBullish(prev)) return 0;
  if (lowerWickPct(cur) >= wp && bodyPct(cur) <= Math.max(0.3, bp * 3) && upperWickPct(cur) < 0.2) return -1;
  return 0;
};

export const signalShootingStar: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  const wp = p(params, 'wickPct', 0.6);
  const prev = bars[i - 1];
  if (!isBullish(prev)) return 0;
  if (upperWickPct(cur) >= wp && bodyPct(cur) <= Math.max(0.3, bp * 3) && lowerWickPct(cur) < 0.2) return -1;
  return 0;
};

// --- Morning / Evening Star (3-candle) ---
export const signalMorningStar: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const first = bars[i - 2], mid = bars[i - 1], third = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isBearish(first) || !isDoji(mid, bp * 1.5) || !isBullish(third)) return 0;
  const firstMid = (first.open + first.close) / 2;
  if (third.close > firstMid && third.close > mid.open) return 1;
  return 0;
};

export const signalEveningStar: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const first = bars[i - 2], mid = bars[i - 1], third = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isBullish(first) || !isDoji(mid, bp * 1.5) || !isBearish(third)) return 0;
  const firstMid = (first.open + first.close) / 2;
  if (third.close < firstMid && third.close < mid.open) return -1;
  return 0;
};

// --- Doji variants ---
export const signalDoji: CandlestickSignalFn = (bars, _, i, params) => {
  const cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  const wp = p(params, 'wickPct', 0.6);
  if (!isDoji(cur, bp)) return 0;
  if (lowerWickPct(cur) > wp) return 1;
  if (upperWickPct(cur) > wp) return -1;
  return 0;
};

export const signalDragonflyDoji: CandlestickSignalFn = (bars, _, i, params) => {
  const cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  const wp = p(params, 'wickPct', 0.6);
  if (!isDoji(cur, bp) || lowerWickPct(cur) < wp || upperWickPct(cur) > 0.1) return 0;
  return 1;
};

export const signalGravestoneDoji: CandlestickSignalFn = (bars, _, i, params) => {
  const cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  const wp = p(params, 'wickPct', 0.6);
  if (!isDoji(cur, bp) || upperWickPct(cur) < wp || lowerWickPct(cur) > 0.1) return 0;
  return -1;
};

// --- Pin Bar ---
export const signalPinBarBull: CandlestickSignalFn = (bars, _, i, params) => {
  const cur = bars[i];
  const bp = p(params, 'bodyPct', 0.35);
  const wp = p(params, 'wickPct', 0.65);
  if (lowerWickPct(cur) >= wp && bodyPct(cur) <= bp) return 1;
  return 0;
};

export const signalPinBarBear: CandlestickSignalFn = (bars, _, i, params) => {
  const cur = bars[i];
  const bp = p(params, 'bodyPct', 0.35);
  const wp = p(params, 'wickPct', 0.65);
  if (upperWickPct(cur) >= wp && bodyPct(cur) <= bp) return -1;
  return 0;
};

// --- Three Soldiers / Crows ---
export const signalThreeSoldiers: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const c1 = bars[i - 2], c2 = bars[i - 1], c3 = bars[i];
  if (!isBullish(c1) || !isBullish(c2) || !isBullish(c3)) return 0;
  if (c2.close > c1.close && c3.close > c2.close && c2.open > c1.open && c3.open > c2.open) return 1;
  return 0;
};

export const signalThreeCrows: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const c1 = bars[i - 2], c2 = bars[i - 1], c3 = bars[i];
  if (!isBearish(c1) || !isBearish(c2) || !isBearish(c3)) return 0;
  if (c2.close < c1.close && c3.close < c2.close && c2.open < c1.open && c3.open < c2.open) return -1;
  return 0;
};

export const signalThreeWhiteCrows: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const c1 = bars[i - 2], c2 = bars[i - 1], c3 = bars[i];
  if (!isBullish(c1) || !isBullish(c2) || !isBullish(c3)) return 0;
  if (c2.open >= c1.open && c2.open <= c1.close && c3.open >= c2.open && c3.open <= c2.close) return 1;
  return 0;
};

// --- Advance Block / Deliberation / Two Crows ---
export const signalAdvanceBlock: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const c1 = bars[i - 2], c2 = bars[i - 1], c3 = bars[i];
  if (!isBullish(c1) || !isBullish(c2) || !isBullish(c3)) return 0;
  const b1 = Math.abs(c1.close - c1.open), b2 = Math.abs(c2.close - c2.open), b3 = Math.abs(c3.close - c3.open);
  if (b2 < b1 && b3 < b2) return -1;
  return 0;
};

export const signalDeliberation: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const c1 = bars[i - 2], c2 = bars[i - 1], c3 = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isBullish(c1) || !isBullish(c2)) return 0;
  const b1 = Math.abs(c1.close - c1.open), b2 = Math.abs(c2.close - c2.open);
  if (b2 >= b1 * 0.5) return 0;
  if (isDoji(c3, bp * 1.5) || bodyPct(c3) < 0.2) return -1;
  return 0;
};

export const signalTwoCrows: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const c1 = bars[i - 2], c2 = bars[i - 1], c3 = bars[i];
  if (!isBullish(c1) || !isBearish(c2) || !isBearish(c3)) return 0;
  if (gapUp(c1, c2) && c2.open > c1.close && c3.open > c2.open && c3.open < c2.close) return -1;
  return 0;
};

// --- Three Inside / Outside ---
export const signalThreeInside: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const first = bars[i - 2], second = bars[i - 1], third = bars[i];
  if (!isBearish(first) || !isBullish(second) || !isBullish(third)) return 0;
  if (second.open >= first.close && second.close <= first.open && third.close > second.high) return 1;
  return 0;
};

export const signalThreeOutside: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const first = bars[i - 2], second = bars[i - 1], third = bars[i];
  if (!isBearish(first) || !isBullish(second) || !isBullish(third)) return 0;
  if (second.open < first.close && second.close > first.open && third.close > second.high) return 1;
  return 0;
};

// --- Abandoned Baby ---
export const signalAbandonedBabyBull: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const first = bars[i - 2], mid = bars[i - 1], third = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isBearish(first) || !isDoji(mid, bp) || !isBullish(third)) return 0;
  if (gapDown(first, mid) && gapUp(mid, third)) return 1;
  return 0;
};

export const signalAbandonedBabyBear: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const first = bars[i - 2], mid = bars[i - 1], third = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isBullish(first) || !isDoji(mid, bp) || !isBearish(third)) return 0;
  if (gapUp(first, mid) && gapDown(mid, third)) return -1;
  return 0;
};

// --- Kicking ---
export const signalKickingBull: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 1) return 0;
  const prev = bars[i - 1], cur = bars[i];
  if (!isMarubozu(prev) || !isBearish(prev)) return 0;
  if (!isMarubozu(cur) || !isBullish(cur)) return 0;
  if (gapDown(prev, cur)) return 1;
  return 0;
};

export const signalKickingBear: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 1) return 0;
  const prev = bars[i - 1], cur = bars[i];
  if (!isMarubozu(prev) || !isBullish(prev)) return 0;
  if (!isMarubozu(cur) || !isBearish(cur)) return 0;
  if (gapUp(prev, cur)) return -1;
  return 0;
};

// --- Ladder Bottom / Mat Hold / Rising/Falling Three ---
export const signalLadderBottom: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 4) return 0;
  const c1 = bars[i - 4], c2 = bars[i - 3], c3 = bars[i - 2], c4 = bars[i - 1], c5 = bars[i];
  if (!isBearish(c1) || !isBearish(c2) || !isBearish(c3) || !isBearish(c4)) return 0;
  if (!isBullish(c5) || c5.close > c4.high) return 1;
  return 0;
};

export const signalMatHold: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 4) return 0;
  const prev = bars[i - 5];
  const c1 = bars[i - 4], c2 = bars[i - 3], c3 = bars[i - 2], c4 = bars[i - 1], c5 = bars[i];
  if (!isBullish(c1) || (prev && !gapUp(prev, c1))) return 0;
  if (!isBearish(c2) || !isBearish(c3) || !isBearish(c4)) return 0;
  if (isBullish(c5) && c5.close > c1.high) return 1;
  return 0;
};

export const signalRisingThree: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 4) return 0;
  const c1 = bars[i - 4], c5 = bars[i];
  if (!isBullish(c1)) return 0;
  const lows = [bars[i - 3].low, bars[i - 2].low, bars[i - 1].low];
  const highs = [bars[i - 3].high, bars[i - 2].high, bars[i - 1].high];
  const inRange = lows.every((l) => l > c1.low) && highs.every((h) => h < c1.high);
  if (inRange && isBullish(c5) && c5.close > c1.high) return 1;
  return 0;
};

export const signalFallingThree: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 4) return 0;
  const c1 = bars[i - 4], c5 = bars[i];
  if (!isBearish(c1)) return 0;
  const lows = [bars[i - 3].low, bars[i - 2].low, bars[i - 1].low];
  const highs = [bars[i - 3].high, bars[i - 2].high, bars[i - 1].high];
  const inRange = lows.every((l) => l > c1.low) && highs.every((h) => h < c1.high);
  if (inRange && isBearish(c5) && c5.close < c1.low) return -1;
  return 0;
};

// --- Tasuki Gap ---
export const signalTasukiGapUp: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const c1 = bars[i - 2], c2 = bars[i - 1], c3 = bars[i];
  if (!isBullish(c1) || !gapUp(bars[i - 3] ?? c1, c1)) return 0;
  if (!isBearish(c2) || c2.open >= c1.low || c2.close <= c1.high) return 0;
  if (isBullish(c3) && c3.close > c2.high) return 1;
  return 0;
};

export const signalTasukiGapDown: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const c1 = bars[i - 2], c2 = bars[i - 1], c3 = bars[i];
  if (!isBearish(c1) || !gapDown(bars[i - 3] ?? c1, c1)) return 0;
  if (!isBullish(c2) || c2.close >= c1.high || c2.open <= c1.low) return 0;
  if (isBearish(c3) && c3.close < c2.low) return -1;
  return 0;
};

// --- On-Neck / In-Neck / Thrusting (bearish continuation) ---
export const signalOnNeck: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 1) return 0;
  const prev = bars[i - 1], cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  const wp = p(params, 'wickPct', 0.6);
  if (!isBearish(prev) || !isBullish(cur) || bodyPct(cur) > Math.max(0.2, bp * 2)) return 0;
  const closesAtPrevLow = safeDiv(Math.abs(cur.close - prev.low), prev.low) < 0.005;
  if (closesAtPrevLow) return -1;
  return 0;
};

export const signalInNeck: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 1) return 0;
  const prev = bars[i - 1], cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  const wp = p(params, 'wickPct', 0.6);
  if (!isBearish(prev) || !isBullish(cur) || bodyPct(cur) > Math.max(0.2, bp * 2)) return 0;
  const prevBody = prev.open - prev.close;
  const penetration = safeDiv(cur.close - prev.low, prevBody);
  if (cur.close > prev.low && cur.close < prev.close && penetration <= 0.5) return -1;
  return 0;
};

export const signalThrusting: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 1) return 0;
  const prev = bars[i - 1], cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isBearish(prev) || !isBullish(cur) || bodyPct(cur) > 0.25) return 0;
  const prevMid = (prev.open + prev.close) / 2;
  if (cur.close > prev.low && cur.close < prevMid) return -1;
  return 0;
};

// --- Stick Sandwich ---
export const signalStickSandwich: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const c1 = bars[i - 2], c2 = bars[i - 1], c3 = bars[i];
  if (!isBearish(c1) || !isBullish(c2) || !isBearish(c3)) return 0;
  if (c2.open > c1.close && c2.close < c1.open && c3.close < c2.low) return 1;
  return 0;
};

// --- Three Stars / Tri-Star / Identical Three Crows ---
export const signalThreeStarsSouth: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const bp = p(params, 'bodyPct', 0.1);
  const c1 = bars[i - 2], c2 = bars[i - 1], c3 = bars[i];
  if (!isDoji(c1, bp) || !isDoji(c2, bp) || !isDoji(c3, bp)) return 0;
  if (c2.low < c1.low && c3.low < c2.low) return -1;
  return 0;
};

export const signalTriStar: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const bp = p(params, 'bodyPct', 0.1);
  const c1 = bars[i - 2], c2 = bars[i - 1], c3 = bars[i];
  if (!isDoji(c1, bp) || !isDoji(c2, bp) || !isDoji(c3, bp)) return 0;
  if (gapDown(c1, c2) && gapUp(c2, c3)) return 1;
  if (gapUp(c1, c2) && gapDown(c2, c3)) return -1;
  return 0;
};

export const signalIdenticalThreeCrows: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const c1 = bars[i - 2], c2 = bars[i - 1], c3 = bars[i];
  if (!isBearish(c1) || !isBearish(c2) || !isBearish(c3)) return 0;
  const tol = 0.001;
  if (safeDiv(Math.abs(c1.open - c2.open), c1.open) < tol && safeDiv(Math.abs(c2.open - c3.open), c2.open) < tol) return -1;
  return 0;
};

// --- Morning/Evening Doji Star ---
export const signalMorningDojiStar: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const first = bars[i - 2], mid = bars[i - 1], third = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isBearish(first) || !isDoji(mid, bp) || !isBullish(third)) return 0;
  if (gapDown(first, mid) && third.close > (first.open + first.close) / 2) return 1;
  return 0;
};

export const signalEveningDojiStar: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const first = bars[i - 2], mid = bars[i - 1], third = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isBullish(first) || !isDoji(mid, bp) || !isBearish(third)) return 0;
  if (gapUp(first, mid) && third.close < (first.open + first.close) / 2) return -1;
  return 0;
};

// --- Harami ---
export const signalHaramiBull: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 1) return 0;
  const prev = bars[i - 1], cur = bars[i];
  if (!isBearish(prev) || !isBullish(cur) || bodyPct(cur) > 0.4) return 0;
  if (cur.open > prev.close && cur.close < prev.open) return 1;
  return 0;
};

export const signalHaramiBear: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 1) return 0;
  const prev = bars[i - 1], cur = bars[i];
  if (!isBullish(prev) || !isBearish(cur) || bodyPct(cur) > 0.4) return 0;
  if (cur.open < prev.close && cur.close > prev.open) return -1;
  return 0;
};

export const signalHaramiCrossBull: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 1) return 0;
  const prev = bars[i - 1], cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isBearish(prev) || !isDoji(cur, bp)) return 0;
  if (cur.open > prev.close && cur.close < prev.open) return 1;
  return 0;
};

export const signalHaramiCrossBear: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 1) return 0;
  const prev = bars[i - 1], cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isBullish(prev) || !isDoji(cur, bp)) return 0;
  if (cur.open < prev.close && cur.close > prev.open) return -1;
  return 0;
};

// --- Piercing Line / Dark Cloud Cover ---
export const signalPiercing: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 1) return 0;
  const prev = bars[i - 1], cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isBearish(prev) || !isBullish(cur) || bodyPct(prev) < bp) return 0;
  const prevMid = (prev.open + prev.close) / 2;
  if (cur.open < prev.low && cur.close > prevMid && cur.close < prev.open) return 1;
  return 0;
};

export const signalDarkCloud: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 1) return 0;
  const prev = bars[i - 1], cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isBullish(prev) || !isBearish(cur) || bodyPct(prev) < bp) return 0;
  const prevMid = (prev.open + prev.close) / 2;
  if (cur.open > prev.high && cur.close < prevMid && cur.close > prev.close) return -1;
  return 0;
};

// --- Tweezer Tops/Bottoms ---
export const signalTweezerTop: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 1) return 0;
  const prev = bars[i - 1], cur = bars[i];
  const tol = 0.002;
  if (safeDiv(Math.abs(prev.high - cur.high), prev.high) > tol) return 0;
  if (isBearish(cur)) return -1;
  return 0;
};

export const signalTweezerBottom: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 1) return 0;
  const prev = bars[i - 1], cur = bars[i];
  const tol = 0.002;
  if (safeDiv(Math.abs(prev.low - cur.low), prev.low) > tol) return 0;
  if (isBullish(cur)) return 1;
  return 0;
};

// --- Marubozu ---
export const signalMarubozuWhite: CandlestickSignalFn = (bars, _, i, params) => {
  const cur = bars[i];
  const bp = p(params, 'bodyPct', 0.9);
  if (isBullish(cur) && isMarubozu(cur, 0.02) && bodyPct(cur) >= 0.85) return 1;
  return 0;
};

export const signalMarubozuBlack: CandlestickSignalFn = (bars, _, i, params) => {
  const cur = bars[i];
  const bp = p(params, 'bodyPct', 0.9);
  if (isBearish(cur) && isMarubozu(cur, 0.02) && bodyPct(cur) >= 0.85) return -1;
  return 0;
};

// --- Spinning Top ---
export const signalSpinningTopBull: CandlestickSignalFn = (bars, _, i, params) => {
  const cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  const wp = p(params, 'wickPct', 0.4);
  if (bodyPct(cur) < 0.3 && lowerWickPct(cur) >= wp && upperWickPct(cur) >= wp) return 1;
  return 0;
};

export const signalSpinningTopBear: CandlestickSignalFn = (bars, _, i, params) => {
  const cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  const wp = p(params, 'wickPct', 0.4);
  if (bodyPct(cur) < 0.3 && lowerWickPct(cur) >= wp && upperWickPct(cur) >= wp) return -1;
  return 0;
};

// --- High Wave ---
export const signalHighWave: CandlestickSignalFn = (bars, _, i, params) => {
  const cur = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  const wp = p(params, 'wickPct', 0.4);
  if (bodyPct(cur) < 0.2 && lowerWickPct(cur) >= wp && upperWickPct(cur) >= wp) return 0;
  return 0;
};

// --- Belt Hold ---
export const signalBeltHoldBull: CandlestickSignalFn = (bars, _, i, params) => {
  const cur = bars[i];
  const bp = p(params, 'bodyPct', 0.7);
  if (!isBullish(cur) || bodyPct(cur) < 0.7) return 0;
  const range = cur.high - cur.low;
  if (range > 0 && Math.abs(cur.open - cur.low) / range < 0.02) return 1;
  return 0;
};

export const signalBeltHoldBear: CandlestickSignalFn = (bars, _, i, params) => {
  const cur = bars[i];
  const bp = p(params, 'bodyPct', 0.7);
  if (!isBearish(cur) || bodyPct(cur) < 0.7) return 0;
  const range = cur.high - cur.low;
  if (range > 0 && Math.abs(cur.open - cur.high) / range < 0.02) return -1;
  return 0;
};

// --- Breakaway / Concealing Baby / Unique Three River / Two Rabbits ---
export const signalBreakawayBull: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 4) return 0;
  const first = bars[i - 4];
  if (!isBearish(first) || !gapDown(bars[i - 5] ?? first, first)) return 0;
  const c2 = bars[i - 3], c3 = bars[i - 2], c4 = bars[i - 1], c5 = bars[i];
  if (!isBullish(c2) || !isBullish(c3) || !isBullish(c4) || !isBullish(c5)) return 0;
  if (gapUp(c4, c5) && c5.close > first.high) return 1;
  return 0;
};

export const signalBreakawayBear: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 4) return 0;
  const first = bars[i - 4];
  if (!isBullish(first) || !gapUp(bars[i - 5] ?? first, first)) return 0;
  const c2 = bars[i - 3], c3 = bars[i - 2], c4 = bars[i - 1], c5 = bars[i];
  if (!isBearish(c2) || !isBearish(c3) || !isBearish(c4) || !isBearish(c5)) return 0;
  if (gapDown(c4, c5) && c5.close < first.low) return -1;
  return 0;
};

export const signalConcealingBaby: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 4) return 0;
  const c1 = bars[i - 4], c2 = bars[i - 3], c3 = bars[i - 2], c4 = bars[i - 1];
  const confirm = bars[i];
  if (!isBearish(c1) || !isBearish(c2) || !isBearish(c3) || !isBearish(c4)) return 0;
  if (c4.open < c3.open || c4.open > c3.close) return 0;
  if (isBullish(confirm) && confirm.close > c1.high) return 1;
  return 0;
};

export const signalUniqueThreeRiver: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const first = bars[i - 2], second = bars[i - 1], third = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isBearish(first) || !(lowerWickPct(second) >= 0.6 && bodyPct(second) <= 0.3) || !isBullish(third)) return 0;
  if (third.open > second.low && third.close < second.open && third.close > first.close) return 1;
  return 0;
};

export const signalTwoRabbits: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const first = bars[i - 2], second = bars[i - 1], third = bars[i];
  if (!isBearish(first) || !gapDown(bars[i - 3] ?? first, first)) return 0;
  if (!isBullish(second) || !isBullish(third)) return 0;
  if (third.open >= second.open && third.open <= second.close && third.close > first.high) return 1;
  return 0;
};

// --- Three Line Strike ---
export const signalThreeLineStrikeBull: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 3) return 0;
  const c1 = bars[i - 3], c2 = bars[i - 2], c3 = bars[i - 1], c4 = bars[i];
  if (!isBearish(c1) || !isBearish(c2) || !isBearish(c3) || !isBullish(c4)) return 0;
  if (c4.open < c3.close && c4.close > c1.open) return 1;
  return 0;
};

export const signalThreeLineStrikeBear: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 3) return 0;
  const c1 = bars[i - 3], c2 = bars[i - 2], c3 = bars[i - 1], c4 = bars[i];
  if (!isBullish(c1) || !isBullish(c2) || !isBullish(c3) || !isBearish(c4)) return 0;
  if (c4.open > c3.close && c4.close < c1.open) return -1;
  return 0;
};

// --- Three River Bottom ---
export const signalThreeRiverBull: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const first = bars[i - 2], second = bars[i - 1], third = bars[i];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isBearish(first) || !isDoji(second, bp) || !isBullish(third)) return 0;
  if (safeDiv(Math.abs(second.low - first.low), first.low) < 0.01 && third.close > first.high) return 1;
  return 0;
};

// --- Northern / Southern Doji ---
export const signalNorthernDoji: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const cur = bars[i], prev = bars[i - 1];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isDoji(cur, bp) || !isBullish(prev)) return 0;
  return -1;
};

export const signalSouthernDoji: CandlestickSignalFn = (bars, _, i, params) => {
  if (i < 2) return 0;
  const cur = bars[i], prev = bars[i - 1];
  const bp = p(params, 'bodyPct', 0.1);
  if (!isDoji(cur, bp) || !isBearish(prev)) return 0;
  return 1;
};
