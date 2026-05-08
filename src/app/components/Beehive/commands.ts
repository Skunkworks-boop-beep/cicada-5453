/**
 * Beehive terminal commands — Section 11 lines 805-832.
 *
 * Each handler mutates the world state in place. The component re-renders
 * each frame so visible side-effects are immediate.
 */

import {
  type Cell,
  type Pulse,
  newPulse,
  FIRE_DURATION_TICKS,
  FAKEOUT_DURATION_TICKS,
} from './cellModel';

export interface BeehiveWorld {
  cells: Cell[];
  pulses: Pulse[];
  tick: number;
  log: (line: string) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────

function activeNonNeutralIndices(cells: Cell[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    if (c.active && c.type !== 'neutral') out.push(i);
  }
  return out;
}

function pickRandom<T>(arr: T[]): T | null {
  if (arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)] ?? null;
}

function fireCell(world: BeehiveWorld, idx: number): void {
  const c = world.cells[idx];
  if (!c) return;
  c.fireTime = world.tick;
  c.fireDur = FIRE_DURATION_TICKS;
  // Spawn pulses to neighbours; cascade decisions happen on pulse arrival.
  for (const n of c.neighbors) {
    world.pulses.push(newPulse(idx, n, 0));
  }
}

// ── Commands ──────────────────────────────────────────────────────────

/** ``fire`` — trigger one random active non-neutral node + cascade. */
export function cmdFire(world: BeehiveWorld): void {
  const candidates = activeNonNeutralIndices(world.cells);
  const idx = pickRandom(candidates);
  if (idx == null) {
    world.log('NO ACTIVE NODES TO FIRE');
    return;
  }
  fireCell(world, idx);
  const c = world.cells[idx]!;
  world.log(`SYNAPSE FIRED · ${c.type.toUpperCase()} · LEVEL ${c.level}`);
}

/** ``fakeout`` — pick a random level, mark 50% of its active cells as
 *  fakeout=true, fire them. Auto-resolve after FAKEOUT_DURATION_TICKS. */
export function cmdFakeout(world: BeehiveWorld): void {
  const level = Math.floor(Math.random() * 8);
  const candidates: number[] = [];
  for (let i = 0; i < world.cells.length; i++) {
    const c = world.cells[i]!;
    if (c.active && c.level === level) candidates.push(i);
  }
  if (candidates.length === 0) {
    world.log(`FAKEOUT · LEVEL ${level} · NO ACTIVE NODES`);
    return;
  }
  const half = Math.max(1, Math.floor(candidates.length * 0.5));
  // Shuffle and take the first half deterministically per call.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
  }
  const affected = candidates.slice(0, half);
  for (const idx of affected) {
    const c = world.cells[idx]!;
    c.fakeout = true;
    c.fakeoutClearTick = world.tick + FAKEOUT_DURATION_TICKS;
    fireCell(world, idx);
  }
  world.log(`FAKEOUT · LEVEL ${level} · ${affected.length} NODES AFFECTED`);
}

/** ``storm`` — 12 rapid sequential random fires, ~90ms apart (we
 *  schedule them as a tick-spaced burst the render loop drains). */
export function cmdStorm(world: BeehiveWorld): void {
  const candidates = activeNonNeutralIndices(world.cells);
  if (candidates.length === 0) {
    world.log('NEURAL STORM · NO ACTIVE NODES');
    return;
  }
  // Stage 12 random fires, spread across the next 12 frames so the
  // animation is visually distinct from a single firework burst.
  for (let n = 0; n < 12; n++) {
    const idx = candidates[Math.floor(Math.random() * candidates.length)]!;
    // Schedule by setting fireTime to now+offset; the renderer treats any
    // fireTime > tick as "scheduled to ignite".
    const c = world.cells[idx]!;
    c.fireTime = world.tick + n;
    c.fireDur = FIRE_DURATION_TICKS;
  }
  world.log('NEURAL STORM · 12 CASCADES INITIATED');
}

/** ``reset`` — clear all cells + pulses; the caller rebuilds the grid. */
export function cmdReset(world: BeehiveWorld): void {
  world.pulses.length = 0;
  for (const c of world.cells) {
    c.fireTime = -9999;
    c.fakeout = false;
    c.fakeoutClearTick = -9999;
  }
  world.log('MAP REBUILT · COLONY RESET');
}

/** ``help`` — list the commands. */
export function cmdHelp(world: BeehiveWorld): void {
  world.log('CMDS: fire · fakeout · storm · reset');
}

/** Dispatch by name. Unknown command logs and returns false. */
export function dispatch(world: BeehiveWorld, raw: string): boolean {
  const name = raw.trim().toLowerCase();
  switch (name) {
    case 'fire': cmdFire(world); return true;
    case 'fakeout': cmdFakeout(world); return true;
    case 'storm': cmdStorm(world); return true;
    case 'reset': cmdReset(world); return true;
    case 'help': cmdHelp(world); return true;
    case '': return false;
    default:
      world.log(`UNKNOWN CMD: ${raw}`);
      return false;
  }
}
