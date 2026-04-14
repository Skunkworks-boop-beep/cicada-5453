/**
 * Technical indicators computed from OHLCV series. No placeholders; full implementations.
 *
 * Volume policy: use (volume ?? 0) for standard fallback. EOM uses a dedicated fallback of 1
 * when volume is 0 to avoid division by zero in boxRatio = (high-low)/volume.
 */

import type { OHLCVBar } from './ohlcv';

/** EOM: when volume is 0, use this to avoid division by zero in boxRatio. Documented exception. */
const EOM_VOLUME_FALLBACK = 1;

/** ZigZag: minimum threshold when lastExtreme*thresholdPct would be 0. Avoids division/compare with 0. */
const ZIGZAG_MIN_THRESHOLD = 0.0001;

/** NVI/PVI: initial value and fallback when prev is null. Standard convention (Norman Fosback). */
const NVI_PVI_INITIAL = 1000;

export function sma(values: number[], period: number): (number | null)[] {
  if (period < 1 || !Number.isFinite(period)) return values.map(() => null);
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    let sum = 0;
    for (let j = 0; j < period; j++) sum += values[i - j];
    out.push(sum / period);
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  if (period < 1 || !Number.isFinite(period)) return values.map(() => null);
  const k = 2 / (period + 1);
  const out: (number | null)[] = [];
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    if (prev === null) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += values[j];
      prev = sum / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

/** RSI with Wilder smoothing (Wilder 1978). First avg = SMA of first period; then smoothed. */
export function rsi(closes: number[], period: number = 14): (number | null)[] {
  if (period < 1 || !Number.isFinite(period)) return closes.map(() => null);
  const out: (number | null)[] = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      out.push(null);
      continue;
    }
    if (i === period) {
      let gains = 0, losses = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const ch = closes[j] - closes[j - 1];
        if (ch > 0) gains += ch;
        else losses -= ch;
      }
      avgGain = gains / period;
      avgLoss = losses / period;
    } else {
      const ch = closes[i] - closes[i - 1];
      const gain = ch > 0 ? ch : 0;
      const loss = ch < 0 ? -ch : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgLoss === 0) {
      out.push(avgGain === 0 ? 50 : 100);
      continue;
    }
    const rs = avgGain / avgLoss;
    out.push(100 - 100 / (1 + rs));
  }
  return out;
}

export function macd(
  closes: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] } {
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const macdLine: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (fast[i] === null || slow[i] === null) macdLine.push(null);
    else macdLine.push(fast[i]! - slow[i]!);
  }
  const macdValues = macdLine.map((x) => x ?? 0);
  const signalLine = ema(macdValues, signalPeriod);
  const histogram: (number | null)[] = [];
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] === null || signalLine[i] === null) histogram.push(null);
    else histogram.push(macdLine[i]! - signalLine[i]!);
  }
  return { macd: macdLine, signal: signalLine, histogram };
}

export function atr(bars: OHLCVBar[], period: number = 14): (number | null)[] {
  if (period < 1 || !Number.isFinite(period)) return bars.map(() => null);
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      tr.push(bars[i].high - bars[i].low);
      continue;
    }
    const prevClose = bars[i - 1].close;
    const high = bars[i].high;
    const low = bars[i].low;
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return ema(tr, period);
}

export function bollingerBands(
  closes: number[],
  period: number = 20,
  stdMult: number = 2
): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  if (period < 1 || !Number.isFinite(period)) {
    return { upper: closes.map(() => null), middle: closes.map(() => null), lower: closes.map(() => null) };
  }
  const middle = sma(closes, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1 || middle[i] === null) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    let sumSq = 0;
    for (let j = 0; j < period; j++) sumSq += (closes[i - j] - middle[i]!) ** 2;
    const std = Math.sqrt(sumSq / period);
    upper.push(middle[i]! + stdMult * std);
    lower.push(middle[i]! - stdMult * std);
  }
  return { upper, middle, lower };
}

/** Linear regression slope over last `period` values (trend strength proxy). */
export function linearRegressionSlope(values: number[], period: number): (number | null)[] {
  if (period < 1 || !Number.isFinite(period)) return values.map(() => null);
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let j = 0; j < period; j++) {
      const x = j;
      const y = values[i - period + 1 + j];
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    }
    const n = period;
    const denom = n * sumX2 - sumX * sumX;
    const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
    out.push(slope);
  }
  return out;
}

/** Rate of change: (close - close_n_ago) / close_n_ago. */
export function roc(closes: number[], period: number): (number | null)[] {
  if (period < 1 || !Number.isFinite(period)) return closes.map(() => null);
  const out: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      out.push(null);
      continue;
    }
    const prev = closes[i - period];
    if (prev === 0) out.push(0);
    else out.push((closes[i] - prev) / prev);
  }
  return out;
}

/** CCI: (TP - SMA(TP)) / (0.015 * mean deviation). TP = typical price. */
export function cci(bars: { high: number; low: number; close: number }[], period: number = 20): (number | null)[] {
  if (period < 1 || !Number.isFinite(period)) return bars.map(() => null);
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  const out: (number | null)[] = [];
  for (let i = 0; i < tp.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    const slice = tp.slice(i - period + 1, i + 1);
    const smaTp = slice.reduce((a, b) => a + b, 0) / period;
    const meanDev = slice.reduce((s, v) => s + Math.abs(v - smaTp), 0) / period;
    if (meanDev === 0) out.push(0);
    else out.push((tp[i] - smaTp) / (0.015 * meanDev));
  }
  return out;
}

/** Williams %R: -100 * (high_n - close) / (high_n - low_n). Overbought -20, oversold -80. */
export function williamsR(bars: { high: number; low: number; close: number }[], period: number = 14): (number | null)[] {
  if (period < 1 || !Number.isFinite(period)) return bars.map(() => null);
  const out: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    const slice = bars.slice(i - period + 1, i + 1);
    const highN = Math.max(...slice.map((b) => b.high));
    const lowN = Math.min(...slice.map((b) => b.low));
    const range = highN - lowN;
    if (range === 0) out.push(-50);
    else out.push(-100 * ((highN - bars[i].close) / range));
  }
  return out;
}

/** ADX: Average Directional Index. Returns { adx, plusDi, minusDi }. Wilder's +DM/-DM rule. */
export function adx(bars: OHLCVBar[], period: number = 14): { adx: (number | null)[]; plusDi: (number | null)[]; minusDi: (number | null)[] } {
  if (period < 1 || !Number.isFinite(period)) {
    const v = bars.map(() => null);
    return { adx: [...v], plusDi: [...v], minusDi: [...v] };
  }
  const tr = bars.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      plusDm.push(0);
      minusDm.push(0);
      continue;
    }
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  const atrArr = ema(tr, period);
  const smoothPlus = ema(plusDm, period);
  const smoothMinus = ema(minusDm, period);
  const plusDi: (number | null)[] = [];
  const minusDi: (number | null)[] = [];
  const dx: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (atrArr[i] == null || atrArr[i] === 0 || smoothPlus[i] == null || smoothMinus[i] == null) {
      plusDi.push(null);
      minusDi.push(null);
      dx.push(null);
      continue;
    }
    const pDi = 100 * smoothPlus[i]! / atrArr[i]!;
    const mDi = 100 * smoothMinus[i]! / atrArr[i]!;
    plusDi.push(pDi);
    minusDi.push(mDi);
    const sum = pDi + mDi;
    dx.push(sum === 0 ? 0 : 100 * Math.abs(pDi - mDi) / sum);
  }
  const adx = ema(dx.map((d) => d ?? 0), period);
  return { adx, plusDi, minusDi };
}

/** Keltner Channel: EMA with ATR bands. */
export function keltner(bars: OHLCVBar[], emaPeriod: number = 20, atrPeriod: number = 10, mult: number = 2): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  if (emaPeriod < 1 || atrPeriod < 1 || !Number.isFinite(emaPeriod) || !Number.isFinite(atrPeriod)) {
    const v = bars.map(() => null);
    return { upper: [...v], middle: [...v], lower: [...v] };
  }
  const c = bars.map((b) => b.close);
  const middle = ema(c, emaPeriod);
  const atrArr = atr(bars, atrPeriod);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (middle[i] == null || atrArr[i] == null) {
      upper.push(null);
      lower.push(null);
    } else {
      upper.push(middle[i]! + mult * atrArr[i]!);
      lower.push(middle[i]! - mult * atrArr[i]!);
    }
  }
  return { upper, middle, lower };
}

/** Donchian Channel: N-period high/low. */
export function donchian(bars: { high: number; low: number; close: number }[], period: number = 20): { upper: (number | null)[]; lower: (number | null)[] } {
  if (period < 1 || !Number.isFinite(period)) {
    return { upper: bars.map(() => null), lower: bars.map(() => null) };
  }
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) {
      upper.push(null);
      lower.push(null);
    } else {
      const slice = bars.slice(i - period + 1, i + 1);
      upper.push(Math.max(...slice.map((b) => b.high)));
      lower.push(Math.min(...slice.map((b) => b.low)));
    }
  }
  return { upper, lower };
}

/** Awesome Oscillator: SMA(5) of median - SMA(34) of median. */
export function awesomeOscillator(bars: { high: number; low: number; close: number }[]): (number | null)[] {
  const median = bars.map((b) => (b.high + b.low) / 2);
  const sma5 = sma(median, 5);
  const sma34 = sma(median, 34);
  const out: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (sma5[i] == null || sma34[i] == null) out.push(null);
    else out.push(sma5[i]! - sma34[i]!);
  }
  return out;
}

/** Accelerator Oscillator: AO - SMA(AO, 5). Momentum of AO. */
export function acceleratorOscillator(bars: { high: number; low: number; close: number }[]): (number | null)[] {
  const ao = awesomeOscillator(bars);
  const aoValues = ao.map((x) => x ?? 0);
  const smaAo = sma(aoValues, 5);
  const out: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (ao[i] == null || smaAo[i] == null) out.push(null);
    else out.push(ao[i]! - smaAo[i]!);
  }
  return out;
}

/** DPO: Detrended Price Oscillator. Price - SMA(price, period/2+1) shifted back. */
export function dpo(closes: number[], period: number = 20): (number | null)[] {
  if (period < 1 || !Number.isFinite(period)) return closes.map(() => null);
  const shift = Math.floor(period / 2) + 1;
  const smaPrice = sma(closes, period);
  const out: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period + shift - 1 || smaPrice[i - shift] == null) out.push(null);
    else out.push(closes[i] - smaPrice[i - shift]!);
  }
  return out;
}

/** TRIX: 1-period ROC of triple-EMA of close. */
export function trix(closes: number[], period: number = 15): (number | null)[] {
  if (period < 1 || !Number.isFinite(period)) return closes.map(() => null);
  let e = ema(closes, period);
  e = ema(e.map((x) => x ?? 0), period);
  e = ema(e.map((x) => x ?? 0), period);
  const out: (number | null)[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (e[i] == null || e[i - 1] == null || e[i - 1] === 0) out.push(null);
    else out.push(100 * ((e[i]! - e[i - 1]!) / e[i - 1]!));
  }
  out.unshift(null);
  return out;
}

/** Money Flow Index: volume-weighted RSI. MF = typical price × volume; MFI = RSI of positive vs negative flow. */
export function mfi(
  bars: { high: number; low: number; close: number; volume: number }[],
  period: number = 14
): (number | null)[] {
  if (period < 1 || !Number.isFinite(period)) return bars.map(() => null);
  const out: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period) {
      out.push(null);
      continue;
    }
    let posFlow = 0;
    let negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = (bars[j].high + bars[j].low + bars[j].close) / 3;
      const mf = tp * (bars[j].volume ?? 0);
      const prevTp = (bars[j - 1].high + bars[j - 1].low + bars[j - 1].close) / 3;
      if (tp > prevTp) posFlow += mf;
      else if (tp < prevTp) negFlow += mf;
    }
    if (negFlow === 0) out.push(100);
    else out.push(100 - 100 / (1 + posFlow / negFlow));
  }
  return out;
}

/** VWAP: cumulative (typical price × volume) / cumulative volume. Session-free; resets from bar 0. */
export function vwap(bars: { high: number; low: number; close: number; volume: number }[]): (number | null)[] {
  const out: (number | null)[] = [];
  let cumTpVol = 0;
  let cumVol = 0;
  for (let i = 0; i < bars.length; i++) {
    const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
    const vol = bars[i].volume ?? 0;
    cumTpVol += tp * vol;
    cumVol += vol;
    out.push(cumVol > 0 ? cumTpVol / cumVol : null);
  }
  return out;
}

/** VWAP bands: VWAP ± stdMult × std(close - VWAP) over rolling period. */
export function vwapBands(
  bars: { high: number; low: number; close: number; volume: number }[],
  period: number = 20,
  stdMult: number = 2
): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  if (period < 1 || !Number.isFinite(period)) {
    const v = bars.map(() => null);
    return { upper: [...v], middle: vwap(bars), lower: [...v] };
  }
  const vwapSeries = vwap(bars);
  const c = bars.map((b) => b.close);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    const m = vwapSeries[i];
    if (m == null || i < period - 1) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    const slice = c.slice(i - period + 1, i + 1);
    const devs = slice.map((x) => x - m);
    const meanDev = devs.reduce((a, b) => a + b, 0) / period;
    const variance = devs.reduce((s, d) => s + (d - meanDev) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    upper.push(m + stdMult * std);
    lower.push(m - stdMult * std);
  }
  return { upper, middle: vwapSeries, lower };
}

/** Chaikin Money Flow: sum(MF) / sum(volume) over period. MF = ((2*close - high - low)/(high - low)) * volume. */
export function cmf(
  bars: { high: number; low: number; close: number; volume: number }[],
  period: number = 20
): (number | null)[] {
  if (period < 1 || !Number.isFinite(period)) return bars.map(() => null);
  const out: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    let sumMf = 0;
    let sumVol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const b = bars[j];
      const range = b.high - b.low;
      const mf = range > 0 ? ((2 * b.close - b.high - b.low) / range) * (b.volume ?? 0) : 0;
      sumMf += mf;
      sumVol += b.volume ?? 0;
    }
    out.push(sumVol > 0 ? sumMf / sumVol : null);
  }
  return out;
}

/** Chande Momentum Oscillator: 100 * (sum gains - sum losses) / (sum gains + sum losses). */
export function cmo(closes: number[], period: number = 14): (number | null)[] {
  if (period < 1 || !Number.isFinite(period)) return closes.map(() => null);
  const out: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      out.push(null);
      continue;
    }
    let gains = 0;
    let losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const ch = closes[j] - closes[j - 1];
      if (ch > 0) gains += ch;
      else losses -= ch;
    }
    const total = gains + losses;
    out.push(total > 0 ? 100 * (gains - losses) / total : 0);
  }
  return out;
}

/** True Strength Index: 100 * EMA(EMA(price change, long), short) / EMA(EMA(|price change|, long), short). */
export function tsi(closes: number[], longPeriod: number = 25, shortPeriod: number = 13): (number | null)[] {
  if (longPeriod < 1 || shortPeriod < 1 || !Number.isFinite(longPeriod) || !Number.isFinite(shortPeriod)) {
    return closes.map(() => null);
  }
  const pc: number[] = [0];
  for (let i = 1; i < closes.length; i++) pc.push(closes[i] - closes[i - 1]);
  const absPc = pc.map((x) => Math.abs(x));
  const ema1Pc = ema(pc, longPeriod);
  const ema1Abs = ema(absPc, longPeriod);
  const ema2Pc = ema(ema1Pc.map((x) => x ?? 0), shortPeriod);
  const ema2Abs = ema(ema1Abs.map((x) => x ?? 0), shortPeriod);
  const out: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    const d1 = ema2Pc[i];
    const d2 = ema2Abs[i];
    if (d1 == null || d2 == null || d2 === 0) out.push(null);
    else out.push(100 * d1 / d2);
  }
  return out;
}

/** Ultimate Oscillator: BP = close - min(low, prevClose); TR = max(high, prevClose) - min(low, prevClose). */
export function ultimateOscillator(
  bars: { high: number; low: number; close: number }[],
  p1: number = 7,
  p2: number = 14,
  p3: number = 28
): (number | null)[] {
  if (p1 < 1 || p2 < 1 || p3 < 1 || !Number.isFinite(p1) || !Number.isFinite(p2) || !Number.isFinite(p3)) {
    return bars.map(() => null);
  }
  const bp: number[] = [];
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const prevClose = i > 0 ? bars[i - 1].close : bars[i].close;
    bp.push(bars[i].close - Math.min(bars[i].low, prevClose));
    tr.push(Math.max(bars[i].high, prevClose) - Math.min(bars[i].low, prevClose));
  }
  const out: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < p3 - 1) {
      out.push(null);
      continue;
    }
    const s1bp = bp.slice(i - p1 + 1, i + 1).reduce((a, b) => a + b, 0);
    const s1tr = tr.slice(i - p1 + 1, i + 1).reduce((a, b) => a + b, 1e-10);
    const s2bp = bp.slice(i - p2 + 1, i + 1).reduce((a, b) => a + b, 0);
    const s2tr = tr.slice(i - p2 + 1, i + 1).reduce((a, b) => a + b, 1e-10);
    const s3bp = bp.slice(i - p3 + 1, i + 1).reduce((a, b) => a + b, 0);
    const s3tr = tr.slice(i - p3 + 1, i + 1).reduce((a, b) => a + b, 1e-10);
    const a1 = s1bp / s1tr;
    const a2 = s2bp / s2tr;
    const a3 = s3bp / s3tr;
    out.push(100 * (4 * a1 + 2 * a2 + a3) / 7);
  }
  return out;
}

/** On-Balance Volume: cumulative volume signed by close direction. */
export function obv(bars: { close: number; volume: number }[]): (number | null)[] {
  const out: (number | null)[] = [bars[0] ? bars[0].volume : null];
  let cum = bars[0]?.volume ?? 0;
  for (let i = 1; i < bars.length; i++) {
    const dir = bars[i].close > bars[i - 1].close ? 1 : bars[i].close < bars[i - 1].close ? -1 : 0;
    cum += dir * (bars[i].volume ?? 0);
    out.push(cum);
  }
  return out;
}

/** Force Index: (close - prevClose) * volume. EMA-smoothed. */
export function forceIndex(
  bars: { close: number; volume: number }[],
  period: number = 2
): (number | null)[] {
  const raw: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const ch = i > 0 ? bars[i].close - bars[i - 1].close : 0;
    raw.push(ch * (bars[i].volume ?? 0));
  }
  return ema(raw, period);
}

/** Ease of Movement: (distance moved / volume). High price move on low volume = high EOM. */
export function eom(
  bars: { high: number; low: number; close: number; volume: number }[],
  period: number = 14
): (number | null)[] {
  const raw: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const prevMid = i > 0 ? (bars[i - 1].high + bars[i - 1].low) / 2 : (bars[i].high + bars[i].low) / 2;
    const currMid = (bars[i].high + bars[i].low) / 2;
    const dist = currMid - prevMid;
    const vol = (bars[i].volume ?? 0) || EOM_VOLUME_FALLBACK;
    const boxRatio = (bars[i].high - bars[i].low) / vol;
    raw.push(boxRatio > 0 ? dist / boxRatio : 0);
  }
  return ema(raw, period);
}

/** Volume Price Trend: cumulative (volume * (close - prevClose) / prevClose). */
export function vpt(bars: { close: number; volume: number }[]): (number | null)[] {
  const out: (number | null)[] = [0];
  let cum = 0;
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    const pctCh = prev !== 0 ? (bars[i].close - prev) / prev : 0;
    cum += (bars[i].volume ?? 0) * pctCh;
    out.push(cum);
  }
  return out;
}

/**
 * Stochastic %K and %D (used by ind-stoch-overbought, ind-stoch-oversold, ind-stoch-div).
 * %K = (close - low_n) / (high_n - low_n) * 100; %D = SMA(%K, smooth).
 */
export function stochastic(
  bars: { high: number; low: number; close: number }[],
  kPeriod: number = 14,
  dPeriod: number = 3
): { k: (number | null)[]; d: (number | null)[] } {
  if (kPeriod < 1 || dPeriod < 1 || !Number.isFinite(kPeriod) || !Number.isFinite(dPeriod)) {
    const v = bars.map(() => null);
    return { k: [...v], d: [...v] };
  }
  const k: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < kPeriod - 1) {
      k.push(null);
      continue;
    }
    const slice = bars.slice(i - kPeriod + 1, i + 1);
    const highN = Math.max(...slice.map((b) => b.high));
    const lowN = Math.min(...slice.map((b) => b.low));
    const close = bars[i].close;
    const range = highN - lowN;
    if (range === 0) k.push(50);
    else k.push(((close - lowN) / range) * 100);
  }
  const d: (number | null)[] = [];
  for (let i = 0; i < k.length; i++) {
    if (i < dPeriod - 1 || k[i] === null) {
      d.push(null);
      continue;
    }
    let sum = 0;
    for (let j = 0; j < dPeriod; j++) sum += k[i - j] ?? 0;
    d.push(sum / dPeriod);
  }
  return { k, d };
}

/** Coppock Curve: 10-period SMA of (ROC14 + ROC11). Long-term momentum; entry on turn up from negative. */
export function coppock(closes: number[], roc1: number = 14, roc2: number = 11, smooth: number = 10): (number | null)[] {
  const r1 = roc(closes, roc1);
  const r2 = roc(closes, roc2);
  const raw: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const a = r1[i] ?? 0;
    const b = r2[i] ?? 0;
    raw.push(a + b);
  }
  return sma(raw, smooth);
}

/** Negative Volume Index: cumulative, only adds when volume < prev volume. NVI += NVI_prev * (close - prevClose)/prevClose. */
export function nvi(bars: { close: number; volume: number }[]): (number | null)[] {
  const out: (number | null)[] = [NVI_PVI_INITIAL];
  for (let i = 1; i < bars.length; i++) {
    const vol = bars[i].volume ?? 0;
    const prevVol = bars[i - 1].volume ?? 0;
    const prev = out[i - 1] ?? NVI_PVI_INITIAL;
    if (vol < prevVol && bars[i - 1].close !== 0) {
      const pct = (bars[i].close - bars[i - 1].close) / bars[i - 1].close;
      out.push(prev * (1 + pct));
    } else {
      out.push(prev);
    }
  }
  return out;
}

/** Positive Volume Index: cumulative, only adds when volume > prev volume. */
export function pvi(bars: { close: number; volume: number }[]): (number | null)[] {
  const out: (number | null)[] = [NVI_PVI_INITIAL];
  for (let i = 1; i < bars.length; i++) {
    const vol = bars[i].volume ?? 0;
    const prevVol = bars[i - 1].volume ?? 0;
    const prev = out[i - 1] ?? NVI_PVI_INITIAL;
    if (vol > prevVol && bars[i - 1].close !== 0) {
      const pct = (bars[i].close - bars[i - 1].close) / bars[i - 1].close;
      out.push(prev * (1 + pct));
    } else {
      out.push(prev);
    }
  }
  return out;
}

/** Accumulation/Distribution: cumulative ((2*close - high - low)/(high - low)) * volume. When high=low use 0. */
export function accumulationDistribution(bars: { high: number; low: number; close: number; volume?: number }[]): (number | null)[] {
  const out: (number | null)[] = [0];
  let cum = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const hl = b.high - b.low;
    const mfm = hl !== 0 ? (2 * b.close - b.high - b.low) / hl : 0;
    cum += mfm * (b.volume ?? 0);
    out.push(cum);
  }
  return out;
}

/** Classic pivot points from prior bar. P=(H+L+C)/3, R1=2P-L, R2=P+(H-L), S1=2P-H, S2=P-(H-L). */
export function pivotPoints(bars: { high: number; low: number; close: number }[]): {
  pivot: (number | null)[];
  r1: (number | null)[];
  r2: (number | null)[];
  s1: (number | null)[];
  s2: (number | null)[];
} {
  const pivot: (number | null)[] = [null];
  const r1: (number | null)[] = [null];
  const r2: (number | null)[] = [null];
  const s1: (number | null)[] = [null];
  const s2: (number | null)[] = [null];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1];
    const h = p.high, l = p.low, c = p.close;
    const pv = (h + l + c) / 3;
    pivot.push(pv);
    r1.push(2 * pv - l);
    r2.push(pv + (h - l));
    s1.push(2 * pv - h);
    s2.push(pv - (h - l));
  }
  return { pivot, r1, r2, s1, s2 };
}

/** Camarilla pivots: tighter levels. R4=C+(H-L)*1.1/2, R3=C+(H-L)*1.1/4, R2=C+(H-L)*1.1/12, R1=C+(H-L)*1.1/24; S symmetric. */
export function camarillaPivots(bars: { high: number; low: number; close: number }[]): {
  r4: (number | null)[]; r3: (number | null)[]; r2: (number | null)[]; r1: (number | null)[];
  s1: (number | null)[]; s2: (number | null)[]; s3: (number | null)[]; s4: (number | null)[];
} {
  const r4: (number | null)[] = [null];
  const r3: (number | null)[] = [null];
  const r2: (number | null)[] = [null];
  const r1: (number | null)[] = [null];
  const s1: (number | null)[] = [null];
  const s2: (number | null)[] = [null];
  const s3: (number | null)[] = [null];
  const s4: (number | null)[] = [null];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1];
    const h = p.high, l = p.low, c = p.close;
    const r = (h - l) * 1.1;
    r4.push(c + r / 2);
    r3.push(c + r / 4);
    r2.push(c + r / 12);
    r1.push(c + r / 24);
    s1.push(c - r / 24);
    s2.push(c - r / 12);
    s3.push(c - r / 4);
    s4.push(c - r / 2);
  }
  return { r4, r3, r2, r1, s1, s2, s3, s4 };
}

/** Fibonacci pivot: P=(H+L+C)/3, R1=P+(H-L)*0.382, R2=P+(H-L)*0.618, S1=P-(H-L)*0.382, S2=P-(H-L)*0.618. */
export function fibPivot(bars: { high: number; low: number; close: number }[]): {
  pivot: (number | null)[];
  r1: (number | null)[];
  r2: (number | null)[];
  s1: (number | null)[];
  s2: (number | null)[];
} {
  const pivot: (number | null)[] = [null];
  const r1: (number | null)[] = [null];
  const r2: (number | null)[] = [null];
  const s1: (number | null)[] = [null];
  const s2: (number | null)[] = [null];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1];
    const h = p.high, l = p.low, c = p.close;
    const pv = (h + l + c) / 3;
    const r = (h - l) * 0.382;
    const r62 = (h - l) * 0.618;
    pivot.push(pv);
    r1.push(pv + r);
    r2.push(pv + r62);
    s1.push(pv - r);
    s2.push(pv - r62);
  }
  return { pivot, r1, r2, s1, s2 };
}

/** ZigZag: filtered swing highs/lows. Uses % threshold (default 0.1%). Returns last ZigZag level at each bar. */
export function zigzag(bars: { high: number; low: number; close: number }[], thresholdPct: number = 0.001): {
  levels: (number | null)[];
  isHigh: boolean[];
} {
  const levels: (number | null)[] = [];
  const isHigh: boolean[] = [];
  if (bars.length === 0) return { levels, isHigh };
  let lastExtreme = bars[0].close;
  let lastIsHigh = true;
  for (let i = 0; i < bars.length; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    const thresh = Math.max(Math.abs(lastExtreme) * thresholdPct, ZIGZAG_MIN_THRESHOLD);
    if (lastIsHigh) {
      if (h >= lastExtreme) {
        lastExtreme = h;
      } else if (l <= lastExtreme - thresh) {
        lastExtreme = l;
        lastIsHigh = false;
      }
    } else {
      if (l <= lastExtreme) {
        lastExtreme = l;
      } else if (h >= lastExtreme + thresh) {
        lastExtreme = h;
        lastIsHigh = true;
      }
    }
    levels.push(lastExtreme);
    isHigh.push(lastIsHigh);
  }
  return { levels, isHigh };
}

/** Bill Williams Fractals: 5-bar pattern. High fractal = bar high > highs of 2 bars left and 2 bars right. */
export function fractals(bars: { high: number; low: number }[]): {
  highFractals: (number | null)[];
  lowFractals: (number | null)[];
} {
  const highFractals: (number | null)[] = [];
  const lowFractals: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < 2 || i >= bars.length - 2) {
      highFractals.push(null);
      lowFractals.push(null);
      continue;
    }
    const h = bars[i].high;
    const l = bars[i].low;
    const isHighFractal = bars[i - 2].high < h && bars[i - 1].high < h && bars[i + 1].high < h && bars[i + 2].high < h;
    const isLowFractal = bars[i - 2].low > l && bars[i - 1].low > l && bars[i + 1].low > l && bars[i + 2].low > l;
    highFractals.push(isHighFractal ? h : null);
    lowFractals.push(isLowFractal ? l : null);
  }
  return { highFractals, lowFractals };
}

/** Smoothed Moving Average (SMMA/RMA): SMMA(i) = (SMMA(i-1)*(N-1) + Price(i)) / N. Used by Alligator. */
export function smma(values: number[], period: number): (number | null)[] {
  if (period < 1 || !Number.isFinite(period)) return values.map(() => null);
  const out: (number | null)[] = [];
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    if (prev === null) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += values[j];
      prev = sum / period;
    } else {
      prev = (prev * (period - 1) + values[i]) / period;
    }
    out.push(prev);
  }
  return out;
}

/** Know Sure Thing (KST): weighted ROC momentum. ROCMA1=SMA(ROC10,10)*1 + ROCMA2=SMA(ROC15,10)*2 + ROCMA3=SMA(ROC20,10)*3 + ROCMA4=SMA(ROC30,15)*4. Signal=SMA(KST,9). */
export function kst(closes: number[]): { kst: (number | null)[]; signal: (number | null)[] } {
  const r1 = roc(closes, 10);
  const r2 = roc(closes, 15);
  const r3 = roc(closes, 20);
  const r4 = roc(closes, 30);
  const rocma1 = sma(r1.map((x) => x ?? 0), 10);
  const rocma2 = sma(r2.map((x) => x ?? 0), 10);
  const rocma3 = sma(r3.map((x) => x ?? 0), 10);
  const rocma4 = sma(r4.map((x) => x ?? 0), 15);
  const kstLine: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    const a = rocma1[i], b = rocma2[i], c = rocma3[i], d = rocma4[i];
    if (a == null || b == null || c == null || d == null) kstLine.push(null);
    else kstLine.push(a * 1 + b * 2 + c * 3 + d * 4);
  }
  const signal = sma(kstLine.map((x) => x ?? 0), 9);
  return { kst: kstLine, signal };
}

/** Price Volume Oscillator (PVO): (EMA(vol,12) - EMA(vol,26)) / EMA(vol,26) * 100. Signal=EMA(PVO,9). Histogram=PVO-Signal. */
export function pvo(bars: { volume: number }[]): { pvo: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] } {
  const vols = bars.map((b) => b.volume ?? 0);
  const fast = ema(vols, 12);
  const slow = ema(vols, 26);
  const pvoLine: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (fast[i] == null || slow[i] == null || slow[i] === 0) pvoLine.push(null);
    else pvoLine.push(100 * (fast[i]! - slow[i]!) / slow[i]!);
  }
  const signal = ema(pvoLine.map((x) => x ?? 0), 9);
  const histogram: (number | null)[] = [];
  for (let i = 0; i < pvoLine.length; i++) {
    if (pvoLine[i] == null || signal[i] == null) histogram.push(null);
    else histogram.push(pvoLine[i]! - signal[i]!);
  }
  return { pvo: pvoLine, signal, histogram };
}

/** Wilder Swing Index: SI = {[(C-Cn1)+0.5*(C-O)+0.25*(Cn1-On1)]/R} * (K/L) * 50. Limit L=25000 for forex. */
export function swingIndex(bars: OHLCVBar[], limitMove: number = 25000): (number | null)[] {
  if (!Number.isFinite(limitMove) || limitMove <= 0) return bars.map(() => null);
  const out: (number | null)[] = [null];
  for (let i = 1; i < bars.length; i++) {
    const c = bars[i].close, o = bars[i].open, h = bars[i].high, l = bars[i].low;
    const cn1 = bars[i - 1].close, on1 = bars[i - 1].open;
    const k = Math.max(h - cn1, l - cn1);
    let r: number;
    const h_cn1 = h - cn1;
    const l_cn1 = l - cn1;
    const hl = h - l;
    if (h_cn1 >= l_cn1 && h_cn1 >= hl) r = h_cn1 + 0.5 * l_cn1 + 0.25 * (cn1 - on1);
    else if (l_cn1 >= h_cn1 && l_cn1 >= hl) r = l_cn1 + 0.5 * h_cn1 + 0.25 * (cn1 - on1);
    else r = hl + 0.25 * (cn1 - on1);
    if (r === 0) { out.push(0); continue; }
    const si = ((c - cn1) + 0.5 * (c - o) + 0.25 * (cn1 - on1)) / r * (k / limitMove) * 50;
    out.push(si);
  }
  return out;
}

/** Supertrend: ATR-based. BasicUpper=(H+L)/2 + mult*ATR, BasicLower=(H+L)/2 - mult*ATR. Flip when price crosses. */
export function supertrend(bars: OHLCVBar[], period: number = 10, mult: number = 3): { line: (number | null)[]; direction: number[] } {
  if (period < 1 || !Number.isFinite(period)) {
    return { line: bars.map(() => null), direction: bars.map(() => 1) };
  }
  const atrArr = atr(bars, period);
  const direction: number[] = [];
  const line: (number | null)[] = [];
  let upperBand = 0, lowerBand = 0, st = 0, dir = 1;
  for (let i = 0; i < bars.length; i++) {
    if (i < period) {
      line.push(null);
      direction.push(1);
      continue;
    }
    const a = atrArr[i];
    if (a == null) {
      line.push(null);
      direction.push(dir);
      continue;
    }
    const hl2 = (bars[i].high + bars[i].low) / 2;
    const basicUpper = hl2 + mult * a;
    const basicLower = hl2 - mult * a;
    if (i === period) {
      upperBand = basicUpper;
      lowerBand = basicLower;
      st = dir === 1 ? lowerBand : upperBand;
    } else {
      if (basicUpper < upperBand || bars[i - 1].close > upperBand) upperBand = basicUpper;
      if (basicLower > lowerBand || bars[i - 1].close < lowerBand) lowerBand = basicLower;
      if (dir === 1) {
        if (bars[i].close < lowerBand) { dir = -1; st = upperBand; }
        else st = lowerBand;
      } else {
        if (bars[i].close > upperBand) { dir = 1; st = lowerBand; }
        else st = upperBand;
      }
    }
    line.push(st);
    direction.push(dir);
  }
  return { line, direction };
}

/** Parabolic SAR: SAR += AF * (EP - SAR). AF starts 0.02, +0.02 per new EP, max 0.20. */
export function parabolicSar(bars: OHLCVBar[], afStart: number = 0.02, afStep: number = 0.02, afMax: number = 0.2): (number | null)[] {
  const out: (number | null)[] = [null];
  if (bars.length < 2) return out;
  let sar = bars[0].low;
  let ep = bars[0].high;
  let af = afStart;
  let dir = 1;
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, c = bars[i].close;
    if (dir === 1) {
      if (l < sar) {
        dir = -1;
        sar = ep;
        ep = l;
        af = afStart;
      } else {
        if (h > ep) { ep = h; af = Math.min(af + afStep, afMax); }
        sar = sar + af * (ep - sar);
        if (sar > bars[i - 1].low) sar = bars[i - 1].low;
        if (sar > l) sar = l;
      }
    } else {
      if (h > sar) {
        dir = 1;
        sar = ep;
        ep = h;
        af = afStart;
      } else {
        if (l < ep) { ep = l; af = Math.min(af + afStep, afMax); }
        sar = sar - af * (sar - ep);
        if (sar < bars[i - 1].high) sar = bars[i - 1].high;
        if (sar < h) sar = h;
      }
    }
    out.push(sar);
  }
  return out;
}

/** Ichimoku Cloud: Tenkan(9), Kijun(26), SenkouA=(Tenkan+Kijun)/2 shifted +26, SenkouB(52) shifted +26, Chikou=close shifted -26. */
export function ichimoku(bars: OHLCVBar[]): {
  tenkan: (number | null)[];
  kijun: (number | null)[];
  senkouA: (number | null)[];
  senkouB: (number | null)[];
  chikou: (number | null)[];
} {
  const hl2 = (i: number, p: number) => {
    if (p < 1 || i < p - 1) return null;
    const slice = bars.slice(i - p + 1, i + 1);
    if (slice.length === 0) return null;
    return (Math.max(...slice.map((b) => b.high)) + Math.min(...slice.map((b) => b.low))) / 2;
  };
  const tenkan: (number | null)[] = [];
  const kijun: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    tenkan.push(hl2(i, 9));
    kijun.push(hl2(i, 26));
  }
  const senkouARaw: (number | null)[] = [];
  const senkouBRaw: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    const t = tenkan[i], k = kijun[i];
    senkouARaw.push(t != null && k != null ? (t + k) / 2 : null);
    if (i >= 51) {
      const slice = bars.slice(i - 51, i + 1);
      if (slice.length === 0) senkouBRaw.push(null);
      else senkouBRaw.push((Math.max(...slice.map((b) => b.high)) + Math.min(...slice.map((b) => b.low))) / 2);
    } else {
      senkouBRaw.push(null);
    }
  }
  const senkouA: (number | null)[] = [];
  const senkouB: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    senkouA.push(i >= 26 ? senkouARaw[i - 26] : null);
    senkouB.push(i >= 26 ? senkouBRaw[i - 26] : null);
  }
  const chikou: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    chikou.push(i + 26 < bars.length ? bars[i].close : null);
  }
  return { tenkan, kijun, senkouA, senkouB, chikou };
}

/** Alligator: Jaw=SMMA(13) shift 8, Teeth=SMMA(8) shift 5, Lips=SMMA(5) shift 3. Uses median price (H+L)/2. */
export function alligator(bars: OHLCVBar[]): { jaw: (number | null)[]; teeth: (number | null)[]; lips: (number | null)[] } {
  const median = bars.map((b) => (b.high + b.low) / 2);
  const j = smma(median, 13);
  const t = smma(median, 8);
  const l = smma(median, 5);
  const shift = (arr: (number | null)[], n: number) => {
    const out: (number | null)[] = [];
    for (let i = 0; i < arr.length; i++) {
      out.push(i >= n ? arr[i - n] : null);
    }
    return out;
  };
  return { jaw: shift(j, 8), teeth: shift(t, 5), lips: shift(l, 3) };
}

/** Gator Oscillator: |Jaw-Teeth| and |Teeth-Lips|. Upper=abs(Jaw-Teeth), Lower=abs(Teeth-Lips). */
export function gatorOscillator(bars: OHLCVBar[]): { upper: (number | null)[]; lower: (number | null)[] } {
  const { jaw, teeth, lips } = alligator(bars);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    const j = jaw[i], t = teeth[i], l = lips[i];
    if (j == null || t == null) upper.push(null);
    else upper.push(Math.abs(j - t));
    if (t == null || l == null) lower.push(null);
    else lower.push(Math.abs(t - l));
  }
  return { upper, lower };
}
