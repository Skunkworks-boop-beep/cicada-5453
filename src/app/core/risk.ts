/**
 * Institutional-grade risk: Kelly sizing, position size from risk %, drawdown limits,
 * correlated exposure (by instrument type), and pre-trade validation.
 *
 * Cold start: when opening a position from a newly deployed bot, multiply the computed
 * position size by getWarmupScaleFactor(bot) from ../core/bot (0.25 for first 48h, then 1).
 */

import type { BotRiskParams, InstrumentType, Position, PositionSide, PortfolioState, TradeScope } from './types';
import { evaluateRiskLibrary } from './riskLibrary';

/** Default risk params (conservative). */
export const DEFAULT_RISK_PARAMS: BotRiskParams = {
  riskPerTradePct: 0.01,
  maxDrawdownPct: 0.15,
  useKelly: true,
  kellyFraction: 0.25,
  maxCorrelatedExposure: 1.5,
  defaultStopLossPct: 0.02,
  defaultRiskRewardRatio: 2,
};

/**
 * Kelly criterion: optimal fraction of bankroll to risk.
 * f* = (p*b - q) / b where p=winRate, q=1-p, b=avgWin/avgLoss (reward/risk).
 */
export function kellyFraction(winRate: number, avgWinLossRatio: number): number {
  if (winRate <= 0 || winRate >= 1 || avgWinLossRatio <= 0) return 0;
  const q = 1 - winRate;
  const b = avgWinLossRatio;
  const f = (winRate * b - q) / b;
  return Math.max(0, Math.min(1, f));
}

/**
 * Position size in units so that (entry - stopLoss) * size * pipValue = riskAmount.
 * riskAmount = equity * riskPerTradePct.
 */
export function positionSizeFromRisk(
  equity: number,
  riskPerTradePct: number,
  entryPrice: number,
  stopLossPrice: number,
  pipValuePerUnit: number
): number {
  const riskAmount = equity * riskPerTradePct;
  const riskPerUnit = Math.abs(entryPrice - stopLossPrice) * pipValuePerUnit;
  if (riskPerUnit <= 0) return 0;
  return riskAmount / riskPerUnit;
}

/**
 * Apply Kelly cap: size = min(fullSize, equity * kellyFraction * f* / riskPerUnit).
 */
export function applyKellyCap(
  size: number,
  equity: number,
  winRate: number,
  avgWinLossRatio: number,
  kellyFractionCap: number
): number {
  const fStar = kellyFraction(winRate, avgWinLossRatio);
  const maxKellySize = equity * kellyFractionCap * fStar;
  return Math.min(size, maxKellySize);
}

/** Bucket by instrument type for correlated exposure (forex vs crypto vs synthetic vs indices). */
export function getInstrumentBucket(type: InstrumentType): string {
  if (type === 'fiat') return 'forex';
  if (type === 'crypto') return 'crypto';
  if (type === 'synthetic_deriv') return 'synthetic';
  return 'indices'; // indices_exness: real stock index CFDs (AUS200, US30, etc.)
}

/**
 * Check if adding a new position would breach global or bot-level limits.
 * @param maxPositionsPerInstrument - From confidence (1–3). Default 1.
 */
export function validateNewPosition(
  portfolio: PortfolioState,
  botParams: BotRiskParams,
  instrumentId: string,
  instrumentType: InstrumentType,
  newPositionRiskAmount: number,
  existingPositions: Position[],
  maxPositionsPerInstrument: number = 1
): { allowed: boolean; reason?: string } {
  if (!Number.isFinite(portfolio.equity) || portfolio.equity <= 0) {
    return { allowed: false, reason: 'Invalid or zero equity' };
  }
  if (portfolio.drawdownPct >= botParams.maxDrawdownPct) {
    return { allowed: false, reason: 'Max drawdown reached' };
  }
  const sameInstrument = existingPositions.filter((p) => p.instrumentId === instrumentId).length;
  if (sameInstrument >= maxPositionsPerInstrument) {
    return { allowed: false, reason: `Max ${maxPositionsPerInstrument} position(s) per instrument` };
  }
  const totalRisk = existingPositions.reduce((s, p) => s + p.riskAmount, 0) + newPositionRiskAmount;
  if (totalRisk > portfolio.equity * botParams.maxCorrelatedExposure) {
    return { allowed: false, reason: 'Correlated exposure limit' };
  }
  return { allowed: true };
}

/**
 * Compute stop-loss and take-profit prices from risk params and entry.
 */
export function getStopLossTakeProfit(
  entryPrice: number,
  side: 'LONG' | 'SHORT',
  stopLossPct: number,
  riskRewardRatio: number
): { stopLoss: number; takeProfit: number } {
  const slDistance = entryPrice * stopLossPct;
  const tpDistance = slDistance * riskRewardRatio;
  if (side === 'LONG') {
    return {
      stopLoss: entryPrice - slDistance,
      takeProfit: entryPrice + tpDistance,
    };
  }
  return {
    stopLoss: entryPrice + slDistance,
    takeProfit: entryPrice - tpDistance,
  };
}

export interface TryOpenPositionResult {
  allowed: boolean;
  reason?: string;
  /** When disallowed by risk library: rule id that blocked. */
  ruleId?: string;
  /** When disallowed by risk library: rule name (human-readable). */
  ruleName?: string;
  size?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskAmount?: number;
}

/**
 * Single entry point for opening a position: validates risk limits, computes size (risk %, Kelly cap),
 * and returns approved size and levels. Call this before addPosition; only add if allowed.
 * Pip value per unit: 1 for forex (standard), or instrument-specific.
 */
export function tryOpenPosition(
  portfolio: PortfolioState,
  botParams: BotRiskParams,
  instrumentId: string,
  instrumentType: InstrumentType,
  entryPrice: number,
  stopLossPrice: number,
  side: PositionSide,
  existingPositions: Position[],
  options?: {
    pipValuePerUnit?: number;
    winRate?: number;
    avgWinLossRatio?: number;
    warmupScale?: number;
    scope?: TradeScope;
    utcHour?: number;
    volatilityPct?: number;
    regime?: string;
    botId?: string;
    maxPositionsPerBot?: number;
    maxPositionsPerInstrument?: number;
    /** NN size multiplier (0.5–2). Applied after base sizing. */
    sizeMultiplier?: number;
    /** NN risk-reward ratio for take-profit. Overrides botParams.defaultRiskRewardRatio. */
    tpR?: number;
  }
): TryOpenPositionResult {
  const pipValue = options?.pipValuePerUnit ?? 1;
  const riskAmount = portfolio.equity * botParams.riskPerTradePct;
  const riskPerUnit = Math.abs(entryPrice - stopLossPrice) * pipValue;
  let size = riskPerUnit > 0 ? riskAmount / riskPerUnit : 0;
  if (size <= 0) {
    return { allowed: false, reason: 'Invalid stop distance or zero risk per unit' };
  }
  if (botParams.useKelly && options?.winRate != null && options?.avgWinLossRatio != null) {
    size = applyKellyCap(
      size,
      portfolio.equity,
      options.winRate,
      options.avgWinLossRatio,
      botParams.kellyFraction
    );
  }
  const newRiskAmount = size * riskPerUnit;
  const maxPerInst = options?.maxPositionsPerInstrument ?? 1;
  const validation = validateNewPosition(
    portfolio,
    botParams,
    instrumentId,
    instrumentType,
    newRiskAmount,
    existingPositions,
    maxPerInst
  );
  if (!validation.allowed) {
    return { allowed: false, reason: validation.reason };
  }
  const scope = options?.scope ?? 'day';
  const libraryResult = evaluateRiskLibrary({
    portfolio,
    botParams,
    instrumentId,
    instrumentType,
    scope,
    newPositionRiskAmount: newRiskAmount,
    newPositionSize: size,
    entryPrice,
    stopLossPrice,
    side,
    existingPositions,
    utcHour: options?.utcHour ?? new Date().getUTCHours(),
    volatilityPct: options?.volatilityPct,
    regime: options?.regime,
    botId: options?.botId,
    maxPositionsPerBot: options?.maxPositionsPerBot,
    maxPositionsPerInstrument: options?.maxPositionsPerInstrument,
  });
  if (!libraryResult.allowed) {
    return {
      allowed: false,
      reason: libraryResult.reason,
      ruleId: libraryResult.ruleId,
      ruleName: libraryResult.ruleName,
    };
  }
  const slDist = Math.abs(entryPrice - stopLossPrice);
  const tpR = options?.tpR ?? botParams.defaultRiskRewardRatio;
  let takeProfit =
    side === 'LONG'
      ? entryPrice + slDist * tpR
      : entryPrice - slDist * tpR;
  /** Ensure exit level is never same as entry (avoids entry=exit bug) */
  const minDist = entryPrice * 0.0001;
  if (side === 'LONG' && takeProfit <= entryPrice + minDist) takeProfit = entryPrice + Math.max(minDist, slDist);
  if (side === 'SHORT' && takeProfit >= entryPrice - minDist) takeProfit = entryPrice - Math.max(minDist, slDist);
  const warmup = options?.warmupScale ?? 1;
  const sizeMult = options?.sizeMultiplier != null && options.sizeMultiplier > 0 ? options.sizeMultiplier : 1;
  /** Volatility scaling: reduce size when ATR% is high (>2%) to limit risk in volatile markets. */
  const volScale = (() => {
    const v = options?.volatilityPct;
    if (v == null || !Number.isFinite(v) || v <= 0.02) return 1;
    if (v >= 0.07) return 0.5;
    return Math.max(0.5, 1 - (v - 0.02) * 10);
  })();
  size = size * warmup * sizeMult * volScale;
  if (size <= 0 || !Number.isFinite(size)) {
    return { allowed: false, reason: 'Position size invalid or zero after sizing' };
  }
  return {
    allowed: true,
    size,
    stopLoss: stopLossPrice,
    takeProfit,
    riskAmount: size * riskPerUnit,
  };
}
