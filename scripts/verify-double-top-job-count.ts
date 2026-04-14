#!/usr/bin/env npx tsx
/**
 * Verify backtest job count for cp-double-top strategy with M1-M15 timeframes.
 * Expected: 1 instrument × 1 strategy × 12 param combos × 3 TFs × 10 regimes = 360
 */

import { estimateBacktestJobCount } from '../src/app/core/backtest';
import {
  DEFAULT_BACKTEST_PARAM_COMBOS_LIMIT,
  getParamCombinationsLimited,
} from '../src/app/core/strategyParams';
import { ALL_REGIMES } from '../src/app/core/regimes';

const REQUEST = {
  instrumentIds: ['inst-eurusd'],
  strategyIds: ['cp-double-top'],
  timeframes: ['M1', 'M5', 'M15'] as const,
  regimes: ALL_REGIMES,
  dateFrom: '2020-01-01',
  dateTo: '2025-01-01',
};

const paramCombos = getParamCombinationsLimited('cp-double-top', DEFAULT_BACKTEST_PARAM_COMBOS_LIMIT);
const est = estimateBacktestJobCount({
  ...REQUEST,
  paramCombosLimit: DEFAULT_BACKTEST_PARAM_COMBOS_LIMIT,
});

console.log('Strategy: cp-double-top (Double Top)');
console.log('Param family: structure');
console.log('Param combos:', paramCombos.length);
console.log('Timeframes: M1, M5, M15 (3)');
console.log('Regimes:', REQUEST.regimes.length);
console.log('Instruments: 1');
console.log('');
console.log(
  'Expected: 1 × 1 ×',
  paramCombos.length,
  '× 3 × 10 =',
  1 * 1 * paramCombos.length * 3 * 10
);
console.log('estimateBacktestJobCount:', est);
console.log('');
console.log(est === 360 ? '✓ PASS: 360 runs' : '✗ FAIL: expected 360, got ' + est);
