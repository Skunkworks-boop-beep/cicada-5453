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
 *
 * The aggregation is **trade-weighted** so a strategy with 100 trades at a 60%
 * win rate dominates a strategy with 2 trades at 100% — matching how the bot
 * actually experiences its performance in live trading. This was previously an
 * arithmetic mean of row-level win rates, which oversampled tiny-sample rows.
 */
export function getBacktestMetricsForBot(
  bot: BotConfig,
  results: BacktestResultRow[]
): { winRate: number; profitFactor: number; sampleSize: number } {
  const botStrategyIds = new Set(Array.isArray(bot.strategyIds) ? bot.strategyIds : []);
  const botTimeframes = new Set(Array.isArray(bot.timeframes) ? bot.timeframes : []);
  const completed = results.filter((r) => {
    if (r.status !== 'completed' || r.instrumentId !== bot.instrumentId) return false;
    if (botStrategyIds.size > 0 && !botStrategyIds.has(r.strategyId)) return false;
    // Only compare against timeframes the bot actually trades; otherwise an
    // M5 scalp bot is being judged against an H4 swing backtest of the same
    // strategy.
    if (botTimeframes.size > 0 && !botTimeframes.has(r.timeframe)) return false;
    // Drop zero-trade rows: they contribute no information and otherwise
    // skew PF averages downward.
    return (r.trades ?? 0) > 0;
  });
  if (completed.length === 0) {
    return { winRate: 0.5, profitFactor: 1, sampleSize: 0 };
  }
  // Trade-weighted averages.
  const totalTrades = completed.reduce((s, r) => s + (r.trades ?? 0), 0);
  if (totalTrades <= 0) {
    return { winRate: 0.5, profitFactor: 1, sampleSize: completed.length };
  }
  const winRateWeighted =
    completed.reduce((s, r) => s + (r.winRate * (r.trades ?? 0)), 0) / totalTrades;
  // Profit factor is ratio-like; averaging PFs directly makes no sense.
  // Aggregate gross profit and gross loss by proxy: row-level profit * trades * win%.
  // This reconstructs aggregated PF instead of averaging the field directly.
  let grossProfit = 0;
  let grossLoss = 0;
  for (const r of completed) {
    const trades = r.trades ?? 0;
    if (trades <= 0) continue;
    const winFrac = (r.winRate ?? 0) / 100;
    const pf = r.profitFactor ?? 1;
    // Decompose into gross profit / loss from win rate and PF — a rough
    // reconstruction, but much better than averaging PF directly.
    const wins = winFrac * trades;
    const losses = trades - wins;
    const avgLoss = losses > 0 ? 1 : 0;
    const avgWin = wins > 0 && pf > 0 ? pf * avgLoss : 0;
    grossProfit += wins * avgWin;
    grossLoss += losses * avgLoss;
  }
  const aggregatedPf =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 10 : 1;
  return {
    winRate: winRateWeighted / 100,
    profitFactor: aggregatedPf,
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
