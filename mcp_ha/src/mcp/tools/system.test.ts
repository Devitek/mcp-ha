import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerSystemTools } from "./system.js";
import { setLogLevel } from "../../logger.js";
import { callTool, fakeCtx, fakeServer } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));

describe("ha_render_template", () => {
  it("renders through REST and truncates huge outputs", async () => {
    const { server, tools } = fakeServer();
    const corePostText = vi.fn(async () => "x".repeat(9000));
    registerSystemTools(server, fakeCtx({ http: { corePostText } }));
    const res = await callTool(tools, "ha_render_template", { template: "{{ states('a.b') }}" });
    expect(corePostText).toHaveBeenCalledWith("/template", { template: "{{ states('a.b') }}" });
    expect(res.data.rendered).toContain("truncated");
  });

  it("is not registered at all when filter_reads is active (audit D5)", () => {
    const { server, tools } = fakeServer();
    registerSystemTools(server, fakeCtx({ cfg: { filterReads: true, entityDenylist: ["camera.*"] } }));
    expect(tools.has("ha_render_template")).toBe(false);
    expect(tools.has("ha_get_system")).toBe(true);
  });
});

describe("ha_get_system", () => {
  it("projects a compact config summary", async () => {
    const { server, tools } = fakeServer();
    const ws = {
      send: vi.fn(async () => ({
        version: "2026.8.1",
        location_name: "Home",
        time_zone: "Europe/Paris",
        unit_system: { temperature: "°C" },
        currency: "EUR",
        country: "FR",
        components: ["light", "sensor", "automation"],
        state: "RUNNING",
        internal_url: "should not leak",
      })),
    };
    registerSystemTools(server, fakeCtx({ ws }));
    const res = await callTool(tools, "ha_get_system", { section: "config" });
    expect(res.data).toEqual({
      version: "2026.8.1",
      location_name: "Home",
      time_zone: "Europe/Paris",
      unit_system: { temperature: "°C" },
      currency: "EUR",
      country: "FR",
      components: 3,
      state: "RUNNING",
    });
  });

  it("tails the error log to the last 100 lines", async () => {
    const { server, tools } = fakeServer();
    const coreGetText = vi.fn(async () => Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"));
    registerSystemTools(server, fakeCtx({ http: { coreGetText } }));
    const res = await callTool(tools, "ha_get_system", { section: "error_log" });
    expect(res.data.total_lines).toBe(300);
    expect(res.data.showing).toBe(100);
    expect(res.data.log.startsWith("line 200")).toBe(true);
    expect(res.data.log.endsWith("line 299")).toBe(true);
  });
});
