import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { listEnvelope, safe } from "../helpers.js";
import { entityReadVisible } from "../../safety.js";

export function registerAutomationTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "ha_list_automations",
    {
      title: "Lister les automations",
      description:
        "Toutes les automations : entity_id, nom, état (on = activée), dernier déclenchement. " +
        "Pour la config détaillée d'une automation, utilisez ha_get_automation.",
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
      title: "Détail d'une automation",
      description:
        "État d'une automation et, si elle a été créée via l'interface, sa configuration complète " +
        "(déclencheurs, conditions, actions). Les automations définies en YAML ne renvoient que l'état.",
      inputSchema: {
        entity_id: z.string().describe("Ex. automation.chauffage_nuit"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_automation", async ({ entity_id }) => {
      if (!entityReadVisible(ctx.cfg, entity_id)) {
        throw new Error(`l'entité ${entity_id} n'est pas accessible (filter_reads)`);
      }
      const all = await ctx.catalog.index();
      const e = all.find((x) => x.entity_id === entity_id && x.domain === "automation");
      if (!e) throw new Error(`automation inconnue : ${entity_id}`);

      const base = {
        entity_id: e.entity_id,
        name: e.name,
        enabled: e.state === "on",
        last_triggered: (e.attributes.last_triggered as string | null) ?? null,
        mode: (e.attributes.mode as string | undefined) ?? undefined,
      };

      const cfgId = e.attributes.id;
      if (typeof cfgId !== "string" || !cfgId) {
        return { ...base, note: "Pas d'id de configuration : automation probablement définie en YAML, config non lisible." };
      }
      try {
        const config = await ctx.http.coreGet(`/config/automation/config/${encodeURIComponent(cfgId)}`);
        return { ...base, config };
      } catch {
        return { ...base, note: "Configuration non lisible via l'API (automation YAML ou droits insuffisants)." };
      }
    })
  );

  server.registerTool(
    "ha_list_scripts",
    {
      title: "Lister les scripts",
      description:
        "Tous les scripts : entity_id, nom, dernier déclenchement, état (on = en cours d'exécution).",
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
