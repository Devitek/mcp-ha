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
 * Client WebSocket Home Assistant : handshake d'auth, corrélation des
 * réponses par id croissant, timeouts, keep-alive et reconnexion avec
 * backoff exponentiel. Les commandes émises avant auth_ok patientent.
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
    throw new Error("Aucune cible Home Assistant : ni SUPERVISOR_TOKEN ni HA_URL");
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
    log.info(`Connexion WebSocket à ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("message", (raw) => this.onMessage(raw.toString()));
    ws.on("close", () => this.onClose("connexion fermée"));
    ws.on("error", (err) => {
      log.warn(`Erreur WebSocket : ${err.message}`);
      // close suivra et déclenchera la reconnexion
    });
  }

  shutdown(): void {
    this.closing = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  /** Envoie une commande et attend son result. */
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
        reject(new Error("WebSocket HA non connecté (réessayez dans quelques secondes)"));
      }, timeoutMs);
      this.waiters.push({ resolve: () => resolve(), reject, timer });
    });
  }

  private raw(type: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket HA non connecté"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`la commande ${type} n'a pas répondu en ${timeoutMs} ms`));
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
    switch (msg.type) {
      case "auth_required":
        this.ws?.send(JSON.stringify({ type: "auth", access_token: this.token() }));
        break;
      case "auth_ok":
        this.authed = true;
        this.backoff = RECONNECT_MIN_MS;
        log.info(`Authentifié auprès de Home Assistant ${msg.ha_version ?? ""}`.trim());
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer);
          w.resolve();
        }
        this.startPing();
        break;
      case "auth_invalid":
        // Jeton Supervisor refusé : cas anormal, on loggue et la fermeture
        // qui suit déclenchera des retries espacés.
        log.error(`Authentification HA refusée : ${msg.message ?? "raison inconnue"}`);
        break;
      default: {
        if (typeof msg.id !== "number") return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        if (msg.type === "result") {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.success) p.resolve(msg.result);
          else p.reject(new Error(msg.error?.message ?? "erreur Home Assistant"));
        } else if (msg.type === "pong") {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(null);
        }
        // Les événements (subscribe) arriveront en v0.2, ignorés pour l'instant.
      }
    }
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.authed || !this.ws) return;
      this.raw("ping", {}, 5_000).catch(() => {
        log.warn("Pas de réponse au ping, fermeture du socket pour forcer la reconnexion");
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
      p.reject(new Error("connexion WebSocket HA perdue pendant la commande"));
    }
    this.pending.clear();
    if (this.closing) return;
    log.warn(`WebSocket HA fermé (${why}), reconnexion dans ${this.backoff} ms`);
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
  }
}
