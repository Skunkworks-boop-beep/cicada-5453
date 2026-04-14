/**
 * Automatic drift detection: compare recent closed-trade stats (win rate, profit factor)
 * to backtest metrics and signal when live performance diverges for early rebuild.
 */

import type { BotConfig, BacktestResultRow, ClosedTrade } from './types';

/** Minimum closed trades before comparing (avoid noise). */
export const DRIFT_MIN_CLOSED_TRADES = 10;

/** Keep this many closed trades per bot for rolling stats. */
export const DRIFT_MAX_CLOSED_TRADES_PER_BOT = 50;

/** If live win rate is this much lower than backtest (e.g. 0.15 = 15 pp), trigger drift. */
export const DRIFT_WIN_RATE_THRESHOLD_PP = 0.15;

/** If live profit factor is below this and backtest was >= 1.2, trigger drift. */
export const DRIFT_PROFIT_FACTOR_MIN = 0.7;

/** When all trades are wins (grossLoss=0), profit factor is infinite; use this sentinel for comparisons. */
const PROFIT_FACTOR_ALL_WINS = 10;

/**
 * Aggregate backtest metrics for a bot (instrument + strategies): average win rate and profit factor
 * from completed rows that match the bot's instrument AND strategy set for like-for-like comparison.
 * Without strategy filter, drift would compare a bot using one strategy to backtests of all strategies.
 */
export function getBacktestMetricsForBot(
  bot: BotConfig,
  results: BacktestResultRow[]
): { winRate: number; profitFactor: number; sampleSize: number } {
  const botStrategyIds = new Set(Array.isArray(bot.strategyIds) ? bot.strategyIds : []);
  const completed = results.filter((r) => {
    if (r.status !== 'completed' || r.instrumentId !== bot.instrumentId) return false;
    if (botStrategyIds.size > 0 && !botStrategyIds.has(r.strategyId)) return false;
    return true;
  });
  if (completed.length === 0) {
    return { winRate: 0.5, profitFactor: 1, sampleSize: 0 };
  }
  const winRate =
    completed.reduce((s, r) => s + r.winRate, 0) / completed.length;
  const profitFactor =
    completed.reduce((s, r) => s + (r.profitFactor ?? 1), 0) / completed.length;
  return {
    winRate: winRate / 100,
    profitFactor,
    sampleSize: completed.length,
  };
}

/**
 * Compute live win rate and profit factor from closed trades.
 */
export function getLiveMetricsFromClosedTrades(
  closedTrades: ClosedTrade[]
): { winRate: number; profitFactor: number; sampleSize: number } {
  if (closedTrades.length === 0) {
    return { winRate: 0, profitFactor: 1, sampleSize: 0 };
  }
  const wins = closedTrades.filter((t) => t.pnl > 0).length;
  const winRate = wins / closedTrades.length;
  const grossProfit = closedTrades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(
    closedTrades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0)
  );
  // True computation: grossProfit/grossLoss. When all wins (grossLoss=0), ratio is infinite; use sentinel.
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? PROFIT_FACTOR_ALL_WINS : 1;
  return { winRate, profitFactor, sampleSize: closedTrades.length };
}

export interface DriftCheckResult {
  drift: boolean;
  reason?: string;
}

/**
 * Compare recent live closed-trade stats to backtest; return whether drift is detected.
 */
export function checkDrift(
  bot: BotConfig,
  backtestResults: BacktestResultRow[],
  closedTradesForBot: ClosedTrade[]
): DriftCheckResult {
  if (closedTradesForBot.length < DRIFT_MIN_CLOSED_TRADES) {
    return { drift: false };
  }
  const backtest = getBacktestMetricsForBot(bot, backtestResults);
  if (backtest.sampleSize === 0) {
    return { drift: false };
  }
  const live = getLiveMetricsFromClosedTrades(closedTradesForBot);

  const winRateDiff = backtest.winRate - live.winRate;
  if (winRateDiff >= DRIFT_WIN_RATE_THRESHOLD_PP) {
    return {
      drift: true,
      reason: `Live win rate ${(live.winRate * 100).toFixed(1)}% vs backtest ${(backtest.winRate * 100).toFixed(1)}%`,
    };
  }

  if (backtest.profitFactor >= 1.2 && live.profitFactor < DRIFT_PROFIT_FACTOR_MIN) {
    return {
      drift: true,
      reason: `Live profit factor ${live.profitFactor.toFixed(2)} vs backtest ${backtest.profitFactor.toFixed(2)}`,
    };
  }

  return { drift: false };
}
