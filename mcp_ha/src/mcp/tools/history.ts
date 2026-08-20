import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { safe, timeWindow, toIso } from "../helpers.js";
import { entityReadVisible } from "../../safety.js";

// Sized so that a maxed-out response still fits under helpers.ts
// MAX_RESPONSE_BYTES: at 500/200 the JSON blew past the global cap and
// always arrived truncated (caught by the unit tests).
const MAX_POINTS = 250;
const MAX_LOGBOOK = 100;

/** Downsamples while keeping the first, the last and a regular stride. */
function downsample<T>(rows: T[], max: number): { rows: T[]; note?: string } {
  if (rows.length <= max) return { rows };
  const stride = Math.ceil(rows.length / max);
  const kept = rows.filter((_, i) => i % stride === 0);
  const last = rows[rows.length - 1];
  if (kept[kept.length - 1] !== last) kept.push(last);
  return {
    rows: kept,
    note: `${rows.length} raw points, downsampled to ${kept.length} (1 in ${stride}). Narrow the window for more precision.`,
  };
}

export function registerHistoryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "ha_get_history",
    {
      title: "Entity history",
      description:
        "State changes of one entity over a time window (default 24 h, max 7 days). " +
        "For numeric sensors over long periods prefer ha_get_statistics (aggregates). " +
        "Window: hours (sliding) or start/end in ISO 8601.",
      inputSchema: {
        entity_id: z.string().describe("E.g. sensor.living_room_temperature"),
        hours: z.number().min(0.25).max(168).optional().describe("Sliding window in hours, default 24"),
        start: z.string().optional().describe("ISO 8601 start"),
        end: z.string().optional().describe("ISO 8601 end, default now"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_history", async ({ entity_id, hours, start, end }) => {
      if (!entityReadVisible(ctx.cfg, entity_id)) {
        throw new Error(`entity ${entity_id} is not accessible (filter_reads)`);
      }
      const w = timeWindow({ start, end, hours }, 24, 168);
      const res: Record<string, any[]> = await ctx.ws.send("history/history_during_period", {
        start_time: w.start,
        end_time: w.end,
        entity_ids: [entity_id],
        minimal_response: true,
        no_attributes: true,
      });
      // The WebSocket answers in a compressed format: s = state, lu =
      // last_updated in epoch seconds. Normalize while accepting the long
      // format too.
      const raw = res?.[entity_id] ?? [];
      const points = raw.map((r) => ({
        t: toIso(r.lu ?? r.last_updated ?? r.last_changed),
        state: r.s ?? r.state,
      }));
      const { rows, note } = downsample(points, MAX_POINTS);
      return { entity_id, from: w.start, to: w.end, count: points.length, points: rows, ...(note ? { note } : {}) };
    })
  );

  server.registerTool(
    "ha_get_statistics",
    {
      title: "Long-term statistics",
      description:
        "Recorder aggregates (min, max, mean, sum) per period for numeric sensors and counters " +
        "(energy, temperature...). Much more compact than ha_get_history over long ranges. " +
        "The statistic id is usually the sensor entity_id.",
      inputSchema: {
        statistic_id: z.union([z.string(), z.array(z.string()).max(10)]).describe("E.g. sensor.home_energy, or a list"),
        period: z.enum(["5minute", "hour", "day", "week", "month"]).optional().describe("Default hour"),
        hours: z.number().min(1).max(8760).optional().describe("Sliding window in hours, default 24"),
        start: z.string().optional().describe("ISO 8601 start"),
        end: z.string().optional().describe("ISO 8601 end"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_statistics", async ({ statistic_id, period, hours, start, end }) => {
      const ids = Array.isArray(statistic_id) ? statistic_id : [statistic_id];
      for (const id of ids) {
        if (!entityReadVisible(ctx.cfg, id)) throw new Error(`${id} is not accessible (filter_reads)`);
      }
      const w = timeWindow({ start, end, hours }, 24, 8760);
      const res: Record<string, any[]> = await ctx.ws.send("recorder/statistics_during_period", {
        start_time: w.start,
        end_time: w.end,
        statistic_ids: ids,
        period: period ?? "hour",
      });
      const round = (v: unknown) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v ?? null);
      const out: Record<string, unknown> = {};
      for (const [id, rows] of Object.entries(res ?? {})) {
        out[id] = rows.map((r) => ({
          start: toIso(r.start),
          mean: round(r.mean),
          min: round(r.min),
          max: round(r.max),
          sum: round(r.sum),
          state: round(r.state),
        }));
      }
      return { from: w.start, to: w.end, period: period ?? "hour", statistics: out };
    })
  );

  server.registerTool(
    "ha_get_logbook",
    {
      title: "Logbook events",
      description:
        "Human-readable logbook events (who did what, when) over a time window " +
        "(default 24 h, max 7 days), filterable by entity. Useful to answer 'what happened?'.",
      inputSchema: {
        entity_id: z.string().optional().describe("Restrict to one entity"),
        hours: z.number().min(0.25).max(168).optional().describe("Sliding window in hours, default 24"),
        start: z.string().optional(),
        end: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_logbook", async ({ entity_id, hours, start, end }) => {
      if (entity_id && !entityReadVisible(ctx.cfg, entity_id)) {
        throw new Error(`entity ${entity_id} is not accessible (filter_reads)`);
      }
      const w = timeWindow({ start, end, hours }, 24, 168);
      const payload: Record<string, unknown> = { start_time: w.start, end_time: w.end };
      if (entity_id) payload.entity_ids = [entity_id];
      const raw: any[] = (await ctx.ws.send("logbook/get_events", payload)) ?? [];
      const visible = raw.filter((r) => !r.entity_id || entityReadVisible(ctx.cfg, r.entity_id));
      const events = visible.slice(-MAX_LOGBOOK).map((r) => ({
        when: toIso(r.when),
        name: r.name,
        ...(r.message ? { message: r.message } : {}),
        ...(r.state !== undefined ? { state: r.state } : {}),
        ...(r.entity_id ? { entity_id: r.entity_id } : {}),
      }));
      return {
        from: w.start,
        to: w.end,
        count: visible.length,
        events,
        ...(visible.length > MAX_LOGBOOK
          ? { note: `${visible.length} events, only the last ${MAX_LOGBOOK} are returned. Narrow the window or filter by entity.` }
          : {}),
      };
    })
  );
}
