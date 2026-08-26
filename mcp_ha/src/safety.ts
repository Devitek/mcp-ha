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

/** Per-token entity glob lists (#167), applied ON TOP of the global ones. */
export interface TokenEntityLists {
  allow: string[] | null;
  deny: string[] | null;
}

/**
 * Global lists AND the authenticated token's lists (#167): both must agree.
 * Two allowlists cannot be merged into one glob set (concat would OR them),
 * hence the two-pass check. Deny always wins, in either list.
 */
export function entityWriteAllowedFor(
  ctx: { cfg: AddonConfig; tokenEntityLists?: TokenEntityLists | undefined },
  entityId: string
): Verdict {
  const global = entityWriteAllowed(ctx.cfg, entityId);
  if (!global.allowed) return global;
  const t = ctx.tokenEntityLists;
  if (!t) return { allowed: true };
  if (t.allow && t.allow.length > 0 && !matchesAny(entityId, t.allow)) {
    return { allowed: false, reason: `${entityId} is not in this token's entity allowlist` };
  }
  if (t.deny && t.deny.length > 0 && matchesAny(entityId, t.deny)) {
    return { allowed: false, reason: `${entityId} is in this token's entity denylist` };
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

/** Writes on these domains require the two-step confirmation (v0.2). */
export function needsConfirmation(cfg: AddonConfig, domain: string): boolean {
  return matchesAny(domain, cfg.confirmDomains);
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
