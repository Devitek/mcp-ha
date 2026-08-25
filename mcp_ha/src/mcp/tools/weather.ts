import { z } from "zod";
import type { ToolRegistrar } from "../registry.js";
import type { ToolContext } from "../../context.js";
import { safe } from "../helpers.js";
import { entityReadVisible } from "../../safety.js";

/** Forecast entry caps per type: enough to reason, never a dump. */
const MAX_ENTRIES: Record<string, number> = { hourly: 48, daily: 14, twice_daily: 14 };

/**
 * Weather forecasts (#140). Since HA 2024.3 forecasts left the weather
 * entity attributes: weather.get_forecasts returns them via
 * return_response, the read-by-service mechanic already proven by
 * todo.get_items (#87), safe without allow_write.
 */
export function registerWeatherTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    "ha_get_forecast",
    {
      title: "Weather forecast",
      description:
        "Without entity_id: lists the weather entities. With entity_id: the forecast ('will it rain " +
        "tomorrow?'). type hourly for the next hours, daily (default) for the week, twice_daily where " +
        "supported. Current conditions live on the weather entity itself (ha_get_entity).",
      inputSchema: {
        entity_id: z.string().optional().describe("E.g. weather.maison; omit to list"),
        type: z.enum(["hourly", "daily", "twice_daily"]).optional().describe("Default daily"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_forecast", async ({ entity_id, type }) => {
      const index = await ctx.catalog.index();
      if (!entity_id) {
        const items = index
          .filter((e) => e.domain === "weather" && entityReadVisible(ctx.cfg, e.entity_id))
          .map((e) => ({ entity_id: e.entity_id, name: e.name, condition: e.state }));
        return { items, total: items.length, note: "Pass entity_id for the forecast." };
      }
      if (!entity_id.startsWith("weather.")) throw new Error(`expected a weather.* entity_id, got: ${entity_id}`);
      if (!entityReadVisible(ctx.cfg, entity_id)) throw new Error(`entity ${entity_id} is not accessible (filter_reads)`);
      const kind = type ?? "daily";
      // Not every provider supports every type: HA's error is clear, relayed.
      const res = await ctx.ws.send("call_service", {
        domain: "weather",
        service: "get_forecasts",
        target: { entity_id },
        service_data: { type: kind },
        return_response: true,
      });
      const raw: any[] = res?.response?.[entity_id]?.forecast ?? [];
      const cap = MAX_ENTRIES[kind] ?? 14;
      const forecast = raw.slice(0, cap).map((f) => ({
        datetime: f.datetime,
        condition: f.condition,
        temperature: f.temperature,
        ...(f.templow !== undefined ? { templow: f.templow } : {}),
        ...(f.precipitation !== undefined ? { precipitation: f.precipitation } : {}),
        ...(f.precipitation_probability !== undefined ? { precipitation_probability: f.precipitation_probability } : {}),
        ...(f.wind_speed !== undefined ? { wind_speed: f.wind_speed } : {}),
        ...(f.humidity !== undefined ? { humidity: f.humidity } : {}),
      }));
      // Units live on the weather entity attributes, best effort.
      const attrs = index.find((e) => e.entity_id === entity_id)?.attributes ?? {};
      const units: Record<string, unknown> = {};
      for (const k of ["temperature_unit", "precipitation_unit", "wind_speed_unit"]) {
        if (attrs[k] !== undefined) units[k.replace("_unit", "")] = attrs[k];
      }
      return {
        entity_id,
        type: kind,
        forecast,
        total: raw.length,
        ...(Object.keys(units).length > 0 ? { units } : {}),
        ...(raw.length > cap ? { note: `${raw.length} entries, first ${cap} returned.` } : {}),
      };
    })
  );
}
