import { describe, it, expect } from 'vitest';
import { computeLiveTradeCosts, computeNetLivePnl } from './tradePnl';

describe('computeLiveTradeCosts', () => {
  it('charges per-type commission and slippage on a winning long forex trade', () => {
    const costs = computeLiveTradeCosts({
      type: 'LONG',
      size: 1,
      entryPrice: 1.10,
      exitPrice: 1.12,
      holdBars: 12,
      timeframe: 'H1',
      instrumentType: 'fiat',
      exitReason: 'signal',
    });
    // Commission ≈ 1.10 * 5e-5 = 5.5e-5; slippage ≈ 1.10 * 3e-5 = 3.3e-5; swap negative.
    expect(costs.commission).toBeGreaterThan(0);
    expect(costs.slippage).toBeGreaterThan(0);
    expect(costs.total).toBeGreaterThan(0);
  });

  it('uses larger slippage on stop/target fills than on signal fills', () => {
    const a = computeLiveTradeCosts({
      type: 'SHORT',
      size: 1,
      entryPrice: 100,
      exitPrice: 99,
      holdBars: 4,
      timeframe: 'M5',
      instrumentType: 'crypto',
      exitReason: 'signal',
    });
    const b = computeLiveTradeCosts({
      type: 'SHORT',
      size: 1,
      entryPrice: 100,
      exitPrice: 99,
      holdBars: 4,
      timeframe: 'M5',
      instrumentType: 'crypto',
      exitReason: 'stop',
    });
    expect(b.slippage).toBeGreaterThan(a.slippage);
  });

  it('synthetic_deriv has zero commission/swap', () => {
    const costs = computeLiveTradeCosts({
      type: 'LONG',
      size: 1,
      entryPrice: 100,
      exitPrice: 101,
      holdBars: 5,
      timeframe: 'M5',
      instrumentType: 'synthetic_deriv',
      exitReason: 'signal',
    });
    expect(costs.commission).toBe(0);
    expect(costs.swap).toBe(0);
  });
});

describe('computeNetLivePnl', () => {
  it('net pnl is gross pnl minus the cost block', () => {
    const r = computeNetLivePnl({
      type: 'LONG',
      size: 10,
      entryPrice: 100,
      exitPrice: 102,
      holdBars: 6,
      timeframe: 'H1',
      instrumentType: 'fiat',
      exitReason: 'signal',
    });
    expect(r.grossPnl).toBeCloseTo(20, 5);
    expect(r.netPnl).toBeLessThanOrEqual(r.grossPnl);
    expect(r.notional).toBeGreaterThan(0);
    expect(Number.isFinite(r.pnlPercent)).toBe(true);
  });

  it('honours balanceAtEntry as the percent basis', () => {
    const balanceBased = computeNetLivePnl(
      {
        type: 'LONG',
        size: 1,
        entryPrice: 100,
        exitPrice: 110,
        holdBars: 1,
        timeframe: 'M5',
        instrumentType: 'synthetic_deriv',
        exitReason: 'signal',
      },
      { balanceAtEntry: 1000 }
    );
    expect(balanceBased.notional).toBe(1000);
    expect(balanceBased.pnlPercent).toBeCloseTo(1, 1); // ~1% of 1000
  });
});
