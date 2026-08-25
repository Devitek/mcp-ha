import { z } from "zod";
import type { ToolRegistrar } from "../registry.js";
import type { ToolContext } from "../../context.js";
import { safe } from "../helpers.js";
import { entityWriteAllowed } from "../../safety.js";
import { audit } from "../../logger.js";

/**
 * Helper creation and deletion (#94, tier 1). Helpers (input_*, counter,
 * timer) are pure state containers with NO behaviour: creating one cannot
 * make the house act. Still write-gated (allow_write + token scope) and
 * audited; deletion additionally honours the entity lists, like every
 * destructive path.
 */

const HELPER_TYPES = [
  "input_boolean",
  "input_number",
  "input_select",
  "input_text",
  "input_datetime",
  "counter",
  "timer",
] as const;
type HelperType = (typeof HELPER_TYPES)[number];

/** Option keys the WS message wires internally; never forwarded. */
const RESERVED_KEYS = new Set(["type", "id"]);

export function registerHelperTools(server: ToolRegistrar, ctx: ToolContext): void {
  // Gated by allow_write and by the token scope (#85).
  const client = (): string => ctx.client ?? "default";

  server.registerTool(
    "ha_create_helper",
    {
      title: "Create a helper",
      description:
        "Creates a Home Assistant helper: a pure state container with no behaviour (a boolean flag, " +
        "a counter, a dropdown...). Useful keys in options per type: input_number min/max/step/unit_of_measurement, " +
        "input_select options (list of strings), input_text min/max/pattern, input_datetime has_date/has_time, " +
        "counter initial/minimum/maximum/step, timer duration ('HH:MM:SS'). All are optional except " +
        "input_number min/max and input_select options, which Home Assistant requires.",
      inputSchema: {
        helper_type: z.enum(HELPER_TYPES).describe("E.g. input_boolean for a flag, counter for a tally"),
        name: z.string().min(1).describe("Display name, e.g. 'Vacation mode'"),
        options: z.record(z.string(), z.unknown()).optional().describe("Type-specific settings, passed to Home Assistant as-is"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe("ha_create_helper", async ({ helper_type, name, options }) => {
      const payload: Record<string, unknown> = { name };
      for (const [k, v] of Object.entries(options ?? {})) {
        if (!RESERVED_KEYS.has(k)) payload[k] = v;
      }
      const created: any = await ctx.ws.send(`config/${helper_type}/create`, payload);
      audit({ client: client(), tool: "ha_create_helper", helper_type, name, allowed: true });
      return {
        created: { helper_type, id: created?.id ?? null, name: created?.name ?? name },
        note: "The new entity appears within a second; find its entity_id with ha_search_entities on the name.",
      };
    })
  );

  server.registerTool(
    "ha_delete_helper",
    {
      title: "Delete a helper",
      description:
        "Deletes a UI-managed helper by its entity_id (e.g. input_boolean.vacation_mode). " +
        "Helpers defined in YAML cannot be deleted this way. Subject to the entity allow/deny lists.",
      inputSchema: {
        entity_id: z.string().describe("E.g. counter.coffee_count"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe("ha_delete_helper", async ({ entity_id }) => {
      const helperType = entity_id.split(".")[0] as HelperType;
      if (!HELPER_TYPES.includes(helperType)) {
        throw new Error(`expected a helper entity_id (${HELPER_TYPES.join(", ")}), got: ${entity_id}`);
      }
      const verdict = entityWriteAllowed(ctx.cfg, entity_id);
      if (!verdict.allowed) {
        audit({ client: client(), tool: "ha_delete_helper", entity_id, allowed: false, reason: verdict.reason });
        throw new Error(verdict.reason);
      }
      // The collection id survives entity renames while the entity_id suffix
      // does not: resolve it through the registry instead of guessing.
      const entry: any = await ctx.ws.send("config/entity_registry/get", { entity_id });
      if (!entry?.unique_id || entry?.platform !== helperType) {
        throw new Error(
          `${entity_id} is not a UI-managed ${helperType} helper (platform: ${entry?.platform ?? "unknown"}). ` +
            "YAML-defined helpers must be removed from the YAML."
        );
      }
      await ctx.ws.send(`config/${helperType}/delete`, { [`${helperType}_id`]: entry.unique_id });
      audit({ client: client(), tool: "ha_delete_helper", entity_id, allowed: true });
      return { deleted: entity_id };
    })
  );
}
