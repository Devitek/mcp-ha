import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerHelperTools } from "./helpers.js";
import { setLogLevel } from "../../logger.js";
import { callTool, fakeCtx, fakeServer, gatedBy } from "./testkit.js";

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

describe("helper tools registration (#94 tier 1)", () => {
  it("is absent without allow_write and for read-scoped tokens", () => {
    const a = fakeServer();
    registerHelperTools(gatedBy(a.server, { allowWrite: false }), fakeCtx({ cfg: { allowWrite: false } }));
    expect(a.tools.size).toBe(0);
    const b = fakeServer();
    registerHelperTools(gatedBy(b.server, { allowWrite: true }, false), fakeCtx({ cfg: { allowWrite: true }, canWrite: false }));
    expect(b.tools.size).toBe(0);
  });
});

describe("ha_create_helper", () => {
  it("creates a helper, strips reserved keys and audits with the client name", async () => {
    const { server, tools } = fakeServer();
    const send = vi.fn(async () => ({ id: "coffee_count", name: "Coffee count" }));
    registerHelperTools(server, fakeCtx({ cfg: { allowWrite: true }, ws: { send }, client: "writer" }));
    const res = await callTool(tools, "ha_create_helper", {
      helper_type: "counter",
      name: "Coffee count",
      options: { initial: 0, step: 1, type: "evil", id: "evil" },
    });
    expect(send).toHaveBeenCalledWith("config/counter/create", { name: "Coffee count", initial: 0, step: 1 });
    expect(res.data.created).toEqual({ helper_type: "counter", id: "coffee_count", name: "Coffee count" });
    expect(auditLines()).toContainEqual(
      expect.objectContaining({ client: "writer", tool: "ha_create_helper", helper_type: "counter", allowed: true })
    );
  });

  it("relays a Home Assistant validation error", async () => {
    const { server, tools } = fakeServer();
    const send = vi.fn(async () => {
      throw new Error("required key not provided @ data['options']");
    });
    registerHelperTools(server, fakeCtx({ cfg: { allowWrite: true }, ws: { send } }));
    const res = await callTool(tools, "ha_create_helper", { helper_type: "input_select", name: "Mode" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("required key");
  });
});

describe("ha_delete_helper", () => {
  const registry = { unique_id: "vacation_mode_col", platform: "input_boolean" };

  it("resolves the collection id through the registry and deletes", async () => {
    const { server, tools } = fakeServer();
    const send = vi.fn(async (type: string) => (type === "config/entity_registry/get" ? registry : null));
    registerHelperTools(server, fakeCtx({ cfg: { allowWrite: true }, ws: { send }, client: "writer" }));
    const res = await callTool(tools, "ha_delete_helper", { entity_id: "input_boolean.vacation" });
    expect(send).toHaveBeenCalledWith("config/entity_registry/get", { entity_id: "input_boolean.vacation" });
    expect(send).toHaveBeenCalledWith("config/input_boolean/delete", { input_boolean_id: "vacation_mode_col" });
    expect(res.data.deleted).toBe("input_boolean.vacation");
    expect(auditLines()).toContainEqual(expect.objectContaining({ client: "writer", tool: "ha_delete_helper", allowed: true }));
  });

  it("refuses non-helper domains and YAML-managed helpers", async () => {
    const { server, tools } = fakeServer();
    const send = vi.fn(async () => ({ unique_id: "x", platform: "template" }));
    registerHelperTools(server, fakeCtx({ cfg: { allowWrite: true }, ws: { send } }));
    const light = await callTool(tools, "ha_delete_helper", { entity_id: "light.kitchen" });
    expect(light.isError).toBe(true);
    const yaml = await callTool(tools, "ha_delete_helper", { entity_id: "input_boolean.from_yaml" });
    expect(yaml.isError).toBe(true);
    expect(yaml.text).toContain("UI-managed");
    expect(send).not.toHaveBeenCalledWith("config/input_boolean/delete", expect.anything());
  });

  it("honours the entity denylist and audits the refusal", async () => {
    const { server, tools } = fakeServer();
    const send = vi.fn();
    registerHelperTools(server, fakeCtx({ cfg: { allowWrite: true, entityDenylist: ["input_boolean.*"] }, ws: { send } }));
    const res = await callTool(tools, "ha_delete_helper", { entity_id: "input_boolean.vacation" });
    expect(res.isError).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(auditLines()).toContainEqual(expect.objectContaining({ tool: "ha_delete_helper", allowed: false }));
  });
});
