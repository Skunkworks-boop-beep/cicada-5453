#!/usr/bin/env npx tsx
/**
 * Verify all frontend strategies are mapped in Python SIGNAL_ROUTER (or covered by fallback).
 * Run: npx tsx scripts/verify-strategy-mapping.ts
 */

import { getAllStrategies } from '../src/app/core/registries';
import { getSignalFn } from '../src/app/core/signals';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const strategies = getAllStrategies();
const ids = strategies.map((s) => s.id);

console.log(`Registry: ${ids.length} strategies`);
console.log(`  ind-*: ${ids.filter((i) => i.startsWith('ind-')).length}`);
console.log(`  pa-*:  ${ids.filter((i) => i.startsWith('pa-')).length}`);
console.log(`  cp-*:  ${ids.filter((i) => i.startsWith('cp-')).length}`);
console.log(`  cs-*:  ${ids.filter((i) => i.startsWith('cs-')).length}`);

// 1. Frontend: every strategy must have a signal function
let feOk = true;
for (const id of ids) {
  const fn = getSignalFn(id);
  if (typeof fn !== 'function') {
    console.error(`FE missing: ${id}`);
    feOk = false;
  }
}
if (feOk) console.log('OK frontend: all strategies have signal functions');

// 2. Python: run verify script that checks each strategy
const pyResult = spawnSync('python', [path.join(rootDir, 'python/verify_signals.py')], {
  cwd: rootDir,
  encoding: 'utf-8',
});
if (pyResult.status !== 0) {
  console.error('Python verify_signals.py failed:', pyResult.stderr || pyResult.stdout);
  process.exit(1);
}

// 3. Python SIGNAL_ROUTER + fallback coverage (cwd=root, so add python/ to path)
const pyScript = `
import sys
sys.path.insert(0, "python")
from cicada_nn.signals import get_signal, SIGNAL_ROUTER

ids = ${JSON.stringify(ids)}
bars = [{"time": i, "open": 1.0, "high": 1.001, "low": 0.999, "close": 1.0} for i in range(50)]
errors = []
for sid in ids:
    try:
        s = get_signal(sid, bars, 25, "ranging", None)
        if s not in (1, -1, 0):
            errors.append(f"{sid}: invalid signal {s}")
    except Exception as e:
        errors.append(f"{sid}: {e}")

if errors:
    print("UNMAPPED or ERROR:", "\\n".join(errors))
    sys.exit(1)
print(f"OK Python: all {len(ids)} strategies mapped and return valid signals")
`;
const pyCheck = spawnSync('python', ['-c', pyScript], {
  cwd: rootDir,
  encoding: 'utf-8',
});
if (pyCheck.status !== 0) {
  console.error(pyCheck.stderr || pyCheck.stdout);
  process.exit(1);
}
console.log(pyCheck.stdout.trim());

console.log('\n✓ Full strategy mapping verified: all', ids.length, 'strategies mapped in Python');
process.exit(0);
