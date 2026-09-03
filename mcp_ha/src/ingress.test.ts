import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createIngressHandler } from "./ingress.js";
import { setLogLevel } from "./logger.js";
import type { AddonConfig } from "./config.js";

beforeAll(() => setLogLevel("fatal"));

const SECRET = "supersecret-token-value-1234567890";

function ctx(partial: Partial<AddonConfig> = {}) {
  return {
    cfg: {
      port: 9583,
      apiToken: SECRET,
      apiTokenGenerated: false,
      allowWrite: true,
      allowCamera: false,
      allowConfigWrite: false,
      enableSessions: false,
      filterReads: false,
      entityAllowlist: ["light.*"],
      entityDenylist: [],
      serviceDenylist: [],
      confirmDomains: ["lock"],
      supervisorToken: "sup-secret",
      devHaUrl: null,
      devHaToken: null,
      ...partial,
    },
    ws: { connected: true, disconnectedForMs: () => null },
  } as any;
}

let server: Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

async function serve(handler: ReturnType<typeof createIngressHandler>): Promise<string> {
  server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

describe("ingress dashboard (#136)", () => {
  it("serves the four tabs with onboarding blocks, token masked and present once for the script", async () => {
    const base = await serve(createIngressHandler(ctx(), Date.now() - 90_000));
    const r = await fetch(`${base}/whatever/ingress/path`);
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("MCP Home Assistant");
    for (const tab of ["overview", "connect", "tokens", "audit"]) {
      expect(html).toContain(`data-tab="${tab}"`);
    }
    // Onboarding blocks with the token as a placeholder only (#92).
    expect(html).toContain("claude mcp add --transport http home-assistant");
    expect(html).toContain("mcp-remote");
    expect(html).toContain("httpUrl");
    // OpenCode block (#178): token through an env var, never in the JSON.
    expect(html).toContain("export HA_MCP_TOKEN=");
    expect(html).toContain("Bearer {env:HA_MCP_TOKEN}");
    expect(html).toContain("&quot;oauth&quot;: false");
    // Generic block for any Streamable HTTP client.
    expect(html).toContain("Streamable HTTP (JSON-RPC over POST)");
    expect(html.match(/___TOKEN___/g)!.length).toBeGreaterThanOrEqual(5);
    // The real token feeds the page script exactly once (HA session trust).
    expect(html.split(SECRET).length - 1).toBe(1);
    expect(html).toContain("supersec**********");
    // The Supervisor token stays out, unconditionally.
    expect(html).not.toContain("sup-secret");
    // Safety card content.
    expect(html).toContain("lock");
    expect(html).toContain("allow_config_write");
  });

  it("computes the tool breakdown from the enabled options", async () => {
    const readOnly = await (await fetch(`${await serve(createIngressHandler(ctx({ allowWrite: false })))}/`)).text();
    expect(readOnly).toContain(">26<");
    expect(readOnly).toContain("26 read</div>"); // no write suffix in the stat card
    server?.close();
    const partial = await (await fetch(`${await serve(createIngressHandler(ctx()))}/`)).text();
    expect(partial).toContain(">36<");
    expect(partial).toContain("26 read");
    expect(partial).toContain("10 write");
    server?.close();
    const full = await (
      await fetch(`${await serve(createIngressHandler(ctx({ allowCamera: true, allowConfigWrite: true })))}/`)
    ).text();
    expect(full).toContain(">45<");
    expect(full).toContain("27 read");
    expect(full).toContain("18 write");
  });

  it("renders the primary token masked, never in clear outside the page script (#85/#182)", async () => {
    const base = await serve(createIngressHandler(ctx()));
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("api_token (primary)");
    expect(html).toContain("full access (bootstrap and recovery)");
    expect(html).toContain("supersec**********");
    expect(html.split(SECRET).length - 1).toBe(1); // page script only
  });

  it("derives the MCP URL from the browsing host and rejects proxy internals (#92)", async () => {
    const base = await serve(createIngressHandler(ctx()));
    const viaLan = await (await fetch(`${base}/`, { headers: { "X-Forwarded-Host": "ha.local:8123" } })).text();
    expect(viaLan).toContain("http://ha.local:9583/mcp");
    const viaProxy = await (await fetch(`${base}/`, { headers: { "X-Forwarded-Host": "172.30.32.2:8099" } })).text();
    expect(viaProxy).toContain("http://HA_IP:9583/mcp");
    const direct = await (await fetch(`${base}/`)).text();
    expect(direct).toContain("http://HA_IP:9583/mcp");
  });

  it("shows the degraded WebSocket state", async () => {
    const down = ctx();
    down.ws = { connected: false, disconnectedForMs: () => 3 * 60_000 };
    const base = await serve(createIngressHandler(down));
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("WebSocket down");
  });

  it("renders usage counters and top tool bars when a tracker is provided (#128)", async () => {
    const { UsageTracker } = await import("./usage.js");
    const usage = new UsageTracker();
    usage.record("ha_get_entity", "writer");
    usage.record("ha_get_entity", "writer");
    usage.record("ha_call_service", "default");
    const base = await serve(createIngressHandler(ctx(), Date.now(), { usage }));
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("Top tools since start");
    expect(html).toContain("ha_get_entity");
    expect(html).toContain('"writer"</span> 2');
    expect(html).toContain("width:100%");
    expect(html).toContain("width:50%");
  });

  it("renders the audit tail newest first with kind tags and escapes it (#126)", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "mcpha-ingress-audit-"));
    const file = join(dir, "audit.log");
    const lines = [
      JSON.stringify({ ts: "2026-08-22T10:00:00.000Z", audit: true, client: "writer", tool: "ha_call_service", domain: "light", service: "turn_on", allowed: true }),
      JSON.stringify({ ts: "2026-08-22T10:02:00.000Z", audit: true, client: "writer", tool: "ha_call_service", domain: "lock", service: "unlock", allowed: true, confirmation_required: true }),
      JSON.stringify({ ts: "2026-08-22T10:05:00.000Z", audit: true, client: "reader", tool: "ha_delete_helper", entity_id: "input_boolean.x", allowed: false, reason: "<script>alert(1)</script>" }),
    ];
    await writeFile(file, lines.join("\n") + "\n");
    const base = await serve(createIngressHandler(ctx(), Date.now(), { auditPath: file }));
    const html = await (await fetch(`${base}/`)).text();
    // newest first
    expect(html.indexOf("ha_delete_helper")).toBeLessThan(html.indexOf("light.turn_on"));
    // kinds drive the client-side filters
    expect(html).toContain('data-kind="refused"');
    expect(html).toContain('data-kind="confirm"');
    expect(html).toContain('data-kind="ok"');
    expect(html).toContain('data-filter="dryconfirm"');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    await rm(dir, { recursive: true, force: true });
  });

  it("ships the three-state theme switcher (#136 follow-up)", async () => {
    const base = await serve(createIngressHandler(ctx()));
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('id="theme"');
    expect(html).toContain('body[data-theme="light"]');
    expect(html).toContain('body:not([data-theme="dark"])');
    expect(html).toContain("mcpha-theme");
  });

  it("inlines the add-on icon as a data URI, with the >_ fallback (#136 follow-up)", async () => {
    const base = await serve(createIngressHandler(ctx()));
    const html = await (await fetch(`${base}/`)).text();
    // vitest runs from mcp_ha/, where the real icon.png lives.
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toContain("&gt;_");
    const fallback = await serve(createIngressHandler(ctx(), Date.now(), { iconPath: "/nonexistent-mcpha/icon.png" }));
    const html2 = await (await fetch(`${fallback}/`)).text();
    expect(html2).toContain("&gt;_");
    expect(html2).not.toContain("data:image/png");
  });

  it("says so when there is no audit file yet", async () => {
    const base = await serve(createIngressHandler(ctx(), Date.now(), { auditPath: "/nonexistent-mcpha/audit.log" }));
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("No audit entries yet");
  });
});

describe("token management on the ingress (#167)", () => {
  async function tokenSetup(cfgPartial: Partial<AddonConfig> = {}) {
    const { TokenStore } = await import("./db/store.js");
    const store = await TokenStore.open(":memory:");
    const base = await serve(createIngressHandler(ctx(cfgPartial), Date.now(), { store }));
    const html = await (await fetch(`${base}/`)).text();
    const csrf = html.match(/name="csrf" value="([0-9a-f]{32})"/)?.[1] ?? "";
    const post = (fields: Record<string, string>) =>
      fetch(`${base}/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      });
    return { store, base, csrf, post };
  }

  it("creates a token from the form and shows the secret exactly once", async () => {
    const { store, base, csrf, post } = await tokenSetup({ allowWrite: true });
    const res = await post({
      csrf,
      mcpha_action: "create",
      name: "voice-pipeline",
      expires: "30d",
      grant_entities: "read",
      grant_services: "write",
      entity_denylist: "lock.*\n",
    });
    const html = await res.text();
    expect(html.match(/mcpha_[A-Za-z0-9_-]{43}/g)!.length).toBe(1);
    expect(html).toContain("Copy it NOW");
    const records = await store.list();
    expect(records).toHaveLength(1);
    expect(records[0]!.grants.services).toBe("write");
    expect(records[0]!.entityDenylist).toEqual(["lock.*"]);
    expect(records[0]!.expiresAt).not.toBeNull();
    // the next GET renders prefix and metadata only, never the secret again
    const after = await (await fetch(`${base}/`)).text();
    expect(after).not.toMatch(/mcpha_[A-Za-z0-9_-]{43}/);
    expect(after).toContain(`${records[0]!.prefix}…`);
    expect(after).toContain("services: write");
  });

  it("refuses a wrong CSRF value and grants above the option gates", async () => {
    const { store, csrf, post } = await tokenSetup({ allowWrite: false });
    const bad = await (await post({ csrf: "0".repeat(32), mcpha_action: "create", name: "x", grant_entities: "read" })).text();
    expect(bad).toContain("Stale form");
    const over = await (await post({ csrf, mcpha_action: "create", name: "x", grant_services: "write" })).text();
    expect(over).toContain("exceed the current option gates");
    expect(over).toContain("allow_write");
    expect(await store.list()).toHaveLength(0);
  });

  it("revokes from the list with an audited event", async () => {
    const { store, base, csrf, post } = await tokenSetup();
    const { record } = await store.create({ name: "goner", grants: { entities: "read" } });
    const html = await (await post({ csrf, mcpha_action: "revoke", id: record.id })).text();
    expect(html).toContain("revoked");
    expect((await store.list())[0]!.revokedAt).not.toBeNull();
    const after = await (await fetch(`${base}/`)).text();
    expect(after).toContain(">revoked</span>");
  });

  it("greys matrix levels above the gates and shows capped-by on over-granted tokens", async () => {
    const { store, base } = await tokenSetup({ allowWrite: true, allowConfigWrite: false });
    // manage exists for automations but sits above the current gates
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toMatch(/name="grant_automations" value="manage" disabled/);
    expect(html).toMatch(/name="grant_automations" value="write"(?! disabled)/);
    // a stored token granted manage elsewhere shows the capping gate
    await store.create({ name: "was-manager", grants: { automations: "manage" } });
    const after = await (await fetch(`${base}/`)).text();
    expect(after).toContain("capped by allow_config_write: off");
  });

  it("answers 405 to POST when no store is wired", async () => {
    const base = await serve(createIngressHandler(ctx()));
    const res = await fetch(`${base}/`, { method: "POST", body: "x=1" });
    expect(res.status).toBe(405);
  });
});
