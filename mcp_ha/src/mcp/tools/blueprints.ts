import { z } from "zod";
import type { ToolRegistrar } from "../registry.js";
import type { ToolContext } from "../../context.js";
import { safe, trunc } from "../helpers.js";

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
        "Installed automation (or script) blueprints with their inputs: name, description, which inputs " +
        "are required. Creating from a blueprint (ha_create_from_blueprint) is the safest way to add an " +
        "automation: the behaviour is already written and vetted, only typed inputs are filled.",
      inputSchema: {
        domain: z.enum(["automation", "script"]).optional().describe("Default automation"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_list_blueprints", async ({ domain }) => {
      let raw: Record<string, any>;
      try {
        raw = (await ctx.ws.send("blueprint/list", { domain: domain ?? "automation" })) ?? {};
      } catch (e) {
        throw new Error(
          `blueprints are not available on this Home Assistant (${e instanceof Error ? e.message : String(e)})`
        );
      }
      const items = Object.entries(raw).map(([path, bp]) => {
        const meta = (bp as { metadata?: Record<string, any> })?.metadata ?? {};
        const input: Record<string, any> = meta.input ?? {};
        return {
          path,
          name: String(meta.name ?? path),
          ...(meta.description ? { description: trunc(String(meta.description), 300) } : {}),
          inputs: Object.entries(input).map(([iname, idef]) => {
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
          }),
        };
      });
      return { domain: domain ?? "automation", items, total: items.length };
    })
  );
}
