import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HaHttp } from "./http.js";
import { setLogLevel } from "../logger.js";
import type { AddonConfig } from "../config.js";

function cfg(partial: Partial<AddonConfig> = {}): AddonConfig {
  return {
    port: 9583,
    apiToken: "t",
    apiTokenGenerated: false,
    allowWrite: false,
    filterReads: false,
    entityAllowlist: [],
    entityDenylist: [],
    serviceDenylist: [],
    supervisorToken: null,
    devHaUrl: null,
    devHaToken: null,
    ...partial,
  };
}

function mockFetch(status: number, body: unknown, asText = false) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => body,
    text: async () => (asText ? String(body) : JSON.stringify(body)),
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeAll(() => setLogLevel("fatal"));
afterEach(() => vi.unstubAllGlobals());

describe("HaHttp core", () => {
  it("targets the Supervisor proxy with the Supervisor token when available", async () => {
    const fetchMock = mockFetch(200, { ok: true });
    const http = new HaHttp(cfg({ supervisorToken: "sup-token", devHaUrl: "http://dev", devHaToken: "dev" }));
    await http.coreGet("/states");
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("http://supervisor/core/api/states");
    expect(init.headers.Authorization).toBe("Bearer sup-token");
  });

  it("falls back to HA_URL and the dev token outside the add-on", async () => {
    const fetchMock = mockFetch(200, {});
    const http = new HaHttp(cfg({ devHaUrl: "http://ha.local:8123/", devHaToken: "dev-token" }));
    await http.coreGet("/config");
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("http://ha.local:8123/api/config");
    expect(init.headers.Authorization).toBe("Bearer dev-token");
  });

  it("throws a readable error on non-2xx answers", async () => {
    mockFetch(404, { message: "not found" });
    const http = new HaHttp(cfg({ devHaUrl: "http://ha", devHaToken: "d" }));
    await expect(http.coreGet("/nope")).rejects.toThrow(/HTTP 404/);
  });

  it("posts JSON and returns raw text with corePostText", async () => {
    const fetchMock = mockFetch(200, "rendered!", true);
    const http = new HaHttp(cfg({ devHaUrl: "http://ha", devHaToken: "d" }));
    const out = await http.corePostText("/template", { template: "{{ 1 + 1 }}" });
    expect(out).toBe("rendered!");
    const [, init] = fetchMock.mock.calls[0] as any;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ template: "{{ 1 + 1 }}" });
  });
});

describe("HaHttp supervisor", () => {
  it("unwraps the { result, data } envelope", async () => {
    mockFetch(200, { result: "ok", data: { addons: [{ slug: "a" }] } });
    const http = new HaHttp(cfg({ supervisorToken: "sup" }));
    const data = await http.supervisorGet("/addons");
    expect(data).toEqual({ addons: [{ slug: "a" }] });
  });

  it("refuses supervisor calls in dev mode with a clear error", async () => {
    const fetchMock = mockFetch(200, {});
    const http = new HaHttp(cfg({ devHaUrl: "http://ha", devHaToken: "d" }));
    await expect(http.supervisorGet("/addons")).rejects.toThrow(/not available outside the add-on/);
    await expect(http.supervisorPost("/addons/self/options", {})).rejects.toThrow(/not available outside the add-on/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(http.supervisorAvailable).toBe(false);
  });

  it("posts options through supervisorPost", async () => {
    const fetchMock = mockFetch(200, { result: "ok", data: null });
    const http = new HaHttp(cfg({ supervisorToken: "sup" }));
    await http.supervisorPost("/addons/self/options", { options: { api_token: "x" } });
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("http://supervisor/addons/self/options");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ options: { api_token: "x" } });
  });
});
