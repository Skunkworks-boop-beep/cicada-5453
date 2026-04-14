/**
 * Fetches OHLCV bars from live sources only (Deriv, MT5/eXness). No synthetic fallback.
 * Routing and parameters depend on activity: backtest uses date range; live/bot use latest.
 * @see Deriv: developers.deriv.com/docs/data/ticks-history
 * @see MT5: MetaTrader5 copy_rates_from / copy_rates_range
 *
 * Deriv ticks_history candles do NOT include volume. We use a proxy (1 per bar) so
 * volume-based indicators (MFI, OBV, VWAP, CMF, PVO, etc.) produce non-null values.
 * Results are approximate; prefer MT5 for instruments where volume matters.
 */

import type { OHLCVBar } from './ohlcv';

/** Volume proxy when source has no volume (e.g. Deriv candles). Enables non-null indicator output. */
const DERIV_VOLUME_PROXY = 1;
import type { BrokerConfig } from './types';
import { getMt5Ohlc } from './api';
import { getTicksHistoryCandles, getTicksHistoryCandlesFullRange, getDerivApiSymbolForRequest, getActiveSyntheticSymbols, isConnected as derivIsConnected } from './derivApi';
import { BROKER_DERIV_ID, BROKER_EXNESS_ID, BROKER_EXNESS_API_ID } from './registries';
import { isDerivFiatOrCryptoApiSymbol, resolveDerivMarketDataSymbol } from './derivSymbolMaps';

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
  /** Date range (YYYY-MM-DD). Used only when activity is 'backtest'. Deriv/MT5 align to this range. */
  dateFrom?: string;
  dateTo?: string;
  /** AbortSignal for cancel (e.g. backtest cancel). Passed to fetch for MT5; checked before Deriv request. */
  signal?: AbortSignal;
}

/** Max bars to request from brokers (full history depth). Deriv: 5k per request (chunked); MT5: all in range. */
const FULL_HISTORY_CAP = 50_000;

export type OHLCVDataSource = 'live';

/**
 * Fetch OHLCV from live sources only. Throws when live data is unavailable.
 * Routing by instrument brokerId ensures the correct data source per usage:
 * - Deriv (broker-deriv): Deriv WebSocket API (ticks_history). Requires Deriv connected.
 * - MT5 add-on (broker-exness): Backend /mt5/ohlc. Requires MT5 add-on connected.
 * - eXness API (broker-exness-api): index CFDs — Backend /mt5/ohlc. Requires MT5 add-on connected.
 */
/** Parse YYYY-MM-DD to epoch seconds (start of day UTC). Returns NaN if invalid. */
function parseDateToEpoch(dateStr: string): number {
  const d = new Date(dateStr + 'T00:00:00Z');
  const ms = d.getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}

export async function fetchOHLCV(params: FetchOHLCVParams): Promise<{ bars: OHLCVBar[]; dataSource: OHLCVDataSource }> {
  const { symbol, brokerId, timeframe, brokers, activity = 'live', count = FULL_HISTORY_CAP, dateFrom, dateTo, signal } = params;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const broker = brokers.find((b) => b.id === brokerId);
  const barCount = Math.min(count, FULL_HISTORY_CAP);
  const useDateRange = activity === 'backtest' && dateFrom && dateTo;

  if (brokerId === BROKER_DERIV_ID) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (broker?.status !== 'connected' || !derivIsConnected()) {
      throw new Error(`Deriv must be connected for ${symbol}. Connect Deriv in the Brokers panel.`);
    }
    const { symbols: apiSymbols } = await getActiveSyntheticSymbols();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const resolved = resolveDerivMarketDataSymbol(symbol);
    const derivSymbol = isDerivFiatOrCryptoApiSymbol(resolved)
      ? resolved
      : getDerivApiSymbolForRequest(symbol, apiSymbols);
    let startEpoch: number | undefined;
    let endEpoch: number | undefined;
    if (useDateRange) {
      const start = parseDateToEpoch(dateFrom);
      const endOfDay = parseDateToEpoch(dateTo) + 86400 - 1;
      const nowEpoch = Math.floor(Date.now() / 1000);
      if (Number.isFinite(start) && Number.isFinite(endOfDay) && start < endOfDay) {
        startEpoch = start;
        endEpoch = Math.min(endOfDay, nowEpoch);
      }
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const candles = useDateRange && startEpoch != null && endEpoch != null
      ? await getTicksHistoryCandlesFullRange(derivSymbol, timeframe, startEpoch, endEpoch, signal)
      : await getTicksHistoryCandles(derivSymbol, timeframe, barCount, startEpoch, endEpoch, useDateRange);
    if (candles.length === 0) {
      throw new Error(`Deriv returned no data for ${derivSymbol} ${timeframe}. Check date range and symbol availability.`);
    }
    return {
      bars: candles.map((c) => ({
        time: c.epoch * 1000,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: DERIV_VOLUME_PROXY,
      })),
      dataSource: 'live',
    };
  }

  // MT5 / eXness: use backend /mt5/ohlc. Instrument brokerId determines which broker to require.
  const isMt5Instrument = brokerId === BROKER_EXNESS_ID;
  const isExnessApiInstrument = brokerId === BROKER_EXNESS_API_ID;
  const useMt5Backend = isMt5Instrument || isExnessApiInstrument;
  const mt5Broker = brokers.find((b) => b.type === 'mt5' && b.status === 'connected');

  if (useMt5Backend) {
    if (!mt5Broker) {
      const hint = isMt5Instrument
        ? 'Connect MT5 add-on in the Brokers panel. MT5 instruments use MT5 backend for OHLC.'
        : 'Connect MT5 add-on in the Brokers panel. eXness API instruments use MT5 backend for OHLC data.';
      throw new Error(`MT5 must be connected for ${symbol}. ${hint}`);
    }
    const mt5Symbol = symbol.replace('/', '');
    const result = await getMt5Ohlc(mt5Symbol, timeframe, barCount, useDateRange ? dateFrom : undefined, useDateRange ? dateTo : undefined, signal);
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
    throw new Error(`MT5 returned no data for ${mt5Symbol} ${timeframe}. Check symbol and date range.`);
  }

  throw new Error(`No live data source for ${symbol}. Connect Deriv (for synthetics) or MT5 (for forex/crypto) in the Brokers panel.`);
}
