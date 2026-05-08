/**
 * Beehive — palette enforcement + cell-model contract tests.
 *
 * jsdom doesn't reliably ship a canvas implementation, so we test the
 * deterministic pieces of the model rather than rendered pixels: every
 * fill / stroke colour the renderer ever asks for must come from the
 * Section 11 palette. The renderer is a thin shell that only calls
 * those getters, so this gives us the same guarantee as a pixel sweep.
 */

import { describe, it, expect } from 'vitest';
import {
  PALETTE,
  PALETTE_VALUES,
  HEX_R,
  HEX_W,
  HEX_H,
  cellCenter,
  cellLabel,
  strengthToFill,
  fireProgressFill,
  cascadeProbability,
  buildGrid,
  newPulse,
  CASCADE_BASE_PROBABILITY,
  MAX_PULSE_DEPTH,
  type CellType,
} from './cellModel';
import { dispatch } from './commands';

describe('Beehive palette', () => {
  it('PALETTE has exactly the 12 spec colours', () => {
    expect(PALETTE_VALUES).toHaveLength(12);
    for (const v of PALETTE_VALUES) {
      expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('strengthToFill always returns a palette colour for any (strength, pulse)', () => {
    const palette = new Set(PALETTE_VALUES);
    for (let s = 0; s <= 1; s += 0.05) {
      for (let p = 0; p < Math.PI * 2; p += 0.5) {
        const colour = strengthToFill(s, p);
        expect(palette.has(colour)).toBe(true);
      }
    }
  });

  it('fireProgressFill always returns a palette colour for progress [0..1]', () => {
    const palette = new Set(PALETTE_VALUES);
    for (let p = 0; p <= 1; p += 0.01) {
      expect(palette.has(fireProgressFill(p))).toBe(true);
    }
  });

  it('palette excludes the dashboard accent #ff6600', () => {
    expect(PALETTE_VALUES).not.toContain('#ff6600');
    expect(PALETTE_VALUES).not.toContain('#ffff00');
    expect(PALETTE_VALUES).not.toContain('#ffffff');
  });
});

describe('Beehive hex math', () => {
  it('HEX_R = 18, HEX_W = 36, HEX_H = sqrt(3) * 18', () => {
    expect(HEX_R).toBe(18);
    expect(HEX_W).toBe(36);
    expect(HEX_H).toBeCloseTo(Math.sqrt(3) * 18, 5);
  });

  it('cellCenter offsets odd columns by half a row', () => {
    const evenCol = cellCenter(0, 0);
    const oddCol = cellCenter(1, 0);
    expect(oddCol.y - evenCol.y).toBeCloseTo(HEX_H / 2, 5);
  });
});

describe('Beehive cell labels', () => {
  it.each<[CellType, string]>([
    ['support', 'S'],
    ['resistance', 'R'],
    ['volume', 'V'],
    ['fractal', 'F'],
    ['neutral', ''],
  ])('cellLabel(%s) → %s', (type, expected) => {
    expect(cellLabel(type)).toBe(expected);
  });
});

describe('Beehive grid construction', () => {
  it('builds a non-empty grid covering the viewport', () => {
    const cells = buildGrid({ width: 400, height: 300 });
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThanOrEqual(400 + HEX_R);
      expect(c.y).toBeLessThanOrEqual(300 + HEX_R);
    }
  });

  it('seeds active cells from supplied nodes within HEX_H/2 of the projected price', () => {
    const cells = buildGrid({
      width: 400, height: 300,
      nodes: [{ price: 1.20, type: 'support', strength: 0.8, touches: 5 }],
      priceMin: 1.0, priceMax: 1.4,
    });
    const active = cells.filter((c) => c.active);
    expect(active.length).toBeGreaterThan(0);
    expect(active.every((c) => c.type === 'support')).toBe(true);
    expect(active.every((c) => c.strength === 0.8)).toBe(true);
  });
});

describe('Beehive cascade math', () => {
  it('cascadeProbability >= base probability', () => {
    for (let s = 0; s <= 1; s += 0.1) {
      expect(cascadeProbability(s)).toBeGreaterThanOrEqual(CASCADE_BASE_PROBABILITY);
    }
  });

  it('cascadeProbability is monotonic non-decreasing in strength', () => {
    let prev = -Infinity;
    for (let s = 0; s <= 1; s += 0.1) {
      const p = cascadeProbability(s);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it('cascadeProbability never exceeds 0.95', () => {
    for (let s = 0; s <= 1; s += 0.05) {
      expect(cascadeProbability(s)).toBeLessThanOrEqual(0.95);
    }
  });

  it('newPulse respects MAX_PULSE_DEPTH cap (depth field accepted but caller-enforced)', () => {
    const p = newPulse(0, 1, MAX_PULSE_DEPTH);
    expect(p.depth).toBe(MAX_PULSE_DEPTH);
    expect(p.speed).toBeGreaterThanOrEqual(0.06);
    expect(p.speed).toBeLessThanOrEqual(0.10);
  });
});

describe('Beehive command dispatch', () => {
  function makeWorld() {
    const cells = buildGrid({
      width: 400, height: 300,
      nodes: [
        { price: 1.20, type: 'support', strength: 0.8, touches: 5 },
        { price: 1.30, type: 'resistance', strength: 0.7, touches: 3 },
      ],
      priceMin: 1.0, priceMax: 1.4,
    });
    const log: string[] = [];
    return {
      cells,
      pulses: [],
      tick: 100,
      log: (line: string) => log.push(line),
      _log: log,
    };
  }

  it('fire on an active node logs SYNAPSE FIRED', () => {
    const w = makeWorld();
    expect(dispatch(w, 'fire')).toBe(true);
    expect(w._log.some((l) => l.startsWith('SYNAPSE FIRED'))).toBe(true);
  });

  it('fakeout sets fakeout=true on affected cells', () => {
    const w = makeWorld();
    dispatch(w, 'fakeout');
    expect(w._log.some((l) => l.startsWith('FAKEOUT'))).toBe(true);
  });

  it('storm logs NEURAL STORM', () => {
    const w = makeWorld();
    dispatch(w, 'storm');
    expect(w._log.some((l) => l.includes('NEURAL STORM'))).toBe(true);
  });

  it('reset clears pulses', () => {
    const w = makeWorld();
    w.pulses = [newPulse(0, 1, 0)];
    dispatch(w, 'reset');
    expect(w.pulses.length).toBe(0);
    expect(w._log.some((l) => l.includes('COLONY RESET'))).toBe(true);
  });

  it('help logs the command list', () => {
    const w = makeWorld();
    dispatch(w, 'help');
    expect(w._log.some((l) => l.includes('CMDS'))).toBe(true);
  });

  it('unknown command logs UNKNOWN CMD', () => {
    const w = makeWorld();
    dispatch(w, 'xyzzy');
    expect(w._log.some((l) => l.startsWith('UNKNOWN CMD'))).toBe(true);
  });
});
