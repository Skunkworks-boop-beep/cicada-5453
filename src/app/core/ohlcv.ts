/**
 * OHLCV bar type. All data comes from live brokers (Deriv, MT5) via ohlcvFeed.
 */

export interface OHLCVBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const BAR_MS: Record<string, number> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
  W1: 7 * 24 * 60 * 60_000,
};

export function getBarDurationMs(timeframe: string): number {
  return BAR_MS[timeframe as keyof typeof BAR_MS] ?? BAR_MS.M5;
}
