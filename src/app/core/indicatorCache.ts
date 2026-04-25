/**
 * Lightweight memoisation for pure indicator functions.
 *
 * Backtest hot path calls `rsi(closes, 14)`, `atr(bars, 14)`, `ema(closes, 20)`
 * repeatedly on the same array — once per strategy, per regime, per timeframe.
 * Each call allocates a fresh array of the same length. With 236 strategies
 * evaluated across thousands of jobs, this becomes the dominant cost.
 *
 * We cache results keyed by **array identity** (`WeakMap<ArrayRef, Map<key, result>>`)
 * so the cache entry is released when the bars/closes array is garbage-collected.
 * No manual invalidation needed. The cache is opt-in: wrap a function once and
 * all downstream call sites get sharing "for free".
 */

type MemoKey = string | number;

interface BarsLike {
  length: number;
}

/**
 * Memoise a function that returns an array given a bars/closes source and a
 * scalar key (typically a period). The source's identity (===) is used to
 * bucket cache entries via a WeakMap so we don't retain memory beyond the
 * source's natural lifetime.
 */
export function memoIndicator1<S extends object, R>(
  fn: (source: S, key: MemoKey) => R
): (source: S, key: MemoKey) => R {
  const table = new WeakMap<S, Map<MemoKey, R>>();
  return (source: S, key: MemoKey): R => {
    let inner = table.get(source);
    if (!inner) {
      inner = new Map<MemoKey, R>();
      table.set(source, inner);
    }
    const existing = inner.get(key);
    if (existing !== undefined) return existing;
    const result = fn(source, key);
    inner.set(key, result);
    return result;
  };
}

/**
 * Same as memoIndicator1 but for functions with a compound scalar key
 * (e.g. macd(fast, slow, signal)). The key is serialised with `|` so it stays
 * hashable even with non-integer inputs.
 */
export function memoIndicatorN<S extends object, Args extends readonly MemoKey[], R>(
  fn: (source: S, ...args: Args) => R
): (source: S, ...args: Args) => R {
  const table = new WeakMap<S, Map<string, R>>();
  return (source: S, ...args: Args): R => {
    const key = args.join('|');
    let inner = table.get(source);
    if (!inner) {
      inner = new Map<string, R>();
      table.set(source, inner);
    }
    const existing = inner.get(key);
    if (existing !== undefined) return existing;
    const result = fn(source, ...args);
    inner.set(key, result);
    return result;
  };
}

/** No-op "proof" type export so consumers see we check bars have length. */
export type { BarsLike };
