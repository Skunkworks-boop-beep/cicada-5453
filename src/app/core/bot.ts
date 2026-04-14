/**
 * Neural network bot: per-instrument config with full risk params and allowed scopes.
 * Build status, deploy, and global execution enable/disable.
 */

import type {
  BotConfig,
  BotExecutionState,
  BotRiskParams,
  Timeframe,
  TradeStyle,
  TradeScope,
  MarketRegime,
  Instrument,
} from './types';
import { getAllStrategies } from './registries';
import { ALL_TRADE_STYLES } from './scope';

import { DEFAULT_REBUILD_HOURS } from './rebuildInterval';
/** When drift is detected, schedule rebuild this many hours from now (early retrain). */
export const DRIFT_EARLY_REBUILD_HOURS = 2;
/** Cold start: scale position size by this factor for the first WARMUP_HOURS after deploy. */
export const WARMUP_HOURS = 48;
export const WARMUP_SIZE_SCALE = 0.25;

export const DEFAULT_RISK_PARAMS: BotRiskParams = {
  riskPerTradePct: 0.01,
  maxDrawdownPct: 0.15,
  useKelly: false,
  kellyFraction: 0.25,
  maxCorrelatedExposure: 1.5,
  defaultStopLossPct: 0.02,
  defaultRiskRewardRatio: 2,
};

function riskParamsFromLevel(level: number): BotRiskParams {
  const scale = 0.5 + (level - 1) * 0.15;
  return {
    riskPerTradePct: Math.min(0.02, 0.005 * scale),
    maxDrawdownPct: Math.max(0.08, 0.25 - level * 0.03),
    useKelly: level >= 4,
    kellyFraction: 0.25,
    maxCorrelatedExposure: Math.max(1, 2 - level * 0.2),
    defaultStopLossPct: Math.max(0.01, 0.03 - level * 0.003),
    defaultRiskRewardRatio: Math.max(1.5, 2.5 - level * 0.1),
  };
}

export function createBotForInstrument(
  instrument: Instrument,
  options: {
    name?: string;
    timeframes?: Timeframe[];
    styles?: TradeStyle[];
    allowedScopes?: TradeScope[];
    regimes?: MarketRegime[];
    strategyIds?: string[];
    riskLevel?: number;
    maxPositions?: number;
    riskParams?: Partial<BotRiskParams>;
    scopeSelectorConfig?: Partial<BotScopeSelectorConfig>;
  } = {}
): BotConfig {
  const strategies = getAllStrategies();
  const defaultStrategyIds = strategies.filter((s) => s.enabled).map((s) => s.id);
  const nextRebuild = new Date();
  nextRebuild.setHours(nextRebuild.getHours() + DEFAULT_REBUILD_HOURS);
  const riskLevel = options.riskLevel ?? 2;
  const baseRisk = riskParamsFromLevel(riskLevel);

  return {
    id: `bot-${instrument.id}-${Date.now()}`,
    name: options.name ?? `CICADA_${instrument.symbol.replace(/\//g, '_')}`,
    instrumentId: instrument.id,
    instrumentSymbol: instrument.symbol,
    timeframes: options.timeframes ?? instrument.timeframes.slice(0, 3),
    styles: options.styles ?? [...ALL_TRADE_STYLES],
    allowedScopes: options.allowedScopes ?? ['scalp', 'day', 'swing'],
    scopeMode: options.scopeMode ?? 'auto',
    fixedScope: options.fixedScope,
    regimes: options.regimes ?? ['trending_bull', 'trending_bear', 'ranging', 'reversal_bull', 'reversal_bear', 'unknown'],
    strategyIds: options.strategyIds ?? defaultStrategyIds,
    riskLevel,
    maxPositions: options.maxPositions ?? 5,
    riskParams: { ...baseRisk, ...options.riskParams },
    status: 'outdated',
    buildProgress: 0,
    nextRebuildAt: nextRebuild.toISOString(),
  };
}

export function setBotStatus(
  bot: BotConfig,
  status: BotConfig['status'],
  buildProgress?: number
): BotConfig {
  return {
    ...bot,
    status,
    buildProgress: buildProgress ?? (status === 'building' ? 0 : bot.buildProgress),
    ...(status === 'ready' && { buildProgress: 100 }),
  };
}

export function setBotBuildProgress(bot: BotConfig, progress: number): BotConfig {
  const next = Math.min(100, Math.max(0, progress));
  return {
    ...bot,
    buildProgress: next,
    status: next >= 100 ? 'ready' : 'building',
  };
}

export function scheduleNextRebuild(bot: BotConfig, instrument: Instrument): BotConfig {
  const hours = instrument.rebuildIntervalHours ?? DEFAULT_REBUILD_HOURS;
  const next = new Date();
  next.setHours(next.getHours() + hours);
  return {
    ...bot,
    nextRebuildAt: next.toISOString(),
    status: 'outdated',
    driftDetectedAt: undefined,
    forceRebuildReason: undefined,
  };
}

/** Mark drift detected so an early rebuild is scheduled. Call when live predictions/outcomes diverge from backtest. */
export function setDriftDetected(bot: BotConfig, reason?: string): BotConfig {
  const next = new Date();
  next.setHours(next.getHours() + DRIFT_EARLY_REBUILD_HOURS);
  return {
    ...bot,
    driftDetectedAt: new Date().toISOString(),
    forceRebuildReason: reason ?? 'Live performance diverging from backtest',
    nextRebuildAt: next.toISOString(),
  };
}

export function clearDriftDetected(bot: BotConfig): BotConfig {
  return {
    ...bot,
    driftDetectedAt: undefined,
    forceRebuildReason: undefined,
  };
}

/** Cold start: return position size scale factor (0.25 during warmup, 1.0 after). Use when sizing new positions. */
export function getWarmupScaleFactor(bot: BotConfig): number {
  if (!bot.deployedAt) return 1;
  const deployed = new Date(bot.deployedAt).getTime();
  const elapsed = (Date.now() - deployed) / (1000 * 60 * 60);
  return elapsed < WARMUP_HOURS ? WARMUP_SIZE_SCALE : 1;
}

export const DEFAULT_EXECUTION_STATE: BotExecutionState = {
  enabled: false,
  updatedAt: new Date().toISOString(),
};

export function createExecutionState(enabled: boolean): BotExecutionState {
  return { enabled, updatedAt: new Date().toISOString() };
}
