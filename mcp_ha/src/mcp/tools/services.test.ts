import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerServiceTools } from "./services.js";
import { setLogLevel } from "../../logger.js";
import { callTool, fakeCtx, fakeServer } from "./testkit.test.js";

beforeAll(() => setLogLevel("fatal"));

let consoleSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Audit lines are JSON with audit:true, emitted even at log level fatal. */
function auditLines(): any[] {
  return consoleSpy.mock.calls
    .map((c) => String(c[0]))
    .filter((line) => line.includes('"audit":true'))
    .map((line) => JSON.parse(line));
}

const SERVICES_FIXTURE = {
  light: {
    turn_on: { name: "Turn on", description: "Turns on a light", fields: { brightness_pct: { description: "Brightness", required: false, selector: { number: {} } } } },
    turn_off: { name: "Turn off", description: "Turns off a light", fields: {} },
  },
  scene: { apply: { name: "Apply", description: "Applies a scene", fields: {} } },
};

function setup(cfgOver: any = {}) {
  const { server, tools } = fakeServer();
  const ws = { send: vi.fn(async (type: string) => (type === "get_services" ? SERVICES_FIXTURE : { context: {} })) };
  const ctx = fakeCtx({ cfg: cfgOver, ws });
  registerServiceTools(server, ctx);
  return { tools, ws };
}

describe("ha_list_services", () => {
  it("returns domains with counts and a nudge when called without arguments", async () => {
    const { tools } = setup();
    const res = await callTool(tools, "ha_list_services", {});
    expect(res.data.domains).toContainEqual({ domain: "light", services: 2 });
    expect(res.data.note).toContain("domain");
  });

  it("details one domain with its fields", async () => {
    const { tools } = setup();
    const res = await callTool(tools, "ha_list_services", { domain: "light" });
    const turnOn = res.data.services.find((s: any) => s.service === "light.turn_on");
    expect(turnOn.fields[0]).toMatchObject({ name: "brightness_pct", selector: "number" });
  });

  it("searches across domains and rejects unknown domains", async () => {
    const { tools } = setup();
    const found = await callTool(tools, "ha_list_services", { search: "scene" });
    expect(found.data.items[0].service).toBe("scene.apply");
    const unknown = await callTool(tools, "ha_list_services", { domain: "nope" });
    expect(unknown.isError).toBe(true);
  });
});

describe("ha_call_service registration gate", () => {
  it("is not registered at all when allow_write is off", () => {
    const { tools } = setup({ allowWrite: false });
    expect(tools.has("ha_call_service")).toBe(false);
    expect(tools.has("ha_list_services")).toBe(true);
  });

  it("is registered when allow_write is on", () => {
    const { tools } = setup({ allowWrite: true });
    expect(tools.has("ha_call_service")).toBe(true);
    expect(tools.get("ha_call_service")!.cfg.annotations.destructiveHint).toBe(true);
  });
});

describe("ha_call_service safety matrix", () => {
  it("refuses a denylisted service and audits the refusal", async () => {
    const { tools, ws } = setup({ allowWrite: true, serviceDenylist: ["homeassistant.stop"] });
    const res = await callTool(tools, "ha_call_service", { domain: "homeassistant", service: "stop" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("service_denylist");
    expect(ws.send).not.toHaveBeenCalled();
    expect(auditLines()).toContainEqual(expect.objectContaining({ allowed: false, service: "stop" }));
  });

  it("refuses a denylisted entity", async () => {
    const { tools, ws } = setup({ allowWrite: true, entityDenylist: ["lock.*"] });
    const res = await callTool(tools, "ha_call_service", {
      domain: "lock",
      service: "unlock",
      target: { entity_id: "lock.front_door" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("entity_denylist");
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("switches to deny-by-default with a non-empty allowlist", async () => {
    const { tools } = setup({ allowWrite: true, entityAllowlist: ["light.*"] });
    const denied = await callTool(tools, "ha_call_service", {
      domain: "switch",
      service: "turn_on",
      target: { entity_id: "switch.tv" },
    });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("entity_allowlist");
  });

  it("catches entity ids smuggled through data", async () => {
    const { tools } = setup({ allowWrite: true, entityDenylist: ["lock.*"] });
    const res = await callTool(tools, "ha_call_service", {
      domain: "homeassistant",
      service: "turn_on",
      data: { entity_id: "lock.front_door" },
    });
    expect(res.isError).toBe(true);
  });

  it("refuses area/device targeting when entity restrictions exist", async () => {
    const { tools } = setup({ allowWrite: true, entityAllowlist: ["light.*"] });
    const res = await callTool(tools, "ha_call_service", {
      domain: "light",
      service: "turn_off",
      target: { area_id: "kitchen" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("entity_id");
  });

  it("allows area targeting when no restriction is configured", async () => {
    const { tools, ws } = setup({ allowWrite: true });
    const res = await callTool(tools, "ha_call_service", {
      domain: "light",
      service: "turn_off",
      target: { area_id: "kitchen" },
    });
    expect(res.isError).toBe(false);
    expect(ws.send).toHaveBeenCalledWith("call_service", expect.objectContaining({ domain: "light" }));
  });

  it("previews without executing in dry_run and still audits", async () => {
    const { tools, ws } = setup({ allowWrite: true });
    const res = await callTool(tools, "ha_call_service", {
      domain: "light",
      service: "turn_on",
      target: { entity_id: "light.kitchen" },
      data: { brightness_pct: 50 },
      dry_run: true,
    });
    expect(res.data.dry_run).toBe(true);
    expect(res.data.would_call).toMatchObject({ domain: "light", service: "turn_on" });
    expect(ws.send).not.toHaveBeenCalled();
    expect(auditLines()).toContainEqual(expect.objectContaining({ dry_run: true, allowed: true }));
  });

  it("executes an allowed call and audits the success", async () => {
    const { tools, ws } = setup({ allowWrite: true, entityAllowlist: ["light.*"] });
    const res = await callTool(tools, "ha_call_service", {
      domain: "light",
      service: "turn_on",
      target: { entity_id: "light.kitchen" },
      data: { brightness_pct: 40 },
    });
    expect(res.data.success).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(
      "call_service",
      expect.objectContaining({
        domain: "light",
        service: "turn_on",
        target: { entity_id: "light.kitchen" },
        service_data: { brightness_pct: 40 },
      })
    );
    expect(auditLines()).toContainEqual(expect.objectContaining({ allowed: true, result: "ok" }));
  });

  it("passes return_response through and surfaces the response", async () => {
    const { server, tools } = fakeServer();
    const ws = { send: vi.fn(async () => ({ response: { forecast: [] } })) };
    registerServiceTools(server, fakeCtx({ cfg: { allowWrite: true }, ws }));
    const res = await callTool(tools, "ha_call_service", {
      domain: "weather",
      service: "get_forecasts",
      target: { entity_id: "weather.home" },
      return_response: true,
    });
    expect(res.data.response).toEqual({ forecast: [] });
    expect(ws.send).toHaveBeenCalledWith("call_service", expect.objectContaining({ return_response: true }));
  });
});
