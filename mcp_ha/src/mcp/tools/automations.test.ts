import { beforeAll, describe, expect, it, vi } from "vitest";
// trace tests (#106) share this file with the other automation tools.
import { registerAutomationTools } from "./automations.js";
import { setLogLevel } from "../../logger.js";
import { callTool, entity, fakeCtx, fakeServer } from "./testkit.js";

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
  it("lists automations with their enabled state and their source (#156)", async () => {
    const { tools } = setup();
    const res = await callTool(tools, "ha_list_automations", {});
    expect(res.data.total).toBe(2);
    expect(res.data.items[0]).toEqual({
      entity_id: "automation.morning",
      name: "Morning routine",
      enabled: true,
      last_triggered: "2026-08-20T06:00:00Z",
      source: "ui",
    });
    // no attributes.id: defined in the user's YAML files, config tools can't reach it
    expect(res.data.items[1].source).toBe("yaml");
  });

  it("lists scripts with their running state", async () => {
    const { tools } = setup();
    const res = await callTool(tools, "ha_list_scripts", {});
    expect(res.data.items).toEqual([
      { entity_id: "script.wake_up", name: "Wake up", running: false, last_triggered: null },
    ]);
  });
});

describe("ha_list_automations include_config (#160)", () => {
  it("attaches UI configs, gives yaml items config: null, and notes the paging rule", async () => {
    const coreGet = vi.fn(async (path: string) => ({ alias: "cfg for " + path, triggers: [] }));
    const { tools } = setup(coreGet);
    const res = await callTool(tools, "ha_list_automations", { include_config: true });
    expect(res.data.items[0].config.alias).toContain("morning-123");
    expect(res.data.items[1].source).toBe("yaml");
    expect(res.data.items[1].config).toBeNull();
    expect(coreGet).toHaveBeenCalledTimes(1); // yaml one skipped, no wasted call
    expect(res.data.note).toContain("include_config");
  });

  it("caps the page at 10 even when a larger limit is asked", async () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      entity(`automation.a${i}`, { name: `A${i}`, attributes: { id: `id-${i}` } })
    );
    const { server, tools } = fakeServer();
    const ctx = fakeCtx({
      catalog: { index: async () => many },
      http: { coreGet: vi.fn(async () => ({ alias: "x" })) },
    });
    registerAutomationTools(server, ctx);
    const res = await callTool(tools, "ha_list_automations", { include_config: true, limit: 50 });
    expect(res.data.returned).toBe(10);
    expect(res.data.has_more).toBe(true);
    expect(res.data.next_offset).toBe(10);
    const plain = await callTool(tools, "ha_list_automations", { limit: 50 });
    expect(plain.data.returned).toBe(14); // no clamp without include_config
  });

  it("omits an oversized config per item, keeping the page valid JSON and the others whole", async () => {
    const coreGet = vi.fn(async (path: string) =>
      path.includes("morning") ? { alias: "huge", blob: "x".repeat(30_000) } : { alias: "small" }
    );
    const many = [
      entity("automation.morning", { name: "Huge one", attributes: { id: "morning-123" } }),
      entity("automation.small", { name: "Small one", attributes: { id: "small-1" } }),
    ];
    const { server, tools } = fakeServer();
    const ctx = fakeCtx({ catalog: { index: async () => many }, http: { coreGet } });
    registerAutomationTools(server, ctx);
    const res = await callTool(tools, "ha_list_automations", { include_config: true });
    // callTool already JSON.parses the page: reaching here means it stayed valid
    expect(res.data.items[0].config).toBeUndefined();
    expect(res.data.items[0].config_omitted).toContain("ha_get_automation");
    expect(res.data.items[1].config).toEqual({ alias: "small" });
  });

  it("turns a per-item fetch failure into a note, not a sunk page (audit B7)", async () => {
    const coreGet = vi.fn(async () => {
      throw new Error("HTTP 503: restarting");
    });
    const { tools } = setup(coreGet);
    const res = await callTool(tools, "ha_list_automations", { include_config: true });
    expect(res.isError).toBe(false);
    expect(res.data.items[0].config).toBeNull();
    expect(res.data.items[0].config_note).toContain("not readable");
    expect(res.data.items[0].config_note).not.toContain("503");
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

  it("treats a 404 as the normal YAML case (audit B7)", async () => {
    const coreGet = vi.fn(async () => {
      throw new Error("HTTP 404: not found");
    });
    const { tools } = setup(coreGet);
    const res = await callTool(tools, "ha_get_automation", { entity_id: "automation.morning" });
    expect(res.isError).toBe(false);
    expect(res.data.note).toContain("YAML");
  });

  it("does not disguise an API failure as a YAML case (audit B7)", async () => {
    const coreGet = vi.fn(async () => {
      throw new Error("HTTP 503: supervisor restarting");
    });
    const { tools } = setup(coreGet);
    const res = await callTool(tools, "ha_get_automation", { entity_id: "automation.morning" });
    expect(res.isError).toBe(false);
    expect(res.data.note).toContain("not readable right now");
    expect(res.data.note).not.toContain("YAML");
  });

  it("returns a 25 KB config whole under the raised cap (#159, round-trip safe)", async () => {
    const media = "x".repeat(25_000); // over the 15 KB global cap, a real field case
    const coreGet = vi.fn(async () => ({ alias: "G4 ring", actions: [{ action: "play_media", media }] }));
    const { tools } = setup(coreGet);
    const res = await callTool(tools, "ha_get_automation", { entity_id: "automation.morning" });
    expect(res.data.truncated).toBeUndefined();
    expect(res.data.config.actions[0].media).toBe(media);
  });

  it("beyond the raised cap, says inline payload and points to the UI, not to filters (#159)", async () => {
    const coreGet = vi.fn(async () => ({ alias: "Huge", actions: [{ media: "x".repeat(70_000) }] }));
    const { tools } = setup(coreGet);
    const res = await callTool(tools, "ha_get_automation", { entity_id: "automation.morning" });
    expect(res.data.truncated).toBe(true);
    expect(res.data.note).toContain("inline payload");
    expect(res.data.note).not.toContain("Refine");
  });
});

describe("ha_get_automation_trace (#106)", () => {
  function traceSetup(wsSend: (type: string, payload: any) => Promise<any>, cfgOver: any = {}) {
    const { server, tools } = fakeServer();
    const ws = { send: vi.fn(wsSend) };
    registerAutomationTools(server, fakeCtx({ cfg: cfgOver, catalog: { index: async () => fixtures }, ws }));
    return { tools, ws };
  }

  it("lists recent runs, resolving the automation config id from the attributes", async () => {
    const { tools, ws } = traceSetup(async () => [
      {
        run_id: "r1",
        timestamp: { start: "2026-08-22T06:00:00Z", finish: "2026-08-22T06:00:01Z" },
        state: "stopped",
        script_execution: "finished",
        trigger: "state of binary_sensor.hall_motion",
        last_step: "action/0",
      },
    ]);
    const res = await callTool(tools, "ha_get_automation_trace", { entity_id: "automation.morning" });
    expect(ws.send).toHaveBeenCalledWith("trace/list", { domain: "automation", item_id: "morning-123" });
    expect(res.data.runs[0]).toMatchObject({ run_id: "r1", result: "finished", trigger: expect.stringContaining("hall_motion") });
  });

  it("uses the object id for scripts and explains empty run lists", async () => {
    const { tools, ws } = traceSetup(async () => []);
    const res = await callTool(tools, "ha_get_automation_trace", { entity_id: "script.wake_up" });
    expect(ws.send).toHaveBeenCalledWith("trace/list", { domain: "script", item_id: "wake_up" });
    expect(res.data.note).toContain("did not fire");
  });

  it("returns ordered steps with condition verdicts and drops the variables", async () => {
    const { tools } = traceSetup(async (type: string) =>
      type === "trace/get"
        ? {
            state: "stopped",
            script_execution: "aborted",
            trace: {
              "condition/0": [
                { timestamp: "2026-08-22T06:00:00.500Z", result: { result: false }, changed_variables: { huge: "x".repeat(5000) } },
              ],
              "trigger/0": [{ timestamp: "2026-08-22T06:00:00.100Z", changed_variables: { trigger: {} } }],
            },
          }
        : []
    );
    const res = await callTool(tools, "ha_get_automation_trace", { entity_id: "automation.morning", run_id: "r1" });
    expect(res.data.steps.map((s: any) => s.path)).toEqual(["trigger/0", "condition/0"]); // time-ordered
    expect(res.data.steps[1].result).toEqual({ result: false });
    expect(JSON.stringify(res.data)).not.toContain("changed_variables");
    expect(res.data.result).toBe("aborted");
  });

  it("refuses YAML automations without a config id and non-automation domains", async () => {
    const { tools } = traceSetup(async () => []);
    const yaml = await callTool(tools, "ha_get_automation_trace", { entity_id: "automation.yaml_one" });
    expect(yaml.isError).toBe(true);
    expect(yaml.text).toContain("no configuration id");
    const light = await callTool(tools, "ha_get_automation_trace", { entity_id: "light.kitchen" });
    expect(light.isError).toBe(true);
  });

  it("respects filter_reads", async () => {
    const { tools, ws } = traceSetup(async () => [], { filterReads: true, entityDenylist: ["automation.*"] });
    const res = await callTool(tools, "ha_get_automation_trace", { entity_id: "automation.morning" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("filter_reads");
    expect(ws.send).not.toHaveBeenCalled();
  });
});
