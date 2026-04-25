/**
 * Portfolio-level Kelly allocation across bots.
 *
 * Single-bot Kelly sizes each trade based on that bot's own win rate and
 * expected reward/risk, with a fraction cap (quarter Kelly by default). That
 * works for one bot in isolation, but CICADA-5453 runs many bots across
 * correlated instruments — the aggregate risk can exceed the safe envelope
 * even when each bot is individually well sized.
 *
 * This module computes per-bot fractional-Kelly weights that sum to at most
 * the configured total budget, using each bot's live or backtest edge plus a
 * cross-bot correlation penalty derived from their closed-trade P&L series.
 * The algorithm:
 *
 *   1. Per bot: estimate f* = (p·b − q) / b  from win rate and avg win/loss.
 *   2. Scale each f* by a cross-bot correlation penalty: bots whose PnL series
 *      covary strongly are treated as a single "effective bot" so their
 *      combined allocation cannot exceed one bot's worth of Kelly risk.
 *   3. Apply a global cap (``totalBudgetPct``) so the aggregate risk stays
 *      bounded even when every bot is simultaneously confident.
 *
 * Output is a map of ``botId -> fraction of equity``; callers multiply it into
 * the bot's per-trade risk % to get the final position risk.
 */

import type { BotConfig, ClosedTrade } from './types';
import { kellyFraction } from './risk';

const EPS = 1e-9;
const MIN_TRADES_FOR_LIVE_EDGE = 10;
const FALLBACK_KELLY_FRACTION = 0.25;

export interface BotEdgeEstimate {
  botId: string;
  winRate: number;       // in [0,1]
  avgWinLossRatio: number;  // reward/risk
  /** Number of closed trades informing this estimate. */
  sampleSize: number;
}

/** Estimate each bot's win rate and avg win/loss from recent closed trades. */
export function estimateBotEdges(
  bots: BotConfig[],
  closedTradesByBot: Record<string, ClosedTrade[]>
): BotEdgeEstimate[] {
  return bots.map((bot) => {
    const trades = closedTradesByBot[bot.id] ?? [];
    if (trades.length < MIN_TRADES_FOR_LIVE_EDGE) {
      // Fall back to the bot's risk params: conservative default. Quarter
      // Kelly for all bots under the minimum sample threshold.
      return {
        botId: bot.id,
        winRate: 0.5,
        avgWinLossRatio: bot.riskParams.defaultRiskRewardRatio || 1,
        sampleSize: trades.length,
      };
    }
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl < 0);
    const winRate = wins.length / trades.length;
    const avgWin = wins.length > 0
      ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length
      : 0;
    const avgLoss = losses.length > 0
      ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length)
      : 0;
    const avgWinLossRatio = avgLoss > EPS ? avgWin / avgLoss : avgWin > 0 ? 3 : 1;
    return { botId: bot.id, winRate, avgWinLossRatio, sampleSize: trades.length };
  });
}

/** Pearson correlation of two equal-length trade P&L series. */
function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 4) return 0;
  const ax = a.slice(-n);
  const bx = b.slice(-n);
  const meanA = ax.reduce((s, v) => s + v, 0) / n;
  const meanB = bx.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denomA = 0;
  let denomB = 0;
  for (let i = 0; i < n; i++) {
    const da = ax[i] - meanA;
    const db = bx[i] - meanB;
    num += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  const denom = Math.sqrt(denomA * denomB);
  return denom > EPS ? num / denom : 0;
}

/**
 * Build a correlation matrix across bots. Uses aligned P&L series (last N
 * closed trades per bot). Missing bots are assumed uncorrelated.
 */
export function botCorrelationMatrix(
  botIds: string[],
  closedTradesByBot: Record<string, ClosedTrade[]>,
  window: number = 40
): number[][] {
  const series = botIds.map((id) => {
    const trades = closedTradesByBot[id] ?? [];
    return trades.slice(-window).map((t) => t.pnl);
  });
  const n = botIds.length;
  const mat: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    mat[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const rho = correlation(series[i], series[j]);
      const clamped = Math.max(-1, Math.min(1, rho));
      mat[i][j] = clamped;
      mat[j][i] = clamped;
    }
  }
  return mat;
}

export interface PortfolioAllocationOptions {
  /** Total aggregate Kelly budget across the portfolio (fraction of equity). */
  totalBudgetPct?: number;
  /** Kelly fraction cap applied *before* correlation netting. */
  kellyFractionCap?: number;
  /** Floor per-bot allocation at this fraction so tiny edges still trade. */
  minBotPct?: number;
}

/**
 * Compute per-bot Kelly fractions that account for bot-to-bot correlation and
 * a global aggregate cap. Returns ``{ botId: fraction }`` where fraction is
 * the proportion of equity this bot may risk *per trade* (before that bot's
 * own risk % is applied).
 *
 * Maths sketch:
 *   f_i = min(kellyCap, f*_i)          — single-bot Kelly
 *   eff_i = f_i / (1 + Σ_{j≠i} |ρ_ij| · (f_j / f_i))   — correlation penalty
 *   Σ eff_i ≤ totalBudgetPct           — scale down if aggregate exceeds cap
 *
 * The correlation penalty is a first-order approximation of the variance
 * inflation a correlated portfolio would suffer; it is intentionally simple
 * because full mean-variance optimisation needs a stable covariance estimate
 * that our closed-trade samples rarely provide.
 */
export function portfolioKellyFractions(
  bots: BotConfig[],
  closedTradesByBot: Record<string, ClosedTrade[]>,
  options?: PortfolioAllocationOptions
): Record<string, number> {
  const budget = options?.totalBudgetPct ?? 0.1;
  const cap = options?.kellyFractionCap ?? FALLBACK_KELLY_FRACTION;
  const floor = options?.minBotPct ?? 0.0025;
  if (bots.length === 0) return {};

  const edges = estimateBotEdges(bots, closedTradesByBot);
  const singleBotF = edges.map((e) => {
    const f = kellyFraction(e.winRate, e.avgWinLossRatio);
    return Math.min(cap, f);
  });

  const ids = edges.map((e) => e.botId);
  const mat = botCorrelationMatrix(ids, closedTradesByBot);

  // Correlation-penalised fractions.
  const penalised: number[] = ids.map((_id, i) => {
    const fi = singleBotF[i];
    if (fi <= 0) return 0;
    let inflator = 0;
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      const fj = singleBotF[j];
      if (fj <= 0) continue;
      const rho = Math.abs(mat[i][j]);
      inflator += rho * (fj / fi);
    }
    return fi / (1 + inflator);
  });

  // Apply floor then global cap.
  const floored = penalised.map((f, i) => (singleBotF[i] > 0 ? Math.max(floor, f) : 0));
  const total = floored.reduce((s, f) => s + f, 0);
  const scale = total > budget ? budget / total : 1;
  const final = floored.map((f) => f * scale);

  const out: Record<string, number> = {};
  ids.forEach((id, i) => {
    out[id] = Number.isFinite(final[i]) ? final[i] : 0;
  });
  return out;
}
