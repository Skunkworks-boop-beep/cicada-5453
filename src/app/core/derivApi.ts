/**
 * @deprecated Stage 4 — Deriv WebSocket API removed.
 *
 * The system is MT5-bridge-only as of Stage 2B's "live-only pipeline"
 * directive. This file used to host a 1,500-line WebSocket client; now
 * it's a deprecation shim that preserves the export surface so existing
 * imports across TradingStore.tsx (141 callsites), BrokersManager.tsx,
 * TickerBar.tsx, etc. don't shatter.
 *
 * Every function returns a "disconnected" / empty-array shape. Callers
 * should treat Deriv as unreachable. A single console warning is logged
 * the first time any function is invoked.
 *
 * Stage 5 (or later cleanup) prunes the call sites and deletes this file.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

let _warned = false;
function _warnOnce(): void {
  if (_warned || typeof console === 'undefined') return;
  _warned = true;
  console.warn(
    '[derivApi] Deprecated since Stage 4 — MT5 bridge is the only live data path. ' +
    'This call returns empty/disconnected. Strip the import in a future cleanup.',
  );
}

// ── Type stubs preserved for import compatibility ────────────────────

export type DerivMessage = Record<string, unknown>;

export interface DerivActiveSymbol {
  symbol?: string;
  underlying_symbol?: string;
  market?: string;
  submarket?: string;
  subgroup?: string;
}

export type DerivSyntheticGroup =
  | 'Volatility' | 'Crash/Boom' | 'Jump' | 'Step' | 'Range Break' | 'World' | 'Uncategorized';

export interface DerivSyntheticValidation {
  byGroup: Record<DerivSyntheticGroup, { total: number; validated: number; missing: string[] }>;
  apiSymbolsNotInApp: string[];
  fetchedAt: number;
}

export interface DerivCandle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DerivPositionRow {
  instrumentId: string;
  instrument: string;
  type: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  stopLoss?: number;
  takeProfit?: number;
  contractId?: number;
}

export interface DerivProfitTableTransaction {
  contract_id: number;
  buy_price: number;
  sell_price: number;
  profit: number;
  payout?: number;
  purchase_time: number;
  sell_time: number;
  transaction_id?: number;
}

// ── Connection lifecycle (always disconnected) ───────────────────────

export function setOnDerivConnectionLost(_cb: (() => void) | null): void {
  _warnOnce();
}

export function connect(_appId: string, _token: string): Promise<DerivMessage> {
  _warnOnce();
  return Promise.reject(new Error('Deriv removed in Stage 4 — use MT5 bridge'));
}

export function disconnect(): void {
  _warnOnce();
}

export function isConnected(): boolean {
  return false;
}

export async function getBalance(): Promise<number> {
  _warnOnce();
  return 0;
}

export function request<T = DerivMessage>(_payload: Record<string, unknown>): Promise<T> {
  _warnOnce();
  return Promise.reject(new Error('Deriv removed in Stage 4'));
}

// ── Symbol / market data (always empty) ──────────────────────────────

export function getActiveSymbols(): Promise<DerivMessage> {
  _warnOnce();
  return Promise.resolve({});
}

export function clearActiveSymbolsCache(): void { /* no-op */ }

export async function getActiveSyntheticSymbols(): Promise<{
  byGroup: Record<DerivSyntheticGroup, DerivActiveSymbol[]>;
  all: DerivActiveSymbol[];
  fetchedAt: number;
}> {
  _warnOnce();
  return {
    byGroup: {
      Volatility: [], 'Crash/Boom': [], Jump: [], Step: [],
      'Range Break': [], World: [], Uncategorized: [],
    },
    all: [],
    fetchedAt: Date.now(),
  };
}

export function ourSymbolToDerivKeys(_ourSymbol: string): string[] {
  return [];
}

export function symbolNormalizations(s: string): string[] {
  return [s];
}

export function resolveDerivApiSymbolToRegistry(
  _apiSymbol: string,
  _instruments: Array<{ id: string; symbol: string; type: string; brokerId: string }>,
): { id: string; symbol: string } | null {
  return null;
}

export function validateDerivSynthetics(
  _instruments: Array<{ id: string; symbol: string; type: string; brokerId: string }>,
  _apiResult: { all: DerivActiveSymbol[]; byGroup: Record<DerivSyntheticGroup, DerivActiveSymbol[]>; fetchedAt: number },
): DerivSyntheticValidation {
  return {
    byGroup: {
      Volatility: { total: 0, validated: 0, missing: [] },
      'Crash/Boom': { total: 0, validated: 0, missing: [] },
      Jump: { total: 0, validated: 0, missing: [] },
      Step: { total: 0, validated: 0, missing: [] },
      'Range Break': { total: 0, validated: 0, missing: [] },
      World: { total: 0, validated: 0, missing: [] },
      Uncategorized: { total: 0, validated: 0, missing: [] },
    },
    apiSymbolsNotInApp: [],
    fetchedAt: Date.now(),
  };
}

export function getDerivApiSymbolForRequest(_ourSymbol: string): string | null {
  return null;
}

// ── OHLC / ticks / portfolio (all empty / null) ─────────────────────

export async function getTicksHistoryCandles(
  _symbol: string,
  _timeframe: string,
  _count: number,
  _startEpoch?: number,
  _endEpoch?: number,
): Promise<DerivCandle[]> {
  _warnOnce();
  return [];
}

export async function getTicksHistoryCandlesFullRange(
  _symbol: string,
  _timeframe: string,
  _startEpoch: number,
  _endEpoch: number,
): Promise<DerivCandle[]> {
  _warnOnce();
  return [];
}

export async function getDerivProfitTable(_limit?: number): Promise<DerivProfitTableTransaction[]> {
  _warnOnce();
  return [];
}

export async function getDerivPositions(): Promise<DerivPositionRow[]> {
  _warnOnce();
  return [];
}

export async function getDerivProposal(
  _symbol: string, _amount: number, _direction: 'LONG' | 'SHORT', _durationSec: number,
): Promise<{ proposal_id: string; ask_price: number; spot: number } | null> {
  _warnOnce();
  return null;
}

export async function buyDerivContract(_proposalId: string, _price: number): Promise<{ contract_id: number }> {
  _warnOnce();
  throw new Error('Deriv removed in Stage 4');
}

export async function getDerivSymbolQuote(
  _symbol: string, _spreadPoints?: number,
): Promise<{ bid: number; ask: number } | null> {
  _warnOnce();
  return null;
}

export async function getDerivSymbolSpreads(): Promise<Record<string, number>> {
  _warnOnce();
  return {};
}

export async function getDerivSymbolSpreadFromTick(_symbol: string): Promise<number | null> {
  _warnOnce();
  return null;
}

export async function getDerivPortfolioPrices(_forceRefresh?: boolean): Promise<Record<string, { bid: number; ask: number; profit?: number }>> {
  _warnOnce();
  return {};
}

export async function getDerivAccountSnapshot(): Promise<{ balance: number; currency: string } | null> {
  _warnOnce();
  return null;
}
