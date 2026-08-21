import type { IncomingMessage, ServerResponse } from "node:http";
import { VERSION } from "./config.js";
import { maskSecret } from "./safety.js";
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

/** HTML-escapes text and attribute values (quotes included). */
const esc = (v: unknown): string =>
  String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Best-effort LAN hostname of the HA instance, taken from the host the user
 * is browsing the HA UI through (#92). The Supervisor proxies ingress, so
 * its internal addresses are rejected in favour of a placeholder.
 */
function detectHaHost(req: IncomingMessage): string {
  const raw = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").trim();
  const hostname = raw.replace(/:\d+$/, "");
  if (!hostname || hostname === "localhost" || hostname === "127.0.0.1" || hostname.startsWith("172.30.32.")) {
    return "HA_IP";
  }
  return hostname;
}

/**
 * Status and onboarding page served through Home Assistant ingress (v0.3
 * #79, onboarding #92). The Supervisor authenticates the HA session, which
 * is the same trust level as the add-on Configuration tab where the token
 * already sits: the page may therefore carry ready-to-copy client configs
 * with the real token. It is masked by default and revealed on explicit
 * action; the Supervisor token never appears. Links and assets stay
 * relative so the ingress path rewriting works untouched.
 */
export function createIngressHandler(
  ctx: ToolContext,
  startedAt: number = Date.now()
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const { cfg, ws } = ctx;
    const downFor = ws.disconnectedForMs();
    const wsBadge = ws.connected
      ? '<span class="ok">connected</span>'
      : `<span class="ko">down${downFor !== null ? ` for ${fmtUptime(downFor)}` : ""}</span>`;
    // 15 core read tools + 2 calendar/todo, plus camera and the write tools
    // depending on the options.
    const readTools = 17 + (cfg.allowCamera ? 1 : 0);
    const writeTools = cfg.allowWrite ? 4 : 0;
    const toolBreakdown = `${readTools + writeTools} (${readTools} read${writeTools ? ` + ${writeTools} write` : ""})`;
    const rows: Array<[string, string]> = [
      ["Version", esc(VERSION)],
      ["Uptime", fmtUptime(Date.now() - startedAt)],
      ["Home Assistant WebSocket", wsBadge],
      ["MCP tools", toolBreakdown],
      ["MCP resources / prompts", "3 / 2"],
      ["allow_write", cfg.allowWrite ? '<span class="warn">enabled</span>' : "disabled"],
      ["filter_reads", cfg.filterReads ? "enabled" : "disabled"],
      ["Confirmation domains", esc(cfg.confirmDomains.join(", ") || "none")],
      ["Entity allowlist / denylist", `${cfg.entityAllowlist.length} / ${cfg.entityDenylist.length} patterns`],
    ];

    // Onboarding blocks (#92): same shapes as the Clients guide, with the
    // detected URL baked in and the token as a placeholder that the page
    // script substitutes (masked on screen, full value on copy).
    const mcpUrl = `http://${detectHaHost(req)}:9583/mcp`;
    const blocks: Array<{ id: string; title: string; note: string; tpl: string }> = [
      {
        id: "claude-code",
        title: "Claude Code (CLI)",
        note: "Run in a terminal:",
        tpl: `claude mcp add --transport http home-assistant \\\n  ${mcpUrl} \\\n  --header "Authorization: Bearer ___TOKEN___"`,
      },
      {
        id: "claude-desktop",
        title: "Claude Desktop",
        note: "In claude_desktop_config.json (restart Claude Desktop afterwards):",
        tpl: `{\n  "mcpServers": {\n    "home-assistant": {\n      "command": "npx",\n      "args": ["-y", "mcp-remote", "${mcpUrl}",\n               "--header", "Authorization: Bearer ___TOKEN___"]\n    }\n  }\n}`,
      },
      {
        id: "gemini-cli",
        title: "Gemini CLI",
        note: "In ~/.gemini/settings.json:",
        tpl: `{\n  "mcpServers": {\n    "home-assistant": {\n      "httpUrl": "${mcpUrl}",\n      "headers": { "Authorization": "Bearer ___TOKEN___" }\n    }\n  }\n}`,
      },
    ];
    const blockHtml = blocks
      .map(
        (b) => `<h3>${esc(b.title)}</h3>
<p class="note">${esc(b.note)}</p>
<div class="blk"><pre id="${b.id}" data-tpl="${esc(b.tpl)}"></pre>
<button class="copy" data-for="${b.id}">Copy</button></div>`
      )
      .join("\n");

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>MCP Home Assistant</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:38rem;padding:0 1rem;color:#1c1c1e}
  h1{font-size:1.2rem} h2{font-size:1.05rem;margin-top:2rem} h3{font-size:.95rem;margin:1.2rem 0 .2rem}
  table{border-collapse:collapse;width:100%}
  td{padding:.4rem .6rem;border-bottom:1px solid #e5e5ea} td:first-child{color:#6e6e73}
  .ok{color:#1a7f37;font-weight:600}.ko{color:#b91c1c;font-weight:600}.warn{color:#b45309;font-weight:600}
  p{color:#6e6e73;font-size:.85rem} .note{margin:.2rem 0}
  .blk{position:relative}
  pre{background:#f2f2f7;border:1px solid #e5e5ea;border-radius:6px;padding:.7rem .8rem;overflow-x:auto;font-size:.8rem;margin:.3rem 0}
  button{font:inherit;font-size:.8rem;padding:.25rem .7rem;border:1px solid #c7c7cc;border-radius:6px;background:#fff;cursor:pointer}
  button:hover{background:#f2f2f7}
  .copy{position:absolute;top:.6rem;right:.5rem}
  @media (prefers-color-scheme: dark){
    body{background:#111;color:#eee}td{border-color:#333}td:first-child{color:#999}p{color:#999}
    pre{background:#1c1c1e;border-color:#333}button{background:#1c1c1e;border-color:#444;color:#eee}button:hover{background:#2c2c2e}
  }
</style></head><body>
<h1>MCP Home Assistant</h1>
<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>
<h2>Connect a client</h2>
<p>MCP endpoint: <code>${esc(mcpUrl)}</code>. The snippets below embed your API token,
masked on screen; <b>Copy</b> always copies the full working version.
<button id="reveal"></button></p>
${blockHtml}
<p>This page is only reachable through your authenticated Home Assistant session,
like the Configuration tab where the token already lives. It refreshes every minute.</p>
<script>
(function () {
  var TOKEN = ${JSON.stringify(cfg.apiToken)};
  var MASK = ${JSON.stringify(maskSecret(cfg.apiToken))};
  var shown = sessionStorage.getItem("mcpha-show-token") === "1";
  function render() {
    document.querySelectorAll("pre[data-tpl]").forEach(function (p) {
      p.textContent = p.getAttribute("data-tpl").split("___TOKEN___").join(shown ? TOKEN : MASK);
    });
    document.getElementById("reveal").textContent = shown ? "Hide token" : "Reveal token";
  }
  document.getElementById("reveal").addEventListener("click", function () {
    shown = !shown;
    sessionStorage.setItem("mcpha-show-token", shown ? "1" : "0");
    render();
  });
  document.querySelectorAll("button.copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var tpl = document.getElementById(btn.getAttribute("data-for")).getAttribute("data-tpl");
      navigator.clipboard.writeText(tpl.split("___TOKEN___").join(TOKEN)).then(function () {
        btn.textContent = "Copied!";
        setTimeout(function () { btn.textContent = "Copy"; }, 1200);
      });
    });
  });
  render();
})();
</script>
</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  };
}
