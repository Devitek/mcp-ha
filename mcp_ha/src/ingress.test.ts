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

describe("ingress status page (v0.3 #79, onboarding #92)", () => {
  it("serves status and onboarding blocks, token masked on screen and present once for the script", async () => {
    const base = await serve(createIngressHandler(ctx(), Date.now() - 90_000));
    const r = await fetch(`${base}/whatever/ingress/path`);
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain("MCP Home Assistant");
    expect(html).toContain("23 (17 read + 6 write)");
    expect(html).toContain("lock");
    // The three ready-to-copy blocks, with the token as a placeholder only.
    expect(html).toContain("claude mcp add --transport http home-assistant");
    expect(html).toContain("mcp-remote");
    expect(html).toContain("httpUrl");
    expect(html.match(/___TOKEN___/g)!.length).toBeGreaterThanOrEqual(3);
    // The real token feeds the page script exactly once (HA session trust,
    // like the Configuration tab); the masked prefix is what renders.
    expect(html.split(SECRET).length - 1).toBe(1);
    expect(html).toContain("supersec**********");
    // The Supervisor token stays out, unconditionally.
    expect(html).not.toContain("sup-secret");
  });

  it("derives the MCP URL from the browsing host and rejects proxy internals (#92)", async () => {
    const base = await serve(createIngressHandler(ctx()));
    const viaLan = await (await fetch(`${base}/`, { headers: { "X-Forwarded-Host": "ha.local:8123" } })).text();
    expect(viaLan).toContain("http://ha.local:9583/mcp");
    const viaProxy = await (await fetch(`${base}/`, { headers: { "X-Forwarded-Host": "172.30.32.2:8099" } })).text();
    expect(viaProxy).toContain("http://HA_IP:9583/mcp");
    // Direct hit without forwarding headers: the loopback host is no LAN URL.
    const direct = await (await fetch(`${base}/`)).text();
    expect(direct).toContain("http://HA_IP:9583/mcp");
  });

  it("shows the degraded WebSocket state", async () => {
    const down = ctx();
    down.ws = { connected: false, disconnectedForMs: () => 3 * 60_000 };
    const base = await serve(createIngressHandler(down));
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("down");
  });
});
