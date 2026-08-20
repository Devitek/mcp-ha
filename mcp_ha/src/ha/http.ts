import { log } from "../logger.js";
import type { AddonConfig } from "../config.js";

/**
 * The two HTTP leftovers of the WebSocket-first design:
 * - the Supervisor API (add-ons, self options), which has no WebSocket
 *   equivalent;
 * - a few core REST endpoints (automation config, template, error_log)
 *   without a simple WebSocket counterpart.
 */
export class HaHttp {
  constructor(private cfg: AddonConfig) {}

  get supervisorAvailable(): boolean {
    return this.cfg.supervisorToken !== null;
  }

  private coreBase(): string {
    if (this.cfg.supervisorToken) return "http://supervisor/core/api";
    if (this.cfg.devHaUrl) return this.cfg.devHaUrl.replace(/\/+$/, "") + "/api";
    throw new Error("No Home Assistant target: neither SUPERVISOR_TOKEN nor HA_URL is set");
  }

  private coreToken(): string {
    return this.cfg.supervisorToken ?? this.cfg.devHaToken ?? "";
  }

  private async request(url: string, token: string, init: RequestInit, asText: boolean): Promise<any> {
    log.debug(`HTTP ${init.method ?? "GET"} ${url}`);
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
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300) || res.statusText}`);
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

  private requireSupervisor(): string {
    if (!this.cfg.supervisorToken) {
      throw new Error("Supervisor API is not available outside the add-on environment (dev mode)");
    }
    return this.cfg.supervisorToken;
  }

  /** GET on the Supervisor API. Answers are { result, data }, data is returned. */
  async supervisorGet(path: string): Promise<any> {
    const token = this.requireSupervisor();
    const json = await this.request("http://supervisor" + path, token, { method: "GET" }, false);
    return json?.data ?? json;
  }

  /** POST on the Supervisor API (used to write the add-on options back). */
  async supervisorPost(path: string, body: unknown): Promise<any> {
    const token = this.requireSupervisor();
    const json = await this.request(
      "http://supervisor" + path,
      token,
      { method: "POST", body: JSON.stringify(body) },
      false
    );
    return json?.data ?? json;
  }
}
