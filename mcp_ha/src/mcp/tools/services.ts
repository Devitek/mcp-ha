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
      title: "Lister les services",
      description:
        "Catalogue des services appelables. Sans paramètre : la liste des domaines et leur nombre de services. " +
        "Avec domain : le détail des services du domaine (champs, description). " +
        "Avec search : recherche transverse.",
      inputSchema: {
        domain: z.string().optional().describe("Ex. light, script, climate"),
        search: z.string().optional().describe("Recherche dans les noms et descriptions"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_list_services", async ({ domain, search }) => {
      const services: Record<string, Record<string, any>> = await ctx.ws.send("get_services");

      if (domain) {
        const d = services[domain.toLowerCase().trim()];
        if (!d) throw new Error(`domaine inconnu : ${domain}`);
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
        note: "Relancez avec domain: '...' pour le détail d'un domaine, ou search pour une recherche transverse.",
      };
    })
  );

  // Outil d'écriture : uniquement enregistré si allow_write est actif.
  // Invisible sinon, c'est le premier étage de la défense.
  if (!ctx.cfg.allowWrite) return;

  server.registerTool(
    "ha_call_service",
    {
      title: "Appeler un service",
      description:
        "Appelle un service Home Assistant (ex. light.turn_on sur light.cuisine). " +
        "Vérifiez d'abord le service avec ha_list_services et l'entité avec ha_search_entities. " +
        "Utilisez dry_run: true pour prévisualiser l'appel sans l'exécuter. " +
        "Soumis aux listes d'autorisation configurées dans l'add-on.",
      inputSchema: {
        domain: z.string().describe("Domaine du service, ex. light"),
        service: z.string().describe("Nom du service, ex. turn_on"),
        target: z
          .object({
            entity_id: z.union([z.string(), z.array(z.string())]).optional(),
            device_id: z.union([z.string(), z.array(z.string())]).optional(),
            area_id: z.union([z.string(), z.array(z.string())]).optional(),
          })
          .optional()
          .describe("Cible de l'appel, privilégiez entity_id"),
        data: z.record(z.any()).optional().describe("Données du service, ex. { brightness_pct: 50 }"),
        dry_run: z.boolean().optional().describe("true : prévisualise sans exécuter"),
        return_response: z.boolean().optional().describe("true si le service renvoie des données (ex. weather.get_forecasts)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe("ha_call_service", async ({ domain, service, target, data, dry_run, return_response }) => {
      const dom = domain.toLowerCase().trim();
      const svc = service.toLowerCase().trim();
      const deny = (reason: string) => {
        audit({ tool: "ha_call_service", domain: dom, service: svc, target, allowed: false, reason });
        throw new Error(`appel refusé : ${reason}`);
      };

      const sv = serviceAllowed(ctx.cfg, dom, svc);
      if (!sv.allowed) deny(sv.reason ?? "service interdit");

      // Entités ciblées explicitement (target et data au cas où).
      const ids: string[] = [];
      const collect = (v: unknown) => {
        if (typeof v === "string") ids.push(v);
        else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") ids.push(x);
      };
      collect(target?.entity_id);
      collect((data as Record<string, unknown> | undefined)?.entity_id);

      for (const id of ids) {
        const v = entityWriteAllowed(ctx.cfg, id);
        if (!v.allowed) deny(v.reason ?? `entité interdite : ${id}`);
      }

      // Un ciblage par pièce ou par appareil contournerait les listes
      // d'entités : on l'interdit dès qu'une restriction est configurée.
      const hasRestrictions = ctx.cfg.entityAllowlist.length > 0 || ctx.cfg.entityDenylist.length > 0;
      if (hasRestrictions && (target?.area_id || target?.device_id)) {
        deny("des restrictions d'entités sont configurées, ciblez des entity_id explicites plutôt que area_id ou device_id");
      }

      if (dry_run) {
        audit({ tool: "ha_call_service", domain: dom, service: svc, target, data, dry_run: true, allowed: true });
        return {
          dry_run: true,
          would_call: { domain: dom, service: svc, target: target ?? null, data: data ?? null },
          note: "Aucune action exécutée. Relancez sans dry_run pour exécuter.",
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
