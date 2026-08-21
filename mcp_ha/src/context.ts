import type { AddonConfig } from "./config.js";
import type { HaWsClient } from "./ha/ws.js";
import type { HaHttp } from "./ha/http.js";
import type { Catalog } from "./ha/catalog.js";
import type { ConfirmationStore } from "./confirm.js";

/** Shared dependencies injected into every tool registration. */
export interface ToolContext {
  cfg: AddonConfig;
  ws: HaWsClient;
  http: HaHttp;
  catalog: Catalog;
  confirmations: ConfirmationStore;
}
