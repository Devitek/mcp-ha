import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { safe } from "../helpers.js";
import { VERSION } from "../../config.js";

/** Each probe gets this long; a diagnostic must never hang. */
const PROBE_TIMEOUT_MS = 3_000;
const WS_SLOW_MS = 1_000;
const REST_SLOW_MS = 2_000;

async function probe(fn: () => Promise<unknown>): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout after ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS);
        (t as { unref?: () => void }).unref?.();
      }),
    ]);
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Self test (#144): ha_get_health looks at the house, this looks at the
 * add-on. No data from the home in the answer, by design: the output is
 * safe to paste into a GitHub issue when asking for support.
 */
export function registerSelfTestTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "ha_get_self_test",
    {
      title: "Add-on self test",
      description:
        "Diagnoses the add-on itself: WebSocket and REST connectivity with latencies, live state map " +
        "status, Supervisor availability, and an overall verdict. Contains no data from your home; " +
        "safe to paste into a support issue.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_self_test", async () => {
      const wsConnected = ctx.ws.connected;
      const ws = wsConnected ? await probe(() => ctx.ws.send("get_config")) : { ok: false, latency_ms: 0, error: "not connected" };
      const rest = await probe(() => ctx.http.coreGet("/config"));
      const liveActive = ctx.catalog.liveActive;
      const supervisor = ctx.http.supervisorAvailable;

      let verdict: "ok" | "degraded" | "broken";
      let reason: string;
      if (!wsConnected || !ws.ok || !rest.ok) {
        verdict = "broken";
        reason = !wsConnected
          ? "the WebSocket to Home Assistant is down"
          : !ws.ok
            ? `the WebSocket does not answer (${ws.error ?? "unknown"})`
            : `the REST API does not answer (${rest.error ?? "unknown"})`;
      } else if (!liveActive) {
        verdict = "degraded";
        reason = "the live state map is inactive, states are served through the short-TTL fallback";
      } else if (ws.latency_ms > WS_SLOW_MS || rest.latency_ms > REST_SLOW_MS) {
        verdict = "degraded";
        reason = `slow answers (ws ${ws.latency_ms} ms, rest ${rest.latency_ms} ms)`;
      } else {
        verdict = "ok";
        reason = "everything answers within normal bounds";
      }

      return {
        verdict,
        reason,
        version: VERSION,
        uptime_seconds: Math.round(process.uptime()),
        websocket: { connected: wsConnected, ...(wsConnected ? { latency_ms: ws.latency_ms } : {}), ...(ws.error ? { error: ws.error } : {}) },
        rest: { ok: rest.ok, latency_ms: rest.latency_ms, ...(rest.error ? { error: rest.error } : {}) },
        live_state_map: liveActive ? "active" : "ttl-fallback",
        supervisor: supervisor ? "available" : "unavailable (dev mode, HA_URL)",
        note: "Infrastructure diagnostic only, no data from your home: safe to paste into a GitHub issue.",
      };
    })
  );
}
