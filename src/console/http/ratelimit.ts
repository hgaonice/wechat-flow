/**
 * In-process token-bucket rate limiter (C6, I29 / design.md D29).
 *
 * Scope: `/api/*` only (the caller decides which requests to `take`). One
 * limiter instance per console process; keys are `u:<userId>` for authenticated
 * callers and `ip:<clientKey>` for anonymous ones (see `server.ts`).
 *
 * Zero dependencies and deterministic: time is injected via `now`, so tests can
 * advance the clock without sleeping. Buckets are created lazily on first use
 * and swept opportunistically so a hostile client cannot grow memory forever.
 */

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until at least one token is available (only when `ok === false`). */
  retryAfterSec?: number;
}

export interface RateLimiterOptions {
  /** Sustained refill rate, tokens per minute. `<= 0` disables limiting. */
  perMin: number;
  /** Bucket capacity (max burst). `<= 0` is treated as 1. */
  burst: number;
  /** Clock injection for tests; defaults to `Date.now`. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  last: number;
}

/** How many retained buckets we tolerate before progressively enabling refill. */
const DEFAULT_SWEEP_EVERY = 512;
/** A bucket untouched for this long is safe to drop once it has refilled. */
const IDLE_BUCKET_MS = 60_000;

export class RateLimiter {
  private readonly perMin: number;
  private readonly burst: number;
  /** Tokens added per elapsed millisecond. */
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();
  private calls = 0;

  constructor(opts: RateLimiterOptions) {
    this.perMin = Number.isFinite(opts.perMin) ? opts.perMin : 0;
    const burst = Number.isFinite(opts.burst) ? Math.trunc(opts.burst) : 1;
    this.burst = burst > 0 ? burst : 1;
    this.refillPerMs = this.perMin > 0 ? this.perMin / 60_000 : 0;
    this.now = opts.now ?? Date.now;
  }

  /** Consume one token for `key`. Returns `ok:false` with `retryAfterSec` when empty. */
  take(key: string): RateLimitResult {
    if (this.perMin <= 0) return { ok: true };

    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.burst, last: t };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, t - bucket.last);
      bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.refillPerMs);
      bucket.last = t;
    }

    this.maybeSweep(t);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }

    const deficit = 1 - bucket.tokens;
    const retryAfterMs = this.refillPerMs > 0 ? deficit / this.refillPerMs : 60_000;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  /** Number of retained buckets (diagnostics/tests). */
  size(): number {
    return this.buckets.size;
  }

  /** Explicitly forget a key (e.g. on logout). */
  remove(key: string): void {
    this.buckets.delete(key);
  }

  /** Drop full, idle buckets. Exposed for tests; also called lazily by `take`. */
  sweep(now: number = this.now()): number {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      const refilled = Math.min(this.burst, bucket.tokens + Math.max(0, now - bucket.last) * this.refillPerMs);
      if (refilled >= this.burst && now - bucket.last >= IDLE_BUCKET_MS) {
        this.buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }

  private maybeSweep(now: number): void {
    this.calls++;
    if (this.calls % DEFAULT_SWEEP_EVERY === 0) this.sweep(now);
  }
}
