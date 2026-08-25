import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerCalendarTools } from "./calendar.js";
import { setLogLevel } from "../../logger.js";
import { callTool, entity, fakeCtx, fakeServer, gatedBy } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));

describe("ha_get_calendar (#87)", () => {
  it("lists calendar entities when no id is given", async () => {
    const { server, tools } = fakeServer();
    const ctx = fakeCtx({
      catalog: { index: async () => [entity("calendar.family", { name: "Family" }), entity("light.k")] },
    });
    registerCalendarTools(server, ctx);
    const res = await callTool(tools, "ha_get_calendar", {});
    expect(res.data.items).toEqual([{ entity_id: "calendar.family", name: "Family" }]);
  });

  it("fetches and projects events over a bounded window", async () => {
    const { server, tools } = fakeServer();
    const coreGet = vi.fn(async (_path: string) => [
      { summary: "Dentist", start: { dateTime: "2026-08-22T09:00:00Z" }, end: { dateTime: "2026-08-22T09:30:00Z" }, location: "Clinic" },
    ]);
    registerCalendarTools(server, fakeCtx({ http: { coreGet } }));
    const res = await callTool(tools, "ha_get_calendar", { entity_id: "calendar.family", hours: 48 });
    expect(res.data.items[0]).toMatchObject({ summary: "Dentist", start: "2026-08-22T09:00:00Z", location: "Clinic" });
    expect(String(coreGet.mock.calls[0]?.[0])).toContain("/calendars/calendar.family?start=");
  });

  it("rejects an over-wide window", async () => {
    const { server, tools } = fakeServer();
    registerCalendarTools(server, fakeCtx({ http: { coreGet: vi.fn() } }));
    const res = await callTool(tools, "ha_get_calendar", { entity_id: "calendar.family", hours: 1000 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("too wide");
  });
});

describe("ha_get_todo_list (#87)", () => {
  it("lists todo entities when no id is given", async () => {
    const { server, tools } = fakeServer();
    const ctx = fakeCtx({ catalog: { index: async () => [entity("todo.shopping", { name: "Shopping" })] } });
    registerCalendarTools(server, ctx);
    const res = await callTool(tools, "ha_get_todo_list", {});
    expect(res.data.items).toEqual([{ entity_id: "todo.shopping", name: "Shopping" }]);
  });

  it("manages list items through the guarded path (#141)", async () => {
    const { server, tools } = fakeServer();
    const send = vi.fn(async () => ({ context: {} }));
    registerCalendarTools(server, fakeCtx({ cfg: { allowWrite: true }, ws: { send } }));
    const add = await callTool(tools, "ha_manage_todo", { entity_id: "todo.shopping", action: "add", item: "Lait" });
    expect(add.data.success).toBe(true);
    expect(send).toHaveBeenCalledWith(
      "call_service",
      expect.objectContaining({ domain: "todo", service: "add_item", target: { entity_id: "todo.shopping" }, service_data: { item: "Lait" } })
    );
    await callTool(tools, "ha_manage_todo", { entity_id: "todo.shopping", action: "complete", item: "Lait" });
    expect(send).toHaveBeenLastCalledWith(
      "call_service",
      expect.objectContaining({ service: "update_item", service_data: { item: "Lait", status: "completed" } })
    );
    await callTool(tools, "ha_manage_todo", { entity_id: "todo.shopping", action: "rename", item: "Lait", new_name: "Lait entier" });
    expect(send).toHaveBeenLastCalledWith(
      "call_service",
      expect.objectContaining({ service: "update_item", service_data: { item: "Lait", rename: "Lait entier" } })
    );
    await callTool(tools, "ha_manage_todo", { entity_id: "todo.shopping", action: "remove", item: "Lait entier" });
    expect(send).toHaveBeenLastCalledWith("call_service", expect.objectContaining({ service: "remove_item" }));
  });

  it("requires new_name for rename and is absent without allow_write (#141)", async () => {
    const { server, tools } = fakeServer();
    registerCalendarTools(server, fakeCtx({ cfg: { allowWrite: true }, ws: { send: vi.fn() } }));
    const res = await callTool(tools, "ha_manage_todo", { entity_id: "todo.shopping", action: "rename", item: "Lait" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("new_name");
    const wrongDomain = await callTool(tools, "ha_manage_todo", { entity_id: "light.kitchen", action: "add", item: "x" });
    expect(wrongDomain.isError).toBe(true);
    const readonly = fakeServer();
    registerCalendarTools(gatedBy(readonly.server, { allowWrite: false }), fakeCtx({ cfg: { allowWrite: false } }));
    expect(readonly.tools.has("ha_manage_todo")).toBe(false);
    expect(readonly.tools.has("ha_get_todo_list")).toBe(true);
  });

  it("reads items via todo.get_items with return_response", async () => {
    const { server, tools } = fakeServer();
    const send = vi.fn(async () => ({ response: { "todo.shopping": { items: [{ summary: "Milk", status: "needs_action" }] } } }));
    registerCalendarTools(server, fakeCtx({ ws: { send } }));
    const res = await callTool(tools, "ha_get_todo_list", { entity_id: "todo.shopping" });
    expect(res.data.items).toEqual([{ summary: "Milk", status: "needs_action" }]);
    expect(send).toHaveBeenCalledWith(
      "call_service",
      expect.objectContaining({ domain: "todo", service: "get_items", return_response: true })
    );
  });
});
