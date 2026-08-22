import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerHealthTools } from "./health.js";
import { setLogLevel } from "../../logger.js";
import { callTool, entity, fakeCtx, fakeServer } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const fixtures = [
  entity("sensor.dead", { state: "unavailable", last_changed: daysAgo(12) }),
  entity("sensor.fresh_dead", { state: "unknown", last_changed: daysAgo(1) }),
  entity("sensor.door_battery", { state: "12", attributes: { device_class: "battery" } }),
  entity("binary_sensor.motion", { state: "off", attributes: { battery_level: 45 } }),
  entity("automation.never_ran", { state: "on", area: "Salon", attributes: { last_triggered: null } }),
  entity("automation.old_one", { state: "on", area: "Salon", attributes: { last_triggered: daysAgo(90) } }),
  entity("automation.active", { state: "on", area: "Salon", attributes: { last_triggered: daysAgo(2) } }),
  entity("automation.disabled", { state: "off", area: "Salon", attributes: { last_triggered: null } }),
  entity("light.no_area", { state: "on" }),
];

function setup(over: any = {}) {
  const { server, tools } = fakeServer();
  const ws = over.ws ?? { send: vi.fn(async () => ({ issues: [] })) };
  registerHealthTools(server, fakeCtx({ catalog: { index: async () => fixtures }, ws, ...over.ctx }));
  return { tools, ws };
}

describe("ha_get_health (#107)", () => {
  it("reports unavailable entities oldest first, with age", async () => {
    const { tools } = setup();
    const res = await callTool(tools, "ha_get_health", {});
    expect(res.data.unavailable.total).toBe(2);
    expect(res.data.unavailable.items[0]).toMatchObject({ entity_id: "sensor.dead", days: 12 });
  });

  it("finds low batteries through device_class and battery_level, honouring the threshold", async () => {
    const { tools } = setup();
    const low = (await callTool(tools, "ha_get_health", {})).data.low_batteries;
    expect(low.items).toEqual([{ entity_id: "sensor.door_battery", name: "sensor.door_battery", level: 12 }]);
    const wide = (await callTool(tools, "ha_get_health", { battery_threshold: 50 })).data.low_batteries;
    expect(wide.items.map((i: any) => i.entity_id)).toEqual(["sensor.door_battery", "binary_sensor.motion"]);
  });

  it("flags enabled automations never fired or stale, not disabled or active ones", async () => {
    const { tools } = setup();
    const stale = (await callTool(tools, "ha_get_health", {})).data.stale_automations;
    expect(stale.items.map((i: any) => i.entity_id).sort()).toEqual(["automation.never_ran", "automation.old_one"]);
  });

  it("counts entities without an area and surfaces HA repairs", async () => {
    const ws = {
      send: vi.fn(async () => ({
        issues: [{ domain: "hassio", severity: "error", translation_key: "unsupported", created: "2026-08-01T00:00:00Z", is_fixable: false }],
      })),
    };
    const { tools } = setup({ ws });
    const res = await callTool(tools, "ha_get_health", {});
    expect(ws.send).toHaveBeenCalledWith("repairs/list_issues", {});
    expect(res.data.repairs.items[0]).toMatchObject({ domain: "hassio", severity: "error", issue: "unsupported" });
    // the batteries and the unavailable sensors have no area but health only
    // counts visible, non-hidden, non-diagnostic entities
    expect(res.data.unassigned_entities).toBeGreaterThan(0);
  });

  it("degrades gracefully when repairs/list_issues is unsupported and under filter_reads", async () => {
    const ws = {
      send: vi.fn(async () => {
        throw new Error("unknown command");
      }),
    };
    const { tools } = setup({ ws, ctx: { cfg: { filterReads: true, entityDenylist: ["sensor.*"] } } });
    const res = await callTool(tools, "ha_get_health", {});
    expect(res.data.repairs.items).toEqual([]);
    // sensor.dead and sensor.fresh_dead are hidden by filter_reads, and the
    // battery sensor with them; motion sits above the default threshold.
    expect(res.data.unavailable.total).toBe(0);
    expect(res.data.low_batteries.items).toEqual([]);
  });
});
