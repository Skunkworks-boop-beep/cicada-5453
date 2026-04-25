import { describe, it, expect } from 'vitest';
import { getAllStrategies } from './registries';
import {
  classifyStrategy,
  getAdaptiveDefaults,
  buildAdaptationMatrix,
} from './strategyAdaptations';

describe('classifyStrategy', () => {
  it('classifies common indicators correctly', () => {
    expect(classifyStrategy('ind-ema-cross-50-200')).toBe('trend');
    expect(classifyStrategy('ind-rsi-overbought')).toBe('mean_reversion');
    expect(classifyStrategy('ind-bb-squeeze')).toBe('breakout');
    expect(classifyStrategy('ind-macd-hist-div')).toBe('mean_reversion');
    expect(classifyStrategy('ind-atr-breakout')).toBe('breakout');
    expect(classifyStrategy('ind-bb-walk')).toBe('volatility');
    expect(classifyStrategy('cs-engulfing-bull')).toBe('candle');
    expect(classifyStrategy('cp-double-top')).toBe('pattern');
    expect(classifyStrategy('pa-fvg')).toBe('price_action');
  });
});

describe('getAdaptiveDefaults', () => {
  it('returns wider stops for synthetic indices than for forex', () => {
    const rsiFiat = getAdaptiveDefaults('ind-rsi-overbought', 'fiat');
    const rsiR10 = getAdaptiveDefaults('ind-rsi-overbought', 'volatility_deriv');
    expect(rsiR10.stopLossPct).toBeGreaterThan(rsiFiat.stopLossPct);
    expect(rsiR10.riskPerTradePct).toBeLessThan(rsiFiat.riskPerTradePct);
  });

  it('breakout strategies on crypto get wider stops + bigger TP', () => {
    const fxBreak = getAdaptiveDefaults('ind-bb-squeeze', 'fiat');
    const cryptoBreak = getAdaptiveDefaults('ind-bb-squeeze', 'crypto');
    expect(cryptoBreak.stopLossPct).toBeGreaterThan(fxBreak.stopLossPct);
    expect(cryptoBreak.takeProfitR).toBeGreaterThanOrEqual(fxBreak.takeProfitR);
  });

  it('marks pattern strategies as not recommended on crash/boom', () => {
    const cb = getAdaptiveDefaults('cp-head-shoulders', 'crash_boom');
    expect(cb.recommended).toBe(false);
  });
});

describe('buildAdaptationMatrix', () => {
  it('emits a row for every registered strategy with all 9 instrument types', () => {
    const ids = getAllStrategies().map((s) => s.id);
    const matrix = buildAdaptationMatrix(ids);
    expect(matrix.length).toBe(ids.length);
    for (const row of matrix.slice(0, 5)) {
      expect(Object.keys(row.perInstrument).length).toBe(9);
      for (const cell of Object.values(row.perInstrument)) {
        expect(cell.stopLossPct).toBeGreaterThan(0);
        expect(cell.riskPerTradePct).toBeGreaterThan(0);
        expect(cell.takeProfitR).toBeGreaterThan(0);
        expect(cell.preferredTimeframes.length).toBeGreaterThan(0);
      }
    }
  });

  it('classifies the full registry without "mixed" exceeding a small fraction', () => {
    const ids = getAllStrategies().map((s) => s.id);
    const matrix = buildAdaptationMatrix(ids);
    const mixed = matrix.filter((m) => m.family === 'mixed').length;
    // We tolerate <10% mixed (some intentionally generic strategies); above that
    // signals the classifier needs new keywords.
    expect(mixed / matrix.length).toBeLessThan(0.1);
  });
});
