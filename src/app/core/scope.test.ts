/**
 * Unit tests for scope: getScopeStyleFromBotForInstrument, mappings.
 * Run: npx vitest run src/app/core/scope.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  getScopeStyleFromBotForInstrument,
  STYLE_TO_SCOPE,
  TIMEFRAME_TO_SCOPE,
  getTimeframesForScope,
} from './scope';
import type { BotConfig, Instrument, TradeScope, TradeStyle } from './types';

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

function makeInstrument(overrides: Partial<Instrument> = {}): Instrument {
  return {
    id: 'inst-eur',
    symbol: 'EURUSD',
    type: 'fiat',
    status: 'active',
    brokerId: 'broker-1',
    timeframes: ['M5', 'M15', 'H1'],
    ...overrides,
  };
}

describe('getScopeStyleFromBotForInstrument', () => {
  const inst = makeInstrument({ id: 'inst-eur' });

  it('manual single: fixedScope returns matching scope and style', () => {
    const bots = [makeBot({ instrumentId: 'inst-eur', scopeMode: 'manual', fixedScope: 'scalp' })];
    const { scope, style } = getScopeStyleFromBotForInstrument('inst-eur', bots, [inst]);
    expect(scope).toBe('scalp');
    expect(style).toBe('scalping');
  });

  it('manual single: fixedScope=day returns day scope and style', () => {
    const bots = [makeBot({ instrumentId: 'inst-eur', scopeMode: 'manual', fixedScope: 'day' })];
    const { scope, style } = getScopeStyleFromBotForInstrument('inst-eur', bots, [inst]);
    expect(scope).toBe('day');
    expect(style).toBe('day');
  });

  it('manual single: fixedScope=swing returns swing scope and style', () => {
    const bots = [makeBot({ instrumentId: 'inst-eur', scopeMode: 'manual', fixedScope: 'swing' })];
    const { scope, style } = getScopeStyleFromBotForInstrument('inst-eur', bots, [inst]);
    expect(scope).toBe('swing');
    expect(style).toBe('swing');
  });

  it('manual multi: fixedStyles uses first style and STYLE_TO_SCOPE for scope', () => {
    const bots = [
      makeBot({
        instrumentId: 'inst-eur',
        scopeMode: 'manual',
        fixedScope: undefined,
        fixedStyles: ['scalping', 'day'],
      }),
    ];
    const { scope, style } = getScopeStyleFromBotForInstrument('inst-eur', bots, [inst]);
    expect(style).toBe('scalping');
    expect(scope).toBe('scalp');
  });

  it('auto mode: primary timeframe maps to scope', () => {
    const bots = [
      makeBot({
        instrumentId: 'inst-eur',
        scopeMode: 'auto',
        timeframes: ['M1', 'M5'],
      }),
    ];
    const { scope, style } = getScopeStyleFromBotForInstrument('inst-eur', bots, [inst]);
    expect(scope).toBe('scalp');
    expect(style).toBe('scalping');
  });

  it('auto mode: H4 primary timeframe maps to swing', () => {
    const bots = [
      makeBot({
        instrumentId: 'inst-eur',
        scopeMode: 'auto',
        timeframes: ['H4', 'D1'],
      }),
    ];
    const { scope, style } = getScopeStyleFromBotForInstrument('inst-eur', bots, [inst]);
    expect(scope).toBe('swing');
    expect(style).toBe('swing');
  });

  it('no bot: uses instrument primary timeframe', () => {
    const instruments = [makeInstrument({ id: 'inst-eur', timeframes: ['M15', 'H1'] })];
    const { scope, style } = getScopeStyleFromBotForInstrument('inst-eur', [], instruments);
    expect(scope).toBe('day');
    expect(style).toBe('day');
  });

  it('no bot, no instrument: defaults to M5 → scalp', () => {
    const { scope, style } = getScopeStyleFromBotForInstrument('inst-unknown', [], []);
    expect(scope).toBe('scalp');
    expect(style).toBe('scalping');
  });

  it('instrument not in list: falls back to defaults', () => {
    const instruments = [makeInstrument({ id: 'inst-other' })];
    const { scope, style } = getScopeStyleFromBotForInstrument('inst-eur', [], instruments);
    expect(scope).toBe('scalp');
    expect(style).toBe('scalping');
  });
});

describe('scope mappings', () => {
  it('STYLE_TO_SCOPE maps all TradeStyles to valid scopes', () => {
    const styles: TradeStyle[] = ['scalping', 'day', 'medium_swing', 'swing', 'sniper'];
    const validScopes: TradeScope[] = ['scalp', 'day', 'swing', 'position'];
    for (const style of styles) {
      const scope = STYLE_TO_SCOPE[style];
      expect(validScopes).toContain(scope);
    }
  });

  it('TIMEFRAME_TO_SCOPE maps all timeframes', () => {
    const tfs = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'] as const;
    for (const tf of tfs) {
      const scope = TIMEFRAME_TO_SCOPE[tf];
      expect(['scalp', 'day', 'swing', 'position']).toContain(scope);
    }
  });

  it('getTimeframesForScope returns non-empty arrays', () => {
    const scopes: TradeScope[] = ['scalp', 'day', 'swing', 'position'];
    for (const s of scopes) {
      const tfs = getTimeframesForScope(s);
      expect(tfs.length).toBeGreaterThan(0);
    }
  });
});
