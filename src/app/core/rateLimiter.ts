/**
 * Token-bucket rate limiter.
 *
 * Built because the existing Deriv "min delay between requests" throttle did
 * not enforce the actual per-minute caps — a 350 ms gap is 2.86 req/s, but
 * Deriv's documented `ticks_history` cap is 50/min ≈ 0.83 req/s sustained.
 * Sustained polling for 17 s would overrun the limit and trigger the
 * "RateLimit" error the user has been hitting.
 *
 * The token bucket lets short bursts through (up to ``burst`` tokens) but
 * caps the *sustained* rate at ``ratePerSecond``. Callers ``await acquire()``
 * before sending a request; the limiter sleeps as long as needed to honour
 * the budget.
 *
 * Limits in this file come from the Deriv API docs (https://api.deriv.com)
 * and the MT5 client docs (no published rate limit; we use a conservative
 * 10 req/s default).
 */

export interface RateLimitOptions {
  /** Sustained max rate (requests / second). */
  ratePerSecond: number;
  /** Maximum burst the bucket can hold (defaults to ceil(ratePerSecond)). */
  burst?: number;
  /** Friendly name for logs. */
  name?: string;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly name: string;

  constructor(opts: RateLimitOptions) {
    this.capacity = Math.max(1, Math.ceil(opts.burst ?? opts.ratePerSecond));
    this.tokens = this.capacity;
    this.refillPerMs = Math.max(0, opts.ratePerSecond) / 1000;
    this.lastRefill = Date.now();
    this.name = opts.name ?? 'rate-limiter';
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  /**
   * Block until 1 token is available, then consume it. Resolves with the
   * approximate wait in ms (useful for logging).
   */
  async acquire(): Promise<number> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const tokensNeeded = 1 - this.tokens;
    const waitMs = Math.max(1, Math.ceil(tokensNeeded / this.refillPerMs));
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
    return waitMs;
  }

  /** Try to acquire without waiting. Returns true on success. */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Diagnostic snapshot for the process monitor / debug overlays. */
  snapshot(): { name: string; tokens: number; capacity: number; ratePerSecond: number } {
    this.refill();
    return {
      name: this.name,
      tokens: this.tokens,
      capacity: this.capacity,
      ratePerSecond: this.refillPerMs * 1000,
    };
  }
}

const _registry = new Map<string, TokenBucket>();

/** Get-or-create a named bucket. Subsequent calls return the same instance. */
export function getRateLimiter(name: string, opts: Omit<RateLimitOptions, 'name'>): TokenBucket {
  const existing = _registry.get(name);
  if (existing) return existing;
  const bucket = new TokenBucket({ name, ...opts });
  _registry.set(name, bucket);
  return bucket;
}

/** Snapshot all active limiters for diagnostics. */
export function rateLimiterSnapshots(): Array<ReturnType<TokenBucket['snapshot']>> {
  return [..._registry.values()].map((b) => b.snapshot());
}

/* ─── Documented broker limits ──────────────────────────────────────────────
 *
 * Deriv (https://api.deriv.com — see "Rate limits" section):
 *   - 30 requests per second per app id (overall ceiling).
 *   - ticks_history: 50 per minute (the strictest cap and the one we saw fail).
 *   - proposal: 100 per minute.
 *   - buy / sell: 100 per minute.
 *   - portfolio / profit_table: 30 per minute.
 *
 * MT5 (no published limit). Conservative default to avoid broker-side throttling.
 */

export const DERIV_TICKS_HISTORY = getRateLimiter('deriv:ticks_history', {
  ratePerSecond: 50 / 60,
  burst: 1,
});
export const DERIV_PROPOSAL = getRateLimiter('deriv:proposal', {
  ratePerSecond: 100 / 60,
  burst: 5,
});
export const DERIV_BUY_SELL = getRateLimiter('deriv:buy_sell', {
  ratePerSecond: 100 / 60,
  burst: 5,
});
export const DERIV_PORTFOLIO = getRateLimiter('deriv:portfolio', {
  ratePerSecond: 30 / 60,
  burst: 3,
});
export const DERIV_TICK = getRateLimiter('deriv:tick', {
  // Tick subscriptions are cheap after subscription, but the subscribe
  // requests are rate-limited in practice. Keep spread probing conservative.
  ratePerSecond: 1,
  burst: 2,
});
export const DERIV_GLOBAL = getRateLimiter('deriv:global', {
  ratePerSecond: 30,
  burst: 30,
});
export const MT5_PRICES = getRateLimiter('mt5:prices', {
  ratePerSecond: 10,
  burst: 10,
});
export const MT5_OHLC = getRateLimiter('mt5:ohlc', {
  ratePerSecond: 5,
  burst: 5,
});
