import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerEnergyTools } from "./energy.js";
import { setLogLevel } from "../../logger.js";
import { callTool, fakeCtx, fakeServer } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));

const PREFS = {
  energy_sources: [
    { type: "grid", flow_from: [{ stat_energy_from: "sensor.grid_in" }], flow_to: [{ stat_energy_to: "sensor.grid_out" }] },
    { type: "solar", stat_energy_from: "sensor.solar" },
    { type: "gas", stat_energy_from: "sensor.gas" },
  ],
  device_consumption: [
    { stat_consumption: "sensor.oven", name: "Oven" },
    { stat_consumption: "sensor.tv", name: null },
  ],
};

function setup(over: any = {}) {
  const { server, tools } = fakeServer();
  const stats = over.stats ?? {
    "sensor.grid_in": [{ change: 4.2 }, { change: 1.8 }],
    "sensor.grid_out": [{ change: 0.5 }],
    "sensor.solar": [{ change: 3.0 }],
    "sensor.gas": [{ change: null }],
    "sensor.oven": [{ change: 2.0 }],
    "sensor.tv": [{ change: 0.4 }],
  };
  const ws = {
    send: vi.fn(async (type: string) => {
      if (type === "energy/get_prefs") {
        if (over.noPrefs) throw new Error("Energy not configured");
        return PREFS;
      }
      return stats;
    }),
  };
  registerEnergyTools(server, fakeCtx({ cfg: over.cfg ?? {}, ws }));
  return { tools, ws };
}

describe("ha_get_energy (#109)", () => {
  it("sums per-period changes into totals per source and ranks devices", async () => {
    const { tools, ws } = setup();
    const res = await callTool(tools, "ha_get_energy", {});
    expect(res.data.totals).toMatchObject({ grid_import: 6, grid_export: 0.5, solar: 3, gas: 0 });
    expect(res.data.top_devices[0]).toMatchObject({ stat: "sensor.oven", name: "Oven", total: 2 });
    const [, payload] = (ws.send as any).mock.calls.find((c: any[]) => c[0] === "recorder/statistics_during_period");
    expect(payload.types).toEqual(["change"]);
    expect(payload.statistic_ids).toContain("sensor.grid_in");
  });

  it("compares with the previous period and computes deltas", async () => {
    const { tools, ws } = setup();
    const res = await callTool(tools, "ha_get_energy", { period: "week", compare: true });
    expect((ws.send as any).mock.calls.filter((c: any[]) => c[0] === "recorder/statistics_during_period")).toHaveLength(2);
    expect(res.data.previous.grid_import).toBe(6);
    expect(res.data.delta_percent.grid_import).toBe(0);
  });

  it("explains clearly when the energy dashboard is not configured", async () => {
    const { tools } = setup({ noPrefs: true });
    const res = await callTool(tools, "ha_get_energy", {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("not configured");
    expect(res.text).toContain("ha_get_statistics");
  });

  it("drops statistics hidden by filter_reads", async () => {
    const { tools, ws } = setup({ cfg: { filterReads: true, entityDenylist: ["sensor.oven"] } });
    await callTool(tools, "ha_get_energy", {});
    const [, payload] = (ws.send as any).mock.calls.find((c: any[]) => c[0] === "recorder/statistics_during_period");
    expect(payload.statistic_ids).not.toContain("sensor.oven");
  });
});
