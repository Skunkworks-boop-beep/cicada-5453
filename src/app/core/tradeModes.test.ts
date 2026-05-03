/**
 * TS-side validation parity with Python's validate_order.
 * Mirrors python/tests/test_trade_modes.py — same baseline cases.
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_TRADE_MODES,
  TRADE_MODES,
  getRules,
  validateOrder,
  type OrderSignal,
} from './tradeModes';

function okSignal(style: keyof typeof TRADE_MODES, atr = 1): OrderSignal {
  const r = TRADE_MODES[style];
  const slDist = ((r.minSlAtr + r.maxSlAtr) / 2) * atr;
  const tpDist = (r.minTpAtr + 0.1) * atr;
  return {
    side: 'LONG',
    entryPrice: 100,
    stopLoss: 100 - slDist,
    takeProfit: 100 + tpDist,
    confidence: r.confidenceThreshold + 0.05,
  };
}

describe('TRADE_MODES table', () => {
  it('contains all five styles', () => {
    expect(Object.keys(TRADE_MODES).sort()).toEqual([
      'day', 'medium_swing', 'scalping', 'sniper', 'swing',
    ]);
    expect(ALL_TRADE_MODES).toHaveLength(5);
  });

  it('has unique MT5 magic numbers', () => {
    const magics = new Set(Object.values(TRADE_MODES).map((r) => r.mt5Magic));
    expect(magics.size).toBe(5);
    expect(magics).toEqual(new Set([1001, 1002, 1003, 1004, 1005]));
  });

  it('throws on unknown style via getRules', () => {
    // @ts-expect-error: deliberately invalid style
    expect(() => getRules('nonexistent')).toThrow();
  });
});

describe('validateOrder', () => {
  it.each(['scalping', 'day', 'medium_swing', 'swing', 'sniper'] as const)(
    'baseline %s signal validates', (style) => {
      const r = getRules(style);
      const res = validateOrder(r, okSignal(style), 1, 0, null);
      expect(res.ok).toBe(true);
    },
  );

  it('rejects below confidence threshold', () => {
    const r = getRules('day');
    const s: OrderSignal = { ...okSignal('day'), confidence: r.confidenceThreshold - 0.01 };
    const res = validateOrder(r, s, 1, 0);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('confidence_below_threshold');
  });

  it('rejects when max_concurrent reached', () => {
    const r = getRules('sniper');
    const res = validateOrder(r, okSignal('sniper'), 1, r.maxConcurrent);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('max_concurrent_exceeded');
  });

  it('rejects min-hold not elapsed', () => {
    const r = getRules('scalping');
    const res = validateOrder(r, okSignal('scalping'), 1, 0, r.minHoldBars - 1);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('min_hold_not_elapsed');
  });

  it('rejects TP too tight', () => {
    const r = getRules('day');
    const s: OrderSignal = {
      side: 'LONG',
      entryPrice: 100,
      stopLoss: 100 - r.minSlAtr,
      takeProfit: 100 + (r.minTpAtr - 0.1),
      confidence: r.confidenceThreshold,
    };
    const res = validateOrder(r, s, 1, 0);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('tp_too_tight');
  });

  it('rejects SL too tight', () => {
    const r = getRules('swing');
    const s: OrderSignal = {
      side: 'LONG',
      entryPrice: 100,
      stopLoss: 100 - Math.max(0.01, r.minSlAtr - 0.1),
      takeProfit: 100 + r.minTpAtr,
      confidence: r.confidenceThreshold,
    };
    const res = validateOrder(r, s, 1, 0);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('sl_too_tight');
  });

  it('rejects SL too wide', () => {
    const r = getRules('day');
    const s: OrderSignal = {
      side: 'LONG',
      entryPrice: 100,
      stopLoss: 100 - (r.maxSlAtr + 0.5),
      takeProfit: 100 + r.minTpAtr,
      confidence: r.confidenceThreshold,
    };
    const res = validateOrder(r, s, 1, 0);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('sl_too_wide');
  });

  it('rejects invalid signal at zero ATR', () => {
    const r = getRules('day');
    const res = validateOrder(r, okSignal('day'), 0, 0);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('invalid_signal');
  });
});
