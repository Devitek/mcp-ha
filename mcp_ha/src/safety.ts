import { createHash, timingSafeEqual } from "node:crypto";
import type { AddonConfig } from "./config.js";

/**
 * Turns a simple glob pattern (`light.*`, `lock.front_door`,
 * `recorder.purge*`) into an anchored regular expression. Only the star is a
 * metacharacter, everything else is literal.
 */
export function globToRegex(glob: string): RegExp {
  const escaped = glob
    .trim()
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function matchesAny(value: string, globs: string[]): boolean {
  return globs.some((g) => globToRegex(g).test(value));
}

export interface Verdict {
  allowed: boolean;
  reason?: string;
}

/**
 * A write to an entity is allowed when:
 * (allowlist empty OR entity matches the allowlist) AND entity is not in the
 * denylist. The denylist always wins. A non-empty allowlist switches the
 * behaviour to deny-by-default.
 */
export function entityWriteAllowed(cfg: AddonConfig, entityId: string): Verdict {
  if (cfg.entityAllowlist.length > 0 && !matchesAny(entityId, cfg.entityAllowlist)) {
    return { allowed: false, reason: `${entityId} is not in entity_allowlist` };
  }
  if (matchesAny(entityId, cfg.entityDenylist)) {
    return { allowed: false, reason: `${entityId} is in entity_denylist` };
  }
  return { allowed: true };
}

/** Service denylist, independent from entities (e.g. hassio.*). */
export function serviceAllowed(cfg: AddonConfig, domain: string, service: string): Verdict {
  const full = `${domain}.${service}`;
  if (matchesAny(full, cfg.serviceDenylist)) {
    return { allowed: false, reason: `service ${full} is in service_denylist` };
  }
  return { allowed: true };
}

/** With filter_reads, denylisted entities also disappear from reads. */
export function entityReadVisible(cfg: AddonConfig, entityId: string): boolean {
  if (!cfg.filterReads) return true;
  return !matchesAny(entityId, cfg.entityDenylist);
}

/**
 * Constant-time token comparison. Both values are hashed first so they have
 * the same length, which timingSafeEqual requires.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Displayable form of a secret: a short prefix followed by a fixed number of
 * asterisks (e.g. d370f4f8**********). Secrets must never reach the logs in
 * full, and the padding is fixed so the real length is not revealed either.
 */
export function maskSecret(secret: string, visible = 8): string {
  if (!secret) return "";
  if (secret.length <= visible) return "*".repeat(10);
  return secret.slice(0, visible) + "*".repeat(10);
}
