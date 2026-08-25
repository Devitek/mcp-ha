import { z } from "zod";
import type { ToolRegistrar } from "../registry.js";
import type { ToolContext } from "../../context.js";
import { errorResult, type ToolResult } from "../helpers.js";
import { entityReadVisible } from "../../safety.js";
import { audit, log } from "../../logger.js";

/** Base64 of a camera frame; larger than this is refused (no resize dep). */
const MAX_IMAGE_BYTES = 4_000_000;

/**
 * Camera snapshot tool (#86). Gated by its own allow_camera option, not by
 * allow_write: seeing your home is not acting on it, but it deserves its own
 * switch. filter_reads and the entity denylist still apply, and every
 * snapshot is audited (a picture leaving the house is worth a log line).
 */
export function registerCameraTools(server: ToolRegistrar, ctx: ToolContext): void {

  server.registerTool(
    "ha_get_camera_snapshot",
    {
      title: "Camera snapshot",
      description:
        "Returns the current still image of a camera entity so the assistant can describe what it sees. " +
        "Find cameras with ha_list_entities domain: 'camera'. Requires the allow_camera option.",
      inputSchema: {
        entity_id: z.string().describe("E.g. camera.front_door"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ entity_id }): Promise<ToolResult> => {
      log.debug(`Tool ha_get_camera_snapshot called for ${entity_id}`);
      try {
        if (!entity_id.startsWith("camera.")) {
          throw new Error(`expected a camera.* entity_id, got: ${entity_id}`);
        }
        if (!entityReadVisible(ctx.cfg, entity_id)) {
          audit({ client: ctx.client ?? "default", tool: "ha_get_camera_snapshot", entity_id, allowed: false, reason: "filter_reads" });
          throw new Error(`camera ${entity_id} is not accessible (filter_reads)`);
        }
        const { buffer, contentType } = await ctx.http.coreGetBinary(
          `/camera_proxy/${encodeURIComponent(entity_id)}`,
          MAX_IMAGE_BYTES
        );
        audit({ client: ctx.client ?? "default", tool: "ha_get_camera_snapshot", entity_id, allowed: true, bytes: buffer.byteLength });
        return { content: [{ type: "image", data: buffer.toString("base64"), mimeType: contentType }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warning(`Tool ha_get_camera_snapshot failed: ${msg}`);
        return errorResult(msg);
      }
    }
  );
}
