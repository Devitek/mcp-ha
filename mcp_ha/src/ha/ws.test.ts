import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { once } from "node:events";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { HaWsClient } from "./ws.js";
import { setLogLevel } from "../logger.js";
import type { AddonConfig } from "../config.js";

type Behavior = (sock: ServerSocket, msg: any) => void;

let wss: WebSocketServer | null = null;
let client: HaWsClient | null = null;
let lastAuthToken: string | null = null;

async function startServer(behavior: Behavior): Promise<number> {
  wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (sock) => {
    sock.send(JSON.stringify({ type: "auth_required" }));
    sock.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth") {
        lastAuthToken = msg.access_token;
        sock.send(JSON.stringify({ type: "auth_ok", ha_version: "test" }));
        return;
      }
      if (msg.type === "ping") {
        sock.send(JSON.stringify({ id: msg.id, type: "pong" }));
        return;
      }
      behavior(sock, msg);
    });
  });
  await once(wss, "listening");
  const address = wss.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  return address.port;
}

function makeClient(port: number): HaWsClient {
  const cfg: AddonConfig = {
    port: 9583,
    apiToken: "t",
    apiTokenGenerated: false,
    allowWrite: false,
    filterReads: false,
    entityAllowlist: [],
    entityDenylist: [],
    serviceDenylist: [],
    confirmDomains: [],
    supervisorToken: null,
    devHaUrl: `http://127.0.0.1:${port}`,
    devHaToken: "dev-token",
  };
  client = new HaWsClient(cfg);
  client.connect();
  return client;
}

beforeAll(() => setLogLevel("fatal"));

afterEach(async () => {
  client?.shutdown();
  client = null;
  await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  wss = null;
});

describe("HaWsClient", () => {
  it("authenticates with the dev token and answers a queued command", async () => {
    const port = await startServer((sock, msg) => {
      if (msg.type === "get_states") {
        sock.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: [{ entity_id: "light.a" }] }));
      }
    });
    const c = makeClient(port);
    // Sent before auth_ok arrives: must be queued, then flushed.
    const result = await c.send("get_states");
    expect(result).toEqual([{ entity_id: "light.a" }]);
    expect(lastAuthToken).toBe("dev-token");
    expect(c.connected).toBe(true);
  });

  it("correlates concurrent commands by id even when answers come back reversed", async () => {
    const pending: any[] = [];
    const port = await startServer((sock, msg) => {
      pending.push(msg);
      if (pending.length === 2) {
        for (const m of [...pending].reverse()) {
          sock.send(JSON.stringify({ id: m.id, type: "result", success: true, result: `answer:${m.type}` }));
        }
      }
    });
    const c = makeClient(port);
    const [a, b] = await Promise.all([c.send("cmd_a"), c.send("cmd_b")]);
    expect(a).toBe("answer:cmd_a");
    expect(b).toBe("answer:cmd_b");
  });

  it("rejects when Home Assistant answers success:false", async () => {
    const port = await startServer((sock, msg) => {
      sock.send(
        JSON.stringify({ id: msg.id, type: "result", success: false, error: { message: "unknown command" } })
      );
    });
    const c = makeClient(port);
    await expect(c.send("bad_command")).rejects.toThrow("unknown command");
  });

  it("times out when the server never answers", async () => {
    const port = await startServer(() => {
      // stay silent
    });
    const c = makeClient(port);
    await expect(c.send("slow_command", {}, 150)).rejects.toThrow(/did not answer within 150 ms/);
  });

  it("rejects in-flight commands when the connection drops", async () => {
    const port = await startServer((sock) => {
      sock.close();
    });
    const c = makeClient(port);
    await expect(c.send("doomed")).rejects.toThrow(/connection was lost/);
    expect(c.connected).toBe(false);
    expect(c.disconnectedForMs()).not.toBeNull();
  });

  it("reconnects with backoff after losing the connection (audit E5)", async () => {
    let connections = 0;
    const port = await startServer((sock, msg) => {
      sock.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: "pong" }));
    });
    wss!.on("connection", () => {
      connections++;
    });
    const c = makeClient(port);
    expect(await c.send("probe")).toBe("pong");
    // Server-side kill of every socket: the client must come back on its own
    // (minimum backoff is 1 s) and serve commands again.
    for (const client of wss!.clients) client.terminate();
    await new Promise((r) => setTimeout(r, 1_800));
    expect(await c.send("probe")).toBe("pong");
    expect(connections).toBe(2);
    expect(c.connected).toBe(true);
  }, 10_000);

  it("fails fast on auth_invalid instead of letting waiters sit out their timeout", async () => {
    wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (sock) => {
      sock.send(JSON.stringify({ type: "auth_required" }));
      sock.on("message", () => {
        sock.send(JSON.stringify({ type: "auth_invalid", message: "bad token" }));
        sock.close();
      });
    });
    await once(wss, "listening");
    const address = wss.address();
    if (typeof address === "string" || address === null) throw new Error("no port");
    const c = makeClient(address.port);
    const started = Date.now();
    await expect(c.send("anything")).rejects.toThrow(/connection was lost/);
    // Rejected by the close handler, not by the 10 s ready() timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(c.connected).toBe(false);
  });
});
