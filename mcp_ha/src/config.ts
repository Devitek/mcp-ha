import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { log } from "./logger.js";

export const VERSION = "0.1.0";

const OPTIONS_PATH = "/data/options.json";
const TOKEN_PATH = "/data/token";

export interface AddonConfig {
  port: number;
  apiToken: string;
  allowWrite: boolean;
  filterReads: boolean;
  entityAllowlist: string[];
  entityDenylist: string[];
  serviceDenylist: string[];
  /** Jeton injecté par le Supervisor quand on tourne en add-on. */
  supervisorToken: string | null;
  /** Mode dev hors add-on : URL et jeton longue durée de l'instance HA. */
  devHaUrl: string | null;
  devHaToken: string | null;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).filter((s) => s.trim().length > 0) : [];
}

export function loadConfig(): AddonConfig {
  let opts: Record<string, unknown> = {};
  if (existsSync(OPTIONS_PATH)) {
    try {
      opts = JSON.parse(readFileSync(OPTIONS_PATH, "utf8"));
    } catch (e) {
      log.error(`Impossible de lire ${OPTIONS_PATH}: ${String(e)}`);
    }
  }

  let apiToken = String(opts.api_token ?? process.env.MCP_API_TOKEN ?? "").trim();
  if (!apiToken) {
    apiToken = bootstrapToken();
  }

  return {
    port: Number(process.env.MCP_PORT ?? 9583),
    apiToken,
    allowWrite: opts.allow_write === true || process.env.MCP_ALLOW_WRITE === "true",
    filterReads: opts.filter_reads === true,
    entityAllowlist: strArray(opts.entity_allowlist),
    entityDenylist: strArray(opts.entity_denylist),
    serviceDenylist: strArray(opts.service_denylist),
    supervisorToken: process.env.SUPERVISOR_TOKEN ?? null,
    devHaUrl: process.env.HA_URL ?? null,
    devHaToken: process.env.HA_TOKEN ?? null,
  };
}

/**
 * Aucun jeton fourni : on en génère un et on le persiste dans /data pour
 * qu'il survive aux redémarrages. C'est le seul endroit où il est affiché.
 */
function bootstrapToken(): string {
  try {
    if (existsSync(TOKEN_PATH)) {
      const t = readFileSync(TOKEN_PATH, "utf8").trim();
      if (t) {
        log.info(`Jeton API chargé depuis ${TOKEN_PATH} (supprimez ce fichier pour en régénérer un).`);
        log.warn(`Jeton API à utiliser par vos clients MCP : ${t}`);
        return t;
      }
    }
  } catch {
    // on retombe sur la génération
  }
  const t = randomBytes(32).toString("hex");
  try {
    writeFileSync(TOKEN_PATH, t, { mode: 0o600 });
    log.warn(`Aucun api_token configuré : jeton généré et persisté dans ${TOKEN_PATH}.`);
  } catch {
    log.warn("Aucun api_token configuré et /data indisponible : jeton éphémère (mode dev).");
  }
  log.warn(`Jeton API à utiliser par vos clients MCP : ${t}`);
  return t;
}
