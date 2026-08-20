import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerHistoryTools } from "./history.js";
import { setLogLevel } from "../../logger.js";
import { callTool, fakeCtx, fakeServer } from "./testkit.js";

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
