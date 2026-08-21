import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { listEnvelope, safe, trunc } from "../helpers.js";
import { guardedServiceCall } from "../writeflow.js";
import { parseHaPayload, servicesSchema } from "../../ha/schemas.js";

function fieldSummary(fields: Record<string, any> | undefined) {
  if (!fields) return [];
  return Object.entries(fields).map(([name, f]) => ({
    name,
    required: f?.required === true,
    description: trunc(f?.description ?? "", 150),
    ...(f?.example !== undefined ? { example: f.example } : {}),
    ...(f?.selector ? { selector: Object.keys(f.selector)[0] } : {}),
  }));
}

export function registerServiceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "ha_list_services",
    {
      title: "List services",
      description:
        "Catalog of callable services. Without parameters: the list of domains with their service counts. " +
        "With domain: the detailed services of that domain (fields, description). " +
        "With search: cross-domain search.",
      inputSchema: {
        domain: z.string().optional().describe("E.g. light, script, climate"),
        search: z.string().optional().describe("Search in names and descriptions"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_list_services", async ({ domain, search }) => {
      const services = parseHaPayload(servicesSchema, await ctx.ws.send("get_services"), "get_services") as Record<
        string,
        Record<string, any>
      >;

      if (domain) {
        const d = services[domain.toLowerCase().trim()];
        if (!d) throw new Error(`unknown domain: ${domain}`);
        return {
          domain,
          services: Object.entries(d).map(([name, def]) => ({
            service: `${domain}.${name}`,
            description: trunc(def?.description ?? def?.name ?? "", 200),
            fields: fieldSummary(def?.fields),
          })),
        };
      }

      if (search) {
        const q = search.toLowerCase();
        const hits: Array<{ service: string; description: string }> = [];
        for (const [dom, defs] of Object.entries(services)) {
          for (const [name, def] of Object.entries(defs)) {
            const full = `${dom}.${name}`;
            const text = `${full} ${def?.name ?? ""} ${def?.description ?? ""}`.toLowerCase();
            if (text.includes(q)) hits.push({ service: full, description: trunc(def?.description ?? "", 120) });
          }
        }
        return listEnvelope(hits, 30, 0);
      }

      return {
        domains: Object.entries(services).map(([dom, defs]) => ({
          domain: dom,
          services: Object.keys(defs).length,
        })),
        note: "Call again with domain: '...' for the details of one domain, or search for a cross-domain lookup.",
      };
    })
  );

  // Write tool: only registered when allow_write is enabled. Invisible
  // otherwise, that is the first layer of defense.
  if (!ctx.cfg.allowWrite) return;

  server.registerTool(
    "ha_call_service",
    {
      title: "Call a service",
      description:
        "Calls a Home Assistant service (e.g. light.turn_on on light.kitchen). " +
        "Check the service with ha_list_services and the entity with ha_search_entities first. " +
        "Use dry_run: true to preview the call without executing it. " +
        "Subject to the allow/deny lists configured in the add-on. Sensitive domains " +
        "(confirm_domains option, locks and alarms by default) answer with a confirm_token " +
        "on the first call: show the preview to the user, then call again with the same " +
        "arguments plus confirm_token to execute.",
      inputSchema: {
        domain: z.string().describe("Service domain, e.g. light"),
        service: z.string().describe("Service name, e.g. turn_on"),
        target: z
          .object({
            entity_id: z.union([z.string(), z.array(z.string())]).optional(),
            device_id: z.union([z.string(), z.array(z.string())]).optional(),
            area_id: z.union([z.string(), z.array(z.string())]).optional(),
          })
          .optional()
          .describe("Call target, prefer entity_id"),
        // zod 4: z.record requires both the key and the value schema.
        data: z.record(z.string(), z.any()).optional().describe("Service data, e.g. { brightness_pct: 50 }"),
        dry_run: z.boolean().optional().describe("true: preview without executing"),
        confirm_token: z.string().optional().describe("Token from a previous confirmation_required answer (sensitive domains)"),
        return_response: z.boolean().optional().describe("true when the service returns data (e.g. weather.get_forecasts)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe("ha_call_service", async ({ domain, service, target, data, dry_run, confirm_token, return_response }) =>
      guardedServiceCall(ctx, {
        tool: "ha_call_service",
        domain,
        service,
        target,
        data,
        dry_run,
        confirm_token,
        return_response,
      })
    )
  );
}
