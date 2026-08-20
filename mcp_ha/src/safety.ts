import { createHash, timingSafeEqual } from "node:crypto";
import type { AddonConfig } from "./config.js";

/**
 * Convertit un motif glob simple (`light.*`, `lock.front_door`,
 * `recorder.purge*`) en expression régulière ancrée. Seule l'étoile est un
 * métacaractère, tout le reste est littéral.
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
 * Une écriture sur une entité est autorisée si :
 * (allowlist vide OU entité dans l'allowlist) ET entité hors denylist.
 * La denylist gagne toujours. Une allowlist non vide bascule en
 * "interdit par défaut".
 */
export function entityWriteAllowed(cfg: AddonConfig, entityId: string): Verdict {
  if (cfg.entityAllowlist.length > 0 && !matchesAny(entityId, cfg.entityAllowlist)) {
    return { allowed: false, reason: `${entityId} n'est pas dans entity_allowlist` };
  }
  if (matchesAny(entityId, cfg.entityDenylist)) {
    return { allowed: false, reason: `${entityId} est dans entity_denylist` };
  }
  return { allowed: true };
}

/** Denylist de services, indépendante des entités (ex. hassio.*). */
export function serviceAllowed(cfg: AddonConfig, domain: string, service: string): Verdict {
  const full = `${domain}.${service}`;
  if (matchesAny(full, cfg.serviceDenylist)) {
    return { allowed: false, reason: `le service ${full} est dans service_denylist` };
  }
  return { allowed: true };
}

/** Avec filter_reads, les entités denylistées disparaissent aussi des lectures. */
export function entityReadVisible(cfg: AddonConfig, entityId: string): boolean {
  if (!cfg.filterReads) return true;
  return !matchesAny(entityId, cfg.entityDenylist);
}

/**
 * Comparaison de jetons en temps constant. On hache d'abord pour ramener les
 * deux valeurs à la même longueur, timingSafeEqual l'exige.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
