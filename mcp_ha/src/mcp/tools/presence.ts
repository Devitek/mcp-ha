import { z } from "zod";
import type { ToolRegistrar } from "../registry.js";
import type { ToolContext } from "../../context.js";
import { safe, timeWindow, toIso } from "../helpers.js";
import { entityReadVisible } from "../../safety.js";

/**
 * Presence summary (#112). Privacy frames the design as much as the tech:
 * the answers speak in NAMED ZONES only, never coordinates. Latitude,
 * longitude and tracker sources are never read; person entities aggregate
 * their trackers already, so device_tracker.* stays out entirely.
 */
export function registerPresenceTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    "ha_get_presence",
    {
      title: "Presence summary",
      description:
        "Who is home, in which zone, since when, plus a compact timeline of zone changes over the window " +
        "(default 24 h, max 7 days). Zone names only, never coordinates.",
      inputSchema: {
        hours: z.number().min(1).max(168).optional().describe("Timeline window in hours, default 24"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_presence", async ({ hours }) => {
      const all = await ctx.catalog.index();
      const people = all
        .filter((e) => e.domain === "person" && entityReadVisible(ctx.cfg, e.entity_id))
        .map((e) => ({ entity_id: e.entity_id, name: e.name, zone: e.state, since: e.last_changed }));
      const zones = all
        .filter((e) => e.domain === "zone" && entityReadVisible(ctx.cfg, e.entity_id))
        .map((e) => ({ entity_id: e.entity_id, name: e.name, persons: Number(e.state) || 0 }));

      if (people.length === 0) {
        return { people: [], zones, note: "No visible person entity. Presence needs person entities in Home Assistant." };
      }

      const w = timeWindow({ hours }, 24, 168);
      const ids = people.map((p) => p.entity_id);
      const res: Record<string, any[]> = await ctx.ws.send("history/history_during_period", {
        start_time: w.start,
        end_time: w.end,
        entity_ids: ids,
        minimal_response: true,
        no_attributes: true,
        include_start_time_state: true,
      });
      const timeline: Record<string, Array<{ t: string | null; zone: string }>> = {};
      for (const id of ids) {
        timeline[id] = (res?.[id] ?? []).map((r) => ({
          t: toIso(r.lu ?? r.last_updated ?? r.last_changed),
          zone: String(r.s ?? r.state ?? "unknown"),
        }));
      }
      return {
        people,
        zones,
        from: w.start,
        to: w.end,
        timeline,
        note: "Zone names only; coordinates are never exposed by design.",
      };
    })
  );
}
