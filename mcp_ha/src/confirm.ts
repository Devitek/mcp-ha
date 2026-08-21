import { createHash, randomBytes } from "node:crypto";

/** A pending confirmation lives this long before expiring. */
const TTL_MS = 2 * 60_000;
/** Hard bound on simultaneous pending confirmations (abuse guard). */
const MAX_PENDING = 100;

interface Pending {
  hash: string;
  expires: number;
}

export type ConsumeVerdict = "ok" | "unknown" | "expired" | "mismatch";

/**
 * Two-step confirmation for writes on sensitive domains (v0.2, issue #15).
 * The first call returns a single-use token bound to the exact call
 * fingerprint; execution requires presenting that token with the SAME call.
 * A token can never authorize a different action, and it dies on first use
 * whatever the outcome.
 */
export class ConfirmationStore {
  private pending = new Map<string, Pending>();

  constructor(private now: () => number = Date.now) {}

  /** Canonical fingerprint of a service call, computed by us, order-stable. */
  static fingerprint(call: { domain: string; service: string; target?: unknown; data?: unknown }): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          domain: call.domain,
          service: call.service,
          target: call.target ?? null,
          data: call.data ?? null,
        })
      )
      .digest("hex");
  }

  issue(hash: string): string {
    this.sweep();
    const token = randomBytes(16).toString("hex");
    this.pending.set(token, { hash, expires: this.now() + TTL_MS });
    return token;
  }

  /** Single use: the token is deleted whatever the verdict. */
  consume(token: string, hash: string): ConsumeVerdict {
    const p = this.pending.get(token);
    if (!p) return "unknown";
    this.pending.delete(token);
    if (this.now() > p.expires) return "expired";
    if (p.hash !== hash) return "mismatch";
    return "ok";
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, p] of this.pending) {
      if (now > p.expires) this.pending.delete(token);
    }
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }
}
