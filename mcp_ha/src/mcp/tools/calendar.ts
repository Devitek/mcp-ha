import { z } from "zod";
import type { ToolRegistrar } from "../registry.js";
import type { ToolContext } from "../../context.js";
import { listEnvelope, safe, timeWindow, trunc } from "../helpers.js";
import { entityReadVisible } from "../../safety.js";
import { guardedServiceCall } from "../writeflow.js";

/**
 * Calendar and to-do read tools (#87). Both are read-only. The to-do tool
 * uses todo.get_items with return_response, which only reads, so it is safe
 * to expose without allow_write.
 */
export function registerCalendarTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    "ha_get_calendar",
    {
      title: "Calendar events",
      description:
        "Without entity_id: lists the calendar entities. With entity_id: the events in a time window " +
        "(default 24 h, max 30 days). Answers questions like 'what is on today?'.",
      inputSchema: {
        entity_id: z.string().optional().describe("E.g. calendar.family; omit to list calendars"),
        hours: z.number().min(1).max(720).optional().describe("Sliding window in hours, default 24"),
        start: z.string().optional().describe("ISO 8601 start"),
        end: z.string().optional().describe("ISO 8601 end"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_calendar", async ({ entity_id, hours, start, end }) => {
      if (!entity_id) {
        const calendars = (await ctx.catalog.index())
          .filter((e) => e.domain === "calendar" && entityReadVisible(ctx.cfg, e.entity_id))
          .map((e) => ({ entity_id: e.entity_id, name: e.name }));
        return { items: calendars, total: calendars.length, note: "Pass entity_id to get the events of one calendar." };
      }
      if (!entityReadVisible(ctx.cfg, entity_id)) throw new Error(`calendar ${entity_id} is not accessible (filter_reads)`);
      const w = timeWindow({ start, end, hours }, 24, 720);
      const raw: any[] = await ctx.http.coreGet(
        `/calendars/${encodeURIComponent(entity_id)}?start=${encodeURIComponent(w.start)}&end=${encodeURIComponent(w.end)}`
      );
      const events = (raw ?? []).map((ev) => ({
        summary: trunc(ev.summary ?? "", 200),
        start: ev.start?.dateTime ?? ev.start?.date ?? ev.start,
        end: ev.end?.dateTime ?? ev.end?.date ?? ev.end,
        ...(ev.location ? { location: trunc(ev.location, 200) } : {}),
        ...(ev.description ? { description: trunc(ev.description, 300) } : {}),
      }));
      return listEnvelope(events, 100, 0, `${entity_id} from ${w.start} to ${w.end}`);
    })
  );

  server.registerTool(
    "ha_get_todo_list",
    {
      title: "To-do list items",
      description:
        "Without entity_id: lists the to-do list entities. With entity_id: the items on that list " +
        "(shopping list, tasks...). Read only.",
      inputSchema: {
        entity_id: z.string().optional().describe("E.g. todo.shopping_list; omit to list the lists"),
        status: z.enum(["needs_action", "completed"]).optional().describe("Filter by status"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_todo_list", async ({ entity_id, status }) => {
      if (!entity_id) {
        const lists = (await ctx.catalog.index())
          .filter((e) => e.domain === "todo" && entityReadVisible(ctx.cfg, e.entity_id))
          .map((e) => ({ entity_id: e.entity_id, name: e.name }));
        return { items: lists, total: lists.length, note: "Pass entity_id to get the items of one list." };
      }
      if (!entityReadVisible(ctx.cfg, entity_id)) throw new Error(`to-do list ${entity_id} is not accessible (filter_reads)`);
      // todo.get_items is a read-only service returning data: safe without allow_write.
      const res = await ctx.ws.send("call_service", {
        domain: "todo",
        service: "get_items",
        target: { entity_id },
        ...(status ? { service_data: { status } } : {}),
        return_response: true,
      });
      const items: any[] = res?.response?.[entity_id]?.items ?? [];
      return {
        entity_id,
        items: items.map((i) => ({ summary: trunc(i.summary ?? "", 200), status: i.status, ...(i.due ? { due: i.due } : {}) })),
        total: items.length,
      };
    })
  );

  // Write side of the lists (#141): "add milk to the shopping list". Gated
  // by allow_write and the token scope, single guarded path (lesson B12).
  server.registerTool(
    "ha_manage_todo",
    {
      title: "Manage a to-do list",
      description:
        "Adds, completes, unchecks, removes or renames an item on a to-do list ('add milk to the " +
        "shopping list'). Items are referenced by their text, as Home Assistant does. Find lists and " +
        "their items with ha_get_todo_list.",
      inputSchema: {
        entity_id: z.string().describe("E.g. todo.shopping_list"),
        action: z.enum(["add", "complete", "uncomplete", "remove", "rename"]),
        item: z.string().min(1).describe("The item text"),
        new_name: z.string().optional().describe("New text, rename only"),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe("ha_manage_todo", async ({ entity_id, action, item, new_name, dry_run, confirm_token }) => {
      if (!entity_id.startsWith("todo.")) throw new Error(`expected a todo.* entity_id, got: ${entity_id}`);
      if (action === "rename" && !new_name) throw new Error("rename needs new_name");
      const route: Record<string, { service: string; data: Record<string, unknown> }> = {
        add: { service: "add_item", data: { item } },
        complete: { service: "update_item", data: { item, status: "completed" } },
        uncomplete: { service: "update_item", data: { item, status: "needs_action" } },
        remove: { service: "remove_item", data: { item } },
        rename: { service: "update_item", data: { item, rename: new_name } },
      };
      const r = route[action]!;
      const result = await guardedServiceCall(ctx, {
        tool: "ha_manage_todo",
        domain: "todo",
        service: r.service,
        target: { entity_id },
        data: r.data,
        dry_run,
        confirm_token,
      });
      if ((result as { success?: boolean }).success) {
        return { ...result, note: "Check the list state with ha_get_todo_list." };
      }
      return result;
    })
  );
}
