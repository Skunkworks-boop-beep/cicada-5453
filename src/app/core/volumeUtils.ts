/**
 * Dynamic lot/volume sizing for broker orders.
 * Supports instrument-specific min, max, step. When min > step, rounds open size
 * to min + step so partial close can leave the smallest remainder (e.g. open 0.51
 * when min is 0.5, then close 0.5 leaving 0.01).
 */

/** Default volume constraints when instrument has none. Most MT5/Exness allow 0.01–100, step 0.01. */
export const DEFAULT_VOLUME_MIN = 0.01;
export const DEFAULT_VOLUME_MAX = 100;
export const DEFAULT_VOLUME_STEP = 0.01;

export interface VolumeConstraints {
  min: number;
  max: number;
  step: number;
}

/** Round value to nearest step, handling float precision. */
function roundToStep(value: number, step: number): number {
  if (step <= 0 || !Number.isFinite(step)) return value;
  const decimals = step < 1 ? String(step).split('.')[1]?.length ?? 2 : 0;
  const factor = Math.pow(10, decimals);
  return Math.round((value / step) * factor) / factor * step;
}

/**
 * Round volume to instrument constraints. Clamps to [min, max], rounds to step.
 * When computed size would round to exactly min, returns min + step so a partial
 * close can leave the smallest remainder (e.g. open 0.51 when min=0.5, close 0.5, leave 0.01).
 */
export function roundVolumeForOrder(
  size: number,
  constraints: VolumeConstraints
): number {
  const r = computeVolumeForOrder(size, constraints);
  return r.openVolume;
}

/** Result of volume computation: open volume, optional partial close, and target size to hold. */
export interface VolumeForOrderResult {
  openVolume: number;
  partialCloseVolume?: number;
  targetSize: number;
}

/**
 * When target < min: open min + target, then partially close min, leaving target.
 * Otherwise: open rounded/clamped size, no partial close.
 */
export function computeVolumeForOrder(
  size: number,
  constraints: VolumeConstraints
): VolumeForOrderResult {
  const { min, max, step } = constraints;
  if (!Number.isFinite(size) || size <= 0) {
    return { openVolume: min, targetSize: min };
  }
  const targetRounded = roundToStep(size, step);
  const targetClamped = Math.max(0, Math.min(max, targetRounded));

  // When target < min: open min + target, close min, leave target (e.g. target 0.07, min 0.5 → open 0.57, close 0.5, leave 0.07)
  if (targetClamped > 0 && targetClamped < min && min + targetClamped <= max) {
    const openVol = roundToStep(min + targetClamped, step);
    return {
      openVolume: openVol,
      partialCloseVolume: roundToStep(min, step),
      targetSize: roundToStep(targetClamped, step),
    };
  }

  const rounded = roundToStep(size, step);
  const clamped = Math.max(min, Math.min(max, rounded));
  return {
    openVolume: roundToStep(clamped, step),
    targetSize: roundToStep(clamped, step),
  };
}

/**
 * Get volume constraints for an instrument. Uses instrument overrides or defaults.
 */
export function getVolumeConstraints(instrument?: {
  volumeMin?: number;
  volumeMax?: number;
  volumeStep?: number;
} | null): VolumeConstraints {
  if (!instrument) {
    return { min: DEFAULT_VOLUME_MIN, max: DEFAULT_VOLUME_MAX, step: DEFAULT_VOLUME_STEP };
  }
  const min = instrument.volumeMin ?? DEFAULT_VOLUME_MIN;
  const max = instrument.volumeMax ?? DEFAULT_VOLUME_MAX;
  const step = instrument.volumeStep ?? DEFAULT_VOLUME_STEP;
  return {
    min: Number.isFinite(min) && min > 0 ? min : DEFAULT_VOLUME_MIN,
    max: Number.isFinite(max) && max > 0 ? max : DEFAULT_VOLUME_MAX,
    step: Number.isFinite(step) && step > 0 ? step : DEFAULT_VOLUME_STEP,
  };
}
