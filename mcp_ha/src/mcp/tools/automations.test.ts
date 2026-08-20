import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerAutomationTools } from "./automations.js";
import { setLogLevel } from "../../logger.js";
import { callTool, entity, fakeCtx, fakeServer } from "./testkit.test.js";

beforeAll(() => setLogLevel("fatal"));

const fixtures = [
  entity("automation.morning", {
    name: "Morning routine",
    state: "on",
    attributes: { last_triggered: "2026-08-20T06:00:00Z", id: "morning-123", mode: "single" },
  }),
  entity("automation.yaml_one", { name: "YAML automation", state: "off", attributes: {} }),
  entity("script.wake_up", { name: "Wake up", state: "off", attributes: { last_triggered: null } }),
];

function setup(coreGet?: any) {
  const { server, tools } = fakeServer();
  const ctx = fakeCtx({
    catalog: { index: async () => fixtures },
    http: { coreGet: coreGet ?? vi.fn(async () => ({ alias: "Morning routine", triggers: [] })) },
  });
  registerAutomationTools(server, ctx);
  return { tools, ctx };
}

describe("ha_list_automations / ha_list_scripts", () => {
  it("lists automations with their enabled state", async () => {
    const { tools } = setup();
    const res = await callTool(tools, "ha_list_automations", {});
    expect(res.data.total).toBe(2);
    expect(res.data.items[0]).toEqual({
      entity_id: "automation.morning",
      name: "Morning routine",
      enabled: true,
      last_triggered: "2026-08-20T06:00:00Z",
    });
  });

  it("lists scripts with their running state", async () => {
    const { tools } = setup();
    const res = await callTool(tools, "ha_list_scripts", {});
    expect(res.data.items).toEqual([
      { entity_id: "script.wake_up", name: "Wake up", running: false, last_triggered: null },
    ]);
  });
});

describe("ha_get_automation", () => {
  it("fetches the UI configuration through the config id attribute", async () => {
    const coreGet = vi.fn(async (path: string) => {
      expect(path).toBe("/config/automation/config/morning-123");
      return { alias: "Morning routine", triggers: [{ platform: "time" }] };
    });
    const { tools } = setup(coreGet);
    const res = await callTool(tools, "ha_get_automation", { entity_id: "automation.morning" });
    expect(res.data.mode).toBe("single");
    expect(res.data.config.triggers).toEqual([{ platform: "time" }]);
  });

  it("degrades gracefully for YAML automations without a config id", async () => {
    const coreGet = vi.fn();
    const { tools } = setup(coreGet);
    const res = await callTool(tools, "ha_get_automation", { entity_id: "automation.yaml_one" });
    expect(res.data.note).toContain("YAML");
    expect(coreGet).not.toHaveBeenCalled();
  });

  it("degrades gracefully when the config endpoint fails", async () => {
    const coreGet = vi.fn(async () => {
      throw new Error("HTTP 404");
    });
    const { tools } = setup(coreGet);
    const res = await callTool(tools, "ha_get_automation", { entity_id: "automation.morning" });
    expect(res.isError).toBe(false);
    expect(res.data.note).toContain("not readable");
  });
});
