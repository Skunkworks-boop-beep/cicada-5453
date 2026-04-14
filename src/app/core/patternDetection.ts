/**
 * Pattern detection for price action and chart patterns.
 * Real computations — no placeholders. Used by backtest signal logic.
 */

import type { OHLCVBar } from './ohlcv';
import { safeDiv } from './mathUtils';

/** Swing high: bar high > highs of left and right bars. */
export function isSwingHigh(bars: OHLCVBar[], i: number, left: number = 2, right: number = 2): boolean {
  if (left < 1 || right < 1 || !Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (i < left || i >= bars.length - right) return false;
  const h = bars[i].high;
  for (let k = 1; k <= left; k++) if (bars[i - k].high >= h) return false;
  for (let k = 1; k <= right; k++) if (bars[i + k].high >= h) return false;
  return true;
}

/** Swing low: bar low < lows of left and right bars. */
export function isSwingLow(bars: OHLCVBar[], i: number, left: number = 2, right: number = 2): boolean {
  if (left < 1 || right < 1 || !Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (i < left || i >= bars.length - right) return false;
  const l = bars[i].low;
  for (let k = 1; k <= left; k++) if (bars[i - k].low <= l) return false;
  for (let k = 1; k <= right; k++) if (bars[i + k].low <= l) return false;
  return true;
}

/** Fair Value Gap (FVG): 3 candles, gap between candle 1 and 3. Bullish: c1.low > c3.high. Bearish: c1.high < c3.low. */
export function detectFvg(bars: OHLCVBar[], i: number): 1 | -1 | 0 {
  if (i < 2) return 0;
  const c1 = bars[i - 2], c2 = bars[i - 1], c3 = bars[i];
  // Bullish FVG: gap between c1.low and c3.high (c3 closes up, c1 was down)
  if (c1.low > c3.high && c3.close > c3.open && c1.close < c1.open) return 1;
  // Bearish FVG: gap between c1.high and c3.low
  if (c1.high < c3.low && c3.close < c3.open && c1.close > c1.open) return -1;
  return 0;
}

/** Liquidity sweep: price sweeps swing high/low then closes back. Swing-based — sweeps occur at swing points (stop clusters). */
export function detectLiquiditySweep(bars: OHLCVBar[], i: number, lookback: number = 8): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
  const swingHighs: { idx: number; high: number }[] = [];
  const swingLows: { idx: number; low: number }[] = [];
  for (let j = i - lookback; j <= i - 2; j++) {
    if (j >= 2 && j < bars.length - 2) {
      if (isSwingHigh(bars, j)) swingHighs.push({ idx: j, high: bars[j].high });
      if (isSwingLow(bars, j)) swingLows.push({ idx: j, low: bars[j].low });
    }
  }
  if (swingHighs.length === 0 || swingLows.length === 0) return 0;
  const lastSwingHigh = swingHighs[swingHighs.length - 1];
  const lastSwingLow = swingLows[swingLows.length - 1];
  const cur = bars[i];
  // Bullish: low sweeps below swing low, then closes above open and above swing low
  if (cur.low < lastSwingLow.low && cur.close > cur.open && cur.close > lastSwingLow.low) return 1;
  // Bearish: high sweeps above swing high, then closes below open and below swing high
  if (cur.high > lastSwingHigh.high && cur.close < cur.open && cur.close < lastSwingHigh.high) return -1;
  return 0;
}

/** Liquidity pool: sweep of liquidity cluster (2+ swing points in tight zone). Wider lookback for cluster detection. */
export function detectLiquidityPool(bars: OHLCVBar[], i: number, lookback: number = 14): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
  const swingHighs: { idx: number; high: number }[] = [];
  const swingLows: { idx: number; low: number }[] = [];
  for (let j = i - lookback; j <= i - 2; j++) {
    if (j >= 2 && j < bars.length - 2) {
      if (isSwingHigh(bars, j)) swingHighs.push({ idx: j, high: bars[j].high });
      if (isSwingLow(bars, j)) swingLows.push({ idx: j, low: bars[j].low });
    }
  }
  const clusterTol = 0.003;
  const hasHighCluster = swingHighs.length >= 2 && safeDiv(Math.abs(swingHighs[swingHighs.length - 1]!.high - swingHighs[swingHighs.length - 2]!.high), swingHighs[swingHighs.length - 1]!.high) <= clusterTol;
  const hasLowCluster = swingLows.length >= 2 && safeDiv(Math.abs(swingLows[swingLows.length - 1]!.low - swingLows[swingLows.length - 2]!.low), swingLows[swingLows.length - 1]!.low) <= clusterTol;
  if (!hasHighCluster && !hasLowCluster) return 0;
  const lastSwingHigh = swingHighs[swingHighs.length - 1];
  const lastSwingLow = swingLows[swingLows.length - 1];
  const cur = bars[i];
  if (hasLowCluster && cur.low < lastSwingLow!.low && cur.close > cur.open && cur.close > lastSwingLow!.low) return 1;
  if (hasHighCluster && cur.high > lastSwingHigh!.high && cur.close < cur.open && cur.close < lastSwingHigh!.high) return -1;
  return 0;
}

/** Inducement: quick fake-out sweep then immediate reversal. Tighter lookback, requires wick rejection. */
export function detectInducement(bars: OHLCVBar[], i: number, lookback: number = 8): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
  const swingHighs: { idx: number; high: number }[] = [];
  const swingLows: { idx: number; low: number }[] = [];
  for (let j = i - lookback; j <= i - 2; j++) {
    if (j >= 2 && j < bars.length - 2) {
      if (isSwingHigh(bars, j)) swingHighs.push({ idx: j, high: bars[j].high });
      if (isSwingLow(bars, j)) swingLows.push({ idx: j, low: bars[j].low });
    }
  }
  if (swingHighs.length === 0 || swingLows.length === 0) return 0;
  const lastSwingHigh = swingHighs[swingHighs.length - 1];
  const lastSwingLow = swingLows[swingLows.length - 1];
  const cur = bars[i];
  const range = cur.high - cur.low;
  const lowerWick = range > 0 ? (Math.min(cur.open, cur.close) - cur.low) / range : 0;
  const upperWick = range > 0 ? (cur.high - Math.max(cur.open, cur.close)) / range : 0;
  if (cur.low < lastSwingLow!.low && cur.close > cur.open && cur.close > lastSwingLow!.low && lowerWick >= 0.4) return 1;
  if (cur.high > lastSwingHigh!.high && cur.close < cur.open && cur.close < lastSwingHigh!.high && upperWick >= 0.4) return -1;
  return 0;
}

/** Stop hunt: sweep of most recent obvious swing level. Medium lookback for key level. */
export function detectStopHunt(bars: OHLCVBar[], i: number, lookback: number = 10): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
  const swingHighs: { idx: number; high: number }[] = [];
  const swingLows: { idx: number; low: number }[] = [];
  for (let j = i - lookback; j <= i - 2; j++) {
    if (j >= 2 && j < bars.length - 2) {
      if (isSwingHigh(bars, j)) swingHighs.push({ idx: j, high: bars[j].high });
      if (isSwingLow(bars, j)) swingLows.push({ idx: j, low: bars[j].low });
    }
  }
  if (swingHighs.length === 0 || swingLows.length === 0) return 0;
  const lastSwingHigh = swingHighs[swingHighs.length - 1];
  const lastSwingLow = swingLows[swingLows.length - 1];
  const cur = bars[i];
  if (cur.low < lastSwingLow!.low && cur.close > cur.open && cur.close > lastSwingLow!.low) return 1;
  if (cur.high > lastSwingHigh!.high && cur.close < cur.open && cur.close < lastSwingHigh!.high) return -1;
  return 0;
}

/** Break of Structure (BOS): break of prior swing high (bullish) or swing low (bearish). Swing-based — no range simplification. */
export function detectBos(bars: OHLCVBar[], i: number, lookback: number = 10): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
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
  if (swingHighs.length === 0 || swingLows.length === 0) return 0;
  const lastSwingHigh = swingHighs[swingHighs.length - 1];
  const lastSwingLow = swingLows[swingLows.length - 1];
  const cur = bars[i];
  if (cur.close > lastSwingHigh.high && cur.close > cur.open) return 1;
  if (cur.close < lastSwingLow.low && cur.close < cur.open) return -1;
  return 0;
}

/** Breakout then retest: price breaks Donchian level, pulls back into range, then closes beyond confirming continuation. */
export function detectBreakoutRetest(bars: OHLCVBar[], i: number, period: number = 20): 1 | -1 | 0 {
  if (i < period + 3 || period <= 0) return 0;
  const highs = bars.slice(i - period, i).map((b) => b.high);
  const lows = bars.slice(i - period, i).map((b) => b.low);
  if (highs.length === 0 || lows.length === 0) return 0;
  const upper = Math.max(...highs);
  const lower = Math.min(...lows);
  const cur = bars[i];
  const prev = bars[i - 1];
  // Bullish: prev broke above upper, cur pulled back (low < upper) but closed above
  if (prev.close >= upper * 0.998 && cur.low < upper && cur.close > upper && cur.close > cur.open) return 1;
  // Bearish: prev broke below lower, cur pulled back (high > lower) but closed below
  if (prev.close <= lower * 1.002 && cur.high > lower && cur.close < lower && cur.close < cur.open) return -1;
  return 0;
}

/** Order Block: last opposite candle before strong move. Bullish: red candle before 2+ green with move > 1.5× OB range. Bearish: green before 2+ red. */
export function detectOrderBlock(bars: OHLCVBar[], i: number): 1 | -1 | 0 {
  if (i < 4) return 0;
  const cur = bars[i];
  const prev = bars[i - 1];
  const p2 = bars[i - 2];
  const p3 = bars[i - 3];
  // Bullish OB: p3 red, p2 and p1 green, strong up move
  if (p3.close < p3.open && p2.close > p2.open && prev.close > prev.open) {
    const move = cur.close - p3.low;
    if (move > (p3.high - p3.low) * 1.5) return 1;
  }
  // Bearish OB: p3 green, p2 and p1 red, strong down move
  if (p3.close > p3.open && p2.close < p2.open && prev.close < prev.open) {
    const move = p3.high - cur.close;
    if (move > (p3.high - p3.low) * 1.5) return -1;
  }
  return 0;
}

/** Double top: two similar swing highs within lookback. Bearish reversal. */
export function detectDoubleTop(bars: OHLCVBar[], i: number, lookback: number = 28, tolerance: number = 0.002): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
  const swingHighs: { idx: number; high: number }[] = [];
  for (let j = i - lookback; j <= i - 2; j++) {
    if (isSwingHigh(bars, j)) swingHighs.push({ idx: j, high: bars[j].high });
  }
  if (swingHighs.length < 2) return 0;
  const last = swingHighs[swingHighs.length - 1];
  const prev = swingHighs[swingHighs.length - 2];
  const diff = safeDiv(Math.abs(last.high - prev.high), prev.high);
  if (diff <= tolerance && bars[i].close < last.high) return -1; // Bearish
  return 0;
}

/** Double bottom: two similar swing lows. Bullish reversal. */
export function detectDoubleBottom(bars: OHLCVBar[], i: number, lookback: number = 28, tolerance: number = 0.002): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
  const swingLows: { idx: number; low: number }[] = [];
  for (let j = i - lookback; j <= i - 2; j++) {
    if (isSwingLow(bars, j)) swingLows.push({ idx: j, low: bars[j].low });
  }
  if (swingLows.length < 2) return 0;
  const last = swingLows[swingLows.length - 1];
  const prev = swingLows[swingLows.length - 2];
  const diff = safeDiv(Math.abs(last.low - prev.low), prev.low);
  if (diff <= tolerance && bars[i].close > last.low) return 1; // Bullish
  return 0;
}

/** Triple top: three similar swing highs. Bearish reversal. */
export function detectTripleTop(bars: OHLCVBar[], i: number, lookback: number = 28, tolerance: number = 0.002): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 6) return 0;
  const swingHighs: { idx: number; high: number }[] = [];
  for (let j = i - lookback; j <= i - 2; j++) {
    if (isSwingHigh(bars, j)) swingHighs.push({ idx: j, high: bars[j].high });
  }
  if (swingHighs.length < 3) return 0;
  const [a, b, c] = swingHighs.slice(-3);
  if (!a || !b || !c) return 0;
  const avg = (a.high + b.high + c.high) / 3;
  const diff = safeDiv(Math.max(Math.abs(a.high - avg), Math.abs(b.high - avg), Math.abs(c.high - avg)), avg);
  if (diff <= tolerance && bars[i].close < c.high) return -1;
  return 0;
}

/** Triple bottom: three similar swing lows. Bullish reversal. */
export function detectTripleBottom(bars: OHLCVBar[], i: number, lookback: number = 28, tolerance: number = 0.002): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 6) return 0;
  const swingLows: { idx: number; low: number }[] = [];
  for (let j = i - lookback; j <= i - 2; j++) {
    if (isSwingLow(bars, j)) swingLows.push({ idx: j, low: bars[j].low });
  }
  if (swingLows.length < 3) return 0;
  const [a, b, c] = swingLows.slice(-3);
  if (!a || !b || !c) return 0;
  const avg = (a.low + b.low + c.low) / 3;
  const diff = safeDiv(Math.max(Math.abs(a.low - avg), Math.abs(b.low - avg), Math.abs(c.low - avg)), avg);
  if (diff <= tolerance && bars[i].close > c.low) return 1;
  return 0;
}

/** Higher High / Higher Low (HH/HL): uptrend structure. Swing-based — compares last two swing highs and swing lows. */
export function detectHhHl(bars: OHLCVBar[], i: number, lookback: number = 10): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
  const swingHighs: { idx: number; high: number }[] = [];
  const swingLows: { idx: number; low: number }[] = [];
  for (let j = i - lookback; j <= i - 2; j++) {
    if (j >= 2 && j < bars.length - 2) {
      if (isSwingHigh(bars, j)) swingHighs.push({ idx: j, high: bars[j].high });
      if (isSwingLow(bars, j)) swingLows.push({ idx: j, low: bars[j].low });
    }
  }
  if (swingHighs.length < 2 || swingLows.length < 2) return 0;
  const [prevSh, lastSh] = swingHighs.slice(-2);
  const [prevSl, lastSl] = swingLows.slice(-2);
  if (!prevSh || !lastSh || !prevSl || !lastSl) return 0;
  if (lastSh.high > prevSh.high && lastSl.low > prevSl.low) return 1; // HH and HL
  return 0;
}

/** Lower High / Lower Low (LH/LL): downtrend structure. Swing-based — compares last two swing highs and swing lows. */
export function detectLhLl(bars: OHLCVBar[], i: number, lookback: number = 10): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
  const swingHighs: { idx: number; high: number }[] = [];
  const swingLows: { idx: number; low: number }[] = [];
  for (let j = i - lookback; j <= i - 2; j++) {
    if (j >= 2 && j < bars.length - 2) {
      if (isSwingHigh(bars, j)) swingHighs.push({ idx: j, high: bars[j].high });
      if (isSwingLow(bars, j)) swingLows.push({ idx: j, low: bars[j].low });
    }
  }
  if (swingHighs.length < 2 || swingLows.length < 2) return 0;
  const [prevSh, lastSh] = swingHighs.slice(-2);
  const [prevSl, lastSl] = swingLows.slice(-2);
  if (!prevSh || !lastSh || !prevSl || !lastSl) return 0;
  if (lastSh.high < prevSh.high && lastSl.low < prevSl.low) return -1; // LH and LL
  return 0;
}

/** Head & Shoulders: L shoulder, higher head, R shoulder; neckline break = bearish. */
export function detectHeadAndShoulders(bars: OHLCVBar[], i: number, lookback: number = 35, tolerance: number = 0.01): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
  const swingHighs: { idx: number; high: number }[] = [];
  const swingLows: { idx: number; low: number }[] = [];
  for (let j = i - lookback; j <= i; j++) {
    if (isSwingHigh(bars, j)) swingHighs.push({ idx: j, high: bars[j].high });
    if (isSwingLow(bars, j)) swingLows.push({ idx: j, low: bars[j].low });
  }
  if (swingHighs.length < 3 || swingLows.length < 2) return 0;
  const [ls, head, rs] = swingHighs.slice(-3);
  if (!ls || !head || !rs) return 0;
  if (head.high <= ls.high || head.high <= rs.high) return 0;
  const neckLow1 = swingLows.find((s) => s.idx > ls.idx && s.idx < head.idx);
  const neckLow2 = swingLows.find((s) => s.idx > head.idx && s.idx < rs.idx);
  if (!neckLow1 || !neckLow2) return 0;
  const neckline = (neckLow1.low + neckLow2.low) / 2;
  if (bars[i].close < neckline * (1 - tolerance)) return -1;
  return 0;
}

/** Inverse Head & Shoulders: L shoulder, lower head, R shoulder; neckline break = bullish. */
export function detectInverseHeadAndShoulders(bars: OHLCVBar[], i: number, lookback: number = 35, tolerance: number = 0.01): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
  const swingHighs: { idx: number; high: number }[] = [];
  const swingLows: { idx: number; low: number }[] = [];
  for (let j = i - lookback; j <= i; j++) {
    if (isSwingHigh(bars, j)) swingHighs.push({ idx: j, high: bars[j].high });
    if (isSwingLow(bars, j)) swingLows.push({ idx: j, low: bars[j].low });
  }
  if (swingLows.length < 3 || swingHighs.length < 2) return 0;
  const [ls, head, rs] = swingLows.slice(-3);
  if (!ls || !head || !rs) return 0;
  if (head.low >= ls.low || head.low >= rs.low) return 0;
  const neckHigh1 = swingHighs.find((s) => s.idx > ls.idx && s.idx < head.idx);
  const neckHigh2 = swingHighs.find((s) => s.idx > head.idx && s.idx < rs.idx);
  if (!neckHigh1 || !neckHigh2) return 0;
  const neckline = (neckHigh1.high + neckHigh2.high) / 2;
  if (bars[i].close > neckline * (1 + tolerance)) return 1;
  return 0;
}

/** Cup and Handle: U-shaped trough then small pullback; breakout above handle = bullish. */
export function detectCupAndHandle(bars: OHLCVBar[], i: number, lookback: number = 35, cupMinBars: number = 12): 1 | -1 | 0 {
  if (i < lookback + cupMinBars || lookback <= 0 || cupMinBars <= 0) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  const lows = slice.map((b) => b.low);
  if (lows.length === 0) return 0;
  const minIdx = lows.indexOf(Math.min(...lows));
  if (minIdx < 3 || minIdx > slice.length - 5) return 0;
  const left = slice.slice(0, minIdx + 1);
  const right = slice.slice(minIdx);
  const cupLow = lows[minIdx];
  if (left.length === 0 || right.length === 0) return 0;
  const rimLeft = Math.max(...left.map((b) => b.high));
  const rimRight = Math.max(...right.map((b) => b.high));
  const rimLevel = (rimLeft + rimRight) / 2;
  if (safeDiv(Math.abs(rimLeft - rimRight), rimLevel) > 0.03) return 0;
  const handle = right.slice(-5);
  if (handle.length === 0) return 0;
  const handleHigh = Math.max(...handle.map((b) => b.high));
  if (handleHigh >= rimLevel * 1.002) return 0;
  if (bars[i].close > handleHigh && bars[i].close > bars[i].open) return 1;
  return 0;
}

/** Inverse Cup and Handle: inverted U then small rally; breakdown = bearish. */
export function detectInverseCupAndHandle(bars: OHLCVBar[], i: number, lookback: number = 35, cupMinBars: number = 12): 1 | -1 | 0 {
  if (i < lookback + cupMinBars || lookback <= 0 || cupMinBars <= 0) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  const highs = slice.map((b) => b.high);
  if (highs.length === 0) return 0;
  const maxIdx = highs.indexOf(Math.max(...highs));
  if (maxIdx < 3 || maxIdx > slice.length - 5) return 0;
  const left = slice.slice(0, maxIdx + 1);
  const right = slice.slice(maxIdx);
  const cupHigh = highs[maxIdx];
  if (left.length === 0 || right.length === 0) return 0;
  const rimLeft = Math.min(...left.map((b) => b.low));
  const rimRight = Math.min(...right.map((b) => b.low));
  const rimLevel = (rimLeft + rimRight) / 2;
  if (safeDiv(Math.abs(rimLeft - rimRight), rimLevel) > 0.03) return 0;
  const handle = right.slice(-5);
  if (handle.length === 0) return 0;
  const handleLow = Math.min(...handle.map((b) => b.low));
  if (handleLow <= rimLevel * 0.998) return 0;
  if (bars[i].close < handleLow && bars[i].close < bars[i].open) return -1;
  return 0;
}

/** Ascending broadening: expanding range with both trendlines rising (higher highs, higher lows). */
export function detectAscendingBroadening(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 2) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  const highs = slice.map((b) => b.high);
  const lows = slice.map((b) => b.low);
  const mid = Math.floor(slice.length / 2);
  const firstHalfHighs = highs.slice(0, mid);
  const secondHalfHighs = highs.slice(mid);
  const firstHalfLows = lows.slice(0, mid);
  const secondHalfLows = lows.slice(mid);
  if (firstHalfHighs.length === 0 || secondHalfHighs.length === 0 || firstHalfLows.length === 0 || secondHalfLows.length === 0) return 0;
  const firstHigh = Math.max(...firstHalfHighs);
  const secondHigh = Math.max(...secondHalfHighs);
  const firstLow = Math.min(...firstHalfLows);
  const secondLow = Math.min(...secondHalfLows);
  if (secondHigh <= firstHigh || secondLow <= firstLow) return 0;
  const expanding = (secondHigh - firstHigh) + (secondLow - firstLow) > 0;
  if (!expanding) return 0;
  const recentHighs = highs.slice(-3);
  const recentLows = lows.slice(-3);
  if (recentHighs.length === 0 || recentLows.length === 0) return 0;
  if (bars[i].close > bars[i].open && bars[i].close > Math.max(...recentHighs)) return 1;
  if (bars[i].close < bars[i].open && bars[i].close < Math.min(...recentLows)) return -1;
  return 0;
}

/** Descending broadening: both trendlines falling (lower highs, lower lows); breakout at extremes. */
export function detectDescendingBroadening(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 2) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  const highs = slice.map((b) => b.high);
  const lows = slice.map((b) => b.low);
  const mid = Math.floor(slice.length / 2);
  const firstHalfHighs = highs.slice(0, mid);
  const secondHalfHighs = highs.slice(mid);
  const firstHalfLows = lows.slice(0, mid);
  const secondHalfLows = lows.slice(mid);
  if (firstHalfHighs.length === 0 || secondHalfHighs.length === 0 || firstHalfLows.length === 0 || secondHalfLows.length === 0) return 0;
  const firstHigh = Math.max(...firstHalfHighs);
  const secondHigh = Math.max(...secondHalfHighs);
  const firstLow = Math.min(...firstHalfLows);
  const secondLow = Math.min(...secondHalfLows);
  if (secondHigh < firstHigh && secondLow < firstLow) {
    const recentHighs = highs.slice(-3);
    const recentLows = lows.slice(-3);
    if (recentHighs.length === 0 || recentLows.length === 0) return 0;
    if (bars[i].close > bars[i].open && bars[i].close > Math.max(...recentHighs)) return 1;
    if (bars[i].close < bars[i].open && bars[i].close < Math.min(...recentLows)) return -1;
  }
  return 0;
}

/** Broadening formation: expanding range (higher highs, lower lows); reversal at extremes. */
export function detectBroadening(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 2) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  const highs = slice.map((b) => b.high);
  const lows = slice.map((b) => b.low);
  const mid = Math.floor(slice.length / 2);
  const firstHalfHighs = highs.slice(0, mid);
  const secondHalfHighs = highs.slice(mid);
  const firstHalfLows = lows.slice(0, mid);
  const secondHalfLows = lows.slice(mid);
  if (firstHalfHighs.length === 0 || secondHalfHighs.length === 0 || firstHalfLows.length === 0 || secondHalfLows.length === 0) return 0;
  const firstHigh = Math.max(...firstHalfHighs);
  const secondHigh = Math.max(...secondHalfHighs);
  const firstLow = Math.min(...firstHalfLows);
  const secondLow = Math.min(...secondHalfLows);
  if (secondHigh > firstHigh && secondLow < firstLow) {
    if (bars[i].close > bars[i].open && bars[i].close > slice[mid]?.close) return 1;
    if (bars[i].close < bars[i].open && bars[i].close < slice[mid]?.close) return -1;
  }
  return 0;
}

/** Wedge rising: converging trendlines, both sloping up; breakout down = bearish. */
export function detectWedgeRising(bars: OHLCVBar[], i: number, lookback: number = 22): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 2) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  if (slice.length < 2) return 0;
  const highs = slice.map((b) => b.high);
  const lows = slice.map((b) => b.low);
  const range = Math.max(...highs) - Math.min(...lows);
  if (range <= 0) return 0;
  const slopeH = (highs[highs.length - 1]! - highs[0]!) / slice.length;
  const slopeL = (lows[lows.length - 1]! - lows[0]!) / slice.length;
  if (slopeH > 0 && slopeL > 0 && slopeH > slopeL * 1.2) {
    const recentLows = lows.slice(-3);
    if (recentLows.length === 0) return 0;
    if (bars[i].close < Math.min(...recentLows)) return -1;
  }
  return 0;
}

/** Wedge falling: converging trendlines, both sloping down; breakout up = bullish. */
export function detectWedgeFalling(bars: OHLCVBar[], i: number, lookback: number = 22): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 2) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  if (slice.length < 2) return 0;
  const highs = slice.map((b) => b.high);
  const lows = slice.map((b) => b.low);
  const slopeH = (highs[highs.length - 1]! - highs[0]!) / slice.length;
  const slopeL = (lows[lows.length - 1]! - lows[0]!) / slice.length;
  if (slopeH < 0 && slopeL < 0 && slopeL < slopeH * 1.2) {
    const recentHighs = highs.slice(-3);
    if (recentHighs.length === 0) return 0;
    if (bars[i].close > Math.max(...recentHighs)) return 1;
  }
  return 0;
}

/** Rounding bottom (saucer): gradual U-shaped bottom; break above resistance. */
export function detectRoundingBottom(bars: OHLCVBar[], i: number, lookback: number = 22): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 2) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  const closes = slice.map((b) => b.close);
  const mid = Math.floor(lookback / 2);
  const first = closes.slice(0, mid);
  const second = closes.slice(mid);
  if (first.length === 0 || second.length === 0) return 0;
  const minFirst = Math.min(...first);
  const minSecond = Math.min(...second);
  const last = closes[closes.length - 1]!;
  const resistance = Math.max(...closes.slice(0, mid));
  if (minSecond >= minFirst * 0.998 && last > resistance * 1.001 && bars[i].close > bars[i].open) return 1;
  return 0;
}

/** Rounding top: gradual inverted U; break below support. */
export function detectRoundingTop(bars: OHLCVBar[], i: number, lookback: number = 22): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 2) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  const closes = slice.map((b) => b.close);
  const mid = Math.floor(lookback / 2);
  const first = closes.slice(0, mid);
  const second = closes.slice(mid);
  if (first.length === 0 || second.length === 0) return 0;
  const maxFirst = Math.max(...first);
  const maxSecond = Math.max(...second);
  const last = closes[closes.length - 1]!;
  const support = Math.min(...closes.slice(0, mid));
  if (maxSecond <= maxFirst * 1.002 && last < support * 0.999 && bars[i].close < bars[i].open) return -1;
  return 0;
}

/** Inside bar: mother (i-2), inside (i-1), breakout (i). Breakout of mother bar. */
export function detectInsideBar(bars: OHLCVBar[], i: number): 1 | -1 | 0 {
  if (i < 3) return 0;
  const mother = bars[i - 2];
  const inside = bars[i - 1];
  const cur = bars[i];
  if (inside.high >= mother.high || inside.low <= mother.low) return 0;
  if (cur.close > mother.high && cur.close > cur.open) return 1;
  if (cur.close < mother.low && cur.close < cur.open) return -1;
  return 0;
}

/** Outside bar: current range engulfs prior. Momentum in close direction. */
export function detectOutsideBar(bars: OHLCVBar[], i: number): 1 | -1 | 0 {
  if (i < 2) return 0;
  const cur = bars[i];
  const prev = bars[i - 1];
  if (cur.high <= prev.high || cur.low >= prev.low) return 0;
  if (cur.close > cur.open && cur.close > prev.high) return 1;
  if (cur.close < cur.open && cur.close < prev.low) return -1;
  return 0;
}

/** Key reversal Day: new high then close below prior close (bearish). New low then close above prior close (bullish). */
export function detectKeyReversal(bars: OHLCVBar[], i: number): 1 | -1 | 0 {
  if (i < 2) return 0;
  const cur = bars[i];
  const prev = bars[i - 1];
  if (cur.high > prev.high && cur.close < prev.close && cur.close < cur.open) return -1;
  if (cur.low < prev.low && cur.close > prev.close && cur.close > cur.open) return 1;
  return 0;
}

/** Island reversal: gap, trade in range, gap opposite. Bullish: gap down then gap up; bearish: gap up then gap down. */
export function detectIslandReversal(bars: OHLCVBar[], i: number, minGapPct: number = 0.001): 1 | -1 | 0 {
  if (i < 4) return 0;
  const cur = bars[i];
  const prev = bars[i - 1];
  const before = bars[i - 2];
  const p3 = bars[i - 3];
  const gapDown = prev.high < before.low * (1 - minGapPct);
  const gapUp = prev.low > before.high * (1 + minGapPct);
  const gapUpAfter = cur.low > prev.high * (1 + minGapPct);
  const gapDownAfter = cur.high < prev.low * (1 - minGapPct);
  if (gapDown && gapUpAfter && cur.close > cur.open) return 1;
  if (gapUp && gapDownAfter && cur.close < cur.open) return -1;
  return 0;
}

/** Ascending channel: price in rising parallel. Touch lower line = long; touch upper = short. */
export function detectChannelUp(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 2) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  if (slice.length < 2) return 0;
  const highs = slice.map((b) => b.high);
  const lows = slice.map((b) => b.low);
  const slopeH = (highs[highs.length - 1]! - highs[0]!) / slice.length;
  const slopeL = (lows[lows.length - 1]! - lows[0]!) / slice.length;
  if (slopeH <= 0 || slopeL <= 0) return 0;
  const lowerLine = lows[0]! + slopeL * (slice.length - 1);
  const upperLine = highs[0]! + slopeH * (slice.length - 1);
  const price = bars[i].close;
  const tol = (upperLine - lowerLine) * 0.05;
  if (price <= lowerLine + tol && bars[i].close > bars[i].open) return 1;
  if (price >= upperLine - tol && bars[i].close < bars[i].open) return -1;
  return 0;
}

/** Descending channel: price in falling parallel. */
export function detectChannelDown(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 2) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  if (slice.length < 2) return 0;
  const highs = slice.map((b) => b.high);
  const lows = slice.map((b) => b.low);
  const slopeH = (highs[highs.length - 1]! - highs[0]!) / slice.length;
  const slopeL = (lows[lows.length - 1]! - lows[0]!) / slice.length;
  if (slopeH >= 0 || slopeL >= 0) return 0;
  const lowerLine = lows[0]! + slopeL * (slice.length - 1);
  const upperLine = highs[0]! + slopeH * (slice.length - 1);
  const price = bars[i].close;
  const tol = (upperLine - lowerLine) * 0.05;
  if (price <= lowerLine + tol && bars[i].close > bars[i].open) return 1;
  if (price >= upperLine - tol && bars[i].close < bars[i].open) return -1;
  return 0;
}

/** Fib retracement: buy at pullback down from high, sell at pullback up from low. */
export function detectFibRetracement(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
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
  if (swingHighs.length === 0 || swingLows.length === 0) return 0;
  const sh = swingHighs[swingHighs.length - 1]!;
  const sl = swingLows[swingLows.length - 1]!;
  const price = bars[i].close;
  const tolPct = 0.03;
  if (sh.idx > sl.idx) {
    const range = sh.high - sl.low;
    if (range <= 0) return 0;
    const tol = range * tolPct;
    const fib382 = sh.high - range * 0.382;
    const fib5 = sh.high - range * 0.5;
    const fib618 = sh.high - range * 0.618;
    const nearFib = Math.abs(price - fib382) < tol || Math.abs(price - fib5) < tol || Math.abs(price - fib618) < tol;
    if (nearFib && bars[i].close > bars[i].open) return 1;
  } else {
    const range = sh.high - sl.low;
    if (range <= 0) return 0;
    const tol = range * tolPct;
    const fib382 = sl.low + range * 0.382;
    const fib5 = sl.low + range * 0.5;
    const fib618 = sl.low + range * 0.618;
    const nearFib = Math.abs(price - fib382) < tol || Math.abs(price - fib5) < tol || Math.abs(price - fib618) < tol;
    if (nearFib && bars[i].close < bars[i].open) return -1;
  }
  return 0;
}

/** Harmonic Gartley: XABCD, B=0.618 XA, D=0.786 XA. Uses swing points for X and A. */
export function detectHarmonicGartley(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
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
  if (swingHighs.length === 0 || swingLows.length === 0) return 0;
  const sh = swingHighs[swingHighs.length - 1]!;
  const sl = swingLows[swingLows.length - 1]!;
  const price = bars[i].close;
  const range = sh.high - sl.low;
  if (range <= 0) return 0;
  const tol = range * 0.03;
  if (sh.idx > sl.idx) {
    const d = sh.high - range * 0.786;
    if (Math.abs(price - d) < tol && bars[i].close > bars[i].open) return 1;
  } else {
    const d = sl.low + range * 0.786;
    if (Math.abs(price - d) < tol && bars[i].close < bars[i].open) return -1;
  }
  return 0;
}

/** Harmonic Bat: B shallow (0.382-0.5), D=0.886 XA. Uses swing points. */
export function detectHarmonicBat(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
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
  if (swingHighs.length === 0 || swingLows.length === 0) return 0;
  const sh = swingHighs[swingHighs.length - 1]!;
  const sl = swingLows[swingLows.length - 1]!;
  const price = bars[i].close;
  const range = sh.high - sl.low;
  if (range <= 0) return 0;
  const tol = range * 0.03;
  if (sh.idx > sl.idx) {
    const d = sh.high - range * 0.886;
    if (Math.abs(price - d) < tol && bars[i].close > bars[i].open) return 1;
  } else {
    const d = sl.low + range * 0.886;
    if (Math.abs(price - d) < tol && bars[i].close < bars[i].open) return -1;
  }
  return 0;
}

/** Harmonic Butterfly: B deep (0.786), D=1.27 or 1.618 extension beyond XA. Swing-based. */
export function detectHarmonicButterfly(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
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
  if (swingHighs.length === 0 || swingLows.length === 0) return 0;
  const sh = swingHighs[swingHighs.length - 1]!;
  const sl = swingLows[swingLows.length - 1]!;
  const price = bars[i].close;
  const range = sh.high - sl.low;
  if (range <= 0) return 0;
  const tol = range * 0.03;
  if (sh.idx > sl.idx) {
    const d127 = sl.low + range * 1.27;
    const d1618 = sl.low + range * 1.618;
    if ((Math.abs(price - d127) < tol || Math.abs(price - d1618) < tol) && bars[i].close > bars[i].open) return 1;
  } else {
    const d127 = sh.high - range * 1.27;
    const d1618 = sh.high - range * 1.618;
    if ((Math.abs(price - d127) < tol || Math.abs(price - d1618) < tol) && bars[i].close < bars[i].open) return -1;
  }
  return 0;
}

/** Harmonic Crab: D=1.618 extension beyond XA. Swing-based. */
export function detectHarmonicCrab(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
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
  if (swingHighs.length === 0 || swingLows.length === 0) return 0;
  const sh = swingHighs[swingHighs.length - 1]!;
  const sl = swingLows[swingLows.length - 1]!;
  const price = bars[i].close;
  const range = sh.high - sl.low;
  if (range <= 0) return 0;
  const tol = range * 0.03;
  if (sh.idx > sl.idx) {
    const d = sl.low + range * 1.618;
    if (Math.abs(price - d) < tol && bars[i].close > bars[i].open) return 1;
  } else {
    const d = sh.high - range * 1.618;
    if (Math.abs(price - d) < tol && bars[i].close < bars[i].open) return -1;
  }
  return 0;
}

/** Harmonic Shark: 1.41 or 2.24 extension beyond XA. Swing-based. */
export function detectHarmonicShark(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
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
  if (swingHighs.length === 0 || swingLows.length === 0) return 0;
  const sh = swingHighs[swingHighs.length - 1]!;
  const sl = swingLows[swingLows.length - 1]!;
  const price = bars[i].close;
  const range = sh.high - sl.low;
  if (range <= 0) return 0;
  const tol = range * 0.04;
  if (sh.idx > sl.idx) {
    const d141 = sl.low + range * 1.41;
    const d224 = sl.low + range * 2.24;
    if ((Math.abs(price - d141) < tol || Math.abs(price - d224) < tol) && bars[i].close > bars[i].open) return 1;
  } else {
    const d141 = sh.high - range * 1.41;
    const d224 = sh.high - range * 2.24;
    if ((Math.abs(price - d141) < tol || Math.abs(price - d224) < tol) && bars[i].close < bars[i].open) return -1;
  }
  return 0;
}

/** Three drives: three equal legs; leg3 = 1.27 or 1.618 of leg1/2. Uses swing points. */
export function detectThreeDrives(bars: OHLCVBar[], i: number, lookback: number = 14): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 6) return 0;
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
  if (swingLows.length >= 3) {
    const [d1, d2, d3] = swingLows.slice(-3);
    if (d2!.low > d1!.low && d3!.low > d2!.low) {
      const leg1 = d2!.low - d1!.low;
      const leg2 = d3!.low - d2!.low;
      if (leg1 > 0 && (Math.abs(leg2 - leg1 * 1.27) < leg1 * 0.2 || Math.abs(leg2 - leg1 * 1.618) < leg1 * 0.2))
        if (bars[i].close > bars[i].open) return 1;
    }
  }
  if (swingHighs.length >= 3) {
    const [h1, h2, h3] = swingHighs.slice(-3);
    if (h2!.high < h1!.high && h3!.high < h2!.high) {
      const leg1 = h1!.high - h2!.high;
      const leg2 = h2!.high - h3!.high;
      if (leg1 > 0 && (Math.abs(leg2 - leg1 * 1.27) < leg1 * 0.2 || Math.abs(leg2 - leg1 * 1.618) < leg1 * 0.2))
        if (bars[i].close < bars[i].open) return -1;
    }
  }
  return 0;
}

/** Cypher: 0.382 XA, 0.786 BC. D = 0.786 of XC. Swing-based. */
export function detectCypher(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
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
  if (swingHighs.length === 0 || swingLows.length === 0) return 0;
  const sh = swingHighs[swingHighs.length - 1]!;
  const sl = swingLows[swingLows.length - 1]!;
  const price = bars[i].close;
  const range = sh.high - sl.low;
  if (range <= 0) return 0;
  const tol = range * 0.03;
  if (sh.idx > sl.idx) {
    const d = sh.high - range * 0.786;
    if (Math.abs(price - d) < tol && bars[i].close > bars[i].open) return 1;
  } else {
    const d = sl.low + range * 0.786;
    if (Math.abs(price - d) < tol && bars[i].close < bars[i].open) return -1;
  }
  return 0;
}

/** Diamond: broadening then contracting; breakout in direction of close. */
export function detectDiamond(bars: OHLCVBar[], i: number, lookback: number = 28): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 2) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  const mid = Math.floor(slice.length / 2);
  const firstHalf = slice.slice(0, mid);
  const secondHalf = slice.slice(mid);
  if (firstHalf.length === 0 || secondHalf.length === 0) return 0;
  const range1 = Math.max(...firstHalf.map((b) => b.high)) - Math.min(...firstHalf.map((b) => b.low));
  const range2 = Math.max(...secondHalf.map((b) => b.high)) - Math.min(...secondHalf.map((b) => b.low));
  if (range1 <= 0 || range2 <= 0) return 0;
  const expanding = range2 > range1 * 1.1;
  const contracting = range2 < range1 * 0.9;
  if (expanding && i >= lookback + 12) {
    const recent = slice.slice(-8);
    const recentRange = Math.max(...recent.map((b) => b.high)) - Math.min(...recent.map((b) => b.low));
    if (recentRange < range2 * 0.7 && bars[i].close > bars[i].open) return 1;
    if (recentRange < range2 * 0.7 && bars[i].close < bars[i].open) return -1;
  }
  return 0;
}

/** Symmetric triangle: converging trendlines (lower highs, higher lows); breakout in close direction. */
export function detectTriangleSymmetric(bars: OHLCVBar[], i: number, lookback: number = 24): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 4) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  const highs = slice.map((b) => b.high);
  const lows = slice.map((b) => b.low);
  const mid = Math.floor(slice.length / 2);
  const firstHalfHighs = highs.slice(0, mid);
  const secondHalfHighs = highs.slice(mid);
  const firstHalfLows = lows.slice(0, mid);
  const secondHalfLows = lows.slice(mid);
  if (firstHalfHighs.length === 0 || secondHalfHighs.length === 0 || firstHalfLows.length === 0 || secondHalfLows.length === 0) return 0;
  const firstHigh = Math.max(...firstHalfHighs);
  const secondHigh = Math.max(...secondHalfHighs);
  const firstLow = Math.min(...firstHalfLows);
  const secondLow = Math.min(...secondHalfLows);
  if (secondHigh >= firstHigh * 0.998 || secondLow <= firstLow * 1.002) return 0;
  const recentHighs = highs.slice(-5);
  const recentLows = lows.slice(-5);
  if (recentHighs.length === 0 || recentLows.length === 0) return 0;
  const upper = Math.max(...recentHighs);
  const lower = Math.min(...recentLows);
  if (bars[i].close > upper && bars[i].close > bars[i].open) return 1;
  if (bars[i].close < lower && bars[i].close < bars[i].open) return -1;
  return 0;
}

/** Ascending triangle: flat top, rising bottom; breakout up. */
export function detectTriangleAscending(bars: OHLCVBar[], i: number, lookback: number = 24): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 4) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  if (slice.length < 2) return 0;
  const highs = slice.map((b) => b.high);
  const lows = slice.map((b) => b.low);
  const resistance = Math.max(...highs);
  const resTol = resistance * 0.003;
  const flatTop = highs.filter((h) => Math.abs(h - resistance) <= resTol).length >= 2;
  const slopeL = (lows[lows.length - 1]! - lows[0]!) / slice.length;
  if (!flatTop || slopeL <= 0) return 0;
  if (bars[i].close > resistance && bars[i].close > bars[i].open) return 1;
  return 0;
}

/** Descending triangle: flat bottom, falling top; breakout down. */
export function detectTriangleDescending(bars: OHLCVBar[], i: number, lookback: number = 24): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 4) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  if (slice.length < 2) return 0;
  const highs = slice.map((b) => b.high);
  const lows = slice.map((b) => b.low);
  const support = Math.min(...lows);
  const supTol = support * 0.003;
  const flatBottom = lows.filter((l) => Math.abs(l - support) <= supTol).length >= 2;
  const slopeH = (highs[highs.length - 1]! - highs[0]!) / slice.length;
  if (!flatBottom || slopeH >= 0) return 0;
  if (bars[i].close < support && bars[i].close < bars[i].open) return -1;
  return 0;
}

/** Bull flag: strong up move, small down consolidation, breakout above flag high. */
export function detectFlagBull(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 5) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  const poleStart = i - lookback;
  const poleEnd = poleStart + Math.floor(lookback * 0.4);
  if (poleEnd >= slice.length - 4) return 0;
  const pole = slice.slice(0, poleEnd - poleStart + 1);
  const flag = slice.slice(poleEnd - poleStart);
  if (pole.length === 0 || flag.length === 0) return 0;
  const poleUp = (pole[pole.length - 1]?.close ?? 0) - (pole[0]?.close ?? 0);
  const poleRange = Math.max(...pole.map((b) => b.high)) - Math.min(...pole.map((b) => b.low));
  if (poleUp <= 0 || poleRange <= 0) return 0;
  const flagHigh = Math.max(...flag.map((b) => b.high));
  const flagLow = Math.min(...flag.map((b) => b.low));
  if (flagHigh - flagLow >= poleRange * 0.5) return 0;
  if (bars[i].close > flagHigh && bars[i].close > bars[i].open) return 1;
  return 0;
}

/** Bear flag: strong down move, small up consolidation, breakout below flag low. */
export function detectFlagBear(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 5) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  const poleStart = 0;
  const poleEnd = Math.floor(lookback * 0.4);
  if (poleEnd >= slice.length - 4) return 0;
  const pole = slice.slice(poleStart, poleEnd + 1);
  const flag = slice.slice(poleEnd);
  if (pole.length === 0 || flag.length === 0) return 0;
  const poleDown = (pole[0]?.close ?? 0) - (pole[pole.length - 1]?.close ?? 0);
  const poleRange = Math.max(...pole.map((b) => b.high)) - Math.min(...pole.map((b) => b.low));
  if (poleDown <= 0 || poleRange <= 0) return 0;
  const flagHigh = Math.max(...flag.map((b) => b.high));
  const flagLow = Math.min(...flag.map((b) => b.low));
  if (flagHigh - flagLow >= poleRange * 0.5) return 0;
  if (bars[i].close < flagLow && bars[i].close < bars[i].open) return -1;
  return 0;
}

/** Pennant: small symmetric triangle after strong move; breakout in trend direction. */
export function detectPennant(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 5) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  const firstHalf = slice.slice(0, Math.floor(slice.length / 2));
  const secondHalf = slice.slice(Math.floor(slice.length / 2));
  if (firstHalf.length === 0 || secondHalf.length === 0) return 0;
  const move1 = (firstHalf[firstHalf.length - 1]?.close ?? 0) - (firstHalf[0]?.close ?? 0);
  const range1 = Math.max(...firstHalf.map((b) => b.high)) - Math.min(...firstHalf.map((b) => b.low));
  if (range1 <= 0) return 0;
  const recentHigh = Math.max(...secondHalf.map((b) => b.high));
  const recentLow = Math.min(...secondHalf.map((b) => b.low));
  if (move1 > 0 && bars[i].close > recentHigh && bars[i].close > bars[i].open) return 1;
  if (move1 < 0 && bars[i].close < recentLow && bars[i].close < bars[i].open) return -1;
  return 0;
}

/** Rectangle: horizontal range; breakout above/below. */
export function detectRectangle(bars: OHLCVBar[], i: number, lookback: number = 24, tolerance: number = 0.005): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 3) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  if (slice.length === 0) return 0;
  const upper = Math.max(...slice.map((b) => b.high));
  const lower = Math.min(...slice.map((b) => b.low));
  const range = upper - lower;
  if (range <= 0) return 0;
  const cur = bars[i];
  if (cur.close > upper * (1 + tolerance) && cur.close > cur.open) return 1;
  if (cur.close < lower * (1 - tolerance) && cur.close < cur.open) return -1;
  return 0;
}

/** Gap up: current low > prior high. Continuation up = bullish. */
export function detectGapUp(bars: OHLCVBar[], i: number, minGapPct: number = 0.001): 1 | -1 | 0 {
  if (i < 2) return 0;
  const cur = bars[i];
  const prev = bars[i - 1];
  if (cur.low <= prev.high * (1 + minGapPct)) return 0;
  if (cur.close > cur.open && cur.close > cur.high * 0.99) return 1;
  return 0;
}

/** Gap down: current high < prior low. Continuation down = bearish. */
export function detectGapDown(bars: OHLCVBar[], i: number, minGapPct: number = 0.001): 1 | -1 | 0 {
  if (i < 2) return 0;
  const cur = bars[i];
  const prev = bars[i - 1];
  if (cur.high >= prev.low * (1 - minGapPct)) return 0;
  if (cur.close < cur.open && cur.close < cur.low * 1.01) return -1;
  return 0;
}

/** Rising window (3-candle): gap between c1 and c3, c3 bullish. */
export function detectRisingWindow(bars: OHLCVBar[], i: number): 1 | -1 | 0 {
  if (i < 2) return 0;
  const c1 = bars[i - 2], c3 = bars[i];
  if (c1.high >= c3.low) return 0;
  if (c3.close > c3.open && c3.close > c3.high * 0.99) return 1;
  return 0;
}

/** Falling window (3-candle): gap between c1 and c3, c3 bearish. */
export function detectFallingWindow(bars: OHLCVBar[], i: number): 1 | -1 | 0 {
  if (i < 2) return 0;
  const c1 = bars[i - 2], c3 = bars[i];
  if (c1.low <= c3.high) return 0;
  if (c3.close < c3.open && c3.close < c3.low * 1.01) return -1;
  return 0;
}

/** Bump and run: parabolic move up then break of trendline = bearish; down then break = bullish. */
export function detectBumpAndRun(bars: OHLCVBar[], i: number, lookback: number = 28): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  const highs = slice.map((b) => b.high);
  const lows = slice.map((b) => b.low);
  const slopeL = (lows[lows.length - 1]! - lows[0]!) / slice.length;
  const slopeH = (highs[highs.length - 1]! - highs[0]!) / slice.length;
  if (slopeL > 0 && slopeH > 0) {
    const trendline = lows[0]! + slopeL * (slice.length - 1);
    if (bars[i].close < trendline * 0.998 && bars[i].close < bars[i].open) return -1;
  } else if (slopeL < 0 && slopeH < 0) {
    const trendline = highs[0]! + slopeH * (slice.length - 1);
    if (bars[i].close > trendline * 1.002 && bars[i].close > bars[i].open) return 1;
  }
  return 0;
}

/** Fakeout: price breaks swing level then reverses (false breakout). Swing-based — levels at swing points. */
export function detectFakeout(bars: OHLCVBar[], i: number, lookback: number = 12): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
  const swingHighs: { idx: number; high: number }[] = [];
  const swingLows: { idx: number; low: number }[] = [];
  for (let j = i - lookback; j <= i - 2; j++) {
    if (j >= 2 && j < bars.length - 2) {
      if (isSwingHigh(bars, j)) swingHighs.push({ idx: j, high: bars[j].high });
      if (isSwingLow(bars, j)) swingLows.push({ idx: j, low: bars[j].low });
    }
  }
  if (swingHighs.length === 0 || swingLows.length === 0) return 0;
  const lastSwingHigh = swingHighs[swingHighs.length - 1];
  const lastSwingLow = swingLows[swingLows.length - 1];
  if (!lastSwingHigh || !lastSwingLow) return 0;
  const prev = bars[i - 1];
  const cur = bars[i];
  if (prev.close >= lastSwingHigh.high * 0.998 && cur.close < lastSwingLow.low && cur.close < cur.open) return -1;
  if (prev.close <= lastSwingLow.low * 1.002 && cur.close > lastSwingHigh.high && cur.close > cur.open) return 1;
  return 0;
}

/** Equal highs/lows: two swing highs or two swing lows at similar level; break of neckline. Dedicated logic. */
export function detectEqualHighsLows(bars: OHLCVBar[], i: number, lookback: number = 18, tolerance: number = 0.002): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
  const swingHighs: { idx: number; high: number }[] = [];
  const swingLows: { idx: number; low: number }[] = [];
  for (let j = i - lookback; j <= i - 2; j++) {
    if (isSwingHigh(bars, j)) swingHighs.push({ idx: j, high: bars[j].high });
    if (isSwingLow(bars, j)) swingLows.push({ idx: j, low: bars[j].low });
  }
  if (swingHighs.length >= 2) {
    const last = swingHighs[swingHighs.length - 1];
    const prev = swingHighs[swingHighs.length - 2];
    const diff = safeDiv(Math.abs(last.high - prev.high), prev.high);
    if (diff <= tolerance) {
      const neckSlice = bars.slice(Math.min(prev.idx, last.idx), Math.max(prev.idx, last.idx) + 1);
      if (neckSlice.length === 0) return 0;
      const neckLow = Math.min(...neckSlice.map((b) => b.low));
      if (bars[i].close < neckLow && bars[i].close < bars[i].open) return -1;
    }
  }
  if (swingLows.length >= 2) {
    const last = swingLows[swingLows.length - 1];
    const prev = swingLows[swingLows.length - 2];
    const diff = safeDiv(Math.abs(last.low - prev.low), prev.low);
    if (diff <= tolerance) {
      const neckSlice = bars.slice(Math.min(prev.idx, last.idx), Math.max(prev.idx, last.idx) + 1);
      if (neckSlice.length === 0) return 0;
      const neckHigh = Math.max(...neckSlice.map((b) => b.high));
      if (bars[i].close > neckHigh && bars[i].close > bars[i].open) return 1;
    }
  }
  return 0;
}

/** S/R flip: prior support becomes resistance (bearish) or prior resistance becomes support (bullish). */
export function detectSrFlip(bars: OHLCVBar[], i: number, lookback: number = 12): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 3) return 0;
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
  if (swingHighs.length < 1 || swingLows.length < 1) return 0;
  const res = Math.min(...swingHighs);
  const sup = Math.max(...swingLows);
  const cur = bars[i];
  const tol = (res - sup) * 0.02;
  if (cur.close < sup - tol && cur.close < cur.open && cur.high >= sup - tol) return -1;
  if (cur.close > res + tol && cur.close > cur.open && cur.low <= res + tol) return 1;
  return 0;
}

/** Trendline break: price breaks linear trendline (support/resistance). */
export function detectTrendlineBreak(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback < 2 || i < lookback + 3) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  if (slice.length < 2) return 0;
  const highs = slice.map((b) => b.high);
  const lows = slice.map((b) => b.low);
  const slopeH = (highs[highs.length - 1]! - highs[0]!) / slice.length;
  const slopeL = (lows[lows.length - 1]! - lows[0]!) / slice.length;
  const cur = bars[i];
  if (slopeH < 0 && slopeL < 0) {
    const tl = lows[0]! + slopeL * (slice.length - 1);
    if (cur.close < tl * 0.998 && cur.close < cur.open) return -1;
  }
  if (slopeH > 0 && slopeL > 0) {
    const tl = highs[0]! + slopeH * (slice.length - 1);
    if (cur.close > tl * 1.002 && cur.close > cur.open) return 1;
  }
  return 0;
}

/** Swing failure: price breaks swing high/low then reverses (failed break). */
export function detectSwingFailure(bars: OHLCVBar[], i: number, lookback: number = 10): 1 | -1 | 0 {
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
  const res = Math.max(...swingHighs);
  const sup = Math.min(...swingLows);
  const prev = bars[i - 1];
  const cur = bars[i];
  if (prev.high >= res * 0.998 && cur.close < prev.low && cur.close < cur.open) return -1;
  if (prev.low <= sup * 1.002 && cur.close > prev.high && cur.close > cur.open) return 1;
  return 0;
}

/** Turtle soup: breakout of prior high/low fails, price reverses. */
export function detectTurtleSoup(bars: OHLCVBar[], i: number, lookback: number = 12): 1 | -1 | 0 {
  if (i < lookback + 3 || lookback < 2) return 0;
  const prevSlice = bars.slice(i - lookback, i - 1);
  if (prevSlice.length === 0) return 0;
  const prevHigh = Math.max(...prevSlice.map((b) => b.high));
  const prevLow = Math.min(...prevSlice.map((b) => b.low));
  const prev = bars[i - 1];
  const cur = bars[i];
  if (prev.close >= prevHigh * 0.998 && cur.close < prevLow && cur.close < cur.open) return -1;
  if (prev.close <= prevLow * 1.002 && cur.close > prevHigh && cur.close > cur.open) return 1;
  return 0;
}

/** Exhaustion: high range/volume bar then reversal. */
export function detectExhaustion(bars: OHLCVBar[], i: number, lookback: number = 6): 1 | -1 | 0 {
  if (i < lookback + 2 || lookback <= 1) return 0;
  const atrLookback = bars.slice(i - lookback, i - 1);
  if (atrLookback.length <= 0) return 0;
  const avgRange = atrLookback.reduce((s, b) => s + (b.high - b.low), 0) / atrLookback.length;
  const curRange = bars[i].high - bars[i].low;
  if (curRange < avgRange * 1.5) return 0;
  const cur = bars[i];
  if (cur.high > bars[i - 1].high && cur.close < cur.open && cur.close < bars[i - 1].close) return -1;
  if (cur.low < bars[i - 1].low && cur.close > cur.open && cur.close > bars[i - 1].close) return 1;
  return 0;
}

/** Capitulation: selling climax (sharp down then reversal up). */
export function detectCapitulation(bars: OHLCVBar[], i: number, lookback: number = 6): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 2) return 0;
  const cur = bars[i];
  const prev = bars[i - 1];
  const wasDown = prev.close < prev.open;
  const sharpDown = cur.low < prev.low && cur.open > cur.close;
  const reversalUp = cur.close > (cur.high + cur.low) / 2 && cur.close > cur.open;
  if (wasDown && sharpDown && reversalUp) return 1;
  const wasUp = prev.close > prev.open;
  const sharpUp = cur.high > prev.high && cur.open < cur.close;
  const reversalDown = cur.close < (cur.high + cur.low) / 2 && cur.close < cur.open;
  if (wasUp && sharpUp && reversalDown) return -1;
  return 0;
}

/** News spike: large range bar, direction from close. */
export function detectNewsSpike(bars: OHLCVBar[], i: number, lookback: number = 12): 1 | -1 | 0 {
  if (i < lookback + 1 || lookback <= 0) return 0;
  const avgRange = bars.slice(i - lookback, i).reduce((s, b) => s + (b.high - b.low), 0) / lookback;
  const curRange = bars[i].high - bars[i].low;
  if (curRange < avgRange * 2) return 0;
  if (bars[i].close > bars[i].open) return 1;
  if (bars[i].close < bars[i].open) return -1;
  return 0;
}

/** Close beyond: close beyond swing high/low (key level); commitment. Swing-based. */
export function detectCloseBeyond(bars: OHLCVBar[], i: number, lookback: number = 12): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
  const swingHighs: { idx: number; high: number }[] = [];
  const swingLows: { idx: number; low: number }[] = [];
  for (let j = i - lookback; j <= i - 2; j++) {
    if (j >= 2 && j < bars.length - 2) {
      if (isSwingHigh(bars, j)) swingHighs.push({ idx: j, high: bars[j].high });
      if (isSwingLow(bars, j)) swingLows.push({ idx: j, low: bars[j].low });
    }
  }
  if (swingHighs.length === 0 || swingLows.length === 0) return 0;
  const lastSwingHigh = swingHighs[swingHighs.length - 1];
  const lastSwingLow = swingLows[swingLows.length - 1];
  if (!lastSwingHigh || !lastSwingLow) return 0;
  const cur = bars[i];
  if (cur.close > lastSwingHigh.high && cur.close > cur.open) return 1;
  if (cur.close < lastSwingLow.low && cur.close < cur.open) return -1;
  return 0;
}

/** Tight consolidation: narrow range (small ATR ratio) then breakout. */
export function detectTightConsolidation(bars: OHLCVBar[], i: number, lookback: number = 10, consolBars: number = 4): 1 | -1 | 0 {
  if (i < lookback + consolBars + 1 || lookback <= 1 || consolBars <= 0) return 0;
  const consolSlice = bars.slice(i - consolBars, i);
  if (consolSlice.length === 0) return 0;
  const consolRange = Math.max(...consolSlice.map((b) => b.high)) - Math.min(...consolSlice.map((b) => b.low));
  const avgRangeDivisor = lookback - 1;
  if (avgRangeDivisor <= 0) return 0;
  const avgRange = bars.slice(i - lookback, i - 1).reduce((s, b) => s + (b.high - b.low), 0) / avgRangeDivisor;
  if (avgRange <= 0 || consolRange > avgRange * 0.6) return 0;
  const upper = Math.max(...consolSlice.map((b) => b.high));
  const lower = Math.min(...consolSlice.map((b) => b.low));
  const cur = bars[i];
  if (cur.close > upper && cur.close > cur.open) return 1;
  if (cur.close < lower && cur.close < cur.open) return -1;
  return 0;
}

/** Absorption: narrow range at level with elevated volume (institutional absorption) then breakout. */
export function detectAbsorption(bars: OHLCVBar[], i: number, lookback: number = 12, absorbBars: number = 5): 1 | -1 | 0 {
  if (i < lookback + absorbBars + 1 || absorbBars <= 0) return 0;
  const absorbSlice = bars.slice(i - absorbBars, i);
  if (absorbSlice.length === 0) return 0;
  const range = Math.max(...absorbSlice.map((b) => b.high)) - Math.min(...absorbSlice.map((b) => b.low));
  const priorSlice = bars.slice(i - lookback, i - absorbBars);
  const priorRange = priorSlice.length > 0
    ? Math.max(...priorSlice.map((b) => b.high)) - Math.min(...priorSlice.map((b) => b.low))
    : 0;
  if (priorRange <= 0 || range >= priorRange * 0.6) return 0;
  const absorbVol = absorbSlice.reduce((s, b) => s + (b.volume ?? 0), 0) / absorbBars;
  const priorVol = priorSlice.length > 0
    ? priorSlice.reduce((s, b) => s + (b.volume ?? 0), 0) / priorSlice.length
    : absorbVol;
  if (priorVol > 0 && absorbVol < priorVol * 1.2) return 0;
  const upper = Math.max(...absorbSlice.map((b) => b.high));
  const lower = Math.min(...absorbSlice.map((b) => b.low));
  const cur = bars[i];
  if (cur.close > upper && cur.close > cur.open) return 1;
  if (cur.close < lower && cur.close < cur.open) return -1;
  return 0;
}

/** Opening range: breakout of first N bars of session. Uses first orBars as range. */
export function detectOpeningRange(bars: OHLCVBar[], i: number, orBars: number = 5): 1 | -1 | 0 {
  if (i < orBars + 1 || orBars <= 0) return 0;
  const orSlice = bars.slice(i - orBars, i);
  if (orSlice.length === 0) return 0;
  const orHigh = Math.max(...orSlice.map((b) => b.high));
  const orLow = Math.min(...orSlice.map((b) => b.low));
  const cur = bars[i];
  if (cur.close > orHigh && cur.close > cur.open) return 1;
  if (cur.close < orLow && cur.close < cur.open) return -1;
  return 0;
}

/** Asian range: breakout of early-session range. First N bars = price-based range when no session time available. */
export function detectAsianRange(bars: OHLCVBar[], i: number, rangeBars: number = 8): 1 | -1 | 0 {
  if (i < rangeBars + 1 || rangeBars <= 0) return 0;
  const rangeSlice = bars.slice(i - rangeBars, i);
  if (rangeSlice.length === 0) return 0;
  const rangeHigh = Math.max(...rangeSlice.map((b) => b.high));
  const rangeLow = Math.min(...rangeSlice.map((b) => b.low));
  const cur = bars[i];
  if (cur.close > rangeHigh && cur.close > cur.open) return 1;
  if (cur.close < rangeLow && cur.close < cur.open) return -1;
  return 0;
}

/** Scalp break: quick break of micro level (short lookback). */
export function detectScalpBreak(bars: OHLCVBar[], i: number, lookback: number = 3): 1 | -1 | 0 {
  if (i < lookback + 1 || lookback <= 0) return 0;
  const prevSlice = bars.slice(i - lookback, i);
  if (prevSlice.length === 0) return 0;
  const prevHigh = Math.max(...prevSlice.map((b) => b.high));
  const prevLow = Math.min(...prevSlice.map((b) => b.low));
  const cur = bars[i];
  if (cur.close > prevHigh && cur.close > cur.open) return 1;
  if (cur.close < prevLow && cur.close < cur.open) return -1;
  return 0;
}

/** Change of Character (CHoCH): BOS against prior trend. Prior LH/LL then bullish BOS, or prior HH/HL then bearish BOS. */
export function detectChoch(bars: OHLCVBar[], i: number, lookback: number = 10): 1 | -1 | 0 {
  if (i < lookback * 2 + 4 || lookback <= 0) return 0;
  const priorSlice = bars.slice(i - lookback * 2, i - lookback);
  const recentSlice = bars.slice(i - lookback, i);
  const cur = bars[i];
  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  for (let j = 2; j < priorSlice.length - 2; j++) {
    const b = priorSlice[j]!;
    if (b.high >= (priorSlice[j - 1]?.high ?? 0) && b.high >= (priorSlice[j - 2]?.high ?? 0) &&
        b.high >= (priorSlice[j + 1]?.high ?? 0) && b.high >= (priorSlice[j + 2]?.high ?? 0))
      swingHighs.push(b.high);
    if (b.low <= (priorSlice[j - 1]?.low ?? Infinity) && b.low <= (priorSlice[j - 2]?.low ?? Infinity) &&
        b.low <= (priorSlice[j + 1]?.low ?? Infinity) && b.low <= (priorSlice[j + 2]?.low ?? Infinity))
      swingLows.push(b.low);
  }
  const priorMid = Math.floor(priorSlice.length / 2);
  const priorFirstHalf = priorSlice.slice(0, priorMid);
  const priorSecondHalf = priorSlice.slice(priorMid);
  if (priorFirstHalf.length === 0 || priorSecondHalf.length === 0) return 0;
  const priorFirstHigh = swingHighs.length >= 2 ? swingHighs[0]! : Math.max(...priorFirstHalf.map((b) => b.high));
  const priorSecondHigh = swingHighs.length >= 2 ? swingHighs[swingHighs.length - 1]! : Math.max(...priorSecondHalf.map((b) => b.high));
  const priorFirstLow = swingLows.length >= 2 ? swingLows[0]! : Math.min(...priorFirstHalf.map((b) => b.low));
  const priorSecondLow = swingLows.length >= 2 ? swingLows[swingLows.length - 1]! : Math.min(...priorSecondHalf.map((b) => b.low));
  const recentHigh = recentSlice.length > 0 ? Math.max(...recentSlice.map((b) => b.high)) : 0;
  const recentLow = recentSlice.length > 0 ? Math.min(...recentSlice.map((b) => b.low)) : Infinity;
  if (priorSecondHigh < priorFirstHigh && priorSecondLow < priorFirstLow) {
    if (cur.high > recentHigh && cur.close > recentHigh && cur.close > cur.open) return 1;
  }
  if (priorSecondHigh > priorFirstHigh && priorSecondLow > priorFirstLow) {
    if (cur.low < recentLow && cur.close < recentLow && cur.close < cur.open) return -1;
  }
  return 0;
}

/** Structure break: break of prior swing high (bullish) or swing low (bearish). Swing-based — no range simplification. */
export function detectStructureBreak(bars: OHLCVBar[], i: number, lookback: number = 10): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
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
  if (swingHighs.length === 0 || swingLows.length === 0) return 0;
  const lastSwingHigh = swingHighs[swingHighs.length - 1];
  const lastSwingLow = swingLows[swingLows.length - 1];
  const cur = bars[i];
  if (cur.close > lastSwingHigh.high && cur.close > cur.open) return 1;
  if (cur.close < lastSwingLow.low && cur.close < cur.open) return -1;
  return 0;
}

/** Swing high/low break: break of swing point. */
export function detectSwingHighLow(bars: OHLCVBar[], i: number, lookback: number = 12): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
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
  if (swingHighs.length === 0 || swingLows.length === 0) return 0;
  const lastSwingHigh = swingHighs[swingHighs.length - 1];
  const lastSwingLow = swingLows[swingLows.length - 1];
  const cur = bars[i];
  if (cur.close > lastSwingHigh.high && cur.close > cur.open) return 1;
  if (cur.close < lastSwingLow.low && cur.close < cur.open) return -1;
  return 0;
}

/** Elliott impulse: 5-wave motive. Uses swing points for wave boundaries. Wave 2 retrace 0.382-0.618, wave 3 > wave 1. */
export function detectElliottImpulse(bars: OHLCVBar[], i: number, lookback: number = 24): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 8) return 0;
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
  if (swingHighs.length < 3 || swingLows.length < 3) {
    const closes = slice.map((b) => b.close);
    const len = Math.floor(slice.length / 5);
    if (len < 2) return 0;
    const w1 = closes.slice(0, len);
    const w2 = closes.slice(len, len * 2);
    const w3 = closes.slice(len * 2, len * 3);
    const p0 = w1[0] ?? 0;
    const p1 = w1[w1.length - 1] ?? 0;
    const p2 = w2[w2.length - 1] ?? 0;
    const p3 = w3[w3.length - 1] ?? 0;
    const wave1 = Math.abs(p1 - p0);
    const wave2 = Math.abs(p2 - p1);
    const wave3 = Math.abs(p3 - p2);
    if (wave1 <= 0) return 0;
    const retrace2 = wave2 / wave1;
    if (retrace2 < 0.382 || retrace2 > 0.618) return 0;
    if (wave3 <= wave1) return 0;
    if (p1 > p0 && p2 < p1 && p3 > p2 && bars[i].close > bars[i].open) return 1;
    if (p1 < p0 && p2 > p1 && p3 < p2 && bars[i].close < bars[i].open) return -1;
    return 0;
  }
  const sh = swingHighs;
  const sl = swingLows;
  const p0 = sl[0]!.low;
  const p1 = sh[0]!.high;
  const p2 = sl[1]!.low;
  const p3 = sh[1]!.high;
  const wave1 = Math.abs(p1 - p0);
  const wave2 = Math.abs(p2 - p1);
  const wave3 = Math.abs(p3 - p2);
  if (wave1 <= 0) return 0;
  const retrace2 = wave2 / wave1;
  if (retrace2 < 0.382 || retrace2 > 0.618) return 0;
  if (wave3 <= wave1) return 0;
  if (p1 > p0 && p2 < p1 && p3 > p2 && bars[i].close > bars[i].open) return 1;
  if (p1 < p0 && p2 > p1 && p3 < p2 && bars[i].close < bars[i].open) return -1;
  return 0;
}

/** Elliott ABC: 3-wave correction. A move, B retrace, C = 0.618 or 1.0 of A. C completion = reversal. */
export function detectElliottAbc(bars: OHLCVBar[], i: number, lookback: number = 18): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 6) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  const closes = slice.map((b) => b.close);
  const lows = slice.map((b) => b.low);
  const highs = slice.map((b) => b.high);
  const mid = Math.floor(slice.length / 3);
  const leg1 = closes.slice(0, mid);
  const leg2 = closes.slice(mid, mid * 2);
  const leg3 = closes.slice(mid * 2);
  if (leg1.length < 2 || leg2.length < 2 || leg3.length < 2) return 0;
  const aHigh = Math.max(...leg1.map((_, j) => highs[j] ?? 0));
  const aLow = Math.min(...leg1.map((_, j) => lows[j] ?? 0));
  const aRange = aHigh - aLow;
  const bHigh = Math.max(...leg2.map((_, j) => highs[mid + j] ?? 0));
  const bLow = Math.min(...leg2.map((_, j) => lows[mid + j] ?? 0));
  const cStart = leg2[leg2.length - 1] ?? 0;
  const cEnd = leg3[leg3.length - 1] ?? 0;
  if (aRange <= 0) return 0;
  const aDown = (leg1[0] ?? 0) > (leg1[leg1.length - 1] ?? 0);
  const bUp = (leg2[0] ?? 0) < (leg2[leg2.length - 1] ?? 0);
  const cDown = cStart > cEnd;
  if (aDown && bUp && cDown) {
    const cRange = Math.abs(cEnd - cStart);
    const ratio = cRange / aRange;
    if ((ratio >= 0.55 && ratio <= 0.75) || (ratio >= 0.9 && ratio <= 1.1)) {
      if (bars[i].close > bars[i].open) return 1;
    }
  }
  const aUp = (leg1[0] ?? 0) < (leg1[leg1.length - 1] ?? 0);
  const bDown = (leg2[0] ?? 0) > (leg2[leg2.length - 1] ?? 0);
  const cUp = cStart < cEnd;
  if (aUp && bDown && cUp) {
    const cRange = Math.abs(cEnd - cStart);
    const ratio = cRange / aRange;
    if ((ratio >= 0.55 && ratio <= 0.75) || (ratio >= 0.9 && ratio <= 1.1)) {
      if (bars[i].close < bars[i].open) return -1;
    }
  }
  return 0;
}

/** Fan lines: Gann-style 1/3 and 2/3 levels from swing pivot. Pivot = first swing low in lookback. */
export function detectFanLines(bars: OHLCVBar[], i: number, lookback: number = 22): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 4) return 0;
  const slice = bars.slice(i - lookback, i + 1);
  if (slice.length < 5) return 0;
  const swingLows: { idx: number; low: number }[] = [];
  for (let j = 2; j < slice.length - 2; j++) {
    const b = slice[j]!;
    if (b.low <= slice[j - 1]!.low && b.low <= slice[j - 2]!.low && b.low <= slice[j + 1]!.low && b.low <= slice[j + 2]!.low)
      swingLows.push({ idx: j, low: b.low });
  }
  const pivot = swingLows.length > 0 ? swingLows[0]!.low : Math.min(...slice.map((b) => b.low));
  const highs = slice.map((b) => b.high);
  const endHigh = Math.max(...highs);
  const range = endHigh - pivot;
  if (range <= 0) return 0;
  const line1 = pivot + range * (1 / 3);
  const line2 = pivot + range * (2 / 3);
  const price = bars[i].close;
  const tol = range * 0.03;
  if (Math.abs(price - line1) < tol || Math.abs(price - line2) < tol) {
    if (bars[i].close > bars[i].open) return 1;
    if (bars[i].close < bars[i].open) return -1;
  }
  return 0;
}

/** Gap fill: price returns to fill prior gap. Bullish: gap down filled then bounce. Bearish: gap up filled then drop. */
export function detectGapFill(bars: OHLCVBar[], i: number, lookback: number = 6): 1 | -1 | 0 {
  if (lookback <= 0 || i < lookback + 3) return 0;
  const cur = bars[i];
  for (let j = i - 1; j >= Math.max(0, i - lookback); j--) {
    if (j < 1) break;
    const c0 = bars[j - 1]!, c1 = bars[j]!;
    const gapDown = c1.high < c0.low;
    const gapUp = c1.low > c0.high;
    if (gapDown) {
      const gapLow = c1.high;
      const gapHigh = c0.low;
      if (cur.low <= gapHigh && cur.close > gapLow && cur.close > cur.open) return 1;
    }
    if (gapUp) {
      const gapLow = c0.high;
      const gapHigh = c1.low;
      if (cur.high >= gapLow && cur.close < gapHigh && cur.close < cur.open) return -1;
    }
  }
  return 0;
}
