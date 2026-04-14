/**
 * Rebuild interval presets for NN bot retraining.
 * Used per-instrument and collectively (apply to all).
 */

export const REBUILD_INTERVAL_PRESETS = [
  { label: '12h', hours: 12 },
  { label: '24h', hours: 24 },
  { label: '48h', hours: 48 },
  { label: '3 days', hours: 72 },
  { label: '1 week', hours: 168 },
  { label: '2 weeks', hours: 336 },
  { label: '1 month', hours: 30 * 24 },
  { label: '2 months', hours: 60 * 24 },
  { label: '3 months', hours: 90 * 24 },
  { label: '6 months', hours: 180 * 24 },
  { label: '1 year', hours: 365 * 24 },
] as const;

export type RebuildIntervalPreset = (typeof REBUILD_INTERVAL_PRESETS)[number];

export const DEFAULT_REBUILD_HOURS = 168; // 1 week

/** Format interval hours for display (e.g. "1 week", "3 days") */
export function formatRebuildInterval(hours: number): string {
  const preset = REBUILD_INTERVAL_PRESETS.find((p) => p.hours === hours);
  if (preset) return preset.label;
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days} day${days !== 1 ? 's' : ''}`;
}
