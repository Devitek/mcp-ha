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
    expect([...tools.keys()].sort()).toEqual(["ha_create_automation", "ha_create_script"]);
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
