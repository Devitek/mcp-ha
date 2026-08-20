import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { listEnvelope, safe } from "../helpers.js";
import { entityReadVisible } from "../../safety.js";
import { log } from "../../logger.js";

export function registerAutomationTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "ha_list_automations",
    {
      title: "List automations",
      description:
        "All automations: entity_id, name, state (on = enabled), last trigger time. " +
        "For the detailed configuration of one automation use ha_get_automation.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_list_automations", async ({ limit, offset }) => {
      const all = (await ctx.catalog.index())
        .filter((e) => e.domain === "automation" && entityReadVisible(ctx.cfg, e.entity_id))
        .map((e) => ({
          entity_id: e.entity_id,
          name: e.name,
          enabled: e.state === "on",
          last_triggered: (e.attributes.last_triggered as string | null) ?? null,
        }));
      return listEnvelope(all, limit ?? 100, offset ?? 0);
    })
  );

  server.registerTool(
    "ha_get_automation",
    {
      title: "Automation details",
      description:
        "State of one automation and, when it was created through the UI, its full configuration " +
        "(triggers, conditions, actions). YAML-defined automations only return their state.",
      inputSchema: {
        entity_id: z.string().describe("E.g. automation.night_heating"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_automation", async ({ entity_id }) => {
      if (!entityReadVisible(ctx.cfg, entity_id)) {
        throw new Error(`entity ${entity_id} is not accessible (filter_reads)`);
      }
      const all = await ctx.catalog.index();
      const e = all.find((x) => x.entity_id === entity_id && x.domain === "automation");
      if (!e) throw new Error(`unknown automation: ${entity_id}`);

      const base = {
        entity_id: e.entity_id,
        name: e.name,
        enabled: e.state === "on",
        last_triggered: (e.attributes.last_triggered as string | null) ?? null,
        mode: (e.attributes.mode as string | undefined) ?? undefined,
      };

      const cfgId = e.attributes.id;
      if (typeof cfgId !== "string" || !cfgId) {
        return { ...base, note: "No configuration id: probably a YAML-defined automation, config not readable." };
      }
      try {
        const config = await ctx.http.coreGet(`/config/automation/config/${encodeURIComponent(cfgId)}`);
        return { ...base, config };
      } catch (e) {
        // A 404 is the normal YAML case; anything else is a real failure and
        // must not be disguised as one (audit B7).
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("HTTP 404")) {
          return { ...base, note: "No stored configuration (YAML-defined automation)." };
        }
        log.warning(`Could not fetch the automation config for ${entity_id}: ${msg}`);
        return { ...base, note: "Configuration not readable right now (Home Assistant API error); the state above is still accurate." };
      }
    })
  );

  server.registerTool(
    "ha_list_scripts",
    {
      title: "List scripts",
      description:
        "All scripts: entity_id, name, last trigger time, state (on = currently running).",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_list_scripts", async ({ limit, offset }) => {
      const all = (await ctx.catalog.index())
        .filter((e) => e.domain === "script" && entityReadVisible(ctx.cfg, e.entity_id))
        .map((e) => ({
          entity_id: e.entity_id,
          name: e.name,
          running: e.state === "on",
          last_triggered: (e.attributes.last_triggered as string | null) ?? null,
        }));
      return listEnvelope(all, limit ?? 100, offset ?? 0);
    })
  );
}
