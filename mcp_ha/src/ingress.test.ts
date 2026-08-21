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

describe("ingress status page (v0.3 #79)", () => {
  it("serves the status without ever leaking a secret", async () => {
    server = createServer(createIngressHandler(ctx(), Date.now() - 90_000));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    if (typeof addr === "string" || addr === null) throw new Error("no port");
    const r = await fetch(`http://127.0.0.1:${addr.port}/whatever/ingress/path`);
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain("MCP Home Assistant");
    expect(html).toContain("21 (17 read + 4 write)");
    expect(html).toContain("lock");
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("sup-secret");
  });

  it("shows the degraded WebSocket state", async () => {
    server = createServer(createIngressHandler(ctx({ }), Date.now()));
    const down = ctx();
    down.ws = { connected: false, disconnectedForMs: () => 3 * 60_000 };
    server = createServer(createIngressHandler(down));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    if (typeof addr === "string" || addr === null) throw new Error("no port");
    const html = await (await fetch(`http://127.0.0.1:${addr.port}/`)).text();
    expect(html).toContain("down");
  });
});
