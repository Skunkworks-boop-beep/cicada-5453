/**
 * Higher timeframe (HTF) mapping and LTF↔HTF bar alignment for real multi-timeframe signals.
 * HTF bars must be the same symbol, sorted by time ascending (open time).
 */

import type { OHLCVBar } from './ohlcv';
import { getBarDurationMs } from './ohlcv';
import type { Timeframe } from './types';

/** Next higher timeframe for bias / filter (institutional: trade LTF, filter with HTF). */
export const HIGHER_TIMEFRAME: Record<Timeframe, Timeframe | null> = {
  M1: 'M5',
  M5: 'M15',
  M15: 'H1',
  M30: 'H1',
  H1: 'H4',
  H4: 'D1',
  D1: 'W1',
  W1: null,
};

export function getHigherTimeframe(tf: Timeframe): Timeframe | null {
  return HIGHER_TIMEFRAME[tf] ?? null;
}

/**
 * For each LTF bar, index of the HTF bar whose open time is ≤ LTF bar time (current HTF candle).
 * Returns -1 if no HTF bar is at or before this time.
 */
export function buildHtfIndexForEachLtfBar(ltfBars: OHLCVBar[], htfBars: OHLCVBar[]): Int32Array {
  const out = new Int32Array(ltfBars.length);
  if (!htfBars.length) {
    out.fill(-1);
    return out;
  }
  for (let i = 0; i < ltfBars.length; i++) {
    const t = ltfBars[i].time;
    let lo = 0;
    let hi = htfBars.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (htfBars[mid].time <= t) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    out[i] = best;
  }
  return out;
}

export function barDurationMs(tf: Timeframe): number {
  return getBarDurationMs(tf);
}
