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
  it("projects blueprints with required flags and selector types", async () => {
    const { server, tools } = fakeServer();
    const ws = { send: vi.fn(async () => BLUEPRINTS) };
    registerBlueprintTools(server, fakeCtx({ ws }));
    const res = await callTool(tools, "ha_list_blueprints", {});
    expect(ws.send).toHaveBeenCalledWith("blueprint/list", { domain: "automation" });
    const bp = res.data.items[0];
    expect(bp).toMatchObject({ path: "homeassistant/motion_light.yaml", name: "Motion-activated Light" });
    const byName = Object.fromEntries(bp.inputs.map((i: any) => [i.name, i]));
    expect(byName.motion_entity).toMatchObject({ required: true, type: "entity" });
    expect(byName.no_motion_wait).toMatchObject({ required: false, default: 120, type: "number" });
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
