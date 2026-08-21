import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { listEnvelope, safe, timeWindow, trunc } from "../helpers.js";
import { entityReadVisible } from "../../safety.js";

/**
 * Calendar and to-do read tools (#87). Both are read-only. The to-do tool
 * uses todo.get_items with return_response, which only reads, so it is safe
 * to expose without allow_write.
 */
export function registerCalendarTools(server: McpServer, ctx: ToolContext): void {
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
}
