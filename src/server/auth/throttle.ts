const MAX_TRACKED_KEYS = 10_000;

/**
 * Limits wrong passphrase attempts per client: `maxFailures` in each fixed
 * window. In memory, so it resets on restart and is per app instance.
 */
export class AttemptThrottle {
  private readonly failures = new Map<string, { count: number; windowStartedAt: number }>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until this client may try again; 0 if it may try now. */
  retryAfterSeconds(key: string): number {
    const entry = this.current(key);
    if (!entry || entry.count < this.maxFailures) return 0;
    return Math.ceil((entry.windowStartedAt + this.windowMs - this.now()) / 1000);
  }

  recordFailure(key: string): void {
    const entry = this.current(key);
    if (entry) {
      entry.count++;
      return;
    }
    // Map keeps insertion order, so the first key is the oldest. Dropping it bounds memory under a flood of addresses.
    if (this.failures.size >= MAX_TRACKED_KEYS) this.failures.delete(this.failures.keys().next().value!);
    this.failures.set(key, { count: 1, windowStartedAt: this.now() });
  }

  clear(key: string): void {
    this.failures.delete(key);
  }

  private current(key: string) {
    const entry = this.failures.get(key);
    if (entry && this.now() - entry.windowStartedAt >= this.windowMs) {
      this.failures.delete(key);
      return undefined;
    }
    return entry;
  }
}
