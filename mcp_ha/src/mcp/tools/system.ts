import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { safe, trunc } from "../helpers.js";

export function registerSystemTools(server: McpServer, ctx: ToolContext): void {
  // A Jinja template can read ANY entity state server-side, which would
  // bypass filter_reads entirely (audit D5): with read filtering enabled the
  // tool is simply not registered, same pattern as allow_write.
  if (!ctx.cfg.filterReads)
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
        "section 'error_log': the last lines of the Home Assistant error log. " +
        "section 'updates': pending Core, OS and add-on updates. " +
        "section 'backups': last backup age and recent backups.",
      inputSchema: {
        section: z.enum(["config", "error_log", "updates", "backups"]).describe("Which section to read"),
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
      if (section === "updates") {
        // Supervisor info endpoints; all readable with the minimal role.
        const [core, os, addons] = await Promise.all([
          ctx.http.supervisorGet("/core/info"),
          ctx.http.supervisorGet("/os/info"),
          ctx.http.supervisorGet("/addons"),
        ]);
        const pending = ((addons?.addons as any[]) ?? []).filter((a) => a.update_available);
        return {
          core: { version: core?.version ?? null, latest: core?.version_latest ?? null, update_available: Boolean(core?.update_available) },
          os: { version: os?.version ?? null, latest: os?.version_latest ?? null, update_available: Boolean(os?.update_available) },
          addons: {
            total: ((addons?.addons as any[]) ?? []).length,
            updates_pending: pending.length,
            pending: pending.slice(0, 10).map((a) => ({ slug: a.slug, version: a.version, latest: a.version_latest })),
          },
        };
      }
      if (section === "backups") {
        // The add-on deliberately runs with the minimal hassio role (#57):
        // if that role cannot list backups, say so honestly instead of
        // escalating privileges for comfort (#111).
        try {
          const res = await ctx.http.supervisorGet("/backups");
          const backups = (((res?.backups as any[]) ?? []) as any[])
            .map((b) => ({ slug: b.slug, name: b.name, date: b.date, type: b.type, size: b.size }))
            .sort((a, b) => String(b.date).localeCompare(String(a.date)));
          const last = backups[0] ?? null;
          const ageDays = last ? Math.floor((Date.now() - Date.parse(last.date)) / 86_400_000) : null;
          return {
            last_backup: last ? { ...last, age_days: ageDays } : null,
            recent: backups.slice(0, 10),
            total: backups.length,
            ...(last === null ? { note: "No backup found. That is worth fixing." } : {}),
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("403")) {
            return {
              available: false,
              note: "Listing backups requires a higher Supervisor role; this add-on deliberately runs with the minimal one. Check backups in Settings > System > Backups.",
            };
          }
          throw e;
        }
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
