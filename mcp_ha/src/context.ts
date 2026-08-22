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
  /**
   * Per-request: whether the authenticated token may write (#85). Undefined
   * means "yes" for backward compatibility with the single-token setup.
   */
  canWrite?: boolean;
  /** Per-request: name of the authenticated token, for the audit trail (#85). */
  client?: string;
  /** True when serving a long-lived session (SSE stream available, #90). */
  sessionMode?: boolean;
  /**
   * Asks the human for confirmation through MCP elicitation (#90). Wired by
   * buildServer in session mode only. Resolves true (confirmed), false
   * (explicitly declined) or null (client cannot elicit: fall back to the
   * confirm_token flow, which stays the universal path).
   */
  elicit?: (message: string) => Promise<boolean | null>;
}
