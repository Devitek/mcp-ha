import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerConfigWriteTools } from "./configwrite.js";
import { setLogLevel } from "../../logger.js";
import { callTool, entity, fakeCtx, fakeServer } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));

let consoleSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function auditLines(): any[] {
  return consoleSpy.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((line: string) => line.includes('"audit":true'))
    .map((line: string) => JSON.parse(line));
}

const AUTOMATION_ARGS = {
  alias: "Hallway light on motion",
  triggers: [{ trigger: "state", entity_id: "binary_sensor.hall_motion", to: "on" }],
  actions: [{ action: "light.turn_on", target: { entity_id: "light.hallway" } }],
};

function setup(over: any = {}) {
  const { server, tools } = fakeServer();
  const ws = { send: vi.fn(async () => ({ triggers: { valid: true }, actions: { valid: true } })) };
  const corePost = vi.fn(async () => ({ result: "ok" }));
  const ctx = fakeCtx({
    cfg: { allowConfigWrite: true },
    ws,
    http: { corePost },
    catalog: { index: async () => over.entities ?? [] },
    client: "writer",
    ...over.ctx,
  });
  registerConfigWriteTools(server, ctx);
  return { tools, ws, corePost, ctx };
}

describe("config write registration (#94 tier 3)", () => {
  it("is absent without allow_config_write and for read-scoped tokens", () => {
    const a = fakeServer();
    registerConfigWriteTools(a.server, fakeCtx({ cfg: { allowConfigWrite: false, allowWrite: true } }));
    expect(a.tools.size).toBe(0);
    const b = fakeServer();
    registerConfigWriteTools(b.server, fakeCtx({ cfg: { allowConfigWrite: true }, canWrite: false }));
    expect(b.tools.size).toBe(0);
  });

  it("is independent from allow_write", () => {
    const { server, tools } = fakeServer();
    registerConfigWriteTools(server, fakeCtx({ cfg: { allowConfigWrite: true, allowWrite: false } }));
    expect([...tools.keys()].sort()).toEqual(["ha_add_dashboard_card", "ha_create_automation", "ha_create_from_blueprint", "ha_create_script", "ha_update_automation", "ha_update_script"]);
  });
});

describe("ha_create_automation", () => {
  it("dry_run returns the YAML preview and writes nothing", async () => {
    const { tools, ws, corePost } = setup();
    const res = await callTool(tools, "ha_create_automation", { ...AUTOMATION_ARGS, dry_run: true });
    expect(res.data.dry_run).toBe(true);
    expect(res.data.yaml).toContain("alias: Hallway light on motion");
    expect(res.data.yaml).toContain("binary_sensor.hall_motion");
    expect(ws.send).not.toHaveBeenCalled();
    expect(corePost).not.toHaveBeenCalled();
  });

  it("validates first, then requires confirmation with the full YAML", async () => {
    const { tools, ws, corePost } = setup();
    const res = await callTool(tools, "ha_create_automation", AUTOMATION_ARGS);
    expect(ws.send).toHaveBeenCalledWith(
      "validate_config",
      expect.objectContaining({ triggers: AUTOMATION_ARGS.triggers, actions: AUTOMATION_ARGS.actions })
    );
    expect(res.data.confirmation_required).toBe(true);
    expect(res.data.confirm_token).toMatch(/^[0-9a-f]{32}$/);
    expect(res.data.would_create).toBe("automation.hallway_light_on_motion");
    expect(res.data.yaml).toContain("mode: single");
    expect(corePost).not.toHaveBeenCalled();
    expect(auditLines()).toContainEqual(
      expect.objectContaining({ client: "writer", tool: "ha_create_automation", allowed: false, reason: "confirmation_required" })
    );
  });

  it("writes on the second call with the token and audits the success", async () => {
    const { tools, corePost } = setup();
    const first = await callTool(tools, "ha_create_automation", AUTOMATION_ARGS);
    const res = await callTool(tools, "ha_create_automation", {
      ...AUTOMATION_ARGS,
      confirm_token: first.data.confirm_token,
    });
    expect(res.data.created).toBe("automation.hallway_light_on_motion");
    expect(corePost).toHaveBeenCalledTimes(1);
    const [path, payload] = corePost.mock.calls[0] as any;
    expect(path).toMatch(/^\/config\/automation\/config\/\d+$/);
    expect(payload).toMatchObject({ alias: AUTOMATION_ARGS.alias, mode: "single", triggers: AUTOMATION_ARGS.triggers });
    expect(auditLines()).toContainEqual(
      expect.objectContaining({ client: "writer", tool: "ha_create_automation", allowed: true })
    );
  });

  it("refuses a token when the arguments changed (fingerprint mismatch)", async () => {
    const { tools, corePost } = setup();
    const first = await callTool(tools, "ha_create_automation", AUTOMATION_ARGS);
    const res = await callTool(tools, "ha_create_automation", {
      ...AUTOMATION_ARGS,
      actions: [{ action: "lock.unlock", target: { entity_id: "lock.front" } }],
      confirm_token: first.data.confirm_token,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("mismatch");
    expect(corePost).not.toHaveBeenCalled();
  });

  it("refuses an invalid config before issuing any token", async () => {
    const { tools, corePost } = setup({
      ctx: {
        ws: { send: vi.fn(async () => ({ triggers: { valid: false, error: "Invalid trigger 'statee'" }, actions: { valid: true } })) },
      },
    });
    const res = await callTool(tools, "ha_create_automation", AUTOMATION_ARGS);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Invalid trigger");
    expect(corePost).not.toHaveBeenCalled();
  });

  it("creation only: refuses when an automation with the same alias exists", async () => {
    const { tools, ws } = setup({
      entities: [entity("automation.old_one", { name: "hallway LIGHT on motion" })],
    });
    const res = await callTool(tools, "ha_create_automation", AUTOMATION_ARGS);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("already exists");
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe("ha_add_dashboard_card (#129)", () => {
  const CLASSIC_CONFIG = {
    views: [
      { title: "Home", path: "home", cards: [{ type: "weather-forecast", entity: "weather.maison" }] },
      { title: "Salon", type: "sections", sections: [{ type: "grid", cards: [{ type: "tile", entity: "light.salon" }] }] },
    ],
  };
  const CARD = { type: "gauge", entity: "sensor.temp" };

  function dashSetup(over: any = {}) {
    const { server, tools } = fakeServer();
    const config = over.config ?? JSON.parse(JSON.stringify(CLASSIC_CONFIG));
    const ws = {
      send: vi.fn(async (type: string) => {
        if (type === "lovelace/dashboards/list") return over.dashboards ?? [];
        if (type === "lovelace/config") return over.configSequence ? over.configSequence.shift() : config;
        if (type === "lovelace/config/save") return null;
        return {};
      }),
    };
    const ctx = fakeCtx({ cfg: { allowConfigWrite: true }, ws, client: "writer" });
    registerConfigWriteTools(server, ctx);
    return { tools, ws };
  }

  it("appends to a classic view by index with a view diff, then saves on confirmation", async () => {
    const { tools, ws } = dashSetup();
    const first = await callTool(tools, "ha_add_dashboard_card", { dashboard: "lovelace", view: 0, card: CARD });
    expect(first.data.confirmation_required).toBe(true);
    expect(first.data.diff).toContain("+ ");
    expect(first.data.diff).toContain("gauge");
    const res = await callTool(tools, "ha_add_dashboard_card", {
      dashboard: "lovelace",
      view: 0,
      card: CARD,
      confirm_token: first.data.confirm_token,
    });
    expect(res.data.updated).toContain("view 0");
    expect(res.data.previous_view_yaml).toContain("weather-forecast");
    const save = (ws.send as any).mock.calls.find((c: any[]) => c[0] === "lovelace/config/save");
    expect(save[1].url_path).toBeNull();
    expect(save[1].config.views[0].cards).toHaveLength(2);
    expect(save[1].config.views[1]).toEqual(CLASSIC_CONFIG.views[1]); // untouched view preserved
  });

  it("appends into the last grid of a sections view targeted by title", async () => {
    const { tools, ws } = dashSetup();
    const first = await callTool(tools, "ha_add_dashboard_card", { dashboard: "lovelace", view: "salon", card: CARD });
    await callTool(tools, "ha_add_dashboard_card", {
      dashboard: "lovelace",
      view: "salon",
      card: CARD,
      confirm_token: first.data.confirm_token,
    });
    const save = (ws.send as any).mock.calls.find((c: any[]) => c[0] === "lovelace/config/save");
    expect(save[1].config.views[1].sections[0].cards).toHaveLength(2);
  });

  it("refuses YAML-managed dashboards and unknown views", async () => {
    const { tools } = dashSetup({ dashboards: [{ url_path: "wall", title: "Wall", mode: "yaml" }] });
    const yaml = await callTool(tools, "ha_add_dashboard_card", { dashboard: "wall", view: 0, card: CARD });
    expect(yaml.isError).toBe(true);
    expect(yaml.text).toContain("YAML-managed");
    const nope = await callTool(tools, "ha_add_dashboard_card", { dashboard: "lovelace", view: "garage", card: CARD });
    expect(nope.isError).toBe(true);
    expect(nope.text).toContain("view not found");
  });

  it("invalidates the token when the dashboard changed between the passes", async () => {
    const changed = JSON.parse(JSON.stringify(CLASSIC_CONFIG));
    changed.views[0].cards.push({ type: "markdown", content: "edited in the UI" });
    const { tools, ws } = dashSetup({ configSequence: [JSON.parse(JSON.stringify(CLASSIC_CONFIG)), changed] });
    const first = await callTool(tools, "ha_add_dashboard_card", { dashboard: "lovelace", view: 0, card: CARD });
    const res = await callTool(tools, "ha_add_dashboard_card", {
      dashboard: "lovelace",
      view: 0,
      card: CARD,
      confirm_token: first.data.confirm_token,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("mismatch");
    expect((ws.send as any).mock.calls.some((c: any[]) => c[0] === "lovelace/config/save")).toBe(false);
  });
});

describe("ha_create_from_blueprint (#127)", () => {
  const BP_LIST = {
    "homeassistant/motion_light.yaml": {
      metadata: {
        name: "Motion light",
        input: {
          motion_entity: { selector: { entity: {} } },
          light_target: { selector: { target: {} } },
          no_motion_wait: { default: 120 },
        },
      },
    },
  };

  function bpSetup(over: any = {}) {
    const { server, tools } = fakeServer();
    const ws = { send: vi.fn(async (type: string) => (type === "blueprint/list" ? BP_LIST : {})) };
    const corePost = vi.fn(async () => ({ result: "ok" }));
    const ctx = fakeCtx({
      cfg: { allowConfigWrite: true },
      ws,
      http: { corePost },
      catalog: { index: async () => over.entities ?? [] },
      client: "writer",
    });
    registerConfigWriteTools(server, ctx);
    return { tools, ws, corePost };
  }
  const GOOD_ARGS = {
    blueprint_path: "homeassistant/motion_light.yaml",
    alias: "Hall motion light",
    inputs: { motion_entity: "binary_sensor.hall", light_target: { entity_id: "light.hall" } },
  };

  it("checks required inputs before offering anything", async () => {
    const { tools, corePost } = bpSetup();
    const missing = await callTool(tools, "ha_create_from_blueprint", {
      blueprint_path: "homeassistant/motion_light.yaml",
      alias: "Hall",
      inputs: { motion_entity: "binary_sensor.hall" },
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("light_target");
    const unknown = await callTool(tools, "ha_create_from_blueprint", {
      ...GOOD_ARGS,
      inputs: { ...GOOD_ARGS.inputs, typo_input: 1 },
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("typo_input");
    expect(corePost).not.toHaveBeenCalled();
  });

  it("runs the guarded two-step flow and writes the use_blueprint payload", async () => {
    const { tools, ws, corePost } = bpSetup();
    const first = await callTool(tools, "ha_create_from_blueprint", GOOD_ARGS);
    expect(first.data.confirmation_required).toBe(true);
    expect(first.data.yaml).toContain("use_blueprint");
    // no triggers/actions to validate over WS for a blueprint payload
    expect(ws.send).not.toHaveBeenCalledWith("validate_config", expect.anything());
    const res = await callTool(tools, "ha_create_from_blueprint", { ...GOOD_ARGS, confirm_token: first.data.confirm_token });
    expect(res.data.created).toBe("automation.hall_motion_light");
    const [, payload] = corePost.mock.calls[0] as any;
    expect(payload).toEqual({
      alias: "Hall motion light",
      use_blueprint: { path: "homeassistant/motion_light.yaml", input: GOOD_ARGS.inputs },
    });
  });

  it("refuses unknown blueprints and existing aliases", async () => {
    const { tools } = bpSetup({ entities: [entity("automation.hall_motion_light", { name: "Hall motion light" })] });
    const nope = await callTool(tools, "ha_create_from_blueprint", { ...GOOD_ARGS, blueprint_path: "nope.yaml" });
    expect(nope.isError).toBe(true);
    expect(nope.text).toContain("unknown blueprint");
    const dup = await callTool(tools, "ha_create_from_blueprint", GOOD_ARGS);
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain("already exists");
  });
});

describe("ha_update_automation / ha_update_script (#108)", () => {
  const CURRENT = {
    alias: "Night heating",
    mode: "single",
    triggers: [{ trigger: "time", at: "22:00:00" }],
    actions: [{ action: "climate.set_temperature", data: { temperature: 17 } }],
  };
  const AUTOMATION_ENTITY = entity("automation.night_heating", {
    name: "Night heating",
    attributes: { id: "night-42" },
  });

  function updateSetup(over: any = {}) {
    const { server, tools } = fakeServer();
    const ws = { send: vi.fn(async () => ({ triggers: { valid: true }, actions: { valid: true } })) };
    const coreGet = over.coreGet ?? vi.fn(async () => CURRENT);
    const corePost = vi.fn(async () => ({ result: "ok" }));
    const ctx = fakeCtx({
      cfg: { allowConfigWrite: true },
      ws,
      http: { coreGet, corePost },
      catalog: { index: async () => [AUTOMATION_ENTITY, entity("script.movie", { name: "Movie" })] },
      client: "writer",
      ...over.ctx,
    });
    registerConfigWriteTools(server, ctx);
    return { tools, ws, coreGet, corePost };
  }

  it("returns a before/after diff and requires confirmation, then posts the merged config", async () => {
    const { tools, coreGet, corePost } = updateSetup();
    const first = await callTool(tools, "ha_update_automation", {
      entity_id: "automation.night_heating",
      actions: [{ action: "climate.set_temperature", data: { temperature: 16 } }],
    });
    expect(coreGet).toHaveBeenCalledWith("/config/automation/config/night-42");
    expect(first.data.confirmation_required).toBe(true);
    expect(first.data.diff).toContain("- ");
    expect(first.data.diff).toContain("+ ");
    expect(first.data.diff).toContain("16");
    const res = await callTool(tools, "ha_update_automation", {
      entity_id: "automation.night_heating",
      actions: [{ action: "climate.set_temperature", data: { temperature: 16 } }],
      confirm_token: first.data.confirm_token,
    });
    expect(res.data.updated).toBe("automation.night_heating");
    expect(res.data.previous_yaml).toContain("17");
    const [path, payload] = corePost.mock.calls[0] as any;
    expect(path).toBe("/config/automation/config/night-42");
    // wholesale replacement of actions, untouched blocks preserved
    expect(payload.actions[0].data.temperature).toBe(16);
    expect(payload.triggers).toEqual(CURRENT.triggers);
    expect(payload.alias).toBe("Night heating");
  });

  it("refuses the token when the config changed between the passes (concurrent edit)", async () => {
    let reads = 0;
    const coreGet = vi.fn(async () => (++reads === 1 ? CURRENT : { ...CURRENT, alias: "Edited in the UI" }));
    const { tools, corePost } = updateSetup({ coreGet });
    const first = await callTool(tools, "ha_update_automation", {
      entity_id: "automation.night_heating",
      mode: "restart",
    });
    const res = await callTool(tools, "ha_update_automation", {
      entity_id: "automation.night_heating",
      mode: "restart",
      confirm_token: first.data.confirm_token,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("mismatch");
    expect(corePost).not.toHaveBeenCalled();
  });

  it("requires at least one field and refuses YAML-managed targets", async () => {
    const yamlEntity = entity("automation.from_yaml", { attributes: {} });
    const { tools } = updateSetup({ ctx: { catalog: { index: async () => [AUTOMATION_ENTITY, yamlEntity] } } });
    const empty = await callTool(tools, "ha_update_automation", { entity_id: "automation.night_heating" });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain("nothing to change");
    const yaml = await callTool(tools, "ha_update_automation", { entity_id: "automation.from_yaml", mode: "restart" });
    expect(yaml.isError).toBe(true);
    expect(yaml.text).toContain("YAML-defined");
  });

  it("updates a script through its object id and supports dry_run", async () => {
    const coreGet = vi.fn(async () => ({ alias: "Movie", sequence: [{ action: "light.turn_off" }] }));
    const { tools, corePost } = updateSetup({ coreGet });
    const res = await callTool(tools, "ha_update_script", {
      entity_id: "script.movie",
      sequence: [{ action: "light.turn_off" }, { action: "media_player.turn_on" }],
      dry_run: true,
    });
    expect(coreGet).toHaveBeenCalledWith("/config/script/config/movie");
    expect(res.data.dry_run).toBe(true);
    expect(res.data.diff).toContain("media_player.turn_on");
    expect(corePost).not.toHaveBeenCalled();
  });

  it("executes directly when elicitation confirms", async () => {
    const { tools, corePost } = updateSetup({ ctx: { elicit: async () => true } });
    const res = await callTool(tools, "ha_update_automation", { entity_id: "automation.night_heating", mode: "queued" });
    expect(res.data.updated).toBe("automation.night_heating");
    expect(corePost).toHaveBeenCalledOnce();
  });
});

describe("ha_create_script", () => {
  const SCRIPT_ARGS = {
    alias: "Soirée cinéma",
    sequence: [{ action: "light.turn_off", target: { area_id: "living_room" } }],
  };

  it("slugifies the alias (accents included) and validates the sequence as actions", async () => {
    const { tools, ws } = setup();
    const res = await callTool(tools, "ha_create_script", SCRIPT_ARGS);
    expect(res.data.would_create).toBe("script.soiree_cinema");
    expect(ws.send).toHaveBeenCalledWith("validate_config", { actions: SCRIPT_ARGS.sequence });
  });

  it("writes to the script config path on confirmation", async () => {
    const { tools, corePost } = setup();
    const first = await callTool(tools, "ha_create_script", SCRIPT_ARGS);
    await callTool(tools, "ha_create_script", { ...SCRIPT_ARGS, confirm_token: first.data.confirm_token });
    expect(corePost).toHaveBeenCalledWith("/config/script/config/soiree_cinema", expect.objectContaining({ alias: "Soirée cinéma" }));
  });

  it("creation only: refuses when script.<object_id> already exists", async () => {
    const { tools } = setup({ entities: [entity("script.soiree_cinema", { name: "whatever" })] });
    const res = await callTool(tools, "ha_create_script", SCRIPT_ARGS);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("already exists");
  });
});
