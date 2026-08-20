import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createHandler, persistGeneratedToken } from "./index.js";
import { setLogLevel } from "./logger.js";
import type { AddonConfig } from "./config.js";

beforeAll(() => setLogLevel("fatal"));

function cfg(partial: Partial<AddonConfig> = {}): AddonConfig {
  return {
    port: 0,
    apiToken: "test-token-long-enough",
    apiTokenGenerated: false,
    allowWrite: false,
    filterReads: false,
    entityAllowlist: [],
    entityDenylist: [],
    serviceDenylist: [],
    supervisorToken: "sup",
    devHaUrl: null,
    devHaToken: null,
    ...partial,
  };
}

function fakeCtx(partial: any = {}) {
  return {
    cfg: cfg(partial.cfg ?? {}),
    ws: {
      connected: true,
      disconnectedForMs: () => null,
      send: vi.fn(async () => ({})),
      ...(partial.ws ?? {}),
    },
    http: { supervisorAvailable: true, ...(partial.http ?? {}) },
    catalog: { index: vi.fn(async () => []), registries: vi.fn(), states: vi.fn() },
  } as any;
}

let server: Server | null = null;

async function startServer(ctx: any): Promise<string> {
  server = createServer(createHandler(ctx));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

const AUTH = { Authorization: "Bearer test-token-long-enough" };
const ACCEPT = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const rpc = (method: string, params?: unknown, id = 1) =>
  JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}), id });

describe("HTTP boundary (audit E1)", () => {
  it("serves /health without auth, no version leaked", async () => {
    const base = await startServer(fakeCtx());
    const r = await fetch(`${base}/health`);
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body).toEqual({ status: "ok", websocket: true });
    expect(JSON.stringify(body)).not.toContain("0.1.");
  });

  it("degrades /health to 503 when the WS has been down for long (audit F4)", async () => {
    const base = await startServer(fakeCtx({ ws: { connected: false, disconnectedForMs: () => 10 * 60_000 } }));
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).status).toBe("degraded");
  });

  it("stays healthy through a short WS outage", async () => {
    const base = await startServer(fakeCtx({ ws: { connected: false, disconnectedForMs: () => 30_000 } }));
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("rejects a missing or wrong bearer with 401 and WWW-Authenticate", async () => {
    const base = await startServer(fakeCtx());
    const none = await fetch(`${base}/mcp`, { method: "POST", headers: ACCEPT, body: rpc("tools/list") });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe("Bearer");
    const wrong = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...ACCEPT, Authorization: "Bearer nope" },
      body: rpc("tools/list"),
    });
    expect(wrong.status).toBe(401);
  });

  it("answers 405 with Allow on non-POST and 404 elsewhere", async () => {
    const base = await startServer(fakeCtx());
    const get = await fetch(`${base}/mcp`, { headers: AUTH });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("maps invalid JSON to -32700 and oversized bodies to a clean 400", async () => {
    const base = await startServer(fakeCtx());
    const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { ...ACCEPT, ...AUTH }, body: "{nope" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe(-32700);

    const huge = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...ACCEPT, ...AUTH },
      body: `{"pad":"${"x".repeat(4_100_000)}"}`,
    }).catch(() => null);
    // The server destroys the socket after answering; both a parsed 400 and
    // a reset are acceptable client-side outcomes, but never a hang.
    if (huge) expect(huge.status).toBe(400);
  });

  it("serves a full MCP round-trip and hides write tools by default", async () => {
    const base = await startServer(fakeCtx());
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...ACCEPT, ...AUTH },
      body: rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } }),
    });
    expect(init.status).toBe(200);
    const list = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...ACCEPT, ...AUTH },
      body: rpc("tools/list", undefined, 2),
    });
    const tools = ((await list.json()) as any).result.tools.map((t: any) => t.name);
    expect(tools).toHaveLength(15);
    expect(tools).not.toContain("ha_call_service");
  });
});

describe("persistGeneratedToken (audit C7/E6/F2)", () => {
  it("does nothing when the token was not generated or no Supervisor", async () => {
    const post = vi.fn();
    expect(
      await persistGeneratedToken(cfg({ apiTokenGenerated: false }), { supervisorAvailable: true, supervisorPost: post } as any, [])
    ).toBe(false);
    expect(
      await persistGeneratedToken(cfg({ apiTokenGenerated: true }), { supervisorAvailable: false, supervisorPost: post } as any, [])
    ).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("merges the freshly read options and adds only api_token", async () => {
    const http = {
      supervisorAvailable: true,
      supervisorGet: vi.fn(async () => ({ options: { log_level: "debug", api_token: "" } })),
      supervisorPost: vi.fn(async () => ({})),
    };
    const ok = await persistGeneratedToken(cfg({ apiTokenGenerated: true }), http as any, []);
    expect(ok).toBe(true);
    expect(http.supervisorPost).toHaveBeenCalledWith("/addons/self/options", {
      options: { log_level: "debug", api_token: "test-token-long-enough" },
    });
  });

  it("skips the write when the user set a token meanwhile (audit F2 race)", async () => {
    const http = {
      supervisorAvailable: true,
      supervisorGet: vi.fn(async () => ({ options: { api_token: "user-set-token" } })),
      supervisorPost: vi.fn(),
    };
    expect(await persistGeneratedToken(cfg({ apiTokenGenerated: true }), http as any, [])).toBe(false);
    expect(http.supervisorPost).not.toHaveBeenCalled();
  });

  it("retries on Supervisor errors then succeeds (audit C7)", async () => {
    let calls = 0;
    const http = {
      supervisorAvailable: true,
      supervisorGet: vi.fn(async () => {
        calls++;
        if (calls < 3) throw new Error("HTTP 503: supervisor starting");
        return { options: {} };
      }),
      supervisorPost: vi.fn(async () => ({})),
    };
    expect(await persistGeneratedToken(cfg({ apiTokenGenerated: true }), http as any, [1, 1, 1])).toBe(true);
    expect(http.supervisorGet).toHaveBeenCalledTimes(3);
  });

  it("gives up after exhausting the retries", async () => {
    const http = {
      supervisorAvailable: true,
      supervisorGet: vi.fn(async () => {
        throw new Error("HTTP 503");
      }),
      supervisorPost: vi.fn(),
    };
    expect(await persistGeneratedToken(cfg({ apiTokenGenerated: true }), http as any, [1])).toBe(false);
    expect(http.supervisorGet).toHaveBeenCalledTimes(2);
  });
});
