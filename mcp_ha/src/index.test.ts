import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createHandler, reconcileOptions } from "./index.js";
import { setLogLevel } from "./logger.js";
import type { AddonConfig } from "./config.js";

beforeAll(() => setLogLevel("fatal"));

function cfg(partial: Partial<AddonConfig> = {}): AddonConfig {
  return {
    port: 0,
    apiToken: "test-token-long-enough",
    apiTokenGenerated: false,
    allowWrite: false,
    allowCamera: false,
    filterReads: false,
    entityAllowlist: [],
    entityDenylist: [],
    serviceDenylist: [],
    confirmDomains: [],
    apiTokens: [],
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
    catalog: { index: vi.fn(async () => []), registries: vi.fn(async () => ({ at: 0, areas: [], devices: [], entities: [] })), states: vi.fn(), ...(partial.catalog ?? {}) },
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
    expect(tools).toHaveLength(17); // 15 core read + calendar + todo
    expect(tools).not.toContain("ha_call_service");
  });
});

describe("scoped named tokens (#85)", () => {
  const toolNames = async (base: string, token: string) => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
      body: rpc("tools/list"),
    });
    return ((await r.json()) as any).result.tools.map((t: any) => t.name);
  };

  it("accepts a named write token and shows the write tools, but a read token does not", async () => {
    const base = await startServer(
      fakeCtx({
        cfg: {
          allowWrite: true,
          apiToken: "test-token-long-enough",
          apiTokens: [
            { name: "writer", token: "write-token-16chars-x", scope: "write" },
            { name: "reader", token: "read-token-16chars-xx", scope: "read" },
          ],
        },
      })
    );
    // default (primary) token is write scope
    expect(await toolNames(base, "test-token-long-enough")).toContain("ha_call_service");
    // named write token
    expect(await toolNames(base, "write-token-16chars-x")).toContain("ha_run_script");
    // named read token: allow_write is on, but the scope forbids writes
    const readTools = await toolNames(base, "read-token-16chars-xx");
    expect(readTools).toHaveLength(17);
    expect(readTools).not.toContain("ha_call_service");
    expect(readTools).not.toContain("ha_run_script");
  });

  it("rejects a token that matches none of the configured ones", async () => {
    const base = await startServer(fakeCtx({ cfg: { apiTokens: [{ name: "x", token: "known-token-16chars-x", scope: "read" }] } }));
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer wrong-token" },
      body: rpc("tools/list"),
    });
    expect(r.status).toBe(401);
  });
});

describe("MCP resources, prompts and structuredContent (v0.3 #79)", () => {
  it("lists and reads the three resources", async () => {
    const ctx = fakeCtx({
      ws: {
        send: vi.fn(async (type: string) =>
          type === "get_config"
            ? { version: "2026.8.1", location_name: "Home", components: ["a", "b"] }
            : { light: { turn_on: {} } }
        ),
      },
      catalog: {
        index: vi.fn(async () => []),
        registries: vi.fn(async () => ({ at: 0, areas: [{ area_id: "a1", name: "Kitchen" }], devices: [], entities: [] })),
      },
    });
    const base = await startServer(ctx);
    const H = { ...ACCEPT, ...AUTH };
    const list = await fetch(`${base}/mcp`, { method: "POST", headers: H, body: rpc("resources/list") });
    const uris = ((await list.json()) as any).result.resources.map((r: any) => r.uri).sort();
    expect(uris).toEqual(["ha://areas", "ha://config", "ha://services"]);

    const read = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: H,
      body: rpc("resources/read", { uri: "ha://config" }, 2),
    });
    const contents = ((await read.json()) as any).result.contents[0];
    expect(contents.mimeType).toBe("application/json");
    expect(JSON.parse(contents.text)).toMatchObject({ version: "2026.8.1", components: 2 });
  });

  it("lists the prompts and renders diagnose-automation with its argument", async () => {
    const base = await startServer(fakeCtx());
    const H = { ...ACCEPT, ...AUTH };
    const list = await fetch(`${base}/mcp`, { method: "POST", headers: H, body: rpc("prompts/list") });
    const names = ((await list.json()) as any).result.prompts.map((p: any) => p.name).sort();
    expect(names).toEqual(["diagnose-automation", "energy-report"]);

    const get = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: H,
      body: rpc("prompts/get", { name: "diagnose-automation", arguments: { automation: "automation.x" } }, 2),
    });
    const text = ((await get.json()) as any).result.messages[0].content.text;
    expect(text).toContain("automation.x");
    expect(text).toContain("ha_get_automation");
  });

  it("ships structuredContent alongside the text on tool calls", async () => {
    const base = await startServer(
      fakeCtx({
        catalog: {
          index: vi.fn(async () => []),
          registries: vi.fn(async () => ({ at: 0, areas: [], devices: [], entities: [] })),
        },
      })
    );
    const call = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...ACCEPT, ...AUTH },
      body: rpc("tools/call", { name: "ha_list_areas", arguments: {} }),
    });
    const result = ((await call.json()) as any).result;
    expect(result.structuredContent).toEqual({ items: [], total: 0 });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });
});

describe("reconcileOptions (audit C7/E6/F2, migration #81)", () => {
  /** Stored options of a fully up-to-date install (all migration keys present). */
  const UP_TO_DATE = { log_level: "info", api_token: "user-set-token", confirm_domains: ["lock"], api_tokens: [], allow_camera: false };

  it("does nothing without a Supervisor or when everything is already in place", async () => {
    const post = vi.fn();
    expect(
      await reconcileOptions(cfg({ apiTokenGenerated: true }), { supervisorAvailable: false, supervisorPost: post } as any, [])
    ).toBe(false);
    const http = {
      supervisorAvailable: true,
      supervisorGet: vi.fn(async () => ({ options: UP_TO_DATE })),
      supervisorPost: post,
    };
    expect(await reconcileOptions(cfg({ apiTokenGenerated: false }), http as any, [])).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("adds the option keys missing from an upgraded install, even without a generated token (#81)", async () => {
    // Thomas's exact incident: token set long ago, confirm_domains absent,
    // every config save refused by the Supervisor until the key exists.
    const http = {
      supervisorAvailable: true,
      supervisorGet: vi.fn(async () => ({ options: { log_level: "info", api_token: "user-set-token", allow_write: false } })),
      supervisorPost: vi.fn(async () => ({})),
    };
    expect(await reconcileOptions(cfg({ apiTokenGenerated: false }), http as any, [])).toBe(true);
    expect(http.supervisorPost).toHaveBeenCalledWith("/addons/self/options", {
      options: {
        log_level: "info",
        api_token: "user-set-token",
        allow_write: false,
        confirm_domains: ["lock", "alarm_control_panel"],
        api_tokens: [],
        allow_camera: false,
      },
    });
  });

  it("merges the generated token and the migrations in a single post", async () => {
    const http = {
      supervisorAvailable: true,
      supervisorGet: vi.fn(async () => ({ options: { log_level: "debug", api_token: "" } })),
      supervisorPost: vi.fn(async () => ({})),
    };
    const ok = await reconcileOptions(cfg({ apiTokenGenerated: true }), http as any, []);
    expect(ok).toBe(true);
    expect(http.supervisorPost).toHaveBeenCalledWith("/addons/self/options", {
      options: {
        log_level: "debug",
        api_token: "test-token-long-enough",
        confirm_domains: ["lock", "alarm_control_panel"],
        api_tokens: [],
        allow_camera: false,
      },
    });
  });

  it("never overwrites a token the user set meanwhile (audit F2 race)", async () => {
    const http = {
      supervisorAvailable: true,
      supervisorGet: vi.fn(async () => ({ options: UP_TO_DATE })),
      supervisorPost: vi.fn(),
    };
    expect(await reconcileOptions(cfg({ apiTokenGenerated: true }), http as any, [])).toBe(false);
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
    expect(await reconcileOptions(cfg({ apiTokenGenerated: true }), http as any, [1, 1, 1])).toBe(true);
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
    expect(await reconcileOptions(cfg({ apiTokenGenerated: true }), http as any, [1])).toBe(false);
    expect(http.supervisorGet).toHaveBeenCalledTimes(2);
  });
});
