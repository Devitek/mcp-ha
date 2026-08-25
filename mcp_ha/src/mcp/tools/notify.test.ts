import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerNotifyTools, resetNotifyLimiter } from "./notify.js";
import { setLogLevel } from "../../logger.js";
import { callTool, entity, fakeCtx, fakeServer, gatedBy } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));
beforeEach(() => resetNotifyLimiter());

const fixtures = [entity("notify.telephone", { name: "Telephone" }), entity("light.kitchen")];

function setup(over: any = {}) {
  const { server, tools } = fakeServer();
  const ws = over.ws ?? {
    send: vi.fn(async (type: string) =>
      type === "get_services" ? { notify: { notify: {}, mobile_app_pixel: {}, send_message: {} } } : { context: {} }
    ),
  };
  registerNotifyTools(server, fakeCtx({ cfg: { allowWrite: true, ...(over.cfg ?? {}) }, ws, catalog: { index: async () => fixtures } }));
  return { tools, ws };
}

describe("ha_send_notification (#116)", () => {
  it("is absent without allow_write and for read-scoped tokens", () => {
    const a = fakeServer();
    registerNotifyTools(gatedBy(a.server, { allowWrite: false }), fakeCtx({ cfg: { allowWrite: false } }));
    expect(a.tools.size).toBe(0);
    const b = fakeServer();
    registerNotifyTools(gatedBy(b.server, { allowWrite: true }, false), fakeCtx({ cfg: { allowWrite: true }, canWrite: false }));
    expect(b.tools.size).toBe(0);
  });

  it("lists legacy services and notify entities when no target is given", async () => {
    const { tools } = setup();
    const res = await callTool(tools, "ha_send_notification", { message: "hi" });
    expect(res.data.targets.services.sort()).toEqual(["mobile_app_pixel", "notify"]);
    expect(res.data.targets.entities).toEqual(["notify.telephone"]);
  });

  it("routes a legacy target to its notify service through the guarded path", async () => {
    const { tools, ws } = setup();
    const res = await callTool(tools, "ha_send_notification", {
      message: "wash done",
      target: "mobile_app_pixel",
      title: "Laundry",
    });
    expect(res.data.success).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(
      "call_service",
      expect.objectContaining({
        domain: "notify",
        service: "mobile_app_pixel",
        service_data: { message: "wash done", title: "Laundry" },
      })
    );
  });

  it("routes a notify entity to send_message with an entity target", async () => {
    const { tools, ws } = setup();
    await callTool(tools, "ha_send_notification", { message: "hello", target: "notify.telephone" });
    expect(ws.send).toHaveBeenCalledWith(
      "call_service",
      expect.objectContaining({
        domain: "notify",
        service: "send_message",
        target: { entity_id: "notify.telephone" },
        service_data: { message: "hello" },
      })
    );
  });

  it("honours the service denylist through the shared guarded path", async () => {
    const { tools, ws } = setup({ cfg: { serviceDenylist: ["notify.*"] } });
    const res = await callTool(tools, "ha_send_notification", { message: "x", target: "mobile_app_pixel" });
    expect(res.isError).toBe(true);
    expect(ws.send).not.toHaveBeenCalledWith("call_service", expect.anything());
  });

  it("rate limits per target and audits the refusal", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tools } = setup();
    for (let i = 0; i < 6; i++) {
      const ok = await callTool(tools, "ha_send_notification", { message: `n${i}`, target: "mobile_app_pixel" });
      expect(ok.isError).toBe(false);
    }
    const blocked = await callTool(tools, "ha_send_notification", { message: "n7", target: "mobile_app_pixel" });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("rate limited");
    // another target is unaffected
    const other = await callTool(tools, "ha_send_notification", { message: "ok", target: "notify.telephone" });
    expect(other.isError).toBe(false);
    const audits = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"audit":true'));
    expect(audits.some((l) => l.includes("rate limited"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("truncates very long messages and does not count dry runs", async () => {
    const { tools, ws } = setup();
    for (let i = 0; i < 10; i++) {
      const r = await callTool(tools, "ha_send_notification", { message: "preview", target: "mobile_app_pixel", dry_run: true });
      expect(r.data.dry_run).toBe(true);
    }
    const res = await callTool(tools, "ha_send_notification", { message: "x".repeat(2000), target: "mobile_app_pixel" });
    expect(res.data.success).toBe(true);
    const sent = (ws.send as any).mock.calls.find((c: any[]) => c[0] === "call_service")[1];
    expect(sent.service_data.message.length).toBeLessThan(1100);
    expect(sent.service_data.message).toContain("chars");
  });
});
