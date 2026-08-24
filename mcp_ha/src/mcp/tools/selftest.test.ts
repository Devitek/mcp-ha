import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerSelfTestTools } from "./selftest.js";
import { setLogLevel } from "../../logger.js";
import { callTool, fakeCtx, fakeServer } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));

function setup(over: any = {}) {
  const { server, tools } = fakeServer();
  registerSelfTestTools(server, fakeCtx(over));
  return { tools };
}

describe("ha_get_self_test (#144)", () => {
  it("answers ok with latencies when everything responds", async () => {
    const { tools } = setup();
    const res = await callTool(tools, "ha_get_self_test", {});
    expect(res.data.verdict).toBe("ok");
    expect(res.data.websocket.connected).toBe(true);
    expect(res.data.websocket.latency_ms).toBeGreaterThanOrEqual(0);
    expect(res.data.rest.ok).toBe(true);
    expect(res.data.live_state_map).toBe("active");
    expect(res.data.supervisor).toBe("available");
    expect(res.data.note).toContain("no data from your home");
  });

  it("is broken when the WebSocket is down or REST fails", async () => {
    const { tools } = setup({ ws: { connected: false, send: vi.fn() } });
    const res = await callTool(tools, "ha_get_self_test", {});
    expect(res.data.verdict).toBe("broken");
    expect(res.data.reason).toContain("WebSocket");
    const { tools: t2 } = setup({ http: { coreGet: vi.fn(async () => { throw new Error("HTTP 502: bad gateway"); }) } });
    const res2 = await callTool(t2, "ha_get_self_test", {});
    expect(res2.data.verdict).toBe("broken");
    expect(res2.data.rest.ok).toBe(false);
    expect(res2.data.rest.error).toContain("502");
  });

  it("degrades when the live state map runs on the TTL fallback", async () => {
    const { tools } = setup({ catalog: { liveActive: false } });
    const res = await callTool(tools, "ha_get_self_test", {});
    expect(res.data.verdict).toBe("degraded");
    expect(res.data.live_state_map).toBe("ttl-fallback");
  });

  it("labels dev mode without a Supervisor", async () => {
    const { tools } = setup({ http: { supervisorAvailable: false } });
    const res = await callTool(tools, "ha_get_self_test", {});
    expect(res.data.supervisor).toContain("dev mode");
  });
});
