import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TokenStore } from "./store.js";
import { readOnlyGrants } from "../mcp/registry.js";
import { setLogLevel } from "../logger.js";

beforeAll(() => setLogLevel("fatal"));

let store: TokenStore | null = null;
afterEach(() => {
  store?.close();
  store = null;
  vi.useRealTimers();
});

async function open(): Promise<TokenStore> {
  store = await TokenStore.open(":memory:");
  return store;
}

describe("TokenStore (#166)", () => {
  it("creates a token whose secret never lands in the store output", async () => {
    const s = await open();
    const { token, record } = await s.create({ name: "voice-pipeline", grants: { entities: "read", services: "write" } });
    expect(token).toMatch(/^mcpha_[A-Za-z0-9_-]{43}$/);
    expect(record.prefix).toBe(token.slice(0, 8));
    expect(record.grants.services).toBe("write");
    expect(record.grants.camera).toBe("none"); // unspecified categories default to none
    const listed = await s.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(token.slice(10));
  });

  it("verifies the clear secret and rejects unknown or tampered ones", async () => {
    const s = await open();
    const { token, record } = await s.create({ name: "app", grants: readOnlyGrants() });
    const ok = await s.verify(token);
    expect(ok?.denied).toBeNull();
    expect(ok?.record.id).toBe(record.id);
    expect(await s.verify(token.slice(0, -1) + "x")).toBeNull();
    expect(await s.verify("mcpha_totally-made-up")).toBeNull();
  });

  it("refuses duplicate names with a readable error and empty grants upfront", async () => {
    const s = await open();
    await s.create({ name: "twin", grants: readOnlyGrants() });
    await expect(s.create({ name: "twin", grants: readOnlyGrants() })).rejects.toThrow(/already exists/);
    await expect(s.create({ name: "empty", grants: {} })).rejects.toThrow(/no grant at all/);
  });

  it("revokes and expires with distinct denied reasons", async () => {
    const s = await open();
    const { token, record } = await s.create({ name: "gone", grants: readOnlyGrants() });
    expect(await s.revoke(record.id)).toBe(true);
    expect((await s.verify(token))?.denied).toBe("revoked");
    expect(await s.revoke("no-such-id")).toBe(false);
    const { token: t2 } = await s.create({
      name: "stale",
      grants: readOnlyGrants(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect((await s.verify(t2))?.denied).toBe("expired");
  });

  it("throttles last_used_at to one write per minute", async () => {
    const s = await open();
    const { token } = await s.create({ name: "busy", grants: readOnlyGrants() });
    await s.verify(token);
    const first = (await s.list())[0]!.lastUsedAt;
    expect(first).not.toBeNull();
    await s.verify(token);
    expect((await s.list())[0]!.lastUsedAt).toBe(first); // second hit inside the window: no write
  });

  it("recovers from persistent foreign locks by reopening without SQLite locking (#172/#174)", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const dir = await mkdtemp(join(tmpdir(), "mcpha-store-lock-"));
    const file = join(dir, "tokens.db");
    // Another handle holds an exclusive lock and never lets go: the exact
    // field profile of a filesystem with broken locks. The standard open
    // times out (short budget for test speed), then the nolock reopen must
    // succeed and be fully functional WHILE the foreign lock is still held.
    const blocker = new DatabaseSync(file);
    blocker.exec("BEGIN EXCLUSIVE;");
    const s = await TokenStore.open(file, { busyTimeoutMs: 50 });
    const { token } = await s.create({ name: "post-lock", grants: readOnlyGrants() });
    expect((await s.verify(token))?.denied).toBeNull();
    s.close();
    // A phantom lock holder never commits anything (that is what makes the
    // nolock reopen safe); rollback models its release.
    blocker.exec("ROLLBACK;");
    blocker.close();
    // And a plain reopen still works once the filesystem behaves again.
    const healthy = await TokenStore.open(file, { busyTimeoutMs: 50 });
    expect(await healthy.list()).toHaveLength(1);
    healthy.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("imports legacy api_tokens idempotently with scope-mapped grants", async () => {
    const s = await open();
    const legacy = [
      { name: "writer", token: "legacy-write-token-16chars", scope: "write" as const },
      { name: "reader", token: "legacy-read-token-16charsx", scope: "read" as const },
    ];
    expect(await s.importLegacy(legacy)).toBe(2);
    expect(await s.importLegacy(legacy)).toBe(0); // second boot: nothing new
    const writer = await s.verify("legacy-write-token-16chars");
    expect(writer?.denied).toBeNull();
    expect(writer?.record.grants.automations).toBe("manage");
    const reader = await s.verify("legacy-read-token-16charsx");
    expect(reader?.record.grants.automations).toBe("read");
    expect(reader?.record.grants.notify).toBe("read"); // read scope: nothing above read anywhere
  });
});
