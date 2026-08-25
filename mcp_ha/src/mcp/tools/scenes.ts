import { z } from "zod";
import type { ToolRegistrar } from "../registry.js";
import type { ToolContext } from "../../context.js";
import { safe } from "../helpers.js";
import { entityWriteAllowed } from "../../safety.js";
import { guardedServiceCall } from "../writeflow.js";
import { audit } from "../../logger.js";

/**
 * Scene snapshot (#110): "capture the current living room mood as a scene".
 * scene.create with snapshot_entities photographs the CURRENT state of the
 * chosen entities. The scene is volatile by HA design (it lives until the
 * scenes reload or a restart); persistent creation would be a config write
 * and stays out of this tool on purpose.
 */

/** Mirrors HA's slugify closely enough for a scene entity object id. */
function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function registerSceneTools(server: ToolRegistrar, ctx: ToolContext): void {
  // Gated by allow_write and by the token scope (#85).

  server.registerTool(
    "ha_snapshot_scene",
    {
      title: "Snapshot a scene",
      description:
        "Captures the CURRENT state of the given entities as a scene ('capture the living room mood as " +
        "Movie night'). The scene is volatile: it survives until the scenes reload or Home Assistant " +
        "restarts. Replay it with ha_call_service scene.turn_on.",
      inputSchema: {
        name: z.string().min(1).describe("Scene name, e.g. 'Movie night'"),
        entities: z.array(z.string()).min(1).max(50).describe("Entities whose current state to capture"),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe("ha_snapshot_scene", async ({ name, entities, dry_run, confirm_token }) => {
      const sceneId = slugify(name);
      if (!sceneId) throw new Error("the name must contain at least one alphanumeric character");
      // The entity lists bound what is capturable: a snapshot reads state.
      for (const id of entities) {
        const v = entityWriteAllowed(ctx.cfg, id);
        if (!v.allowed) {
          audit({ client: ctx.client ?? "default", tool: "ha_snapshot_scene", entity_id: id, allowed: false, reason: v.reason });
          throw new Error(v.reason ?? `entity denied: ${id}`);
        }
      }
      // Creation only, consistent with the config-write doctrine.
      if ((await ctx.catalog.index()).some((e) => e.entity_id === `scene.${sceneId}`)) {
        throw new Error(`scene.${sceneId} already exists; pick another name instead of overwriting it.`);
      }
      const result = await guardedServiceCall(ctx, {
        tool: "ha_snapshot_scene",
        domain: "scene",
        service: "create",
        data: { scene_id: sceneId, snapshot_entities: entities },
        dry_run,
        confirm_token,
      });
      if ((result as { success?: boolean }).success) {
        return {
          ...result,
          scene: `scene.${sceneId}`,
          note:
            "Volatile by Home Assistant design: it lives until the scenes reload or HA restarts. " +
            "Replay it with scene.turn_on. Recreate it after a restart if you still need it.",
        };
      }
      return result;
    })
  );
}
