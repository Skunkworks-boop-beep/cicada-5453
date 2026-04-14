/**
 * Portfolio state: balance, positions with full risk fields (stop, target, riskAmount),
 * peak equity, drawdown, and risk-limit checks. Production-ready.
 *
 * Balance/equity are only set from:
 * - Live broker responses: MT5 (postMt5Connect / applyMt5LoginSuccess) or Deriv (getBalance after authorize).
 * - Persisted cache: last known values from a previous live session (hydratePortfolio on load).
 * No mock or synthetic balance data is used.
 *
 * Opening positions: use addPositionWithRiskCheck so validateNewPosition, position sizing, and Kelly run.
 */

import type { PortfolioState, Position, PositionSide, TradeStyle, TradeScope, RiskLimits, PortfolioDataSource, BotConfig, InstrumentType } from './types';
import { tryOpenPosition, type TryOpenPositionResult } from './risk';
import { getWarmupScaleFactor } from './bot';

/** Default risk distance as fraction of entry when no stop loss is set. Aligns with defaultStopLossPct (2%). */
const DEFAULT_RISK_DIST_PCT = 0.02;

function position(
  id: string,
  instrumentId: string,
  instrument: string,
  type: PositionSide,
  size: number,
  entryPrice: number,
  currentPrice: number,
  style: TradeStyle,
  scope: TradeScope,
  botId: string,
  stopLoss?: number,
  takeProfit?: number
): Position {
  const pnl = type === 'LONG' ? (currentPrice - entryPrice) * size : (entryPrice - currentPrice) * size;
  const pnlPercent = entryPrice && size && Number.isFinite(entryPrice * size)
    ? (pnl / (entryPrice * size)) * 100
    : 0;
  const riskDist = stopLoss != null
    ? Math.abs(entryPrice - stopLoss)
    : (entryPrice && Number.isFinite(entryPrice) ? entryPrice * DEFAULT_RISK_DIST_PCT : 0);
  const riskAmount = riskDist * size;
  return {
    id,
    instrumentId,
    instrument,
    type,
    size,
    entryPrice,
    currentPrice,
    pnl,
    pnlPercent,
    scope,
    style,
    botId,
    openedAt: new Date().toISOString(),
    stopLoss,
    takeProfit,
    riskAmount,
  };
}

/** When set, MT5 (or broker) provided equity; use for display when dataSource is mt5. */
let serverEquity: number | null = null;

let portfolioState: PortfolioState = {
  balance: 0,
  equity: 0,
  peakEquity: 0,
  drawdownPct: 0,
  positions: [],
  totalPnl: 0,
  totalPnlPercent: 0,
  dataSource: 'none',
};

function recalcTotals(positions: Position[], balance: number): {
  totalPnl: number;
  totalPnlPercent: number;
  equity: number;
  peakEquity: number;
  drawdownPct: number;
} {
  const totalPnl = positions.reduce((s, p) => s + p.pnl, 0);
  const equity = balance + totalPnl;
  let { peakEquity } = portfolioState;
  if (equity > peakEquity && (balance > 0 || positions.length > 0)) peakEquity = equity;
  const drawdownPct = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
  const totalPnlPercent = balance > 0 ? (totalPnl / balance) * 100 : 0;
  return { totalPnl, totalPnlPercent, equity, peakEquity, drawdownPct };
}

export function getPortfolioState(): PortfolioState {
  const { totalPnl, totalPnlPercent, equity: computedEquity, peakEquity, drawdownPct } = recalcTotals(
    portfolioState.positions,
    portfolioState.balance
  );
  const equity =
    portfolioState.dataSource === 'mt5' &&
    serverEquity != null &&
    Number.isFinite(serverEquity)
      ? serverEquity
      : computedEquity;
  return {
    ...portfolioState,
    totalPnl,
    totalPnlPercent,
    equity,
    peakEquity,
    drawdownPct,
    dataSource: portfolioState.dataSource,
  };
}

export function updatePositionPrices(
  updater: (position: Position) => { currentPrice: number; pnl: number; pnlPercent: number }
): void {
  portfolioState.positions = portfolioState.positions.map((p) => {
    const up = updater(p);
    return { ...p, currentPrice: up.currentPrice, pnl: up.pnl, pnlPercent: up.pnlPercent };
  });
}

/** Compute P/L for a position given current price (mark-to-market: LONG uses bid to close, SHORT uses ask). */
export function positionPnl(
  type: Position['type'],
  size: number,
  entryPrice: number,
  currentPrice: number
): { pnl: number; pnlPercent: number } {
  const pnl = type === 'LONG' ? (currentPrice - entryPrice) * size : (entryPrice - currentPrice) * size;
  const pnlPercent = entryPrice && size ? (pnl / (entryPrice * size)) * 100 : 0;
  return { pnl, pnlPercent };
}

/** Update prices, then close any position that hit stop or target. Optional onBeforeClose is called per position before removal (e.g. for drift recording). */
export function tickAndEvaluateStops(
  priceUpdater: (position: Position) => { currentPrice: number; pnl: number; pnlPercent: number },
  options?: { onBeforeClose?: (position: Position, exitPrice: number) => void }
): void {
  updatePositionPrices(priceUpdater);
  const toClose = evaluateStopsAndTargets(portfolioState.positions);
  for (const { id, exitPrice } of toClose) {
    const position = portfolioState.positions.find((p) => p.id === id);
    if (position && options?.onBeforeClose) options.onBeforeClose(position, exitPrice);
    removePosition(id);
  }
}

/** Result of evaluating a position for stop/target: id and the exit price (TP/SL level hit). */
export interface PositionCloseResult {
  id: string;
  /** Exit price: stopLoss when SL hit, takeProfit when TP hit — the level at which the trade was closed. */
  exitPrice: number;
}

/** Check stop-loss and take-profit; return list of position ids and exit prices that should be closed.
 * Exit = stopLoss when SL hit, takeProfit when TP hit. Never entry — reflects how the trade was closed. */
export function evaluateStopsAndTargets(positions: Position[]): PositionCloseResult[] {
  const toClose: PositionCloseResult[] = [];
  for (const p of positions) {
    if (p.type === 'LONG') {
      if (p.stopLoss != null && p.currentPrice <= p.stopLoss) {
        toClose.push({ id: p.id, exitPrice: p.stopLoss });
      } else if (p.takeProfit != null && p.currentPrice >= p.takeProfit) {
        toClose.push({ id: p.id, exitPrice: p.takeProfit });
      }
    } else {
      if (p.stopLoss != null && p.currentPrice >= p.stopLoss) {
        toClose.push({ id: p.id, exitPrice: p.stopLoss });
      } else if (p.takeProfit != null && p.currentPrice <= p.takeProfit) {
        toClose.push({ id: p.id, exitPrice: p.takeProfit });
      }
    }
  }
  return toClose;
}

export function addPosition(pos: Omit<Position, 'id'>, options?: { id?: string }): void {
  const id = options?.id ?? `pos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const riskAmount = pos.stopLoss != null ? Math.abs(pos.entryPrice - pos.stopLoss) * pos.size : pos.entryPrice * pos.size * 0.02;
  const openedAt = pos.openedAt ?? new Date().toISOString();
  portfolioState.positions = [...portfolioState.positions, { ...pos, id, riskAmount, openedAt }];
}

/**
 * Open a position only if risk checks pass. Runs validateNewPosition, position sizing, Kelly cap, warmup.
 * Use this for any execution path that opens a trade; do not call addPosition directly for bot-driven trades.
 */
export function addPositionWithRiskCheck(
  params: {
    instrumentId: string;
    instrument: string;
    type: PositionSide;
    entryPrice: number;
    currentPrice: number;
    stopLossPrice: number;
    scope: TradeScope;
    style: TradeStyle;
    botId: string;
    bot: BotConfig;
    instrumentType: InstrumentType;
  },
  options?: {
    winRate?: number;
    avgWinLossRatio?: number;
    pipValuePerUnit?: number;
    volatilityPct?: number;
    regime?: string;
  }
): TryOpenPositionResult & { added: boolean } {
  const portfolio = getPortfolioState();
  const result = tryOpenPosition(
    portfolio,
    params.bot.riskParams,
    params.instrumentId,
    params.instrumentType,
    params.entryPrice,
    params.stopLossPrice,
    params.type,
    portfolio.positions,
    {
      pipValuePerUnit: options?.pipValuePerUnit ?? 1,
      winRate: options?.winRate,
      avgWinLossRatio: options?.avgWinLossRatio,
      warmupScale: getWarmupScaleFactor(params.bot),
      scope: params.scope,
      utcHour: new Date().getUTCHours(),
      volatilityPct: options?.volatilityPct,
      regime: options?.regime,
      botId: params.botId,
      maxPositionsPerBot: params.bot.maxPositions,
    }
  );
  if (
    !result.allowed ||
    result.size == null ||
    result.size <= 0 ||
    !Number.isFinite(result.size)
  ) {
    return { ...result, added: false };
  }
  addPosition({
    instrumentId: params.instrumentId,
    instrument: params.instrument,
    type: params.type,
    size: result.size,
    entryPrice: params.entryPrice,
    currentPrice: params.currentPrice,
    pnl: 0,
    pnlPercent: 0,
    scope: params.scope,
    style: params.style,
    botId: params.botId,
    stopLoss: result.stopLoss,
    takeProfit: result.takeProfit,
    riskAmount: result.riskAmount ?? (
      params.stopLossPrice != null && Number.isFinite(params.entryPrice) && Number.isFinite(params.stopLossPrice)
        ? result.size * Math.abs(params.entryPrice - params.stopLossPrice)
        : 0
    ),
  });
  return { ...result, added: true };
}

export function removePosition(positionId: string): void {
  portfolioState.positions = portfolioState.positions.filter((p) => p.id !== positionId);
}

export function setBalance(balance: number, source: PortfolioDataSource = 'mt5'): void {
  portfolioState.balance = balance;
  portfolioState.dataSource = source;
  if (source === 'none') {
    serverEquity = null;
    portfolioState.positions = [];
    portfolioState.peakEquity = 0;
  } else {
    portfolioState.peakEquity = balance > (portfolioState.peakEquity ?? 0) ? balance : (portfolioState.peakEquity ?? balance);
  }
}

/** Set equity from broker (e.g. MT5 account.equity). Used for display when available. */
export function setServerEquity(equity: number | null): void {
  serverEquity = equity != null && Number.isFinite(equity) ? equity : null;
}

/** Hydrate portfolio from persisted state (e.g. on load). Only restores if we had a real source. */
export function hydratePortfolio(balance: number, peakEquity: number, positions: Position[], dataSource: PortfolioDataSource = 'none'): void {
  portfolioState.balance = balance;
  portfolioState.peakEquity = peakEquity;
  portfolioState.positions = [...positions];
  portfolioState.dataSource = dataSource;
}

/** Replace open positions (e.g. after syncing from broker). Keeps balance and dataSource unchanged. */
export function setPositions(positions: Position[]): void {
  portfolioState.positions = [...positions];
}

export function setPeakEquity(peak: number): void {
  portfolioState.peakEquity = peak;
}

/** Check global risk limits; returns true if within limits. */
export function checkRiskLimits(limits: RiskLimits): { ok: boolean; violations: string[] } {
  const state = getPortfolioState();
  const violations: string[] = [];
  if (state.equity > 0 && state.drawdownPct >= limits.maxDrawdownPct) {
    violations.push(`Drawdown ${(state.drawdownPct * 100).toFixed(1)}% exceeds max ${(limits.maxDrawdownPct * 100).toFixed(0)}%`);
  }
  const totalExposure = state.positions.reduce((s, p) => s + p.size * p.currentPrice, 0);
  const exposurePct = state.equity > 0 ? totalExposure / state.equity : 0;
  if (exposurePct > limits.maxTotalExposurePct) {
    violations.push(`Total exposure ${(exposurePct * 100).toFixed(1)}% exceeds max ${(limits.maxTotalExposurePct * 100).toFixed(0)}%`);
  }
  const byInstrument = new Map<string, number>();
  for (const p of state.positions) {
    byInstrument.set(p.instrumentId, (byInstrument.get(p.instrumentId) ?? 0) + 1);
  }
  for (const [inst, count] of byInstrument) {
    if (count > limits.maxPositionsPerInstrument) {
      violations.push(`Instrument ${inst} has ${count} positions (max ${limits.maxPositionsPerInstrument})`);
    }
  }
  return { ok: violations.length === 0, violations };
}
