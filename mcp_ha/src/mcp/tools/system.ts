import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { safe, trunc } from "../helpers.js";

export function registerSystemTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "ha_render_template",
    {
      title: "Render a Jinja template",
      description:
        "Evaluates a Jinja2 template on the Home Assistant side and returns the result. Very powerful " +
        "for computed reads: {{ states('sensor.x') }}, {{ states.light | selectattr('state','eq','on') | list | count }}, etc. " +
        "Read only, but it can access every entity.",
      inputSchema: {
        template: z.string().min(1).max(5000).describe("Jinja2 template"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_render_template", async ({ template }) => {
      // v0.1 choice: REST rather than WebSocket, because the WS
      // render_template command is a subscription (result comes through
      // events), see issue #12 in the repository.
      const rendered = await ctx.http.corePostText("/template", { template });
      return { rendered: trunc(rendered, 5000) };
    })
  );

  server.registerTool(
    "ha_get_system",
    {
      title: "System information",
      description:
        "section 'config': HA version, name, timezone, units, number of integrations. " +
        "section 'error_log': the last lines of the Home Assistant error log.",
      inputSchema: {
        section: z.enum(["config", "error_log"]).describe("Which section to read"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_system", async ({ section }) => {
      if (section === "config") {
        const c = await ctx.ws.send("get_config");
        return {
          version: c.version,
          location_name: c.location_name,
          time_zone: c.time_zone,
          unit_system: c.unit_system,
          currency: c.currency,
          country: c.country,
          components: Array.isArray(c.components) ? c.components.length : null,
          state: c.state,
        };
      }
      const text = await ctx.http.coreGetText("/error_log");
      const lines = text.trimEnd().split("\n");
      const tail = lines.slice(-100);
      return {
        total_lines: lines.length,
        showing: tail.length,
        log: tail.join("\n").slice(-10_000),
      };
    })
  );
}
