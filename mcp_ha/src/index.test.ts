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
    allowConfigWrite: false,
    enableSessions: false,
    filterReads: false,
    entityAllowlist: [],
    entityDenylist: [],
    serviceDenylist: [],
    confirmDomains: [],
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
    catalog: { index: vi.fn(async () => []), registries: vi.fn(async () => ({ at: 0, areas: [], devices: [], entities: [], floors: [], labels: [] })), states: vi.fn(), onEntityChange: vi.fn(() => () => {}), ...(partial.catalog ?? {}) },
  } as any;
}

let server: Server | null = null;

async function startServer(ctx: any, opts: any = {}): Promise<string> {
  server = createServer(createHandler(ctx, opts));
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
    expect(tools).toHaveLength(26); // all read tools
    expect(tools).not.toContain("ha_call_service");
  });
});

describe("usage counters (#128)", () => {
  it("counts tools/call at the handler for the authenticated client", async () => {
    const { UsageTracker } = await import("./usage.js");
    const usage = new UsageTracker();
    server = createServer(createHandler(fakeCtx(), { usage }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    if (typeof addr === "string" || addr === null) throw new Error("no port");
    const base = `http://127.0.0.1:${addr.port}`;
    const H = { ...ACCEPT, ...AUTH };
    await fetch(`${base}/mcp`, { method: "POST", headers: H, body: rpc("tools/list") });
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: H,
      body: rpc("tools/call", { name: "ha_list_areas", arguments: {} }),
    });
    const s = usage.snapshot();
    expect(s.total).toBe(1); // tools/list does not count
    expect(s.top_tools[0]).toEqual({ tool: "ha_list_areas", calls: 1 });
    expect(s.by_client[0]).toEqual({ client: "default", calls: 1 });
  });
});

describe("MCP completions (#115)", () => {
  const H = { ...ACCEPT, ...AUTH };
  const entities = [
    { entity_id: "automation.night_heating", name: "Night heating", domain: "automation", state: "on", area: null, floor: null, device_id: null, last_changed: "", hidden: false, category: null, aliases: [], labels: [], attributes: {} },
    { entity_id: "automation.morning", name: "Morning", domain: "automation", state: "on", area: null, floor: null, device_id: null, last_changed: "", hidden: false, category: null, aliases: [], labels: [], attributes: {} },
    { entity_id: "sensor.temp", name: "Temp", domain: "sensor", state: "21", area: null, floor: null, device_id: null, last_changed: "", hidden: false, category: null, aliases: [], labels: [], attributes: {} },
  ];

  it("completes prompt arguments with real automation ids", async () => {
    const base = await startServer(fakeCtx({ catalog: { index: vi.fn(async () => entities) } }));
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: H,
      body: rpc("completion/complete", {
        ref: { type: "ref/prompt", name: "diagnose-automation" },
        argument: { name: "automation", value: "night" },
      }),
    });
    const values = ((await r.json()) as any).result.completion.values;
    expect(values).toEqual(["automation.night_heating"]);
  });

  it("completes the ha://entity template under filter_reads rules", async () => {
    const base = await startServer(
      fakeCtx({
        cfg: { filterReads: true, entityDenylist: ["sensor.*"] },
        catalog: { index: vi.fn(async () => entities) },
      })
    );
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: H,
      body: rpc("completion/complete", {
        ref: { type: "ref/resource", uri: "ha://entity/{entity_id}" },
        argument: { name: "entity_id", value: "" },
      }),
    });
    const values = ((await r.json()) as any).result.completion.values;
    expect(values).toContain("automation.morning");
    expect(values).not.toContain("sensor.temp");
  });
});

describe("MCP sessions (#90)", () => {
  const S_AUTH = { ...ACCEPT, ...AUTH };
  /** Session responses are SSE: pull the JSON out of the data lines. */
  const sse = (text: string): any =>
    JSON.parse(
      text
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("")
    );
  const INIT = rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } });

  async function openSession(base: string, headers: Record<string, string> = S_AUTH): Promise<string> {
    const init = await fetch(`${base}/mcp`, { method: "POST", headers, body: INIT });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();
    await init.text();
    return sid!;
  }

  function sessionCtx(extra: any = {}) {
    return fakeCtx({ cfg: { enableSessions: true }, ...extra });
  }

  it("opens a session on initialize and serves follow-up requests on it", async () => {
    const base = await startServer(sessionCtx());
    const sid = await openSession(base);
    const list = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...S_AUTH, "mcp-session-id": sid },
      body: rpc("tools/list", undefined, 2),
    });
    expect(list.status).toBe(200);
    const tools = sse(await list.text()).result.tools.map((t: any) => t.name);
    expect(tools).toContain("ha_search_entities");
  });

  it("keeps the stateless one-shot path working alongside sessions", async () => {
    const base = await startServer(sessionCtx());
    const list = await fetch(`${base}/mcp`, { method: "POST", headers: S_AUTH, body: rpc("tools/list") });
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).result.tools.length).toBeGreaterThan(0);
  });

  it("rejects unknown sessions with 404 and foreign tokens with 403", async () => {
    const { TokenStore } = await import("./db/store.js");
    const store = await TokenStore.open(":memory:");
    const { token: otherToken } = await store.create({ name: "other", grants: { entities: "read" } });
    const base = await startServer(sessionCtx({ cfg: { enableSessions: true } }), { store });
    const unknown = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...S_AUTH, "mcp-session-id": "nope" },
      body: rpc("tools/list"),
    });
    expect(unknown.status).toBe(404);
    const sid = await openSession(base);
    const foreign = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...ACCEPT, Authorization: `Bearer ${otherToken}`, "mcp-session-id": sid },
      body: rpc("tools/list"),
    });
    expect(foreign.status).toBe(403);
  });

  it("ends a session on DELETE", async () => {
    const base = await startServer(sessionCtx());
    const sid = await openSession(base);
    const del = await fetch(`${base}/mcp`, { method: "DELETE", headers: { ...AUTH, "mcp-session-id": sid } });
    expect([200, 405].includes(del.status)).toBe(true); // SDK answers 200; some builds decline DELETE
    if (del.status === 200) {
      const after = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { ...S_AUTH, "mcp-session-id": sid },
        body: rpc("tools/list"),
      });
      expect(after.status).toBe(404);
    }
  });

  it("caps simultaneous sessions", async () => {
    server = createServer(createHandler(sessionCtx(), { maxSessions: 1 }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    if (typeof addr === "string" || addr === null) throw new Error("no port");
    const base = `http://127.0.0.1:${addr.port}`;
    await openSession(base);
    const second = await fetch(`${base}/mcp`, { method: "POST", headers: S_AUTH, body: INIT });
    expect(second.status).toBe(503);
  });

  it("serves and subscribes the ha://entity resource inside a session", async () => {
    const base = await startServer(
      sessionCtx({
        catalog: {
          index: vi.fn(async () => [
            { entity_id: "sensor.temp", name: "Temp", domain: "sensor", state: "21.5", area: null, floor: null, device_id: null, last_changed: "2026-01-01T00:00:00Z", hidden: false, category: null, aliases: [], labels: [], attributes: {} },
          ]),
          registries: vi.fn(async () => ({ at: 0, areas: [], devices: [], entities: [], floors: [], labels: [] })),
          onEntityChange: vi.fn(() => () => {}),
        },
      })
    );
    const sid = await openSession(base);
    const H = { ...S_AUTH, "mcp-session-id": sid };
    const read = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: H,
      body: rpc("resources/read", { uri: "ha://entity/sensor.temp" }, 3),
    });
    const content = JSON.parse(sse(await read.text()).result.contents[0].text);
    expect(content).toMatchObject({ entity_id: "sensor.temp", state: "21.5" });
    const sub = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: H,
      body: rpc("resources/subscribe", { uri: "ha://entity/sensor.temp" }, 4),
    });
    expect(sse(await sub.text()).result).toEqual({});
  });

  it("serves and subscribes the ha://area resource inside a session (#143)", async () => {
    const areaCatalog = {
      index: vi.fn(async () => [
        { entity_id: "light.salon", name: "Salon light", domain: "light", state: "on", area: "Salon", floor: null, device_id: null, last_changed: "", hidden: false, category: null, aliases: [], labels: [], attributes: {} },
        { entity_id: "sensor.salon_temp", name: "Salon temp", domain: "sensor", state: "21.5", area: "Salon", floor: null, device_id: null, last_changed: "", hidden: false, category: null, aliases: [], labels: [], attributes: {} },
      ]),
      registries: vi.fn(async () => ({ at: 0, areas: [{ area_id: "salon", name: "Salon", floor_id: "rdc" }], devices: [], entities: [], floors: [{ floor_id: "rdc", name: "Rez-de-chaussée", level: 0 }], labels: [] })),
      onEntityChange: vi.fn(() => () => {}),
    };
    const base = await startServer(sessionCtx({ catalog: areaCatalog }));
    const sid = await openSession(base);
    const H = { ...S_AUTH, "mcp-session-id": sid };
    const read = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: H,
      body: rpc("resources/read", { uri: "ha://area/salon" }, 3),
    });
    const content = JSON.parse(sse(await read.text()).result.contents[0].text);
    expect(content).toMatchObject({
      area_id: "salon",
      name: "Salon",
      floor: "Rez-de-chaussée",
      entity_count: 2,
      by_domain: { light: 1, sensor: 1 },
    });
    expect(content.notable).toEqual([{ entity_id: "light.salon", state: "on" }]);
    const sub = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: H,
      body: rpc("resources/subscribe", { uri: "ha://area/salon" }, 4),
    });
    expect(sse(await sub.text()).result).toEqual({});
    const unknown = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: H,
      body: rpc("resources/subscribe", { uri: "ha://area/garage" }, 5),
    });
    expect(sse(await unknown.text()).error.message).toContain("unknown area");
  });

  it("refuses subscribing a filtered entity", async () => {
    const base = await startServer(
      sessionCtx({
        cfg: { enableSessions: true, filterReads: true, entityDenylist: ["camera.*"] },
        catalog: { onEntityChange: vi.fn(() => () => {}) },
      })
    );
    const sid = await openSession(base);
    const sub = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...S_AUTH, "mcp-session-id": sid },
      body: rpc("resources/subscribe", { uri: "ha://entity/camera.front" }, 5),
    });
    const parsed = sse(await sub.text());
    expect(parsed.error.message).toContain("filter_reads");
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

  it("authenticates store tokens with capped grants, refuses revoked ones with an audit line (#166)", async () => {
    const { TokenStore } = await import("./db/store.js");
    const store = await TokenStore.open(":memory:");
    const { token, record } = await store.create({
      name: "automation-manager",
      grants: { entities: "read", automations: "manage", scripts: "write", camera: "read" },
    });
    const base = await startServer(
      fakeCtx({
        // allow_camera stays OFF: the requested camera grant must be capped away.
        cfg: { allowWrite: true, allowConfigWrite: true, apiToken: "test-token-long-enough" },
      }),
      { store }
    );
    const names = await toolNames(base, token);
    expect(names).toContain("ha_get_entity");
    expect(names).toContain("ha_update_automation");
    expect(names).toContain("ha_run_script");
    expect(names).not.toContain("ha_get_camera_snapshot"); // capped by allow_camera=false
    expect(names).not.toContain("ha_call_service"); // services grant absent: none
    expect(names).not.toContain("ha_send_notification");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await store.revoke(record.id);
    const denied = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
      body: rpc("tools/list"),
    });
    expect(denied.status).toBe(401);
    const auditLine = consoleSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("token_refused"));
    expect(auditLine).toContain("automation-manager");
    expect(auditLine).toContain("revoked");
    consoleSpy.mockRestore();
    store.close();
  });

  it("with every gate open, the server registers exactly the central registry (#165)", async () => {
    const { TOOL_REGISTRY } = await import("./mcp/registry.js");
    const base = await startServer(
      fakeCtx({
        cfg: { allowWrite: true, allowConfigWrite: true, allowCamera: true, apiToken: "test-token-long-enough" },
      })
    );
    const names = (await toolNames(base, "test-token-long-enough")).sort();
    // Two-way check: a tool added without a registry entry, or a registry
    // entry without a tool, both fail here. Counts everywhere derive from
    // the registry, so this is the only exhaustiveness gate needed.
    expect(names).toEqual(Object.keys(TOOL_REGISTRY).sort());
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
        registries: vi.fn(async () => ({ at: 0, areas: [{ area_id: "a1", name: "Kitchen" }], devices: [], entities: [], floors: [], labels: [] })),
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
    expect(names).toEqual(["daily-briefing", "diagnose-automation", "energy-report", "health-report", "propose-automation", "propose-dashboard-card", "propose-script"]);

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
          registries: vi.fn(async () => ({ at: 0, areas: [], devices: [], entities: [], floors: [], labels: [] })),
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
  const UP_TO_DATE = { log_level: "info", api_token: "user-set-token", confirm_domains: ["lock"], allow_camera: false, allow_config_write: false, enable_sessions: false };

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
        allow_camera: false,
        allow_config_write: false,
      enable_sessions: false,
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
        allow_camera: false,
        allow_config_write: false,
      enable_sessions: false,
      },
    });
  });

  it("removes deprecated keys from the stored options (#180)", async () => {
    const http = {
      supervisorAvailable: true,
      supervisorGet: vi.fn(async () => ({ options: { ...UP_TO_DATE } })),
      supervisorPost: vi.fn(async () => ({})),
    };
    const stored = { ...UP_TO_DATE, some_dead_option: true };
    const httpDead = {
      supervisorAvailable: true,
      supervisorGet: vi.fn(async () => ({ options: stored })),
      supervisorPost: vi.fn(async () => ({})),
    };
    expect(await reconcileOptions(cfg({ apiTokenGenerated: false }), httpDead as any, [], {}, ["some_dead_option"])).toBe(true);
    const posted = (httpDead.supervisorPost.mock.calls[0] as any)[1].options;
    expect("some_dead_option" in posted).toBe(false);
    expect(posted.confirm_domains).toEqual(["lock"]); // untouched keys survive
    // once gone, the same call is a no-op
    const http2 = {
      supervisorAvailable: true,
      supervisorGet: vi.fn(async () => ({ options: { ...UP_TO_DATE } })),
      supervisorPost: vi.fn(),
    };
    expect(await reconcileOptions(cfg({ apiTokenGenerated: false }), http2 as any, [], {}, ["some_dead_option"])).toBe(false);
    expect(http2.supervisorPost).not.toHaveBeenCalled();
  });

  it("does not retry a definitive 400 schema refusal (#184)", async () => {
    const err = Object.assign(new Error("HTTP 400: Missing option 'api_tokens' in root"), { status: 400 });
    const http = {
      supervisorAvailable: true,
      supervisorGet: vi.fn(async () => ({ options: { log_level: "info", api_token: "user-set-token" } })),
      supervisorPost: vi.fn(async () => {
        throw err;
      }),
    };
    expect(await reconcileOptions(cfg({ apiTokenGenerated: false }), http as any, [1, 1, 1])).toBe(false);
    expect(http.supervisorPost).toHaveBeenCalledTimes(1);
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
