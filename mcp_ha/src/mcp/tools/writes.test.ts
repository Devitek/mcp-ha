import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerWriteTools } from "./writes.js";
import { registerServiceTools } from "./services.js";
import { setLogLevel } from "../../logger.js";
import { callTool, fakeCtx, fakeServer, gatedBy } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));

function setup(cfgOver: any = {}) {
  const { server, tools } = fakeServer();
  const ws = { send: vi.fn(async () => ({ context: {} })) };
  const ctx = fakeCtx({ cfg: { allowWrite: true, ...cfgOver }, ws });
  registerWriteTools(server, ctx);
  return { tools, ws, ctx };
}

describe("registration gate", () => {
  it("registers none of the write tools without allow_write", () => {
    const { server, tools } = fakeServer();
    registerWriteTools(gatedBy(server, { allowWrite: false }), fakeCtx({ cfg: { allowWrite: false } }));
    expect(tools.size).toBe(0);
  });

  it("registers the three dedicated tools with allow_write", () => {
    const { tools } = setup();
    expect([...tools.keys()].sort()).toEqual(["ha_run_script", "ha_set_automation", "ha_trigger_automation"]);
  });
});

describe("ha_run_script", () => {
  it("rejects a non-script entity_id before any call", async () => {
    const { tools, ws } = setup();
    const res = await callTool(tools, "ha_run_script", { entity_id: "light.kitchen" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("script.*");
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("runs a script with variables through script.turn_on", async () => {
    const { tools, ws } = setup();
    const res = await callTool(tools, "ha_run_script", { entity_id: "script.wake_up", variables: { room: "bedroom" } });
    expect(res.data.success).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(
      "call_service",
      expect.objectContaining({
        domain: "script",
        service: "turn_on",
        target: { entity_id: "script.wake_up" },
        service_data: { variables: { room: "bedroom" } },
      })
    );
  });

  it("honours the entity denylist like every write", async () => {
    const { tools, ws } = setup({ entityDenylist: ["script.dangerous"] });
    const res = await callTool(tools, "ha_run_script", { entity_id: "script.dangerous" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("entity_denylist");
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("previews with dry_run without executing", async () => {
    const { tools, ws } = setup();
    const res = await callTool(tools, "ha_run_script", { entity_id: "script.wake_up", dry_run: true });
    expect(res.data.dry_run).toBe(true);
    expect(res.data.would_call.domain).toBe("script");
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe("ha_trigger_automation", () => {
  it("skips conditions by default and honours skip_condition false", async () => {
    const { tools, ws } = setup();
    await callTool(tools, "ha_trigger_automation", { entity_id: "automation.morning" });
    expect(ws.send).toHaveBeenLastCalledWith(
      "call_service",
      expect.objectContaining({ domain: "automation", service: "trigger", service_data: { skip_condition: true } })
    );
    await callTool(tools, "ha_trigger_automation", { entity_id: "automation.morning", skip_condition: false });
    expect(ws.send).toHaveBeenLastCalledWith(
      "call_service",
      expect.objectContaining({ service_data: { skip_condition: false } })
    );
  });

  it("rejects a non-automation entity_id", async () => {
    const { tools } = setup();
    const res = await callTool(tools, "ha_trigger_automation", { entity_id: "script.x" });
    expect(res.isError).toBe(true);
  });
});

describe("ha_set_automation", () => {
  it("maps enabled to turn_on and turn_off", async () => {
    const { tools, ws } = setup();
    await callTool(tools, "ha_set_automation", { entity_id: "automation.morning", enabled: true });
    expect(ws.send).toHaveBeenLastCalledWith("call_service", expect.objectContaining({ service: "turn_on" }));
    await callTool(tools, "ha_set_automation", { entity_id: "automation.morning", enabled: false });
    expect(ws.send).toHaveBeenLastCalledWith("call_service", expect.objectContaining({ service: "turn_off" }));
  });
});

describe("two-step confirmation through the shared write path (#15)", () => {
  function confirmSetup() {
    const { server, tools } = fakeServer();
    const ws = { send: vi.fn(async () => ({ context: {} })) };
    const ctx = fakeCtx({ cfg: { allowWrite: true, confirmDomains: ["lock", "script"] }, ws });
    registerServiceTools(server, ctx);
    registerWriteTools(server, ctx);
    return { tools, ws };
  }

  it("first call returns a preview and a token, nothing executed", async () => {
    const { tools, ws } = confirmSetup();
    const res = await callTool(tools, "ha_call_service", {
      domain: "lock",
      service: "unlock",
      target: { entity_id: "lock.front" },
    });
    expect(res.data.confirmation_required).toBe(true);
    expect(res.data.confirm_token).toMatch(/^[0-9a-f]{32}$/);
    expect(res.data.would_call.service).toBe("unlock");
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("executes with the token and burns it", async () => {
    const { tools, ws } = confirmSetup();
    const first = await callTool(tools, "ha_call_service", {
      domain: "lock",
      service: "unlock",
      target: { entity_id: "lock.front" },
    });
    const token = first.data.confirm_token;
    const second = await callTool(tools, "ha_call_service", {
      domain: "lock",
      service: "unlock",
      target: { entity_id: "lock.front" },
      confirm_token: token,
    });
    expect(second.data.success).toBe(true);
    expect(ws.send).toHaveBeenCalledTimes(1);
    // burnt: replay refused
    const replay = await callTool(tools, "ha_call_service", {
      domain: "lock",
      service: "unlock",
      target: { entity_id: "lock.front" },
      confirm_token: token,
    });
    expect(replay.isError).toBe(true);
    expect(replay.text).toContain("unknown");
  });

  it("refuses a token presented with a DIFFERENT call", async () => {
    const { tools, ws } = confirmSetup();
    const first = await callTool(tools, "ha_call_service", {
      domain: "lock",
      service: "unlock",
      target: { entity_id: "lock.front" },
    });
    const res = await callTool(tools, "ha_call_service", {
      domain: "lock",
      service: "unlock",
      target: { entity_id: "lock.back_door" },
      confirm_token: first.data.confirm_token,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("mismatch");
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("applies to the dedicated tools too, via the shared path", async () => {
    const { tools, ws } = confirmSetup();
    const first = await callTool(tools, "ha_run_script", { entity_id: "script.wake_up" });
    expect(first.data.confirmation_required).toBe(true);
    const second = await callTool(tools, "ha_run_script", {
      entity_id: "script.wake_up",
      confirm_token: first.data.confirm_token,
    });
    expect(second.data.success).toBe(true);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it("dry_run needs no confirmation and non-sensitive domains skip it entirely", async () => {
    const { tools, ws } = confirmSetup();
    const dry = await callTool(tools, "ha_call_service", {
      domain: "lock",
      service: "unlock",
      target: { entity_id: "lock.front" },
      dry_run: true,
    });
    expect(dry.data.dry_run).toBe(true);
    const light = await callTool(tools, "ha_call_service", {
      domain: "light",
      service: "turn_on",
      target: { entity_id: "light.kitchen" },
    });
    expect(light.data.success).toBe(true);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });
});
