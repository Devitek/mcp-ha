import { beforeAll, describe, expect, it, vi } from "vitest";
import { Catalog } from "./catalog.js";
import { setLogLevel } from "../logger.js";

const areas = [{ area_id: "ar_kitchen", name: "Kitchen" }];
const devices = [
  { id: "dev1", name: "Hue bulb", name_by_user: null, manufacturer: "Philips", model: "LCA001", area_id: "ar_kitchen", disabled_by: null },
  // Child device (2026.9, #191): no own area, references its parent.
  { id: "child1", name: "Left channel", name_by_user: null, area_id: null, disabled_by: null, parent_device_id: "dev1" },
];
const entities = [
  // Direct area assignment on the entity.
  { entity_id: "light.direct", area_id: "ar_kitchen", device_id: null, disabled_by: null, hidden_by: null, entity_category: null },
  // Area inherited from the device.
  { entity_id: "light.via_device", area_id: null, device_id: "dev1", disabled_by: null, hidden_by: null, entity_category: null },
  // Entity on a child device: the area must come from the parent (#191).
  { entity_id: "media_player.left", area_id: null, device_id: "child1", disabled_by: null, hidden_by: null, entity_category: null },
  { entity_id: "sensor.hidden_one", area_id: null, device_id: null, disabled_by: null, hidden_by: "user", entity_category: "diagnostic" },
];
const states = [
  { entity_id: "light.direct", state: "on", attributes: { friendly_name: "Direct light" }, last_changed: "2026-01-01T00:00:00Z", last_updated: "2026-01-01T00:00:00Z" },
  { entity_id: "light.via_device", state: "off", attributes: {}, last_changed: "2026-01-01T00:00:00Z", last_updated: "2026-01-01T00:00:00Z" },
  { entity_id: "media_player.left", state: "idle", attributes: {}, last_changed: "2026-01-01T00:00:00Z", last_updated: "2026-01-01T00:00:00Z" },
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
    // #191: one-level parent hop for child devices.
    expect(byId.get("media_player.left")).toMatchObject({ area: "Kitchen" });
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
    // Everything served from cache on the second run (5 registries since #89).
    expect(calls.filter((t) => t === "get_states")).toHaveLength(1);
    expect(calls.filter((t) => t.startsWith("config/"))).toHaveLength(5);
  });

  it("shares the in-flight promise between concurrent callers (audit B5)", async () => {
    const ws = fakeWs();
    const catalog = new Catalog(ws as any);
    await Promise.all([catalog.index(), catalog.index(), catalog.index()]);
    const calls = ws.send.mock.calls.map((c) => c[0]);
    expect(calls.filter((t) => t === "get_states")).toHaveLength(1);
    expect(calls.filter((t) => t.startsWith("config/"))).toHaveLength(5);
  });

  it("refetches everything after invalidate(), e.g. on WS reconnection (audit C9)", async () => {
    const ws = fakeWs();
    const catalog = new Catalog(ws as any);
    await catalog.index();
    catalog.invalidate();
    await catalog.index();
    const calls = ws.send.mock.calls.map((c) => c[0]);
    expect(calls.filter((t) => t === "get_states")).toHaveLength(2);
    expect(calls.filter((t) => t.startsWith("config/"))).toHaveLength(10);
  });

  it("turns an unexpected HA payload into an actionable error (audit B2)", async () => {
    const catalog = new Catalog(fakeWs({ get_states: { not: "an array" } }) as any);
    await expect(catalog.index()).rejects.toThrow(/Unexpected payload from Home Assistant \(get_states\)/);
  });

  it("joins floors, aliases and labels when the registries answer (#89)", async () => {
    const catalog = new Catalog(
      fakeWs({
        "config/area_registry/list": [{ area_id: "ar_kitchen", name: "Kitchen", floor_id: "fl_ground" }],
        "config/entity_registry/list": [
          {
            entity_id: "light.direct",
            area_id: "ar_kitchen",
            device_id: null,
            disabled_by: null,
            hidden_by: null,
            entity_category: null,
            aliases: ["big light"],
            labels: ["lb_1", "lb_ghost"],
          },
        ],
        "config/floor_registry/list": [{ floor_id: "fl_ground", name: "Ground floor", level: 0 }],
        "config/label_registry/list": [{ label_id: "lb_1", name: "holiday-off" }],
      }) as any
    );
    const e = (await catalog.index()).find((x) => x.entity_id === "light.direct");
    expect(e).toMatchObject({
      floor: "Ground floor",
      aliases: ["big light"],
      // Known ids are resolved to names, unknown ones stay as ids.
      labels: ["holiday-off", "lb_ghost"],
    });
  });

  it("degrades to empty floors and labels on an older core (#89)", async () => {
    // fakeWs throws on the floor/label commands by default: this is exactly
    // the old-core behaviour, and the join must survive it.
    const catalog = new Catalog(fakeWs() as any);
    const e = (await catalog.index()).find((x) => x.entity_id === "light.direct");
    expect(e).toMatchObject({ area: "Kitchen", floor: null, aliases: [], labels: [] });
  });
});

describe("event-driven registry invalidation (#93)", () => {
  it("subscribes to the five registry events and refetches after one fires", async () => {
    const ws = fakeWs() as any;
    const handlers = new Map<string, (e: unknown) => void>();
    ws.subscribe = vi.fn(async (_t: string, p: { event_type: string }, h: (e: unknown) => void) => {
      handlers.set(p.event_type, h);
      return handlers.size;
    });
    const catalog = new Catalog(ws);
    await catalog.watchRegistries();
    expect([...handlers.keys()].sort()).toEqual([
      "area_registry_updated",
      "device_registry_updated",
      "entity_registry_updated",
      "floor_registry_updated",
      "label_registry_updated",
    ]);
    await catalog.index();
    handlers.get("area_registry_updated")!({});
    await catalog.index();
    const regCalls = ws.send.mock.calls.map((c: unknown[]) => c[0]).filter((t: any) => String(t).startsWith("config/"));
    // Two full registry rounds: the event dropped the cache within its TTL.
    expect(regCalls).toHaveLength(10);
    // States were untouched by the registry event.
    expect(ws.send.mock.calls.map((c: unknown[]) => c[0]).filter((t: any) => t === "get_states")).toHaveLength(1);
  });

  it("survives failing subscriptions, the TTL stays as the net", async () => {
    const ws = fakeWs() as any;
    ws.subscribe = vi.fn(async () => {
      throw new Error("subscription refused");
    });
    const catalog = new Catalog(ws);
    await catalog.watchRegistries();
    const index = await catalog.index();
    expect(index.length).toBeGreaterThan(0);
  });
});

describe("live state cache (v0.3 #79)", () => {
  function liveWs() {
    const ws = fakeWs() as any;
    let handler: ((e: unknown) => void) | null = null;
    ws.subscribe = vi.fn(async (_t: string, _p: unknown, onEvent: (e: unknown) => void) => {
      handler = onEvent;
      return 42;
    });
    return { ws, emit: (e: unknown) => handler?.(e) };
  }
  const changed = (entityId: string, state: string | null) => ({
    data: {
      entity_id: entityId,
      new_state:
        state === null
          ? null
          : { entity_id: entityId, state, attributes: {}, last_changed: "2026-01-02T00:00:00Z", last_updated: "2026-01-02T00:00:00Z" },
    },
  });

  it("serves states from the live map and applies updates without any new get_states", async () => {
    const { ws, emit } = liveWs();
    const catalog = new Catalog(ws);
    await catalog.startLive();
    emit(changed("light.direct", "off"));
    emit(changed("sensor.brand_new", "1"));
    emit(changed("sensor.orphan", null));
    const states = await catalog.states();
    const byId = new Map(states.map((s) => [s.entity_id, s.state]));
    expect(byId.get("light.direct")).toBe("off");
    expect(byId.get("sensor.brand_new")).toBe("1");
    expect(byId.has("sensor.orphan")).toBe(false);
    await catalog.states();
    expect(ws.send.mock.calls.map((c: unknown[]) => c[0]).filter((t: unknown) => t === "get_states")).toHaveLength(1);
  });

  it("replays events buffered during the snapshot (subscribe-first ordering)", async () => {
    const ws = fakeWs() as any;
    let handler: ((e: unknown) => void) | null = null;
    ws.subscribe = vi.fn(async (_t: string, _p: unknown, onEvent: (e: unknown) => void) => {
      handler = onEvent;
      // The event arrives BEFORE get_states returns: it must win.
      handler(changed("light.direct", "racing"));
      return 42;
    });
    const catalog = new Catalog(ws);
    await catalog.startLive();
    const states = await catalog.states();
    expect(states.find((s) => s.entity_id === "light.direct")?.state).toBe("racing");
  });

  it("dispatches entity change events to listeners until detached (#90)", async () => {
    const { ws, emit } = liveWs();
    const catalog = new Catalog(ws);
    await catalog.startLive();
    const seen: string[] = [];
    const detach = catalog.onEntityChange((id) => seen.push(id));
    emit(changed("light.direct", "off"));
    emit(changed("sensor.new", "1"));
    expect(seen).toEqual(["light.direct", "sensor.new"]);
    detach();
    emit(changed("light.direct", "on"));
    expect(seen).toHaveLength(2);
  });

  it("falls back to TTL fetches when the subscription fails, and resubscribes after invalidate", async () => {
    const ws = fakeWs() as any;
    ws.subscribe = vi.fn(async () => {
      throw new Error("subscription refused");
    });
    const catalog = new Catalog(ws);
    await catalog.startLive();
    await catalog.states();
    expect(ws.send.mock.calls.map((c: unknown[]) => c[0])).toContain("get_states");
    // reconnection path: invalidate drops the live map, startLive retries
    ws.subscribe = vi.fn(async (_t: string, _p: unknown, _e: unknown) => 43);
    catalog.invalidate();
    await catalog.startLive();
    expect(ws.subscribe).toHaveBeenCalled();
  });
});
