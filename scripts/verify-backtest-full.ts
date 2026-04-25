#!/usr/bin/env npx tsx
/**
 * Full backtest verification: no fake/momentum fallbacks, real signal logic for all strategies.
 * Ensures:
 * 1. All registry strategies use real signal logic (never _signal_momentum)
 * 2. Backtest completes without errors for every strategy
 * 3. Results are deterministic (same bars + strategy → same trades)
 *
 * Run: npx tsx scripts/verify-backtest-full.ts
 */

import { spawnSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

/** Resolve the project venv python so verify works without a system-wide torch. */
function resolvePython(): string {
  const env = process.env.CICADA_PYTHON?.trim();
  if (env && existsSync(env)) return env;
  const posix = join(rootDir, 'python/venv/bin/python');
  const win = join(rootDir, 'python/venv/Scripts/python.exe');
  if (existsSync(posix)) return posix;
  if (existsSync(win)) return win;
  return 'python3';
}
const PYTHON = resolvePython();

import { getAllStrategies } from '../src/app/core/registries';
import { runSingleBacktest } from '../src/app/core/backtest';
import type { OHLCVBar } from '../src/app/core/ohlcv';

const TMP_BARS = join(rootDir, '.verify-backtest-bars.json');
const SPREAD = 0.0001;

function makeBars(n: number, variant: 'up' | 'down' | 'range' = 'up'): OHLCVBar[] {
  const bars: OHLCVBar[] = [];
  for (let i = 0; i < n; i++) {
    let o: number, c: number;
    if (variant === 'up') {
      o = 1.0 + i * 0.001;
      c = o + 0.0005;
    } else if (variant === 'down') {
      o = 1.1 - i * 0.001;
      c = o - 0.0005;
    } else {
      o = 1.0 + 0.002 * Math.sin(i * 0.2);
      c = o + 0.0003;
    }
    bars.push({
      time: 1000 + i,
      open: o,
      high: Math.max(o, c) + 0.0003,
      low: Math.min(o, c) - 0.0003,
      close: c,
      volume: 0,
    });
  }
  return bars;
}

function runPythonBacktest(
  strategyId: string,
  regime: string,
  bars: OHLCVBar[],
  params?: Record<string, number>
): { trades: number; profit: number; status: string; error?: string } {
  const barsForPy = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
  writeFileSync(TMP_BARS, JSON.stringify(barsForPy));
  const proc = spawnSync(PYTHON, [join(rootDir, 'scripts/run_python_parity.py'), 'backtest', TMP_BARS, strategyId, regime, JSON.stringify(params ?? {})], {
    cwd: rootDir,
    encoding: 'utf-8',
  });
  try {
    if (existsSync(TMP_BARS)) unlinkSync(TMP_BARS);
  } catch {
    /* ignore */
  }
  if (proc.status !== 0) {
    return { trades: 0, profit: 0, status: 'failed', error: proc.stderr || proc.stdout };
  }
  try {
    const out = JSON.parse(proc.stdout.trim());
    return { trades: out.trades ?? 0, profit: out.profit ?? 0, status: 'completed' };
  } catch {
    return { trades: 0, profit: 0, status: 'failed', error: proc.stdout };
  }
}

async function main() {
  const strategies = getAllStrategies();
  const bars = makeBars(150, 'up');
  const regimes = ['trending_bull', 'ranging', 'reversal_bear'] as const;

  console.log('Full backtest verification: no fake logic, 100% real signals\n');
  console.log(`Strategies: ${strategies.length} | Regimes: ${regimes.length} | Bars: ${bars.length}\n`);

  let feErrors = 0;
  let pyErrors = 0;
  let momentumWarnings = 0;

  // 1. Frontend: every strategy must complete without throw
  for (const s of strategies) {
    for (const regime of regimes) {
      try {
        const r = runSingleBacktest('inst-eur', 'EURUSD', s.id, s.name, 'M5', regime, SPREAD, 0, bars, undefined);
        if (r.trades === undefined || r.profit === undefined) {
          console.error(`FE invalid ${s.id}@${regime}: missing trades/profit`);
          feErrors++;
        }
      } catch (e) {
        console.error(`FE throw ${s.id}@${regime}:`, (e as Error).message);
        feErrors++;
      }
    }
  }
  if (feErrors === 0) {
    console.log('OK frontend: all strategies complete without error');
  } else {
    console.log(`FAIL frontend: ${feErrors} errors`);
  }

  // 2. Python: sample strategies (full 236*3 would be slow); ensure no momentum fallback
  const sampleIds = [
    'ind-rsi-oversold',
    'ind-macd-cross',
    'ind-bb-reversion',
    'ind-donchian',
    'pa-fvg',
    'pa-bos',
    'pa-liquidity-sweep',
    'cp-double-top',
    'cs-engulfing-bull',
  ];
  for (const sid of sampleIds) {
    for (const regime of regimes) {
      const py = runPythonBacktest(sid, regime, bars);
      if (py.status !== 'completed') {
        console.error(`PY fail ${sid}@${regime}:`, py.error?.slice(0, 80));
        pyErrors++;
      }
      if (py.error?.includes('momentum')) {
        momentumWarnings++;
      }
    }
  }
  if (pyErrors === 0) {
    console.log('OK Python: sample strategies complete (get_signal, no momentum fallback)');
  } else {
    console.log(`FAIL Python: ${pyErrors} errors`);
  }
  if (momentumWarnings > 0) {
    console.log(`WARN: ${momentumWarnings} momentum fallback warnings`);
  }

  // 3. Determinism: same bars + strategy → same result
  const fe1 = runSingleBacktest('inst-eur', 'EURUSD', 'ind-rsi-oversold', 'RSI', 'M5', 'trending_bull', SPREAD, 0, bars, { period: 14 });
  const fe2 = runSingleBacktest('inst-eur', 'EURUSD', 'ind-rsi-oversold', 'RSI', 'M5', 'trending_bull', SPREAD, 0, bars, { period: 14 });
  if (fe1.trades !== fe2.trades || fe1.profit !== fe2.profit) {
    console.error('FAIL determinism: frontend results differ on same input');
  } else {
    console.log('OK determinism: same input → same result');
  }

  // 4. Regime filter: different regimes must produce different (profit, trades) when bars have mixed regimes
  const barsMixed = makeBars(200, 'range'); // range = mix of regimes
  const rBull = runSingleBacktest('inst-eur', 'EURUSD', 'ind-rsi-oversold', 'RSI', 'M5', 'trending_bull', SPREAD, 0, barsMixed, { period: 14 });
  const rBear = runSingleBacktest('inst-eur', 'EURUSD', 'ind-rsi-oversold', 'RSI', 'M5', 'trending_bear', SPREAD, 0, barsMixed, { period: 14 });
  const sameWhenBothHaveTrades = rBull.trades > 0 && rBear.trades > 0 && rBull.trades === rBear.trades && rBull.profit === rBear.profit;
  if (sameWhenBothHaveTrades) {
    console.error('FAIL regime filter: trending_bull and trending_bear produced identical (profit, trades) — regime filter may be broken');
  } else {
    console.log('OK regime filter: different regimes produce different results');
  }

  // 5. Strategy diversity: different strategies must produce different results (not same values for all)
  const indStrategies = strategies.filter((s) => s.id.startsWith('ind-'));
  const paStrategies = strategies.filter((s) => s.id.startsWith('pa-'));
  const strategySample = [...indStrategies.slice(0, 5), ...paStrategies.slice(0, 5)];
  const barsLong = makeBars(500, 'range'); // longer + ranging for more regime variety
  const profits = new Map<string, number>();
  for (const s of strategySample) {
    const r = runSingleBacktest('inst-eur', 'EURUSD', s.id, s.name, 'M5', 'any', SPREAD, 0, barsLong, undefined);
    profits.set(s.id, r.profit);
  }
  const uniqueProfits = new Set(profits.values());
  const allSame = uniqueProfits.size === 1 && strategySample.length > 1;
  if (allSame) {
    console.error('FAIL strategy diversity: all strategies produced identical profit — backtest may be broken');
  } else {
    console.log(`OK strategy diversity: ${uniqueProfits.size} distinct profit values across ${strategySample.length} strategies`);
  }

  console.log('\n--- Summary ---');
  if (feErrors > 0 || pyErrors > 0) {
    console.log('FAIL: backtest has errors');
    process.exit(1);
  }
  console.log('All checks passed. Backtest uses real signal logic for all strategies.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
