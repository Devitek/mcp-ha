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
import { registerHelperTools } from "./tools/helpers.js";
import { registerConfigWriteTools } from "./tools/configwrite.js";
import { registerHealthTools } from "./tools/health.js";
import { registerNotifyTools } from "./tools/notify.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

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

  registerEntityTools(server, ctx);
  registerServiceTools(server, ctx);
  registerWriteTools(server, ctx);
  registerAutomationTools(server, ctx);
  registerHistoryTools(server, ctx);
  registerAddonTools(server, ctx);
  registerSystemTools(server, ctx);
  registerCameraTools(server, ctx);
  registerCalendarTools(server, ctx);
  registerHelperTools(server, ctx);
  registerConfigWriteTools(server, ctx);
  registerHealthTools(server, ctx);
  registerNotifyTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}
