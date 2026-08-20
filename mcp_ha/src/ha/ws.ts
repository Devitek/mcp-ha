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
const PING_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Home Assistant WebSocket client: auth handshake, response correlation by
 * monotonically increasing id, per-command timeouts, keep-alive and
 * reconnection with exponential backoff. Commands issued before auth_ok wait
 * in line.
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

  constructor(private cfg: AddonConfig) {}

  get connected(): boolean {
    return this.authed;
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
      log.error(String(e instanceof Error ? e.message : e));
      return;
    }
    log.info(`Connecting to Home Assistant WebSocket at ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("message", (raw) => this.onMessage(raw.toString()));
    ws.on("close", () => this.onClose("connection closed"));
    ws.on("error", (err) => {
      log.warning(`WebSocket error: ${err.message}`);
      // close follows and triggers the reconnection
    });
  }

  shutdown(): void {
    this.closing = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
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
      ws.send(JSON.stringify({ id, type, ...payload }));
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
        this.backoff = RECONNECT_MIN_MS;
        log.info(`Authenticated with Home Assistant ${msg.ha_version ?? ""}`.trim());
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer);
          w.resolve();
        }
        this.startPing();
        break;
      case "auth_invalid":
        // Refused Supervisor token: abnormal. The close that follows will
        // schedule spaced retries.
        log.error(`Home Assistant refused the authentication: ${msg.message ?? "unknown reason"}`);
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

  private onClose(why: string): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.authed = false;
    this.ws = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Home Assistant WebSocket connection was lost during the command"));
    }
    this.pending.clear();
    if (this.closing) return;
    log.warning(`Home Assistant WebSocket closed (${why}), reconnecting in ${this.backoff} ms`);
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
  }
}
