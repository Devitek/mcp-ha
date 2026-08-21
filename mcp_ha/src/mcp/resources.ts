import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

/**
 * Static-ish catalogs exposed as MCP resources (v0.3, #79): clients that
 * support resources can pin them as context without spending a tool call.
 * The heavier, filterable listings stay tools.
 */
export function registerResources(server: McpServer, ctx: ToolContext): void {
  const json = (uri: string, data: unknown) => ({
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data) }],
  });

  server.registerResource(
    "areas",
    "ha://areas",
    {
      title: "Areas",
      description: "All Home Assistant areas with their entity counts.",
      mimeType: "application/json",
    },
    async (uri) => {
      const [regs, index] = await Promise.all([ctx.catalog.registries(), ctx.catalog.index()]);
      const counts = new Map<string, number>();
      for (const e of index) if (e.area) counts.set(e.area, (counts.get(e.area) ?? 0) + 1);
      return json(
        uri.href,
        regs.areas.map((a) => ({ area_id: a.area_id, name: a.name, entities: counts.get(a.name) ?? 0 }))
      );
    }
  );

  server.registerResource(
    "services",
    "ha://services",
    {
      title: "Service domains",
      description: "Callable service domains with their service counts (details via the ha_list_services tool).",
      mimeType: "application/json",
    },
    async (uri) => {
      const services: Record<string, Record<string, unknown>> = await ctx.ws.send("get_services");
      return json(
        uri.href,
        Object.entries(services).map(([domain, defs]) => ({ domain, services: Object.keys(defs).length }))
      );
    }
  );

  server.registerResource(
    "config",
    "ha://config",
    {
      title: "Home Assistant configuration",
      description: "Compact Home Assistant instance configuration (version, name, timezone, units).",
      mimeType: "application/json",
    },
    async (uri) => {
      const c = await ctx.ws.send("get_config");
      return json(uri.href, {
        version: c.version,
        location_name: c.location_name,
        time_zone: c.time_zone,
        unit_system: c.unit_system,
        currency: c.currency,
        country: c.country,
        components: Array.isArray(c.components) ? c.components.length : null,
        state: c.state,
      });
    }
  );
}
