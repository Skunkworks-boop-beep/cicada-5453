/**
 * Rebuild scheduler: per-instrument periodic rebuild.
 * Decides when to rebuild which bot (periodic, regime change, manual, performance drop).
 */

import type { RebuildScheduleEntry } from './types';
import type { Instrument } from './types';
import type { BotConfig } from './types';
import { DEFAULT_REBUILD_HOURS } from './rebuildInterval';

/** Only bots that have actually been built (ready, deployed, or outdated with nnFeatureVector) get a schedule entry. */
export function buildScheduleFromInstrumentsAndBots(
  instruments: Instrument[],
  bots: BotConfig[]
): RebuildScheduleEntry[] {
  const now = new Date();
  const entries: RebuildScheduleEntry[] = [];
  const isActuallyBuilt = (b: BotConfig) =>
    b.status === 'ready' ||
    b.status === 'deployed' ||
    (b.status === 'outdated' && (b.nnFeatureVector?.length ?? 0) > 0);
  for (const inst of instruments) {
    if (inst.status !== 'active') continue;
    const bot = bots.find((b) => b.instrumentId === inst.id);
    if (!bot || !isActuallyBuilt(bot)) continue;
    const intervalHours = inst.rebuildIntervalHours ?? DEFAULT_REBUILD_HOURS;
    const nextRun = bot.nextRebuildAt
      ? new Date(bot.nextRebuildAt)
      : (() => {
          const n = new Date(now);
          n.setHours(n.getHours() + intervalHours);
          return n;
        })();
    entries.push({
      instrumentId: inst.id,
      instrumentSymbol: inst.symbol,
      nextRunAt: nextRun.toISOString(),
      intervalHours,
      reason: bot.driftDetectedAt ? 'drift' : (bot.status === 'outdated' ? 'performance_drop' : 'periodic'),
    });
  }
  return entries;
}

export function getNextDueRebuilds(
  schedule: RebuildScheduleEntry[],
  withinMinutes: number = 60
): RebuildScheduleEntry[] {
  const cutoff = new Date();
  cutoff.setMinutes(cutoff.getMinutes() + withinMinutes);
  return schedule.filter((e) => new Date(e.nextRunAt) <= cutoff);
}
