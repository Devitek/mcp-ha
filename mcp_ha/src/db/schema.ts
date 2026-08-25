import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Token store schema (#166, epic #164). Single source for both the runtime
 * types and drizzle-kit generate; migrations live in mcp_ha/drizzle/ and are
 * applied programmatically at boot (store.ts), drizzle-kit itself stays a
 * dev dependency.
 *
 * The secret NEVER lands here: only its sha256 (hex) plus an 8-character
 * prefix so a human can tell tokens apart, GitHub-style. Grants and the
 * per-token entity lists are stored as JSON text: they are opaque payloads
 * for SQL, always read and validated through the store.
 */
export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull().unique(),
    /** JSON Record<Category, Level> from the central registry (#165). */
    grants: text("grants").notNull(),
    /** JSON string[] glob lists, intersected with the global ones. Null = unrestricted. */
    entityAllowlist: text("entity_allowlist"),
    entityDenylist: text("entity_denylist"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at"),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [index("idx_tokens_hash").on(t.hash)]
);

export type TokenRow = typeof tokens.$inferSelect;
