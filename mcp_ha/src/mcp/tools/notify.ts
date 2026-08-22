import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { safe, trunc } from "../helpers.js";
import { guardedServiceCall } from "../writeflow.js";
import { audit } from "../../logger.js";
import { TargetRateLimiter } from "../../rate.js";

/**
 * Outbound notifications (#116). Doable through ha_call_service since v0.2,
 * but a named tool makes the use case discoverable and lists the real
 * targets. Everything still flows through the single guarded write path.
 */

/**
 * A notification physically disturbs someone (ring, watch buzz): a looping
 * assistant must not hammer. Process-wide fixed cap per target; the audit
 * trail then says who sent what. Limiter shared with ha_announce (#125).
 */
const limiter = new TargetRateLimiter(6);

/** Test hook. */
export function resetNotifyLimiter(): void {
  limiter.reset();
}

export function registerNotifyTools(server: McpServer, ctx: ToolContext): void {
  // Gated by allow_write and by the token scope (#85).
  if (!ctx.cfg.allowWrite || ctx.canWrite === false) return;

  server.registerTool(
    "ha_send_notification",
    {
      title: "Send a notification",
      description:
        "Sends a notification to a phone or other notify target ('tell me when the wash is done'). " +
        "Without target: lists the available targets. Legacy services and new notify.* entities are " +
        "both supported; the right call is routed automatically. Capped at 6 notifications per minute " +
        "per target.",
      inputSchema: {
        message: z.string().min(1).describe("The notification body"),
        target: z.string().optional().describe("A target from the list, e.g. mobile_app_pixel or notify.telephone"),
        title: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional().describe("Platform extras (actions, images, channels), passed as-is"),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe("ha_send_notification", async ({ message, target, title, data, dry_run, confirm_token }) => {
      if (!target) {
        const [services, index] = await Promise.all([ctx.ws.send("get_services"), ctx.catalog.index()]);
        const legacy = Object.keys((services?.notify as Record<string, unknown>) ?? {}).filter((s) => s !== "send_message");
        const entities = index.filter((e) => e.domain === "notify").map((e) => e.entity_id);
        return {
          targets: { services: legacy, entities },
          note: "Pass one of these as target. Entities (notify.*) use the modern send_message path.",
        };
      }

      const body = trunc(message, 1000);
      const isEntity = target.startsWith("notify.") && (await ctx.catalog.index()).some((e) => e.entity_id === target);

      if (!dry_run && !limiter.allow(target)) {
        audit({
          client: ctx.client ?? "default",
          tool: "ha_send_notification",
          target,
          allowed: false,
          reason: `rate limited (${limiter.limit}/min per target)`,
        });
        throw new Error(`rate limited: at most ${limiter.limit} notifications per minute per target. Wait before retrying.`);
      }

      if (isEntity) {
        // send_message only knows message and title; platform extras are
        // forwarded anyway so HA's own validation error reaches the client
        // instead of a silent drop.
        return guardedServiceCall(ctx, {
          tool: "ha_send_notification",
          domain: "notify",
          service: "send_message",
          target: { entity_id: target },
          data: { message: body, ...(title ? { title } : {}), ...(data ? { data } : {}) },
          dry_run,
          confirm_token,
        });
      }
      const service = target.replace(/^notify\./, "");
      return guardedServiceCall(ctx, {
        tool: "ha_send_notification",
        domain: "notify",
        service,
        data: { message: body, ...(title ? { title } : {}), ...(data ? { data } : {}) },
        dry_run,
        confirm_token,
      });
    })
  );
}
