import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { effectiveTokens, loadConfig, VERSION, type AddonConfig, type ApiToken } from "./config.js";
import { enableAuditFile, getLogLevel, log } from "./logger.js";
import { AuthRateLimiter } from "./ratelimit.js";
import { safeEqual } from "./safety.js";
import { HaWsClient } from "./ha/ws.js";
import { HaHttp } from "./ha/http.js";
import { Catalog } from "./ha/catalog.js";
import { ConfirmationStore } from "./confirm.js";
import { createIngressHandler, INGRESS_PORT } from "./ingress.js";
import { buildServer } from "./mcp/server.js";
import type { ToolContext } from "./context.js";

const MAX_BODY_BYTES = 4_000_000;
/** /health reports degraded once the WS has been down this long. */
const WS_DEGRADED_AFTER_MS = 5 * 60_000;
const SHUTDOWN_GRACE_MS = 5_000;
/** Spaced retries for the token write-back: the Supervisor can answer 503 while HA boots. */
const PERSIST_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

class BodyError extends Error {}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyError("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new BodyError("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

/**
 * The HTTP request handler, extracted from main() so the authentication and
 * transport boundary is testable by injection (see index.test.ts).
 */
/** Matches the presented bearer against every accepted token (#85). */
function authenticate(presented: string, tokens: ApiToken[]): ApiToken | null {
  for (const t of tokens) if (safeEqual(presented, t.token)) return t;
  return null;
}

export function createHandler(ctx: ToolContext): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { cfg, ws } = ctx;
  const limiter = new AuthRateLimiter();
  const tokens = effectiveTokens(cfg);
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health" && req.method === "GET") {
      // Unauthenticated on purpose and deliberately minimal: no version, no
      // configuration details. Degraded once the WS has been down for a
      // while, so the Docker healthcheck finally reflects reality.
      const downFor = ws.disconnectedForMs();
      const degraded = downFor !== null && downFor > WS_DEGRADED_AFTER_MS;
      sendJson(res, degraded ? 503 : 200, {
        status: degraded ? "degraded" : "ok",
        websocket: ws.connected,
      });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    if (req.method !== "POST") {
      rpcError(res, 405, -32000, "method not allowed, this server is stateless (POST only)", {
        Allow: "POST",
      });
      return;
    }

    const ip = req.socket.remoteAddress ?? "unknown";
    const retryIn = limiter.retryInMs(ip);
    if (retryIn > 0) {
      rpcError(res, 429, -32002, "too many failed authentications, slow down", {
        "Retry-After": String(Math.ceil(retryIn / 1000)),
      });
      return;
    }

    const auth = req.headers.authorization ?? "";
    const presented = auth.match(/^Bearer\s+(.+)$/i)?.[1];
    const identity = presented ? authenticate(presented.trim(), tokens) : null;
    if (!identity) {
      const blocked = limiter.fail(ip);
      log.notice(`Unauthorized MCP request from ${ip}${blocked > 0 ? ` (blocked ${blocked} ms)` : ""}`);
      rpcError(res, 401, -32001, "unauthorized", { "WWW-Authenticate": "Bearer" });
      return;
    }
    limiter.succeed(ip);
    // Per-request context carries the authenticated identity and its scope:
    // a read-scoped token never sees the write tools (#85).
    const reqCtx: ToolContext = { ...ctx, canWrite: identity.scope === "write", client: identity.name };

    try {
      const body = await readJsonBody(req);
      log.debug(`MCP request from ${ip} as "${identity.name}" (${identity.scope})`);
      // Stateless mode: one server and one transport per request, no session
      // (sessionIdGenerator left undefined). The SDK types are not
      // exactOptionalPropertyTypes-clean, hence the connect cast.
      const server = buildServer(reqCtx);
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warning(`MCP request failed: ${msg}`);
      if (!res.headersSent) {
        // -32700 is reserved for malformed requests; anything else is an
        // internal error and the client gets a generic message.
        if (e instanceof BodyError) rpcError(res, 400, -32700, msg);
        else rpcError(res, 500, -32603, "internal error");
      } else {
        res.end();
      }
    }
  };
}

/**
 * Option keys added in later versions. The Supervisor materializes defaults
 * into the stored user options at INSTALL time only and never injects new
 * keys on updates: a key the schema requires but the stored options lack
 * bricks every config save (issue #81). Every new option key added to
 * config.yaml MUST get an entry here.
 */
const OPTION_MIGRATIONS: Array<{ key: string; value: unknown }> = [
  { key: "confirm_domains", value: ["lock", "alarm_control_panel"] },
  { key: "api_tokens", value: [] },
  { key: "allow_camera", value: false },
];

/**
 * Boot-time reconciliation of the stored add-on options: adds the option
 * keys introduced by newer versions (see OPTION_MIGRATIONS) and, when the
 * API token was generated by us, writes it back so it becomes visible in
 * the HA configuration panel. Retried a few times because the Supervisor
 * may not be ready during HA boot.
 *
 * The options are re-fetched immediately before each attempt and the token
 * write is skipped when api_token is no longer empty (the user set one in
 * the meantime); posting merges the freshly read options with only our
 * patch added, so a concurrent user edit is never clobbered by stale data.
 */
export async function reconcileOptions(
  cfg: AddonConfig,
  http: HaHttp,
  delays: number[] = PERSIST_RETRY_DELAYS_MS
): Promise<boolean> {
  if (!http.supervisorAvailable) return false;
  for (let attempt = 0; ; attempt++) {
    try {
      const info = await http.supervisorGet("/addons/self/info");
      const current = info?.options ?? {};

      const patch: Record<string, unknown> = {};
      for (const m of OPTION_MIGRATIONS) {
        if (!(m.key in current)) patch[m.key] = m.value;
      }
      const tokenAlreadySet = typeof current.api_token === "string" && current.api_token.trim().length > 0;
      if (cfg.apiTokenGenerated && !tokenAlreadySet) patch.api_token = cfg.apiToken;

      if (Object.keys(patch).length === 0) return false;
      await http.supervisorPost("/addons/self/options", {
        options: { ...current, ...patch },
      });
      log.notice(
        `Add-on options reconciled (${Object.keys(patch).join(", ")}); they are visible in the HA configuration panel.`
      );
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const delay = delays[attempt];
      if (delay === undefined) {
        log.warning(
          `Could not reconcile the add-on options after ${attempt + 1} attempts: ${msg}. ` +
            "Restart the add-on to retry; a generated token stays available in /data/token."
        );
        return false;
      }
      log.debug(`Options reconciliation failed (${msg}), retrying in ${delay} ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function closeWithGrace(server: Server, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Requests still running after the grace period are cut, but everything
      // that could finish in time got its answer out.
      server.closeAllConnections();
      resolve();
    }, graceMs);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  // Persist audit lines when /data exists (i.e. inside the add-on); dev mode
  // outside the container keeps the stdout-only behaviour (#91).
  if (existsSync("/data")) {
    enableAuditFile("/data/audit.log");
    log.debug("Audit lines are mirrored to /data/audit.log (size-rotated).");
  }

  const ws = new HaWsClient(cfg);
  const catalog = new Catalog(ws);
  // Stale caches must not survive an HA restart (audit B5/C9), and the live
  // state cache resubscribes on every (re)connection (v0.3, #79).
  ws.onConnect(() => {
    catalog.invalidate();
    void catalog.startLive();
    // Registry events drop the registry cache the moment something is
    // renamed or moved (#93); the TTL only remains as a safety net.
    void catalog.watchRegistries();
  });
  ws.connect();
  const http = new HaHttp(cfg);
  const ctx: ToolContext = { cfg, ws, http, catalog, confirmations: new ConfirmationStore() };
  void reconcileOptions(cfg, http);

  const httpServer = createServer(createHandler(ctx));

  // Ingress status page (v0.3, #79): the port stays inside the container
  // network (not in config.yaml ports), the Supervisor proxies and
  // authenticates HA users to it.
  const ingressServer = cfg.supervisorToken || process.env.INGRESS_TEST === "true" ? createServer(createIngressHandler(ctx)) : null;
  ingressServer?.listen(INGRESS_PORT, "0.0.0.0", () => {
    log.info(`Ingress status page listening on port ${INGRESS_PORT}`);
  });

  httpServer.listen(cfg.port, "0.0.0.0", () => {
    log.info(`mcp-ha ${VERSION} listening on port ${cfg.port} (MCP endpoint /mcp, health /health)`);
    log.info(`Mode: ${cfg.supervisorToken ? "add-on (Supervisor)" : "dev (HA_URL)"}`);
    log.info(`Log level: ${getLogLevel()}`);
    log.info(`Write access (allow_write): ${cfg.allowWrite ? "ENABLED, ha_call_service is exposed" : "disabled, read only"}`);
    if (cfg.filterReads) log.info("filter_reads is active: the denylist also applies to reads.");
  });

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    log.info("Shutdown requested, draining in-flight requests...");
    ingressServer?.close();
    void closeWithGrace(httpServer, SHUTDOWN_GRACE_MS).then(() => {
      ws.shutdown();
      process.exit(0);
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

// The entry point only runs when executed directly, so index.test.ts can
// import createHandler and persistGeneratedToken without starting a server.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    log.fatal(`Startup failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(1);
  });
}
