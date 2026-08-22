import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { safe } from "../helpers.js";

/**
 * Dashboard listing (#129), read only. The guarded card insertion lives
 * with the other config writes (ha_add_dashboard_card, configwrite.ts).
 */
export function registerDashboardTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "ha_list_dashboards",
    {
      title: "List dashboards",
      description:
        "Without dashboard: the Lovelace dashboards (title, url_path, editable or YAML-managed). " +
        "With dashboard: its views (index, title, path, layout type, card count), what " +
        "ha_add_dashboard_card needs to target an insertion.",
      inputSchema: {
        dashboard: z.string().optional().describe("url_path, or 'lovelace' for the default; omit to list dashboards"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_list_dashboards", async ({ dashboard }) => {
      if (!dashboard) {
        const list: any[] = ((await ctx.ws.send("lovelace/dashboards/list", {})) as any[]) ?? [];
        return {
          items: [
            { url_path: "lovelace", title: "Default dashboard", editable: null, note: "editability known on read" },
            ...list.map((d) => ({
              url_path: d.url_path,
              title: d.title,
              editable: d.mode === "storage",
              ...(d.mode !== "storage" ? { note: "YAML-managed: not editable through the add-on" } : {}),
            })),
          ],
          note: "Pass a url_path to see the views of one dashboard.",
        };
      }
      const urlPath = dashboard === "lovelace" || dashboard === "" ? null : dashboard;
      const config: any = await ctx.ws.send("lovelace/config", { url_path: urlPath });
      const views: any[] = config?.views ?? [];
      return {
        dashboard,
        views: views.map((v, i) => ({
          index: i,
          ...(v.title ? { title: v.title } : {}),
          ...(v.path ? { path: v.path } : {}),
          layout: v.type === "sections" || Array.isArray(v.sections) ? "sections" : "cards",
          cards:
            v.type === "sections" || Array.isArray(v.sections)
              ? (v.sections ?? []).reduce((n: number, s: any) => n + (s.cards?.length ?? 0), 0)
              : (v.cards?.length ?? 0),
        })),
        total: views.length,
      };
    })
  );
}
