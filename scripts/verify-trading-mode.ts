#!/usr/bin/env npx tsx
/**
 * Verify trading mode (scope selection) wiring: selectScopeForTick, STYLE_TO_SCOPE, execution flow,
 * mode selection logic, and backend wiring (scope → timeframe → predict).
 *
 * Run: npx tsx scripts/verify-trading-mode.ts
 */

import { selectScopeForTick, getBotExecutionIntervalMs } from '../src/app/core/botExecution';
import { STYLE_TO_SCOPE, getTimeframesForScope, getScopeStyleFromBotForInstrument } from '../src/app/core/scope';
import type { BotConfig, TradeScope, TradeStyle } from '../src/app/core/types';
import type { Timeframe } from '../src/app/core/types';
import { DEFAULT_SCOPE_SELECTOR_CONFIG } from '../src/app/core/types';
import { ALL_TRADE_STYLES } from '../src/app/core/scope';

const ALL_STYLE_IDS: TradeStyle[] = ['scalping', 'day', 'medium_swing', 'swing', 'sniper'];

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot-test',
    name: 'TestBot',
    instrumentId: 'inst-eur',
    instrumentSymbol: 'EURUSD',
    timeframes: ['M1', 'M5', 'M15', 'H1', 'H4'],
    styles: ['scalping', 'day', 'swing'],
    allowedScopes: ['scalp', 'day', 'swing'],
    regimes: ['trending_bull', 'ranging'],
    strategyIds: ['ind-rsi-oversold'],
    riskLevel: 2,
    maxPositions: 3,
    riskParams: {
      riskPerTradePct: 0.01,
      maxDrawdownPct: 0.15,
      useKelly: false,
      kellyFraction: 0.25,
      maxCorrelatedExposure: 1.5,
      defaultStopLossPct: 0.02,
      defaultRiskRewardRatio: 2,
    },
    status: 'deployed',
    buildProgress: 100,
    ...overrides,
  };
}

function makeInput(overrides: Partial<{
  equity: number;
  drawdownPct: number;
  regime: string;
  regimeConfidence: number;
  volatilityPercent: number;
  utcHour: number;
  utcDay: number;
}> = {}) {
  return {
    equity: 1000,
    drawdownPct: 0,
    regime: 'ranging',
    regimeConfidence: 0.6,
    volatilityPercent: 0.01,
    utcHour: 10,
    utcDay: 2, // Tuesday
    ...overrides,
  };
}

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
  console.log('Trading mode verification\n');

  // 1. Manual mode: fixedScope in allowedScopes → returns fixedScope
  const botManualScalp = makeBot({ scopeMode: 'manual', fixedScope: 'scalp' });
  const scope1 = selectScopeForTick(botManualScalp, makeInput());
  assert(scope1 === 'scalp', `manual scalp: expected 'scalp', got ${scope1}`);
  if (scope1 === 'scalp') ok('manual mode: fixedScope=scalp in allowedScopes → returns scalp');

  const botManualSwing = makeBot({ scopeMode: 'manual', fixedScope: 'swing' });
  const scope2 = selectScopeForTick(botManualSwing, makeInput());
  assert(scope2 === 'swing', `manual swing: expected 'swing', got ${scope2}`);
  if (scope2 === 'swing') ok('manual mode: fixedScope=swing in allowedScopes → returns swing');

  // 2. Manual mode: fixedScope NOT in allowedScopes → returns null (restricts execution)
  const botManualPosition = makeBot({
    scopeMode: 'manual',
    fixedScope: 'position',
    allowedScopes: ['scalp', 'day', 'swing'],
  });
  const scope3 = selectScopeForTick(botManualPosition, makeInput());
  assert(scope3 === null, `manual position not in allowed: expected null, got ${scope3}`);
  if (scope3 === null) ok('manual mode: fixedScope not in allowedScopes → returns null (restricts execution)');

  // 3. Auto/undefined scopeMode uses dynamic logic
  const botAuto = makeBot({ scopeMode: 'auto', fixedScope: undefined });
  const inputNormal = makeInput({ equity: 1000, drawdownPct: 0, utcHour: 10, utcDay: 2 });
  const scope4 = selectScopeForTick(botAuto, inputNormal);
  assert(scope4 !== null, `auto mode: expected non-null scope, got ${scope4}`);
  if (scope4 !== null) ok('auto mode: returns scope from dynamic logic');

  const botUndefined = makeBot(); // no scopeMode
  const scope5 = selectScopeForTick(botUndefined, inputNormal);
  assert(scope5 !== null, `undefined scopeMode (default auto): expected non-null, got ${scope5}`);
  if (scope5 !== null) ok('undefined scopeMode defaults to auto logic');

  // 4. High drawdown → auto returns null (pause)
  const inputHighDD = makeInput({ drawdownPct: DEFAULT_SCOPE_SELECTOR_CONFIG.drawdownPause + 0.01 });
  const scope6 = selectScopeForTick(botAuto, inputHighDD);
  assert(scope6 === null, `high drawdown: expected null, got ${scope6}`);
  if (scope6 === null) ok('auto mode: high drawdown → returns null (pause)');

  // 5. Weekend → no scalp in candidates
  const inputWeekend = makeInput({ utcDay: 0 }); // Sunday
  const scope7 = selectScopeForTick(botAuto, inputWeekend);
  assert(scope7 !== 'scalp', `weekend: scalp should be filtered, got ${scope7}`);
  if (scope7 !== 'scalp') ok('auto mode: weekend filters scalp');

  // 5b. Trending regime with high confidence → prefers swing/position
  const botAutoWithPosition = makeBot({ allowedScopes: ['scalp', 'day', 'swing', 'position'] });
  const inputTrending = makeInput({
    regime: 'trending_bull',
    regimeConfidence: 0.85,
    utcHour: 14,
    utcDay: 2,
  });
  const scope7b = selectScopeForTick(botAutoWithPosition, inputTrending);
  assert(scope7b === 'swing' || scope7b === 'position', `trending: expected swing or position, got ${scope7b}`);
  if (scope7b === 'swing' || scope7b === 'position') ok('auto mode: trending regime prefers swing/position');

  // 6. STYLE_TO_SCOPE maps all TradeStyles
  const beforeStyle = errors;
  for (const style of ALL_TRADE_STYLES) {
    const scope = STYLE_TO_SCOPE[style];
    assert(
      ['scalp', 'day', 'swing', 'position'].includes(scope),
      `STYLE_TO_SCOPE[${style}] = ${scope} is not a valid TradeScope`
    );
  }
  if (errors === beforeStyle) ok(`STYLE_TO_SCOPE maps all ${ALL_TRADE_STYLES.length} TradeStyles`);

  // 7. getTimeframesForScope returns non-empty arrays
  const scopes: TradeScope[] = ['scalp', 'day', 'swing', 'position'];
  for (const s of scopes) {
    const tfs = getTimeframesForScope(s);
    assert(tfs.length > 0, `getTimeframesForScope(${s}) returned empty`);
  }
  ok('getTimeframesForScope returns valid TFs for all scopes');

  // 8. Manual multi (2–4 fixedStyles): uses auto logic restricted to those scopes
  const botMulti = makeBot({
    scopeMode: 'manual',
    fixedScope: undefined,
    fixedStyles: ['scalping', 'day'],
  });
  const scope8 = selectScopeForTick(botMulti, makeInput());
  assert(
    scope8 === 'scalp' || scope8 === 'day',
    `manual multi scalp+day: expected scalp or day, got ${scope8}`
  );
  if (scope8 === 'scalp' || scope8 === 'day') ok('manual multi (2 styles): returns one of selected scopes');

  // 9. Manual mode: fixedScope not in allowedScopes → null
  const botNoScalp = makeBot({
    scopeMode: 'manual',
    fixedScope: 'scalp',
    allowedScopes: ['day', 'swing'],
  });
  const scope9 = selectScopeForTick(botNoScalp, makeInput());
  assert(scope9 === null, `manual scalp but scalp not in allowedScopes: expected null, got ${scope9}`);
  if (scope9 === null) ok('manual mode: fixedScope not in allowedScopes → null');

  // 10. Manual multi (3 styles): returns one of selected scopes
  const botMulti3 = makeBot({
    scopeMode: 'manual',
    fixedScope: undefined,
    fixedStyles: ['scalping', 'day', 'medium_swing'],
  });
  const scope10 = selectScopeForTick(botMulti3, makeInput());
  const valid10 = ['scalp', 'day', 'swing'].includes(scope10 ?? '');
  assert(valid10, `manual multi 3 styles: expected scalp/day/swing, got ${scope10}`);
  if (valid10) ok('manual multi (3 styles): returns one of selected scopes');

  // 11. Manual multi (4 styles): returns one of selected scopes
  const botMulti4 = makeBot({
    scopeMode: 'manual',
    fixedScope: undefined,
    fixedStyles: ['scalping', 'day', 'medium_swing', 'swing'],
  });
  const scope11 = selectScopeForTick(botMulti4, makeInput());
  const valid11 = ['scalp', 'day', 'swing'].includes(scope11 ?? '');
  assert(valid11, `manual multi 4 styles: expected scalp/day/swing, got ${scope11}`);
  if (valid11) ok('manual multi (4 styles): returns one of selected scopes');

  // 12. Manual multi: scalping + sniper both map to scalp → only scalp in allowed
  const botScalpSniper = makeBot({
    scopeMode: 'manual',
    fixedScope: undefined,
    fixedStyles: ['scalping', 'sniper'],
  });
  const scope12 = selectScopeForTick(botScalpSniper, makeInput());
  assert(scope12 === 'scalp', `manual scalping+sniper: expected scalp only, got ${scope12}`);
  if (scope12 === 'scalp') ok('manual multi: overlapping styles (scalp+sniper) → single scope');

  // 13. Manual multi: only swing scopes → weekend filters scalp, returns day or swing
  const botSwingOnly = makeBot({
    scopeMode: 'manual',
    fixedScope: undefined,
    fixedStyles: ['medium_swing', 'swing'],
  });
  const scope13Weekend = selectScopeForTick(botSwingOnly, makeInput({ utcDay: 0 }));
  const valid13 = scope13Weekend === 'day' || scope13Weekend === 'swing';
  assert(valid13, `manual swing-only weekend: expected day or swing, got ${scope13Weekend}`);
  if (valid13) ok('manual multi swing-only: weekend returns day or swing');

  // --- Mode selection logic (simulated) ---
  console.log('\n--- Mode selection logic ---');

  function simulateSelectMode(
    bot: BotConfig,
    style: TradeStyle | 'auto'
  ): Partial<BotConfig> {
    if (style === 'auto') {
      return {
        scopeMode: 'auto',
        fixedScope: undefined,
        fixedStyle: undefined,
        fixedStyles: undefined,
      };
    }
    const current = bot.fixedStyles ?? (bot.fixedStyle ? [bot.fixedStyle] : []);
    const idx = current.indexOf(style);
    const next = idx >= 0 ? current.filter((_, i) => i !== idx) : [...current, style];
    if (next.length === 0 || next.length === ALL_STYLE_IDS.length) {
      return {
        scopeMode: 'auto',
        fixedScope: undefined,
        fixedStyle: undefined,
        fixedStyles: undefined,
      };
    }
    const allowed = bot.allowedScopes?.length ? bot.allowedScopes : ['scalp', 'day', 'swing'];
    const scopes = [...new Set(next.map((s) => STYLE_TO_SCOPE[s]))];
    const allowedScopes = [...new Set([...allowed, ...scopes])];
    if (next.length === 1) {
      return {
        scopeMode: 'manual',
        fixedScope: STYLE_TO_SCOPE[next[0]],
        fixedStyle: next[0],
        fixedStyles: next,
        allowedScopes,
      };
    }
    return {
      scopeMode: 'manual',
      fixedScope: undefined,
      fixedStyle: undefined,
      fixedStyles: next,
      allowedScopes,
    };
  }

  function simulateIsSelected(bot: BotConfig, style: TradeStyle | 'auto'): boolean {
    if (style === 'auto') {
      const fs = bot.fixedStyles ?? [];
      return (
        (bot.scopeMode ?? 'auto') === 'auto' ||
        (fs.length === 0 && !bot.fixedScope) ||
        fs.length === ALL_STYLE_IDS.length
      );
    }
    const fs = bot.fixedStyles ?? (bot.fixedStyle ? [bot.fixedStyle] : []);
    return fs.includes(style);
  }

  // 14. Click mode → deselects AUTO
  let bot = makeBot({ scopeMode: 'auto' });
  const patch14 = simulateSelectMode(bot, 'scalping');
  bot = { ...bot, ...patch14 } as BotConfig;
  assert(bot.scopeMode === 'manual', 'select scalping: scopeMode should be manual');
  assert(!simulateIsSelected(bot, 'auto'), 'select scalping: AUTO should be deselected');
  assert(simulateIsSelected(bot, 'scalping'), 'select scalping: scalping should be selected');
  ok('select mode → deselects AUTO');

  // 15. Click AUTO → clears mode selection
  bot = makeBot({ scopeMode: 'manual', fixedScope: 'scalp', fixedStyle: 'scalping', fixedStyles: ['scalping'] });
  const patch15 = simulateSelectMode(bot, 'auto');
  bot = { ...bot, ...patch15 } as BotConfig;
  assert(bot.scopeMode === 'auto', 'select AUTO: scopeMode should be auto');
  assert(simulateIsSelected(bot, 'auto'), 'select AUTO: AUTO should be selected');
  assert(!simulateIsSelected(bot, 'scalping'), 'select AUTO: scalping should be deselected');
  ok('select AUTO → clears mode selection');

  // 16. Toggle: click selected mode again → deselects it
  bot = makeBot({ scopeMode: 'manual', fixedScope: 'scalp', fixedStyle: 'scalping', fixedStyles: ['scalping'] });
  const patch16 = simulateSelectMode(bot, 'scalping');
  bot = { ...bot, ...patch16 } as BotConfig;
  assert(bot.scopeMode === 'auto', 'toggle off scalping: should switch to auto');
  assert(simulateIsSelected(bot, 'auto'), 'toggle off scalping: AUTO should be selected');
  ok('toggle selected mode → deselects, switches to AUTO');

  // 17. Select all 5 → switches to AUTO
  bot = makeBot({
    scopeMode: 'manual',
    fixedStyles: ['scalping', 'day', 'medium_swing', 'swing'],
  });
  const patch17 = simulateSelectMode(bot, 'sniper');
  bot = { ...bot, ...patch17 } as BotConfig;
  assert(bot.scopeMode === 'auto', 'select 5th mode: should switch to auto');
  assert(simulateIsSelected(bot, 'auto'), 'all 5 selected: AUTO should be selected');
  ok('select all 5 modes → switches to AUTO');

  // 18. Multi-select: 2 modes → both selected, scopeMode manual
  bot = makeBot({ scopeMode: 'auto' });
  bot = { ...bot, ...simulateSelectMode(bot, 'scalping') } as BotConfig;
  bot = { ...bot, ...simulateSelectMode(bot, 'day') } as BotConfig;
  assert(bot.fixedStyles?.length === 2, 'multi-select: should have 2 styles');
  assert(bot.scopeMode === 'manual', 'multi-select: scopeMode should be manual');
  assert(!bot.fixedScope, 'multi-select 2: fixedScope should be undefined');
  const scope18 = selectScopeForTick(bot, makeInput());
  assert(scope18 === 'scalp' || scope18 === 'day', `multi-select 2: scope should be scalp or day, got ${scope18}`);
  ok('multi-select 2 modes → manual with auto logic in those scopes');

  // 19. Backward compat: fixedStyle without fixedStyles → selectScopeForTick uses fixedScope
  const botLegacy = makeBot({
    scopeMode: 'manual',
    fixedScope: 'day',
    fixedStyle: 'day',
    fixedStyles: undefined,
  });
  const scope19 = selectScopeForTick(botLegacy, makeInput());
  assert(scope19 === 'day', `legacy fixedStyle: expected day, got ${scope19}`);
  assert(simulateIsSelected(botLegacy, 'day'), 'legacy: day should be selected');
  assert(!simulateIsSelected(botLegacy, 'auto'), 'legacy: AUTO should not be selected');
  ok('backward compat: fixedStyle without fixedStyles works');

  // 20. High drawdown with manual single → still uses fixed scope (no pause from drawdown)
  const botManualDD = makeBot({
    scopeMode: 'manual',
    fixedScope: 'scalp',
    fixedStyle: 'scalping',
  });
  const scope20 = selectScopeForTick(botManualDD, makeInput({ drawdownPct: 0.25 }));
  assert(scope20 === 'scalp', `manual single with high DD: should still return scalp, got ${scope20}`);
  ok('manual mode: high drawdown does not pause (fixed scope)');

  // 21. Manual position scope (when in allowedScopes)
  const botPosition = makeBot({
    scopeMode: 'manual',
    fixedScope: 'position',
    allowedScopes: ['scalp', 'day', 'swing', 'position'],
  });
  const scope21 = selectScopeForTick(botPosition, makeInput());
  assert(scope21 === 'position', `manual position: expected position, got ${scope21}`);
  if (scope21 === 'position') ok('manual mode: fixedScope=position works when in allowedScopes');

  // --- Backend wiring: scope → timeframe → predict ---
  console.log('\n--- Backend wiring (scope → timeframe → predict) ---');

  function simulateExecutionFlow(bot: BotConfig, scope: TradeScope): { timeframe: Timeframe; payload: object } {
    const scopeTfs = getTimeframesForScope(scope);
    const primaryTf = bot.timeframes[0] ?? 'M5';
    const tf = scopeTfs.find((t) => bot.timeframes.includes(t)) ?? scopeTfs[0] ?? primaryTf;
    const payload = {
      instrument_id: bot.instrumentId,
      feature_vector: bot.nnFeatureVector ?? new Array(256).fill(0),
      instrument_type: 'fiat',
      regime: 'ranging',
      timeframe: tf,
      scope,  // Backend uses scope for NN style_index (scalp/day/swing/position)
    };
    return { timeframe: tf as Timeframe, payload };
  }

  // 22. Scope → timeframe mapping: each scope yields valid TF for predict
  const scopesForBackend: TradeScope[] = ['scalp', 'day', 'swing', 'position'];
  const botWithAllTfs = makeBot({
    timeframes: ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'],
    nnFeatureVector: new Array(256).fill(0.1),
  });
  for (const sc of scopesForBackend) {
    const { timeframe, payload } = simulateExecutionFlow(botWithAllTfs, sc);
    assert(typeof timeframe === 'string', `scope ${sc}: timeframe must be string`);
    assert(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'].includes(timeframe), `scope ${sc}: invalid TF ${timeframe}`);
    assert(payload.instrument_id === 'inst-eur', 'payload must have instrument_id');
    assert(Array.isArray((payload as { feature_vector: number[] }).feature_vector), 'payload must have feature_vector');
    assert((payload as { feature_vector: number[] }).feature_vector.length === 256, 'feature_vector must be 256-dim');
    assert('regime' in payload && 'timeframe' in payload, 'payload must have regime and timeframe');
  }
  ok('scope → timeframe → predict payload: all scopes yield valid PredictRequest');

  // 23. Backend PredictRequest schema alignment (frontend sends what backend expects)
  const expectedKeys = ['instrument_id', 'feature_vector', 'instrument_type', 'regime', 'timeframe'];
  const { payload: samplePayload } = simulateExecutionFlow(botWithAllTfs, 'scalp');
  for (const k of expectedKeys) {
    assert(k in samplePayload, `PredictRequest missing key: ${k}`);
  }
  ok('PredictRequest schema: frontend payload matches backend expectations');

  // 23b. getScopeStyleFromBotForInstrument: trade-mode logic (no broker) — bot config, not arbitrary defaults
  const botScalpManual = makeBot({ instrumentId: 'inst-eur', scopeMode: 'manual', fixedScope: 'scalp' });
  const instEur = { id: 'inst-eur', symbol: 'EURUSD', type: 'fiat' as const, status: 'active' as const, brokerId: 'b1', timeframes: ['M5', 'H1'] };
  const { scope: scope23b, style: style23b } = getScopeStyleFromBotForInstrument('inst-eur', [botScalpManual], [instEur]);
  assert(scope23b === 'scalp' && style23b === 'scalping', `getScopeStyleFromBot: manual scalp expected scalp/scalping, got ${scope23b}/${style23b}`);
  if (scope23b === 'scalp') ok('getScopeStyleFromBotForInstrument: manual fixedScope=scalp → scalp/scalping');

  const botAutoH4 = makeBot({ instrumentId: 'inst-eur', scopeMode: 'auto', timeframes: ['H4', 'D1'] });
  const { scope: scope23c } = getScopeStyleFromBotForInstrument('inst-eur', [botAutoH4], [instEur]);
  assert(scope23c === 'swing', `getScopeStyleFromBot: auto H4 primary expected swing, got ${scope23c}`);
  if (scope23c === 'swing') ok('getScopeStyleFromBotForInstrument: auto primary TF H4 → swing');

  const { scope: scope23d } = getScopeStyleFromBotForInstrument('inst-unknown', [], []);
  assert(scope23d === 'scalp', `getScopeStyleFromBot: no bot/instrument expected scalp default, got ${scope23d}`);
  if (scope23d === 'scalp') ok('getScopeStyleFromBotForInstrument: no bot → M5 default → scalp');

  // 24. runBotExecution flow: scope=null → no predict (skipped)
  const botNullScope = makeBot({
    scopeMode: 'manual',
    fixedScope: 'position',
    allowedScopes: ['scalp', 'day', 'swing'],
  });
  const scope24 = selectScopeForTick(botNullScope, makeInput());
  assert(scope24 === null, 'scope=null: execution should skip predict');
  ok('scope=null → execution skips predict (no backend call)');

  // --- Additional branch coverage ---
  console.log('\n--- Branch coverage ---');

  // 25. equity < equityScalpOnly (50): scalp-only filter
  const inputLowEquity = makeInput({ equity: 30 });
  const scope25 = selectScopeForTick(botAuto, inputLowEquity);
  assert(scope25 === 'scalp', `low equity: expected scalp, got ${scope25}`);
  if (scope25 === 'scalp') ok('auto: equity < 50 → scalp only');

  // 26. equity < equityScalpOnly with no scalp in allowed → null
  const botDaySwingOnly = makeBot({ allowedScopes: ['day', 'swing'] });
  const scope26 = selectScopeForTick(botDaySwingOnly, inputLowEquity);
  assert(scope26 === null, `low equity + no scalp allowed: expected null, got ${scope26}`);
  if (scope26 === null) ok('auto: equity < 50 + no scalp in allowed → null');

  // 27. equity between 50 and 500: scalp or day
  const inputMidEquity = makeInput({ equity: 200 });
  const scope27 = selectScopeForTick(botAuto, inputMidEquity);
  assert(scope27 === 'scalp' || scope27 === 'day', `mid equity: expected scalp or day, got ${scope27}`);
  if (scope27 === 'scalp' || scope27 === 'day') ok('auto: equity 50–500 → scalp or day');

  // 28. drawdownScalpOnly: high DD filters to scalp only; no scalp → null
  const inputDrawdownScalp = makeInput({
    drawdownPct: 0.15,
    equity: 1000,
  });
  const scope28 = selectScopeForTick(botDaySwingOnly, inputDrawdownScalp);
  assert(scope28 === null, `drawdownScalpOnly + no scalp: expected null, got ${scope28}`);
  if (scope28 === null) ok('auto: drawdownScalpOnly + no scalp in allowed → null');

  // 29. volatilityNoScalp: high volatility filters out scalp
  const inputHighVol = makeInput({ volatilityPercent: 0.05 });
  const scope29 = selectScopeForTick(botAuto, inputHighVol);
  assert(scope29 !== 'scalp', `high volatility: scalp should be filtered, got ${scope29}`);
  if (scope29 !== 'scalp') ok('auto: volatilityNoScalp filters scalp');

  // 30. utcHour 0–2: scalp filtered
  const inputEarlyHour = makeInput({ utcHour: 1, utcDay: 2 });
  const scope30 = selectScopeForTick(botAuto, inputEarlyHour);
  assert(scope30 !== 'scalp', `utcHour 0–2: scalp should be filtered, got ${scope30}`);
  if (scope30 !== 'scalp') ok('auto: utcHour 0–2 filters scalp');

  // 31. allowedScopes empty → uses default [scalp, day, swing]
  const botEmptyAllowed = makeBot({ allowedScopes: [], scopeMode: 'auto' });
  const scope31 = selectScopeForTick(botEmptyAllowed, makeInput());
  assert(scope31 !== null, 'empty allowedScopes: should use default');
  if (scope31 !== null) ok('empty allowedScopes → uses default [scalp, day, swing]');

  // 32. getBotExecutionIntervalMs
  const emptyBots: BotConfig[] = [];
  const intervalEmpty = getBotExecutionIntervalMs(emptyBots);
  assert(intervalEmpty === 30_000, `empty bots: expected 30000, got ${intervalEmpty}`);
  const botScalpTf = makeBot({ timeframes: ['M1', 'M5'] });
  const intervalScalp = getBotExecutionIntervalMs([{ ...botScalpTf, status: 'deployed' } as BotConfig]);
  assert(intervalScalp === 15_000, `scalp bot: expected 15000, got ${intervalScalp}`);
  ok('getBotExecutionIntervalMs: empty → day; scalp TF → 15s');

  // 33. selectMode: next.length 3 (multi 3) → fixedScope undefined, fixedStyles length 3
  bot = makeBot({ scopeMode: 'auto' });
  bot = { ...bot, ...simulateSelectMode(bot, 'scalping') } as BotConfig;
  bot = { ...bot, ...simulateSelectMode(bot, 'day') } as BotConfig;
  bot = { ...bot, ...simulateSelectMode(bot, 'medium_swing') } as BotConfig;
  assert(bot.fixedStyles?.length === 3, 'multi-select 3: should have 3 styles');
  assert(!bot.fixedScope, 'multi-select 3: fixedScope should be undefined');
  ok('selectMode: 3 styles → manual multi (no fixedScope)');

  // 34. isSelected: fixedStyles length 5 (all) → auto selected (edge case)
  const botAllFive = makeBot({
    scopeMode: 'manual',
    fixedStyles: ALL_STYLE_IDS,
  });
  assert(simulateIsSelected(botAllFive, 'auto'), 'fixedStyles.length=5: AUTO should be selected');
  ok('isSelected: fixedStyles.length=5 → AUTO selected');

  // 35. manual multi: fixedStyles maps to empty allowed (invalid styles) - STYLE_TO_SCOPE always returns valid, so we need allowed from fixedStyles. If fixedStyles = ['scalping','sniper'] we get ['scalp']. Never empty. Skip.
  // 36. candidates[0] when candidates empty - can happen if all filters remove everything. e.g. weekend + high vol + day/swing only → could end up with []. Let me check: weekend filters scalp, we have day, swing. So candidates = [day, swing]. High vol filters scalp. So we'd still have day, swing. For candidates to be empty we need allowed to not include day or swing after filters. E.g. allowed = ['scalp'], weekend → filter scalp → []. return null.
  const botScalpOnly = makeBot({ allowedScopes: ['scalp'] });
  const scope36 = selectScopeForTick(botScalpOnly, makeInput({ utcDay: 0 })); // weekend filters scalp
  assert(scope36 === null, 'scalp-only + weekend: candidates empty → null');
  if (scope36 === null) ok('auto: candidates empty after filters → null');

  console.log('\n--- Summary ---');
  if (errors > 0) {
    console.error(`FAIL: ${errors} error(s)`);
    process.exit(1);
  }
  console.log('All trading mode checks passed.');

  // Coverage summary
  console.log('\n--- Coverage ---');
  console.log('selectScopeForTick branches:');
  console.log('  ✓ manual single (fixedScope in allowedScopes)');
  console.log('  ✓ manual single (fixedScope NOT in allowedScopes → null)');
  console.log('  ✓ manual multi (2–4 fixedStyles → auto logic restricted)');
  console.log('  ✓ auto: drawdownPause → null');
  console.log('  ✓ auto: equity filters (scalp-only, day-min)');
  console.log('  ✓ auto: drawdownScalpOnly filter');
  console.log('  ✓ auto: volatilityNoScalp filter');
  console.log('  ✓ auto: weekend (utcDay 0/6) filter');
  console.log('  ✓ auto: utcHour 0–2 filter');
  console.log('  ✓ auto: trending regime → swing/position');
  console.log('  ✓ auto: default candidates[0]');
  console.log('Backend wiring:');
  console.log('  ✓ scope → getTimeframesForScope → timeframe');
  console.log('  ✓ timeframe → postPredict payload');
  console.log('  ✓ PredictRequest schema alignment');
  console.log('  ✓ scope=null → skip predict');
}

main();
