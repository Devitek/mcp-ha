// Progressive per-IP delay on authentication failures (audit D3). A 64-hex
// generated token is not brute-forceable in practice, but a weak user-chosen
// token is, and unlimited free tries also flood the logs.

const FREE_FAILURES = 5;
const BASE_BLOCK_MS = 1_000;
const MAX_BLOCK_MS = 60_000;
/** Forget an IP entirely after this much inactivity. */
const FORGET_AFTER_MS = 10 * 60_000;
/** Hard bound on tracked IPs; beyond it the oldest entries are dropped. */
const MAX_TRACKED = 1_000;

interface Entry {
  failures: number;
  blockedUntil: number;
  lastSeen: number;
}

export class AuthRateLimiter {
  private entries = new Map<string, Entry>();

  constructor(private now: () => number = Date.now) {}

  /** Milliseconds the caller must still wait, or 0 when allowed. */
  retryInMs(ip: string): number {
    const e = this.entries.get(ip);
    if (!e) return 0;
    const now = this.now();
    if (now - e.lastSeen > FORGET_AFTER_MS) {
      this.entries.delete(ip);
      return 0;
    }
    return Math.max(0, e.blockedUntil - now);
  }

  /** Records a failed authentication and returns the applied block in ms. */
  fail(ip: string): number {
    const now = this.now();
    this.sweep(now);
    const e = this.entries.get(ip) ?? { failures: 0, blockedUntil: 0, lastSeen: now };
    e.failures += 1;
    e.lastSeen = now;
    if (e.failures > FREE_FAILURES) {
      const exponent = e.failures - FREE_FAILURES - 1;
      e.blockedUntil = now + Math.min(BASE_BLOCK_MS * 2 ** exponent, MAX_BLOCK_MS);
    }
    this.entries.set(ip, e);
    return Math.max(0, e.blockedUntil - now);
  }

  /** A successful authentication clears the slate for that IP. */
  succeed(ip: string): void {
    this.entries.delete(ip);
  }

  private sweep(now: number): void {
    if (this.entries.size < MAX_TRACKED) return;
    for (const [ip, e] of this.entries) {
      if (now - e.lastSeen > FORGET_AFTER_MS) this.entries.delete(ip);
    }
    // Still over the cap after expiry: drop oldest entries (Map keeps
    // insertion order, good enough for an abuse bound).
    while (this.entries.size >= MAX_TRACKED) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
