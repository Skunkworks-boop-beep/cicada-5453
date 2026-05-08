/**
 * Beehive cell data model — Section 11 of the spec, lines 666-712.
 *
 * Strict palette enforcement: every colour the Beehive ever paints lives
 * in PALETTE below. Tests assert that no other RGB value appears in any
 * rendered frame. The dashboard's #ff6600 is forbidden inside the hive.
 */

// ── Palette (Section 11 lines 642-655) ────────────────────────────────

export const PALETTE = {
  inactive: '#020d02',
  dim: '#031503',
  weak: '#041e04',
  borderDefault: '#062806',
  medium: '#0a3d0a',
  active: '#0d520d',
  strong: '#116611',
  veryStrong: '#158015',
  nearFiring: '#1aaa1a',
  firing: '#1aff1a',
  labelDefault: '#0a6a0a',
  dimText: '#0a3a0a',
} as const;

/** All hex codes the renderer is permitted to write. The render-contract
 *  test sweeps frame pixels and asserts membership against this set. */
export const PALETTE_VALUES: readonly string[] = Object.values(PALETTE);

// ── Hex grid math (Section 11 lines 656-665) ──────────────────────────

export const HEX_R = 18;
export const HEX_W = HEX_R * 2;
export const HEX_H = Math.sqrt(3) * HEX_R;

export function cellCenter(col: number, row: number): { x: number; y: number } {
  return {
    x: col * HEX_W * 0.75 + HEX_R,
    y: row * HEX_H + (col % 2 === 0 ? 0 : HEX_H / 2) + HEX_H / 2,
  };
}

// ── Cell type + state ─────────────────────────────────────────────────

export type CellType = 'support' | 'resistance' | 'volume' | 'fractal' | 'neutral';

export type CellOutcome = 'win' | 'loss' | 'neutral';

export interface Cell {
  col: number;
  row: number;
  x: number;
  y: number;
  type: CellType;
  /** 0-7 — vertical band; the Y-position rounded to the spec's 8 levels. */
  level: number;
  /** True when the cell maps to a real S/R / volume / fractal node. */
  active: boolean;
  /** 0-1 — node strength from the geometric map. Drives idle fill brightness. */
  strength: number;
  /** Tick at which the cell last fired (-9999 if never). */
  fireTime: number;
  /** Duration (ticks) of the fire animation. */
  fireDur: number;
  /** Idle breathing oscillator — modulates fill brightness ±1 shade. */
  pulse: number;
  /** Per-cell oscillator speed. Random-init so cells breathe out of phase. */
  pulseSpd: number;
  /** Optional outcome label for the hover probe — set from context layer. */
  outcome: CellOutcome;
  /** Historical touch count at this price coordinate. */
  touches: number;
  /** Per-coordinate fields from the execution-quality map. */
  spread: number;
  slippage: number;
  /** Lookback features the hover probe surfaces. */
  momentum: number;
  volume: number;
  atr: number;
  /** True when the cell is currently in fakeout state (after `fakeout` cmd
   *  or emergent detection). Auto-clears after FAKEOUT_DURATION_TICKS. */
  fakeout: boolean;
  fakeoutClearTick: number;
  /** Adjacent hexagons (indices into the cell list). */
  neighbors: number[];
}

export const FIRE_DURATION_TICKS = 30;
export const FAKEOUT_DURATION_TICKS = 180; // ~3000ms at 60fps

// ── Cell label (Section 11 line 569: S / R / V / F) ───────────────────

export function cellLabel(type: CellType): string {
  switch (type) {
    case 'support': return 'S';
    case 'resistance': return 'R';
    case 'volume': return 'V';
    case 'fractal': return 'F';
    default: return '';
  }
}

// ── Strength → fill colour (idle node) ────────────────────────────────

/** Map a 0-1 strength + breathing oscillator to one of the palette shades.
 *  The output is always one of the palette hex codes (no interpolated
 *  colours), satisfying the strict-palette rule. */
export function strengthToFill(strength: number, pulse: number): string {
  // Breathing: shift index by ±1 over the pulse cycle.
  const shades = [PALETTE.dim, PALETTE.weak, PALETTE.medium, PALETTE.active, PALETTE.strong, PALETTE.veryStrong];
  const base = Math.min(shades.length - 1, Math.max(0, Math.round(strength * (shades.length - 1))));
  const breath = Math.sin(pulse) >= 0 ? 1 : -1;
  const idx = Math.min(shades.length - 1, Math.max(0, base + breath));
  return shades[idx]!;
}

/** Map fire-progress (0-1, 1 = just fired) to a palette shade. */
export function fireProgressFill(progressFromIgnition: number): string {
  // Section 11 line 700: #1aff1a → #1aaa1a → #158015 → #116611 over fireDur.
  if (progressFromIgnition < 0.25) return PALETTE.firing;
  if (progressFromIgnition < 0.5) return PALETTE.nearFiring;
  if (progressFromIgnition < 0.75) return PALETTE.veryStrong;
  return PALETTE.strong;
}

// ── Hex grid construction ─────────────────────────────────────────────

export interface GridOptions {
  width: number;
  height: number;
  /** Optional list of nodes from /map/geometric/{symbol}; when supplied,
   *  cells overlapping a node are activated with the node's strength. */
  nodes?: Array<{ price: number; type: CellType; strength: number; touches?: number }>;
  /** Price-axis bounds used to map node prices to vertical bands. */
  priceMin?: number;
  priceMax?: number;
}

export function buildGrid(opts: GridOptions): Cell[] {
  const cols = Math.ceil(opts.width / (HEX_W * 0.75));
  const rows = Math.ceil(opts.height / HEX_H);
  const cells: Cell[] = [];
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      const { x, y } = cellCenter(col, row);
      if (x > opts.width + HEX_R || y > opts.height + HEX_R) continue;
      const level = Math.floor((y / opts.height) * 8);
      cells.push({
        col, row, x, y,
        type: 'neutral',
        level: Math.min(7, Math.max(0, level)),
        active: false,
        strength: 0,
        fireTime: -9999,
        fireDur: FIRE_DURATION_TICKS,
        pulse: Math.random() * Math.PI * 2,
        pulseSpd: 0.02 + Math.random() * 0.04,
        outcome: 'neutral',
        touches: 0,
        spread: 0,
        slippage: 0,
        momentum: 0,
        volume: 0,
        atr: 0,
        fakeout: false,
        fakeoutClearTick: -9999,
        neighbors: [],
      });
    }
  }

  // Compute neighbor indices — cells within ~1.05 × HEX_W of each other.
  const dThresh2 = (HEX_W * 1.05) ** 2;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    for (let j = i + 1; j < cells.length; j++) {
      const o = cells[j]!;
      const dx = c.x - o.x;
      const dy = c.y - o.y;
      if (dx * dx + dy * dy <= dThresh2) {
        c.neighbors.push(j);
        o.neighbors.push(i);
      }
    }
  }

  // Project nodes from /map/geometric/{symbol} onto vertical bands.
  const nodes = opts.nodes ?? [];
  if (nodes.length > 0 && opts.priceMin != null && opts.priceMax != null) {
    const range = opts.priceMax - opts.priceMin;
    if (range > 0) {
      for (const node of nodes) {
        const py = opts.height * (1 - (node.price - opts.priceMin) / range);
        // Activate every cell within ±HEX_H/2 of this y.
        for (const c of cells) {
          if (Math.abs(c.y - py) <= HEX_H / 2) {
            c.active = true;
            c.type = node.type;
            c.strength = Math.max(c.strength, Math.min(1, Math.max(0, node.strength)));
            c.touches = Math.max(c.touches, node.touches ?? 0);
          }
        }
      }
    }
  }

  return cells;
}

// ── Pulse (in-flight cascade) ─────────────────────────────────────────

export interface Pulse {
  fromIdx: number;
  toIdx: number;
  /** 0..1, advances per tick by ``speed``. */
  progress: number;
  speed: number;
  depth: number;
}

export const MAX_PULSE_DEPTH = 5;

export function newPulse(fromIdx: number, toIdx: number, depth: number): Pulse {
  return {
    fromIdx,
    toIdx,
    progress: 0,
    speed: 0.06 + Math.random() * 0.04,
    depth,
  };
}

export const CASCADE_BASE_PROBABILITY = 0.28;

/** Probability a fired cell triggers a fired neighbour. Strength bonus
 *  per spec line 717. */
export function cascadeProbability(strength: number): number {
  return Math.min(0.95, CASCADE_BASE_PROBABILITY + 0.3 * strength);
}
