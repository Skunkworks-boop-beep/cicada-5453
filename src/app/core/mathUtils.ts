/**
 * Safe math utilities to avoid division by zero and distorted relative comparisons.
 * Use price-aware divisors instead of generic || 1 or || 1e-10.
 */

/** Minimum divisor for relative price comparisons. Avoids /0; use when price can be 0. */
const MIN_DIVISOR = 1e-10;

/**
 * Safe division: a / b, using eps when b is 0 or not finite.
 * For relative comparisons (e.g. |a-b|/b), use this to avoid division by zero.
 */
export function safeDiv(a: number, b: number, eps: number = MIN_DIVISOR): number {
  const divisor = b && Number.isFinite(b) ? b : eps;
  return a / divisor;
}

/**
 * Relative difference |a - b| / b for tolerance checks.
 * Returns 0 when b is 0 or not finite (no meaningful relative comparison).
 */
export function relativeDiff(a: number, b: number): number {
  if (!b || !Number.isFinite(b)) return 0;
  return Math.abs(a - b) / b;
}
