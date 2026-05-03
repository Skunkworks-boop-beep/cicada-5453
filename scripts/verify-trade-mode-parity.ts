#!/usr/bin/env npx tsx
/**
 * Verify the canonical trade-mode rules table is identical in TS and Python.
 *
 * If you change a number in src/app/core/tradeModes.ts you MUST change the
 * matching field in python/cicada_nn/trade_modes.py — this script fails CI
 * otherwise. Same role as scripts/verify-trading-mode.ts but for the new
 * Stage 1 mode rules (min hold, ATR bands, SL management, etc.).
 *
 * Run: npx tsx scripts/verify-trade-mode-parity.ts
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { TRADE_MODES, type TradeModeRules } from '../src/app/core/tradeModes';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

function resolvePython(): string {
  const env = process.env.CICADA_PYTHON?.trim();
  if (env && existsSync(env)) return env;
  const posix = join(rootDir, 'python/venv/bin/python');
  const win = join(rootDir, 'python/venv/Scripts/python.exe');
  if (existsSync(posix)) return posix;
  if (existsSync(win)) return win;
  return 'python3';
}

const PYTHON_SCRIPT = `
import json
import sys
sys.path.insert(0, "python")
from cicada_nn.trade_modes import TRADE_MODES
out = {}
for k, r in TRADE_MODES.items():
    out[k] = {
        "style": r.style,
        "timeframes": list(r.timeframes),
        "minHoldBars": r.min_hold_bars,
        "minTpAtr": r.min_tp_atr,
        "minSlAtr": r.min_sl_atr,
        "maxSlAtr": r.max_sl_atr,
        "slManagement": r.sl_management.value,
        "tpManagement": r.tp_management.value,
        "entryConfirmation": r.entry_confirmation,
        "exitTrigger": r.exit_trigger,
        "maxConcurrent": r.max_concurrent,
        "confidenceThreshold": r.confidence_threshold,
        "mt5Magic": r.mt5_magic,
    }
print(json.dumps(out))
`;

function loadPythonTable(): Record<string, Record<string, unknown>> {
  const py = resolvePython();
  const result = spawnSync(py, ['-c', PYTHON_SCRIPT], {
    cwd: rootDir,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    console.error('[parity] Python failed:', result.stderr);
    process.exit(1);
  }
  return JSON.parse(result.stdout);
}

function tsRow(r: TradeModeRules): Record<string, unknown> {
  return {
    style: r.style,
    timeframes: [...r.timeframes],
    minHoldBars: r.minHoldBars,
    minTpAtr: r.minTpAtr,
    minSlAtr: r.minSlAtr,
    maxSlAtr: r.maxSlAtr,
    slManagement: r.slManagement,
    tpManagement: r.tpManagement,
    entryConfirmation: r.entryConfirmation,
    exitTrigger: r.exitTrigger,
    maxConcurrent: r.maxConcurrent,
    confidenceThreshold: r.confidenceThreshold,
    mt5Magic: r.mt5Magic,
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function main(): void {
  const py = loadPythonTable();
  const tsKeys = Object.keys(TRADE_MODES).sort();
  const pyKeys = Object.keys(py).sort();
  if (tsKeys.length !== pyKeys.length || !tsKeys.every((k, i) => k === pyKeys[i])) {
    console.error('[parity] keys differ', { tsKeys, pyKeys });
    process.exit(1);
  }

  let mismatches = 0;
  for (const key of tsKeys) {
    const tsR = tsRow(TRADE_MODES[key as keyof typeof TRADE_MODES]);
    const pyR = py[key];
    if (!deepEqual(tsR, pyR)) {
      mismatches++;
      console.error(`[parity] ${key} mismatch:`);
      console.error('  TS :', JSON.stringify(tsR));
      console.error('  PY :', JSON.stringify(pyR));
    }
  }
  if (mismatches > 0) {
    console.error(`[parity] ${mismatches}/${tsKeys.length} mode(s) differ between TS and Python.`);
    process.exit(1);
  }
  console.log(`[parity] ✅ all ${tsKeys.length} trade-mode rule sets match across TS and Python.`);
}

main();
