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
      apiTokens: [],
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
    expect(html.match(/___TOKEN___/g)!.length).toBeGreaterThanOrEqual(3);
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
    expect(readOnly).toContain(">24<");
    expect(readOnly).toContain("24 read</div>"); // no write suffix in the stat card
    server?.close();
    const partial = await (await fetch(`${await serve(createIngressHandler(ctx()))}/`)).text();
    expect(partial).toContain(">33<");
    expect(partial).toContain("24 read");
    expect(partial).toContain("9 write");
    server?.close();
    const full = await (
      await fetch(`${await serve(createIngressHandler(ctx({ allowCamera: true, allowConfigWrite: true })))}/`)
    ).text();
    expect(full).toContain(">40<");
    expect(full).toContain("25 read");
    expect(full).toContain("15 write");
  });

  it("renders named tokens masked with their scope, never in clear (#85)", async () => {
    const named = "named-token-value-abcdef123456789";
    const base = await serve(
      createIngressHandler(ctx({ apiTokens: [{ name: "voice-pipeline", token: named, scope: "read" }] }))
    );
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("voice-pipeline");
    expect(html).toContain("named-to**********");
    expect(html).not.toContain(named);
    expect(html).toContain("api_token (primary)");
    expect(html).toContain("api_tokens");
    expect(html).toContain(">read</span>");
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

  it("says so when there is no audit file yet", async () => {
    const base = await serve(createIngressHandler(ctx(), Date.now(), { auditPath: "/nonexistent-mcpha/audit.log" }));
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("No audit entries yet");
  });
});
