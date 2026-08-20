import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { safe, trunc } from "../helpers.js";

const SLUG_RE = /^[a-z0-9_-]+$/;

export function registerAddonTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "ha_get_addons",
    {
      title: "Installed add-ons",
      description:
        "Without parameters: the list of installed add-ons (slug, version, state, update available). " +
        "With slug: the details of one add-on. Read only, control will come later.",
      inputSchema: {
        slug: z.string().optional().describe("Add-on slug, e.g. core_mosquitto"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_addons", async ({ slug }) => {
      if (slug) {
        // The slug ends up in a Supervisor URL: validate it strictly.
        if (!SLUG_RE.test(slug)) throw new Error(`invalid slug: ${slug}`);
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
