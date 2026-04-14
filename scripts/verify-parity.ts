/**
 * Full parity test: regime, signals, backtest — frontend vs Python.
 * Run: npx tsx scripts/verify-parity.ts
 */

import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { detectRegimeSeries } from '../src/app/core/regimes';
import { getSignalFn } from '../src/app/core/signals';
import { runSingleBacktest } from '../src/app/core/backtest';
import type { OHLCVBar } from '../src/app/core/ohlcv';
import type { StrategyParams } from '../src/app/core/types';

const LOOKBACK = 50;
const TMP_PATH = join(__dirname, '.parity-test.json');
const SCRIPT_PATH = join(__dirname, 'run_python_parity.py');

type BarVariant = 'flat' | 'uptrend' | 'downtrend' | 'ranging' | 'volatile' | 'reversal_bull' | 'reversal_bear' | 'breakout';

function generateBars(count: number, variant: BarVariant): OHLCVBar[] {
  const bars: OHLCVBar[] = [];
  for (let i = 0; i < count; i++) {
    let o: number, h: number, l: number, c: number;
    const t = i / Math.max(count - 1, 1);
    switch (variant) {
      case 'flat':
        o = 1.0; h = 1.001; l = 0.999; c = 1.0;
        break;
      case 'uptrend':
        o = 1.0 + i * 0.001; c = o + 0.0005; h = c + 0.0003; l = o - 0.0003;
        break;
      case 'downtrend':
        o = 1.1 - i * 0.001; c = o - 0.0005; h = o + 0.0003; l = c - 0.0003;
        break;
      case 'ranging':
        o = 1.0 + 0.002 * Math.sin(i * 0.2); c = o + 0.0003; h = c + 0.0005; l = o - 0.0005;
        break;
      case 'volatile':
        o = 1.0 + (i % 5 - 2) * 0.005; c = o + (i % 3 - 1) * 0.003; h = Math.max(o, c) + 0.002; l = Math.min(o, c) - 0.002;
        break;
      case 'reversal_bull':
        o = 1.05 - i * 0.0008; c = o - 0.0003; h = o + 0.0002; l = c - 0.0002;
        if (i > 40) { o = 1.01 + (i - 40) * 0.0005; c = o + 0.0004; h = c + 0.0003; l = o - 0.0003; }
        break;
      case 'reversal_bear':
        o = 1.0 + i * 0.0008; c = o + 0.0003; h = c + 0.0002; l = o - 0.0002;
        if (i > 40) { o = 1.04 - (i - 40) * 0.0005; c = o - 0.0004; h = o + 0.0003; l = c - 0.0003; }
        break;
      case 'breakout':
        o = 1.0; h = 1.001; l = 0.999; c = 1.0;
        break;
      default:
        o = 1.0; h = 1.001; l = 0.999; c = 1.0;
    }
    bars.push({ time: 1000 + i, open: o, high: h, low: l, close: c, volume: 0 });
  }
  if (variant === 'breakout' && count > 80) {
    bars[80] = { time: 1080, open: 1.0, high: 1.002, low: 0.999, close: 1.001, volume: 0 };
  }
  return bars;
}

function runPython(mode: string, bars: OHLCVBar[], ...args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const barsForPy = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
    writeFileSync(TMP_PATH, JSON.stringify(barsForPy));
    const proc = spawn('python', [SCRIPT_PATH, mode, TMP_PATH, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', (code) => {
      try { if (existsSync(TMP_PATH)) unlinkSync(TMP_PATH); } catch { /* ignore */ }
      if (code !== 0) {
        reject(new Error(`Python ${mode} exited ${code}: ${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out.trim()));
      } catch {
        reject(new Error(`Python parse failed: ${out.slice(0, 150)}`));
      }
    });
  });
}

// --- Regime parity ---
async function testRegime() {
  const cases: { name: string; bars: OHLCVBar[] }[] = [
    { name: 'flat_81', bars: generateBars(81, 'flat') },
    { name: 'flat_breakout', bars: generateBars(81, 'breakout') },
    { name: 'uptrend_80', bars: generateBars(80, 'uptrend') },
    { name: 'downtrend_80', bars: generateBars(80, 'downtrend') },
    { name: 'ranging_80', bars: generateBars(80, 'ranging') },
    { name: 'volatile_80', bars: generateBars(80, 'volatile') },
    { name: 'reversal_bull_80', bars: generateBars(80, 'reversal_bull') },
    { name: 'reversal_bear_80', bars: generateBars(80, 'reversal_bear') },
    { name: 'short_60', bars: generateBars(60, 'flat') },
    { name: 'edge_55', bars: generateBars(55, 'uptrend') },
    { name: 'uptrend_120', bars: generateBars(120, 'uptrend') },
  ];

  let fails = 0;
  for (const { name, bars } of cases) {
    const fe = detectRegimeSeries(bars, LOOKBACK);
    const py = await runPython('regime', bars, String(LOOKBACK)) as string[];
    const mismatches: { i: number; fe: string; py: string }[] = [];
    for (let i = 0; i < Math.min(fe.length, py.length); i++) {
      const f = fe[i]?.regime ?? 'unknown';
      const p = py[i] ?? 'unknown';
      if (f !== p) mismatches.push({ i, fe: f, py: p });
    }
    if (mismatches.length > 0) {
      console.log(`FAIL regime ${name}: ${mismatches.length} mismatches`);
      mismatches.slice(0, 5).forEach((m) => console.log(`  bar ${m.i}: fe=${m.fe} py=${m.py}`));
      fails += mismatches.length;
    } else {
      console.log(`OK regime ${name}: ${fe.length} bars`);
    }
  }
  return fails;
}

// --- Signal parity ---
async function testSignals() {
  const bars = generateBars(120, 'uptrend');
  const regimes = detectRegimeSeries(bars, LOOKBACK);
  const strategyConfig: { id: string; params?: StrategyParams }[] = [
    { id: 'pa-fvg' },
    { id: 'pa-bos' },
    { id: 'ind-rsi-oversold', params: { period: 14, overbought: 70, oversold: 30 } },
    { id: 'ind-macd-cross', params: { fast: 12, slow: 26, signal: 9 } },
    { id: 'pa-liquidity-sweep', params: { lookback: 5 } },
    { id: 'ind-bb-reversion', params: { period: 20, stdMult: 2 } },
    { id: 'ind-donchian', params: { period: 20 } },
    { id: 'ind-stoch-overbought', params: { kPeriod: 14, dPeriod: 3, overbought: 80, oversold: 20 } },
    { id: 'ind-cci-overbought', params: { period: 20 } },
    { id: 'ind-williams-r', params: { period: 14 } },
    { id: 'ind-roc', params: { period: 12 } },
    { id: 'ind-adx-trend', params: { period: 14 } },
    { id: 'ind-keltner', params: { emaPeriod: 20, atrPeriod: 10, mult: 2 } },
    { id: 'ind-ema-cross-9-21', params: { fast: 9, slow: 21 } },
    { id: 'ind-atr-breakout', params: { period: 14, mult: 1.5 } },
  ];

  let fails = 0;
  for (const { id: sid, params } of strategyConfig) {
    const signalFn = getSignalFn(sid);
    const pySignals = await runPython('signals', bars, sid, JSON.stringify(params ?? {})) as number[];
    const feSignals: number[] = [];
    for (let i = 0; i < bars.length; i++) {
      const reg = regimes[i] ?? null;
      feSignals.push(signalFn(bars, reg, i, params ?? undefined));
    }
    const mismatches: { i: number; fe: number; py: number }[] = [];
    for (let i = 0; i < Math.min(feSignals.length, pySignals.length); i++) {
      if (feSignals[i] !== pySignals[i]) mismatches.push({ i, fe: feSignals[i], py: pySignals[i] });
    }
    if (mismatches.length > 0) {
      console.log(`FAIL signals ${sid}: ${mismatches.length} mismatches`);
      mismatches.slice(0, 5).forEach((m) => console.log(`  bar ${m.i}: fe=${m.fe} py=${m.py}`));
      fails += mismatches.length;
    } else {
      console.log(`OK signals ${sid}`);
    }
  }
  return fails;
}

// --- Backtest parity ---
async function testBacktest() {
  const SPREAD = 0.0001;
  let fails = 0;

  const cases: { bars: OHLCVBar[]; regime: string }[] = [
    { bars: generateBars(120, 'uptrend'), regime: 'reversal_bear' },
    { bars: generateBars(81, 'breakout'), regime: 'breakout' },
  ];

  const strategies = [
    { id: 'ind-rsi-oversold', params: { period: 14, overbought: 70, oversold: 30 } as StrategyParams },
    { id: 'pa-fvg', params: undefined },
    { id: 'pa-bos', params: undefined },
    { id: 'ind-donchian', params: { period: 20 } },
  ];

  for (const { bars, regime } of cases) {
    for (const { id, params } of strategies) {
      const fe = runSingleBacktest('inst-eur', 'EURUSD', id, id, 'M5', regime as any, SPREAD, 0, bars, params);
      const py = await runPython('backtest', bars, id, regime, params ? JSON.stringify(params) : '{}') as {
        trades: number; profit: number; winRate: number; maxDrawdown: number; profitFactor: number;
      };
      const tradeDiff = Math.abs(fe.trades - py.trades);
      const tradeOk = tradeDiff <= Math.max(2, Math.max(fe.trades, py.trades) * 0.15);
      const profitOk = Math.abs(fe.profit - py.profit) < Math.max(150, Math.abs(fe.profit) * 0.5);
      const wrOk = Math.abs(fe.winRate - py.winRate) < 15;
      const label = `${id}@${regime}`;
      if (!tradeOk || !profitOk || !wrOk) {
        console.log(`FAIL backtest ${label}: fe trades=${fe.trades} profit=${fe.profit} wr=${fe.winRate} | py trades=${py.trades} profit=${py.profit} wr=${py.winRate}`);
        fails++;
      } else {
        console.log(`OK backtest ${label}: trades=${fe.trades} profit≈${fe.profit.toFixed(0)}`);
      }
    }
  }
  return fails;
}

async function main() {
  console.log('Full parity test: regime, signals, backtest\n');
  let total = 0;
  total += await testRegime();
  console.log('');
  total += await testSignals();
  console.log('');
  total += await testBacktest();
  console.log('');
  if (total > 0) {
    console.log(`Total: ${total} failures`);
    process.exit(1);
  }
  console.log('All parity tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
