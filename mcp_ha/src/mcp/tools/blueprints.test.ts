import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerBlueprintTools } from "./blueprints.js";
import { setLogLevel } from "../../logger.js";
import { callTool, fakeCtx, fakeServer } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));

const BLUEPRINTS = {
  "homeassistant/motion_light.yaml": {
    metadata: {
      name: "Motion-activated Light",
      description: "Turn on a light when motion is detected.",
      input: {
        motion_entity: { name: "Motion Sensor", selector: { entity: { domain: "binary_sensor" } } },
        light_target: { name: "Light", selector: { target: { entity: { domain: "light" } } } },
        no_motion_wait: { name: "Wait time", default: 120, selector: { number: { min: 0, max: 3600 } } },
      },
    },
  },
};

describe("ha_list_blueprints (#127)", () => {
  function setup(blueprints: Record<string, unknown> = BLUEPRINTS) {
    const { server, tools } = fakeServer();
    const ws = { send: vi.fn(async () => blueprints) };
    registerBlueprintTools(server, fakeCtx({ ws }));
    return { tools, ws };
  }

  it("lists blueprints compactly with their required input names (#227)", async () => {
    const { tools, ws } = setup();
    const res = await callTool(tools, "ha_list_blueprints", {});
    expect(ws.send).toHaveBeenCalledWith("blueprint/list", { domain: "automation" });
    expect(res.data.items[0]).toEqual({
      path: "homeassistant/motion_light.yaml",
      name: "Motion-activated Light",
      description: "Turn on a light when motion is detected.",
      input_count: 3,
      required_inputs: ["motion_entity", "light_target"],
    });
    expect(res.data.items[0].inputs).toBeUndefined();
  });

  it("details the inputs of one blueprint with required flags and selector types", async () => {
    const { tools } = setup();
    const res = await callTool(tools, "ha_list_blueprints", { path: "homeassistant/motion_light.yaml" });
    const byName = Object.fromEntries(res.data.inputs.map((i: any) => [i.name, i]));
    expect(byName.motion_entity).toMatchObject({ required: true, type: "entity" });
    expect(byName.no_motion_wait).toMatchObject({ required: false, default: 120, type: "number" });
    const unknown = await callTool(tools, "ha_list_blueprints", { path: "nope.yaml" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("unknown automation blueprint");
  });

  it("paginates and filters large collections instead of truncating (#227)", async () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 45; i++) {
      many[`EPMatt/controller_${i}.yaml`] = {
        metadata: { name: `Controller ${i}`, input: Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`in_${k}`, { default: "" }])) },
      };
    }
    many["homeassistant/motion_light.yaml"] = BLUEPRINTS["homeassistant/motion_light.yaml"];
    const { tools } = setup(many);
    const page = await callTool(tools, "ha_list_blueprints", {});
    expect(page.data).toMatchObject({ returned: 20, total: 46, has_more: true, next_offset: 20 });
    expect(page.data.truncated).toBeUndefined();
    const found = await callTool(tools, "ha_list_blueprints", { search: "motion" });
    expect(found.data.items.map((b: any) => b.path)).toEqual(["homeassistant/motion_light.yaml"]);
  });

  it("fails clearly on cores without blueprints", async () => {
    const { server, tools } = fakeServer();
    const ws = { send: vi.fn(async () => { throw new Error("unknown command"); }) };
    registerBlueprintTools(server, fakeCtx({ ws }));
    const res = await callTool(tools, "ha_list_blueprints", {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("not available");
  });
});
