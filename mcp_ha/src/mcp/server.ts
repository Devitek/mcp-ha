import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../config.js";
import type { ToolContext } from "../context.js";
import { registerEntityTools } from "./tools/entities.js";
import { registerServiceTools } from "./tools/services.js";
import { registerAutomationTools } from "./tools/automations.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerAddonTools } from "./tools/addons.js";
import { registerSystemTools } from "./tools/system.js";

/**
 * Construit un serveur MCP complet. Appelé à chaque requête (mode stateless),
 * l'enregistrement des outils est purement en mémoire et très bon marché.
 */
export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "mcp-ha", version: VERSION },
    {
      instructions:
        "Serveur MCP pour Home Assistant. Découvrez les entités avec ha_search_entities " +
        "(ou ha_list_entities avec filtres), puis ha_get_entity pour le détail. " +
        "Les réponses sont du JSON compact, paginé et plafonné : affinez vos filtres plutôt " +
        "que de demander de gros volumes. Pour l'historique long, préférez ha_get_statistics.",
    }
  );
  registerEntityTools(server, ctx);
  registerServiceTools(server, ctx);
  registerAutomationTools(server, ctx);
  registerHistoryTools(server, ctx);
  registerAddonTools(server, ctx);
  registerSystemTools(server, ctx);
  return server;
}
