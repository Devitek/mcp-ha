import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { safe } from "../helpers.js";
import { entityReadVisible } from "../../safety.js";
import { log } from "../../logger.js";

/** Per-section cap so a sick instance still answers compactly. */
const SECTION_CAP = 30;
const REPAIRS_CAP = 20;

/**
 * Instance health report (#107): the "house doctor" reflex. Pure read,
 * every signal is already in the live catalog or one WS call away. The
 * response qualifies (age, thresholds used) instead of judging: seasonal
 * sensors and winter automations are not defects.
 */
export function registerHealthTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "ha_get_health",
    {
      title: "Instance health report",
      description:
        "One-call health summary: Home Assistant's own repair issues, entities unavailable or unknown " +
        "(with age), low batteries, enabled automations that have not fired for a long time, and " +
        "entities without an area. Use the health-report prompt for a guided reading.",
      inputSchema: {
        battery_threshold: z.number().min(1).max(99).optional().describe("Percent, default 20"),
        stale_days: z.number().min(1).max(365).optional().describe("Automation staleness, default 30 days"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_health", async ({ battery_threshold, stale_days }) => {
      const batteryMax = battery_threshold ?? 20;
      const staleMs = (stale_days ?? 30) * 86_400_000;
      const now = Date.now();
      const all = (await ctx.catalog.index()).filter((e) => entityReadVisible(ctx.cfg, e.entity_id));

      const ageDays = (iso: string): number | null => {
        const t = Date.parse(iso);
        return Number.isFinite(t) ? Math.floor((now - t) / 86_400_000) : null;
      };
      const capped = <T>(items: T[]): { items: T[]; total: number } => ({ items: items.slice(0, SECTION_CAP), total: items.length });

      const unavailable = capped(
        all
          .filter((e) => e.state === "unavailable" || e.state === "unknown")
          .map((e) => ({ entity_id: e.entity_id, state: e.state, since: e.last_changed, days: ageDays(e.last_changed) }))
          .sort((a, b) => (b.days ?? 0) - (a.days ?? 0))
      );

      const lowBatteries = capped(
        all
          .filter((e) => {
            const cls = e.attributes.device_class;
            const level = cls === "battery" ? Number(e.state) : Number(e.attributes.battery_level);
            return Number.isFinite(level) && level <= batteryMax;
          })
          .map((e) => ({
            entity_id: e.entity_id,
            name: e.name,
            level: e.attributes.device_class === "battery" ? Number(e.state) : Number(e.attributes.battery_level),
          }))
          .sort((a, b) => a.level - b.level)
      );

      const staleAutomations = capped(
        all
          .filter((e) => {
            if (e.domain !== "automation" || e.state !== "on") return false;
            const last = e.attributes.last_triggered;
            if (last === null || last === undefined) return true;
            const t = Date.parse(String(last));
            return Number.isFinite(t) ? now - t > staleMs : true;
          })
          .map((e) => ({
            entity_id: e.entity_id,
            name: e.name,
            last_triggered: (e.attributes.last_triggered as string | null) ?? null,
          }))
      );

      const unassigned = all.filter((e) => !e.area && !e.hidden && e.category === null).length;

      // Home Assistant's own diagnostics (Repairs). Best source there is;
      // degrade to [] on cores without the command, like the registries.
      let repairs: Array<Record<string, unknown>> = [];
      try {
        const res: any = await ctx.ws.send("repairs/list_issues", {});
        repairs = ((res?.issues as any[]) ?? []).slice(0, REPAIRS_CAP).map((i) => ({
          domain: i.domain,
          severity: i.severity,
          issue: i.translation_key ?? i.issue_id,
          ...(i.created ? { created: i.created } : {}),
          ...(i.is_fixable !== undefined ? { fixable: Boolean(i.is_fixable) } : {}),
        }));
      } catch (e) {
        log.debug(`repairs/list_issues unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }

      return {
        repairs: { items: repairs, note: repairs.length === 0 ? "No repair issue reported by Home Assistant (or unsupported core)." : "Straight from Home Assistant's Repairs system." },
        unavailable,
        low_batteries: { ...lowBatteries, threshold_percent: batteryMax },
        stale_automations: { ...staleAutomations, threshold_days: stale_days ?? 30 },
        unassigned_entities: unassigned,
        note: "Qualified signals, not verdicts: a seasonal sensor or a winter automation can be legitimately idle.",
      };
    })
  );
}
