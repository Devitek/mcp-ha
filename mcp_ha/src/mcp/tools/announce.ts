import { z } from "zod";
import type { ToolRegistrar } from "../registry.js";
import type { ToolContext } from "../../context.js";
import { safe, trunc } from "../helpers.js";
import { entityReadVisible } from "../../safety.js";
import { guardedServiceCall } from "../writeflow.js";
import { audit } from "../../logger.js";
import { TargetRateLimiter } from "../../rate.js";

/**
 * Voice announcements (#125): the spoken sibling of ha_send_notification.
 * Stricter cap than notifications: a voice in the living room disturbs
 * more than a vibration.
 */
const limiter = new TargetRateLimiter(3);

/** Test hook. */
export function resetAnnounceLimiter(): void {
  limiter.reset();
}

export function registerAnnounceTools(server: ToolRegistrar, ctx: ToolContext): void {
  // Gated by allow_write and by the token scope (#85).

  server.registerTool(
    "ha_announce",
    {
      title: "Announce on speakers",
      description:
        "Speaks a message in the house ('announce that dinner is ready'). Without target: lists the " +
        "Assist satellites, media players and TTS engines available. Assist satellites use their native " +
        "announce; media players go through tts.speak. Capped at 3 announcements per minute per target.",
      inputSchema: {
        message: z.string().min(1).describe("What to say; audio, keep it short"),
        target: z.string().optional().describe("assist_satellite.* or media_player.*; omit to list"),
        engine: z.string().optional().describe("tts.* engine for media players; default: the first one available"),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe("ha_announce", async ({ message, target, engine, dry_run, confirm_token }) => {
      const index = await ctx.catalog.index();
      const visible = index.filter((e) => entityReadVisible(ctx.cfg, e.entity_id));
      if (!target) {
        return {
          targets: {
            assist_satellites: visible.filter((e) => e.domain === "assist_satellite").map((e) => e.entity_id),
            media_players: visible.filter((e) => e.domain === "media_player").map((e) => e.entity_id),
            tts_engines: visible.filter((e) => e.domain === "tts").map((e) => e.entity_id),
          },
          note: "Pass one as target. Media players need a TTS engine (picked automatically when only one exists).",
        };
      }

      const body = trunc(message, 500);
      if (!dry_run && !limiter.allow(target)) {
        audit({
          client: ctx.client ?? "default",
          tool: "ha_announce",
          target,
          allowed: false,
          reason: `rate limited (${limiter.limit}/min per target)`,
        });
        throw new Error(`rate limited: at most ${limiter.limit} announcements per minute per target. Wait before retrying.`);
      }

      if (target.startsWith("assist_satellite.")) {
        return guardedServiceCall(ctx, {
          tool: "ha_announce",
          domain: "assist_satellite",
          service: "announce",
          target: { entity_id: target },
          data: { message: body },
          dry_run,
          confirm_token,
        });
      }
      if (target.startsWith("media_player.")) {
        const tts = engine ?? visible.find((e) => e.domain === "tts")?.entity_id;
        if (!tts) {
          throw new Error(
            "no TTS engine available: install one (e.g. Google Translate TTS or Piper) or pass engine explicitly."
          );
        }
        return guardedServiceCall(ctx, {
          tool: "ha_announce",
          domain: "tts",
          service: "speak",
          target: { entity_id: tts },
          data: { media_player_entity_id: target, message: body },
          dry_run,
          confirm_token,
        });
      }
      throw new Error(`expected an assist_satellite.* or media_player.* target, got: ${target}`);
    })
  );
}
