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
 * Currency-aware buckets for forex pairs: EUR/USD and GBP/USD share USD
 * exposure, so a flat "forex" bucket under-counts correlated risk. We
 * decompose each pair into its base/quote symbols so sizing can penalise
 * already-exposed currencies.
 */
const QUOTE_CURRENCY_PATTERNS: Array<[RegExp, [string, string]]> = [
  [/^([A-Z]{3})\/([A-Z]{3})$/, ['$1', '$2']],
];

/** Return [base, quote] legs for a forex pair; null for non-forex instruments. */
export function decomposeCurrencyLegs(
  symbol: string,
  type: InstrumentType
): { base: string; quote: string } | null {
  if (type !== 'fiat') return null;
  const s = symbol.toUpperCase();
  for (const [re, [b, q]] of QUOTE_CURRENCY_PATTERNS) {
    const m = s.match(re);
    if (m) {
      return {
        base: b === '$1' ? m[1] : b,
        quote: q === '$2' ? m[2] : q,
      };
    }
  }
  // Fallback for 6-char symbols without slash (e.g. EURUSD)
  if (/^[A-Z]{6}$/.test(s)) {
    return { base: s.slice(0, 3), quote: s.slice(3, 6) };
  }
  return null;
}

/** Exposure to each currency leg implied by currently-open positions. */
export function computeCurrencyExposure(
  positions: Position[],
  instrumentTypes: Record<string, InstrumentType>
): Record<string, number> {
  const exposure: Record<string, number> = {};
  for (const p of positions) {
    const symbol = p.instrument ?? p.instrumentId;
    const type = instrumentTypes[p.instrumentId] ?? 'fiat';
    const legs = decomposeCurrencyLegs(symbol, type);
    const sign = p.type === 'LONG' ? 1 : -1;
    const notional = p.size * p.currentPrice;
    if (!legs) {
      exposure[symbol.toUpperCase()] = (exposure[symbol.toUpperCase()] ?? 0) + sign * notional;
      continue;
    }
    // LONG EUR/USD = long EUR, short USD. We measure absolute currency risk.
    exposure[legs.base] = (exposure[legs.base] ?? 0) + sign * notional;
    exposure[legs.quote] = (exposure[legs.quote] ?? 0) - sign * notional;
  }
  return exposure;
}

/**
 * Correlation-aware sizing penalty: when the proposed trade would further
 * increase exposure to a currency that is already carrying a large net
 * position, reduce the size. Returns a scale in (0, 1].
 *
 * The penalty kicks in when the ratio of existing currency-leg exposure to
 * portfolio equity exceeds ``threshold`` (default 0.5 × equity). Above the
 * threshold it linearly decays to ``minScale`` at the cap (default 1.5 × equity).
 */
export function correlationScale(
  equity: number,
  positions: Position[],
  instrumentTypes: Record<string, InstrumentType>,
  targetSymbol: string,
  targetType: InstrumentType,
  side: PositionSide,
  options?: { threshold?: number; cap?: number; minScale?: number }
): number {
  if (equity <= 0 || positions.length === 0) return 1;
  const legs = decomposeCurrencyLegs(targetSymbol, targetType);
  if (!legs) return 1;
  const exposure = computeCurrencyExposure(positions, instrumentTypes);
  const sign = side === 'LONG' ? 1 : -1;
  const baseAbs = Math.abs((exposure[legs.base] ?? 0) + sign * 1) / equity;
  const quoteAbs = Math.abs((exposure[legs.quote] ?? 0) - sign * 1) / equity;
  const worst = Math.max(baseAbs, quoteAbs);
  const threshold = options?.threshold ?? 0.5;
  const cap = options?.cap ?? 1.5;
  const minScale = options?.minScale ?? 0.3;
  if (worst <= threshold) return 1;
  if (worst >= cap) return minScale;
  const t = (worst - threshold) / (cap - threshold);
  return 1 - (1 - minScale) * t;
}

/**
 * Volatility-targeting scalar: size so that (size × entry × ATR%) tracks
 * ``target_daily_vol_pct`` of equity. Returns a multiplier that, applied to
 * the risk-% derived size, brings the position's expected daily move in line
 * with the target.
 *
 * Keeps the multiplier clamped so extreme ATR% values do not balloon the
 * position. Zero / invalid ATR returns 1 (no-op).
 */
export function volatilityTargetScale(
  equity: number,
  atrPct: number | undefined,
  price: number,
  sizeRaw: number,
  targetDailyVolPct: number = 0.01
): number {
  if (!Number.isFinite(atrPct) || (atrPct ?? 0) <= 0) return 1;
  if (price <= 0 || equity <= 0 || sizeRaw <= 0) return 1;
  const expectedDailyMove = sizeRaw * price * (atrPct as number);
  const targetMove = equity * targetDailyVolPct;
  if (expectedDailyMove <= 0) return 1;
  const ratio = targetMove / expectedDailyMove;
  return Math.max(0.25, Math.min(2.5, ratio));
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
    /** Target daily portfolio volatility (fraction of equity). Enables vol-targeting. */
    targetDailyVolPct?: number;
    /** Symbol (e.g. EUR/USD) for currency-leg decomposition. */
    instrumentSymbol?: string;
    /** Map of instrument id -> type for currency exposure aggregation. */
    instrumentTypes?: Record<string, InstrumentType>;
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

  /**
   * Portfolio-level volatility targeting. When the caller supplies a target
   * daily σ and ATR%, we rescale so the expected daily move matches target.
   * Caps prevent over-aggressive sizing when ATR is tiny.
   */
  const volTargetScale = options?.targetDailyVolPct
    ? volatilityTargetScale(
        portfolio.equity,
        options.volatilityPct,
        entryPrice,
        size,
        options.targetDailyVolPct
      )
    : 1;

  /**
   * Correlation-aware penalty: if this trade would pile further exposure onto
   * a currency leg that the portfolio is already loaded with, reduce the
   * size. EUR/USD and GBP/USD share USD; this bucket was previously flat.
   */
  const corrScale = options?.instrumentSymbol && options?.instrumentTypes
    ? correlationScale(
        portfolio.equity,
        existingPositions,
        options.instrumentTypes,
        options.instrumentSymbol,
        instrumentType,
        side
      )
    : 1;

  size = size * warmup * sizeMult * volScale * volTargetScale * corrScale;
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
