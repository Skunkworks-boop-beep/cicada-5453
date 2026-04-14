/**
 * Positions API: persist open positions and closed trades to backend for full restore.
 */

import { getNnApiBaseUrl } from './config';

export interface PositionsPayload {
  positions: Array<Record<string, unknown>>;
  closedTradesByBot: Record<string, Array<Record<string, unknown>>>;
  /** Balance (live-fetched); persisted for restore. */
  balance?: number;
  /** Peak equity for drawdown. */
  peakEquity?: number;
  /** Open P/L from positions. */
  totalPnl?: number;
  totalPnlPercent?: number;
  /** Realized P/L from closed trades. */
  realizedPnl?: number;
}

/** Fetch persisted positions and closed trades from backend. Used on load for full restore. */
export async function getPositions(options?: { signal?: AbortSignal }): Promise<PositionsPayload> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/positions`, {
      signal: options?.signal ?? AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { positions: [], closedTradesByBot: {} };
    const data = (await res.json()) as {
      positions?: unknown[];
      closedTradesByBot?: Record<string, unknown[]>;
      balance?: number;
      peakEquity?: number;
      totalPnl?: number;
      totalPnlPercent?: number;
      realizedPnl?: number;
    };
    return {
      positions: Array.isArray(data.positions) ? data.positions : [],
      closedTradesByBot: data.closedTradesByBot && typeof data.closedTradesByBot === 'object' ? data.closedTradesByBot : {},
      balance: data.balance,
      peakEquity: data.peakEquity,
      totalPnl: data.totalPnl,
      totalPnlPercent: data.totalPnlPercent,
      realizedPnl: data.realizedPnl,
    };
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[positionsApi] getPositions failed:', e);
    }
    return { positions: [], closedTradesByBot: {} };
  }
}

const POST_POSITIONS_RETRIES = 3;
const POST_POSITIONS_RETRY_DELAY_MS = 500;

/** Persist positions and closed trades to backend. Called on store persist for full backup.
 * Retries up to POST_POSITIONS_RETRIES times with exponential backoff to mitigate transient failures. */
export async function postPositions(payload: PositionsPayload, options?: { signal?: AbortSignal }): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 0; attempt < POST_POSITIONS_RETRIES; attempt++) {
    try {
      const res = await fetch(`${getNnApiBaseUrl()}/positions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: options?.signal ?? AbortSignal.timeout(5_000),
      });
      if (res.ok) return true;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[positionsApi] postPositions attempt ${attempt + 1}/${POST_POSITIONS_RETRIES} failed:`, e);
      }
    }
    if (attempt < POST_POSITIONS_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, POST_POSITIONS_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('[positionsApi] postPositions all retries exhausted:', lastError);
  }
  return false;
}
