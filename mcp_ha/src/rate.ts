/**
 * Per-target sliding-minute rate limiter, shared by the outbound channels
 * (#116 notifications, #125 announcements): a looping assistant must not
 * hammer things that physically disturb people. Process-wide state.
 */
export class TargetRateLimiter {
  private sentAt = new Map<string, number[]>();

  constructor(private maxPerMinute: number) {}

  /** True when the send is allowed; records it. */
  allow(target: string): boolean {
    const now = Date.now();
    const recent = (this.sentAt.get(target) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.maxPerMinute) {
      this.sentAt.set(target, recent);
      return false;
    }
    recent.push(now);
    this.sentAt.set(target, recent);
    return true;
  }

  get limit(): number {
    return this.maxPerMinute;
  }

  /** Test hook. */
  reset(): void {
    this.sentAt.clear();
  }
}
