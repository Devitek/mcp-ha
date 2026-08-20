import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { listEnvelope, safe, trunc } from "../helpers.js";
import { entityWriteAllowed, serviceAllowed } from "../../safety.js";
import { audit } from "../../logger.js";

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
      const services: Record<string, Record<string, any>> = await ctx.ws.send("get_services");

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
        "Subject to the allow/deny lists configured in the add-on.",
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
        return_response: z.boolean().optional().describe("true when the service returns data (e.g. weather.get_forecasts)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe("ha_call_service", async ({ domain, service, target, data, dry_run, return_response }) => {
      const dom = domain.toLowerCase().trim();
      const svc = service.toLowerCase().trim();
      const deny = (reason: string) => {
        audit({ tool: "ha_call_service", domain: dom, service: svc, target, allowed: false, reason });
        throw new Error(`call refused: ${reason}`);
      };

      const sv = serviceAllowed(ctx.cfg, dom, svc);
      if (!sv.allowed) deny(sv.reason ?? "service denied");

      // Explicitly targeted entities (target, plus data just in case).
      const ids: string[] = [];
      const collect = (v: unknown) => {
        if (typeof v === "string") ids.push(v);
        else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") ids.push(x);
      };
      collect(target?.entity_id);
      collect((data as Record<string, unknown> | undefined)?.entity_id);

      for (const id of ids) {
        const v = entityWriteAllowed(ctx.cfg, id);
        if (!v.allowed) deny(v.reason ?? `entity denied: ${id}`);
      }

      // Targeting by area or device would bypass the entity lists: refuse it
      // as soon as any entity restriction is configured.
      const hasRestrictions = ctx.cfg.entityAllowlist.length > 0 || ctx.cfg.entityDenylist.length > 0;
      if (hasRestrictions && (target?.area_id || target?.device_id)) {
        deny("entity restrictions are configured, target explicit entity_id values instead of area_id or device_id");
      }

      if (dry_run) {
        audit({ tool: "ha_call_service", domain: dom, service: svc, target, data, dry_run: true, allowed: true });
        return {
          dry_run: true,
          would_call: { domain: dom, service: svc, target: target ?? null, data: data ?? null },
          note: "Nothing was executed. Call again without dry_run to execute.",
        };
      }

      const payload: Record<string, unknown> = { domain: dom, service: svc };
      if (target) payload.target = target;
      if (data) payload.service_data = data;
      if (return_response) payload.return_response = true;

      const result = await ctx.ws.send("call_service", payload);
      audit({ tool: "ha_call_service", domain: dom, service: svc, target, data, allowed: true, result: "ok" });
      return {
        success: true,
        ...(result?.response !== undefined ? { response: result.response } : {}),
      };
    })
  );
}
