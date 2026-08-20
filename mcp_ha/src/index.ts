import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, VERSION } from "./config.js";
import { log } from "./logger.js";
import { safeEqual } from "./safety.js";
import { HaWsClient } from "./ha/ws.js";
import { HaHttp } from "./ha/http.js";
import { Catalog } from "./ha/catalog.js";
import { buildServer } from "./mcp/server.js";
import type { ToolContext } from "./context.js";

const MAX_BODY_BYTES = 4_000_000;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("corps de requête trop volumineux"));
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
        reject(new Error("JSON invalide"));
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

async function main(): Promise<void> {
  const cfg = loadConfig();

  const ws = new HaWsClient(cfg);
  ws.connect();
  const ctx: ToolContext = { cfg, ws, http: new HaHttp(cfg), catalog: new Catalog(ws) };

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health" && req.method === "GET") {
      // Sans auth, volontairement minimal : rien de sensible ici.
      sendJson(res, 200, { status: "ok", version: VERSION, websocket: ws.connected });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    if (req.method !== "POST") {
      rpcError(res, 405, -32000, "méthode non autorisée, le serveur est en mode stateless (POST uniquement)", {
        Allow: "POST",
      });
      return;
    }

    const auth = req.headers.authorization ?? "";
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match || !safeEqual(match[1].trim(), cfg.apiToken)) {
      rpcError(res, 401, -32001, "non autorisé", { "WWW-Authenticate": "Bearer" });
      return;
    }

    try {
      const body = await readJsonBody(req);
      // Mode stateless : un serveur et un transport par requête, aucune session.
      const server = buildServer(ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`Requête MCP en échec : ${msg}`);
      if (!res.headersSent) rpcError(res, 400, -32700, msg);
      else res.end();
    }
  });

  httpServer.listen(cfg.port, "0.0.0.0", () => {
    log.info(`Serveur MCP mcp-ha ${VERSION} à l'écoute sur le port ${cfg.port} (endpoint /mcp, santé /health)`);
    log.info(`Mode : ${cfg.supervisorToken ? "add-on (Supervisor)" : "dev (HA_URL)"}`);
    log.info(`Écriture (allow_write) : ${cfg.allowWrite ? "ACTIVE, ha_call_service exposé" : "désactivée, lecture seule"}`);
    if (cfg.filterReads) log.info("filter_reads actif : la denylist s'applique aussi aux lectures.");
  });

  const stop = (): void => {
    log.info("Arrêt demandé, fermeture propre...");
    httpServer.close();
    ws.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => {
  log.error(`Échec du démarrage : ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
