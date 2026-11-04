import { z } from "zod";
import type { ToolRegistrar } from "../registry.js";
import type { ToolContext } from "../../context.js";
import { listEnvelope, safe, trunc } from "../helpers.js";

/**
 * Blueprint listing (#127), read only. The creation FROM a blueprint lives
 * with the other config writes (ha_create_from_blueprint, configwrite.ts):
 * filling typed holes in vetted YAML is the safest way to program the house.
 */
export function registerBlueprintTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    "ha_list_blueprints",
    {
      title: "List blueprints",
      description:
        "Installed automation (or script) blueprints. Without path: a compact paginated list (name, " +
        "short description, required input names), filterable by search. With path: the full inputs of " +
        "one blueprint (types, defaults), what ha_create_from_blueprint needs. Creating from a blueprint " +
        "is the safest way to add an automation: the behaviour is already written and vetted, only " +
        "typed inputs are filled.",
      inputSchema: {
        domain: z.enum(["automation", "script"]).optional().describe("Default automation"),
        path: z.string().optional().describe("Blueprint path from the list, for its full inputs"),
        search: z.string().optional().describe("Filter on name, path and description"),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_list_blueprints", async ({ domain, path, search, limit, offset }) => {
      const dom = domain ?? "automation";
      let raw: Record<string, any>;
      try {
        raw = (await ctx.ws.send("blueprint/list", { domain: dom })) ?? {};
      } catch (e) {
        throw new Error(
          `blueprints are not available on this Home Assistant (${e instanceof Error ? e.message : String(e)})`
        );
      }
      const metaOf = (bp: unknown): Record<string, any> => (bp as { metadata?: Record<string, any> })?.metadata ?? {};
      const inputsOf = (meta: Record<string, any>) =>
        Object.entries((meta.input ?? {}) as Record<string, any>).map(([iname, idef]) => {
          const d = (idef ?? {}) as Record<string, unknown>;
          return {
            name: iname,
            ...(d.description ? { description: trunc(String(d.description), 150) } : {}),
            required: !("default" in d),
            ...(d.default !== undefined ? { default: d.default } : {}),
            ...(d.selector && typeof d.selector === "object"
              ? { type: Object.keys(d.selector as object)[0] ?? "unknown" }
              : {}),
          };
        });

      // Detail of one blueprint (#227): the full inputs live here only, so
      // the list stays small whatever the collection.
      if (path) {
        if (!(path in raw)) {
          throw new Error(`unknown ${dom} blueprint '${path}', list them without path to get valid paths`);
        }
        const meta = metaOf(raw[path]);
        return {
          domain: dom,
          path,
          name: String(meta.name ?? path),
          ...(meta.description ? { description: trunc(String(meta.description), 1000) } : {}),
          inputs: inputsOf(meta),
        };
      }

      const q = search?.toLowerCase().trim();
      const all = Object.entries(raw)
        .map(([p, bp]) => {
          const meta = metaOf(bp);
          const inputs = inputsOf(meta);
          return {
            path: p,
            name: String(meta.name ?? p),
            ...(meta.description ? { description: trunc(String(meta.description), 150) } : {}),
            input_count: inputs.length,
            required_inputs: inputs.filter((i) => i.required).map((i) => i.name),
            _haystack: `${p} ${meta.name ?? ""} ${meta.description ?? ""}`.toLowerCase(),
          };
        })
        .filter((b) => !q || b._haystack.includes(q))
        .map(({ _haystack, ...b }) => b);
      return {
        domain: dom,
        ...listEnvelope(all, limit ?? 20, offset ?? 0, "Pass a path for the full inputs of one blueprint."),
      };
    })
  );
}
