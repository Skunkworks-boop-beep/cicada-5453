/**
 * Global trading system store: instruments, strategies, backtest, bots, execution, portfolio, scheduler.
 * Production: persistence, NN API build, stop/target evaluation on tick.
 */

import React, { createContext, useContext, useMemo, useRef, useSyncExternalStore } from 'react';
import type {
  Instrument,
  BotConfig,
  BrokerConfig,
  BrokerConfigCredentials,
  BacktestResultRow,
  BacktestRunRequest,
  RebuildScheduleEntry,
  AnyStrategyDef,
  Position,
  ClosedTrade,
  TradeScope,
  TradeStyle,
} from '../core/types';
import {
  BACKTEST_FULL_HISTORY_BARS,
  BACKTEST_DATE_FROM_EARLIEST,
  FULL_DEPTH_TIMEFRAMES,
  MIN_BARS_REQUIRED_BACKTEST,
  MIN_BARS_REQUIRED_RESEARCH,
  getRemoteServerUrl,
  loadRemoteServerUrlFromBackend,
  isRemoteOffloadConfigured,
  getNnApiBaseUrl,
} from '../core/config';
import { analyzeInstrumentRiskFromBars } from '../core/instrumentRisk';
import { buildJobRiskOverrides, buildJobRiskOverridesFromParamTunes } from '../core/strategyInstrumentConfig';
import { getSelectedStrategyIds } from '../core/strategySelection';
import { DEFAULT_INSTRUMENTS, DEFAULT_BROKERS, BROKER_DERIV_ID, BROKER_EXNESS_ID, BROKER_EXNESS_API_ID, getAllStrategies } from '../core/registries';
import {
  getBacktestState,
  runBacktest,
  resetBacktestResults,
  hydrateBacktestState,
  setBacktestRunning,
  setBacktestFailed,
  setBacktestPhase,
  setBacktestCancelled,
  setBacktestSelectedTimeframes,
  appendAutoCompareLog,
  setLastAutoCompareResult,
  clearAutoCompareLog,
  estimateBacktestJobCount,
  getBestResultsForBuild,
  splitBacktestResultsForOOS,
  MIN_TRAINING_ROWS_FOR_BUILD,
  type BacktestEngineState,
} from '../core/backtest';
import { checkDrift, DRIFT_MAX_CLOSED_TRADES_PER_BOT } from '../core/drift';
import {
  createBotForInstrument,
  setBotStatus,
  setBotBuildProgress,
  scheduleNextRebuild,
  setDriftDetected,
  clearDriftDetected,
  DEFAULT_EXECUTION_STATE,
  createExecutionState,
} from '../core/bot';
import {
  getPortfolioState,
  hydratePortfolio,
  removePosition,
  setBalance,
  setPeakEquity,
  setServerEquity,
  updatePositionPrices,
  positionPnl,
  setPositions,
} from '../core/portfolio';
import { runBotExecution, runPositionEvaluation, POSITION_EVAL_INTERVAL_MS, type BotExecutionEvent } from '../core/botExecution';
import type { PortfolioState } from '../core/types';
import { buildScheduleFromInstrumentsAndBots, getNextDueRebuilds } from '../core/scheduler';
import { loadStateFromBackend, saveState, mergeStrategiesWithPersisted, saveResearchBars, clearResearchBars, type PersistedState } from '../core/persistence';
import { postBuild, getHealth, postMt5Connect, getMt5Account, getMt5Prices, getMt5Positions, getMt5SymbolSpreads, postBacktestStream, postResearchGridStream, postBackwardValidate, postExecutionLogAppend, getExecutionLog, getBots, postBots } from '../core/api';
import { getPositions, postPositions } from '../core/positionsApi';
import { connect as derivConnect, disconnect as derivDisconnect, isConnected as derivIsConnected, getBalance as derivGetBalance, getDerivAccountSnapshot, getDerivPortfolioPrices, getDerivProfitTable, getDerivSymbolQuote, getDerivSymbolSpreads, getDerivSymbolSpreadFromTick, getDerivPositions, ourSymbolToDerivKeys, resolveDerivApiSymbolToRegistry, setOnDerivConnectionLost } from '../core/derivApi';
import { getExnessAccount, getExnessPositions } from '../core/exnessApi';
import {
  DEFAULT_BACKTEST_PARAM_COMBOS_LIMIT,
  DEFAULT_RESEARCH_PARAM_TUNE_MAX_RISK,
  DEFAULT_RESEARCH_PARAM_TUNE_MAX_STRAT,
  DEFAULT_RESEARCH_REGIME_GRID_MAX,
} from '../core/gridConfig';
import { getHigherTimeframe } from '../core/multiTimeframe';
import type { Timeframe } from '../core/types';
import { fetchOHLCV } from '../core/ohlcvFeed';
import { logTradeEvent, tradeEventToExecutionLog } from '../core/tradeLogger';
import { getScopeStyleFromBotForInstrument } from '../core/scope';
import { computeClosedTradePnl } from '../core/tradePnl';

/** Log level for styled display (matches theme: green/orange/red/yellow). */
export type ResearchLogLevel = 'info' | 'progress' | 'success' | 'warning' | 'error';

export interface ResearchLogEntry {
  level: ResearchLogLevel;
  message: string;
}

/** Verbose trace for NN bot build (UI terminal + browser console [bot-build]). */
export interface BotBuildLogEntry {
  level: ResearchLogLevel;
  message: string;
  timestamp: string;
}

export interface BaselineResult {
  instrumentId: string;
  instrumentSymbol: string;
  regimeDistribution: Record<string, number>;
  baselineAvgSharpe: number;
  baselineTotalProfit: number;
}

export interface ResearchState {
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  regimeTunes: Array<{ instrumentId: string; instrumentSymbol: string; regimeConfig: Record<string, number>; score: number; regimeDistribution: Record<string, number>; validated?: boolean; regimeValidationMessage?: string }>;
  paramTunes: Array<{ instrumentId: string; strategyId: string; regime: string; sharpeInSample: number; profitOOS?: number; tradesOOS?: number; riskParams: { stopLossPct: number; riskPerTradePct: number; takeProfitR: number } }>;
  /** Baseline metrics (defaults) per instrument for cross-reference. */
  baselineResults: BaselineResult[];
  error?: string;
  /** Progress log with level for themed display. */
  log: ResearchLogEntry[];
  /** Progress 0–100 for progress bar and ETA. */
  progress?: number;
  /** Total steps (baseline + regime + param jobs) for ETA. */
  total?: number;
  /** Completed steps for rate-based ETA. */
  completed?: number;
  /** Current phase for progressive coverage display. */
  currentPhase?: 'baseline' | 'regime' | 'param' | 'skip';
  /** Current instrument symbol. */
  currentInstrument?: string;
  /** Current strategy id. */
  currentStrategy?: string;
  /** Current regime. */
  currentRegime?: string;
  /** Param job progress (done/total). */
  paramJobDone?: number;
  paramJobTotal?: number;
  /** Regime config progress (for long regime calibration). */
  regimeConfigProgress?: number;
  regimeConfigTotal?: number;
  instrumentIdx?: number;
  instrumentTotal?: number;
  /** Instruments skipped (no symbol, insufficient bars) with reason. */
  skippedInstruments?: Array<{ instrumentId: string; instrumentSymbol?: string; reason: string; barCount?: number; minRequired?: number; detail?: string }>;
  /** Fetched bars (instrumentId|tf -> bars). Kept until Clear; persisted to survive reload. */
  barsByKey?: Record<string, Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>>;
}

export interface TradingStoreState {
  instruments: Instrument[];
  brokers: BrokerConfig[];
  strategies: AnyStrategyDef[];
  backtest: BacktestEngineState;
  /** Grid research results (regime + param tune) for pre-backtest tuning. */
  research: ResearchState;
  bots: BotConfig[];
  execution: { enabled: boolean; updatedAt: string };
  portfolio: PortfolioState;
  schedule: RebuildScheduleEntry[];
  /** Closed trades per bot for drift detection (live win rate vs backtest). */
  closedTradesByBot: Record<string, ClosedTrade[]>;
  /** Backward validation: calibrations that would have predicted profitable trades. Used to seed research. */
  backwardValidation: {
    status: 'idle' | 'running' | 'completed' | 'failed';
    calibrationHints: Record<string, { regimeConfig: Record<string, number>; strategyId: string; score: number }>;
    validatedTrades: Array<{ instrumentId: string; correctSide: string; simulatedPnl: number }>;
    summary: { total: number; verified: number; skipped: number };
    error?: string;
    /** Progress log for UI display. */
    log: Array<{ level: ResearchLogLevel; message: string }>;
  } | null;
  /** Live bot execution log: predictions, skips, orders (last N events). */
  botExecutionLog: BotExecutionEvent[];
  /** Step-by-step bot NN build log (timing, fetches, POST /build). */
  botBuildLog: BotBuildLogEntry[];
}

type Listener = () => void;
const listeners: Listener[] = [];
let snapshotVersion = 0;
let cachedSnapshot: TradingStoreState | null = null;
let cachedSnapshotVersion = -1;

function subscribe(l: Listener) {
  listeners.push(l);
  return () => { listeners.splice(listeners.indexOf(l), 1); };
}
function emit() {
  snapshotVersion++;
  listeners.forEach((l) => l());
}

const BOT_ERROR_AUTO_CLEAR_MS = 3000;
function scheduleClearBotError(botId: string) {
  setTimeout(() => {
    const b = bots.find((x) => x.id === botId);
    if (b?.lastError) {
      bots = bots.map((x) => (x.id === botId ? { ...x, lastError: undefined } : x));
      schedulePersist();
      emit();
    }
  }, BOT_ERROR_AUTO_CLEAR_MS);
}

const BACKTEST_RELATED_ERRORS = [
  'Run a backtest first',
  'Full backtest required. Run a backtest and let it complete (do not cancel).',
  'Full backtest required. Run a backtest and let it complete.',
] as const;
function clearBacktestRelatedBotErrors(instrumentIds: Set<string>) {
  if (instrumentIds.size === 0) return;
  let changed = false;
  bots = bots.map((x) => {
    if (!x.lastError || !instrumentIds.has(x.instrumentId)) return x;
    const isBacktestRelated =
      BACKTEST_RELATED_ERRORS.some((e) => x.lastError === e) ||
      (x.lastError.startsWith('No live backtest results for') && x.lastError.includes('Run backtest with this instrument selected'));
    if (isBacktestRelated) {
      changed = true;
      return { ...x, lastError: undefined };
    }
    return x;
  });
  if (changed) {
    schedulePersist();
    emit();
  }
}

let instruments: Instrument[] = [...DEFAULT_INSTRUMENTS];
let brokers: BrokerConfig[] = [...DEFAULT_BROKERS];
let strategies: AnyStrategyDef[] = getAllStrategies();
let research: ResearchState = {
  status: 'idle',
  regimeTunes: [],
  paramTunes: [],
  baselineResults: [],
  log: [] as ResearchLogEntry[],
};
let researchAbortController: AbortController | null = null;
let researchAbortReason: 'broker_disconnected' | null = null;
let bots: BotConfig[] = [];
let execution = { ...DEFAULT_EXECUTION_STATE };
let closedTradesByBot: Record<string, ClosedTrade[]> = {};
let backwardValidation: {
  status: 'idle' | 'running' | 'completed' | 'failed';
  calibrationHints: Record<string, { regimeConfig: Record<string, number>; strategyId: string; score: number }>;
  validatedTrades: Array<{ instrumentId: string; correctSide: string; simulatedPnl: number }>;
  summary: { total: number; verified: number; skipped: number };
  error?: string;
  log: Array<{ level: ResearchLogLevel; message: string }>;
} | null = null;
const BOT_EXECUTION_LOG_MAX = 500;
let botExecutionLog: BotExecutionEvent[] = [];

const MAX_BOT_BUILD_LOG = 600;
const MAX_PERSISTED_BOT_BUILD_LOG = 350;
let botBuildLog: BotBuildLogEntry[] = [];

function appendBotBuildLog(level: ResearchLogLevel, message: string) {
  const line = message.length > 12_000 ? `${message.slice(0, 12_000)}…` : message;
  const entry: BotBuildLogEntry = {
    level,
    message: line,
    timestamp: new Date().toISOString(),
  };
  botBuildLog = [...botBuildLog, entry].slice(-MAX_BOT_BUILD_LOG);
  if (typeof console !== 'undefined' && console.info) {
    console.info(`[bot-build] ${entry.timestamp} [${level}] ${line}`);
  }
  emit();
}

function pushBotExecutionEvent(event: Omit<BotExecutionEvent, 'id' | 'timestamp'>): BotExecutionEvent {
  const full: BotExecutionEvent = {
    ...event,
    id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };
  botExecutionLog = [full, ...botExecutionLog].slice(0, BOT_EXECUTION_LOG_MAX);
  return full;
}

function getSnapshot(): TradingStoreState {
  if (cachedSnapshot !== null && cachedSnapshotVersion === snapshotVersion) {
    return cachedSnapshot;
  }
  const backtest = getBacktestState();
  const portfolio = getPortfolioState();
  const schedule = buildScheduleFromInstrumentsAndBots(instruments, bots) as RebuildScheduleEntry[];
  cachedSnapshot = {
    instruments: [...instruments],
    brokers: [...brokers],
    strategies: [...strategies],
    backtest,
    research: { ...research },
    bots: [...bots],
    execution: { ...execution },
    portfolio: { ...portfolio },
    schedule,
    closedTradesByBot: { ...closedTradesByBot },
    backwardValidation,
    botExecutionLog: [...botExecutionLog],
    botBuildLog: [...botBuildLog],
  };
  cachedSnapshotVersion = snapshotVersion;
  return cachedSnapshot;
}

/** Valid exit price from broker: must be finite and > 0. Never use 0. */
function isValidExitPrice(v: number | undefined | null): v is number {
  return v != null && Number.isFinite(v) && v > 0;
}

/** Sanitize loaded closed trades: only keep broker-confirmed (contractId). Strip estimated values.
 * For tick contracts: entryPrice is underlying (e.g. 5108), exitPrice may be wrong (stake/payout e.g. 5.86). Strip it. */
function sanitizeClosedTrades(raw: Record<string, ClosedTrade[]>): Record<string, ClosedTrade[]> {
  const out: Record<string, ClosedTrade[]> = {};
  for (const [botId, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const withContractId = list.filter((t) => t.contractId != null);
    /** Deduplicate by contractId — keep most recent per contract (avoids duplicates from sync quirks). */
    const byContract = new Map<number, ClosedTrade>();
    for (const t of withContractId) {
      const cid = t.contractId!;
      const existing = byContract.get(cid);
      if (!existing || (t.closedAt ?? '') > (existing.closedAt ?? '')) byContract.set(cid, t);
    }
    const kept = Array.from(byContract.values())
      .map((t) => {
        const ex = t.exitPrice;
        const ep = t.entryPrice;
        const isDerivTick = /inst-deriv-r\d+/i.test(t.instrumentId);
        return {
          ...t,
          exitPrice: isDerivTick ? undefined : (isValidExitPrice(ex) ? ex : undefined),
          entryPrice: isDerivTick && (ep == null || ep < 100) ? undefined : ep,
        };
      });
    if (kept.length > 0) out[botId] = kept;
  }
  return out;
}

/** Broker-confirmed data for a closed trade (Deriv profit_table or MT5).
 * When provided, these values are used exclusively — no phantom or estimated values.
 * Never stores exitPrice 0 — broker sell_price 0 (e.g. tick contracts) is treated as undefined. */
function recordClosedTrade(
  position: Position,
  exitPrice: number,
  pnlOverride?: number,
  brokerData?: {
    exitPrice?: number;
    profit: number;
    closedAt?: string;
    contractId?: number;
    brokerKey?: string;
    /** For tick contracts, buy_price may be stake; use position.entryPrice when broker buy is stake-like */
    buyPrice?: number;
    /** Override scope from bot's trade mode (respects manual fixedScope / fixedStyles / auto). */
    scope?: TradeScope;
    /** For tick contracts: stake (notional for P/L %). When set, use instead of entryPrice*size. */
    stake?: number;
    /** For tick contracts: payout (stake = payout - profit when winning). */
    payout?: number;
    /** Balance at entry (for P/L % = profit/balanceAtEntry). Use when available for tick contracts. */
    balanceAtEntry?: number;
    /** Entry time (ISO). From Deriv purchase_time for backward validation. */
    openedAt?: string;
    /** NN sl_pct, tp_r, size_mult for closed trade log consistency */
    nnSlPct?: number;
    nnTpR?: number;
    nnSizeMult?: number;
  }
): boolean {
  const list = closedTradesByBot[position.botId] ?? [];
  const pnl = brokerData != null
    ? brokerData.profit
    : pnlOverride != null && Number.isFinite(pnlOverride)
      ? pnlOverride
      : isValidExitPrice(exitPrice)
        ? position.type === 'LONG'
          ? (exitPrice - position.entryPrice) * position.size
          : (position.entryPrice - exitPrice) * position.size
        : 0;
  /** Never store 0 — broker may return sell_price 0 for tick contracts; treat as undefined. */
  const finalExitPrice = brokerData != null && isValidExitPrice(brokerData.exitPrice)
    ? brokerData.exitPrice
    : isValidExitPrice(exitPrice)
      ? exitPrice
      : undefined;
  const closedAt = brokerData?.closedAt ?? new Date().toISOString();
  const isTickContract = /inst-deriv-r\d+/i.test(position.instrumentId) ||
    instruments.some((i) => i.id === position.instrumentId && /^R_/.test(i.symbol ?? ''));
  const { pnlPercent } = computeClosedTradePnl({
    profit: pnl,
    entryPrice: position.entryPrice,
    size: position.size,
    balanceAtEntry: brokerData?.balanceAtEntry ?? position.balanceAtEntry,
    stake: brokerData?.stake,
    buyPrice: brokerData?.buyPrice,
    payout: brokerData?.payout,
    instrumentId: position.instrumentId,
    isTickContract,
  });

  /** Deduplicate by broker key first (Deriv contract_id, MT5 ticket), then by position id + values */
  const existingIdx = list.findIndex((t) => {
    if (brokerData?.contractId != null && t.contractId === brokerData.contractId) return true;
    if (brokerData?.brokerKey != null && t.brokerKey === brokerData.brokerKey) return true;
    if (t.id === position.id) return true;
    const exitMatch = finalExitPrice == null
      ? (t.exitPrice == null || !isValidExitPrice(t.exitPrice))
      : isValidExitPrice(t.exitPrice) && Math.abs(t.exitPrice - finalExitPrice) < 0.01;
    return t.instrumentId === position.instrumentId && t.entryPrice === position.entryPrice && exitMatch && Math.abs(t.pnl - pnl) < 0.01;
  });

  const scope = brokerData?.scope ?? position.scope;
  const balanceAtEntry = brokerData?.balanceAtEntry ?? position.balanceAtEntry;
  const nnSlPct = brokerData?.nnSlPct ?? position.nnSlPct;
  const nnTpR = brokerData?.nnTpR ?? position.nnTpR;
  const nnSizeMult = brokerData?.nnSizeMult ?? position.nnSizeMult;
  const isDerivTick = /inst-deriv-r\d+/i.test(position.instrumentId) || /^R_/.test(position.instrument ?? '');
  /** For tick contracts, entryPrice from broker can be stake (e.g. 2); never store it. */
  const entryPrice = isDerivTick && (position.entryPrice == null || position.entryPrice < 100)
    ? undefined
    : position.entryPrice;
  const trade: ClosedTrade = {
    id: position.id,
    botId: position.botId,
    instrumentId: position.instrumentId,
    type: position.type,
    size: position.size,
    entryPrice,
    exitPrice: isDerivTick ? undefined : finalExitPrice,
    pnl,
    pnlPercent,
    openedAt: brokerData?.openedAt ?? position.openedAt,
    closedAt,
    scope,
    contractId: brokerData?.contractId,
    brokerKey: brokerData?.brokerKey,
    balanceAtEntry,
    nnSlPct,
    nnTpR,
    nnSizeMult,
  };

  if (existingIdx >= 0) {
    /** Update existing with broker values (overwrite for correctness) */
    const updated = { ...list[existingIdx], ...trade };
    const next = [...list];
    next[existingIdx] = updated;
    closedTradesByBot[position.botId] = next.slice(-DRIFT_MAX_CLOSED_TRADES_PER_BOT);
    emit();
    return false; // not a new record, but we updated
  }

  const next = [...list, trade].slice(-DRIFT_MAX_CLOSED_TRADES_PER_BOT);
  closedTradesByBot[position.botId] = next;

  const tradeEvent = {
    kind: 'trade_close' as const,
    positionId: position.id,
    instrumentId: position.instrumentId,
    symbol: position.instrument ?? position.instrumentId,
    type: position.type,
    entryPrice,
    exitPrice: isDerivTick ? undefined : finalExitPrice,
    pnl,
    pnlPercent,
    botId: position.botId,
    timestamp: trade.closedAt,
  };
  logTradeEvent(tradeEvent);
  if (getRemoteServerUrl()) {
    const execEv = tradeEventToExecutionLog(tradeEvent);
    postExecutionLogAppend([{ id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, timestamp: new Date().toISOString(), ...execEv }]).catch(() => {});
  }
  return true;
}

/** Deriv profit_table row — used as source of truth for closed trades. */
type DerivProfitRow = { contract_id: number; buy_price: number; sell_price: number; profit: number; payout?: number; purchase_time: number; sell_time: number };

/** Record closed trades for positions we had that are no longer in broker's list (broker confirmed close).
 * For Deriv: ONLY record when profit_table has a match (no phantom). Use broker values exclusively.
 * For MT5/Exness: use getBrokerExitPrice/getBrokerProfit when provided; else live price.
 * Calls persistNow when any closed trade is recorded to mitigate data loss on crash. */
async function reconcileClosedPositions(
  existingPositions: Position[],
  newPositionIds: Set<string>,
  idToBrokerKey: (id: string) => string | null,
  options?: {
    /** Deriv: map contract_id -> profit_table row. When set, ONLY record when we have a match. */
    derivProfitByContractId?: Map<number, DerivProfitRow>;
    getLiveExitPrice?: (p: Position) => Promise<number | null>;
    getBrokerExitPrice?: (p: Position, brokerKey: string) => Promise<number | null>;
    getBrokerProfit?: (p: Position, brokerKey: string) => Promise<number | null>;
    /** Scope from bot's trade mode (manual fixedScope, fixedStyles, or auto). When set, overrides position.scope. */
    getScopeForInstrument?: (instrumentId: string) => TradeScope;
  }
) {
  let anyRecorded = false;
  const derivMap = options?.derivProfitByContractId;

  for (const p of existingPositions) {
    const key = idToBrokerKey(p.id);
    if (key == null || newPositionIds.has(key)) continue;

    if (derivMap) {
      /** Deriv: only record when broker confirms via profit_table — no phantom logging.
       * sell_price can be 0 for tick contracts (R_10, R_100); never store 0 as exit. */
      const contractId = parseInt(key, 10);
      if (!Number.isFinite(contractId)) continue;
      const row = derivMap.get(contractId);
      if (!row || !Number.isFinite(row.profit)) continue;
      const bp = row.buy_price;
      const sp = row.sell_price;
      const payout = (row as DerivProfitRow).payout;
      const ratio = bp > 0 && sp > 0 ? bp / sp : 1;
      const isStakePayout = ratio > 50 || ratio < 0.02;
      const isTickContract = /inst-deriv-r\d+/i.test(p.instrumentId);
      let stake: number | undefined;
      if (isTickContract) {
        if (row.profit < 0) stake = -row.profit;
        else if (payout != null && payout > 0) stake = payout - row.profit;
        else if (bp > 0 && bp < 100) stake = bp;
        else stake = 1;
      }
      const scopeFromMode = options?.getScopeForInstrument?.(p.instrumentId);
      const brokerData = {
        exitPrice: isStakePayout ? undefined : (isValidExitPrice(sp) ? sp : undefined),
        profit: row.profit,
        closedAt: row.sell_time > 0 ? new Date(row.sell_time * 1000).toISOString() : new Date().toISOString(),
        openedAt: row.purchase_time > 0 ? new Date(row.purchase_time * 1000).toISOString() : p.openedAt,
        contractId,
        brokerKey: key,
        buyPrice: row.buy_price,
        scope: scopeFromMode,
        stake,
        payout: row.payout,
        balanceAtEntry: p.balanceAtEntry,
      };
      if (recordClosedTrade(p, isStakePayout ? 0 : row.sell_price, row.profit, brokerData)) anyRecorded = true;
    } else {
      /** MT5/Exness: NO broker API for closed trades. Do NOT record — all values must come from broker. */
      continue;
    }
    if (p.botId) runDriftCheckForBot(p.botId);
  }
  if (anyRecorded) {
    persistNow();
    emit();
  }
}

/** Cross-check and update closed trades from Deriv profit_table (source of truth).
 * For tick contracts (R_*, etc.): buy_price/sell_price are stake/payout, NOT underlying index.
 * Only overwrite entry/exit when they look like index levels (both in 100+ range, same order of magnitude). */
function updateClosedTradesFromDerivProfitTable(profitTable: DerivProfitRow[]): void {
  const byContractId = new Map(profitTable.map((t) => [t.contract_id, t]));
  let anyUpdated = false;
  for (const botId of Object.keys(closedTradesByBot)) {
    const list = closedTradesByBot[botId];
    let botUpdated = false;
    const next = list.map((t) => {
      const cid = t.contractId;
      if (cid == null) return t;
      const row = byContractId.get(cid);
      if (!row || !Number.isFinite(row.profit)) return t;
      const closedAt = row.sell_time > 0 ? new Date(row.sell_time * 1000).toISOString() : t.closedAt;
      const buyPrice = row.buy_price;
      const sellPrice = row.sell_price;
      const payout = row.payout;
      const isTickContract = /inst-deriv-r\d+/i.test(t.instrumentId) ||
        instruments.some((i) => i.id === t.instrumentId && /^R_/.test(i.symbol ?? ''));
      const { pnlPercent } = computeClosedTradePnl({
        profit: row.profit,
        entryPrice: t.entryPrice,
        size: t.size,
        balanceAtEntry: t.balanceAtEntry,
        stake: row.profit < 0 ? -row.profit : (payout != null && payout > 0 && row.profit > 0 ? payout - row.profit : undefined),
        buyPrice: buyPrice > 0 && buyPrice < 100 ? buyPrice : undefined,
        payout,
        instrumentId: t.instrumentId,
        isTickContract,
      });
      const ratio = buyPrice > 0 && sellPrice > 0 ? buyPrice / sellPrice : 1;
      const isStakePayout = ratio > 50 || ratio < 0.02 || isTickContract;
      const bothLookLikeIndex = !isStakePayout && buyPrice >= 100 && sellPrice >= 100;
      const rawEntry = bothLookLikeIndex ? buyPrice : t.entryPrice;
      const entryPrice = isTickContract && (rawEntry == null || rawEntry < 100) ? undefined : rawEntry;
      const brokerExitPrice = isStakePayout ? undefined : (bothLookLikeIndex && isValidExitPrice(sellPrice) ? sellPrice : isValidExitPrice(sellPrice) ? sellPrice : t.exitPrice);
        const scopeFromMode = getScopeStyleFromBotForInstrument(t.instrumentId, bots, instruments).scope;
      const openedAt = row.purchase_time > 0 ? new Date(row.purchase_time * 1000).toISOString() : t.openedAt;
      if (
        t.exitPrice !== brokerExitPrice ||
        t.pnl !== row.profit ||
        t.pnlPercent !== pnlPercent ||
        t.closedAt !== closedAt ||
        t.entryPrice !== entryPrice ||
        t.scope !== scopeFromMode ||
        t.openedAt !== openedAt
      ) {
        botUpdated = true;
        return { ...t, exitPrice: brokerExitPrice, pnl: row.profit, pnlPercent, closedAt, openedAt, entryPrice: entryPrice ?? undefined, scope: scopeFromMode };
      }
      return t;
    });
    if (botUpdated) {
      closedTradesByBot[botId] = next;
      anyUpdated = true;
    }
  }
  if (anyUpdated) {
    emit();
    persistNow();
  }
}

function runDriftCheckForBot(botId: string) {
  const bot = bots.find((b) => b.id === botId);
  if (!bot || bot.driftDetectedAt) return;
  const backtest = getBacktestState();
  const closed = (closedTradesByBot[botId] ?? []).filter((t) => t.contractId != null);
  const enabledIds = getSelectedStrategyIds(strategies).strategyIds;
  const filteredResults = backtest.results.filter((r) => enabledIds.includes(r.strategyId));
  const result = checkDrift(bot, filteredResults, closed);
  if (result.drift && result.reason) {
    bots = bots.map((x) => (x.id === botId ? setDriftDetected(x, result.reason) : x));
    persistNow(); // Persist drift immediately so backend storage has it
    emit();
  }
}

function persist() {
  const portfolio = getPortfolioState();
  const backtest = getBacktestState();
  const brokerOnlyTrades = sanitizeClosedTrades(closedTradesByBot);
  // Never persist 'connecting' — WebSocket is lost on reload; save as disconnected
  const brokersToSave = brokers.map((b) => (b.status === 'connecting' ? { ...b, status: 'disconnected' as const } : b));

  // Cap heavy research persistence to avoid JSON serialization blocking the UI.
  // Research outputs can grow large (full-depth bars + large grids).
  const MAX_PERSISTED_RESEARCH_LOG_LINES = 500;
  const MAX_PERSISTED_REGIME_TUNES = 500;
  const MAX_PERSISTED_PARAM_TUNES = 1500;
  const MAX_PERSISTED_BASELINE_RESULTS = 500;

  const hasResearchData = research.paramTunes.length > 0 || research.regimeTunes.length > 0 || research.baselineResults.length > 0;
  const shouldPersistResearch = research.status === 'completed' && hasResearchData;
  const MAX_PERSISTED_BACKTEST_RESULTS = 5000;
  const persistedBacktestResults =
    backtest.status === 'running'
      ? [] // Avoid serializing a rapidly growing array on every progress tick.
      : backtest.results.slice(-MAX_PERSISTED_BACKTEST_RESULTS);

  const cappedRegimeTunes = shouldPersistResearch ? research.regimeTunes.slice(-MAX_PERSISTED_REGIME_TUNES) : [];
  const cappedParamTunes = shouldPersistResearch ? research.paramTunes.slice(-MAX_PERSISTED_PARAM_TUNES) : [];
  const cappedBaselineResults = shouldPersistResearch ? research.baselineResults.slice(-MAX_PERSISTED_BASELINE_RESULTS) : [];
  const cappedResearchLog = research.log?.length
    ? research.log.slice(-MAX_PERSISTED_RESEARCH_LOG_LINES).map((e) => ({ level: e.level, message: e.message }))
    : undefined;

  saveState({
    version: 1,
    instruments,
    brokers: brokersToSave,
    strategies: strategies.map((s) => ({ id: s.id, enabled: s.enabled })),
    bots,
    execution,
    backtest: {
      results: persistedBacktestResults,
      runRequest: backtest.runRequest,
      status: backtest.status,
      progress: backtest.progress,
      selectedTimeframes: backtest.selectedTimeframes,
      autoCompareLog: backtest.autoCompareLog,
      lastAutoCompareResult: backtest.lastAutoCompareResult,
      profitByScope: backtest.profitByScope,
    },
    research: shouldPersistResearch
      ? {
          regimeTunes: cappedRegimeTunes,
          paramTunes: cappedParamTunes,
          baselineResults: cappedBaselineResults,
          log: cappedResearchLog,
        }
      : undefined,
    closedTradesByBot: brokerOnlyTrades,
    botBuildLog: botBuildLog.slice(-MAX_PERSISTED_BOT_BUILD_LOG).map((e) => ({
      level: e.level,
      message: e.message,
      timestamp: e.timestamp,
    })),
    botExecutionLog: botExecutionLog.slice(0, BOT_EXECUTION_LOG_MAX).map((e) => ({ ...e, details: e.details as Record<string, unknown> | undefined })),
    portfolio: {
      balance: portfolio.balance,
      peakEquity: portfolio.peakEquity,
      totalPnl: portfolio.totalPnl,
      totalPnlPercent: portfolio.totalPnlPercent,
      realizedPnl: Object.values(brokerOnlyTrades).flat().reduce((s, t) => s + (t.pnl ?? 0), 0),
      dataSource: portfolio.dataSource,
      positions: portfolio.positions.map((p) => ({
        id: p.id,
        instrumentId: p.instrumentId,
        instrument: p.instrument,
        type: p.type,
        size: p.size,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice,
        pnl: p.pnl,
        pnlPercent: p.pnlPercent,
        scope: p.scope,
        style: p.style,
        botId: p.botId,
        openedAt: p.openedAt,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
        riskAmount: p.riskAmount,
        balanceAtEntry: p.balanceAtEntry,
        nnSlPct: p.nnSlPct,
        nnTpR: p.nnTpR,
        nnSizeMult: p.nnSizeMult,
      })),
    },
  });
  // Only send built bots to backend when they actually changed — avoid redundant POST on every persist
  const builtBots = bots.filter(
    (b) =>
      ['ready', 'deployed', 'building'].includes(b.status) ||
      (b.status === 'outdated' && (b.nnFeatureVector?.length ?? 0) > 0)
  );
  const builtBotsKey = JSON.stringify(builtBots);
  if (builtBotsKey !== lastPostBotsKeyRef.current) {
    lastPostBotsKeyRef.current = builtBotsKey;
    postBots(builtBots as unknown as import('../core/api').BotConfigPayload[]).catch(() => {});
  }
  // Persist positions, closed trades (broker only), balance, and P/L to backend for full restore
  const realizedPnl = Object.values(brokerOnlyTrades).flat().reduce((s, t) => s + (t.pnl ?? 0), 0);
  postPositions({
    positions: portfolio.positions.map((p) => ({ ...p })),
    closedTradesByBot: brokerOnlyTrades as unknown as Record<string, Array<Record<string, unknown>>>,
    balance: portfolio.balance,
    peakEquity: portfolio.peakEquity,
    totalPnl: portfolio.totalPnl,
    totalPnlPercent: portfolio.totalPnlPercent,
    realizedPnl,
  }).catch(() => {});
}

const persistDebounceRef = { t: 0 as ReturnType<typeof setTimeout> | 0 };
const lastPostBotsKeyRef = { current: '' };
let beforeUnloadRegistered = false;
function registerBeforeUnload() {
  if (beforeUnloadRegistered || typeof window === 'undefined') return;
  beforeUnloadRegistered = true;
  window.addEventListener('beforeunload', () => {
    persistNow();
  });
  window.addEventListener('pagehide', () => {
    persistNow();
  });
}
function schedulePersist() {
  if (persistDebounceRef.t) clearTimeout(persistDebounceRef.t);
  persistDebounceRef.t = setTimeout(() => {
    persistDebounceRef.t = 0;
    persist();
  }, 500);
}
/** Flush debounce and persist immediately. Use when backtest completes so reload doesn't lose data. */
function persistNow() {
  if (persistDebounceRef.t) {
    clearTimeout(persistDebounceRef.t);
    persistDebounceRef.t = 0;
  }
  persist();
}

/** Throttled persist: at most every intervalMs. Used during backtest so progress survives reload. */
const BACKTEST_PERSIST_INTERVAL_MS = 2000;
let lastBacktestPersistAt = 0;
function persistBacktestProgressIfDue() {
  const now = Date.now();
  if (now - lastBacktestPersistAt >= BACKTEST_PERSIST_INTERVAL_MS) {
    lastBacktestPersistAt = now;
    persistNow();
  }
}

let backtestAbortController: AbortController | null = null;
let buildAbortController: AbortController | null = null;
let buildingBotId: string | null = null;
/** Set when abort is due to broker disconnect (so catch preserves cancelled state with "Broker disconnected" instead of resetting).
 * Cleared on resetBacktest, runBacktest, and resumeBacktest for complete reset. */
let backtestAbortReason: 'broker_disconnected' | null = null;

export interface TradingStoreActions {
  setSelectedInstrument: (id: string) => void;
  setInstruments: (next: Instrument[] | ((prev: Instrument[]) => Instrument[])) => void;
  setInstrumentRebuildInterval: (instrumentId: string, hours: number) => void;
  setAllInstrumentsRebuildInterval: (hours: number) => void;
  addInstrumentsFromDeriv: (symbols: string[]) => void;
  toggleInstrumentStatus: (id: string) => void;
  toggleStrategyEnabled: (id: string) => void;
  setAllStrategiesEnabled: (enabled: boolean) => void;
  runBacktest: (request: BacktestRunRequest) => Promise<BacktestResultRow[]>;
  /** Run default + research backtest, compare total profit, use best. When research exists. */
  runBacktestWithCompare: (requestDefault: BacktestRunRequest, requestResearch: BacktestRunRequest) => Promise<BacktestResultRow[]>;
  runResearch: (request: BacktestRunRequest) => Promise<void>;
  cancelResearch: () => void;
  clearResearch: () => void;
  runBackwardValidation: () => Promise<void>;
  clearBackwardValidation: () => void;
  resumeBacktest: () => Promise<BacktestResultRow[]>;
  cancelBacktest: () => void;
  resetBacktest: () => void;
  setBacktestSelectedTimeframes: (timeframes: import('../core/types').Timeframe[]) => void;
  setExecutionEnabled: (enabled: boolean) => void;
  getOrCreateBot: (instrumentId: string) => BotConfig | null;
  setBot: (bot: BotConfig) => void;
  updateBotProgress: (botId: string, progress: number) => void;
  buildBot: (botId: string, onProgress?: (p: number) => void) => Promise<void>;
  cancelBuildBot: (botId: string) => void;
  deployBot: (botId: string) => void;
  undeployBot: (botId: string) => void;
  deployAllReadyBots: () => void;
  undeployAllBots: () => void;
  rebuildBot: (botId: string) => void;
  deleteBot: (botId: string) => void;
  deleteAllBots: () => void;
  /** Mark drift detected for early rebuild (live performance diverging from backtest). */
  setDriftDetected: (botId: string, reason?: string) => void;
  clearDriftDetected: (botId: string) => void;
  /** Clear lastError for a bot (dismiss error after user has addressed it). */
  clearBotError: (botId: string) => void;
  /** Clear lastError for all bots. */
  clearAllBotErrors: () => void;
  tickPortfolioPrices: () => void;
  /** Sync instrument spreads from live broker (MT5 or Deriv) when connected. */
  syncInstrumentSpreads: () => Promise<void>;
  /** Run bot execution: evaluate deployed bots, call NN predict, open positions via risk check. */
  tickBotExecution: () => Promise<void>;
  /** Run position-only evaluation: predict for open positions, close on NEUTRAL/opposite. */
  tickPositionEvaluation: () => Promise<void>;
  clearBotExecutionLog: () => void;
  /** Clear bot NN build trace terminal. */
  clearBotBuildLog: () => void;
  loadExecutionLogFromBackend: (options?: { merge?: boolean }) => Promise<void>;
  loadPersisted: () => void;
  addBroker: (broker: BrokerConfig) => void;
  updateBroker: (id: string, patch: Partial<BrokerConfig>) => void;
  removeBroker: (id: string) => void;
  connectBroker: (id: string, credentials?: BrokerConfigCredentials) => Promise<void>;
  /** Disconnect broker. Only call on explicit user action or actual connection loss. Components must never disconnect for refresh/retry. */
  disconnectBroker: (id: string) => void;
  /** Fetch balance from whichever broker is connected (Deriv API or MT5) and update portfolio. */
  syncPortfolioBalance: () => Promise<void>;
  /** Fetch open positions from the connected broker (MT5 or Deriv) and show them in Live Portfolio. */
  syncBrokerPositions: () => Promise<void>;
  /** Remove a position from the portfolio (local only; does not close on broker). */
  removePosition: (positionId: string) => void;
  /** Manually clear all closed trade data (user may clear stale or incorrect data). */
  clearClosedTrades: () => void;
  /** Apply MT5 connection success from login page so portfolio and broker state stay in sync. */
  applyMt5LoginSuccess: (
    credentials: { login: string; password: string; server: string },
    account: { balance: number; equity?: number }
  ) => void;
  getBrokerForInstrument: (instrumentId: string) => BrokerConfig | null;
  /** Current store state (e.g. for validation after async updates). */
  getState: () => TradingStoreState;
  /** If instrument count is below default registry size, restore full list (fixes stuck 54 etc.). */
  ensureFullInstrumentRegistry: () => void;
}

function getActions(): TradingStoreActions {
  return {
    setSelectedInstrument(id) {
      instruments = instruments.map((i) => ({ ...i, selected: i.id === id }));
      schedulePersist();
      emit();
    },
    setInstruments(next) {
      instruments = typeof next === 'function' ? next(instruments) : next;
      schedulePersist();
      emit();
    },
    setInstrumentRebuildInterval(instrumentId, hours) {
      instruments = instruments.map((i) =>
        i.id === instrumentId ? { ...i, rebuildIntervalHours: hours } : i
      );
      schedulePersist();
      emit();
    },
    setAllInstrumentsRebuildInterval(hours) {
      instruments = instruments.map((i) => ({ ...i, rebuildIntervalHours: hours }));
      schedulePersist();
      emit();
    },
    addInstrumentsFromDeriv(symbolsToAdd) {
      if (!symbolsToAdd?.length) return;
      const existingSymbols = new Set(instruments.map((i) => i.symbol.trim().toLowerCase()));
      const existingIds = new Set(instruments.map((i) => i.id));
      const TF_SYNTH = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'] as const;
      const added: Instrument[] = [];
      for (const sym of symbolsToAdd) {
        const s = sym.trim();
        if (!s || existingSymbols.has(s.toLowerCase())) continue;
        const slug = s
          .replace(/\s+/g, '-')
          .replace(/[^a-zA-Z0-9-_()]/g, '')
          .toLowerCase()
          .slice(0, 40);
        let id = `inst-deriv-${slug}`;
        let n = 0;
        while (existingIds.has(id)) {
          n += 1;
          id = `inst-deriv-${slug}-${n}`;
        }
        existingIds.add(id);
        existingSymbols.add(s.toLowerCase());
        added.push({
          id,
          symbol: s,
          type: 'synthetic_deriv',
          status: 'active',
          brokerId: BROKER_DERIV_ID,
          timeframes: [...TF_SYNTH],
          rebuildIntervalHours: 168,
        });
      }
      if (added.length > 0) {
        instruments = [...instruments, ...added];
        schedulePersist();
        emit();
      }
    },
    toggleInstrumentStatus(id) {
      instruments = instruments.map((i) =>
        i.id === id ? { ...i, status: i.status === 'active' ? 'inactive' : 'active' } : i
      );
      schedulePersist();
      emit();
    },
    toggleStrategyEnabled(id) {
      strategies = strategies.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s));
      const selectedIds = getSelectedStrategyIds(strategies).strategyIds;
      bots = bots.map((b) => ({ ...b, strategyIds: selectedIds }));
      persistNow(); // Persist immediately so strategy library selection survives reload
      emit();
    },
    setAllStrategiesEnabled(enabled) {
      strategies = strategies.map((s) => ({ ...s, enabled }));
      const selectedIds = getSelectedStrategyIds(strategies).strategyIds;
      bots = bots.map((b) => ({ ...b, strategyIds: selectedIds }));
      persistNow(); // Persist immediately so strategy library selection survives reload
      emit();
    },
    async runResearch(request) {
      if (!request.instrumentIds?.length) {
        throw new Error('No active instruments. Activate at least one in Instrument Registry.');
      }
      if (!request.strategyIds?.length) {
        throw new Error('No strategies selected. Enable at least one in Strategy Library.');
      }
      if (!request.timeframes?.length) {
        throw new Error('Select at least one timeframe to run research.');
      }
      researchAbortReason = null;
      const researchAbort = new AbortController();
      researchAbortController = researchAbort;
      research = { status: 'running', regimeTunes: [], paramTunes: [], baselineResults: [], log: [] as ResearchLogEntry[], error: undefined, progress: 0, total: undefined, completed: undefined };
      emit();
      const instrument_symbols: Record<string, string> = {};
      for (const id of request.instrumentIds) {
        const inst = instruments.find((i) => i.id === id);
        if (inst) instrument_symbols[id] = inst.symbol ?? id;
      }
      const strategy_names: Record<string, string> = {};
      for (const id of request.strategyIds) {
        const s = strategies.find((x) => x.id === id);
        if (s) strategy_names[id] = s.name ?? id;
      }
      const apiAvailable = await getHealth({ timeoutMs: getRemoteServerUrl() ? 15_000 : 5_000 });
      if (!apiAvailable) {
        research = { ...research, status: 'failed', error: 'API not available. Start Python server or connect remote.', log: [...research.log, { level: 'error', message: 'API not available.' }] };
        emit();
        return;
      }
      const needsDeriv = request.instrumentIds.some((id) => {
        const inst = instruments.find((i) => i.id === id);
        return inst?.brokerId === BROKER_DERIV_ID || (inst?.type === 'synthetic_deriv' && !inst?.brokerId);
      });
      const needsMt5 = request.instrumentIds.some((id) => {
        const inst = instruments.find((i) => i.id === id);
        const bid = inst?.brokerId ?? (inst?.type === 'synthetic_deriv' ? BROKER_DERIV_ID : BROKER_EXNESS_API_ID);
        return bid === BROKER_EXNESS_ID || bid === BROKER_EXNESS_API_ID;
      });
      const derivConnected = brokers.some((b) => b.id === BROKER_DERIV_ID && b.status === 'connected') && derivIsConnected();
      const mt5Connected = brokers.some((b) => b.type === 'mt5' && b.status === 'connected');
      if (needsDeriv && !derivConnected) {
        research = { ...research, status: 'failed', error: 'Deriv must be connected for research. Connect in Brokers panel.', log: [...research.log, { level: 'error', message: 'Deriv not connected. Connect broker before running research.' }] };
        emit();
        return;
      }
      if (needsMt5 && !mt5Connected) {
        research = { ...research, status: 'failed', error: 'MT5 must be connected for research. Connect in Brokers panel.', log: [...research.log, { level: 'error', message: 'MT5 not connected. Connect broker before running research.' }] };
        emit();
        return;
      }
      try {
        const getBarsForResearch = async (instrumentId: string, instrumentSymbol: string, timeframe: string) => {
          const inst = instruments.find((i) => i.id === instrumentId);
          const brokerId = inst?.brokerId ?? (inst?.type === 'synthetic_deriv' ? BROKER_DERIV_ID : BROKER_EXNESS_API_ID);
          return fetchOHLCV({
            instrumentId,
            symbol: instrumentSymbol,
            brokerId,
            timeframe,
            brokers,
            activity: 'backtest',
            count: BACKTEST_FULL_HISTORY_BARS,
            dateFrom: request.dateFrom ?? BACKTEST_DATE_FROM_EARLIEST,
            dateTo: request.dateTo ?? new Date().toISOString().slice(0, 10),
            signal: researchAbort.signal,
          });
        };
        const barsByKey: Record<string, Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>> = {};
        const timeframes = request.timeframes?.length ? request.timeframes : [...FULL_DEPTH_TIMEFRAMES];
        const totalFetches = request.instrumentIds.length * timeframes.length;
        let fetchCount = 0;

        const fetchResearchBars = async (instrumentId: string, sym: string, tf: string) => {
          try {
            return await getBarsForResearch(instrumentId, sym, tf);
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            const msg = `[research] OHLCV fetch failed for ${sym} ${tf}: ${detail}`;
            console.error(msg);
            pushResearchLog({ level: 'error', message: msg });
            throw new Error(msg);
          }
        };

        // Streaming research can produce a large number of progress events. To keep the UI responsive,
        // we cap the number of log lines we keep and throttle re-renders while the NDJSON stream is active.
        const MAX_RESEARCH_LOG_LINES = 400;
        const RESEARCH_STREAM_FLUSH_INTERVAL_MS = 250;
        let lastStreamFlushAt = 0;
        let streamPendingState: Partial<ResearchState> = {};
        let streamLogBuffer: ResearchLogEntry[] = [];

        const flushStreamUi = (force: boolean = false) => {
          const now = Date.now();
          const shouldFlush =
            force ||
            streamLogBuffer.length > 0 ||
            Object.keys(streamPendingState).length > 0
            ? (force || now - lastStreamFlushAt >= RESEARCH_STREAM_FLUSH_INTERVAL_MS)
            : false;
          if (!shouldFlush) return;

          const nextLog = streamLogBuffer.length > 0 ? [...research.log, ...streamLogBuffer] : research.log;
          const trimmedLog = nextLog.length > MAX_RESEARCH_LOG_LINES ? nextLog.slice(-MAX_RESEARCH_LOG_LINES) : nextLog;

          research = {
            ...research,
            ...streamPendingState,
            log: trimmedLog,
          };
          streamPendingState = {};
          streamLogBuffer = [];
          lastStreamFlushAt = now;
          emit();
        };

        const pushResearchLog = (entry: ResearchLogEntry) => {
          streamLogBuffer.push(entry);
          // Keep the UI responsive while still giving feedback.
          flushStreamUi(false);
        };

        for (const instrumentId of request.instrumentIds) {
          const sym = instrument_symbols[instrumentId] ?? instrumentId;
          for (const tf of timeframes) {
            pushResearchLog({ level: 'progress', message: `Fetching ${sym} ${tf}... (${++fetchCount}/${totalFetches})` });
            // Ensure we commit occasional log/progress updates even during large fetch loops.
            flushStreamUi(false);
            const { bars } = await fetchResearchBars(instrumentId, sym, tf);
            if (bars.length < MIN_BARS_REQUIRED_RESEARCH) {
              throw new Error(
                `Insufficient data for ${sym} ${tf}: got ${bars.length} bars, need at least ${MIN_BARS_REQUIRED_RESEARCH}. ` +
                `Check date range and broker connection. Process halted — no inference or skip.`
              );
            }
            barsByKey[`${instrumentId}|${tf}`] = bars;
          }
        }

        // This step can be large; avoid persisting full bars in persisted state because JSON serialization can
        // lock up the browser (especially for full-depth 50k bars per series).
        streamLogBuffer.push({
          level: 'info',
          message: `Fetched ${Object.keys(barsByKey).length} bar series (full depth). Starting regime calibration + param tune...`,
        });
        flushStreamUi(true);

        const instrumentSpreads: Record<string, number> = {};
        request.instrumentIds.forEach((id) => {
          const inst = instruments.find((i) => i.id === id);
          const v = inst?.spread;
          const sp = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
          if (sp != null) instrumentSpreads[id] = sp;
        });
        // Always use full regime list for param tuning. request.regimes may be ['any'] (backtest filter) — we skip that for research.
        const researchRegimes = ['trending_bull', 'trending_bear', 'ranging', 'volatile', 'breakout'];
        const res = await postResearchGridStream({
          instrumentIds: request.instrumentIds,
          strategyIds: request.strategyIds,
          timeframes: request.timeframes?.length ? request.timeframes : [...FULL_DEPTH_TIMEFRAMES],
          regimes: researchRegimes,
          dateFrom: request.dateFrom ?? BACKTEST_DATE_FROM_EARLIEST,
          dateTo: request.dateTo ?? new Date().toISOString().slice(0, 10),
          instrument_symbols,
          strategy_names,
          bars: barsByKey,
          instrument_spreads: Object.keys(instrumentSpreads).length > 0 ? instrumentSpreads : undefined,
          regime_grid_max: request.regimeGridMax ?? DEFAULT_RESEARCH_REGIME_GRID_MAX,
          param_tune_max_strat: request.paramTuneMaxStrat ?? DEFAULT_RESEARCH_PARAM_TUNE_MAX_STRAT,
          param_tune_max_risk: request.paramTuneMaxRisk ?? DEFAULT_RESEARCH_PARAM_TUNE_MAX_RISK,
          robust_mode: request.robustMode ?? false,
          calibration_hints: backwardValidation?.status === 'completed' ? backwardValidation.calibrationHints : undefined,
        }, (chunk) => {
          const c = chunk as {
            message?: string; level?: string; progress?: number; total?: number; completed?: number;
            currentPhase?: string; currentInstrument?: string; currentStrategy?: string; currentRegime?: string;
            paramJobDone?: number; paramJobTotal?: number; regimeConfigProgress?: number; regimeConfigTotal?: number;
            instrumentIdx?: number; instrumentTotal?: number;
          };
          if (c.message) {
            const level = (c.level as ResearchLogLevel) || 'info';
            streamLogBuffer.push({ level, message: c.message });
          }

          if (typeof c.progress === 'number') streamPendingState.progress = c.progress;
          if (typeof c.total === 'number') streamPendingState.total = c.total;
          if (typeof c.completed === 'number') streamPendingState.completed = c.completed;
          if (c.currentPhase != null) streamPendingState.currentPhase = c.currentPhase as ResearchState['currentPhase'];
          if (c.currentInstrument != null) streamPendingState.currentInstrument = c.currentInstrument;
          if (c.currentStrategy != null) streamPendingState.currentStrategy = c.currentStrategy;
          if (c.currentRegime != null) streamPendingState.currentRegime = c.currentRegime;
          if (typeof c.paramJobDone === 'number') streamPendingState.paramJobDone = c.paramJobDone;
          if (typeof c.paramJobTotal === 'number') streamPendingState.paramJobTotal = c.paramJobTotal;
          if (typeof c.regimeConfigProgress === 'number') streamPendingState.regimeConfigProgress = c.regimeConfigProgress;
          if (typeof c.regimeConfigTotal === 'number') streamPendingState.regimeConfigTotal = c.regimeConfigTotal;
          if (typeof c.instrumentIdx === 'number') streamPendingState.instrumentIdx = c.instrumentIdx;
          if (typeof c.instrumentTotal === 'number') streamPendingState.instrumentTotal = c.instrumentTotal;

          const now = Date.now();
          const shouldFlushNow = now - lastStreamFlushAt >= RESEARCH_STREAM_FLUSH_INTERVAL_MS || streamLogBuffer.length >= 25;
          if (shouldFlushNow) flushStreamUi(false);
        }, researchAbort.signal);

        // Ensure any buffered UI updates are applied before switching to completed/failed.
        flushStreamUi(true);
        researchAbortController = null;
        if ('error' in res) {
          research = {
            ...research,
            status: 'failed',
            regimeTunes: [],
            paramTunes: [],
            baselineResults: [],
            error: res.error,
            log: [...research.log, { level: 'error', message: `Error: ${res.error}` }].slice(-MAX_RESEARCH_LOG_LINES),
          };
        } else {
          const skipped = 'skippedInstruments' in res ? (res.skippedInstruments ?? []) : [];
          const skipMsg = skipped.length > 0
            ? ` ${skipped.length} instrument(s) skipped (${skipped.map((s) => `${s.instrumentId}: ${s.reason}`).join(', ')}).`
            : '';
          research = {
            ...research,
            status: 'completed',
            regimeTunes: res.regimeTunes ?? [],
            paramTunes: res.paramTunes ?? [],
            baselineResults: res.baselineResults ?? [],
            skippedInstruments: skipped,
            log: [...research.log, { level: 'success', message: `Research complete. ${res.regimeTunes?.length ?? 0} regime tunes, ${res.paramTunes?.length ?? 0} param tunes.${skipMsg}` }].slice(-MAX_RESEARCH_LOG_LINES),
            progress: 100,
            total: research.total,
            completed: research.completed,
          };
        }
        persistNow();
        emit();
      } catch (e) {
        researchAbortController = null;
        const isAbort = (e as Error)?.name === 'AbortError';
        const errMsg = (e as Error)?.message ?? String(e);
        const brokerDisconnectAbort = researchAbortReason === 'broker_disconnected';
        if (brokerDisconnectAbort) researchAbortReason = null;
        const isBrokerDisconnect =
          brokerDisconnectAbort ||
          /connected|disconnect|connection closed|not connected|connection lost/i.test(errMsg) ||
          (errMsg.includes('Connect') && (errMsg.includes('Brokers') || errMsg.includes('panel')));
        const logMsg = isBrokerDisconnect
          ? 'Broker disconnected during research. Reconnect in Brokers panel and try again.'
          : isAbort ? 'Research cancelled.' : `Error: ${errMsg}`;
        if (isBrokerDisconnect && typeof console !== 'undefined' && console.warn) {
          console.warn('[Research] Broker disconnected:', brokerDisconnectAbort ? 'aborted' : errMsg);
        }
        research = {
          ...research,
          status: isBrokerDisconnect ? 'failed' : (isAbort ? 'cancelled' : 'failed'),
          regimeTunes: [],
          paramTunes: [],
          error: isBrokerDisconnect ? 'Broker disconnected. Reconnect and try again.' : (isAbort ? undefined : (e instanceof Error ? e.message : 'Research failed')),
          log: [...research.log, { level: isBrokerDisconnect ? 'error' : (isAbort ? 'warning' : 'error'), message: logMsg }],
          baselineResults: [],
        };
        emit();
      }
    },
    cancelResearch() {
      if (researchAbortController) {
        researchAbortReason = null;
        researchAbortController.abort();
        researchAbortController = null;
        emit();
      }
    },
    clearResearch() {
      clearResearchBars();
      research = {
        status: 'idle',
        regimeTunes: [],
        paramTunes: [],
        baselineResults: [],
        log: [] as ResearchLogEntry[],
        progress: undefined,
        total: undefined,
        completed: undefined,
        currentPhase: undefined,
        currentInstrument: undefined,
        currentStrategy: undefined,
        currentRegime: undefined,
        paramJobDone: undefined,
        paramJobTotal: undefined,
        regimeConfigProgress: undefined,
        regimeConfigTotal: undefined,
        instrumentIdx: undefined,
        instrumentTotal: undefined,
        barsByKey: undefined,
        skippedInstruments: undefined,
      };
      schedulePersist();
      emit();
    },
    async runBackwardValidation() {
      const allTrades = Object.values(closedTradesByBot).flat();
      if (allTrades.length === 0) {
        backwardValidation = { status: 'failed', calibrationHints: {}, validatedTrades: [], summary: { total: 0, verified: 0, skipped: 0 }, error: 'No closed trades. Run live bots to accumulate trades.', log: [{ level: 'error', message: 'No closed trades. Run live bots to accumulate trades.' }] };
        emit();
        return;
      }
      const stratSel = getSelectedStrategyIds(strategies);
      if (!stratSel.strategyIds.length) {
        backwardValidation = { status: 'failed', calibrationHints: {}, validatedTrades: [], summary: { total: allTrades.length, verified: 0, skipped: allTrades.length }, error: 'No strategies enabled. Enable strategies in Strategy Library.', log: [{ level: 'error', message: 'No strategies enabled. Enable strategies in Strategy Library.' }] };
        emit();
        return;
      }
      backwardValidation = { status: 'running', calibrationHints: {}, validatedTrades: [], summary: { total: allTrades.length, verified: 0, skipped: 0 }, log: [{ level: 'info', message: `Starting backward validation: ${allTrades.length} trades, ${stratSel.strategyIds.length} strategies` }] };
      emit();
      const instrumentIds = [...new Set(allTrades.map((t) => t.instrumentId))];
      const instrument_symbols: Record<string, string> = {};
      for (const id of instrumentIds) {
        const inst = instruments.find((i) => i.id === id);
        instrument_symbols[id] = inst?.symbol ?? id;
      }
      // Must match `SCOPE_TO_TIMEFRAME` in python/cicada_nn/backward_validation.py (swing→H4, position→D1)
      const timeframes: Timeframe[] = ['M5', 'H1', 'H4', 'D1'];
      const barsByKey: Record<string, Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>> = {};
      try {
        backwardValidation = { ...backwardValidation!, log: [...backwardValidation!.log, { level: 'progress', message: `Fetching bars for ${instrumentIds.length} instruments (${timeframes.join(', ')})...` }] };
        emit();
        for (const instrumentId of instrumentIds) {
          const sym = instrument_symbols[instrumentId];
          const inst = instruments.find((i) => i.id === instrumentId);
          const brokerId = inst?.brokerId ?? (inst?.type === 'synthetic_deriv' ? BROKER_DERIV_ID : BROKER_EXNESS_API_ID);
          for (const tf of timeframes) {
            const { bars } = await fetchOHLCV({
              instrumentId: instrumentId,
              symbol: sym,
              brokerId,
              timeframe: tf,
              brokers,
              activity: 'backtest',
              count: BACKTEST_FULL_HISTORY_BARS,
              dateFrom: BACKTEST_DATE_FROM_EARLIEST,
              dateTo: new Date().toISOString().slice(0, 10),
            });
            if (bars.length > 0) barsByKey[`${instrumentId}|${tf}`] = bars;
          }
        }
        const barKeys = Object.keys(barsByKey).length;
        backwardValidation = { ...backwardValidation!, log: [...backwardValidation!.log, { level: 'info', message: `Fetched ${barKeys} bar series. Running backward validation...` }] };
        emit();
        const res = await postBackwardValidate({
          closed_trades: allTrades.map((t) => ({
            instrumentId: t.instrumentId,
            botId: t.botId ?? '',
            type: t.type ?? '',
            pnl: t.pnl ?? 0,
            entryPrice: t.entryPrice,
            openedAt: t.openedAt,
            closedAt: t.closedAt ?? '',
            scope: t.scope,
            nnSlPct: t.nnSlPct,
            nnTpR: t.nnTpR,
          })),
          bars: barsByKey,
          instrument_symbols,
          strategy_ids: stratSel.strategyIds,
        });
        if ('error' in res) {
          backwardValidation = {
            status: 'failed',
            calibrationHints: {},
            validatedTrades: [],
            summary: { total: allTrades.length, verified: 0, skipped: allTrades.length },
            error: res.error,
            log: [...backwardValidation!.log, { level: 'error', message: `Error: ${res.error}` }],
          };
        } else {
          const sum = res.summary ?? { total: allTrades.length, verified: 0, skipped: allTrades.length };
          const hintsCount = Object.keys(res.calibrationHints ?? {}).length;
          backwardValidation = {
            status: 'completed',
            calibrationHints: res.calibrationHints ?? {},
            validatedTrades: res.validatedTrades ?? [],
            summary: sum,
            log: [
              ...backwardValidation!.log,
              { level: 'success', message: `Done: ${sum.verified} verified, ${sum.skipped} skipped, ${hintsCount} calibration hints` },
            ],
          };
        }
      } catch (e) {
        backwardValidation = {
          status: 'failed',
          calibrationHints: {},
          validatedTrades: [],
          summary: { total: allTrades.length, verified: 0, skipped: allTrades.length },
          error: e instanceof Error ? e.message : 'Backward validation failed',
          log: [...backwardValidation!.log, { level: 'error', message: `Error: ${e instanceof Error ? e.message : 'Backward validation failed'}` }],
        };
      }
      emit();
    },
    clearBackwardValidation() {
      backwardValidation = null;
      emit();
    },
    async runBacktest(request) {
      if (!request.instrumentIds?.length) {
        throw new Error('No active instruments. Activate at least one in Instrument Registry.');
      }
      if (!request.strategyIds?.length) {
        throw new Error('No strategies selected. Enable at least one in Strategy Library.');
      }
      if (!request.timeframes?.length) {
        throw new Error('Select at least one timeframe to run backtest.');
      }
      if (request.dateFrom && request.dateTo && request.dateFrom > request.dateTo) {
        throw new Error('Invalid date range: dateFrom must not be after dateTo.');
      }

      backtestAbortController?.abort();
      backtestAbortController = new AbortController();
      backtestAbortReason = null;

      // Show running state immediately so user sees feedback (dots, progress) right away
      setBacktestRunning(request, 'Starting backtest...');
      persistNow(); // Persist runRequest + status so reload can resume
      emit();

      const instrument_symbols: Record<string, string> = {};
      for (const id of request.instrumentIds) {
        const inst = instruments.find((i) => i.id === id);
        if (inst) instrument_symbols[id] = inst.symbol ?? id;
      }
      const strategy_names: Record<string, string> = {};
      for (const id of request.strategyIds) {
        const s = strategies.find((x) => x.id === id);
        if (s) strategy_names[id] = s.name ?? id;
      }

      const remoteConfigured = getRemoteServerUrl() != null;
      const apiAvailable = await getHealth({ timeoutMs: remoteConfigured ? 15_000 : 5_000 });
      if (apiAvailable) {
        const hasDerivInstruments = request.instrumentIds.some((id) => {
          const inst = instruments.find((i) => i.id === id);
          return inst?.brokerId === BROKER_DERIV_ID;
        });
        const hasMt5Instruments = request.instrumentIds.some((id) => {
          const inst = instruments.find((i) => i.id === id);
          return inst?.brokerId === BROKER_EXNESS_ID || inst?.brokerId === BROKER_EXNESS_API_ID;
        });
        const derivConnected = brokers.some((b) => b.id === BROKER_DERIV_ID && b.status === 'connected');
        const mt5Connected = brokers.some((b) => b.type === 'mt5' && b.status === 'connected');
        let phase: string;
        if (hasDerivInstruments && derivConnected) {
          phase = 'Fetching from Deriv (ticks_history)...';
        } else if (hasDerivInstruments && !derivConnected) {
          phase = 'Deriv not connected — connect in Brokers to run backtest';
          setBacktestPhase(phase);
          setBacktestFailed('Deriv must be connected for Deriv instruments. Connect in Brokers panel.');
          emit();
          throw new Error('Deriv must be connected for Deriv instruments. Connect in Brokers panel.');
        } else if (hasMt5Instruments && !mt5Connected) {
          phase = 'MT5 not connected — connect in Brokers to run backtest';
          setBacktestPhase(phase);
          setBacktestFailed('MT5 must be connected for MT5/eXness instruments. Connect in Brokers panel.');
          emit();
          throw new Error('MT5 must be connected for MT5/eXness instruments. Connect in Brokers panel.');
        } else if (mt5Connected) {
          phase = 'Fetching from MT5...';
        } else {
          phase = 'Fetching OHLCV data...';
        }
        setBacktestPhase(phase);
        emit();
        try {
          const getBarsForServer = async (instrumentId: string, instrumentSymbol: string, timeframe: string) => {
            const inst = instruments.find((i) => i.id === instrumentId);
            const symbol = inst?.symbol ?? instrumentSymbol;
            const brokerId = inst?.brokerId ?? (inst?.type === 'synthetic_deriv' ? BROKER_DERIV_ID : BROKER_EXNESS_API_ID);
            return fetchOHLCV({
              instrumentId,
              symbol,
              brokerId,
              timeframe,
              brokers,
              activity: 'backtest',
              count: BACKTEST_FULL_HISTORY_BARS,
              dateFrom: request.dateFrom,
              dateTo: request.dateTo,
              signal: backtestAbortController!.signal,
            });
          };
          const barsByKey: Record<string, Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>> = {};
          const timeframes = request.timeframes ?? [];
          const htfUnion = new Set<string>();
          for (const tf of timeframes) {
            const h = getHigherTimeframe(tf as Timeframe);
            if (h) htfUnion.add(h);
          }
          const totalFetchesPerInstrument = timeframes.length + htfUnion.size;
          const totalFetches = request.instrumentIds.length * totalFetchesPerInstrument;
          let fetchCount = 0;
          for (const instrumentId of request.instrumentIds) {
            if (backtestAbortController!.signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const sym = instrument_symbols[instrumentId] ?? instrumentId;
            const inst = instruments.find((i) => i.id === instrumentId);
            const source = inst?.brokerId === BROKER_DERIV_ID && derivConnected ? 'Deriv' : mt5Connected ? 'MT5' : 'live';
            for (const tf of timeframes) {
              if (backtestAbortController!.signal.aborted) throw new DOMException('Aborted', 'AbortError');
              setBacktestPhase(`Fetching ${sym} ${tf} from ${source}... (${++fetchCount}/${totalFetches})`);
              emit();
              let bars: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>;
              try {
                const res = await getBarsForServer(instrumentId, sym, tf);
                bars = res.bars;
              } catch (e) {
                if ((e as Error)?.name === 'AbortError') throw e;
                const detail = e instanceof Error ? e.message : String(e);
                const msg = `[backtest] OHLCV fetch failed for ${sym} ${tf}: ${detail}`;
                console.error(msg);
                setBacktestPhase(`Error — ${msg}`);
                setBacktestFailed(msg);
                emit();
                throw new Error(msg);
              }
              if (bars.length < MIN_BARS_REQUIRED_BACKTEST) {
                const msg =
                  `[backtest] Insufficient data for ${sym} ${tf}: got ${bars.length} bars, need at least ${MIN_BARS_REQUIRED_BACKTEST}. ` +
                  `Check date range and broker connection.`;
                console.error(msg);
                setBacktestFailed(msg);
                emit();
                throw new Error(msg);
              }
              barsByKey[`${instrumentId}|${tf}`] = bars;
            }
            for (const htf of htfUnion) {
              if (backtestAbortController!.signal.aborted) throw new DOMException('Aborted', 'AbortError');
              const hKey = `${instrumentId}|${htf}`;
              if (barsByKey[hKey]) continue;
              setBacktestPhase(`Fetching ${sym} ${htf} (HTF context)... (${++fetchCount}/${totalFetches})`);
              emit();
              try {
                const { bars: htfBars } = await getBarsForServer(instrumentId, sym, htf);
                if (htfBars.length < MIN_BARS_REQUIRED_BACKTEST) {
                  const msg = `[backtest] Insufficient HTF data for ${sym} ${htf}: got ${htfBars.length} bars, need at least ${MIN_BARS_REQUIRED_BACKTEST}.`;
                  console.error(msg);
                  setBacktestFailed(msg);
                  emit();
                  throw new Error(msg);
                }
                barsByKey[hKey] = htfBars;
              } catch (e) {
                if ((e as Error)?.name === 'AbortError') throw e;
                if (e instanceof Error && e.message.startsWith('[backtest]')) throw e;
                const detail = e instanceof Error ? e.message : String(e);
                const msg = `[backtest] OHLCV fetch failed for ${sym} ${htf} (HTF): ${detail}`;
                console.error(msg);
                setBacktestFailed(msg);
                emit();
                throw new Error(msg);
              }
            }
          }
          if (backtestAbortController!.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const analyzed = analyzeInstrumentRiskFromBars(barsByKey, request.instrumentIds, instrument_symbols);
          const instrumentRiskOverrides = Object.keys(analyzed).length > 0
            ? { ...request.instrumentRiskOverrides, ...Object.fromEntries(Object.entries(analyzed).map(([id, p]) => [id, { riskPerTradePct: p.riskPerTradePct, stopLossPct: p.stopLossPct, takeProfitR: p.takeProfitR }])) }
            : request.instrumentRiskOverrides;
          const baseJobRiskOverrides = buildJobRiskOverrides(
            request.strategyIds ?? [],
            request.instrumentIds,
            instrument_symbols
          );
          // Use request.jobRiskOverrides when provided (BacktestEngine builds with validated filter).
          // Otherwise build from research, filtering by validated regime (same logic as BacktestEngine).
          const validatedIds = new Set(
            (research?.regimeTunes ?? []).filter((r) => r.validated !== false).map((r) => r.instrumentId)
          );
          const validParamTunes = (research?.paramTunes ?? []).filter((t) => validatedIds.has(t.instrumentId));
          const researchOverrides = validParamTunes.length > 0 ? buildJobRiskOverridesFromParamTunes(validParamTunes) : {};
          const jobRiskOverrides =
            request.jobRiskOverrides && Object.keys(request.jobRiskOverrides).length > 0
              ? request.jobRiskOverrides
              : Object.keys(researchOverrides).length > 0
                ? { ...baseJobRiskOverrides, ...researchOverrides }
                : baseJobRiskOverrides;
          setBacktestPhase('Processing on server...');
          emit();
          const streamedRows: BacktestResultRow[] = [];
          const serverRes = await postBacktestStream({
            instrumentIds: request.instrumentIds,
            strategyIds: request.strategyIds,
            timeframes: request.timeframes ?? [],
            regimes: request.regimes ?? [],
            dateFrom: request.dateFrom ?? '',
            dateTo: request.dateTo ?? '',
            instrument_symbols,
            strategy_names,
            bars: barsByKey,
            instrumentSpreads: request.instrumentSpreads,
            riskPerTradePct: request.riskPerTradePct,
            stopLossPct: request.stopLossPct,
            takeProfitR: request.takeProfitR,
            regimeLookback: request.regimeLookback,
            initialEquity: request.initialEquity,
            slippagePct: request.slippagePct,
            instrumentRiskOverrides,
            jobRiskOverrides: Object.keys(jobRiskOverrides).length > 0 ? jobRiskOverrides : undefined,
            paramCombosLimit: request.paramCombosLimit ?? DEFAULT_BACKTEST_PARAM_COMBOS_LIMIT,
            regimeTunes: request.regimeTunes,
            preferHtfRegime: request.preferHtfRegime,
            instrumentTypes: Object.fromEntries(instruments.map((i) => [i.id, i.type])),
          }, (chunk) => {
            if (chunk.type === 'progress') {
              const phase = chunk.phase ?? `Processing on server... (${chunk.completed ?? 0}/${chunk.total ?? 0})`;
              setBacktestPhase(phase);
              emit();
              return;
            }
            if (chunk.type === 'row' && chunk.row) {
              const row = chunk.row.status === 'completed' && !chunk.row.dataSource
                ? { ...chunk.row, dataSource: 'live' as const }
                : chunk.row;
              streamedRows.push(row);
              const st = getBacktestState();
              hydrateBacktestState({
                results: streamedRows,
                runRequest: request,
                status: 'running',
                progress: typeof chunk.progress === 'number' ? chunk.progress : st.progress,
                currentPhase: chunk.phase ?? `Processing on server... (${chunk.completed ?? streamedRows.length}/${chunk.total ?? streamedRows.length})`,
                autoCompareLog: st.autoCompareLog,
                lastAutoCompareResult: st.lastAutoCompareResult,
              });
              persistBacktestProgressIfDue();
              emit();
            }
          }, backtestAbortController!.signal);
          if ('error' in serverRes) {
            setBacktestFailed(`Backend error: ${serverRes.error}`);
            emit();
            throw new Error(`Backend error: ${serverRes.error}`);
          } else {
            const allFailed = serverRes.results.every((r: { status?: string }) => r.status === 'failed');
            if (serverRes.results.length > 0 && !allFailed) {
              const rows = (serverRes.results as BacktestResultRow[]).map((r) =>
                r.status === 'completed' && !r.dataSource ? { ...r, dataSource: 'live' as const } : r
              );
              const st = getBacktestState();
              hydrateBacktestState({
                results: rows,
                runRequest: request,
                autoCompareLog: st.autoCompareLog,
                lastAutoCompareResult: st.lastAutoCompareResult,
              });
              clearBacktestRelatedBotErrors(new Set(request.instrumentIds));
              persistNow();
              emit();
              return serverRes.results as BacktestResultRow[];
            }
            const msg = 'Backend returned no successful backtest rows.';
            setBacktestFailed(msg);
            emit();
            throw new Error(msg);
          }
        } catch (e) {
          if ((e as Error)?.name === 'AbortError') {
          if (backtestAbortReason === 'broker_disconnected') {
            backtestAbortReason = null;
            const st = getBacktestState();
            setBacktestCancelled(st.results, st.runRequest, 'Broker disconnected');
          } else {
            resetBacktestResults();
          }
          persistNow();
          emit();
          return [];
        }
        setBacktestFailed(e instanceof Error ? e.message : 'Backtest failed');
        emit();
        throw e;
        }
      }

      if (!apiAvailable) {
        throw new Error(
          isRemoteOffloadConfigured()
            ? 'Backend unreachable. Check Server Offload URL, network, and firewall.'
            : 'Backend unreachable. Start the NN API server (e.g. uvicorn cicada_nn.api:app --reload --host 0.0.0.0 --port 8000) or check backend URL.'
        );
      }

      const getBars = async (instrumentId: string, instrumentSymbol: string, timeframe: string) => {
        const inst = instruments.find((i) => i.id === instrumentId);
        const symbol = inst?.symbol ?? instrumentSymbol;
        const brokerId = inst?.brokerId ?? (inst?.type === 'synthetic_deriv' ? BROKER_DERIV_ID : BROKER_EXNESS_API_ID);
        try {
          return await fetchOHLCV({
            instrumentId,
            symbol,
            brokerId,
            timeframe,
            brokers,
            activity: 'backtest',
            count: BACKTEST_FULL_HISTORY_BARS,
            dateFrom: request.dateFrom,
            dateTo: request.dateTo,
            signal: backtestAbortController!.signal,
          });
        } catch (e) {
          if ((e as Error)?.name === 'AbortError') throw e;
          const detail = e instanceof Error ? e.message : String(e);
          const msg = `[backtest] OHLCV fetch failed for ${symbol} ${timeframe}: ${detail}`;
          console.error(msg);
          setBacktestPhase(`Error — ${msg}`);
          emit();
          throw new Error(msg);
        }
      };
      try {
        const hasDerivInstruments = request.instrumentIds.some((id) => {
          const inst = instruments.find((i) => i.id === id);
          return inst?.brokerId === BROKER_DERIV_ID;
        });
        const hasMt5Instruments = request.instrumentIds.some((id) => {
          const inst = instruments.find((i) => i.id === id);
          return inst?.brokerId === BROKER_EXNESS_ID || inst?.brokerId === BROKER_EXNESS_API_ID;
        });
        const onProgress = () => {
          emit();
          if (backtestAbortController && !backtestAbortController.signal.aborted) {
            const st = getBacktestState();
            if (st.status === 'running') persistBacktestProgressIfDue();
          }
        };
        const requestWithSymbols = { ...request, instrument_symbols };
        const instTypeIndex = new Map(instruments.map((i) => [i.id, i.type]));
        const getInstrumentType = (id: string) => instTypeIndex.get(id);
        const results = await runBacktest(
          requestWithSymbols,
          onProgress,
          getBars,
          backtestAbortController!.signal,
          undefined,
          getInstrumentType
        );
        if (backtestAbortReason === 'broker_disconnected') {
          backtestAbortReason = null;
          setBacktestCancelled(results, request, 'Broker disconnected');
          emit();
        } else {
          const completedInstrumentIds = new Set(
            results.filter((r) => r.status === 'completed').map((r) => r.instrumentId)
          );
          clearBacktestRelatedBotErrors(completedInstrumentIds);
        }
        persistNow();
        return results;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') {
          if (backtestAbortReason === 'broker_disconnected') {
            backtestAbortReason = null;
            const st = getBacktestState();
            setBacktestCancelled(st.results, st.runRequest, 'Broker disconnected');
          } else {
            resetBacktestResults();
          }
          persistNow();
          emit();
          return [];
        }
        setBacktestFailed(e instanceof Error ? e.message : 'Backtest failed');
        emit();
        throw e;
      }
    },
    async resumeBacktest() {
      const state = getBacktestState();
      if (!state.runRequest) {
        throw new Error('Nothing to resume. Run a backtest first.');
      }
      const totalEst = estimateBacktestJobCount(state.runRequest);
      if (totalEst != null && state.results.length >= totalEst) {
        return state.results;
      }
      backtestAbortController?.abort();
      backtestAbortController = new AbortController();
      backtestAbortReason = null;
      const request = state.runRequest;
      const instrument_symbols: Record<string, string> = {};
      for (const id of request.instrumentIds) {
        const inst = instruments.find((i) => i.id === id);
        if (inst) instrument_symbols[id] = inst.symbol ?? id;
      }
      const strategy_names: Record<string, string> = {};
      for (const id of request.strategyIds) {
        const s = strategies.find((x) => x.id === id);
        if (s) strategy_names[id] = s.name ?? id;
      }
      const getBars = async (instrumentId: string, instrumentSymbol: string, timeframe: string) => {
        const inst = instruments.find((i) => i.id === instrumentId);
        const symbol = inst?.symbol ?? instrumentSymbol;
        const brokerId = inst?.brokerId ?? (inst?.type === 'synthetic_deriv' ? BROKER_DERIV_ID : BROKER_EXNESS_API_ID);
        try {
          return await fetchOHLCV({
            instrumentId,
            symbol,
            brokerId,
            timeframe,
            brokers,
            activity: 'backtest',
            count: BACKTEST_FULL_HISTORY_BARS,
            dateFrom: request.dateFrom,
            dateTo: request.dateTo,
            signal: backtestAbortController!.signal,
          });
        } catch (e) {
          if ((e as Error)?.name === 'AbortError') throw e;
          const detail = e instanceof Error ? e.message : String(e);
          const msg = `[backtest] OHLCV fetch failed for ${symbol} ${timeframe}: ${detail}`;
          console.error(msg);
          setBacktestPhase(`Error — ${msg}`);
          emit();
          throw new Error(msg);
        }
      };
      try {
        const onProgress = () => {
          emit();
          if (backtestAbortController && !backtestAbortController.signal.aborted) {
            const st = getBacktestState();
            if (st.status === 'running') persistBacktestProgressIfDue();
          }
        };
        const requestWithSymbols = { ...request, instrument_symbols };
        const results = await runBacktest(
          requestWithSymbols,
          onProgress,
          getBars,
          backtestAbortController!.signal,
          state.results
        );
        if (backtestAbortReason === 'broker_disconnected') {
          backtestAbortReason = null;
          setBacktestCancelled(results, request, 'Broker disconnected');
          emit();
        } else {
          const completedInstrumentIds = new Set(
            results.filter((r) => r.status === 'completed').map((r) => r.instrumentId)
          );
          clearBacktestRelatedBotErrors(completedInstrumentIds);
        }
        persistNow();
        return results;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') {
          if (backtestAbortReason === 'broker_disconnected') {
            backtestAbortReason = null;
            const st = getBacktestState();
            setBacktestCancelled(st.results, st.runRequest, 'Broker disconnected');
          } else {
            resetBacktestResults();
          }
          persistNow();
          emit();
          return [];
        }
        setBacktestFailed(e instanceof Error ? e.message : 'Backtest failed');
        emit();
        throw e;
      }
    },
    async runBacktestWithCompare(requestDefault: BacktestRunRequest, requestResearch: BacktestRunRequest) {
      clearAutoCompareLog();
      appendAutoCompareLog('info', 'Auto-compare: running default backtest (1/2)...');
      setBacktestPhase('Auto-compare: default config (1/2)...');
      emit();

      const resultsDefault = await this.runBacktest(requestDefault);
      if (backtestAbortController?.signal.aborted) {
        appendAutoCompareLog('warning', 'Auto-compare cancelled — not running research backtest');
        hydrateBacktestState({
          results: resultsDefault,
          runRequest: requestDefault,
          status: 'cancelled',
          progress: 100,
          currentPhase: 'Auto-compare cancelled (after default run)',
          autoCompareLog: getBacktestState().autoCompareLog,
          lastAutoCompareResult: null,
        });
        persistNow();
        emit();
        return resultsDefault;
      }
      const profitDefault = resultsDefault.reduce((s, r) => s + r.profit, 0);
      appendAutoCompareLog('success', `Default backtest complete: $${profitDefault.toFixed(2)} total profit`);
      emit();

      appendAutoCompareLog('info', 'Auto-compare: running research backtest (2/2)...');
      setBacktestPhase('Auto-compare: research config (2/2)...');
      emit();

      const resultsResearch = await this.runBacktest(requestResearch);
      if (backtestAbortController?.signal.aborted) {
        appendAutoCompareLog('warning', 'Auto-compare cancelled during research run — using default results');
        hydrateBacktestState({
          results: resultsDefault,
          runRequest: requestDefault,
          status: 'cancelled',
          progress: 100,
          currentPhase: 'Auto-compare cancelled',
          autoCompareLog: getBacktestState().autoCompareLog,
          lastAutoCompareResult: null,
        });
        persistNow();
        emit();
        return resultsDefault;
      }
      const profitResearch = resultsResearch.reduce((s, r) => s + r.profit, 0);
      appendAutoCompareLog('success', `Research backtest complete: $${profitResearch.toFixed(2)} total profit`);
      emit();

      const winner: 'default' | 'research' = profitDefault > profitResearch ? 'default' : 'research';
      const result = {
        winner,
        profitDefault,
        profitResearch,
        timestamp: new Date().toISOString(),
      };
      setLastAutoCompareResult(result);

      const phaseMsg = `Auto-compare: ${winner.toUpperCase()} config selected ($${(winner === 'default' ? profitDefault : profitResearch).toFixed(2)})`;
      if (winner === 'default') {
        appendAutoCompareLog(
          'warning',
          `Selected: DEFAULT config ($${profitDefault.toFixed(2)} vs research $${profitResearch.toFixed(2)})`
        );
        hydrateBacktestState({
          results: resultsDefault,
          runRequest: requestDefault,
          status: 'completed',
          progress: 100,
          currentPhase: phaseMsg,
          autoCompareLog: getBacktestState().autoCompareLog,
          lastAutoCompareResult: result,
        });
      } else {
        appendAutoCompareLog(
          'success',
          `Selected: RESEARCH config ($${profitResearch.toFixed(2)} vs default $${profitDefault.toFixed(2)})`
        );
        hydrateBacktestState({
          results: resultsResearch,
          runRequest: requestResearch,
          status: 'completed',
          progress: 100,
          currentPhase: phaseMsg,
          autoCompareLog: getBacktestState().autoCompareLog,
          lastAutoCompareResult: result,
        });
      }
      persistNow();
      emit();
      return winner === 'default' ? resultsDefault : resultsResearch;
    },
    cancelBacktest() {
      backtestAbortController?.abort();
      const st = getBacktestState();
      if (st.status === 'running' && (st.results.length > 0 || st.runRequest)) {
        setBacktestCancelled(st.results, st.runRequest);
        persistNow();
        emit();
      }
    },
    resetBacktest() {
      backtestAbortReason = null;
      resetBacktestResults();
      persistNow();
      emit();
    },
    setBacktestSelectedTimeframes(timeframes) {
      setBacktestSelectedTimeframes(timeframes);
      schedulePersist();
      emit();
    },
    setExecutionEnabled(enabled) {
      execution = createExecutionState(enabled);
      schedulePersist();
      emit();
    },
    getOrCreateBot(instrumentId) {
      const inst = instruments.find((i) => i.id === instrumentId);
      if (!inst) return null;
      let bot = bots.find((b) => b.instrumentId === instrumentId);
      if (!bot) {
        const selectedIds = getSelectedStrategyIds(strategies).strategyIds;
        bot = createBotForInstrument(inst, { strategyIds: selectedIds });
        bots = [...bots, bot];
        schedulePersist();
        emit();
      }
      return bot;
    },
    setBot(bot) {
      const idx = bots.findIndex((b) => b.id === bot.id);
      const prev = idx >= 0 ? bots[idx] : null;
      let next = bot;
      // Auto-clear lastError when user fixes the underlying condition
      if (prev?.lastError) {
        if (bot.timeframes.length > 0 && prev.lastError === 'Select at least one timeframe in Bot Builder') {
          next = { ...next, lastError: undefined };
        } else if (getSelectedStrategyIds(strategies).strategyIds.length > 0 && prev.lastError === 'No strategies enabled. Enable at least one in Strategy Library.') {
          next = { ...next, lastError: undefined };
        }
      }
      if (idx >= 0) bots = [...bots.slice(0, idx), next, ...bots.slice(idx + 1)];
      else bots = [...bots, next];
      schedulePersist();
      emit();
    },
    updateBotProgress(botId, progress) {
      const b = bots.find((x) => x.id === botId);
      if (b) {
        const next = setBotBuildProgress(b, progress);
        bots = bots.map((x) => (x.id === botId ? next : x));
        emit();
      }
    },
    async buildBot(botId, onProgress) {
      const b = bots.find((x) => x.id === botId);
      if (!b) return;
      if (b.timeframes.length === 0) {
        bots = bots.map((x) => (x.id === botId ? { ...x, status: 'outdated' as const, lastError: 'Select at least one timeframe in Bot Builder' } : x));
        scheduleClearBotError(botId);
        schedulePersist();
        emit();
        return;
      }
      buildAbortController?.abort();
      buildAbortController = new AbortController();
      buildingBotId = botId;
      bots = bots.map((x) => (x.id === botId ? setBotStatus(x, 'building', 0) : x));
      emit();

      botBuildLog = [];
      const buildT0 =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
      const elapsed = () =>
        Math.round(
          (typeof performance !== 'undefined' ? performance.now() : Date.now()) - buildT0
        );
      const log = (level: ResearchLogLevel, msg: string) =>
        appendBotBuildLog(level, `[+${elapsed()}ms] ${msg}`);
      log('info', `Session start | bot="${b.name}" | symbol=${b.instrumentSymbol} | instrumentId=${b.instrumentId}`);
      log('info', `NN API base URL: ${getNnApiBaseUrl()}`);

      /** Drive progress bar + ETA; monotonic so later steps never lower the bar (e.g. 58% before NN vs 70% after bar fetch). */
      const bumpProgress = (p: number) => {
        let applied = p;
        bots = bots.map((x) => {
          if (x.id !== botId) return x;
          const next = Math.max(x.buildProgress ?? 0, Math.min(99, p));
          applied = next;
          return setBotBuildProgress(x, next);
        });
        emit();
        onProgress?.(applied);
      };

      const healthT0 =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
      const apiAvailable = await getHealth();
      log(
        apiAvailable ? 'success' : 'error',
        `GET /health → ${apiAvailable ? 'ok' : 'unreachable'} (${Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - healthT0)}ms)`
      );
      const backtestState = getBacktestState();
      const instrumentTypes: Record<string, string> = {};
      instruments.forEach((i) => { instrumentTypes[i.id] = i.type; });

      if (!apiAvailable) {
        log('error', 'Abort: NN API not reachable — start Python service or fix VITE_NN_API_URL / Server Offload.');
        bots = bots.map((x) => (x.id === botId ? { ...x, status: 'outdated' as const, lastError: 'Backend unavailable' } : x));
        scheduleClearBotError(botId);
        buildingBotId = null;
        schedulePersist();
        emit();
        return;
      }

      const backtestResults = backtestState.results;
      if (backtestState.status !== 'completed') {
        const msg = backtestState.status === 'cancelled'
          ? 'Full backtest required. Run a backtest and let it complete (do not cancel).'
          : backtestResults.length === 0
            ? 'Run a backtest first'
            : 'Full backtest required. Run a backtest and let it complete.';
        log('error', `Abort: backtest status="${backtestState.status}" — ${msg}`);
        bots = bots.map((x) => (x.id === botId ? { ...x, status: 'outdated' as const, lastError: msg } : x));
        scheduleClearBotError(botId);
        buildingBotId = null;
        schedulePersist();
        emit();
        return;
      }
      if (backtestResults.length === 0) {
        log('error', 'Abort: backtest results empty — run a backtest first.');
        bots = bots.map((x) => (x.id === botId ? { ...x, status: 'outdated' as const, lastError: 'Run a backtest first' } : x));
        scheduleClearBotError(botId);
        buildingBotId = null;
        schedulePersist();
        emit();
        return;
      }
      log(
        'info',
        `Backtest OK | rows=${backtestResults.length} completed | status=${backtestState.status}`
      );
      bumpProgress(5);

      // NN build uses only live broker data; synthetic/cached data must not affect the real model.
      const liveResults = backtestResults.filter((r) => r.dataSource === 'live');
      log('info', `Filtered live OHLCV rows: ${liveResults.length} (dataSource===live)`);
      if (liveResults.length === 0) {
        log('error', 'Abort: no live backtest rows — connect Deriv or MT5 and re-run backtest.');
        bots = bots.map((x) =>
          x.id === botId
            ? { ...x, status: 'outdated' as const, lastError: 'NN build uses live data only. Connect a broker (Deriv or eXness/MT5) and run backtest to get live OHLCV, then build.' }
            : x
        );
        scheduleClearBotError(botId);
        buildingBotId = null;
        schedulePersist();
        emit();
        return;
      }
      bumpProgress(10);

      // Strategies 100% from Strategy Library (enabled only). No per-bot override. Robust detection.
      const buildSelection = getSelectedStrategyIds(strategies);
      const buildStrategyIds = buildSelection.strategyIds;
      log('info', `Strategy library | enabled count=${buildStrategyIds.length} ids=[${buildStrategyIds.slice(0, 12).join(',')}${buildStrategyIds.length > 12 ? ',…' : ''}]`);
      if (buildStrategyIds.length === 0) {
        log('error', 'Abort: no enabled strategies in Strategy Library.');
        const buildErr = buildSelection.hasWarnings
          ? `No valid strategies. ${buildSelection.invalidIds.length ? `${buildSelection.invalidIds.length} invalid. ` : ''}${buildSelection.missingSignalIds.length ? `${buildSelection.missingSignalIds.length} missing signal. ` : ''}Enable strategies in Strategy Library.`
          : 'No strategies enabled. Enable at least one in Strategy Library.';
        bots = bots.map((x) =>
          x.id === botId ? { ...x, status: 'outdated' as const, lastError: buildErr } : x
        );
        scheduleClearBotError(botId);
        buildingBotId = null;
        schedulePersist();
        emit();
        return;
      }
      const botInstrumentLive = liveResults.filter(
        (r) => r.instrumentId === b.instrumentId && buildStrategyIds.includes(r.strategyId)
      );
      log('info', `Rows for this instrument + strategies: ${botInstrumentLive.length}`);
      if (botInstrumentLive.length === 0) {
        log('error', `Abort: no live rows for instrument ${b.instrumentSymbol} with selected strategies.`);
        bots = bots.map((x) =>
          x.id === botId
            ? { ...x, status: 'outdated' as const, lastError: `No live backtest results for ${b.instrumentSymbol} from selected strategies. Run backtest with this instrument selected, then build.` }
            : x
        );
        scheduleClearBotError(botId);
        buildingBotId = null;
        schedulePersist();
        emit();
        return;
      }

      const { train: trainResults, validation: validationResults } = splitBacktestResultsForOOS(botInstrumentLive);
      log(
        'info',
        `OOS split | train=${trainResults.length} | validation=${validationResults?.length ?? 0}`
      );
      if (trainResults.length === 0) {
        log('error', 'Abort: train slice empty after OOS split.');
        bots = bots.map((x) =>
          x.id === botId ? { ...x, status: 'outdated' as const, lastError: 'Out-of-sample split: no training results for this instrument.' } : x
        );
        scheduleClearBotError(botId);
        buildingBotId = null;
        schedulePersist();
        emit();
        return;
      }
      bumpProgress(15);
      if (trainResults.length < MIN_TRAINING_ROWS_FOR_BUILD) {
        log(
          'error',
          `Abort: need ≥${MIN_TRAINING_ROWS_FOR_BUILD} training rows (have ${trainResults.length}).`
        );
        bots = bots.map((x) =>
          x.id === botId
            ? { ...x, status: 'outdated' as const, lastError: `Need at least ${MIN_TRAINING_ROWS_FOR_BUILD} training rows for this instrument (have ${trainResults.length}). Run backtest with more strategies/timeframes.` }
            : x
        );
        scheduleClearBotError(botId);
        buildingBotId = null;
        schedulePersist();
        emit();
        return;
      }

      bumpProgress(18);
      const bestResults = getBestResultsForBuild(trainResults);
      const rowsToUse = bestResults.length > 0 ? bestResults : trainResults;
      log(
        'info',
        `getBestResultsForBuild | train=${trainResults.length} → rowsToUse=${rowsToUse.length} (best filter applied=${bestResults.length > 0})`
      );
      const runRequest = backtestState.runRequest;
      const dateFrom = runRequest?.dateFrom;
      const dateTo = runRequest?.dateTo;
      log('info', `Backtest date range for bar replay: ${dateFrom ?? '—'} → ${dateTo ?? '—'}`);

      // Fetch bars for detection training: unique (instrumentId, timeframe) from results
      let barsForBuild: Record<string, Array<{ open: number; high: number; low: number; close: number; time?: number }>> | undefined;
      if (dateFrom && dateTo && rowsToUse.length > 0) {
        const keys = [...new Set(rowsToUse.map((r) => `${r.instrumentId}|${r.timeframe}`))];
        log('info', `Bar fetch phase | unique keys=${keys.length} (instrumentId|timeframe) — progress ~20–50%`);
        const barsByKey: Record<string, Array<{ open: number; high: number; low: number; close: number; time?: number }>> = {};
        const nKeys = keys.length;
        // Bar fetch uses 20–50% only; 52%+ is reserved for /build (server PyTorch — can take minutes).
        for (let ki = 0; ki < keys.length; ki++) {
          const key = keys[ki];
          if (nKeys > 0) {
            bumpProgress(20 + Math.round((30 / nKeys) * (ki + 1)));
          }
          const [instrumentId, timeframe] = key.split('|');
          const inst = instruments.find((i) => i.id === instrumentId);
          const sym = inst?.symbol ?? instrumentId.replace(/^inst-/, '').toUpperCase().replace(/-/g, '/');
          const brokerId = inst?.brokerId ?? BROKER_DERIV_ID;
          const fetchT0 =
            typeof performance !== 'undefined' ? performance.now() : Date.now();
          log('progress', `fetchOHLCV start | key=${key} | symbol=${sym} | brokerId=${brokerId} | tf=${timeframe}`);
          try {
            const { bars } = await fetchOHLCV({
              instrumentId,
              symbol: sym,
              brokerId,
              timeframe,
              brokers,
              activity: 'backtest',
              count: 1000,
              dateFrom,
              dateTo,
              signal: buildAbortController.signal,
            });
            const fetchMs = Math.round(
              (typeof performance !== 'undefined' ? performance.now() : Date.now()) - fetchT0
            );
            if (bars.length >= 210) {
              barsByKey[key] = bars.map((bar) => ({ open: bar.open, high: bar.high, low: bar.low, close: bar.close, time: bar.time }));
              log(
                'success',
                `fetchOHLCV ok | key=${key} | bars=${bars.length} (${fetchMs}ms) — kept for detection (≥210 bars)`
              );
            } else {
              log(
                'warning',
                `fetchOHLCV short | key=${key} | bars=${bars.length} (${fetchMs}ms) — skipped (<210 bars for detection)`
              );
            }
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            log('warning', `fetchOHLCV failed | key=${key} | ${detail}`);
          }
        }
        if (Object.keys(barsByKey).length > 0) barsForBuild = barsByKey;
        const totalBars = Object.values(barsByKey).reduce((s, a) => s + a.length, 0);
        log(
          'info',
          `Bar fetch done | keysWithData=${Object.keys(barsByKey).length}/${keys.length} | totalBarRows=${totalBars}`
        );
      } else {
        log('warning', 'Bar fetch skipped (no dateFrom/dateTo or no rows) — POST /build will use tabular train() only.');
        bumpProgress(50);
      }

      bumpProgress(52);
      let trainServerPulse: ReturnType<typeof setInterval> | null = null;
      if (typeof window !== 'undefined') {
        trainServerPulse = window.setInterval(() => {
          if (buildingBotId !== botId) return;
          const cur = bots.find((x) => x.id === botId);
          if (!cur || cur.status !== 'building') return;
          const p = cur.buildProgress ?? 0;
          if (p >= 52 && p < 96) bumpProgress(Math.min(96, p + 2));
        }, 4500);
      }
      const barKeys = barsForBuild ? Object.keys(barsForBuild) : [];
      const totalBarsPayload = barsForBuild
        ? Object.values(barsForBuild).reduce((s, a) => s + a.length, 0)
        : 0;
      log(
        'info',
        `POST /build | trainRows=${rowsToUse.length} | valRows=${validationResults?.length ?? 0} | epochs=50 | barsKeys=${barKeys.length} | barRows=${totalBarsPayload}`
      );
      log(
        'info',
        barKeys.length > 0
          ? 'Mode: detection — server runs train_detection (PyTorch on bars); usually the slowest step.'
          : 'Mode: tabular — server runs train() on backtest JSON only (no bar tensors).'
      );
      log(
        'warning',
        'POST /build in flight — single HTTP request until PyTorch finishes. UI pulse 52–96% is estimated; watch elapsed time below.'
      );
      const postT0 =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
      try {
        const res = await postBuild(rowsToUse, instrumentTypes, {
          epochs: 50,
          signal: buildAbortController.signal,
          validationResults: validationResults?.length ? validationResults : undefined,
          bars: barsForBuild,
        });
        const postMs = Math.round(
          (typeof performance !== 'undefined' ? performance.now() : Date.now()) - postT0
        );
        log(
          res.success ? 'success' : 'error',
          `POST /build finished in ${postMs}ms | success=${res.success} | message=${(res.message || '').slice(0, 280)}`
        );
        if (res.success) {
          log(
            'info',
            `Response extras | oos_accuracy=${res.oos_accuracy ?? 'n/a'} | oos_sample_count=${res.oos_sample_count ?? 'n/a'} | detection_tf=${res.detection_timeframe ?? 'n/a'} | detection_bar_window=${res.detection_bar_window ?? 'n/a'}`
          );
        }
        if (buildingBotId !== botId) return;
        if (res.success) {
          const next = bots.find((x) => x.id === botId);
          if (next) {
            const featureVector = res.feature_vector;
            const hasValidVector = Array.isArray(featureVector) && featureVector.length >= 32 && featureVector.length <= 512;
            if (!hasValidVector) {
              log(
                'error',
                `Build reported success but feature_vector invalid (need length 32–512, got ${Array.isArray(featureVector) ? featureVector.length : 0}).`
              );
              bots = bots.map((x) =>
                x.id === botId
                  ? { ...x, status: 'outdated' as const, lastError: 'Build succeeded but no valid feature vector. Rebuild the bot.' }
                  : x
              );
              scheduleClearBotError(botId);
              schedulePersist();
              emit();
            } else {
              const usedStrategyIds = [...new Set(rowsToUse.map((r) => r.strategyId))];
              log(
                'success',
                `Build complete | feature_vector dim=${featureVector.length} | strategyIds=${usedStrategyIds.join(', ')}`
              );
              const updated = {
                ...setBotStatus(setBotBuildProgress(next, 100), 'ready'),
                lastError: undefined,
                driftDetectedAt: undefined,
                forceRebuildReason: undefined,
                strategyIds: usedStrategyIds.length > 0 ? usedStrategyIds : next.strategyIds,
                nnFeatureVector: featureVector,
                oosAccuracy: res.oos_accuracy ?? undefined,
                oosSampleCount: res.oos_sample_count ?? undefined,
                nnDetectionTimeframe: res.detection_timeframe ?? undefined,
                nnDetectionBarWindow: res.detection_bar_window ?? undefined,
                nnDetectionModels: res.detection_models
                  ? Object.fromEntries(Object.entries(res.detection_models).map(([tf, meta]) => [
                      tf,
                      {
                        timeframe: meta.timeframe,
                        scope: meta.scope,
                        barWindow: meta.bar_window,
                        checkpointPath: meta.checkpoint_path,
                        valAccuracy: meta.val_accuracy,
                        sampleCount: meta.num_samples,
                        strategyId: meta.strategy_id,
                      },
                    ]))
                  : undefined,
              };
              bots = bots.map((x) => (x.id === botId ? updated : x));
              resetBacktestResults();
              persistNow();
              emit();
            }
          }
          return;
        }
        log('error', `Build failed (API): ${res.message}`);
        bots = bots.map((x) => (x.id === botId ? { ...x, status: 'outdated' as const, lastError: res.message } : x));
        scheduleClearBotError(botId);
      } catch (e) {
        const postMs = Math.round(
          (typeof performance !== 'undefined' ? performance.now() : Date.now()) - postT0
        );
        if ((e as Error)?.name === 'AbortError' && buildingBotId === botId) {
          log('warning', `POST /build aborted after ~${postMs}ms (user cancel or client timeout).`);
          bots = bots.map((x) => (x.id === botId ? { ...x, status: 'outdated' as const, buildProgress: 0, lastError: 'Build cancelled' } : x));
          scheduleClearBotError(botId);
        } else if (buildingBotId === botId) {
          const msg = (e as Error)?.message ?? 'Build failed';
          log('error', `POST /build exception after ~${postMs}ms: ${msg}`);
          bots = bots.map((x) => (x.id === botId ? { ...x, status: 'outdated' as const, lastError: msg } : x));
          scheduleClearBotError(botId);
        }
      } finally {
        if (trainServerPulse != null) {
          clearInterval(trainServerPulse);
          trainServerPulse = null;
        }
        if (buildingBotId === botId) buildingBotId = null;
      }
      schedulePersist();
      emit();
    },
    cancelBuildBot(botId) {
      if (buildingBotId === botId) buildAbortController?.abort();
    },
    deployBot(botId) {
      const b = bots.find((x) => x.id === botId);
      if (!b || b.status !== 'ready') return;
      const deployed = {
        ...setBotStatus(b, 'deployed'),
        deployedAt: new Date().toISOString(),
        // Preserve drift status across deploy — only clear on successful rebuild
      };
      bots = bots.map((x) => (x.id === botId ? deployed : x));
      schedulePersist();
      emit();
    },
    undeployBot(botId) {
      const b = bots.find((x) => x.id === botId);
      if (!b || b.status !== 'deployed') return;
      bots = bots.map((x) =>
        x.id === botId ? { ...setBotStatus(x, 'ready'), deployedAt: undefined } : x
      );
      schedulePersist();
      emit();
    },
    deployAllReadyBots() {
      const ready = bots.filter((b) => b.status === 'ready');
      if (ready.length === 0) return;
      const now = new Date().toISOString();
      bots = bots.map((x) => {
        if (x.status !== 'ready') return x;
        return {
          ...setBotStatus(x, 'deployed'),
          deployedAt: now,
          // Preserve drift status across deploy — only clear on successful rebuild
        };
      });
      schedulePersist();
      emit();
    },
    undeployAllBots() {
      const deployed = bots.filter((b) => b.status === 'deployed');
      if (deployed.length === 0) return;
      bots = bots.map((x) =>
        x.status === 'deployed' ? { ...setBotStatus(x, 'ready'), deployedAt: undefined } : x
      );
      schedulePersist();
      emit();
    },
    setDriftDetected(botId, reason) {
      const b = bots.find((x) => x.id === botId);
      if (b) {
        bots = bots.map((x) => (x.id === botId ? setDriftDetected(x, reason) : x));
        persistNow();
        emit();
      }
    },
    clearDriftDetected(botId) {
      const b = bots.find((x) => x.id === botId);
      if (b) {
        bots = bots.map((x) => (x.id === botId ? clearDriftDetected(x) : x));
        schedulePersist();
        emit();
      }
    },
    clearBotError(botId) {
      const b = bots.find((x) => x.id === botId);
      if (b?.lastError) {
        bots = bots.map((x) => (x.id === botId ? { ...x, lastError: undefined } : x));
        schedulePersist();
        emit();
      }
    },
    clearAllBotErrors() {
      if (bots.some((b) => b.lastError)) {
        bots = bots.map((x) => (x.lastError ? { ...x, lastError: undefined } : x));
        schedulePersist();
        emit();
      }
    },
    rebuildBot(botId) {
      const b = bots.find((x) => x.id === botId);
      if (!b) return;
      const isActuallyBuilt = b.status === 'ready' || b.status === 'deployed' || (b.status === 'outdated' && (b.nnFeatureVector?.length ?? 0) > 0);
      if (!isActuallyBuilt) return;
      const inst = instruments.find((i) => i.id === b.instrumentId);
      if (inst) {
        const scheduled = scheduleNextRebuild(b, inst);
        // Preserve drift until build succeeds — so REBUILD NOW stays active if build fails
        const next = {
          ...setBotStatus(scheduled, 'building', 0),
          driftDetectedAt: b.driftDetectedAt ?? scheduled.driftDetectedAt,
          forceRebuildReason: b.forceRebuildReason ?? scheduled.forceRebuildReason,
        };
        bots = bots.map((x) => (x.id === botId ? next : x));
        schedulePersist();
        emit();
      }
    },
    deleteBot(botId) {
      if (buildingBotId === botId) buildAbortController?.abort();
      const removed = bots.find((b) => b.id === botId);
      bots = bots.filter((b) => b.id !== botId);
      delete closedTradesByBot[botId];
      const normSym = (s: string) => s.replace(/\s+/g, '').replace(/\//g, '').toUpperCase();
      const instSym = removed
        ? instruments.find((i) => i.id === removed.instrumentId)?.symbol
        : undefined;
      const otherBotSameInstrument = instSym
        ? bots.some((b) => {
            const s = instruments.find((i) => i.id === b.instrumentId)?.symbol;
            return s && normSym(s) === normSym(instSym);
          })
        : false;
      botExecutionLog = botExecutionLog.filter((e) => {
        if (e.botId === botId) return false;
        if (e.botId) return true;
        if (otherBotSameInstrument || !instSym) return true;
        return normSym(e.symbol ?? '') !== normSym(instSym);
      });
      schedulePersist();
      emit();
    },
    deleteAllBots() {
      if (buildingBotId) buildAbortController?.abort();
      bots = [];
      closedTradesByBot = {};
      botExecutionLog = [];
      persistNow();
      emit();
    },
    /** Update portfolio position prices from live broker feed (MT5 or Deriv). No simulated ticks. */
    tickPortfolioPrices() {
      const state = getPortfolioState();
      if (state.positions.length === 0) return;

      const resolveSymbol = (p: Position): string => {
        const inst = instruments.find((i) => i.id === p.instrumentId);
        const raw = inst?.symbol ?? p.instrument ?? '';
        return raw.replace(/\s/g, '').replace('/', '').trim().toUpperCase();
      };

      if (state.dataSource === 'mt5') {
        const symbols = [...new Set(state.positions.map(resolveSymbol).filter(Boolean))];
        if (symbols.length === 0) {
          schedulePersist();
          emit();
          return;
        }
        getMt5Prices(symbols).then((res) => {
          if ('error' in res) return;
          const prices = res.prices;
          updatePositionPrices((p) => {
            const sym = resolveSymbol(p);
            const quote = prices[sym];
            const currentPrice =
              quote != null ? (p.type === 'LONG' ? quote.bid : quote.ask) : p.currentPrice;
            const { pnl, pnlPercent } = positionPnl(p.type, p.size, p.entryPrice, currentPrice);
            return { currentPrice, pnl, pnlPercent };
          });
          schedulePersist();
          emit();
        });
        return;
      }

      if (state.dataSource === 'deriv') {
        getDerivPortfolioPrices()
          .then((prices) => {
            const tryPrice = (p: Position) => {
              const sym = resolveSymbol(p);
              const quote = prices[sym] ?? prices[sym.toUpperCase()];
              if (quote != null) {
                const currentPrice = p.type === 'LONG' ? quote.bid : quote.ask;
                const pnl = quote.profit != null && Number.isFinite(quote.profit)
                  ? quote.profit
                  : positionPnl(p.type, p.size, p.entryPrice, currentPrice).pnl;
                const pnlPercent = p.entryPrice && p.size && p.entryPrice * p.size > 0
                  ? (pnl / (p.entryPrice * p.size)) * 100
                  : 0;
                return { currentPrice, pnl, pnlPercent };
              }
              for (const key of ourSymbolToDerivKeys(sym)) {
                const q = prices[key] ?? prices[key.toUpperCase()];
                if (q != null) {
                  const currentPrice = p.type === 'LONG' ? q.bid : q.ask;
                  const pnl = q.profit != null && Number.isFinite(q.profit)
                    ? q.profit
                    : positionPnl(p.type, p.size, p.entryPrice, currentPrice).pnl;
                  const pnlPercent = p.entryPrice && p.size && p.entryPrice * p.size > 0
                    ? (pnl / (p.entryPrice * p.size)) * 100
                    : 0;
                  return { currentPrice, pnl, pnlPercent };
                }
              }
              return { currentPrice: p.currentPrice, pnl: p.pnl, pnlPercent: p.pnlPercent };
            };
            updatePositionPrices(tryPrice);
            schedulePersist();
            emit();
          })
          .catch((e) => {
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('[TradingStore] removePosition/updatePosition failed:', e);
            }
            schedulePersist();
            emit();
          });
        return;
      }

      schedulePersist();
      emit();
    },
    async syncInstrumentSpreads() {
      const mt5Broker = brokers.find((b) => b.type === 'mt5' && b.status === 'connected');
      const derivBroker = brokers.find((b) => b.id === BROKER_DERIV_ID && b.status === 'connected');
      if (!mt5Broker && !derivBroker) return;

      if (mt5Broker) {
        const mt5Instruments = instruments.filter(
          (i) => i.brokerId === BROKER_EXNESS_ID || i.brokerId === BROKER_EXNESS_API_ID
        );
        const symbols = mt5Instruments.map((i) => (i.symbol ?? '').replace(/\s/g, '').replace('/', '').trim().toUpperCase()).filter(Boolean);
        if (symbols.length > 0) {
          const res = await getMt5SymbolSpreads(symbols);
          if ('spreads' in res && Object.keys(res.spreads).length > 0) {
            const spreadBySymbol = res.spreads;
            instruments = instruments.map((i) => {
              const sym = (i.symbol ?? '').replace(/\s/g, '').replace('/', '').trim().toUpperCase();
              const live = spreadBySymbol[sym];
              if (live != null && live > 0 && (i.brokerId === BROKER_EXNESS_ID || i.brokerId === BROKER_EXNESS_API_ID)) {
                return { ...i, spread: live };
              }
              return i;
            });
            schedulePersist();
            emit();
          }
        }
      }

      if (derivBroker) {
        try {
          const spreads = await getDerivSymbolSpreads();
          const usedDerivInstrumentIds = new Set<string>();
          for (const i of instruments) {
            if (i.brokerId === BROKER_DERIV_ID && i.selected) usedDerivInstrumentIds.add(i.id);
          }
          for (const b of bots) {
            if (b.status === 'deployed') usedDerivInstrumentIds.add(b.instrumentId);
          }
          for (const p of getPortfolioState().positions) {
            usedDerivInstrumentIds.add(p.instrumentId);
          }
          const derivInstruments = instruments.filter((i) =>
            i.brokerId === BROKER_DERIV_ID &&
            i.status === 'active' &&
            usedDerivInstrumentIds.has(i.id)
          );
          instruments = instruments.map((i) => {
            if (i.brokerId !== BROKER_DERIV_ID) return i;
            const sym = (i.symbol ?? '').replace(/\s/g, '_').trim();
            const variants = [sym, sym.toUpperCase(), sym.replace(/_/g, '')];
            for (const v of variants) {
              const live = spreads[v] ?? spreads[v.toUpperCase()];
              if (live != null && live > 0) return { ...i, spread: live };
            }
            return i;
          });
          const stillMissing = derivInstruments.filter((i) => {
            const sym = (i.symbol ?? '').replace(/\s/g, '_').trim();
            const variants = [sym, sym.toUpperCase(), sym.replace(/_/g, '')];
            return !variants.some((v) => (spreads[v] ?? spreads[v.toUpperCase()]) != null);
          });
          for (const i of stillMissing) {
            const sym = (i.symbol ?? '').replace(/\s/g, '_').replace(/\//g, '').trim();
            if (!sym) continue;
            try {
              const live = await getDerivSymbolSpreadFromTick(sym);
              if (live != null && live > 0) {
                instruments = instruments.map((inst) =>
                  inst.id === i.id ? { ...inst, spread: live } : inst
                );
              }
            } catch {
              /* skip */
            }
            await new Promise((r) => setTimeout(r, 150));
          }
          if (derivInstruments.length > 0) {
            schedulePersist();
            emit();
          }
        } catch (e) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[TradingStore] getDerivSymbolSpreads failed:', e);
          }
        }
      }
    },
    async tickBotExecution() {
      const pendingBatch: BotExecutionEvent[] = [];
      await runBotExecution({
        bots,
        instruments,
        brokers,
        executionEnabled: execution.enabled,
        closedTradesByBot,
        onEmit: () => {
          persistNow();
          emit();
        },
        onEvent: (e) => {
          const full = pushBotExecutionEvent(e);
          pendingBatch.push(full);
          emit();
        },
        onClosePosition: ({ position, exitPrice, pnl, nnSlPct, nnTpR, nnSizeMult }) => {
          recordClosedTrade(position, exitPrice, pnl, { profit: pnl, nnSlPct, nnTpR, nnSizeMult });
          removePosition(position.id);
          persistNow();
          emit();
        },
      });
      if (pendingBatch.length > 0 && getRemoteServerUrl()) {
        postExecutionLogAppend(pendingBatch as unknown as import('../core/api').ExecutionLogEventPayload[]).catch(() => {});
      }
    },
    async tickPositionEvaluation() {
      const pendingBatch: BotExecutionEvent[] = [];
      await runPositionEvaluation({
        bots,
        instruments,
        brokers,
        executionEnabled: execution.enabled,
        closedTradesByBot,
        onEmit: () => {
          persistNow();
          emit();
        },
        onEvent: (e) => {
          const full = pushBotExecutionEvent(e);
          pendingBatch.push(full);
          emit();
        },
        onClosePosition: ({ position, exitPrice, pnl, nnSlPct, nnTpR, nnSizeMult }) => {
          recordClosedTrade(position, exitPrice, pnl, { profit: pnl, nnSlPct, nnTpR, nnSizeMult });
          removePosition(position.id);
          persistNow();
          emit();
        },
      });
      if (pendingBatch.length > 0 && getRemoteServerUrl()) {
        postExecutionLogAppend(pendingBatch as unknown as import('../core/api').ExecutionLogEventPayload[]).catch(() => {});
      }
    },
    clearBotExecutionLog() {
      botExecutionLog = [];
      emit();
    },
    clearBotBuildLog() {
      botBuildLog = [];
      emit();
    },
    async loadExecutionLogFromBackend(opts?: { merge?: boolean }) {
      const remote = getRemoteServerUrl();
      if (!remote) return;
      const events = await getExecutionLog({ limit: 500 });
      if (events.length === 0) return;
      const asBotEvents: BotExecutionEvent[] = events.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        botId: e.botId,
        symbol: e.symbol,
        phase: e.phase as BotExecutionEvent['phase'],
        outcome: e.outcome as BotExecutionEvent['outcome'],
        message: e.message,
        details: e.details as BotExecutionEvent['details'],
      }));
      if (opts?.merge) {
        const existingIds = new Set(botExecutionLog.map((x) => x.id));
        const newOnes = asBotEvents.filter((x) => !existingIds.has(x.id));
        botExecutionLog = [...newOnes, ...botExecutionLog].slice(0, BOT_EXECUTION_LOG_MAX);
      } else {
        botExecutionLog = asBotEvents.slice(0, BOT_EXECUTION_LOG_MAX);
      }
      emit();
    },
    async loadPersisted() {
      registerBeforeUnload();
      try {
        await loadRemoteServerUrlFromBackend();
        const loaded = (await loadStateFromBackend()) ?? ({} as Partial<PersistedState>);
        const stateLoaded = Object.keys(loaded).length > 0;
        if (!stateLoaded && typeof console !== 'undefined' && console.warn) {
          console.warn('[TradingStore] No backend state snapshot loaded; restoring from defaults + backend bots/positions.');
        }
        // Map legacy Deriv display names to API underlying_symbol (see registries.ts)
        // Always use the full instrument registry from code. Never restore instruments from persisted state.
        const defaultIds = new Set(DEFAULT_INSTRUMENTS.map((d) => d.id));
        const selectedId =
          loaded?.instruments?.find((i) => i.selected)?.id ?? loaded?.instruments?.[0]?.id;
        const keepSelected = selectedId && defaultIds.has(selectedId);
        const loadedById = new Map((loaded?.instruments ?? []).map((i) => [i.id, i]));
        instruments = DEFAULT_INSTRUMENTS.map((d, idx) => {
          const loadedInst = loadedById.get(d.id);
          const spread = loadedInst?.spread != null && loadedInst.spread > 0 ? loadedInst.spread : undefined;
          return {
            ...d,
            brokerId: d.brokerId, // Always use registry — never trust persisted brokerId (eXness vs Deriv must stay separate)
            spread,
            rebuildIntervalHours: loadedInst?.rebuildIntervalHours ?? d.rebuildIntervalHours,
            selected: keepSelected ? d.id === selectedId : idx === 0,
            status: loadedInst?.status === 'inactive' ? 'inactive' : 'active',
          };
        });
        if (loaded.brokers?.length) {
          const byId = new Map(loaded.brokers.map((b) => [b.id, b]));
          brokers = DEFAULT_BROKERS.map((d) => {
            const p = byId.get(d.id);
            return p ? { ...d, ...p, config: p.config && Object.keys(p.config).length ? p.config : d.config } : d;
          });
          loaded.brokers.filter((b) => !DEFAULT_BROKERS.some((d) => d.id === b.id)).forEach((b) => brokers.push(b));
          brokers.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
          // Reset 'connecting' to 'disconnected' — WebSocket is lost on reload; prevents stuck CONNECTING state
          brokers = brokers.map((b) => (b.status === 'connecting' ? { ...b, status: 'disconnected' as const } : b));
        }
        if (loaded.strategies?.length) {
          strategies = mergeStrategiesWithPersisted(getAllStrategies(), loaded.strategies);
          if (!strategies.some((s) => s.enabled)) {
            // Enable ind-rsi-oversold + ind-bb-squeeze (volatile regime) so backtest produces non-zero results
            strategies = strategies.map((s) =>
              s.id === 'ind-rsi-oversold' || s.id === 'ind-bb-squeeze' ? { ...s, enabled: true } : s
            );
          }
        } else {
          // First load: ensure ind-rsi-oversold + ind-bb-squeeze enabled (work in unknown/volatile → non-zero results)
          strategies = getAllStrategies().map((s) =>
            s.id === 'ind-rsi-oversold' || s.id === 'ind-bb-squeeze' ? { ...s, enabled: true } : s
          );
        }
        const selectedStrategyIds = getSelectedStrategyIds(strategies).strategyIds;
        const migrateBot = (b: BotConfig): BotConfig => {
          let migrated = b.status === 'building' ? { ...b, status: 'outdated' as const, buildProgress: 0 } : b;
          const fallbackInstrumentId = DEFAULT_INSTRUMENTS[0]?.id ?? 'inst-eurusd';
          if (!defaultIds.has(migrated.instrumentId)) {
            const inst = DEFAULT_INSTRUMENTS[0];
            migrated = { ...migrated, instrumentId: inst?.id ?? fallbackInstrumentId, instrumentSymbol: inst?.symbol ?? migrated.instrumentSymbol };
          }
          // Ensure strategyIds and fixedStyles are arrays (fix Set.map from corrupted/legacy data)
          const strategyIds = (Array.isArray(migrated.strategyIds) ? migrated.strategyIds : Array.from(migrated.strategyIds ?? [])) as string[];
          const fixedStyles = (Array.isArray(migrated.fixedStyles) ? migrated.fixedStyles : (migrated.fixedStyles != null ? Array.from(migrated.fixedStyles as Iterable<string>) : undefined)) as TradeStyle[] | undefined;
          // When scopeMode is auto, clear manual state so scope selection is truly dynamic
          const scopeMode = migrated.scopeMode ?? 'auto';
          const clearManual = scopeMode === 'auto';
          const out = {
            ...migrated,
            strategyIds: [...selectedStrategyIds],
            ...(fixedStyles !== undefined ? { fixedStyles } : {}),
          };
          if (clearManual) {
            return { ...out, scopeMode: 'auto' as const, fixedScope: undefined, fixedStyle: undefined, fixedStyles: undefined } as BotConfig;
          }
          return out as BotConfig;
        };
        if (loaded.bots?.length) {
          bots = loaded.bots.map((b) => migrateBot(b as BotConfig));
        }
        if (loaded.execution) execution = loaded.execution;
        if (loaded.closedTradesByBot && typeof loaded.closedTradesByBot === 'object') {
          const raw = loaded.closedTradesByBot as Record<string, ClosedTrade[]>;
          const sanitized = sanitizeClosedTrades(raw);
          const rawCount = Object.values(raw).flat().length;
          const keptCount = Object.values(sanitized).flat().length;
          closedTradesByBot = sanitized;
          if (keptCount < rawCount) schedulePersist();
        }
        if (Array.isArray(loaded.botBuildLog) && loaded.botBuildLog.length > 0) {
          botBuildLog = loaded.botBuildLog
            .filter((e) => e && typeof e.message === 'string')
            .map((e) => ({
              level: (['info', 'progress', 'success', 'warning', 'error'].includes(e.level)
                ? e.level
                : 'info') as ResearchLogLevel,
              message: e.message,
              timestamp: typeof e.timestamp === 'string' ? e.timestamp : new Date().toISOString(),
            }))
            .slice(-MAX_BOT_BUILD_LOG);
        }
        if (Array.isArray(loaded.botExecutionLog) && loaded.botExecutionLog.length > 0) {
          botExecutionLog = loaded.botExecutionLog
            .filter((e): e is typeof e & { id: string; timestamp: string; botId: string; symbol: string; phase: string; outcome: string; message: string } =>
              typeof e?.id === 'string' && typeof e?.botId === 'string')
            .map((e) => ({
              id: e.id,
              timestamp: e.timestamp,
              botId: e.botId,
              symbol: e.symbol,
              phase: e.phase as BotExecutionEvent['phase'],
              outcome: e.outcome as BotExecutionEvent['outcome'],
              message: e.message,
              details: e.details as BotExecutionEvent['details'],
            }))
            .slice(0, BOT_EXECUTION_LOG_MAX);
        }
        if (loaded.portfolio && (loaded.portfolio.dataSource === 'mt5' || loaded.portfolio.dataSource === 'deriv')) {
          let persistedPositions = Array.isArray(loaded.portfolio.positions)
            ? loaded.portfolio.positions
                .filter((p): p is typeof p & { id: string } => typeof p?.id === 'string')
                .map((p) => {
                  const instId = String(p.instrumentId ?? '');
                  const { scope, style } = p.scope && p.style
                    ? { scope: p.scope as TradeScope, style: p.style as TradeStyle }
                    : getScopeStyleFromBotForInstrument(instId, bots, instruments);
                  return {
                  ...p,
                  id: p.id,
                  instrumentId: instId,
                  instrument: String(p.instrument ?? ''),
                  type: (p.type === 'LONG' || p.type === 'SHORT' ? p.type : 'LONG') as Position['type'],
                  size: Number(p.size) || 0,
                  entryPrice: Number(p.entryPrice) || 0,
                  currentPrice: Number(p.currentPrice) || Number(p.entryPrice) || 0,
                  pnl: Number(p.pnl) || 0,
                  pnlPercent: Number(p.pnlPercent) || 0,
                  scope,
                  style,
                  botId: String(p.botId ?? ''),
                  openedAt: String(p.openedAt ?? new Date().toISOString()),
                  riskAmount: Number(p.riskAmount) || 0,
                  balanceAtEntry: p.balanceAtEntry != null ? Number(p.balanceAtEntry) : undefined,
                  nnSlPct: p.nnSlPct != null ? Number(p.nnSlPct) : undefined,
                  nnTpR: p.nnTpR != null ? Number(p.nnTpR) : undefined,
                  nnSizeMult: p.nnSizeMult != null ? Number(p.nnSizeMult) : undefined,
                };
                })
            : [];
          hydratePortfolio(
            Number(loaded.portfolio.balance ?? 0),
            Number(loaded.portfolio.peakEquity ?? loaded.portfolio.balance ?? 0),
            persistedPositions,
            loaded.portfolio.dataSource as 'mt5' | 'deriv'
          );
          /** Backend fallback: if local positions empty, try backend for full restore (async) */
          if (persistedPositions.length === 0) {
            getPositions()
              .then((remote) => {
                if (remote.balance != null && Number.isFinite(remote.balance)) {
                  setBalance(remote.balance, (loaded.portfolio?.dataSource as 'mt5' | 'deriv') ?? 'mt5');
                }
                if (remote.peakEquity != null && Number.isFinite(remote.peakEquity)) {
                  setPeakEquity(remote.peakEquity);
                }
                if (remote.positions?.length) {
                  const restored = remote.positions
                    .filter((p): p is Record<string, unknown> & { id: string } => typeof (p as Record<string, unknown>)?.id === 'string')
                    .map((p) => {
                      const instId = String(p.instrumentId ?? '');
                      const { scope, style } = p.scope && p.style
                        ? { scope: p.scope as TradeScope, style: p.style as TradeStyle }
                        : getScopeStyleFromBotForInstrument(instId, bots, instruments);
                      return {
                      id: String(p.id),
                      instrumentId: instId,
                      instrument: String(p.instrument ?? ''),
                      type: ((p.type === 'LONG' || p.type === 'SHORT') ? p.type : 'LONG') as Position['type'],
                      size: Number(p.size) || 0,
                      entryPrice: Number(p.entryPrice) || 0,
                      currentPrice: Number(p.currentPrice) ?? Number(p.entryPrice) ?? 0,
                      pnl: Number(p.pnl) || 0,
                      pnlPercent: Number(p.pnlPercent) || 0,
                      scope,
                      style,
                      botId: String(p.botId ?? ''),
                      openedAt: String(p.openedAt ?? new Date().toISOString()),
                      stopLoss: p.stopLoss != null ? Number(p.stopLoss) : undefined,
                      takeProfit: p.takeProfit != null ? Number(p.takeProfit) : undefined,
                      riskAmount: Number(p.riskAmount) || 0,
                      balanceAtEntry: p.balanceAtEntry != null ? Number(p.balanceAtEntry) : undefined,
                    };
                    });
                  setPositions(restored);
                }
                if (remote.closedTradesByBot && Object.keys(remote.closedTradesByBot).length > 0) {
                  closedTradesByBot = sanitizeClosedTrades(remote.closedTradesByBot as unknown as Record<string, ClosedTrade[]>);
                }
                if (remote.positions?.length || (remote.closedTradesByBot && Object.keys(remote.closedTradesByBot).length > 0)) {
                  schedulePersist();
                  emit();
                }
              })
              .catch(() => {});
          }
        }
        if (!instruments.some((i) => i.selected) && instruments.length > 0) {
          const first = instruments.find((i) => i.status === 'active') ?? instruments[0];
          instruments = instruments.map((i) => ({ ...i, selected: i.id === first.id }));
        }
        // Brokers we'll attempt to reconnect (have credentials)
        const toReconnect = brokers.filter(
          (b) =>
            b.status === 'connected' &&
            ((b.type === 'mt5' && b.config.login && b.config.password) ||
              (b.type === 'deriv_api' && b.config.appId && b.config.password) ||
              (b.type === 'exness_api' && b.config.apiKey))
        );
        if (loaded.backtest) {
          const results = Array.isArray(loaded.backtest.results) ? loaded.backtest.results : [];
          const validResults = results.filter((r) => defaultIds.has(r.instrumentId));
          const runRequest = loaded.backtest.runRequest ?? null;
          const wasRunning = loaded.backtest.status === 'running';
          const restoredStatus = wasRunning ? 'cancelled' : loaded.backtest.status;
          hydrateBacktestState({
            results: validResults,
            runRequest,
            status: restoredStatus,
            progress: loaded.backtest.progress,
            selectedTimeframes: loaded.backtest.selectedTimeframes as import('../core/types').Timeframe[] | undefined,
            autoCompareLog: Array.isArray(loaded.backtest.autoCompareLog) ? loaded.backtest.autoCompareLog : [],
            lastAutoCompareResult: loaded.backtest.lastAutoCompareResult ?? null,
          });
          // Avoid automatic resume on reload; repeated restarts can freeze/unresponsive tab on heavy runs.
          if (wasRunning && runRequest) {
            setBacktestCancelled(validResults, runRequest, 'Reloaded — resume manually to continue');
          }
        }
        if (loaded.research?.paramTunes?.length || loaded.research?.regimeTunes?.length || loaded.research?.baselineResults?.length) {
          const log = Array.isArray(loaded.research.log) ? loaded.research.log.map((e) => ({ level: e.level ?? 'info', message: e.message ?? '' })) : [];
          research = {
            status: 'completed',
            regimeTunes: loaded.research.regimeTunes ?? [],
            paramTunes: loaded.research.paramTunes ?? [],
            baselineResults: loaded.research.baselineResults ?? [],
            log,
          };
        }
        emit();
        // Fetch bots from backend so they persist across reconnect/refresh/devices.
        // Preserve driftDetectedAt/forceRebuildReason from local bots (client-only; backend may not store them).
        const localBotsById = new Map(bots.map((b) => [b.id, b]));
        getBots()
          .then((backendBots) => {
            if (backendBots.length > 0) {
              const fallbackInstrumentId = DEFAULT_INSTRUMENTS[0]?.id ?? 'inst-eurusd';
              bots = (backendBots as unknown as BotConfig[]).map((b) => {
                const migrated = migrateBot(b as BotConfig);
                const local = localBotsById.get(migrated.id);
                if (local?.driftDetectedAt != null || local?.forceRebuildReason != null) {
                  return {
                    ...migrated,
                    driftDetectedAt: local.driftDetectedAt ?? migrated.driftDetectedAt,
                    forceRebuildReason: local.forceRebuildReason ?? migrated.forceRebuildReason,
                  };
                }
                return {
                  ...migrated,
                  strategyIds: [...selectedStrategyIds],
                };
              });
              emit();
              persist();
            }
          })
          .catch(() => {});
        // Re-establish live connections after reload (Deriv WS and MT5 session are not persisted)
        if (toReconnect.length > 0) {
          setTimeout(() => {
            toReconnect.forEach((br) => getActions().connectBroker(br.id));
          }, 0);
        }
        persist(); // persist full state (instruments, brokers with credentials, etc.) so reload keeps everything
        emit();
        if (getRemoteServerUrl()) {
          getActions().loadExecutionLogFromBackend({ merge: true }).catch(() => {});
        }
      } catch (err) {
        console.error('loadPersisted failed:', err);
      }
    },
    addBroker(broker) {
      if (brokers.some((b) => b.id === broker.id)) return;
      brokers = [...brokers, { ...broker, order: brokers.length }];
      schedulePersist();
      emit();
    },
    updateBroker(id, patch) {
      brokers = brokers.map((b) => (b.id === id ? { ...b, ...patch } : b));
      schedulePersist();
      emit();
    },
    removeBroker(id) {
      if (DEFAULT_BROKERS.some((d) => d.id === id)) return;
      brokers = brokers.filter((b) => b.id !== id);
      schedulePersist();
      emit();
    },
    async connectBroker(id, credentials) {
      const b = brokers.find((x) => x.id === id);
      if (!b) return;
      if (b.status === 'connecting') return;
      const config = credentials ?? b.config;
      brokers = brokers.map((x) => (x.id === id ? { ...x, status: 'connecting' as const, lastError: undefined } : x));
      emit();
      const CONN_TIMEOUT_MS = 20_000;
      const withTimeout = <T,>(p: Promise<T>): Promise<T> =>
        Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Connection timeout')), CONN_TIMEOUT_MS))]);
      try {
        if (b.type === 'exness_api') {
          const apiKey = (config.apiKey ?? b.config.apiKey ?? '').toString().trim();
          const baseUrl = (config.baseUrl ?? b.config.baseUrl ?? '').trim() || undefined;
          if (!apiKey) {
            brokers = brokers.map((x) =>
              x.id === id ? { ...x, status: 'error', lastError: 'eXness API requires an API key from Personal Area → API.' as const, config: { ...x.config, ...config } } : x
            );
          } else {
            const account = await withTimeout(getExnessAccount(apiKey, baseUrl));
            setBalance(account.balance, 'mt5');
            setServerEquity(account.equity ?? null);
            setTimeout(() => getActions().syncBrokerPositions().catch((e) => {
              if (typeof console !== 'undefined' && console.warn) {
                console.warn('[TradingStore] syncBrokerPositions failed:', e);
              }
            }), 100);
            brokers = brokers.map((x) =>
              x.id === id
                ? {
                    ...x,
                    status: 'connected',
                    lastError: undefined,
                    connectedAt: new Date().toISOString(),
                    config: { ...x.config, apiKey, baseUrl: baseUrl || undefined },
                  }
                : x
            );
            persistNow(); // Persist immediately so broker connectivity survives reload
          }
        } else if (b.type === 'mt5') {
          const login = (config.login ?? b.config.login ?? '').toString().trim();
          const password = config.password ?? b.config.password ?? '';
          const server = (config.server ?? b.config.server ?? '').toString().trim();
          const res = await withTimeout(postMt5Connect(login, password, server));
          if (res.connected) {
            // Balance/equity from MT5 backend response only (no mock data)
            const bal = res.account?.balance;
            const numBal = bal != null && Number.isFinite(Number(bal)) ? Number(bal) : 0;
            setBalance(numBal, 'mt5');
            const eq = res.account?.equity;
            setServerEquity(eq != null && Number.isFinite(Number(eq)) ? Number(eq) : null);
            setTimeout(() => getActions().syncBrokerPositions().catch((e) => {
              if (typeof console !== 'undefined' && console.warn) {
                console.warn('[TradingStore] syncBrokerPositions failed:', e);
              }
            }), 100);
          }
          brokers = brokers.map((x) =>
            x.id === id
              ? {
                  ...x,
                  status: res.connected ? 'connected' : 'error',
                  lastError: res.connected ? undefined : res.message,
                  connectedAt: res.connected ? new Date().toISOString() : undefined,
                  config: { ...x.config, login, password, server },
                }
              : x
          );
          if (res.connected) persistNow(); // Persist immediately so broker connectivity survives reload
        } else {
          const appId = (config.appId ?? b.config.appId ?? '').toString().trim();
          const token = (config.password ?? b.config.password ?? '').toString().trim();
          if (!appId || !token) {
            brokers = brokers.map((x) =>
              x.id === id
                ? { ...x, status: 'error', lastError: 'Deriv requires App ID and token (from api.deriv.com).', config: { ...x.config, ...config } }
                : x
            );
          } else {
            let lastErr: Error | null = null;
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                if (attempt > 0) await new Promise((r) => setTimeout(r, 800));
                await withTimeout(derivConnect(appId, token));
                lastErr = null;
                break;
              } catch (e) {
                lastErr = e instanceof Error ? e : new Error(String(e));
                if (attempt === 1) throw lastErr;
              }
            }
            const { balance: bal } = await withTimeout(getDerivAccountSnapshot(true));
            setBalance(bal, 'deriv'); // Balance from Deriv API only (no mock)
            setTimeout(() => getActions().syncBrokerPositions().catch((e) => {
              if (typeof console !== 'undefined' && console.warn) {
                console.warn('[TradingStore] syncBrokerPositions failed:', e);
              }
            }), 100);
            brokers = brokers.map((x) =>
              x.id === id
                ? {
                    ...x,
                    status: 'connected',
                    lastError: undefined,
                    connectedAt: new Date().toISOString(),
                    config: { ...x.config, appId, password: token },
                  }
                : x
            );
            persistNow(); // Persist immediately so broker connectivity survives reload
          }
        }
      } catch (err) {
        brokers = brokers.map((x) =>
          x.id === id ? { ...x, status: 'error', lastError: err instanceof Error ? err.message : String(err) } : x
        );
        const portfolio = getPortfolioState();
        const isSource =
          (b.type === 'deriv_api' && portfolio.dataSource === 'deriv') ||
          (b.type === 'mt5' && portfolio.dataSource === 'mt5') ||
          (b.type === 'exness_api' && portfolio.dataSource === 'mt5');
        if (isSource) {
          setBalance(0, 'none');
          closedTradesByBot = {};
        }
      }
      schedulePersist();
      emit();
    },
    disconnectBroker(id) {
      const b = brokers.find((x) => x.id === id);
      if (!b) return;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[TradingStore] Broker disconnected:', id, b.type);
      }
      const portfolio = getPortfolioState();
      const isSource =
        (b.type === 'deriv_api' && portfolio.dataSource === 'deriv') ||
        (b.type === 'mt5' && portfolio.dataSource === 'mt5') ||
        (b.type === 'exness_api' && portfolio.dataSource === 'mt5');
      if (b.type === 'deriv_api') derivDisconnect();
      if (isSource) {
        setBalance(0, 'none');
        /** Clear closed trades when broker disconnects — avoid showing stale/wrong P/L from persisted state. */
        closedTradesByBot = {};
      }
      brokers = brokers.map((x) =>
        x.id === id ? { ...x, status: 'disconnected', lastError: undefined, connectedAt: undefined } : x
      );
      postExecutionLogAppend([{
        id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        botId: '',
        symbol: id,
        phase: 'broker',
        outcome: 'disconnect',
        message: `Broker disconnected: ${id} (${b.type})`,
      }]).catch(() => {});
      // Do NOT abort backtest or research on broker disconnect — backtest/research fetch then process; build uses no live connection.
      persistNow(); // Persist immediately so disconnected state survives reload
      emit();
    },
    async syncPortfolioBalance() {
      const connected = brokers.find((b) => b.status === 'connected');
      if (!connected) return;
      if (connected.type === 'deriv_api' && derivIsConnected()) {
        try {
          const { balance: bal, prices } = await getDerivAccountSnapshot(true);
          setBalance(bal, 'deriv');
          const portfolio = getPortfolioState();
          if (portfolio.positions.length > 0) {
            const resolveSymbol = (p: Position) => {
              const inst = instruments.find((i) => i.id === p.instrumentId);
              const raw = inst?.symbol ?? p.instrument ?? '';
              return raw.replace(/\s/g, '').replace('/', '').trim().toUpperCase();
            };
            const tryPrice = (p: Position) => {
              const sym = resolveSymbol(p);
              const quote = prices[sym] ?? prices[sym.toUpperCase()];
              if (quote != null) {
                const currentPrice = p.type === 'LONG' ? quote.bid : quote.ask;
                const pnl = quote.profit != null && Number.isFinite(quote.profit)
                  ? quote.profit
                  : positionPnl(p.type, p.size, p.entryPrice, currentPrice).pnl;
                const pnlPercent = p.entryPrice && p.size && p.entryPrice * p.size > 0
                  ? (pnl / (p.entryPrice * p.size)) * 100
                  : 0;
                return { currentPrice, pnl, pnlPercent };
              }
              for (const key of ourSymbolToDerivKeys(sym)) {
                const q = prices[key] ?? prices[key.toUpperCase()];
                if (q != null) {
                  const currentPrice = p.type === 'LONG' ? q.bid : q.ask;
                  const pnl = q.profit != null && Number.isFinite(q.profit)
                    ? q.profit
                    : positionPnl(p.type, p.size, p.entryPrice, currentPrice).pnl;
                  const pnlPercent = p.entryPrice && p.size && p.entryPrice * p.size > 0
                    ? (pnl / (p.entryPrice * p.size)) * 100
                    : 0;
                  return { currentPrice, pnl, pnlPercent };
                }
              }
              return { currentPrice: p.currentPrice, pnl: p.pnl, pnlPercent: p.pnlPercent };
            };
            updatePositionPrices(tryPrice);
          }
          schedulePersist();
          emit();
        } catch (e) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[TradingStore] derivGetBalance/getDerivAccountSnapshot failed:', e);
          }
        }
        return;
      }
      if (connected.type === 'exness_api') {
        const apiKey = (connected.config.apiKey ?? '').toString().trim();
        if (!apiKey) return;
        try {
          const account = await getExnessAccount(apiKey, (connected.config.baseUrl ?? '').trim() || undefined);
          setBalance(account.balance, 'mt5');
          setServerEquity(account.equity ?? null);
        } catch (e) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[TradingStore] getExnessAccount failed:', e);
          }
        }
        return;
      }
      if (connected.type === 'mt5') {
        const login = (connected.config.login ?? '').toString().trim();
        const password = connected.config.password ?? '';
        const server = (connected.config.server ?? '').toString().trim();
        if (!login || !password) return;
        try {
          const acc = await getMt5Account();
          if (acc.connected && acc.account) {
            setBalance(acc.account.balance, 'mt5');
            setServerEquity(acc.account.equity ?? null);
            return;
          }
          const res = await postMt5Connect(login, password, server);
          if (res.connected) {
            const numBal = res.account?.balance != null && Number.isFinite(Number(res.account.balance)) ? Number(res.account.balance) : 0;
            setBalance(numBal, 'mt5');
            const eq = res.account?.equity;
            setServerEquity(eq != null && Number.isFinite(Number(eq)) ? Number(eq) : null);
          }
        } catch (e) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[TradingStore] getMt5Account/postMt5Connect failed:', e);
          }
        }
      }
    },
    async syncBrokerPositions() {
      const portfolio = getPortfolioState();
      const connectedBySource =
        portfolio.dataSource === 'deriv'
          ? brokers.find((b) => b.type === 'deriv_api' && b.status === 'connected')
          : portfolio.dataSource === 'mt5'
            ? brokers.find((b) => (b.type === 'mt5' || b.type === 'exness_api' || b.id === BROKER_EXNESS_ID) && b.status === 'connected')
            : null;
      const connected = connectedBySource ?? brokers.find((b) => b.status === 'connected');
      if (!connected) throw new Error('No broker connected. Connect a broker to sync positions.');
      const resolveInstrumentId = (symbol: string): string => {
        const norm = symbol.replace(/\s/g, '').replace('/', '').toUpperCase();
        const inst = instruments.find(
          (i) => i.symbol.replace(/\s/g, '').replace('/', '').toUpperCase() === norm
        );
        return inst?.id ?? symbol;
      };
      if (connected.type === 'exness_api') {
        const apiKey = (connected.config.apiKey ?? '').toString().trim();
        const baseUrl = (connected.config.baseUrl ?? '').trim() || undefined;
        if (!apiKey) return;
        try {
          const rows = await getExnessPositions(apiKey, baseUrl);
          const positions: Position[] = rows.map((p, i) => {
            const type: Position['type'] = (p.type === 'buy' ? 'LONG' : 'SHORT') as Position['type'];
            const entryPrice = Number(p.price_open) || 0;
            const size = Number(p.volume) || 0;
            const rawCurrent = Number(p.price_current);
            const currentPrice = (rawCurrent && Number.isFinite(rawCurrent)) ? rawCurrent : (entryPrice || 0);
            const pnl = p.profit != null ? Number(p.profit) : (currentPrice - entryPrice) * size * (type === 'LONG' ? 1 : -1);
            const pnlPercent = entryPrice && size ? (pnl / (entryPrice * size)) * 100 : 0;
            const instId = resolveInstrumentId(p.symbol);
            const existing = portfolio.positions.find((ep) => ep.instrumentId === instId && ep.type === type);
            const { scope, style } = existing ? { scope: existing.scope, style: existing.style } : getScopeStyleFromBotForInstrument(instId, bots, instruments);
            const bal = portfolio.balance > 0 ? portfolio.balance : portfolio.equity;
            return {
              id: `pos-exness-${p.id ?? i}-${Date.now()}`,
              instrumentId: instId,
              instrument: p.symbol,
              type,
              size,
              entryPrice,
              currentPrice,
              pnl,
              pnlPercent,
              scope,
              style,
              botId: existing?.botId ?? '',
              openedAt: existing?.openedAt ?? (p.time ? new Date(p.time * 1000).toISOString() : new Date().toISOString()),
              stopLoss: p.sl,
              takeProfit: p.tp,
              riskAmount: size * entryPrice * 0.02,
              balanceAtEntry: existing?.balanceAtEntry ?? (bal > 0 ? bal : undefined),
            };
          });
          const newKeys = new Set(positions.map((p) => {
            const m = p.id.match(/^pos-exness-(.+?)-\d+$/);
            return m ? m[1] : p.id;
          }));
          await reconcileClosedPositions(portfolio.positions, newKeys, (id) => {
            const m = id.match(/^pos-exness-(.+?)-\d+$/);
            return m ? m[1] : null;
          }, undefined);
          if (positions.length > 0) setPositions(positions);
          else if (portfolio.positions.some((p) => p.id.startsWith('pos-exness-'))) setPositions([]);
          schedulePersist();
          emit();
        } catch (e) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[TradingStore] syncBrokerPositions exness failed:', e);
          }
        }
        return;
      }
      if (connected.type === 'mt5') {
        const res = await getMt5Positions();
        if ('error' in res) return;
        const newKeys = new Set((res.positions ?? []).map((p) => String(p.ticket)));
        const toReconcile = portfolio.positions.filter((p) => {
          const m = p.id.match(/^pos-mt5-(\d+)$/);
          const key = m ? m[1] : null;
          return key != null && !newKeys.has(key);
        });
        const symbolsToFetch = [...new Set(toReconcile.map((p) => (p.instrument ?? p.instrumentId).replace(/\s/g, '').replace('/', '')))];
        let livePrices: Record<string, { bid: number; ask: number }> = {};
        if (symbolsToFetch.length > 0) {
          const pr = await getMt5Prices(symbolsToFetch);
          if (!('error' in pr)) livePrices = pr.prices;
        }
        const getMt5LiveExit = async (p: Position) => {
          const raw = p.instrument ?? p.instrumentId;
          const variants = [raw.replace(/\s/g, '').replace('/', ''), raw.replace(/\s/g, '').replace('/', '').toUpperCase()];
          for (const v of variants) {
            const q = livePrices[v];
            if (q) return p.type === 'LONG' ? q.bid : q.ask;
          }
          return null;
        };
        await reconcileClosedPositions(portfolio.positions, newKeys, (id) => {
          const m = id.match(/^pos-mt5-(\d+)$/);
          return m ? m[1] : null;
        }, { getLiveExitPrice: getMt5LiveExit });
        if (!res.positions?.length) {
          if (portfolio.positions.some((p) => p.id.startsWith('pos-mt5-'))) setPositions([]);
          schedulePersist();
          emit();
          return;
        }
          const positions: Position[] = res.positions.map((p) => {
            const type: Position['type'] = p.type === 0 ? 'LONG' : 'SHORT';
            const entryPrice = Number(p.price_open) || 0;
            const size = Number(p.volume) || 0;
            const rawCurrent = Number(p.price_current);
            const currentPrice = (rawCurrent && Number.isFinite(rawCurrent)) ? rawCurrent : (entryPrice || 0);
            const pnl = Number(p.profit) || 0;
            const pnlPercent = entryPrice && size ? (pnl / (entryPrice * size)) * 100 : 0;
            const riskAmount = size * entryPrice * 0.02;
            const existing = portfolio.positions.find((ep) => ep.id === `pos-mt5-${p.ticket}`);
            const instId = resolveInstrumentId(p.symbol);
            const { scope, style } = existing ? { scope: existing.scope, style: existing.style } : getScopeStyleFromBotForInstrument(instId, bots, instruments);
            const bal = portfolio.balance > 0 ? portfolio.balance : portfolio.equity;
            return {
            id: `pos-mt5-${p.ticket}`,
            instrumentId: instId,
            instrument: p.symbol,
            type,
            size,
            entryPrice,
            currentPrice,
            pnl,
            pnlPercent,
            scope,
            style,
            botId: existing?.botId ?? '',
            openedAt: existing?.openedAt ?? new Date(p.time * 1000).toISOString(),
            stopLoss: p.sl ?? undefined,
            takeProfit: p.tp ?? undefined,
            riskAmount,
            balanceAtEntry: existing?.balanceAtEntry ?? (bal > 0 ? bal : undefined),
          };
        });
        setPositions(positions);
        schedulePersist();
        emit();
        return;
      }
      if (connected.type === 'deriv_api' && derivIsConnected()) {
        try {
          const derivRegistrySymbols = instruments
            .filter((i) => i.type === 'synthetic_deriv' && i.brokerId === BROKER_DERIV_ID)
            .map((i) => i.symbol);
          const rows = await getDerivPositions();
          const newKeys = new Set(rows.map((r) => String(r.contractId ?? '')));
          let profitTable = await getDerivProfitTable(200);
          const closedCount = portfolio.positions.filter((p) => {
            const m = p.id.match(/^pos-deriv-(\d+)-\d+$/);
            const key = m ? m[1] : null;
            return key != null && !newKeys.has(key);
          }).length;
          if (closedCount > 0 && profitTable.length === 0) {
            await new Promise((r) => setTimeout(r, 800));
            profitTable = await getDerivProfitTable(200);
          }
          const derivProfitByContractId = new Map(profitTable.map((t) => [t.contract_id, t]));
          await reconcileClosedPositions(portfolio.positions, newKeys, (id) => {
            const m = id.match(/^pos-deriv-(\d+)-\d+$/);
            return m ? m[1] : null;
          }, {
            derivProfitByContractId,
            getScopeForInstrument: (instrumentId) => getScopeStyleFromBotForInstrument(instrumentId, bots, instruments).scope,
          });
          updateClosedTradesFromDerivProfitTable(profitTable);
          const existingPositions = portfolio.positions;
          const positions: Position[] = rows.length > 0 ? rows.map((r, i) => {
            const registrySym = resolveDerivApiSymbolToRegistry(r.instrument, derivRegistrySymbols);
            const inst = registrySym ? instruments.find((instr) => instr.symbol === registrySym) : null;
            const instrumentId = inst?.id ?? resolveInstrumentId(r.instrument);
            const cid = r.contractId ?? i;
            const existing = existingPositions.find((p) => {
              const m = p.id.match(/^pos-deriv-(\d+)-/);
              return m && m[1] === String(cid);
            }) ?? existingPositions.find((p) => p.instrument === r.instrument && p.type === r.type);
            const stopLoss = r.stopLoss ?? existing?.stopLoss;
            const takeProfit = r.takeProfit ?? existing?.takeProfit;
            /** Deriv buy_price can be stake (e.g. 3) for binary options; use existing underlying price when sane. */
            const entryPrice = (r.entryPrice > 100) ? r.entryPrice : (existing?.entryPrice ?? r.currentPrice ?? r.entryPrice);
            const { scope, style } = getScopeStyleFromBotForInstrument(instrumentId, bots, instruments);
            const bal = portfolio.balance > 0 ? portfolio.balance : portfolio.equity;
            return {
            id: `pos-deriv-${r.contractId ?? i}-${Date.now()}`,
            instrumentId,
            instrument: r.instrument,
            type: r.type,
            size: r.size,
            entryPrice,
            currentPrice: r.currentPrice,
            pnl: r.pnl,
            pnlPercent: r.pnlPercent,
            scope,
            style,
            botId: existing?.botId ?? '',
            openedAt: existing?.openedAt ?? new Date().toISOString(),
            stopLoss,
            takeProfit,
            riskAmount: r.size * entryPrice * 0.02,
            balanceAtEntry: existing?.balanceAtEntry ?? (bal > 0 ? bal : undefined),
          };
          }) : [];
          setPositions(positions);
          schedulePersist();
          emit();
        } catch (e) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[TradingStore] syncBrokerPositions mt5 failed:', e);
          }
        }
      }
    },
    removePosition(positionId) {
      removePosition(positionId);
      schedulePersist();
      emit();
    },
    clearClosedTrades() {
      closedTradesByBot = {};
      schedulePersist();
      emit();
    },
    applyMt5LoginSuccess(credentials, account) {
      const balance = Number(account.balance);
      setBalance(Number.isFinite(balance) ? balance : 0, 'mt5');
      setServerEquity(account.equity != null && Number.isFinite(Number(account.equity)) ? Number(account.equity) : null);
      const exness = brokers.find((x) => x.id === BROKER_EXNESS_ID);
      if (exness) {
        brokers = brokers.map((x) =>
          x.id === BROKER_EXNESS_ID
            ? {
                ...x,
                status: 'connected' as const,
                lastError: undefined,
                connectedAt: new Date().toISOString(),
                config: {
                  ...x.config,
                  login: credentials.login,
                  password: credentials.password,
                  server: credentials.server,
                },
              }
            : x
        );
      }
      schedulePersist();
      emit();
    },
    getBrokerForInstrument(instrumentId) {
      const inst = instruments.find((i) => i.id === instrumentId);
      if (!inst) return null;
      return brokers.find((b) => b.id === inst.brokerId) ?? null;
    },
    getState() {
      return getSnapshot();
    },
    ensureFullInstrumentRegistry() {
      const derivCount = instruments.filter((i) => i.type === 'synthetic_deriv' && i.brokerId === BROKER_DERIV_ID).length;
      const expectedDeriv = DEFAULT_INSTRUMENTS.filter((i) => i.type === 'synthetic_deriv' && i.brokerId === BROKER_DERIV_ID).length;
      if (instruments.length >= DEFAULT_INSTRUMENTS.length && derivCount >= expectedDeriv) return;
      const selectedId = instruments.find((i) => i.selected)?.id;
      const defaultIds = new Set(DEFAULT_INSTRUMENTS.map((d) => d.id));
      const keepSelected = selectedId && defaultIds.has(selectedId);
      const currentById = new Map(instruments.map((i) => [i.id, i]));
      instruments = DEFAULT_INSTRUMENTS.map((d, idx) => {
        const cur = currentById.get(d.id);
        const spread = cur?.spread != null && cur.spread > 0 ? cur.spread : undefined;
        return {
          ...d,
          brokerId: d.brokerId, // Registry: Deriv (fiat/crypto/synthetics) vs eXness API (index CFDs only)
          spread,
          rebuildIntervalHours: cur?.rebuildIntervalHours ?? d.rebuildIntervalHours,
          selected: keepSelected ? d.id === selectedId : idx === 0,
        };
      });
      persist();
      emit();
    },
  };
}

const TradingStoreContext = createContext<{
  state: TradingStoreState;
  actions: TradingStoreActions;
} | null>(null);

const HMR_RESTORE_FLAG = '__tradingStoreHmrDisposed';

export function TradingStoreProvider({ children }: { children: React.ReactNode }) {
  const initRef = useRef(false);
  const win = typeof window !== 'undefined' ? window : null;
  // On HMR, React Fast Refresh preserves initRef (true), but module-level state (brokers) is reset.
  // The dispose callback sets a flag so we run loadPersisted again to restore and reconnect.
  const hmrDisposed = win && (import.meta as { hot?: unknown }).hot && (win as unknown as Record<string, boolean>)[HMR_RESTORE_FLAG];
  const shouldInit = win && (!initRef.current || hmrDisposed);
  if (shouldInit) {
    initRef.current = true;
    if (hmrDisposed) (win as unknown as Record<string, boolean>)[HMR_RESTORE_FLAG] = false;
    try {
      const actions = getActions();
      actions.loadPersisted();
      actions.ensureFullInstrumentRegistry(); // restore full registry if count was ever stuck (e.g. 54)
      setOnDerivConnectionLost(() => actions.disconnectBroker(BROKER_DERIV_ID));
      window.addEventListener('beforeunload', () => {
        persistNow();
      });
    } catch (err) {
      console.error('Store init failed:', err);
    }
  }
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const actions = useMemo(() => getActions(), []);
  const value = useMemo(() => ({ state, actions }), [state, actions]);
  return (
    <TradingStoreContext.Provider value={value}>
      {children}
    </TradingStoreContext.Provider>
  );
}

export function useTradingStore() {
  const ctx = useContext(TradingStoreContext);
  if (!ctx) throw new Error('useTradingStore must be used within TradingStoreProvider');
  return ctx;
}

// On HMR: module re-executes, in-memory state and WebSocket are reset. The accept() callback runs in the OLD
// module context (state is discarded). Use dispose to signal the NEW module to restore on first render.
const hot = (import.meta as { hot?: { dispose: (cb: () => void) => void } }).hot;
if (hot) {
  hot.dispose(() => {
    (window as unknown as { __tradingStoreHmrDisposed?: boolean }).__tradingStoreHmrDisposed = true;
  });
}
