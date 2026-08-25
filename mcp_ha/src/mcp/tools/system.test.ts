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

  it("reads recent errors through system_log/list, projected (#153)", async () => {
    const { server, tools } = fakeServer();
    const ws = {
      send: vi.fn(async () => [
        { timestamp: 1755648000.5, level: "ERROR", source: ["components/automation/__init__.py", 42], message: ["Error rendering template", "second part"], count: 3, first_occurred: 1755647000 },
        { timestamp: 1755648100, level: "WARNING", source: ["helpers/entity.py", 7], message: "single message", count: 1 },
      ]),
    };
    registerSystemTools(server, fakeCtx({ ws }));
    const res = await callTool(tools, "ha_get_system", { section: "error_log" });
    expect(ws.send).toHaveBeenCalledWith("system_log/list", {});
    expect(res.data.entries[0]).toMatchObject({
      level: "ERROR",
      source: "components/automation/__init__.py:42",
      message: "Error rendering template | second part",
      count: 3,
    });
    expect(res.data.entries[0].timestamp).toMatch(/^2025-/);
    expect(res.data.entries[1].count).toBeUndefined();
    expect(res.data.total).toBe(2);
  });

  it("falls back to the legacy REST error log on old cores (#153)", async () => {
    const { server, tools } = fakeServer();
    const ws = { send: vi.fn(async () => { throw new Error("unknown command"); }) };
    const coreGetText = vi.fn(async () => Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"));
    registerSystemTools(server, fakeCtx({ ws, http: { coreGetText } }));
    const res = await callTool(tools, "ha_get_system", { section: "error_log" });
    expect(res.data.total_lines).toBe(300);
    expect(res.data.showing).toBe(100);
    expect(res.data.log.endsWith("line 299")).toBe(true);
  });

  it("answers structured when neither log source is reachable (#153)", async () => {
    const { server, tools } = fakeServer();
    const ws = { send: vi.fn(async () => { throw new Error("unknown command"); }) };
    const coreGetText = vi.fn(async () => { throw new Error("HTTP 404: Not Found"); });
    registerSystemTools(server, fakeCtx({ ws, http: { coreGetText } }));
    const res = await callTool(tools, "ha_get_system", { section: "error_log" });
    expect(res.isError).toBe(false);
    expect(res.data.available).toBe(false);
    expect(res.data.note).toContain("Settings > System > Logs");
  });
});

describe("ha_get_system: updates and backups (#111)", () => {
  it("summarizes pending core, OS and add-on updates", async () => {
    const { server, tools } = fakeServer();
    const supervisorGet = vi.fn(async (path: string) => {
      if (path === "/core/info") return { version: "2026.8.1", version_latest: "2026.8.2", update_available: true };
      if (path === "/os/info") return { version: "16.1", version_latest: "16.1", update_available: false };
      return { addons: [
        { slug: "mcp_ha", version: "0.14.0", version_latest: "0.15.0", update_available: true },
        { slug: "ssh", version: "9.0", version_latest: "9.0", update_available: false },
      ] };
    });
    registerSystemTools(server, fakeCtx({ http: { supervisorGet } }));
    const res = await callTool(tools, "ha_get_system", { section: "updates" });
    expect(res.data.core).toEqual({ version: "2026.8.1", latest: "2026.8.2", update_available: true });
    expect(res.data.os.update_available).toBe(false);
    expect(res.data.addons).toMatchObject({ total: 2, updates_pending: 1 });
    expect(res.data.addons.pending[0].slug).toBe("mcp_ha");
  });

  it("answers partially when the minimal role denies core and os info (#153)", async () => {
    const { server, tools } = fakeServer();
    const supervisorGet = vi.fn(async (path: string) => {
      if (path === "/addons") return { addons: [{ slug: "mcp_ha", version: "0.27.0", version_latest: "0.27.1", update_available: true }] };
      throw new Error("HTTP 403: 403: Forbidden");
    });
    registerSystemTools(server, fakeCtx({ http: { supervisorGet } }));
    const res = await callTool(tools, "ha_get_system", { section: "updates" });
    expect(res.isError).toBe(false);
    expect(res.data.core).toMatchObject({ available: false });
    expect(res.data.core.note).toContain("minimal");
    expect(res.data.os).toMatchObject({ available: false });
    expect(res.data.addons).toMatchObject({ total: 1, updates_pending: 1 });
  });

  it("lists backups newest first with the age of the last one", async () => {
    const { server, tools } = fakeServer();
    const supervisorGet = vi.fn(async () => ({
      backups: [
        { slug: "a1", name: "old", date: "2026-08-01T02:00:00Z", type: "full", size: 512 },
        { slug: "b2", name: "fresh", date: "2026-08-21T02:00:00Z", type: "partial", size: 128 },
      ],
    }));
    registerSystemTools(server, fakeCtx({ http: { supervisorGet } }));
    const res = await callTool(tools, "ha_get_system", { section: "backups" });
    expect(res.data.last_backup.name).toBe("fresh");
    expect(res.data.last_backup.age_days).toBeGreaterThanOrEqual(0);
    expect(res.data.recent.map((b: any) => b.slug)).toEqual(["b2", "a1"]);
  });

  it("degrades honestly when the minimal role cannot list backups", async () => {
    const { server, tools } = fakeServer();
    const supervisorGet = vi.fn(async () => {
      throw new Error("HTTP 403: forbidden");
    });
    registerSystemTools(server, fakeCtx({ http: { supervisorGet } }));
    const res = await callTool(tools, "ha_get_system", { section: "backups" });
    expect(res.isError).toBe(false);
    expect(res.data.available).toBe(false);
    expect(res.data.note).toContain("minimal");
  });
});
