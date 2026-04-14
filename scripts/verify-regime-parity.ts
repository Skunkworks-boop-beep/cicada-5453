/**
 * Frontend vs Python regime detection parity test.
 * Run: npx tsx scripts/verify-regime-parity.ts
 *
 * Generates identical bars, runs both implementations, compares bar-by-bar.
 */

import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { detectRegimeSeries } from '../src/app/core/regimes';
import type { OHLCVBar } from '../src/app/core/ohlcv';

const LOOKBACK = 50;

function generateBars(count: number, variant: 'flat' | 'uptrend' | 'breakout'): OHLCVBar[] {
  const bars: OHLCVBar[] = [];
  for (let i = 0; i < count; i++) {
    let o: number, h: number, l: number, c: number;
    if (variant === 'flat') {
      o = 1.0;
      h = 1.001;
      l = 0.999;
      c = 1.0;
    } else if (variant === 'uptrend') {
      o = 1.0 + i * 0.001;
      c = o + 0.0005;
      h = c + 0.0003;
      l = o - 0.0003;
    } else {
      o = 1.0;
      h = 1.001;
      l = 0.999;
      c = 1.0;
    }
    bars.push({ time: 1000 + i, open: o, high: h, low: l, close: c, volume: 0 });
  }
  if (variant === 'breakout' && count > 80) {
    bars[80] = { time: 1080, open: 1.0, high: 1.002, low: 0.999, close: 1.001, volume: 0 };
  }
  return bars;
}

function runPythonRegime(bars: OHLCVBar[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const tmpPath = join(__dirname, '.regime-test.json');
    const scriptPath = join(__dirname, 'run_python_regime.py');
    const barsForPython = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
    writeFileSync(tmpPath, JSON.stringify(barsForPython));

    const proc = spawn('python', [scriptPath, tmpPath, String(LOOKBACK)], {
      cwd: join(process.cwd()),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', (code) => {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch { /* ignore */ }
      if (code !== 0) {
        reject(new Error(`Python exited ${code}: ${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out.trim()));
      } catch (e) {
        reject(new Error(`Python output parse failed: ${out.slice(0, 200)}`));
      }
    });
  });
}

function compare(frontend: { regime: string }[], python: string[]) {
  const mismatches: { i: number; frontend: string; python: string }[] = [];
  const len = Math.min(frontend.length, python.length);
  for (let i = 0; i < len; i++) {
    const f = frontend[i]?.regime ?? 'unknown';
    const p = python[i] ?? 'unknown';
    if (f !== p) {
      mismatches.push({ i, frontend: f, python: p });
    }
  }
  if (frontend.length !== python.length) {
    console.warn(`Length mismatch: frontend=${frontend.length}, python=${python.length}`);
  }
  return mismatches;
}

async function main() {
  console.log('Regime parity test: frontend vs Python\n');

  const cases: { name: string; bars: OHLCVBar[] }[] = [
    { name: 'flat_81', bars: generateBars(81, 'flat') },
    { name: 'flat_breakout', bars: generateBars(81, 'breakout') },
    { name: 'uptrend_80', bars: generateBars(80, 'uptrend') },
  ];

  let totalMismatches = 0;
  for (const { name, bars } of cases) {
    const frontend = detectRegimeSeries(bars, LOOKBACK);
    const python = await runPythonRegime(bars);
    const mismatches = compare(frontend, python);

    if (mismatches.length > 0) {
      console.log(`FAIL ${name}: ${mismatches.length} mismatches`);
      mismatches.slice(0, 10).forEach((m) => console.log(`  bar ${m.i}: frontend=${m.frontend} python=${m.python}`));
      if (mismatches.length > 10) console.log(`  ... and ${mismatches.length - 10} more`);
      totalMismatches += mismatches.length;
    } else {
      console.log(`OK ${name}: ${frontend.length} bars match`);
    }
  }

  if (totalMismatches > 0) {
    console.log(`\nTotal: ${totalMismatches} mismatches`);
    process.exit(1);
  }
  console.log('\nAll regime outputs match.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
