import type { AddonConfig } from "../config.js";

/**
 * Les deux restes HTTP du design WebSocket-first :
 * - l'API Supervisor (add-ons), qui n'a pas d'équivalent WebSocket ;
 * - quelques endpoints REST du core (config des automations, template,
 *   error_log) sans équivalent WebSocket simple.
 */
export class HaHttp {
  constructor(private cfg: AddonConfig) {}

  get supervisorAvailable(): boolean {
    return this.cfg.supervisorToken !== null;
  }

  private coreBase(): string {
    if (this.cfg.supervisorToken) return "http://supervisor/core/api";
    if (this.cfg.devHaUrl) return this.cfg.devHaUrl.replace(/\/+$/, "") + "/api";
    throw new Error("Aucune cible Home Assistant : ni SUPERVISOR_TOKEN ni HA_URL");
  }

  private coreToken(): string {
    return this.cfg.supervisorToken ?? this.cfg.devHaToken ?? "";
  }

  private async request(url: string, token: string, init: RequestInit, asText: boolean): Promise<any> {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} : ${body.slice(0, 300) || res.statusText}`);
    }
    return asText ? res.text() : res.json();
  }

  coreGet(path: string): Promise<any> {
    return this.request(this.coreBase() + path, this.coreToken(), { method: "GET" }, false);
  }

  coreGetText(path: string): Promise<string> {
    return this.request(this.coreBase() + path, this.coreToken(), { method: "GET" }, true);
  }

  corePostText(path: string, body: unknown): Promise<string> {
    return this.request(
      this.coreBase() + path,
      this.coreToken(),
      { method: "POST", body: JSON.stringify(body) },
      true
    );
  }

  /** GET sur l'API Supervisor. Répond { result, data }, on renvoie data. */
  async supervisorGet(path: string): Promise<any> {
    if (!this.cfg.supervisorToken) {
      throw new Error("API Supervisor indisponible hors environnement add-on (mode dev)");
    }
    const json = await this.request(
      "http://supervisor" + path,
      this.cfg.supervisorToken,
      { method: "GET" },
      false
    );
    return json?.data ?? json;
  }
}
