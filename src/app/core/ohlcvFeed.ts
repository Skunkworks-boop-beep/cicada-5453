/**
 * Fetches OHLCV bars from MT5 via the backend /mt5/ohlc endpoint.
 *
 * Stage 5: Deriv WebSocket / eXness REST paths removed. Every instrument
 * routes through the MT5 bridge — the bridge is the only live data
 * source the spec recognises (lines 894-1224). Without the bridge
 * reachable, fetch fails loudly; there is no synthetic fallback.
 */

import type { OHLCVBar } from './ohlcv';
import type { BrokerConfig } from './types';
import { getMt5Ohlc } from './api';

/** Activity determines data params: backtest needs date range; live/bot need latest bars only. */
export type OHLCVActivity = 'backtest' | 'live';

export interface FetchOHLCVParams {
  instrumentId: string;
  symbol: string;
  brokerId: string;
  timeframe: string;
  brokers: BrokerConfig[];
  /** Activity: backtest = use date range when provided; live = latest bars only. */
  activity?: OHLCVActivity;
  /** Max bars to request. Backtest: up to 50k; live/bot: typically 50–200. */
  count?: number;
  /** Date range (YYYY-MM-DD). Used only when activity is 'backtest'. */
  dateFrom?: string;
  dateTo?: string;
  /** AbortSignal for cancel (e.g. backtest cancel). Passed to fetch. */
  signal?: AbortSignal;
}

/** Max bars to request from the backend (full history depth). */
const FULL_HISTORY_CAP = 50_000;

export type OHLCVDataSource = 'live';

/**
 * Fetch OHLCV from the MT5 bridge. Throws when MT5 is unavailable.
 * Every instrument now routes through the same path; brokerId is kept
 * in the param shape for backward compatibility but is no longer used
 * for routing.
 */
export async function fetchOHLCV(params: FetchOHLCVParams): Promise<{ bars: OHLCVBar[]; dataSource: OHLCVDataSource }> {
  const { symbol, brokers, timeframe, activity = 'live', count = FULL_HISTORY_CAP, dateFrom, dateTo, signal } = params;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const useDateRange = activity === 'backtest' && dateFrom && dateTo;
  const barCount = Math.min(count, FULL_HISTORY_CAP);

  const mt5Broker = brokers.find((b) => b.type === 'mt5' && b.status === 'connected');
  if (!mt5Broker) {
    throw new Error(
      `MT5 must be connected for ${symbol}. Connect MT5 in the Brokers panel — the bridge is the only live data source.`,
    );
  }
  const mt5Symbol = symbol.replace('/', '');
  const result = await getMt5Ohlc(
    mt5Symbol,
    timeframe,
    barCount,
    useDateRange ? dateFrom : undefined,
    useDateRange ? dateTo : undefined,
    signal,
  );
  if ('bars' in result && result.bars.length > 0) {
    return {
      bars: result.bars.map((b) => ({
        time: b.time * 1000,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume ?? 0,
      })),
      dataSource: 'live',
    };
  }
  throw new Error(`MT5 returned no data for ${mt5Symbol} ${timeframe}. Check symbol availability and date range.`);
}
