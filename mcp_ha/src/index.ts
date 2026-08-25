import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { effectiveTokens, loadConfig, VERSION, type AddonConfig, type ApiToken } from "./config.js";
import { audit, enableAuditFile, getLogLevel, log } from "./logger.js";
import { AuthRateLimiter } from "./ratelimit.js";
import { safeEqual } from "./safety.js";
import { HaWsClient } from "./ha/ws.js";
import { HaHttp } from "./ha/http.js";
import { Catalog } from "./ha/catalog.js";
import { ConfirmationStore } from "./confirm.js";
import { createIngressHandler, INGRESS_PORT } from "./ingress.js";
import { UsageTracker } from "./usage.js";
import { buildServer } from "./mcp/server.js";
import { capGrants, type Grants } from "./mcp/registry.js";
import { TokenStore } from "./db/store.js";
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

/** One long-lived MCP session (#90): transport + server + token binding. */
interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof buildServer>;
  /** Name of the token that opened the session; others get a 403. */
  identity: string;
  lastSeen: number;
}

export interface HandlerOptions {
  /** Session cap (#90); sized for a Pi, overridable in tests. */
  maxSessions?: number;
  /** Idle sessions are closed after this long. */
  sessionIdleMs?: number;
  /** Shared usage counters displayed on the ingress page (#128). */
  usage?: UsageTracker;
  /** Fine-grained token store (#166); absent in bare setups and some tests. */
  store?: TokenStore;
}

export function createHandler(
  ctx: ToolContext,
  opts: HandlerOptions = {}
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { cfg, ws } = ctx;
  const limiter = new AuthRateLimiter();
  const tokens = effectiveTokens(cfg);
  const maxSessions = opts.maxSessions ?? 16;
  const sessionIdleMs = opts.sessionIdleMs ?? 30 * 60_000;
  const usage = opts.usage ?? new UsageTracker();
  const sessions = new Map<string, McpSession>();

  // Idle sweep (#90, audit lesson: caps and cleanup from day one). unref so
  // the timer never keeps the process alive.
  if (cfg.enableSessions) {
    setInterval(() => {
      const now = Date.now();
      for (const [sid, s] of sessions) {
        if (now - s.lastSeen > sessionIdleMs) {
          log.info(`Closing idle MCP session ${sid.slice(0, 8)}… (inactive ${Math.round((now - s.lastSeen) / 60_000)} min)`);
          s.transport.close();
        }
      }
    }, 60_000).unref();
  }

  const isInitialize = (body: unknown): boolean =>
    Array.isArray(body)
      ? body.some((m) => (m as { method?: string } | null)?.method === "initialize")
      : (body as { method?: string } | null)?.method === "initialize";

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

    // GET (SSE stream) and DELETE (session end) only make sense against an
    // existing session (#90); anything else keeps the historic 405.
    const sessionHeader = String(req.headers["mcp-session-id"] ?? "") || null;
    const sessionVerb = cfg.enableSessions && (req.method === "GET" || req.method === "DELETE") && sessionHeader !== null;
    if (req.method !== "POST" && !sessionVerb) {
      rpcError(res, 405, -32000, "method not allowed (POST; with sessions enabled, GET/DELETE carry mcp-session-id)", {
        Allow: cfg.enableSessions ? "POST, GET, DELETE" : "POST",
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
    const presented = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    // Two token populations (#166): the config tokens (primary api_token,
    // plus any legacy api_tokens not yet imported) matched in constant time,
    // then the store, looked up by sha256 so timing never correlates with
    // the secret. Store tokens carry real Grants, capped by the option
    // gates on every request: closing a gate degrades them instantly.
    let identity: { name: string; scope: string; grants?: Grants } | null = null;
    const configIdentity = presented ? authenticate(presented, tokens) : null;
    if (configIdentity) {
      identity = { name: configIdentity.name, scope: configIdentity.scope };
    } else if (presented && opts.store) {
      const v = await opts.store.verify(presented);
      if (v && v.denied) {
        audit({ event: "token_refused", client: v.record.name, reason: v.denied });
      } else if (v) {
        identity = { name: v.record.name, scope: "grants", grants: capGrants(v.record.grants, cfg) };
      }
    }
    if (!identity) {
      const blocked = limiter.fail(ip);
      log.notice(`Unauthorized MCP request from ${ip}${blocked > 0 ? ` (blocked ${blocked} ms)` : ""}`);
      rpcError(res, 401, -32001, "unauthorized", { "WWW-Authenticate": "Bearer" });
      return;
    }
    limiter.succeed(ip);
    // Per-request context carries the authenticated identity and its reach:
    // scope for config tokens (#85), capped grants for store tokens (#166).
    const reqCtx: ToolContext = {
      ...ctx,
      client: identity.name,
      ...(identity.grants ? { grants: identity.grants } : { canWrite: identity.scope === "write" }),
    };

    try {
      // Existing session: route to its transport. Every request must still
      // authenticate, and with the very token that opened the session; a
      // valid but different token cannot ride someone else's session.
      if (cfg.enableSessions && sessionHeader) {
        const session = sessions.get(sessionHeader);
        if (!session) {
          rpcError(res, 404, -32001, "unknown or expired session, reinitialize");
          return;
        }
        if (session.identity !== identity.name) {
          rpcError(res, 403, -32001, "this session belongs to another token");
          return;
        }
        session.lastSeen = Date.now();
        const body = req.method === "POST" ? await readJsonBody(req) : undefined;
        if (body !== undefined) usage.recordBody(body, identity.name);
        await session.transport.handleRequest(req, res, body);
        return;
      }

      const body = await readJsonBody(req);
      usage.recordBody(body, identity.name);
      log.debug(`MCP request from ${ip} as "${identity.name}" (${identity.scope})`);

      // New session: an initialize without a session id opens one (#90).
      // Non-initialize requests without a session id keep the stateless
      // one-shot path, so historic clients continue working unchanged.
      if (cfg.enableSessions && isInitialize(body)) {
        if (sessions.size >= maxSessions) {
          rpcError(res, 503, -32000, `session limit reached (${maxSessions}), retry later or use stateless requests`);
          return;
        }
        const server = buildServer({ ...reqCtx, sessionMode: true });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, { transport, server, identity: identity.name, lastSeen: Date.now() });
            log.info(`MCP session ${sid.slice(0, 8)}… opened by "${identity.name}" (${sessions.size}/${maxSessions})`);
          },
        } as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.delete(sid)) {
            log.info(`MCP session ${sid.slice(0, 8)}… closed (${sessions.size}/${maxSessions})`);
            server.close();
          }
        };
        await server.connect(transport as Parameters<typeof server.connect>[0]);
        await transport.handleRequest(req, res, body);
        return;
      }

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
  { key: "allow_config_write", value: false },
  { key: "enable_sessions", value: false },
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
  delays: number[] = PERSIST_RETRY_DELAYS_MS,
  extraPatch: Record<string, unknown> = {}
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
      // Caller-provided rewrites (#166: blanking api_tokens after their
      // import into the store), skipped once the stored value matches.
      for (const [k, v] of Object.entries(extraPatch)) {
        if (JSON.stringify(current[k]) !== JSON.stringify(v)) patch[k] = v;
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

  // Fine-grained token store (#166): on-disk in the add-on, in-memory in
  // dev mode. Legacy api_tokens are imported once (hashed, grants mapped
  // from their scope) and the clear-text option is then blanked, so no
  // secret keeps living in the options or the Supervisor backups.
  const store = await TokenStore.open(existsSync("/data") ? "/data/tokens.db" : ":memory:");
  if (cfg.apiTokens.length > 0) {
    const imported = await store.importLegacy(cfg.apiTokens);
    log.notice(`Token store: ${imported} legacy api_tokens imported (hashed); blanking the clear-text option.`);
    void reconcileOptions(cfg, http, undefined, { api_tokens: [] });
  } else {
    void reconcileOptions(cfg, http);
  }

  // Shared between the MCP handler (which counts) and the ingress page
  // (which displays), #128.
  const usage = new UsageTracker();
  const httpServer = createServer(createHandler(ctx, { usage, store }));

  // Ingress status page (v0.3, #79): the port stays inside the container
  // network (not in config.yaml ports), the Supervisor proxies and
  // authenticates HA users to it.
  const ingressServer =
    cfg.supervisorToken || process.env.INGRESS_TEST === "true"
      ? createServer(createIngressHandler(ctx, Date.now(), { usage }))
      : null;
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
