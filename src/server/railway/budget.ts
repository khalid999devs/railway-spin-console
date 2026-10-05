export interface RatePolicy {
  limit: number;
  windowMs: number;
}

export interface BudgetSnapshot {
  limit: number;
  used: number;
  windowSeconds: number;
  /** "railway" once a `RateLimit-Policy` header has been seen; "assumed" before that. */
  source: "railway" | "assumed";
}

/** Until Railway states its policy, assume the smallest documented plan. */
const ASSUMED_POLICY: RatePolicy = { limit: 100, windowMs: 3_600_000 };
/** Share of the hourly limit that reads may spend; the rest is kept for writes. */
const READ_SHARE = 0.8;
/** Reads that may happen back to back, e.g. while watching a deploy. */
const READ_BURST = 20;

/** Parses `"default";q=1000;w=3600` (limit `q` per window of `w` seconds). */
export function parseRatePolicy(header: string | null): RatePolicy | null {
  if (!header) return null;
  const limit = Number(/(?:^|;)\s*q=(\d+)/.exec(header)?.[1]);
  const windowSeconds = Number(/(?:^|;)\s*w=(\d+)/.exec(header)?.[1]);
  if (!Number.isInteger(limit) || !Number.isInteger(windowSeconds) || limit <= 0 || windowSeconds <= 0) return null;
  return { limit, windowMs: windowSeconds * 1000 };
}

/**
 * Tracks this process's use of Railway's hourly request limit.
 *
 * Railway does not report how many requests are left, so two things are kept
 * locally: a sliding-window count of every request (shown to the user), and a
 * token bucket that paces reads. The bucket refills at READ_SHARE of the
 * limit, so reads can never exceed `READ_BURST + READ_SHARE * limit` per
 * window however often browsers poll.
 */
export class RequestBudget {
  private policy = ASSUMED_POLICY;
  private source: BudgetSnapshot["source"] = "assumed";
  private sentAt: number[] = [];
  private tokens = READ_BURST;
  private refilledAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.refilledAt = now();
  }

  observePolicy(policy: RatePolicy | null): void {
    if (!policy) return;
    this.refill();
    this.policy = policy;
    this.source = "railway";
  }

  record(): void {
    this.sentAt.push(this.now());
  }

  tryTakeRead(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Time for one read token to refill: the fastest pace that is sustainable all hour. */
  get readIntervalMs(): number {
    return this.policy.windowMs / (this.policy.limit * READ_SHARE);
  }

  snapshot(): BudgetSnapshot {
    const cutoff = this.now() - this.policy.windowMs;
    const firstInWindow = this.sentAt.findIndex((at) => at > cutoff);
    this.sentAt = firstInWindow === -1 ? [] : this.sentAt.slice(firstInWindow);
    return { limit: this.policy.limit, used: this.sentAt.length, windowSeconds: this.policy.windowMs / 1000, source: this.source };
  }

  private refill(): void {
    const now = this.now();
    this.tokens = Math.min(READ_BURST, this.tokens + (now - this.refilledAt) / this.readIntervalMs);
    this.refilledAt = now;
  }
}
