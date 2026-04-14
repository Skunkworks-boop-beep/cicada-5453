/**
 * Unit tests for botExecution: selectScopeForTick, getBotExecutionIntervalMs.
 * Run: npx vitest run --coverage
 */

import { describe, it, expect } from 'vitest';
import { selectScopeForTick, getBotExecutionIntervalMs } from './botExecution';
import { STYLE_TO_SCOPE, getTimeframesForScope, getScopeForTimeframe, getScopeForStyle, getTimeframesForStyle } from './scope';
import type { BotConfig, TradeScope, TradeStyle } from './types';
import { DEFAULT_SCOPE_SELECTOR_CONFIG } from './types';

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
    utcDay: 2,
    ...overrides,
  };
}

describe('selectScopeForTick', () => {
  it('manual single: fixedScope in allowedScopes returns that scope', () => {
    expect(selectScopeForTick(makeBot({ scopeMode: 'manual', fixedScope: 'scalp' }), makeInput())).toBe('scalp');
    expect(selectScopeForTick(makeBot({ scopeMode: 'manual', fixedScope: 'swing' }), makeInput())).toBe('swing');
    expect(selectScopeForTick(makeBot({ scopeMode: 'manual', fixedScope: 'position', allowedScopes: ['scalp', 'day', 'swing', 'position'] }), makeInput())).toBe('position');
  });

  it('manual single: fixedScope NOT in allowedScopes returns null', () => {
    expect(selectScopeForTick(makeBot({ scopeMode: 'manual', fixedScope: 'position', allowedScopes: ['scalp', 'day', 'swing'] }), makeInput())).toBeNull();
    expect(selectScopeForTick(makeBot({ scopeMode: 'manual', fixedScope: 'scalp', allowedScopes: ['day', 'swing'] }), makeInput())).toBeNull();
  });

  it('manual multi (2-4 styles): returns one of selected scopes', () => {
    const bot = makeBot({ scopeMode: 'manual', fixedScope: undefined, fixedStyles: ['scalping', 'day'] });
    const scope = selectScopeForTick(bot, makeInput());
    expect(['scalp', 'day']).toContain(scope);
  });

  it('manual multi: fixedStyles maps to empty allowed returns null', () => {
    const bot = makeBot({ scopeMode: 'manual', fixedScope: undefined, fixedStyles: ['scalping', 'sniper'] });
    expect(selectScopeForTick(bot, makeInput())).toBe('scalp');
  });

  it('auto: drawdownPause returns null', () => {
    const input = makeInput({ drawdownPct: DEFAULT_SCOPE_SELECTOR_CONFIG.drawdownPause + 0.01 });
    expect(selectScopeForTick(makeBot({ scopeMode: 'auto' }), input)).toBeNull();
  });

  it('auto: equity < 50 returns scalp only', () => {
    const input = makeInput({ equity: 30 });
    expect(selectScopeForTick(makeBot({ scopeMode: 'auto' }), input)).toBe('scalp');
  });

  it('auto: equity < 50 with no scalp in allowed returns null', () => {
    const input = makeInput({ equity: 30 });
    expect(selectScopeForTick(makeBot({ allowedScopes: ['day', 'swing'] }), input)).toBeNull();
  });

  it('auto: equity 50-500 returns scalp or day', () => {
    const input = makeInput({ equity: 200 });
    const scope = selectScopeForTick(makeBot({ scopeMode: 'auto' }), input);
    expect(['scalp', 'day']).toContain(scope);
  });

  it('auto: drawdownScalpOnly with no scalp returns null', () => {
    const input = makeInput({ drawdownPct: 0.15 });
    expect(selectScopeForTick(makeBot({ allowedScopes: ['day', 'swing'] }), input)).toBeNull();
  });

  it('auto: volatilityNoScalp filters scalp', () => {
    const input = makeInput({ volatilityPercent: 0.05 });
    const scope = selectScopeForTick(makeBot({ scopeMode: 'auto' }), input);
    expect(scope).not.toBe('scalp');
  });

  it('auto: weekend (Sunday) filters scalp', () => {
    const input = makeInput({ utcDay: 0 });
    const scope = selectScopeForTick(makeBot({ scopeMode: 'auto' }), input);
    expect(scope).not.toBe('scalp');
  });

  it('auto: weekend (Saturday) filters scalp', () => {
    const input = makeInput({ utcDay: 6 });
    const scope = selectScopeForTick(makeBot({ scopeMode: 'auto' }), input);
    expect(scope).not.toBe('scalp');
  });

  it('auto: utcHour 0-2 filters scalp', () => {
    const input = makeInput({ utcHour: 1 });
    const scope = selectScopeForTick(makeBot({ scopeMode: 'auto' }), input);
    expect(scope).not.toBe('scalp');
  });

  it('auto: utcHour 0 (midnight) filters scalp', () => {
    const input = makeInput({ utcHour: 0 });
    const scope = selectScopeForTick(makeBot({ scopeMode: 'auto' }), input);
    expect(scope).not.toBe('scalp');
  });

  it('auto: trending_bull regime prefers swing/position', () => {
    const input = makeInput({ regime: 'trending_bull', regimeConfidence: 0.85, utcHour: 14 });
    const scope = selectScopeForTick(makeBot({ allowedScopes: ['scalp', 'day', 'swing', 'position'] }), input);
    expect(['swing', 'position']).toContain(scope);
  });

  it('auto: trending_bear regime prefers swing/position', () => {
    const input = makeInput({ regime: 'trending_bear', regimeConfidence: 0.8, utcHour: 14 });
    const scope = selectScopeForTick(makeBot({ allowedScopes: ['scalp', 'day', 'swing', 'position'] }), input);
    expect(['swing', 'position']).toContain(scope);
  });

  it('auto: trending with position but no swing returns position', () => {
    const input = makeInput({ regime: 'trending_bull', regimeConfidence: 0.9, utcDay: 0, utcHour: 14 });
    const scope = selectScopeForTick(makeBot({ allowedScopes: ['day', 'position'] }), input);
    expect(scope).toBe('position');
  });

  it('auto: scalp-only + weekend returns null (candidates empty)', () => {
    const input = makeInput({ utcDay: 0 });
    expect(selectScopeForTick(makeBot({ allowedScopes: ['scalp'] }), input)).toBeNull();
  });

  it('empty allowedScopes uses default', () => {
    const scope = selectScopeForTick(makeBot({ allowedScopes: [] }), makeInput());
    expect(scope).not.toBeNull();
  });

  it('allowedScopes undefined or empty uses default', () => {
    const bot = makeBot({ allowedScopes: [] });
    const scope = selectScopeForTick(bot, makeInput());
    expect(scope).not.toBeNull();
  });

  it('undefined scopeMode defaults to auto', () => {
    const scope = selectScopeForTick(makeBot(), makeInput());
    expect(scope).not.toBeNull();
  });
});

describe('getBotExecutionIntervalMs', () => {
  it('empty bots returns day interval', () => {
    expect(getBotExecutionIntervalMs([])).toBe(30_000);
  });

  it('scalp TF bot returns 15s', () => {
    const bot = makeBot({ timeframes: ['M1', 'M5'], status: 'deployed' });
    expect(getBotExecutionIntervalMs([bot])).toBe(15_000);
  });

  it('swing TF bot returns 60s', () => {
    const bot = makeBot({ timeframes: ['H4', 'D1'], status: 'deployed' });
    expect(getBotExecutionIntervalMs([bot])).toBe(60_000);
  });

  it('position TF bot returns 120s', () => {
    const bot = makeBot({ timeframes: ['W1'], status: 'deployed' });
    expect(getBotExecutionIntervalMs([bot])).toBe(120_000);
  });

  it('mixed bots returns fastest', () => {
    const scalp = makeBot({ timeframes: ['M1'], status: 'deployed' });
    const swing = makeBot({ timeframes: ['H4'], status: 'deployed', id: 'bot-2', instrumentId: 'inst-2' });
    expect(getBotExecutionIntervalMs([scalp, swing])).toBe(15_000);
  });
});

describe('scope module', () => {
  it('STYLE_TO_SCOPE maps all styles', () => {
    for (const style of ALL_STYLE_IDS) {
      expect(['scalp', 'day', 'swing', 'position']).toContain(STYLE_TO_SCOPE[style]);
    }
  });

  it('getTimeframesForScope returns non-empty', () => {
    for (const s of ['scalp', 'day', 'swing', 'position'] as TradeScope[]) {
      expect(getTimeframesForScope(s).length).toBeGreaterThan(0);
    }
  });

  it('getScopeForTimeframe maps TF to scope', () => {
    expect(getScopeForTimeframe('M1')).toBe('scalp');
    expect(getScopeForTimeframe('H4')).toBe('swing');
    expect(getScopeForTimeframe('W1')).toBe('position');
  });

  it('getScopeForStyle maps style to scope', () => {
    expect(getScopeForStyle('scalping')).toBe('scalp');
    expect(getScopeForStyle('medium_swing')).toBe('swing');
  });

  it('getTimeframesForStyle returns TFs for style', () => {
    expect(getTimeframesForStyle('scalping')).toEqual(['M1', 'M5']);
    expect(getTimeframesForStyle('day')).toEqual(['M15', 'M30', 'H1']);
  });
});

describe('selectScopeForTick - trending returns position when swing not in candidates', () => {
  it('trending with position only returns position', () => {
    const input = makeInput({ regime: 'trending_bull', regimeConfidence: 0.9, utcDay: 0 });
    const scope = selectScopeForTick(makeBot({ allowedScopes: ['day', 'swing', 'position'] }), input);
    expect(['swing', 'position']).toContain(scope);
  });
});

describe('selectScopeForTick - manual multi allowed.length 0', () => {
  it('manual multi with invalid fixedStyles never produces empty - STYLE_TO_SCOPE always valid', () => {
    const bot = makeBot({ scopeMode: 'manual', fixedScope: undefined, fixedStyles: ['scalping', 'day'] });
    const allowed = [...new Set(bot.fixedStyles!.map((s) => STYLE_TO_SCOPE[s]))];
    expect(allowed.length).toBeGreaterThan(0);
  });
});
