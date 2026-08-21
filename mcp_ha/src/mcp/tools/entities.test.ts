import { beforeAll, describe, expect, it } from "vitest";
import { registerEntityTools } from "./entities.js";
import { setLogLevel } from "../../logger.js";
import { callTool, entity, fakeCtx, fakeServer } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));

const fixtures = [
  entity("light.kitchen", { name: "Kitchen light", area: "Kitchen", state: "on" }),
  entity("light.living_room", { name: "Living room light", area: "Living room", state: "off" }),
  entity("sensor.kitchen_temp", { name: "Kitchen temperature", area: "Kitchen", state: "21.5" }),
  entity("camera.front", { name: "Front camera", area: "Entrance" }),
];

function setup(cfgOver: any = {}) {
  const { server, tools } = fakeServer();
  const ctx = fakeCtx({ cfg: cfgOver, catalog: { index: async () => fixtures } });
  registerEntityTools(server, ctx);
  return tools;
}

describe("ha_list_entities", () => {
  it("returns a histogram instead of a dump when no filter is given", async () => {
    const res = await callTool(setup(), "ha_list_entities", {});
    expect(res.data.items).toBeUndefined();
    expect(res.data.total).toBe(4);
    expect(res.data.by_domain).toContainEqual({ light: 2 });
    expect(res.data.by_area).toContainEqual({ Kitchen: 2 });
    expect(res.data.note).toContain("filter");
  });

  it("filters by domain and projects compact fields only", async () => {
    const res = await callTool(setup(), "ha_list_entities", { domain: "light" });
    expect(res.data.total).toBe(2);
    expect(res.data.items[0]).toEqual({
      entity_id: "light.kitchen",
      name: "Kitchen light",
      state: "on",
      area: "Kitchen",
      last_changed: "2026-01-01T00:00:00Z",
    });
  });

  it("filters by area case-insensitively and by state", async () => {
    const byArea = await callTool(setup(), "ha_list_entities", { area: "kitchen" });
    expect(byArea.data.total).toBe(2);
    const byState = await callTool(setup(), "ha_list_entities", { domain: "light", state: "off" });
    expect(byState.data.items.map((i: any) => i.entity_id)).toEqual(["light.living_room"]);
  });
});

describe("ha_search_entities", () => {
  it("ranks an exact entity_id first", async () => {
    const res = await callTool(setup(), "ha_search_entities", { query: "light.kitchen" });
    expect(res.data.items[0].entity_id).toBe("light.kitchen");
  });

  it("requires every token to match somewhere", async () => {
    const res = await callTool(setup(), "ha_search_entities", { query: "kitchen light" });
    const ids = res.data.items.map((i: any) => i.entity_id);
    expect(ids).toContain("light.kitchen");
    expect(ids).not.toContain("camera.front");
  });

  it("suggests alternatives when nothing matches", async () => {
    const res = await callTool(setup(), "ha_search_entities", { query: "zzz" });
    expect(res.data.total).toBe(0);
    expect(res.data.note).toContain("ha_list_entities");
  });
});

describe("ha_get_entity", () => {
  it("returns full details and truncates huge attribute values", async () => {
    const { server, tools } = fakeServer();
    const big = entity("sensor.big", { attributes: { small: "ok", huge: "x".repeat(2000) } });
    const ctx = fakeCtx({ catalog: { index: async () => [big] } });
    registerEntityTools(server, ctx);
    const res = await callTool(tools, "ha_get_entity", { entity_id: "sensor.big" });
    expect(res.data.attributes.small).toBe("ok");
    expect(String(res.data.attributes.huge)).toContain("truncated");
  });

  it("fails with guidance on an unknown entity", async () => {
    const res = await callTool(setup(), "ha_get_entity", { entity_id: "light.nope" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("ha_search_entities");
  });
});

describe("filter_reads", () => {
  const cfgOver = { filterReads: true, entityDenylist: ["camera.*"] };

  it("hides denied entities from lists and searches", async () => {
    const list = await callTool(setup(cfgOver), "ha_list_entities", { domain: "camera" });
    expect(list.data.total).toBe(0);
    const search = await callTool(setup(cfgOver), "ha_search_entities", { query: "camera" });
    expect(search.data.total).toBe(0);
  });

  it("refuses details of a denied entity", async () => {
    const res = await callTool(setup(cfgOver), "ha_get_entity", { entity_id: "camera.front" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("filter_reads");
  });
});

describe("aliases, labels and floors (#89)", () => {
  const rich = [
    entity("light.plafonnier", {
      name: "Plafonnier",
      area: "Salon",
      floor: "Ground floor",
      aliases: ["big light", "lustre"],
      labels: ["holiday-off"],
    }),
    entity("light.desk", { name: "Desk lamp", area: "Office", floor: "Upstairs" }),
  ];
  const setup = () => {
    const { server, tools } = fakeServer();
    registerEntityTools(server, fakeCtx({ catalog: { index: async () => rich } }));
    return tools;
  };

  it("finds an entity through its Assist alias", async () => {
    const res = await callTool(setup(), "ha_search_entities", { query: "big light" });
    expect(res.data.items[0].entity_id).toBe("light.plafonnier");
  });

  it("matches labels and floors in search with a lower weight than the name", async () => {
    const res = await callTool(setup(), "ha_search_entities", { query: "holiday" });
    expect(res.data.items.map((i: any) => i.entity_id)).toEqual(["light.plafonnier"]);
  });

  it("filters lists by label and by floor", async () => {
    const byLabel = await callTool(setup(), "ha_list_entities", { label: "Holiday-OFF" });
    expect(byLabel.data.items.map((i: any) => i.entity_id)).toEqual(["light.plafonnier"]);
    const byFloor = await callTool(setup(), "ha_list_entities", { floor: "upstairs" });
    expect(byFloor.data.items.map((i: any) => i.entity_id)).toEqual(["light.desk"]);
  });

  it("exposes aliases, labels and floor in the entity details, omitting empty ones", async () => {
    const res = await callTool(setup(), "ha_get_entity", { entity_id: "light.plafonnier" });
    expect(res.data).toMatchObject({ aliases: ["big light", "lustre"], labels: ["holiday-off"], floor: "Ground floor" });
    const bare = await callTool(setup(), "ha_get_entity", { entity_id: "light.desk" });
    expect(bare.data.aliases).toBeUndefined();
    expect(bare.data.labels).toBeUndefined();
  });
});

describe("ha_list_areas and ha_list_devices", () => {
  it("counts entities per area", async () => {
    const { server, tools } = fakeServer();
    const ctx = fakeCtx({
      catalog: {
        index: async () => fixtures,
        registries: async () => ({
          at: 0,
          areas: [
            { area_id: "a1", name: "Kitchen", floor_id: "f1" },
            { area_id: "a2", name: "Empty room", floor_id: null },
          ],
          devices: [],
          entities: [],
          floors: [{ floor_id: "f1", name: "Ground floor", level: 0 }],
          labels: [],
        }),
      },
    });
    registerEntityTools(server, ctx);
    const res = await callTool(tools, "ha_list_areas", {});
    expect(res.data.items).toContainEqual({ area_id: "a1", name: "Kitchen", floor: "Ground floor", entities: 2 });
    expect(res.data.items).toContainEqual({ area_id: "a2", name: "Empty room", entities: 0 });
  });

  it("filters devices by area and drops disabled ones", async () => {
    const { server, tools } = fakeServer();
    const ctx = fakeCtx({
      catalog: {
        index: async () => [],
        registries: async () => ({
          at: 0,
          areas: [{ area_id: "a1", name: "Kitchen", floor_id: null }],
          devices: [
            { id: "d1", name: "Bulb", name_by_user: "My bulb", manufacturer: "Philips", model: "LCA", area_id: "a1", disabled_by: null },
            { id: "d2", name: "Old", name_by_user: null, manufacturer: null, model: null, area_id: "a1", disabled_by: "user" },
            { id: "d3", name: "Elsewhere", name_by_user: null, manufacturer: null, model: null, area_id: null, disabled_by: null },
          ],
          entities: [],
          floors: [],
          labels: [],
        }),
      },
    });
    registerEntityTools(server, ctx);
    const res = await callTool(tools, "ha_list_devices", { area: "kitchen" });
    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0]).toMatchObject({ device_id: "d1", name: "My bulb" });
  });
});
