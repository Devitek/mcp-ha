import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { safe, trunc } from "../helpers.js";

export function registerSystemTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "ha_render_template",
    {
      title: "Rendre un template Jinja",
      description:
        "Évalue un template Jinja2 côté Home Assistant et renvoie le rendu. Très puissant pour des lectures " +
        "calculées : {{ states('sensor.x') }}, {{ states.light | selectattr('state','eq','on') | list | count }}, etc. " +
        "Lecture seule, mais accède à toutes les entités.",
      inputSchema: {
        template: z.string().min(1).max(5000).describe("Template Jinja2"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_render_template", async ({ template }) => {
      // Choix v0.1 : REST plutôt que WebSocket, car la commande WS
      // render_template est un abonnement (résultat via événements), voir
      // l'issue #12 du dépôt.
      const rendered = await ctx.http.corePostText("/template", { template });
      return { rendered: trunc(rendered, 5000) };
    })
  );

  server.registerTool(
    "ha_get_system",
    {
      title: "Infos système",
      description:
        "section 'config' : version de HA, nom, fuseau, unités, nombre d'intégrations. " +
        "section 'error_log' : les dernières lignes du journal d'erreurs de Home Assistant.",
      inputSchema: {
        section: z.enum(["config", "error_log"]).describe("Quelle section lire"),
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
