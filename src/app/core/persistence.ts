/**
 * Persist and restore trading store state to backend filesystem storage.
 * Backend data (bot build, MT5 connect/status/OHLC) is sent to the NN API server
 * via api.ts (getNnApiBaseUrl()); only app state (instruments, bots, strategies,
 * portfolio cache, etc.) is persisted here. Production: use versioned schema and migration.
 */

import { getNnApiBaseUrl } from './config';
import type { Instrument, BotConfig, BrokerConfig, BacktestResultRow, BacktestRunRequest, ClosedTrade } from './types';
import type { AnyStrategyDef } from './types';

export interface PersistedState {
  version: 1;
  instruments: Instrument[];
  brokers: BrokerConfig[];
  strategies: Array<{ id: string; enabled: boolean }>;
  bots: BotConfig[];
  execution: { enabled: boolean; updatedAt: string };
  /** Backtest results and last run request so they survive reload */
  backtest?: {
    results: BacktestResultRow[];
    runRequest: BacktestRunRequest | null;
    status?: 'running' | 'completed' | 'cancelled' | 'failed' | 'idle';
    progress?: number;
    selectedTimeframes?: string[];
    autoCompareLog?: Array<{ level: string; message: string; timestamp: string }>;
    lastAutoCompareResult?: { winner: 'default' | 'research'; profitDefault: number; profitResearch: number; timestamp: string } | null;
  };
  portfolio: {
    balance: number;
    peakEquity: number;
    /** Open P/L (from positions); persisted for display across refresh. */
    totalPnl?: number;
    totalPnlPercent?: number;
    /** Realized P/L (sum of closed trades); persisted for full P/L history. */
    realizedPnl?: number;
    dataSource?: 'none' | 'mt5' | 'deriv';
    /** Open positions persisted for full restore across refresh/reload. */
    positions: Array<{
      id: string;
      instrumentId: string;
      instrument: string;
      type: 'LONG' | 'SHORT';
      size: number;
      entryPrice: number;
      currentPrice: number;
      pnl: number;
      pnlPercent: number;
      scope: string;
      style: string;
      botId: string;
      openedAt: string;
      stopLoss?: number;
      takeProfit?: number;
      riskAmount: number;
    }>;
  };
  /** Closed trades per bot for drift detection (last N per bot). */
  closedTradesByBot?: Record<string, ClosedTrade[]>;
  /** Grid research results (regime + param tune) for use in backtest. */
  research?: {
    regimeTunes: Array<{ instrumentId: string; instrumentSymbol: string; regimeConfig: Record<string, number>; score: number; regimeDistribution: Record<string, number>; validated?: boolean; regimeValidationMessage?: string }>;
    paramTunes: Array<{ instrumentId: string; strategyId: string; regime: string; sharpeInSample: number; profitOOS?: number; tradesOOS?: number; riskParams: { stopLossPct: number; riskPerTradePct: number; takeProfitR: number } }>;
    baselineResults?: Array<{ instrumentId: string; instrumentSymbol: string; regimeDistribution: Record<string, number>; baselineAvgSharpe: number; baselineTotalProfit: number }>;
    /** Research run log (last N entries persisted so it survives reload). */
    log?: Array<{ level: string; message: string }>;
  };
  /** Last N lines of bot NN build trace (timestamps + per-step durations). */
  botBuildLog?: Array<{ level: string; message: string; timestamp: string }>;
  /** Bot execution log (predictions, orders, skips) for audit/lookback. Persisted + backend. */
  botExecutionLog?: Array<{
    id: string;
    timestamp: string;
    botId: string;
    symbol: string;
    phase: string;
    outcome: string;
    message: string;
    details?: Record<string, unknown>;
  }>;
}

export function loadState(): Partial<PersistedState> | null {
  // Local browser persistence is deprecated for heavy trading state.
  // State is now loaded asynchronously from backend via loadStateFromBackend().
  return null;
}

export function saveState(state: PersistedState): void {
  fetch(`${getNnApiBaseUrl()}/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
    signal: AbortSignal.timeout(6_000),
  }).catch((e) => {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[persistence] saveState backend sync failed:', e);
    }
  });
}

export async function loadStateFromBackend(): Promise<Partial<PersistedState> | null> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/state`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { state?: PersistedState };
    const parsed = data?.state;
    if (!parsed || parsed.version !== 1) return null;
    return parsed;
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[persistence] loadStateFromBackend failed:', e);
    }
    return null;
  }
}

export function mergeStrategiesWithPersisted(
  current: AnyStrategyDef[],
  persisted: Array<{ id: string; enabled: boolean }> | undefined
): AnyStrategyDef[] {
  if (!persisted?.length) return current;
  const map = new Map(persisted.map((p) => [p.id, p.enabled]));
  return current.map((s) => (map.has(s.id) ? { ...s, enabled: map.get(s.id)! } : s));
}

export type ResearchBarsMap = Record<string, Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>>;

/** Keep research bars in memory only (no browser storage). */
export function saveResearchBars(bars: ResearchBarsMap): void {
  void bars;
}

/** Clear in-memory research bars (called when user clicks Clear). */
export function clearResearchBars(): void {
  // no-op: research bars are not persisted in browser storage
}
