import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../config.js";
import type { ToolContext } from "../context.js";
import { registerEntityTools } from "./tools/entities.js";
import { registerServiceTools } from "./tools/services.js";
import { registerWriteTools } from "./tools/writes.js";
import { registerAutomationTools } from "./tools/automations.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerAddonTools } from "./tools/addons.js";
import { registerSystemTools } from "./tools/system.js";
import { registerCameraTools } from "./tools/camera.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerWeatherTools } from "./tools/weather.js";
import { registerHelperTools } from "./tools/helpers.js";
import { registerConfigWriteTools } from "./tools/configwrite.js";
import { registerHealthTools } from "./tools/health.js";
import { registerSelfTestTools } from "./tools/selftest.js";
import { registerNotifyTools } from "./tools/notify.js";
import { registerSceneTools } from "./tools/scenes.js";
import { registerAnnounceTools } from "./tools/announce.js";
import { registerExplainTools } from "./tools/explain.js";
import { registerBlueprintTools } from "./tools/blueprints.js";
import { registerDashboardTools } from "./tools/dashboards.js";
import { registerEnergyTools } from "./tools/energy.js";
import { registerPresenceTools } from "./tools/presence.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { gatedRegistrar, grantsFromConfig } from "./registry.js";

/**
 * Builds a complete MCP server. Called for every request (stateless mode) or
 * once per session (#90); tool registration is in-memory and very cheap.
 */
export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "mcp-ha", version: VERSION },
    {
      instructions:
        "MCP server for Home Assistant. Discover entities with ha_search_entities " +
        "(or ha_list_entities with filters), then ha_get_entity for details. " +
        "Responses are compact, paginated and capped JSON: refine your filters " +
        "instead of requesting large dumps. For long history windows prefer ha_get_statistics.",
    }
  );

  // In-protocol confirmation (#90): only a session has the SSE stream a
  // server-to-client request needs. null = fall back to confirm_token.
  if (ctx.sessionMode) {
    ctx = {
      ...ctx,
      elicit: async (message: string): Promise<boolean | null> => {
        if (!server.server.getClientCapabilities()?.elicitation) return null;
        try {
          const res = await server.server.elicitInput({
            message,
            requestedSchema: {
              type: "object",
              properties: { confirm: { type: "boolean", title: "Confirm this action" } },
              required: ["confirm"],
            },
          });
          if (res.action === "accept") return (res.content as { confirm?: unknown } | undefined)?.confirm === true;
          return false; // decline and cancel are explicit refusals
        } catch {
          return null; // protocol hiccup: the token flow remains available
        }
      },
    };
  }

  // Central gating (#165): the modules register everything they have; the
  // registrar filters against the grants. Until per-token grants land
  // (#166/#167), grants come from the option gates and the token scope.
  const grants = ctx.grants ?? grantsFromConfig(ctx.cfg, ctx.canWrite);
  const gated = gatedRegistrar(server, grants);
  registerEntityTools(gated, ctx);
  registerServiceTools(gated, ctx);
  registerWriteTools(gated, ctx);
  registerAutomationTools(gated, ctx);
  registerHistoryTools(gated, ctx);
  registerAddonTools(gated, ctx);
  registerSystemTools(gated, ctx);
  registerCameraTools(gated, ctx);
  registerCalendarTools(gated, ctx);
  registerWeatherTools(gated, ctx);
  registerHelperTools(gated, ctx);
  registerConfigWriteTools(gated, ctx);
  registerHealthTools(gated, ctx);
  registerSelfTestTools(gated, ctx);
  registerNotifyTools(gated, ctx);
  registerSceneTools(gated, ctx);
  registerAnnounceTools(gated, ctx);
  registerExplainTools(gated, ctx);
  registerBlueprintTools(gated, ctx);
  registerDashboardTools(gated, ctx);
  registerEnergyTools(gated, ctx);
  registerPresenceTools(gated, ctx);
  registerResources(server, ctx);
  registerPrompts(server, ctx);
  return server;
}
