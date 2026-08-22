import { log } from "../logger.js";
import type { AddonConfig } from "../config.js";

/** Per-request budget: a hung Supervisor must not hang the MCP client. */
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_BASE_DELAY_MS = 1_000;
/** Status codes worth one retry on idempotent requests. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The two HTTP leftovers of the WebSocket-first design:
 * - the Supervisor API (add-ons, self options), which has no WebSocket
 *   equivalent;
 * - a few core REST endpoints (automation config, template, error_log)
 *   without a simple WebSocket counterpart.
 *
 * Every request carries a hard timeout. GET requests get one retry with
 * backoff on 429/5xx and network errors; POST requests are never retried
 * automatically (no double effects).
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

  private async attempt(url: string, token: string, init: RequestInit, asText: boolean): Promise<any> {
    log.debug(`HTTP ${init.method ?? "GET"} ${url}`);
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`HTTP ${res.status}: ${body.slice(0, 300) || res.statusText}`);
      (err as any).status = res.status;
      (err as any).retryAfterMs = Number(res.headers.get("retry-after")) * 1000 || null;
      throw err;
    }
    return asText ? res.text() : res.json();
  }

  private async request(url: string, token: string, init: RequestInit, asText: boolean): Promise<any> {
    const idempotent = (init.method ?? "GET") === "GET";
    try {
      return await this.attempt(url, token, init, asText);
    } catch (e: any) {
      const status: number | undefined = e?.status;
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      const network = status === undefined;
      const retryable = idempotent && (timedOut || network || RETRYABLE_STATUS.has(status ?? 0));
      if (!retryable) {
        if (timedOut) throw new Error(`Home Assistant did not answer within ${REQUEST_TIMEOUT_MS} ms`);
        throw e;
      }
      const delay = Math.min(e?.retryAfterMs ?? RETRY_BASE_DELAY_MS, 5_000);
      log.debug(`HTTP retry in ${delay} ms after ${timedOut ? "timeout" : `error ${status ?? e?.message}`}`);
      await sleep(delay);
      try {
        return await this.attempt(url, token, init, asText);
      } catch (e2: any) {
        if (e2?.name === "TimeoutError" || e2?.name === "AbortError") {
          throw new Error(`Home Assistant did not answer within ${REQUEST_TIMEOUT_MS} ms (after retry)`);
        }
        throw e2;
      }
    }
  }

  coreGet(path: string): Promise<any> {
    return this.request(this.coreBase() + path, this.coreToken(), { method: "GET" }, false);
  }

  /**
   * Binary GET (camera snapshots, #86): returns the raw bytes and content
   * type. Same timeout and one-retry policy as the other GETs; enforces a
   * byte cap so a huge image cannot blow the client context.
   */
  async coreGetBinary(path: string, maxBytes: number): Promise<{ buffer: Buffer; contentType: string }> {
    const attempt = async (): Promise<{ buffer: Buffer; contentType: string }> => {
      const res = await fetch(this.coreBase() + path, {
        method: "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${this.coreToken()}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new Error(`HTTP ${res.status}: ${body.slice(0, 200) || res.statusText}`);
        (err as any).status = res.status;
        throw err;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        throw new Error(`image too large (${Math.round(buffer.byteLength / 1024)} KB, cap ${Math.round(maxBytes / 1024)} KB)`);
      }
      return { buffer, contentType: res.headers.get("content-type") ?? "image/jpeg" };
    };
    log.debug(`HTTP GET (binary) ${this.coreBase() + path}`);
    try {
      return await attempt();
    } catch (e: any) {
      const status: number | undefined = e?.status;
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      if (!(timedOut || status === undefined || RETRYABLE_STATUS.has(status ?? 0))) throw e;
      await sleep(RETRY_BASE_DELAY_MS);
      return attempt();
    }
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

  /** JSON POST to the core API (config writes, #94 tier 3). Never retried. */
  corePost(path: string, body: unknown): Promise<any> {
    return this.request(
      this.coreBase() + path,
      this.coreToken(),
      { method: "POST", body: JSON.stringify(body) },
      false
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
