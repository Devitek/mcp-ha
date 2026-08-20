import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { safe, trunc } from "../helpers.js";

const SLUG_RE = /^[a-z0-9_-]+$/;

export function registerAddonTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "ha_get_addons",
    {
      title: "Add-ons installés",
      description:
        "Sans paramètre : liste des add-ons installés (slug, version, état, mise à jour disponible). " +
        "Avec slug : le détail d'un add-on. Lecture seule, le pilotage viendra plus tard.",
      inputSchema: {
        slug: z.string().optional().describe("Slug d'un add-on, ex. core_mosquitto"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_addons", async ({ slug }) => {
      if (slug) {
        // Le slug part dans une URL Supervisor : on le valide strictement.
        if (!SLUG_RE.test(slug)) throw new Error(`slug invalide : ${slug}`);
        const info = await ctx.http.supervisorGet(`/addons/${slug}/info`);
        return {
          slug: info.slug,
          name: info.name,
          description: trunc(info.description ?? "", 300),
          version: info.version,
          version_latest: info.version_latest,
          update_available: info.update_available,
          state: info.state,
          boot: info.boot,
          webui: info.webui ?? null,
        };
      }
      const data = await ctx.http.supervisorGet("/addons");
      const addons: any[] = data?.addons ?? [];
      return {
        items: addons.map((a) => ({
          slug: a.slug,
          name: a.name,
          version: a.version,
          update_available: a.update_available,
          state: a.state,
        })),
        total: addons.length,
      };
    })
  );
}
