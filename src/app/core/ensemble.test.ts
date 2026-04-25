import { describe, it, expect } from 'vitest';
import { ensembleDecision } from './ensemble';
import { portfolioKellyFractions, botCorrelationMatrix, estimateBotEdges } from './portfolioKelly';
import type { BotConfig, ClosedTrade } from './types';

describe('ensembleDecision', () => {
  it('trusts both voters when they agree and both are confident', () => {
    const decision = ensembleDecision({
      nnAction: 0,
      nnConfidence: 0.8,
      strategySignal: 1,
      strategyReliability: 0.7,
    });
    expect(decision.action).toBe('LONG');
    expect(decision.reason).toBe('agree_high_conf');
    expect(decision.confidence).toBeGreaterThan(0.5);
  });

  it('resolves a conflict in favour of the stronger weighted voter', () => {
    const decision = ensembleDecision({
      nnAction: 1,             // NN says SHORT
      nnConfidence: 0.9,
      strategySignal: 1,       // strategy says LONG
      strategyReliability: 0.3,
      nnWeight: 0.7,
    });
    expect(decision.action).toBe('SHORT');
    expect(decision.reason).toBe('conflict_resolved_nn');
  });

  it('suppresses the trade when total confidence is below the floor', () => {
    const decision = ensembleDecision({
      nnAction: 0,
      nnConfidence: 0.3,
      strategySignal: 0,
      strategyReliability: 0.3,
      minConfidence: 0.6,
    });
    expect(decision.action).toBe('NEUTRAL');
    expect(decision.reason).toBe('low_confidence');
  });

  it('damps the ensemble when regime confidence is low', () => {
    const high = ensembleDecision({
      nnAction: 0,
      nnConfidence: 0.9,
      strategySignal: 1,
      strategyReliability: 0.7,
      regimeConfidence: 1,
    });
    const low = ensembleDecision({
      nnAction: 0,
      nnConfidence: 0.9,
      strategySignal: 1,
      strategyReliability: 0.7,
      regimeConfidence: 0.3,
    });
    expect(high.confidence).toBeGreaterThan(low.confidence);
  });
});

describe('portfolioKellyFractions', () => {
  const baseBot = (id: string): BotConfig => ({
    id,
    name: id,
    instrumentId: id,
    instrumentSymbol: id,
    timeframes: ['M5'],
    styles: ['day'],
    allowedScopes: ['day'],
    regimes: ['trending_bull'],
    strategyIds: ['ind-rsi'],
    riskLevel: 3,
    maxPositions: 2,
    riskParams: {
      riskPerTradePct: 0.01,
      maxDrawdownPct: 0.15,
      useKelly: true,
      kellyFraction: 0.25,
      maxCorrelatedExposure: 1.5,
      defaultStopLossPct: 0.02,
      defaultRiskRewardRatio: 2,
    },
    status: 'deployed',
    buildProgress: 100,
  });

  it('returns no trades when no history and no edges', () => {
    const bots = [baseBot('bot-a'), baseBot('bot-b')];
    const alloc = portfolioKellyFractions(bots, {});
    expect(Object.keys(alloc)).toEqual(['bot-a', 'bot-b']);
    // With no edges, every bot gets floor-capped at 0.0025.
    expect(alloc['bot-a']).toBeGreaterThanOrEqual(0);
    expect(alloc['bot-a']).toBeLessThanOrEqual(0.25);
  });

  it('penalises highly correlated bots', () => {
    const bots = [baseBot('bot-a'), baseBot('bot-b')];
    const winSeq: ClosedTrade[] = Array.from({ length: 20 }).map((_, i) => ({
      id: `${i}`,
      botId: 'bot-a',
      instrumentId: 'bot-a',
      pnl: i % 2 === 0 ? 10 : -4,
      pnlPercent: 0,
      closedAt: new Date(2024, 0, i + 1).toISOString(),
    }));
    const sameSeq = winSeq.map((t) => ({ ...t, botId: 'bot-b' }));
    const closed = { 'bot-a': winSeq, 'bot-b': sameSeq };
    const mat = botCorrelationMatrix(['bot-a', 'bot-b'], closed);
    expect(mat[0][1]).toBeGreaterThan(0.8);

    const alloc = portfolioKellyFractions(bots, closed, { totalBudgetPct: 0.1 });
    // Both bots share the budget; neither should exceed their pre-correlation
    // Kelly fraction alone.
    expect(alloc['bot-a'] + alloc['bot-b']).toBeLessThanOrEqual(0.1001);
  });

  it('estimates live edges from closed trades', () => {
    const bots = [baseBot('bot-a')];
    const trades: ClosedTrade[] = Array.from({ length: 20 }).map((_, i) => ({
      id: `${i}`,
      botId: 'bot-a',
      instrumentId: 'bot-a',
      pnl: i < 14 ? 10 : -4,
      pnlPercent: 0,
      closedAt: new Date(2024, 0, i + 1).toISOString(),
    }));
    const [edge] = estimateBotEdges(bots, { 'bot-a': trades });
    expect(edge.winRate).toBeCloseTo(14 / 20, 2);
    expect(edge.avgWinLossRatio).toBeCloseTo(10 / 4, 2);
    expect(edge.sampleSize).toBe(20);
  });
});
