import { beforeAll, describe, expect, it, vi } from "vitest";
import { Catalog } from "./catalog.js";
import { setLogLevel } from "../logger.js";

const areas = [{ area_id: "ar_kitchen", name: "Kitchen" }];
const devices = [
  { id: "dev1", name: "Hue bulb", name_by_user: null, manufacturer: "Philips", model: "LCA001", area_id: "ar_kitchen", disabled_by: null },
];
const entities = [
  // Direct area assignment on the entity.
  { entity_id: "light.direct", area_id: "ar_kitchen", device_id: null, disabled_by: null, hidden_by: null, entity_category: null },
  // Area inherited from the device.
  { entity_id: "light.via_device", area_id: null, device_id: "dev1", disabled_by: null, hidden_by: null, entity_category: null },
  { entity_id: "sensor.hidden_one", area_id: null, device_id: null, disabled_by: null, hidden_by: "user", entity_category: "diagnostic" },
];
const states = [
  { entity_id: "light.direct", state: "on", attributes: { friendly_name: "Direct light" }, last_changed: "2026-01-01T00:00:00Z", last_updated: "2026-01-01T00:00:00Z" },
  { entity_id: "light.via_device", state: "off", attributes: {}, last_changed: "2026-01-01T00:00:00Z", last_updated: "2026-01-01T00:00:00Z" },
  { entity_id: "sensor.hidden_one", state: "42", attributes: { friendly_name: "Diag" }, last_changed: "2026-01-01T00:00:00Z", last_updated: "2026-01-01T00:00:00Z" },
  // No registry entry at all (e.g. a template entity).
  { entity_id: "sensor.orphan", state: "1", attributes: {}, last_changed: "2026-01-01T00:00:00Z", last_updated: "2026-01-01T00:00:00Z" },
];

function fakeWs(overrides: Record<string, unknown> = {}) {
  return {
    send: vi.fn(async (type: string) => {
      if (type in overrides) return overrides[type];
      switch (type) {
        case "config/area_registry/list": return areas;
        case "config/device_registry/list": return devices;
        case "config/entity_registry/list": return entities;
        case "get_states": return states;
        default: throw new Error(`unexpected command ${type}`);
      }
    }),
  };
}

beforeAll(() => setLogLevel("fatal"));

describe("Catalog.index", () => {
  it("joins states with registries", async () => {
    const catalog = new Catalog(fakeWs() as any);
    const index = await catalog.index();
    const byId = new Map(index.map((e) => [e.entity_id, e]));

    expect(byId.get("light.direct")).toMatchObject({ name: "Direct light", area: "Kitchen", domain: "light", state: "on" });
    // Area resolved through the device registry.
    expect(byId.get("light.via_device")).toMatchObject({ area: "Kitchen", name: "light.via_device" });
    expect(byId.get("sensor.hidden_one")).toMatchObject({ hidden: true, category: "diagnostic" });
    // Entities without a registry entry survive the join.
    expect(byId.get("sensor.orphan")).toMatchObject({ area: null, hidden: false, name: "sensor.orphan" });
  });

  it("caches states and registries within their TTLs (audit F1)", async () => {
    const ws = fakeWs();
    const catalog = new Catalog(ws as any);
    await catalog.index();
    await catalog.index();
    const calls = ws.send.mock.calls.map((c) => c[0]);
    // Everything served from cache on the second run.
    expect(calls.filter((t) => t === "get_states")).toHaveLength(1);
    expect(calls.filter((t) => t.startsWith("config/"))).toHaveLength(3);
  });

  it("shares the in-flight promise between concurrent callers (audit B5)", async () => {
    const ws = fakeWs();
    const catalog = new Catalog(ws as any);
    await Promise.all([catalog.index(), catalog.index(), catalog.index()]);
    const calls = ws.send.mock.calls.map((c) => c[0]);
    expect(calls.filter((t) => t === "get_states")).toHaveLength(1);
    expect(calls.filter((t) => t.startsWith("config/"))).toHaveLength(3);
  });

  it("refetches everything after invalidate(), e.g. on WS reconnection (audit C9)", async () => {
    const ws = fakeWs();
    const catalog = new Catalog(ws as any);
    await catalog.index();
    catalog.invalidate();
    await catalog.index();
    const calls = ws.send.mock.calls.map((c) => c[0]);
    expect(calls.filter((t) => t === "get_states")).toHaveLength(2);
    expect(calls.filter((t) => t.startsWith("config/"))).toHaveLength(6);
  });

  it("turns an unexpected HA payload into an actionable error (audit B2)", async () => {
    const catalog = new Catalog(fakeWs({ get_states: { not: "an array" } }) as any);
    await expect(catalog.index()).rejects.toThrow(/Unexpected payload from Home Assistant \(get_states\)/);
  });
});
