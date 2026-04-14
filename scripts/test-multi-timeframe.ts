#!/usr/bin/env npx tsx
/**
 * Unit checks for HTF/LTF alignment and MTF signals (no live market — synthetic bars).
 */

import { buildHtfIndexForEachLtfBar, getHigherTimeframe } from '../src/app/core/multiTimeframe';
import type { OHLCVBar } from '../src/app/core/ohlcv';
import { signalHtfBias, signalMultiTfAlignment } from '../src/app/core/signals';
import { detectRegimeSeries } from '../src/app/core/regimes';

function bar(t: number, close: number): OHLCVBar {
  return { time: t, open: close, high: close + 1, low: close - 1, close, volume: 1 };
}

const M5 = 5 * 60 * 1000;
const M15 = 15 * 60 * 1000;

// 20 LTF bars on M5
const ltf: OHLCVBar[] = [];
let t0 = Date.UTC(2024, 0, 1, 0, 0, 0);
for (let i = 0; i < 20; i++) {
  ltf.push(bar(t0 + i * M5, 100 + i * 0.1));
}
// HTF: one bar per 15m aligned to same start
const htf: OHLCVBar[] = [];
for (let j = 0; j < 10; j++) {
  htf.push(bar(t0 + j * M15, 100 + j * 0.3));
}

const idx = buildHtfIndexForEachLtfBar(ltf, htf);
console.log('getHigherTimeframe(M5)=', getHigherTimeframe('M5'));
console.log('htf index for LTF bar 10:', idx[10]);

const htfIndexByLtfBar = idx;
const ctx = { htfBars: htf, htfIndexByLtfBar, htfTimeframe: 'M15' as const, ltfTimeframe: 'M5' as const };

// Fake regime series for signal API (structure strategies need regime)
const regimeSeries = detectRegimeSeries(ltf, 50);
const i = 15;
const reg = regimeSeries[i] ?? null;

const mtf = signalMultiTfAlignment(ltf, reg, i, { fast: 5, slow: 12 }, ctx);
const bias = signalHtfBias(ltf, reg, i, { fast: 5, slow: 12 }, ctx);
console.log('signalMultiTfAlignment (i=15, synthetic):', mtf);
console.log('signalHtfBias (i=15, synthetic):', bias);

const ok =
  idx.length === ltf.length &&
  idx[0] >= 0 &&
  getHigherTimeframe('M5') === 'M15' &&
  getHigherTimeframe('W1') === null;

console.log(ok ? '✓ multi-timeframe unit checks passed' : '✗ FAIL');

process.exit(ok ? 0 : 1);
