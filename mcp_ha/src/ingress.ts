import type { IncomingMessage, ServerResponse } from "node:http";
import { VERSION } from "./config.js";
import type { ToolContext } from "./context.js";

/** Ingress listens here inside the container; never published on the LAN. */
export const INGRESS_PORT = 9584;

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

const esc = (v: unknown): string =>
  String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Status page served through Home Assistant ingress (v0.3, #79). The
 * Supervisor authenticates the HA session, so no token is required here,
 * and NOTHING sensitive is displayed. Links and assets are relative so the
 * ingress path rewriting works untouched.
 */
export function createIngressHandler(
  ctx: ToolContext,
  startedAt: number = Date.now()
): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    const { cfg, ws } = ctx;
    const downFor = ws.disconnectedForMs();
    const wsBadge = ws.connected
      ? '<span class="ok">connected</span>'
      : `<span class="ko">down${downFor !== null ? ` for ${fmtUptime(downFor)}` : ""}</span>`;
    const toolCount = cfg.allowWrite ? 19 : 15;
    const rows: Array<[string, string]> = [
      ["Version", esc(VERSION)],
      ["Uptime", fmtUptime(Date.now() - startedAt)],
      ["Home Assistant WebSocket", wsBadge],
      ["MCP tools", `${toolCount} (${cfg.allowWrite ? "15 read + 4 write" : "read only"})`],
      ["MCP resources / prompts", "3 / 2"],
      ["allow_write", cfg.allowWrite ? '<span class="warn">enabled</span>' : "disabled"],
      ["filter_reads", cfg.filterReads ? "enabled" : "disabled"],
      ["Confirmation domains", esc(cfg.confirmDomains.join(", ") || "none")],
      ["Entity allowlist / denylist", `${cfg.entityAllowlist.length} / ${cfg.entityDenylist.length} patterns`],
    ];
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>MCP Home Assistant</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:38rem;padding:0 1rem;color:#1c1c1e}
  h1{font-size:1.2rem} table{border-collapse:collapse;width:100%}
  td{padding:.4rem .6rem;border-bottom:1px solid #e5e5ea} td:first-child{color:#6e6e73}
  .ok{color:#1a7f37;font-weight:600}.ko{color:#b91c1c;font-weight:600}.warn{color:#b45309;font-weight:600}
  p{color:#6e6e73;font-size:.85rem}
  @media (prefers-color-scheme: dark){body{background:#111;color:#eee}td{border-color:#333}td:first-child{color:#999}p{color:#999}}
</style></head><body>
<h1>MCP Home Assistant</h1>
<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>
<p>MCP endpoint: <code>http://&lt;HA_IP&gt;:9583/mcp</code> (bearer token in the add-on Configuration tab).
This page refreshes every 10 seconds and never shows secrets.</p>
</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  };
}
