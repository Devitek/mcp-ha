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
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

/**
 * Builds a complete MCP server. Called for every request (stateless mode),
 * tool registration is in-memory and very cheap.
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
  registerEntityTools(server, ctx);
  registerServiceTools(server, ctx);
  registerWriteTools(server, ctx);
  registerAutomationTools(server, ctx);
  registerHistoryTools(server, ctx);
  registerAddonTools(server, ctx);
  registerSystemTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}
