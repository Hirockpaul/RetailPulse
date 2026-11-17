/**
 * Limits failed logins per (email + IP): after `max` failures within `windowMs`, further
 * attempts are refused until the window ends. A successful login clears the counter.
 *
 * In-memory on purpose (single API instance in the MVP): it resets when the API restarts and
 * is not shared between instances. Move it to PostgreSQL or Redis before running several.
 */
export class LoginThrottle {
  private readonly entries = new Map<string, { failures: number; resetAt: number }>();

  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds the caller must wait, or 0 if an attempt is allowed. */
  retryAfterSeconds(key: string): number {
    const entry = this.live(key);
    if (!entry || entry.failures < this.max) return 0;
    return Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000));
  }

  recordFailure(key: string): void {
    this.sweep();
    const entry = this.live(key);
    if (entry) entry.failures += 1;
    else this.entries.set(key, { failures: 1, resetAt: this.now() + this.windowMs });
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private live(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.resetAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Bound memory: drop expired entries once the map gets large. */
  private sweep() {
    if (this.entries.size < 1000) return;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= this.now()) this.entries.delete(key);
    }
  }
}
