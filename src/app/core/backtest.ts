/**
 * Production backtest engine: OHLCV data, regime detection, strategy signals,
 * rule-based trade execution (entry/exit per your rules) with PnL/drawdown,
 * and full metrics (Sharpe, Sortino, profit factor, etc.). Deterministic — no randomness.
 */

import type {
  BacktestRunRequest,
  BacktestResultRow,
  BacktestStatus,
  Timeframe,
  MarketRegime,
  TradeScope,
  StrategyParams,
  BacktestDiagnostics,
  RegimeState,
} from './types';
import type { OHLCVBar } from './ohlcv';
import { BACKTEST_CONFIG } from './config';
import { safeDiv } from './mathUtils';
import { spreadPointsToFraction as spreadPointsToFractionUtil } from './spreadUtils';
import { getAllStrategies } from './registries';
import { validateStrategyIds } from './strategySelection';
import { detectRegimeSeries } from './regimes';
import { getSignalFn, type SignalContext } from './signals';
import { buildHtfIndexForEachLtfBar, getHigherTimeframe } from './multiTimeframe';
import {
  DEFAULT_BACKTEST_PARAM_COMBOS_LIMIT,
  getParamCombinationsLimited,
} from './strategyParams';

const REGIMES: MarketRegime[] = [
  'trending_bull', 'trending_bear', 'ranging', 'reversal_bull', 'reversal_bear',
  'volatile', 'breakout', 'consolidation', 'unknown', 'any',
];

import { SCOPE_BACKTEST_DEFAULTS, SCOPE_MAX_HOLD_BARS } from './scope';

const TIMEFRAME_TO_SCOPE: Record<Timeframe, TradeScope> = {
  M1: 'scalp', M5: 'scalp', M15: 'day', M30: 'day', H1: 'day', H4: 'swing', D1: 'swing', W1: 'position',
};

/** Convert instrument spread (points/pips) to price fraction using instrument-specific point size. */
function spreadPointsToFraction(spreadPoints: number, instrumentSymbol: string): number {
  return spreadPointsToFractionUtil(spreadPoints, instrumentSymbol);
}

/** Resolve backtest config from request overrides. */
function getBacktestConfig(request: BacktestRunRequest | null): {
  initialEquity: number;
  slippagePct: number;
  riskPerTradePct: number;
  stopLossPct: number;
  takeProfitR: number;
  regimeLookback: number;
} {
  return {
    initialEquity: request?.initialEquity ?? BACKTEST_CONFIG.initialEquity,
    slippagePct: request?.slippagePct ?? BACKTEST_CONFIG.slippagePct,
    riskPerTradePct: request?.riskPerTradePct ?? BACKTEST_CONFIG.riskPerTradePct,
    stopLossPct: request?.stopLossPct ?? BACKTEST_CONFIG.stopLossPct,
    takeProfitR: request?.takeProfitR ?? BACKTEST_CONFIG.takeProfitR,
    regimeLookback: request?.regimeLookback ?? BACKTEST_CONFIG.regimeLookback,
  };
}

/** Trade record from backtest: deterministic execution per rules (entry, stop, target, exit). */
interface SimTrade {
  entryBar: number;
  exitBar: number;
  side: 1 | -1;
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  pnlPct: number;
  exitReason: 'signal' | 'stop' | 'target' | 'max_hold';
}

const UNKNOWN_REGIME_STATE: RegimeState = {
  regime: 'unknown',
  confidence: 0,
  trendStrength: 0,
  volatilityPercent: 0,
  momentum: 0,
  detectedAt: new Date().toISOString(),
};

function resolvePreferHtfRegime(
  request: BacktestRunRequest | null | undefined,
  htfBars: OHLCVBar[] | null | undefined,
  regimeLookback: number
): boolean {
  if (request?.preferHtfRegime === false) return false;
  if (request?.preferHtfRegime === true) return true;
  return !!(htfBars && htfBars.length >= regimeLookback + 2);
}

/** Optional higher-timeframe bars + regime mapping for multi-timeframe signals and HTF regime filter. */
export interface RunSingleBacktestMtfOptions {
  htfBars?: OHLCVBar[] | null;
  htfTimeframe?: Timeframe | null;
  preferHtfRegime?: boolean;
  request?: BacktestRunRequest | null;
}

export function runSingleBacktest(
  instrumentId: string,
  instrumentSymbol: string,
  strategyId: string,
  strategyName: string,
  timeframe: Timeframe,
  regime: MarketRegime,
  /** Spread as price fraction (e.g. 0.0001 = 0.01%). Used for entry/exit cost. */
  spreadPct: number,
  seed: number,
  /** When provided, use these bars (live data). Required — no synthetic fallback. */
  barsOverride?: OHLCVBar[] | null,
  /** Strategy params for grid search (e.g. RSI period, MACD fast/slow). */
  strategyParams?: StrategyParams,
  /** Override backtest config (risk, stop, target, regime lookback). */
  backtestConfig?: { initialEquity: number; slippagePct: number; riskPerTradePct: number; stopLossPct: number; takeProfitR: number; regimeLookback: number },
  /** Higher timeframe series (same symbol) for real HTF signals + optional HTF regime filter. */
  mtf?: RunSingleBacktestMtfOptions
): Omit<BacktestResultRow, 'id' | 'status' | 'completedAt'> {
  const scope = TIMEFRAME_TO_SCOPE[timeframe];
  const spread = Number.isFinite(spreadPct) ? spreadPct : BACKTEST_CONFIG.defaultSpreadPct;
  const cfg = backtestConfig ?? getBacktestConfig(null);
  const maxHoldBars = SCOPE_MAX_HOLD_BARS[scope];
  if (!barsOverride || barsOverride.length === 0) {
    throw new Error(`Live data required for backtest (${instrumentId} ${timeframe}). Connect Deriv or MT5 in Brokers.`);
  }
  const bars: OHLCVBar[] = barsOverride;

  const htfBars = mtf?.htfBars && mtf.htfBars.length > 0 ? mtf.htfBars : null;
  const req = mtf?.request;
  const preferHtfRegime = resolvePreferHtfRegime(req ?? null, htfBars, cfg.regimeLookback);

  let regimeSeries: RegimeState[];
  let signalCtx: SignalContext | undefined;

  if (htfBars && htfBars.length >= 2) {
    const htfIndexByLtfBar = buildHtfIndexForEachLtfBar(bars, htfBars);
    signalCtx = {
      htfBars,
      htfIndexByLtfBar,
      htfTimeframe: mtf?.htfTimeframe ?? undefined,
      ltfTimeframe: timeframe,
    };
    if (preferHtfRegime && htfBars.length >= cfg.regimeLookback + 2) {
      const htfReg = detectRegimeSeries(htfBars, cfg.regimeLookback);
      regimeSeries = bars.map((_, i) => {
        const hi = htfIndexByLtfBar[i];
        if (hi < 0) return UNKNOWN_REGIME_STATE;
        return htfReg[hi] ?? htfReg[htfReg.length - 1] ?? UNKNOWN_REGIME_STATE;
      });
    } else {
      regimeSeries = detectRegimeSeries(bars, cfg.regimeLookback);
    }
  } else {
    regimeSeries = detectRegimeSeries(bars, cfg.regimeLookback);
  }

  const signalFn = getSignalFn(strategyId, instrumentId, instrumentSymbol);
  const trades: SimTrade[] = [];
  let position: { side: 1 | -1; entryBar: number; entryPrice: number; size: number; stop: number; target: number } | null = null;
  let equity = cfg.initialEquity;
  let peakEquity = cfg.initialEquity;
  let maxDrawdown = 0;
  const returns: number[] = [];

  // Diagnostic counters for zero-trade runs
  let signalsFired = 0;
  let regimeBlocked = 0;
  const regimeDistribution: Record<string, number> = {};
  let signalsLong = 0;
  let signalsShort = 0;

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const prevBar = bars[i - 1];
    const reg = regimeSeries[i] ?? null;
    const signal = signalFn(bars, reg, i, strategyParams, signalCtx);

    // Diagnostics: track signals and regime blocking
    if (signal !== 0) {
      signalsFired++;
      if (signal === 1) signalsLong++;
      else signalsShort++;
      const rk = reg?.regime ?? 'null';
      regimeDistribution[rk] = (regimeDistribution[rk] ?? 0) + 1;
    }

    if (position) {
      const high = bar.high, low = bar.low;
      const holdBars = i - position.entryBar;
      let exitPrice: number | null = null;
      let exitReason: 'signal' | 'stop' | 'target' | 'max_hold' = 'signal';

      if (holdBars >= maxHoldBars) {
        exitPrice = position.side === 1 ? bar.close * (1 - spread) : bar.close * (1 + spread);
        exitReason = 'max_hold';
      } else if (position.side === 1) {
        if (low <= position.stop) {
          exitPrice = position.stop;
          exitReason = 'stop';
        } else if (high >= position.target) {
          exitPrice = position.target;
          exitReason = 'target';
        } else if (signal === -1) {
          exitPrice = bar.close * (1 - spread);
          exitReason = 'signal';
        }
      } else {
        if (high >= position.stop) {
          exitPrice = position.stop;
          exitReason = 'stop';
        } else if (low <= position.target) {
          exitPrice = position.target;
          exitReason = 'target';
        } else if (signal === 1) {
          exitPrice = bar.close * (1 + spread);
          exitReason = 'signal';
        }
      }

      if (exitPrice != null) {
        const slippage = position.entryPrice * cfg.slippagePct;
        const actualExit = position.side === 1 ? exitPrice - slippage : exitPrice + slippage;
        const pnlPct = position.side === 1
          ? safeDiv(actualExit - position.entryPrice, position.entryPrice)
          : safeDiv(position.entryPrice - actualExit, position.entryPrice);
        const pnl = position.size * position.entryPrice * pnlPct;
        equity += pnl;
        returns.push(pnlPct);
        trades.push({
          entryBar: position.entryBar,
          exitBar: i,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: actualExit,
          size: position.size,
          pnl,
          pnlPct,
          exitReason,
        });
        const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
        if (equity > peakEquity) peakEquity = equity;
        if (dd > maxDrawdown) maxDrawdown = dd;
        position = null;
      }
    }

    if (!position && (signal === 1 || signal === -1)) {
      // Only enter when detected regime at this bar matches the job's regime filter (or regime is 'any' = no filter)
      const regimeMatches = regime === 'any' || reg?.regime === regime;
      if (!regimeMatches) {
        regimeBlocked++;
        continue;
      }
      const entryPrice = bar.close * (1 + (signal === 1 ? spread : -spread));
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;
      const riskAmount = equity * cfg.riskPerTradePct;
      const riskDist = entryPrice * cfg.stopLossPct;
      const size = riskDist > 0 ? riskAmount / riskDist : 0;
      if (size <= 0 || !Number.isFinite(size)) continue;
      const stop = signal === 1 ? entryPrice * (1 - cfg.stopLossPct) : entryPrice * (1 + cfg.stopLossPct);
      const riskDistAbs = Math.abs(entryPrice - stop);
      const target = signal === 1 ? entryPrice + riskDistAbs * cfg.takeProfitR : entryPrice - riskDistAbs * cfg.takeProfitR;
      position = { side: signal as 1 | -1, entryBar: i, entryPrice, size, stop, target };
    }
  }

  const wins = trades.filter((t) => t.pnl > 0).length;
  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const totalProfit = trades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : totalTrades > 0 ? 2 : 1;
  const avgHoldBars = totalTrades > 0 ? trades.reduce((s, t) => s + (t.exitBar - t.entryBar), 0) / totalTrades : 0;

  const meanRet = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdRet = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (returns.length - 1))
    : 0;
  const sharpeRatio = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(252) : 0;
  const downside = returns.filter((r) => r < 0);
  const downStd = downside.length > 1
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length)
    : 0;
  const sortinoRatio = downStd > 0 ? (meanRet / downStd) * Math.sqrt(252) : 0;

  const dataEndTime =
    bars.length > 0 && bars[bars.length - 1]?.time
      ? new Date(bars[bars.length - 1].time).toISOString()
      : undefined;

  const diagnostics: BacktestDiagnostics | undefined =
    totalTrades === 0
      ? (() => {
          let zeroTradeReason: string;
          if (signalsFired === 0) {
            zeroTradeReason = 'No signals fired — strategy pattern never matched bars';
          } else if (regimeBlocked >= signalsFired) {
            zeroTradeReason = `All ${signalsFired} signal(s) blocked by regime filter (job regime: ${regime})`;
          } else {
            zeroTradeReason = `${regimeBlocked} of ${signalsFired} signal(s) blocked by regime; no entries filled`;
          }
          return {
            barsCount: bars.length,
            signalsFired,
            regimeBlocked,
            regimeDistribution,
            signalDirectionDistribution: { long: signalsLong, short: signalsShort },
            zeroTradeReason,
          };
        })()
      : undefined;

  return {
    instrumentId,
    instrumentSymbol,
    strategyId,
    strategyName,
    strategyParams: strategyParams && Object.keys(strategyParams).length > 0 ? strategyParams : undefined,
    timeframe,
    regime,
    scope,
    winRate: Math.round(winRate * 10) / 10,
    profit: Math.round(totalProfit * 100) / 100,
    trades: totalTrades,
    maxDrawdown: Math.round(maxDrawdown * 10000) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    sortinoRatio: Math.round(sortinoRatio * 100) / 100,
    avgHoldBars: Math.round(avgHoldBars * 10) / 10,
    dataEndTime,
    diagnostics,
  };
}

let globalResultId = 0;
function nextId(): string {
  return `bt-${++globalResultId}-${Date.now()}`;
}

export type AutoCompareLogLevel = 'info' | 'progress' | 'success' | 'warning';

export interface AutoCompareLogEntry {
  level: AutoCompareLogLevel;
  message: string;
  timestamp: string;
}

export interface LastAutoCompareResult {
  winner: 'default' | 'research';
  profitDefault: number;
  profitResearch: number;
  timestamp: string;
}

/** Profit aggregated by trade scope (scalp/day/swing/position). */
export type ProfitByScope = Partial<Record<TradeScope, number>>;

export interface BacktestEngineState {
  status: BacktestStatus;
  progress: number;
  currentPhase: string;
  results: BacktestResultRow[];
  runRequest: BacktestRunRequest | null;
  /** Selected timeframes for next run; persisted across reload. */
  selectedTimeframes: Timeframe[];
  /** Auto-compare run log (default vs research backtest, comparison). */
  autoCompareLog: AutoCompareLogEntry[];
  /** Last auto-compare outcome: which config won and profits. */
  lastAutoCompareResult: LastAutoCompareResult | null;
  /** Total profit per trade scope (scalp, day, swing, position). Forward/backward iteration summary. */
  profitByScope?: ProfitByScope;
}

const DEFAULT_TIMEFRAMES: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];

const defaultState: BacktestEngineState = {
  status: 'idle',
  progress: 0,
  currentPhase: '',
  results: [],
  runRequest: null,
  selectedTimeframes: [...DEFAULT_TIMEFRAMES],
  autoCompareLog: [],
  lastAutoCompareResult: null,
  profitByScope: undefined,
};

const VALID_TF_SET = new Set<string>(DEFAULT_TIMEFRAMES);

/** Ensures a valid timeframe array. Handles undefined, null, or malformed persisted data. Empty array is valid (deselect all). */
function ensureTimeframesArray(
  arr: unknown,
  fallback: Timeframe[] = DEFAULT_TIMEFRAMES
): Timeframe[] {
  if (!Array.isArray(arr)) return [...fallback];
  const filtered = arr.filter((t): t is Timeframe => typeof t === 'string' && VALID_TF_SET.has(t));
  return filtered;
}

let engineState: BacktestEngineState = { ...defaultState };

export function getBacktestState(): BacktestEngineState {
  const tfs = ensureTimeframesArray(engineState.selectedTimeframes);
  return {
    ...engineState,
    results: [...engineState.results],
    selectedTimeframes: tfs,
    autoCompareLog: [...engineState.autoCompareLog],
    lastAutoCompareResult: engineState.lastAutoCompareResult,
    profitByScope: engineState.profitByScope,
  };
}

export function appendAutoCompareLog(level: AutoCompareLogLevel, message: string): void {
  engineState = {
    ...engineState,
    autoCompareLog: [
      ...engineState.autoCompareLog,
      { level, message, timestamp: new Date().toISOString() },
    ],
  };
}

export function setLastAutoCompareResult(result: LastAutoCompareResult | null): void {
  engineState = { ...engineState, lastAutoCompareResult: result };
}

export function clearAutoCompareLog(): void {
  engineState = {
    ...engineState,
    autoCompareLog: [],
    lastAutoCompareResult: null,
  };
}

export function setBacktestSelectedTimeframes(timeframes: Timeframe[]): void {
  const tfs = ensureTimeframesArray(timeframes);
  engineState = { ...engineState, selectedTimeframes: tfs };
}

/** Estimate total job count from a run request (mirrors runBacktest job creation). */
export function estimateBacktestJobCount(request: BacktestRunRequest | null): number | undefined {
  if (!request?.instrumentIds?.length || !request?.strategyIds?.length) return undefined;
  const strategies = getAllStrategies().filter((s) => request.strategyIds!.includes(s.id));
  const instruments = request.instrumentIds;
  const timeframes = request.timeframes?.length ? request.timeframes : (['M5', 'H1'] as Timeframe[]);
  const regimes = request.regimes?.length ? request.regimes : REGIMES;
  const paramLimit = request.paramCombosLimit ?? DEFAULT_BACKTEST_PARAM_COMBOS_LIMIT;
  let count = 0;
  for (const _instId of instruments) {
    for (const s of strategies) {
      const paramCombos = getParamCombinationsLimited(s.id, paramLimit);
      for (const _params of paramCombos) {
        for (const _tf of timeframes) {
          for (const _regime of regimes) {
            count++;
          }
        }
      }
    }
  }
  return count;
}

export function resetBacktestResults(): void {
  const tfs = ensureTimeframesArray(engineState.selectedTimeframes);
  engineState = { ...defaultState, results: [], selectedTimeframes: tfs };
}

/** Set backtest to running state (e.g. before server offload so UI shows progress). */
export function setBacktestRunning(runRequest: BacktestRunRequest, phase?: string): void {
  engineState = {
    ...engineState,
    status: 'running',
    progress: 0,
    currentPhase: phase ?? 'Processing on server...',
    results: [],
    runRequest,
  };
}

/** Update only the current phase (e.g. during server fetch). */
export function setBacktestPhase(phase: string): void {
  engineState.currentPhase = phase;
}

/** Set backtest to failed state (e.g. when server returns error). */
export function setBacktestFailed(phase: string): void {
  engineState = {
    ...engineState,
    status: 'failed',
    currentPhase: phase,
  };
}

/** Compute total profit per trade scope from backtest results. */
export function computeProfitByScope(results: BacktestResultRow[]): ProfitByScope {
  const out: ProfitByScope = {};
  for (const r of results) {
    if (r.status === 'completed' && r.scope) {
      out[r.scope] = (out[r.scope] ?? 0) + r.profit;
    }
  }
  return Object.keys(out).length > 0 ? out : {};
}

/** Set backtest to cancelled state (e.g. when user cancels or broker disconnects). */
export function setBacktestCancelled(
  results: BacktestResultRow[],
  runRequest: BacktestRunRequest | null,
  phase?: string
): void {
  engineState = {
    ...engineState,
    status: 'cancelled',
    profitByScope: computeProfitByScope(results),
    progress: (() => {
      const est = runRequest ? estimateBacktestJobCount(runRequest) : undefined;
      if (!results.length || est == null || est <= 0) return 0;
      return Math.round((results.length / est) * 100);
    })(),
    currentPhase: phase ?? 'Cancelled',
    results,
    runRequest,
  };
}

/** Restore backtest state from persisted data (e.g. after page reload). Preserves status (cancelled, failed, completed). */
export function hydrateBacktestState(data: {
  results: BacktestResultRow[];
  runRequest: BacktestRunRequest | null;
  status?: BacktestStatus;
  progress?: number;
  currentPhase?: string;
  selectedTimeframes?: Timeframe[];
  autoCompareLog?: AutoCompareLogEntry[];
  lastAutoCompareResult?: LastAutoCompareResult | null;
}): void {
  const hasResults = data.results.length > 0;
  const status =
    data.status && ['running', 'completed', 'cancelled', 'failed'].includes(data.status)
      ? data.status
      : hasResults
        ? 'completed'
        : 'idle';
  // When cancelled, keep progress at the point of cancellation; otherwise show 100% for completed/failed
  const progress =
    status === 'running' && typeof data.progress === 'number' && data.progress >= 0 && data.progress <= 100
      ? data.progress
      : status === 'cancelled' && typeof data.progress === 'number' && data.progress >= 0 && data.progress <= 100
        ? data.progress
      : status === 'completed' || status === 'failed' || (hasResults && status !== 'running')
        ? 100
        : 0;
  const selectedTimeframes = ensureTimeframesArray(
    data.selectedTimeframes,
    ensureTimeframesArray(data.runRequest?.timeframes)
  );
  engineState = {
    ...engineState,
    status,
    progress,
    profitByScope: computeProfitByScope(data.results),
    currentPhase: data.currentPhase ?? (hasResults ? `Restored ${data.results.length} results` : ''),
    results: data.results,
    runRequest: data.runRequest ?? null,
    selectedTimeframes,
    autoCompareLog: Array.isArray(data.autoCompareLog) ? data.autoCompareLog : [],
    lastAutoCompareResult: data.lastAutoCompareResult ?? null,
  };
}

/** Provider to fetch live OHLCV per instrument/timeframe. Required for backtest — no synthetic fallback. */
export type GetBarsProvider = (
  instrumentId: string,
  instrumentSymbol: string,
  timeframe: string
) => Promise<{ bars: OHLCVBar[]; dataSource: 'live' }>;

export function runBacktest(
  request: BacktestRunRequest,
  onProgress?: (state: BacktestEngineState) => void,
  getBars?: GetBarsProvider,
  signal?: AbortSignal,
  /** When resuming after reload: existing results to keep; backtest continues from next job. */
  existingResults?: BacktestResultRow[]
): Promise<BacktestResultRow[]> {
  if (!request.instrumentIds?.length) {
    return Promise.reject(new Error('At least one instrument is required'));
  }
  if (!request.strategyIds?.length) {
    return Promise.reject(new Error('At least one strategy is required'));
  }
  const validated = validateStrategyIds(request.strategyIds);
  if (validated.strategyIds.length === 0) {
    const msg = validated.hasWarnings
      ? `No valid strategies. ${validated.invalidIds.length ? `${validated.invalidIds.length} invalid. ` : ''}${validated.missingSignalIds.length ? `${validated.missingSignalIds.length} missing signal.` : ''}`
      : 'At least one strategy is required';
    return Promise.reject(new Error(msg));
  }
  const strategies = validated.strategies;
  const instruments = request.instrumentIds;
  const timeframes = request.timeframes?.length ? request.timeframes : (['M5', 'H1'] as Timeframe[]);
  const regimes = request.regimes?.length ? request.regimes : REGIMES;

  const spreads = request.instrumentSpreads ?? {};
  const btConfig = getBacktestConfig(request);
  const defaultSpreadPct = BACKTEST_CONFIG.defaultSpreadPct;
  const paramLimit = request.paramCombosLimit ?? DEFAULT_BACKTEST_PARAM_COMBOS_LIMIT;
  const jobs: Array<{
    instrumentId: string;
    instrumentSymbol: string;
    strategyId: string;
    strategyName: string;
    timeframe: Timeframe;
    regime: MarketRegime;
    seed: number;
    spreadPct: number;
    strategyParams?: StrategyParams;
  }> = [];
  let seed = 0;
  const instSymbols = request.instrument_symbols ?? {};
  for (const instId of instruments) {
    const symbol = instSymbols[instId] ?? (instId.replace(/^inst-/, '').toUpperCase().replace(/-/g, '/') || instId);
    const spreadVal = spreads[instId];
    const spreadPct =
      spreadVal != null && Number.isFinite(spreadVal)
        ? spreadPointsToFraction(spreadVal, symbol)
        : defaultSpreadPct;
    for (const s of strategies) {
      const paramCombos = getParamCombinationsLimited(s.id, paramLimit);
      for (const strategyParams of paramCombos) {
        for (const tf of timeframes) {
          for (const regime of regimes) {
            jobs.push({
              instrumentId: instId,
              instrumentSymbol: symbol,
              strategyId: s.id,
              strategyName: s.name,
              timeframe: tf,
              regime,
              seed: seed++,
              spreadPct,
              strategyParams: Object.keys(strategyParams).length > 0 ? strategyParams : undefined,
            });
          }
        }
      }
    }
  }

  if (!getBars) {
    return Promise.reject(new Error('Live data required. Provide getBars and connect Deriv or MT5 in Brokers.'));
  }
  const total = jobs.length;
  const startIndex = existingResults?.length ?? 0;
  const results: BacktestResultRow[] = existingResults ? [...existingResults] : [];
  let zeroTradeLogCount = 0;
  const MAX_ZERO_TRADE_LOGS = 5;
  engineState = {
    ...engineState,
    status: 'running',
    profitByScope: undefined,
    progress: total ? Math.round((results.length / total) * 100) : 0,
    currentPhase: startIndex > 0
      ? `Resuming from ${startIndex}/${jobs.length}...`
      : `Backtesting ${jobs.length} configurations (live data + regime + signals + rule execution)`,
    results: [...results],
    runRequest: request,
  };
  onProgress?.(getBacktestState());

  return new Promise((resolve) => {
    // Run one job per tick so the main thread can update the UI (avoids freeze with 50k bars per job).
    const chunkSize = 1;
    const barCache = new Map<string, { bars: OHLCVBar[]; dataSource: 'live' }>();

    const runChunk = async (start: number): Promise<void> => {
      if (signal?.aborted) {
        engineState.status = 'cancelled';
        engineState.currentPhase = 'Cancelled';
        onProgress?.(getBacktestState());
        resolve(results);
        return;
      }
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const end = Math.min(start + chunkSize, total);
      for (let i = start; i < end; i++) {
        const job = jobs[i];
        const key = `${job.instrumentId}|${job.timeframe}`;
        if (!barCache.has(key)) {
          try {
            barCache.set(key, await getBars(job.instrumentId, job.instrumentSymbol, job.timeframe));
          } catch (e) {
            if ((e as Error)?.name === 'AbortError') {
              engineState.status = 'cancelled';
              engineState.currentPhase = 'Cancelled';
              onProgress?.(getBacktestState());
              resolve(results);
              return;
            }
            const detail = e instanceof Error ? e.message : String(e);
            console.error(
              `[backtest] OHLCV fetch failed for ${job.instrumentSymbol} ${job.timeframe}:`,
              detail
            );
            throw e;
          }
        }
        const cached = barCache.get(key)!;
        const bars = cached.bars;
        const dataSource = cached.dataSource;
        const jobKey = `${job.instrumentId}|${job.strategyId}`;
        const jobKeyTf = `${job.instrumentId}|${job.strategyId}|${job.timeframe}`;
        const jobOverrides = request.jobRiskOverrides?.[jobKeyTf] ?? request.jobRiskOverrides?.[jobKey];
        const instOverrides = request.instrumentRiskOverrides?.[job.instrumentId];
        const overrides = jobOverrides ?? instOverrides;
        const scope = TIMEFRAME_TO_SCOPE[job.timeframe];
        const scopeDefaults = SCOPE_BACKTEST_DEFAULTS[scope];
        const jobConfig = {
          ...btConfig,
          ...scopeDefaults,
          ...(overrides?.riskPerTradePct != null && { riskPerTradePct: overrides.riskPerTradePct }),
          ...(overrides?.stopLossPct != null && { stopLossPct: overrides.stopLossPct }),
          ...(overrides?.takeProfitR != null && { takeProfitR: overrides.takeProfitR }),
        };
        const htfTf = getHigherTimeframe(job.timeframe);
        let mtf: RunSingleBacktestMtfOptions | undefined;
        if (htfTf) {
          const htfKey = `${job.instrumentId}|${htfTf}`;
          if (!barCache.has(htfKey)) {
            try {
              barCache.set(htfKey, await getBars(job.instrumentId, job.instrumentSymbol, htfTf));
            } catch (e) {
              if ((e as Error)?.name === 'AbortError') {
                engineState.status = 'cancelled';
                engineState.currentPhase = 'Cancelled';
                onProgress?.(getBacktestState());
                resolve(results);
                return;
              }
              const detail = e instanceof Error ? e.message : String(e);
              console.error(
                `[backtest] OHLCV fetch failed for ${job.instrumentSymbol} ${htfTf} (HTF):`,
                detail
              );
              throw e;
            }
          }
          const htfCached = barCache.get(htfKey);
          if (htfCached?.bars?.length) {
            mtf = {
              htfBars: htfCached.bars,
              htfTimeframe: htfTf,
              request,
            };
          }
        }
        try {
          const base = runSingleBacktest(
            job.instrumentId,
            job.instrumentSymbol,
            job.strategyId,
            job.strategyName,
            job.timeframe,
            job.regime,
            job.spreadPct,
            job.seed,
            bars,
            job.strategyParams,
            jobConfig,
            mtf
          );
          const row: BacktestResultRow = {
            ...base,
            id: nextId(),
            status: 'completed',
            completedAt: new Date().toISOString(),
            dataSource,
          };
          results.push(row);
          if (base.trades === 0 && base.diagnostics && zeroTradeLogCount < MAX_ZERO_TRADE_LOGS) {
            zeroTradeLogCount++;
            const d = base.diagnostics;
            const dir = d.signalDirectionDistribution;
            const dirStr = dir ? ` long=${dir.long} short=${dir.short}` : '';
            console.warn(
              `[Backtest $0] ${job.instrumentSymbol} ${job.strategyId} ${job.timeframe} regime=${job.regime}:`,
              d.zeroTradeReason ?? `bars=${d.barsCount} signals=${d.signalsFired} regimeBlocked=${d.regimeBlocked}${dirStr}`,
              d.regimeDistribution
            );
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          results.push({
            instrumentId: job.instrumentId,
            instrumentSymbol: job.instrumentSymbol,
            strategyId: job.strategyId,
            strategyName: job.strategyName,
            strategyParams: job.strategyParams,
            timeframe: job.timeframe,
            regime: job.regime,
            scope: TIMEFRAME_TO_SCOPE[job.timeframe],
            winRate: 0,
            profit: 0,
            trades: 0,
            maxDrawdown: 0,
            profitFactor: 0,
            sharpeRatio: 0,
            sortinoRatio: 0,
            avgHoldBars: 0,
            id: nextId(),
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: errMsg,
            dataSource: 'live',
          });
        }
      }
      engineState.results = [...results];
      engineState.progress = total ? Math.round((results.length / total) * 100) : 100;
      engineState.currentPhase = signal?.aborted ? 'Cancelled' : `Processed ${results.length}/${total}`;
      onProgress?.(getBacktestState());

      if (signal?.aborted) {
        engineState.status = 'cancelled';
        engineState.currentPhase = 'Cancelled';
        onProgress?.(getBacktestState());
        resolve(results);
        return;
      }
      if (results.length < total) {
        setTimeout(() => void runChunk(end), 0);
      } else {
        engineState = {
          ...engineState,
          status: 'completed',
          profitByScope: computeProfitByScope(results),
        };
        onProgress?.(getBacktestState());
        resolve(results);
      }
    };

    setTimeout(() => void runChunk(startIndex), 0);
  });
}

export function getBestResultsForInstrument(
  results: BacktestResultRow[],
  instrumentId: string,
  limit: number = 10
): BacktestResultRow[] {
  return results
    .filter((r) => r.instrumentId === instrumentId && r.status === 'completed')
    .sort((a, b) => b.profit - a.profit)
    .slice(0, limit);
}

export function getBestStrategiesByRegime(
  results: BacktestResultRow[],
  regime: MarketRegime,
  limit: number = 5
): BacktestResultRow[] {
  return results
    .filter((r) => r.regime === regime && r.status === 'completed')
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, limit);
}

/** Minimum backtest result rows (for this instrument) required for NN build; avoids underfitting. */
export const MIN_TRAINING_ROWS_FOR_BUILD = 5;

/** Fraction of time-ordered data used for training; rest is out-of-sample validation (e.g. 0.8 = 80% train). */
export const OOS_TRAIN_FRACTION = 0.8;

/**
 * Walk-forward split: sort by dataEndTime and split into train (first 80%) and validation (last 20%).
 * Strategy selection and NN training must use only train; validation is for monitoring generalization.
 */
export function splitBacktestResultsForOOS(
  results: BacktestResultRow[],
  trainFraction: number = OOS_TRAIN_FRACTION
): { train: BacktestResultRow[]; validation: BacktestResultRow[] } {
  const withTime = results
    .filter((r) => r.status === 'completed' && (r.dataEndTime ?? r.completedAt))
    .map((r) => ({ ...r, _sortTime: r.dataEndTime ?? r.completedAt ?? '' }));
  withTime.sort((a, b) => (a._sortTime < b._sortTime ? -1 : a._sortTime > b._sortTime ? 1 : 0));
  const idx = Math.max(1, Math.floor(withTime.length * trainFraction));
  const train = withTime.slice(0, idx).map(({ _sortTime, ...r }) => r);
  const validation = withTime.slice(idx).map(({ _sortTime, ...r }) => r);
  return { train, validation };
}

const MIN_TRADES_FOR_CONFIG = 1;

function robustScore(r: BacktestResultRow): number {
  const profit = r.profit ?? 0;
  const pf = r.profitFactor ?? 1;
  const sharpe = r.sharpeRatio ?? 0;
  const trades = r.trades ?? 0;
  if (trades < MIN_TRADES_FOR_CONFIG) return -1e9;
  const dd = r.maxDrawdown ?? 0;
  const ddPenalty = dd > 0 ? 1 - Math.min(0.5, dd) : 1;
  return profit * Math.max(0.1, pf) * (1 + 0.1 * sharpe) * ddPenalty;
}

/**
 * Filter to best backtest results for NN training: profitable or risk-adjusted configs.
 * - Requires minimum trades for reliability.
 * - Ranks by robust score (profit × profitFactor × Sharpe) when available.
 * Call with TRAIN slice only (from splitBacktestResultsForOOS) to avoid leakage.
 */
export function getBestResultsForBuild(results: BacktestResultRow[]): BacktestResultRow[] {
  const completed = results.filter((r) => r.status === 'completed');
  if (completed.length === 0) return [];
  const pfValid = (pf: number | undefined) => pf != null && Number.isFinite(pf) && pf > 0;
  const withMinTrades = completed.filter((r) => (r.trades ?? 0) >= MIN_TRADES_FOR_CONFIG);
  const best = withMinTrades.filter((r) => {
    const pf = r.profitFactor;
    if (pfValid(pf) && pf >= 1) return true;
    if (!pfValid(pf) && (r.profit ?? 0) >= 0) return true;
    return false;
  });
  if (best.length >= Math.max(20, completed.length * 0.5)) return best;
  const byScore = [...withMinTrades].sort((a, b) => robustScore(b) - robustScore(a));
  const keepCount = Math.max(best.length, Math.ceil(byScore.length * 0.75));
  return byScore.slice(0, keepCount);
}
