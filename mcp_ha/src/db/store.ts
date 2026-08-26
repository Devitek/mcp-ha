import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { migrate } from "drizzle-orm/sqlite-proxy/migrator";
import { tokens, type TokenRow } from "./schema.js";
import { CATEGORIES, LEVELS, readOnlyGrants, fullGrants, type Grants, type Level } from "../mcp/registry.js";
import type { ApiToken } from "../config.js";
import { log } from "../logger.js";

/**
 * Token store (#166, epic #164): tokens hashed at rest in a local SQLite
 * database. Drizzle rides the stable sqlite-proxy adapter over the built-in
 * node:sqlite driver (zero native dependency); the dedicated node-sqlite
 * driver only exists in the 1.0 RCs, swapping to it once stable touches
 * only this file. Migrations are the drizzle/ folder, applied here at boot.
 *
 * The secret exists in memory at creation time only: what lands on disk is
 * sha256(token) plus an 8-character prefix for human identification. Lookup
 * goes through the hash (indexed), which breaks any timing correlation with
 * the secret; the final comparison is still timingSafeEqual on the hashes,
 * keeping the constant-time doctrine end to end.
 */

export interface TokenRecord {
  id: string;
  name: string;
  prefix: string;
  grants: Grants;
  entityAllowlist: string[] | null;
  entityDenylist: string[] | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreateTokenInput {
  name: string;
  grants: Partial<Grants>;
  entityAllowlist?: string[] | undefined;
  entityDenylist?: string[] | undefined;
  /** ISO date; the token stops authenticating past it. */
  expiresAt?: string | undefined;
}

export interface CreatedToken {
  /** The clear secret, shown ONCE and never stored. */
  token: string;
  record: TokenRecord;
}

export type VerifyResult =
  | { record: TokenRecord; denied: null }
  | { record: TokenRecord; denied: "revoked" | "expired" }
  | null;

/** At most one last_used_at write per token per minute. */
const LAST_USED_THROTTLE_MS = 60_000;
const TOKEN_PREFIX_CHARS = 8;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeGrants(partial: Partial<Grants>): Grants {
  const out = {} as Grants;
  for (const c of CATEGORIES) {
    const level = partial[c] ?? "none";
    if (!LEVELS.includes(level as Level)) throw new Error(`invalid level for ${c}: ${String(level)}`);
    out[c] = level as Level;
  }
  return out;
}

function toRecord(row: TokenRow): TokenRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    grants: normalizeGrants(JSON.parse(row.grants) as Partial<Grants>),
    entityAllowlist: row.entityAllowlist ? (JSON.parse(row.entityAllowlist) as string[]) : null,
    entityDenylist: row.entityDenylist ? (JSON.parse(row.entityDenylist) as string[]) : null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

export interface TokenStoreOptions {
  /** SQLITE_BUSY wait budget; short in tests, 5 s in production. */
  busyTimeoutMs?: number;
}

export class TokenStore {
  private client: DatabaseSync;
  private db: ReturnType<typeof drizzle>;
  private lastTouch = new Map<string, number>();

  private constructor(path: string, opts: TokenStoreOptions = {}) {
    this.client = new DatabaseSync(path);
    // A transient lock (fast restart racing the dying process, checkpoint in
    // flight) becomes a short wait instead of an error (#172).
    this.client.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 5000};`);
    // WAL is an optimisation, never a requirement (#172): the delete-to-WAL
    // transition needs an exclusive lock and some filesystems (network
    // mounts, odd overlays) refuse it with "database is locked". A 10-row
    // database is perfectly served by the rollback journal.
    try {
      this.client.exec("PRAGMA journal_mode = WAL;");
    } catch (e) {
      log.warning(
        `tokens.db: WAL journal unavailable (${e instanceof Error ? e.message : String(e)}); staying on the rollback journal`
      );
    }
    // sqlite-proxy contract: rows as arrays of values in column order.
    // Single-table queries only, so Object.values keeps that order.
    this.db = drizzle(async (sql, params, method) => {
      const stmt = this.client.prepare(sql);
      if (method === "run") {
        stmt.run(...(params as never[]));
        return { rows: [] };
      }
      const rows = (stmt.all(...(params as never[])) as Record<string, unknown>[]).map((r) => Object.values(r));
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    });
  }

  /** Opens (or creates) the database and applies pending migrations. */
  static async open(path: string, opts: TokenStoreOptions = {}): Promise<TokenStore> {
    const store = new TokenStore(path, opts);
    const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
    await migrate(
      store.db,
      async (queries) => {
        for (const q of queries) store.client.exec(q);
      },
      { migrationsFolder }
    );
    return store;
  }

  async create(input: CreateTokenInput): Promise<CreatedToken> {
    const name = input.name.trim();
    if (!name) throw new Error("token name must not be empty");
    const grants = normalizeGrants(input.grants);
    if (Object.values(grants).every((l) => l === "none")) {
      throw new Error("a token with no grant at all would never authenticate anything: pick at least one category");
    }
    const token = `mcpha_${randomBytes(32).toString("base64url")}`;
    const now = new Date().toISOString();
    const row: TokenRow = {
      id: randomUUID(),
      name,
      prefix: token.slice(0, TOKEN_PREFIX_CHARS),
      hash: sha256Hex(token),
      grants: JSON.stringify(grants),
      entityAllowlist: input.entityAllowlist?.length ? JSON.stringify(input.entityAllowlist) : null,
      entityDenylist: input.entityDenylist?.length ? JSON.stringify(input.entityDenylist) : null,
      createdAt: now,
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
    };
    try {
      await this.db.insert(tokens).values(row);
    } catch (e) {
      // Drizzle wraps driver errors; the SQLite UNIQUE violation is the cause.
      const cause = (e as { cause?: unknown }).cause;
      const msg = `${e instanceof Error ? e.message : String(e)} ${cause instanceof Error ? cause.message : ""}`;
      if (msg.includes("UNIQUE")) throw new Error(`a token named "${name}" already exists; revoke it or pick another name`);
      throw e;
    }
    return { token, record: toRecord(row) };
  }

  /**
   * Authenticates a presented bearer. null = unknown token; a record with a
   * denied reason lets the caller audit revoked/expired attempts by name.
   */
  async verify(presented: string): Promise<VerifyResult> {
    const digest = sha256Hex(presented);
    const rows = await this.db.select().from(tokens).where(eq(tokens.hash, digest)).limit(1);
    const row = rows[0];
    if (!row) return null;
    if (!timingSafeEqual(Buffer.from(digest), Buffer.from(row.hash))) return null;
    const record = toRecord(row);
    if (record.revokedAt) return { record, denied: "revoked" };
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return { record, denied: "expired" };
    await this.touch(row.id);
    return { record, denied: null };
  }

  private async touch(id: string): Promise<void> {
    const now = Date.now();
    const last = this.lastTouch.get(id) ?? 0;
    if (now - last < LAST_USED_THROTTLE_MS) return;
    this.lastTouch.set(id, now);
    try {
      await this.db.update(tokens).set({ lastUsedAt: new Date(now).toISOString() }).where(eq(tokens.id, id));
    } catch (e) {
      log.debug(`last_used_at update failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Marks a token revoked; idempotent. Returns false for unknown ids. */
  async revoke(id: string): Promise<boolean> {
    const rows = await this.db.select().from(tokens).where(eq(tokens.id, id)).limit(1);
    if (!rows[0]) return false;
    if (!rows[0].revokedAt) {
      await this.db.update(tokens).set({ revokedAt: new Date().toISOString() }).where(eq(tokens.id, id));
    }
    return true;
  }

  /** Every token, newest first, WITHOUT the hash. */
  async list(): Promise<TokenRecord[]> {
    const rows = await this.db.select().from(tokens);
    return rows.map(toRecord).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * One-shot import of the legacy api_tokens option (#166): the clear YAML
   * tokens become hashed rows with the grants their scope meant; the option
   * is then blanked by the caller. Idempotent: rows already present (same
   * hash or same name) are skipped, so a failed write-back only re-skips.
   */
  async importLegacy(legacy: ApiToken[]): Promise<number> {
    let imported = 0;
    for (const t of legacy) {
      if (!t.token) continue;
      const digest = sha256Hex(t.token);
      const byHash = await this.db.select().from(tokens).where(eq(tokens.hash, digest)).limit(1);
      if (byHash[0]) continue;
      const byName = await this.db.select().from(tokens).where(eq(tokens.name, t.name)).limit(1);
      if (byName[0]) {
        log.warning(`legacy token "${t.name}" not imported: a different token with that name already exists`);
        continue;
      }
      const grants = t.scope === "write" ? fullGrants() : readOnlyGrants();
      await this.db.insert(tokens).values({
        id: randomUUID(),
        name: t.name,
        prefix: t.token.slice(0, TOKEN_PREFIX_CHARS),
        hash: digest,
        grants: JSON.stringify(grants),
        entityAllowlist: null,
        entityDenylist: null,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      });
      imported += 1;
    }
    return imported;
  }

  close(): void {
    this.client.close();
  }
}
