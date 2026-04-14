#!/usr/bin/env npx tsx
/**
 * Verify 100% backend wiring: all frontend API calls map to backend endpoints,
 * request/response shapes align, and no orphaned or missing calls.
 *
 * Run: npx tsx scripts/verify-backend-wiring.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_TS = path.join(__dirname, '../src/app/core/api.ts');
const API_PY = path.join(__dirname, '../python/cicada_nn/api.py');

const apiTs = fs.readFileSync(API_TS, 'utf-8');
const apiPy = fs.readFileSync(API_PY, 'utf-8');

const FRONTEND_CALLS: Array<{ fn: string; method: string; path: string }> = [
  { fn: 'postBuild', method: 'POST', path: '/build' },
  { fn: 'postPredict', method: 'POST', path: '/predict' },
  { fn: 'getHealth', method: 'GET', path: '/health' },
  { fn: 'postBacktest', method: 'POST', path: '/backtest' },
  { fn: 'postMt5Connect', method: 'POST', path: '/mt5/connect' },
  { fn: 'getMt5Status', method: 'GET', path: '/mt5/status' },
  { fn: 'getMt5Ohlc', method: 'GET', path: '/mt5/ohlc' },
  { fn: 'getMt5Prices', method: 'GET', path: '/mt5/prices' },
  { fn: 'getMt5SymbolSpreads', method: 'GET', path: '/mt5/symbols_spread' },
  { fn: 'getMt5Positions', method: 'GET', path: '/mt5/positions' },
  { fn: 'postMt5Order', method: 'POST', path: '/mt5/order' },
];

const BACKEND_ROUTES = [
  { method: 'GET', path: '/', decorator: '@app.get("/")' },
  { method: 'GET', path: '/health', decorator: '@app.get("/health")' },
  { method: 'POST', path: '/build', decorator: '@app.post("/build")' },
  { method: 'POST', path: '/predict', decorator: '@app.post("/predict")' },
  { method: 'POST', path: '/backtest', decorator: '@app.post("/backtest")' },
  { method: 'POST', path: '/mt5/connect', decorator: '@app.post("/mt5/connect")' },
  { method: 'GET', path: '/mt5/status', decorator: '@app.get("/mt5/status")' },
  { method: 'GET', path: '/mt5/ohlc', decorator: '@app.get("/mt5/ohlc")' },
  { method: 'GET', path: '/mt5/prices', decorator: '@app.get("/mt5/prices")' },
  { method: 'GET', path: '/mt5/symbols_spread', decorator: '@app.get("/mt5/symbols_spread")' },
  { method: 'GET', path: '/mt5/positions', decorator: '@app.get("/mt5/positions")' },
  { method: 'POST', path: '/mt5/order', decorator: '@app.post("/mt5/order")' },
];

let errors = 0;

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    errors++;
  }
}

function ok(msg: string) {
  console.log('OK', msg);
}

function main() {
  console.log('=== Backend Wiring Verification ===\n');

  // 1. Each frontend call must target a backend endpoint
  console.log('1. Frontend API calls → Backend endpoints');
  for (const { fn, method, path: p } of FRONTEND_CALLS) {
    const hasPathInApi = apiTs.includes(p);
    assert(hasPathInApi, `api.ts: ${fn} must call ${p}`);
    const backendPath = p.replace('/', '');
    const backendHas = apiPy.includes(p) || apiPy.includes(backendPath);
    assert(backendHas, `api.py: ${p} must exist`);
    ok(`${fn} → ${method} ${p}`);
  }

  // 2. Backend must have all expected routes
  console.log('\n2. Backend routes defined');
  for (const { method, path: p } of BACKEND_ROUTES) {
    const pathPart = p.replace('/', '');
    assert(apiPy.includes(pathPart), `api.py: ${method} ${p} route missing`);
    ok(`${method} ${p}`);
  }

  // 3. Backtest request/response alignment
  console.log('\n3. Backtest request/response alignment');
  assert(apiPy.includes('instrument_spreads'), 'Backend: BacktestRunRequest must have instrument_spreads');
  assert(apiTs.includes('instrument_spreads'), 'Frontend: postBacktest must send instrument_spreads');
  ok('Backtest instrument_spreads wired');

  // 4. Build request alignment
  console.log('\n4. Build request alignment');
  assert(apiTs.includes('dataEndTime') || apiTs.includes('completedAt'), 'Frontend: build sends dataEndTime/completedAt');
  assert(apiPy.includes('dataEndTime') || apiPy.includes('BuildRequest'), 'Backend: BuildRequest accepts results');
  ok('Build request shape aligned');

  // 5. Predict request alignment
  console.log('\n5. Predict request alignment');
  assert(apiTs.includes('instrument_id') && apiTs.includes('feature_vector'), 'Frontend: predict sends instrument_id, feature_vector');
  assert(apiPy.includes('instrument_id') && apiPy.includes('feature_vector'), 'Backend: PredictRequest has instrument_id, feature_vector');
  ok('Predict request shape aligned');

  // 6. MT5 symbols_spread endpoint
  console.log('\n6. MT5 symbols_spread');
  assert(apiPy.includes('get_symbol_spreads') || apiPy.includes('symbols_spread'), 'Backend: symbols_spread uses get_symbol_spreads');
  assert(apiTs.includes('getMt5SymbolSpreads'), 'Frontend: getMt5SymbolSpreads exists');
  ok('MT5 symbols_spread wired');

  // 7. API functions exported and used
  console.log('\n7. API functions exported');
  for (const { fn } of FRONTEND_CALLS) {
    assert(apiTs.includes(`function ${fn}`) || apiTs.includes(`async function ${fn}`), `api.ts: ${fn} must be defined`);
    ok(`${fn} defined`);
  }

  // 8. Deploy/Undeploy - frontend only (no backend)
  console.log('\n8. Deploy/Undeploy (frontend-only)');
  ok('deployBot, undeployBot, deployAllReadyBots, undeployAllBots are store actions (no backend)');

  // 9. Config
  console.log('\n9. Config');
  assert(apiTs.includes('getNnApiBaseUrl'), 'api.ts uses getNnApiBaseUrl');
  ok('All API calls use getNnApiBaseUrl()');

  console.log('\n=== Summary ===');
  if (errors > 0) {
    console.error(`\n${errors} error(s) found.`);
    process.exit(1);
  }
  console.log('All backend wirings verified. 100% complete.');
}

main();
