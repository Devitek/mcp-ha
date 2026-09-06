import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerHistoryTools } from "./history.js";
import { setLogLevel } from "../../logger.js";
import { callTool, fakeCtx, fakeServer, entity } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));

function setup(wsSend: (type: string, payload: any) => Promise<any>, cfgOver: any = {}) {
  const { server, tools } = fakeServer();
  const ws = { send: vi.fn(wsSend) };
  registerHistoryTools(server, fakeCtx({ cfg: cfgOver, ws }));
  return { tools, ws };
}

describe("ha_get_history", () => {
  it("normalizes the compressed WS format and tolerates the long one", async () => {
    const { tools, ws } = setup(async () => ({
      "sensor.temp": [
        { s: "21.5", lu: 1755648000 },
        { state: "22.0", last_updated: "2026-08-20T01:00:00Z" },
      ],
    }));
    const res = await callTool(tools, "ha_get_history", { entity_id: "sensor.temp", hours: 24 });
    expect(res.data.points).toEqual([
      { t: "2025-08-20T00:00:00.000Z", state: "21.5" },
      { t: "2026-08-20T01:00:00.000Z", state: "22.0" },
    ]);
    expect(ws.send).toHaveBeenCalledWith(
      "history/history_during_period",
      expect.objectContaining({ entity_ids: ["sensor.temp"], minimal_response: true, no_attributes: true })
    );
  });

  it("downsamples beyond 250 points, says so, and still fits the global cap", async () => {
    const raw = Array.from({ length: 1200 }, (_, i) => ({ s: String(i), lu: 1755648000 + i }));
    const { tools } = setup(async () => ({ "sensor.temp": raw }));
    const res = await callTool(tools, "ha_get_history", { entity_id: "sensor.temp" });
    expect(res.data.count).toBe(1200);
    expect(res.data.points.length).toBeLessThanOrEqual(251);
    expect(res.data.note).toContain("downsampled");
    // The last raw point always survives the downsampling.
    expect(res.data.points.at(-1).state).toBe("1199");
    // The downsampled response must not trip the global size cap.
    expect(res.data.truncated).toBeUndefined();
  });

  it("fetches several entities in one call and shares the point budget (#88)", async () => {
    const mk = (n: number, base: number) => Array.from({ length: n }, (_, i) => ({ s: String(i), lu: base + i }));
    const { tools, ws } = setup(async () => ({
      "sensor.a": mk(300, 1755648000),
      "sensor.b": mk(10, 1755648000),
    }));
    const res = await callTool(tools, "ha_get_history", { entity_id: ["sensor.a", "sensor.b", "sensor.a"] });
    expect(ws.send).toHaveBeenCalledWith(
      "history/history_during_period",
      expect.objectContaining({ entity_ids: ["sensor.a", "sensor.b"] }) // deduplicated
    );
    expect(res.data.series["sensor.a"].count).toBe(300);
    // Budget of 250 shared between 2 entities: at most 125 (+ last point) each.
    expect(res.data.series["sensor.a"].points.length).toBeLessThanOrEqual(126);
    expect(res.data.series["sensor.a"].note).toContain("downsampled");
    expect(res.data.series["sensor.b"].points).toHaveLength(10);
    // The single-entity shape is not used for list calls.
    expect(res.data.points).toBeUndefined();
  });

  it("caps the list at 5 entities in the input schema (#88)", () => {
    const { tools } = setup(async () => ({}));
    const schema = tools.get("ha_get_history")!.cfg.inputSchema.entity_id;
    expect(schema.safeParse(["a.b", "c.d", "e.f", "g.h", "i.j"]).success).toBe(true);
    expect(schema.safeParse(["a.b", "c.d", "e.f", "g.h", "i.j", "k.l"]).success).toBe(false);
  });

  it("refuses the whole call when one listed entity is filtered (#88)", async () => {
    const { tools, ws } = setup(async () => ({}), { filterReads: true, entityDenylist: ["camera.*"] });
    const res = await callTool(tools, "ha_get_history", { entity_id: ["sensor.ok", "camera.front"] });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("camera.front");
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("rejects windows wider than 7 days", async () => {
    const { tools, ws } = setup(async () => ({}));
    const res = await callTool(tools, "ha_get_history", { entity_id: "sensor.temp", hours: 200 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("too wide");
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("respects filter_reads", async () => {
    const { tools } = setup(async () => ({}), { filterReads: true, entityDenylist: ["camera.*"] });
    const res = await callTool(tools, "ha_get_history", { entity_id: "camera.front" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("filter_reads");
  });
});

describe("ha_get_statistics", () => {
  it("normalizes timestamps and rounds values", async () => {
    const { tools, ws } = setup(async () => ({
      "sensor.energy": [{ start: 1755648000000, mean: 1.23456789, min: null, max: 2, sum: 10.000004, state: 5 }],
    }));
    const res = await callTool(tools, "ha_get_statistics", { statistic_id: "sensor.energy", period: "day" });
    expect(res.data.statistics["sensor.energy"][0]).toEqual({
      start: "2025-08-20T00:00:00.000Z",
      mean: 1.235,
      min: null,
      max: 2,
      sum: 10,
      state: 5,
    });
    expect(ws.send).toHaveBeenCalledWith(
      "recorder/statistics_during_period",
      expect.objectContaining({ statistic_ids: ["sensor.energy"], period: "day" })
    );
  });

  it("accepts a list of statistic ids", async () => {
    const { ws, tools } = setup(async () => ({}));
    await callTool(tools, "ha_get_statistics", { statistic_id: ["a.b", "c.d"] });
    expect(ws.send).toHaveBeenCalledWith(
      "recorder/statistics_during_period",
      expect.objectContaining({ statistic_ids: ["a.b", "c.d"], period: "hour" })
    );
  });
});

describe("ha_get_logbook", () => {
  it("caps events, keeps the most recent ones and filters denied entities", async () => {
    const events = Array.from({ length: 250 }, (_, i) => ({
      when: 1755648000 + i,
      name: `event ${i}`,
      entity_id: i % 10 === 0 ? "camera.front" : "light.kitchen",
      state: "on",
    }));
    const { tools } = setup(async () => events, { filterReads: true, entityDenylist: ["camera.*"] });
    const res = await callTool(tools, "ha_get_logbook", { hours: 24 });
    expect(res.data.count).toBe(225); // 250 minus the 25 camera events
    expect(res.data.events.length).toBe(100);
    expect(res.data.note).toContain("100");
    expect(res.data.events.at(-1).name).toBe("event 249");
    expect(res.data.events[0].when).toMatch(/^\d{4}-/);
    expect(res.data.events.every((e: any) => e.entity_id !== "camera.front")).toBe(true);
  });
});
describe("ha_get_logbook by area or floor (#194)", () => {
  function scopeSetup(events: any[] = []) {
    const { server, tools } = fakeServer();
    const ws = { send: vi.fn(async () => events) };
    const index = [
      entity("light.kitchen_main", { area: "Kitchen", floor: "Ground floor" }),
      entity("sensor.kitchen_temp", { area: "Kitchen", floor: "Ground floor" }),
      entity("light.bedroom", { area: "Bedroom", floor: "First floor" }),
    ];
    const ctx = fakeCtx({ ws, catalog: { index: async () => index } });
    registerHistoryTools(server, ctx);
    return { tools, ws };
  }

  it("resolves an area into its visible entity ids", async () => {
    const { tools, ws } = scopeSetup([{ when: "2026-09-03T10:00:00Z", name: "Kitchen main", entity_id: "light.kitchen_main", state: "on" }]);
    const res = await callTool(tools, "ha_get_logbook", { area: "kitchen" });
    const payload = (ws.send.mock.calls[0] as any)[1];
    expect(payload.entity_ids.sort()).toEqual(["light.kitchen_main", "sensor.kitchen_temp"]);
    expect(res.data.events[0].entity_id).toBe("light.kitchen_main");
  });

  it("resolves a floor too, and refuses combined scopes", async () => {
    const { tools, ws } = scopeSetup();
    await callTool(tools, "ha_get_logbook", { floor: "ground floor" });
    const payload = (ws.send.mock.calls[0] as any)[1];
    expect(payload.entity_ids).toHaveLength(2);
    const both = await callTool(tools, "ha_get_logbook", { area: "Kitchen", entity_id: "light.bedroom" });
    expect(both.isError).toBe(true);
    expect(both.text).toContain("ONE of");
  });

  it("answers an actionable error for an unknown area, listing the known ones", async () => {
    const { tools } = scopeSetup();
    const res = await callTool(tools, "ha_get_logbook", { area: "Garage" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Known areas");
    expect(res.text).toContain("Kitchen");
  });

  it("caps the resolved entity list at 60 with a scope note", async () => {
    const { server, tools } = fakeServer();
    const ws = { send: vi.fn(async () => []) };
    const many = Array.from({ length: 70 }, (_, i) => entity(`sensor.s${i}`, { area: "Big room" }));
    registerHistoryTools(server, fakeCtx({ ws, catalog: { index: async () => many } }));
    const res = await callTool(tools, "ha_get_logbook", { area: "big room" });
    const payload = (ws.send.mock.calls[0] as any)[1];
    expect(payload.entity_ids).toHaveLength(60);
    expect(res.data.scope_note).toContain("70 entities");
  });
});

