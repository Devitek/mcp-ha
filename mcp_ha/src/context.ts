import type { AddonConfig } from "./config.js";
import type { HaWsClient } from "./ha/ws.js";
import type { HaHttp } from "./ha/http.js";
import type { Catalog } from "./ha/catalog.js";

/** Dépendances partagées injectées dans chaque enregistrement d'outil. */
export interface ToolContext {
  cfg: AddonConfig;
  ws: HaWsClient;
  http: HaHttp;
  catalog: Catalog;
}
