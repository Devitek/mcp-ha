import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { safe, timeWindow, toIso } from "../helpers.js";
import { entityReadVisible } from "../../safety.js";

const MAX_POINTS = 500;
const MAX_LOGBOOK = 200;

/** Sous-échantillonne en gardant premier, dernier et un pas régulier. */
function downsample<T>(rows: T[], max: number): { rows: T[]; note?: string } {
  if (rows.length <= max) return { rows };
  const stride = Math.ceil(rows.length / max);
  const kept = rows.filter((_, i) => i % stride === 0);
  const last = rows[rows.length - 1];
  if (kept[kept.length - 1] !== last) kept.push(last);
  return {
    rows: kept,
    note: `${rows.length} points bruts, sous-échantillonnés à ${kept.length} (1 sur ${stride}). Réduisez la fenêtre pour plus de précision.`,
  };
}

export function registerHistoryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "ha_get_history",
    {
      title: "Historique d'une entité",
      description:
        "Changements d'état d'une entité sur une fenêtre temporelle (défaut 24 h, max 7 jours). " +
        "Pour des capteurs numériques sur de longues périodes, préférez ha_get_statistics (agrégats). " +
        "Fenêtre : hours (glissant) ou start/end en ISO 8601.",
      inputSchema: {
        entity_id: z.string().describe("Ex. sensor.temperature_salon"),
        hours: z.number().min(0.25).max(168).optional().describe("Fenêtre glissante en heures, défaut 24"),
        start: z.string().optional().describe("Début ISO 8601"),
        end: z.string().optional().describe("Fin ISO 8601, défaut maintenant"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_history", async ({ entity_id, hours, start, end }) => {
      if (!entityReadVisible(ctx.cfg, entity_id)) {
        throw new Error(`l'entité ${entity_id} n'est pas accessible (filter_reads)`);
      }
      const w = timeWindow({ start, end, hours }, 24, 168);
      const res: Record<string, any[]> = await ctx.ws.send("history/history_during_period", {
        start_time: w.start,
        end_time: w.end,
        entity_ids: [entity_id],
        minimal_response: true,
        no_attributes: true,
      });
      // Le WebSocket renvoie un format compressé : s = state, lu = last_updated
      // en secondes epoch. On normalise, en tolérant aussi le format long.
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
      title: "Statistiques long terme",
      description:
        "Agrégats du recorder (min, max, moyenne, somme) par période pour des capteurs numériques ou compteurs " +
        "(énergie, température...). Bien plus compact que ha_get_history sur de longues durées. " +
        "L'id statistique est en général l'entity_id du capteur.",
      inputSchema: {
        statistic_id: z.union([z.string(), z.array(z.string()).max(10)]).describe("Ex. sensor.conso_maison, ou liste"),
        period: z.enum(["5minute", "hour", "day", "week", "month"]).optional().describe("Défaut hour"),
        hours: z.number().min(1).max(8760).optional().describe("Fenêtre glissante en heures, défaut 24"),
        start: z.string().optional().describe("Début ISO 8601"),
        end: z.string().optional().describe("Fin ISO 8601"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_statistics", async ({ statistic_id, period, hours, start, end }) => {
      const ids = Array.isArray(statistic_id) ? statistic_id : [statistic_id];
      for (const id of ids) {
        if (!entityReadVisible(ctx.cfg, id)) throw new Error(`${id} n'est pas accessible (filter_reads)`);
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
      title: "Journal des événements (logbook)",
      description:
        "Événements lisibles du logbook (qui a fait quoi, quand) sur une fenêtre temporelle " +
        "(défaut 24 h, max 7 jours), filtrable par entité. Utile pour répondre à « que s'est-il passé ? ».",
      inputSchema: {
        entity_id: z.string().optional().describe("Limiter à une entité"),
        hours: z.number().min(0.25).max(168).optional().describe("Fenêtre glissante en heures, défaut 24"),
        start: z.string().optional(),
        end: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_logbook", async ({ entity_id, hours, start, end }) => {
      if (entity_id && !entityReadVisible(ctx.cfg, entity_id)) {
        throw new Error(`l'entité ${entity_id} n'est pas accessible (filter_reads)`);
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
          ? { note: `${visible.length} événements, seuls les ${MAX_LOGBOOK} derniers sont renvoyés. Réduisez la fenêtre ou filtrez par entité.` }
          : {}),
      };
    })
  );
}
