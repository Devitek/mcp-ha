import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { safe } from "../helpers.js";
import { entityReadVisible } from "../../safety.js";

/**
 * Energy report wired to the REAL energy dashboard (#109): energy/get_prefs
 * names the exact statistics the user configured (grid, solar, battery,
 * gas, water, per-device), so nothing is guessed. Totals use the "change"
 * statistic type: energy statistics are cumulative sums, and summing the
 * per-period change is the dashboard's own way to get a period total.
 */

const PERIOD_HOURS = { day: 24, week: 168, month: 720 } as const;

interface Buckets {
  grid_import: string[];
  grid_export: string[];
  solar: string[];
  battery_in: string[];
  battery_out: string[];
  gas: string[];
  water: string[];
}

function collectStats(prefs: any): { buckets: Buckets; devices: Array<{ stat: string; name: string | null }> } {
  const buckets: Buckets = { grid_import: [], grid_export: [], solar: [], battery_in: [], battery_out: [], gas: [], water: [] };
  for (const src of (prefs?.energy_sources as any[]) ?? []) {
    if (src.type === "grid") {
      for (const f of src.flow_from ?? []) if (f.stat_energy_from) buckets.grid_import.push(f.stat_energy_from);
      for (const f of src.flow_to ?? []) if (f.stat_energy_to) buckets.grid_export.push(f.stat_energy_to);
    } else if (src.type === "solar" && src.stat_energy_from) buckets.solar.push(src.stat_energy_from);
    else if (src.type === "battery") {
      if (src.stat_energy_to) buckets.battery_in.push(src.stat_energy_to);
      if (src.stat_energy_from) buckets.battery_out.push(src.stat_energy_from);
    } else if (src.type === "gas" && src.stat_energy_from) buckets.gas.push(src.stat_energy_from);
    else if (src.type === "water" && src.stat_energy_from) buckets.water.push(src.stat_energy_from);
  }
  const devices = (((prefs?.device_consumption as any[]) ?? []) as any[])
    .filter((d) => d.stat_consumption)
    .map((d) => ({ stat: String(d.stat_consumption), name: (d.name as string | undefined) ?? null }));
  return { buckets, devices };
}

export function registerEnergyTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "ha_get_energy",
    {
      title: "Energy report",
      description:
        "Energy totals from the configured energy dashboard (grid import/export, solar, battery, gas, " +
        "water, top consuming devices) over a period, with an optional comparison to the previous one " +
        "('this week vs last week'). Uses the exact statistics the dashboard is configured with.",
      inputSchema: {
        period: z.enum(["day", "week", "month"]).optional().describe("Sliding window, default day"),
        compare: z.boolean().optional().describe("true: also compute the previous period and the deltas"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_energy", async ({ period, compare }) => {
      let prefs: any;
      try {
        prefs = await ctx.ws.send("energy/get_prefs", {});
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `the energy dashboard is not configured (${msg}). Set it up in Settings > Dashboards > Energy, ` +
            "or use ha_get_statistics on your energy sensors directly."
        );
      }
      const { buckets, devices } = collectStats(prefs);
      const allStats = [...new Set([...Object.values(buckets).flat(), ...devices.map((d) => d.stat)])].filter((s) =>
        entityReadVisible(ctx.cfg, s)
      );
      if (allStats.length === 0) {
        return { note: "The energy dashboard has no readable statistic configured." };
      }

      const hours = PERIOD_HOURS[period ?? "day"];
      const now = Date.now();
      const window = async (start: number, end: number): Promise<Record<string, number>> => {
        const res: Record<string, Array<{ change?: number | null }>> = await ctx.ws.send("recorder/statistics_during_period", {
          start_time: new Date(start).toISOString(),
          end_time: new Date(end).toISOString(),
          statistic_ids: allStats,
          period: hours > 168 ? "day" : "hour",
          types: ["change"],
        });
        const totals: Record<string, number> = {};
        for (const [id, rows] of Object.entries(res ?? {})) {
          totals[id] = Math.round((rows ?? []).reduce((acc, r) => acc + (r.change ?? 0), 0) * 1000) / 1000;
        }
        return totals;
      };

      const sumBucket = (totals: Record<string, number>, ids: string[]): number =>
        Math.round(ids.reduce((acc, id) => acc + (totals[id] ?? 0), 0) * 1000) / 1000;
      const summarize = (totals: Record<string, number>) => ({
        grid_import: sumBucket(totals, buckets.grid_import),
        grid_export: sumBucket(totals, buckets.grid_export),
        solar: sumBucket(totals, buckets.solar),
        battery_in: sumBucket(totals, buckets.battery_in),
        battery_out: sumBucket(totals, buckets.battery_out),
        gas: sumBucket(totals, buckets.gas),
        water: sumBucket(totals, buckets.water),
      });

      const current = await window(now - hours * 3_600_000, now);
      const totals = summarize(current);
      const topDevices = devices
        .filter((d) => entityReadVisible(ctx.cfg, d.stat))
        .map((d) => ({ ...d, total: current[d.stat] ?? 0 }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);

      const out: Record<string, unknown> = {
        period: period ?? "day",
        from: new Date(now - hours * 3_600_000).toISOString(),
        to: new Date(now).toISOString(),
        totals,
        top_devices: topDevices,
        note: "Units follow the dashboard statistics (kWh for energy, m3 for gas and water).",
      };
      if (compare) {
        const previous = summarize(await window(now - 2 * hours * 3_600_000, now - hours * 3_600_000));
        const delta: Record<string, number | null> = {};
        for (const [k, v] of Object.entries(totals)) {
          const p = (previous as Record<string, number>)[k] ?? 0;
          delta[k] = p !== 0 ? Math.round(((v - p) / p) * 1000) / 10 : null;
        }
        out.previous = previous;
        out.delta_percent = delta;
      }
      return out;
    })
  );
}
