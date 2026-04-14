#!/usr/bin/env npx tsx
/**
 * Verify getBestResultsForBuild logic: includes best greens AND best oranges when fallback triggers.
 * Run: npx tsx scripts/verify-build-selection.ts
 */

import { getBestResultsForBuild } from '../src/app/core/backtest';
import type { BacktestResultRow } from '../src/app/core/types';

function mock(profit: number, profitFactor: number, id: string): BacktestResultRow {
  return {
    id: `bt-${id}`,
    instrumentId: 'inst-eur',
    instrumentSymbol: 'EURUSD',
    strategyId: 'ind-rsi-oversold',
    strategyName: 'RSI',
    timeframe: 'M5',
    regime: 'ranging',
    scope: 'day',
    winRate: profit >= 0 ? 55 : 40,
    profit,
    trades: 5,
    maxDrawdown: 0.02,
    profitFactor,
    sharpeRatio: 0.5,
    sortinoRatio: 0.6,
    avgHoldBars: 10,
    status: 'completed',
    completedAt: '2025-01-01T00:00:00Z',
    dataEndTime: '2025-01-01T00:00:00Z',
    dataSource: 'live',
  };
}

// Case 1: Few greens (10), many oranges (15) → fallback to top 75% by profit
const results = [
  ...Array.from({ length: 10 }, (_, i) => mock(100 + i * 50, 1.5, `g${i}`)),
  ...Array.from({ length: 15 }, (_, i) => mock(-500 + i * 30, 0.5, `o${i}`)),
];

const best = getBestResultsForBuild(results);
const greens = best.filter((r) => r.profit >= 0);
const oranges = best.filter((r) => r.profit < 0);

console.log('=== getBestResultsForBuild verification ===\n');
console.log('Input: 10 green (profit 100–550), 15 orange (profit -500 to -80)');
console.log('best.length < max(20, 50%*25) → fallback to top 75% by profit\n');
console.log('Result:', best.length, 'rows');
console.log('  Greens:', greens.length, '| Oranges:', oranges.length);
console.log('  Orange profits (best of orange):', oranges.map((r) => r.profit).join(', '));
console.log('');

const ok =
  oranges.length > 0 &&
  Math.min(...oranges.map((r) => r.profit)) > -350 && // Best oranges = smallest losses
  greens.length === 10;

if (ok) {
  console.log('✓ Verified: best oranges (smallest losses) are included in build selection');
} else {
  console.log('✗ Unexpected result');
  process.exit(1);
}
