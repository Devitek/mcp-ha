import WebSocket from "ws";
import { log } from "../logger.js";
import type { AddonConfig } from "../config.js";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** Long backoff once authentication is repeatedly refused (bad token). */
const AUTH_INVALID_BACKOFF_MS = 300_000;
const AUTH_INVALID_THRESHOLD = 3;
/** The whole connect + auth phase must finish within this budget. */
const HANDSHAKE_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Home Assistant WebSocket client: auth handshake with a hard deadline,
 * response correlation by monotonically increasing id, per-command timeouts,
 * keep-alive, and reconnection with exponential backoff. Commands issued
 * before auth_ok wait in line. Repeated auth refusals switch to a long
 * backoff instead of hammering Home Assistant forever.
 */
export class HaWsClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private waiters: Waiter[] = [];
  private authed = false;
  private closing = false;
  private backoff = RECONNECT_MIN_MS;
  private pingTimer: NodeJS.Timeout | null = null;
  private authTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private authInvalidCount = 0;
  /** Epoch ms of the moment the connection was last lost; null while authed. */
  private disconnectedAt: number | null = Date.now();
  private connectListeners: Array<() => void> = [];

  constructor(private cfg: AddonConfig) {}

  /** Registers a callback fired on every successful (re)authentication. */
  onConnect(cb: () => void): void {
    this.connectListeners.push(cb);
  }

  get connected(): boolean {
    return this.authed;
  }

  /** How long the connection has been down, in ms. null when connected. */
  disconnectedForMs(): number | null {
    return this.disconnectedAt === null ? null : Date.now() - this.disconnectedAt;
  }

  private url(): string {
    if (this.cfg.supervisorToken) return "ws://supervisor/core/websocket";
    if (this.cfg.devHaUrl) {
      return this.cfg.devHaUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/api/websocket";
    }
    throw new Error("No Home Assistant target: neither SUPERVISOR_TOKEN nor HA_URL is set");
  }

  private token(): string {
    return this.cfg.supervisorToken ?? this.cfg.devHaToken ?? "";
  }

  connect(): void {
    if (this.closing) return;
    let url: string;
    try {
      url = this.url();
    } catch (e) {
      // Even a configuration error is retried: HA_URL may appear later in
      // dev workflows, and giving up silently leaves a zombie server.
      log.error(String(e instanceof Error ? e.message : e));
      this.scheduleReconnect("no target configured");
      return;
    }
    log.info(`Connecting to Home Assistant WebSocket at ${url}`);
    const ws = new WebSocket(url, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
    this.ws = ws;

    // Hard deadline on the whole connect + auth phase: without it, a
    // half-open connection (HA rebooting mid-auth) never emits close and the
    // client would stay stuck forever.
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = setTimeout(() => {
      if (!this.authed && this.ws === ws) {
        log.warning(`Authentication did not complete within ${HANDSHAKE_TIMEOUT_MS} ms, dropping the socket`);
        ws.terminate();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    ws.on("message", (raw) => {
      if (this.ws === ws) this.onMessage(raw.toString());
    });
    ws.on("close", () => this.onClose(ws, "connection closed"));
    ws.on("error", (err) => {
      log.warning(`WebSocket error: ${err.message}`);
      // close follows and triggers the reconnection
    });
  }

  shutdown(): void {
    this.closing = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.authTimer) clearTimeout(this.authTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.authTimer = null;
    this.reconnectTimer = null;
    this.ws?.close();
  }

  /** Sends a command and waits for its result. */
  async send(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): Promise<any> {
    await this.ready();
    return this.raw(type, payload, timeoutMs);
  }

  private ready(timeoutMs = 10_000): Promise<void> {
    if (this.authed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error("Home Assistant WebSocket is not connected (retry in a few seconds)"));
      }, timeoutMs);
      this.waiters.push({ resolve: () => resolve(), reject, timer });
    });
  }

  private raw(type: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Home Assistant WebSocket is not connected"));
    }
    const id = this.nextId++;
    log.debug(`WS command ${type} (id ${id})`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`command ${type} did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, type, ...payload }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private onMessage(rawStr: string): void {
    let msg: any;
    try {
      msg = JSON.parse(rawStr);
    } catch {
      return;
    }
    log.trace(`WS frame received: type=${msg.type ?? "?"} id=${msg.id ?? "-"} (${rawStr.length} bytes)`);
    switch (msg.type) {
      case "auth_required":
        this.ws?.send(JSON.stringify({ type: "auth", access_token: this.token() }));
        break;
      case "auth_ok":
        this.authed = true;
        this.disconnectedAt = null;
        this.backoff = RECONNECT_MIN_MS;
        this.authInvalidCount = 0;
        if (this.authTimer) {
          clearTimeout(this.authTimer);
          this.authTimer = null;
        }
        log.info(`Authenticated with Home Assistant ${msg.ha_version ?? ""}`.trim());
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer);
          w.resolve();
        }
        for (const cb of this.connectListeners) {
          try {
            cb();
          } catch {
            // a listener failure must not break the auth flow
          }
        }
        this.startPing();
        break;
      case "auth_invalid":
        this.authInvalidCount += 1;
        log.error(
          `Home Assistant refused the authentication (${this.authInvalidCount}x): ${msg.message ?? "unknown reason"}`
        );
        // The close that follows schedules the retry; after a few refusals
        // the token is clearly wrong and fast retries only spam HA.
        break;
      default: {
        if (typeof msg.id !== "number") return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        if (msg.type === "result") {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.success) p.resolve(msg.result);
          else {
            log.debug(`WS command id ${msg.id} failed: ${msg.error?.message ?? "unknown error"}`);
            p.reject(new Error(msg.error?.message ?? "Home Assistant error"));
          }
        } else if (msg.type === "pong") {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(null);
        }
        // Subscription events will arrive in a later version, ignored for now.
      }
    }
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.authed || !this.ws) return;
      this.raw("ping", {}, 5_000).catch(() => {
        log.warning("No answer to ping, terminating the socket to force a reconnection");
        this.ws?.terminate();
      });
    }, PING_INTERVAL_MS);
  }

  private scheduleReconnect(why: string): void {
    if (this.closing || this.reconnectTimer) return;
    let delay = this.backoff;
    if (this.authInvalidCount >= AUTH_INVALID_THRESHOLD) {
      delay = AUTH_INVALID_BACKOFF_MS;
      log.error(
        `Authentication refused ${this.authInvalidCount} times: the token is likely invalid, next attempt in ${Math.round(delay / 1000)} s`
      );
    } else {
      log.warning(`Home Assistant WebSocket down (${why}), reconnecting in ${delay} ms`);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
  }

  private onClose(ws: WebSocket, why: string): void {
    // A late close from a socket we already replaced must not tear down the
    // fresh connection (e.g. a ping terminate racing with a reconnect).
    if (this.ws !== ws) return;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    this.authed = false;
    if (this.disconnectedAt === null) this.disconnectedAt = Date.now();
    this.ws = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Home Assistant WebSocket connection was lost during the command"));
    }
    this.pending.clear();
    // Waiters must fail fast rather than sit out their 10 s timeout on a
    // connection we know is gone.
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error("Home Assistant WebSocket connection was lost"));
    }
    if (this.closing) return;
    this.scheduleReconnect(why);
  }
}
