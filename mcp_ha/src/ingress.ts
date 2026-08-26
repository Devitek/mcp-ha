import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { effectiveTokens, VERSION } from "./config.js";
import type { AddonConfig } from "./config.js";
import { maskSecret } from "./safety.js";
import { audit } from "./logger.js";
import {
  capGrants,
  CATEGORIES,
  grantsFromConfig,
  LEVELS,
  TOOL_REGISTRY,
  toolCounts,
  type Category,
  type Grants,
  type Level,
} from "./mcp/registry.js";
import type { TokenStore } from "./db/store.js";
import type { ToolContext } from "./context.js";
import type { UsageTracker } from "./usage.js";

/** Ingress listens here inside the container; never published on the LAN. */
export const INGRESS_PORT = 9584;

/** How many audit lines the page shows; SSH remains the full-history path. */
const AUDIT_DISPLAY_LINES = 50;

export interface IngressOptions {
  /** Usage counters shared with the MCP handler (#128). */
  usage?: UsageTracker;
  /** Audit file location, injectable for tests (#126). */
  auditPath?: string;
  /** Add-on icon location, injectable for tests (#136 follow-up). */
  iconPath?: string;
  /** Fine-grained token store (#167): enables the Tokens management tab. */
  store?: TokenStore;
}

/**
 * Anti-CSRF token (#167), double-submit style: random per process, embedded
 * in every form and required on every POST. An external page cannot read
 * this page (same-origin), so it cannot know the value; a restart rotates
 * it, which at worst turns a stale form into a "reload and retry" error.
 */
const CSRF_TOKEN = randomBytes(16).toString("hex");

/** Levels that actually exist for a category, "none" always included. */
function categoryLevels(cat: Category): Level[] {
  const present = new Set(
    Object.values(TOOL_REGISTRY)
      .filter((e) => e.category === cat)
      .map((e) => e.level as Level)
  );
  return LEVELS.filter((l) => l === "none" || present.has(l));
}

/** Compact one-line human summary of a grants object. */
function grantsSummary(g: Grants): string {
  const parts: string[] = [];
  let reads = 0;
  for (const c of CATEGORIES) {
    const l = g[c] ?? "none";
    if (l === "none") continue;
    if (l === "read") reads += 1;
    else parts.push(`${c}: ${l}`);
  }
  if (reads > 0) parts.push(`${reads} read`);
  return parts.join(" · ") || "nothing";
}

/** Option gates currently limiting these grants ("capped by …"). */
function cappedGates(g: Grants, cfg: AddonConfig): string[] {
  const eff = capGrants(g, cfg);
  const gates = new Set<string>();
  for (const c of CATEGORIES) {
    const asked = LEVELS.indexOf(g[c] ?? "none");
    const got = LEVELS.indexOf(eff[c]);
    if (got >= asked) continue;
    if (c === "camera") gates.add("allow_camera");
    if ((g[c] === "write" || g[c] === "manage") && got < LEVELS.indexOf("write")) gates.add("allow_write");
    if (g[c] === "manage") gates.add("allow_config_write");
  }
  return [...gates].sort();
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 32_768) throw new Error("form too large");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

interface Flash {
  kind: "created" | "revoked" | "error";
  text: string;
  /** The one-time clear secret, present on creation only. */
  secret?: string;
}

/** Handles the Tokens tab POSTs; always answers with a re-rendered page. */
async function handleTokenPost(req: IncomingMessage, store: TokenStore, cfg: AddonConfig): Promise<Flash> {
  let form: URLSearchParams;
  try {
    form = await readForm(req);
  } catch (e) {
    return { kind: "error", text: e instanceof Error ? e.message : String(e) };
  }
  if (form.get("csrf") !== CSRF_TOKEN) {
    return { kind: "error", text: "Stale form (the add-on restarted since this page loaded): reload and retry." };
  }
  const action = form.get("mcpha_action");
  if (action === "revoke") {
    const id = form.get("id") ?? "";
    const record = (await store.list()).find((r) => r.id === id);
    if (!record || !(await store.revoke(id))) return { kind: "error", text: "Unknown token id." };
    audit({ event: "token_revoked", client: record.name });
    return { kind: "revoked", text: `Token "${record.name}" revoked; requests with it now get a 401.` };
  }
  if (action === "create") {
    const grants: Partial<Grants> = {};
    for (const c of CATEGORIES) {
      const l = form.get(`grant_${c}`);
      if (l && l !== "none") grants[c] = l as Level;
    }
    // The ceiling is enforced at creation too (#167): the matrix greys these
    // out, but the browser is not the boundary.
    const over = cappedGates(grants as Grants, cfg);
    if (over.length > 0) return { kind: "error", text: `These grants exceed the current option gates (${over.join(", ")} off): open the gates first or ask for less.` };
    const parseList = (field: string): string[] =>
      (form.get(field) ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    const expires = form.get("expires") ?? "never";
    const days = expires === "30d" ? 30 : expires === "90d" ? 90 : expires === "365d" ? 365 : null;
    try {
      const created = await store.create({
        name: form.get("name") ?? "",
        grants,
        entityAllowlist: parseList("entity_allowlist"),
        entityDenylist: parseList("entity_denylist"),
        expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : undefined,
      });
      audit({ event: "token_created", client: created.record.name });
      return {
        kind: "created",
        text: `Token "${created.record.name}" created. Copy it NOW: it is stored hashed and will never be shown again.`,
        secret: created.token,
      };
    } catch (e) {
      return { kind: "error", text: e instanceof Error ? e.message : String(e) };
    }
  }
  return { kind: "error", text: "Unknown action." };
}

/**
 * The add-on icon, inlined as a data URI (3.4 KB PNG): keeps the page a
 * single response with no extra route and no network dependency. Cached per
 * path; null when unreadable, the header then falls back to the >_ mark.
 */
const iconCache = new Map<string, string | null>();
async function loadIcon(path: string): Promise<string | null> {
  const cached = iconCache.get(path);
  if (cached !== undefined) return cached;
  let uri: string | null = null;
  try {
    uri = `data:image/png;base64,${(await readFile(path)).toString("base64")}`;
  } catch {
    uri = null;
  }
  iconCache.set(path, uri);
  return uri;
}

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
 * Last audit lines for the page (#126). The #91 contract is untouched: no
 * MCP tool reads or clears the audit; this renders it to the HUMAN behind
 * the HA session, the same trust boundary as the Configuration tab.
 */
async function readAuditTail(path: string): Promise<Array<Record<string, unknown>> | null> {
  try {
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    return lines
      .slice(-AUDIT_DISPLAY_LINES)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((x): x is Record<string, unknown> => x !== null)
      .reverse();
  } catch {
    return null; // dev mode or nothing written yet
  }
}

// --- small design system lifted from the mockup (#136): everything is
// inline styles over CSS variables; only the interactive states (tabs,
// filter pills, client sub-tabs) use classes so vanilla JS can toggle them.
const MONO = "font-family:'IBM Plex Mono',ui-monospace,monospace";
const CARD = "background:var(--card);border:1px solid var(--border);border-radius:8px";
const STAT_LABEL = "font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:600";
const STAT_VALUE = `font-size:26px;font-weight:700;margin-top:4px;${MONO}`;
const STAT_SUB = "font-size:12px;color:var(--muted);margin-top:2px";
const PILL_ON = "font-size:11px;font-weight:700;color:var(--warn);background:var(--warn-bg);border:1px solid var(--warn-border);border-radius:12px;padding:2px 10px";
const PILL_OFF = "font-size:11px;font-weight:600;color:var(--muted);background:var(--border);border-radius:12px;padding:2px 10px";

function statCard(label: string, value: string, sub: string): string {
  return `<div style="${CARD};padding:14px 16px"><div style="${STAT_LABEL}">${label}</div><div style="${STAT_VALUE}">${value}</div><div style="${STAT_SUB}">${sub}</div></div>`;
}

function safetyRow(name: string, value: string): string {
  return `<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:13px;color:var(--muted);${MONO}">${esc(name)}</span>${value}</div>`;
}

/**
 * Status and onboarding dashboard served through Home Assistant ingress
 * (v0.3 #79, onboarding #92, observability #126/#128, redesign #136). The
 * Supervisor authenticates the HA session, the same trust level as the
 * add-on Configuration tab: the page may carry ready-to-copy client
 * configs with the real primary token, masked by default and revealed on
 * explicit action. Named tokens are only ever rendered masked; the
 * Supervisor token never appears. Everything is one server-rendered
 * response, links relative, no framework, no network dependency.
 */
export function createIngressHandler(
  ctx: ToolContext,
  startedAt: number = Date.now(),
  opts: IngressOptions = {}
): (req: IncomingMessage, res: ServerResponse) => void {
  const auditPath = opts.auditPath ?? "/data/audit.log";
  // Relative to cwd: mcp_ha/ in dev, /app in the image (Dockerfile COPY).
  const iconPath = opts.iconPath ?? "icon.png";
  return async (req, res) => {
    const { cfg, ws } = ctx;

    // Token management POSTs (#167): routed by a form field rather than the
    // path, because ingress serves under an arbitrary Supervisor prefix.
    // The answer is the re-rendered page; the meta refresh then reloads it
    // as a GET, which naturally retires the one-time secret banner.
    let flash: Flash | null = null;
    if (req.method === "POST") {
      if (!opts.store) {
        res.writeHead(405, { Allow: "GET" });
        res.end();
        return;
      }
      flash = await handleTokenPost(req, opts.store, cfg);
    }
    const downFor = ws.disconnectedForMs();
    const wsBadge = ws.connected
      ? `<div style="display:flex;align-items:center;gap:7px;background:var(--ok-bg);border:1px solid var(--ok-border);border-radius:20px;padding:5px 12px"><span style="width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 6px var(--ok-glow)"></span><span style="font-size:12px;font-weight:600;color:var(--ok)">WebSocket connected</span></div>`
      : `<div style="display:flex;align-items:center;gap:7px;background:var(--warn-bg);border:1px solid var(--warn-border);border-radius:20px;padding:5px 12px"><span style="width:8px;height:8px;border-radius:50%;background:var(--err)"></span><span style="font-size:12px;font-weight:600;color:var(--err)">WebSocket down${downFor !== null ? ` for ${esc(fmtUptime(downFor))}` : ""}</span></div>`;

    // Tool counts derived from the central registry (#165): the page shows
    // exactly what buildServer would register for a full-scope token.
    const { read: readTools, write: writeTools } = toolCounts(grantsFromConfig(cfg, true));

    const snap = opts.usage?.snapshot();
    const audit = await readAuditTail(auditPath);
    const icon = await loadIcon(iconPath);
    const logoHtml = icon
      ? `<img src="${icon}" alt="" width="40" height="40" style="border-radius:9px;display:block">`
      : `<div style="width:40px;height:40px;border-radius:9px;background:#060d06;display:flex;align-items:center;justify-content:center;border:1px solid #1f2a1f"><span style="${MONO};font-size:20px;color:#33ff66;line-height:1">&gt;_</span></div>`;
    const mcpUrl = `http://${detectHaHost(req)}:9583/mcp`;

    // --- Overview -------------------------------------------------------
    const statCards = [
      statCard("MCP tools", String(readTools + writeTools), `${readTools} read${writeTools ? ` · <span style="color:var(--warn)">${writeTools} write</span>` : ""}`),
      statCard("Tool calls", String(snap?.total ?? 0), snap && snap.by_client.length > 0 ? `since start · ${snap.by_client.length} client${snap.by_client.length > 1 ? "s" : ""}` : "since start"),
      statCard("Resources / prompts", "3 / 6", "MCP capabilities"),
      statCard("Write audit", String(audit?.length ?? 0), "entries · /data/audit.log"),
    ].join("");

    const flag = (on: boolean): string => (on ? `<span style="${PILL_ON}">ENABLED</span>` : `<span style="${PILL_OFF}">disabled</span>`);
    const safetyCard = `<div style="${CARD};padding:16px"><div style="font-size:13px;font-weight:700;margin-bottom:12px">Safety configuration</div><div style="display:flex;flex-direction:column;gap:8px">
${safetyRow("allow_write", flag(cfg.allowWrite))}
${safetyRow("allow_config_write", flag(cfg.allowConfigWrite))}
${safetyRow("allow_camera", flag(cfg.allowCamera))}
${safetyRow("enable_sessions", flag(cfg.enableSessions))}
${safetyRow("filter_reads", flag(cfg.filterReads))}
${safetyRow("confirm_domains", `<span style="font-size:12px;${MONO};color:var(--text)">${esc(cfg.confirmDomains.join(", ") || "none")}</span>`)}
${safetyRow("allow / deny patterns", `<span style="font-size:12px;${MONO};color:var(--text)">${cfg.entityAllowlist.length} / ${cfg.entityDenylist.length}</span>`)}
</div></div>`;

    const maxCalls = snap?.top_tools[0]?.calls ?? 1;
    const topToolsRows =
      snap && snap.top_tools.length > 0
        ? snap.top_tools
            .map(
              (t) =>
                `<div style="display:flex;align-items:center;gap:10px"><span style="font-size:12px;${MONO};color:var(--text);width:170px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.tool)}</span><div style="flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden"><div style="height:100%;width:${Math.round((t.calls / maxCalls) * 100)}%;background:var(--accent);border-radius:4px"></div></div><span style="font-size:12px;${MONO};color:var(--muted);min-width:16px;text-align:right">${t.calls}</span></div>`
            )
            .join("")
        : `<div style="font-size:12px;color:var(--muted)">No tool call yet.</div>`;
    const byClientLine =
      snap && snap.by_client.length > 0
        ? `All calls: ${snap.by_client.map((c) => `<span style="${MONO};color:var(--text)">"${esc(c.client)}"</span> ${c.calls}`).join(" · ")}`
        : "Counters reset on restart; the persistent audit covers write history.";
    const topToolsCard = `<div style="${CARD};padding:16px"><div style="font-size:13px;font-weight:700;margin-bottom:12px">Top tools since start</div><div style="display:flex;flex-direction:column;gap:9px">${topToolsRows}</div><div style="font-size:12px;color:var(--muted);margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">${byClientLine}</div></div>`;

    // --- Connect a client (#92 mechanics untouched) ---------------------
    const blocks: Array<{ id: string; label: string; note: string; tpl: string }> = [
      {
        id: "claude-code",
        label: "Claude Code",
        note: "Run in a terminal:",
        tpl: `claude mcp add --transport http home-assistant \\\n  ${mcpUrl} \\\n  --header "Authorization: Bearer ___TOKEN___"`,
      },
      {
        id: "claude-desktop",
        label: "Claude Desktop",
        note: "In claude_desktop_config.json (restart Claude Desktop afterwards):",
        tpl: `{\n  "mcpServers": {\n    "home-assistant": {\n      "command": "npx",\n      "args": ["-y", "mcp-remote", "${mcpUrl}",\n               "--header", "Authorization: Bearer ___TOKEN___"]\n    }\n  }\n}`,
      },
      {
        id: "gemini-cli",
        label: "Gemini CLI",
        note: "In ~/.gemini/settings.json:",
        tpl: `{\n  "mcpServers": {\n    "home-assistant": {\n      "httpUrl": "${mcpUrl}",\n      "headers": { "Authorization": "Bearer ___TOKEN___" }\n    }\n  }\n}`,
      },
    ];
    const clientTabs = blocks
      .map((b, i) => `<button class="ctab${i === 0 ? " on" : ""}" data-client="${b.id}">${esc(b.label)}</button>`)
      .join("");
    const clientPanels = blocks
      .map(
        (b, i) => `<div class="cpanel" data-cpanel="${b.id}"${i === 0 ? "" : " hidden"}>
<div style="font-size:12px;color:var(--muted);margin-bottom:10px">${esc(b.note)}</div>
<div style="position:relative"><pre style="margin:0;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:14px 16px;${MONO};font-size:12.5px;line-height:1.6;color:var(--text);overflow-x:auto" data-tpl="${esc(b.tpl)}"></pre>
<button class="btn copy" data-for="${b.id}" style="position:absolute;top:10px;right:10px">Copy</button></div></div>`
      )
      .join("");

    // --- Tokens (#85/#167): the primary stays masked; store tokens only
    // ever exist as prefix + metadata, the secret was shown once.
    const legacyRows = effectiveTokens(cfg)
      .map(
        (t, i) =>
          `<div style="display:grid;grid-template-columns:1.2fr 2fr 1.4fr 1fr .6fr;gap:12px;padding:12px 16px;border-bottom:1px solid var(--row-border);align-items:center"><span style="font-size:13px;font-weight:600;${MONO}">${esc(t.name)}</span><span style="font-size:12.5px;${MONO};color:var(--muted)">${esc(maskSecret(t.token))}</span><span style="font-size:12px;color:var(--muted)">${i === 0 ? "full access (bootstrap and recovery)" : `legacy scope: ${esc(t.scope)}`}</span><span style="font-size:12px;color:var(--muted)">${i === 0 ? "api_token (primary)" : "api_tokens"}</span><span></span></div>`
      )
      .join("");
    const storeRecords = opts.store ? await opts.store.list() : [];
    const now = Date.now();
    const storeRows = storeRecords
      .map((r) => {
        const expired = r.expiresAt !== null && Date.parse(r.expiresAt) <= now;
        const status = r.revokedAt
          ? `<span style="font-size:11px;font-weight:700;color:var(--err)">revoked</span>`
          : expired
            ? `<span style="font-size:11px;font-weight:700;color:var(--warn)">expired</span>`
            : `<span style="font-size:11px;font-weight:700;color:var(--ok)">active</span>`;
        const capped = cappedGates(r.grants, cfg);
        const cappedNote = capped.length
          ? `<div style="font-size:11px;color:var(--warn)">capped by ${esc(capped.map((g) => `${g}: off`).join(", "))}</div>`
          : "";
        const dates = `created ${esc(r.createdAt.slice(0, 10))}${r.expiresAt ? ` · expires ${esc(r.expiresAt.slice(0, 10))}` : ""}${r.lastUsedAt ? ` · last used ${esc(r.lastUsedAt.slice(0, 10))}` : " · never used"}`;
        const revokeForm = r.revokedAt
          ? ""
          : `<form method="post" action="#tokens" style="margin:0" onsubmit="return confirm('Revoke this token? Clients using it will get a 401.')"><input type="hidden" name="csrf" value="${CSRF_TOKEN}"><input type="hidden" name="mcpha_action" value="revoke"><input type="hidden" name="id" value="${esc(r.id)}"><button class="btn" type="submit">Revoke</button></form>`;
        return `<div style="display:grid;grid-template-columns:1.2fr 2fr 1.4fr 1fr .6fr;gap:12px;padding:12px 16px;border-bottom:1px solid var(--row-border);align-items:center"><span style="font-size:13px;font-weight:600;${MONO}">${esc(r.name)}</span><div><div style="font-size:12.5px;${MONO};color:var(--muted)">${esc(r.prefix)}…</div>${cappedNote}</div><span style="font-size:12px;color:var(--muted)">${esc(grantsSummary(r.grants))}</span><span style="font-size:11px;color:var(--muted)">${dates}</span><span style="display:flex;align-items:center;gap:8px;justify-content:end">${status}${revokeForm}</span></div>`;
      })
      .join("");

    // Creation form matrix: one row per category, radios per level; a level
    // above the option gates is disabled here AND refused server-side.
    const ceiling = grantsFromConfig(cfg, true);
    const matrixRows = CATEGORIES.map((c) => {
      const available = categoryLevels(c);
      const cells = LEVELS.map((l) => {
        if (!available.includes(l)) return `<span style="color:var(--faint);text-align:center">·</span>`;
        const over = LEVELS.indexOf(l) > LEVELS.indexOf(ceiling[c]);
        return `<label style="display:flex;justify-content:center;${over ? "opacity:.35" : "cursor:pointer"}" ${over ? `title="above the current allow_* gates"` : ""}><input type="radio" name="grant_${c}" value="${l}"${l === "none" ? " checked" : ""}${over ? " disabled" : ""}></label>`;
      }).join("");
      return `<div style="display:grid;grid-template-columns:1.4fr repeat(4,1fr);gap:6px;padding:6px 12px;border-bottom:1px solid var(--row-border);align-items:center"><span style="font-size:12.5px;${MONO}">${esc(c)}</span>${cells}</div>`;
    }).join("");
    const flashHtml = !flash
      ? ""
      : flash.kind === "created"
        ? `<div style="${CARD};margin-top:20px;padding:14px 16px;border-color:var(--ok-border);background:var(--ok-bg)"><div style="font-size:13px;font-weight:700;color:var(--ok)">${esc(flash.text)}</div><div style="display:flex;align-items:center;gap:10px;margin-top:10px"><code id="newsecret" style="${MONO};font-size:13px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--code);overflow-x:auto">${esc(flash.secret ?? "")}</code><button class="btn" id="copysecret">Copy</button></div></div>`
        : `<div style="${CARD};margin-top:20px;padding:12px 16px;border-color:${flash.kind === "error" ? "var(--warn-border)" : "var(--ok-border)"}"><span style="font-size:13px;font-weight:600;color:${flash.kind === "error" ? "var(--warn)" : "var(--ok)"}">${esc(flash.text)}</span></div>`;
    const createCard = !opts.store
      ? ""
      : `<div style="${CARD};margin-top:12px">
<div style="padding:14px 16px;border-bottom:1px solid var(--border);font-size:13px;font-weight:700">New token</div>
<form method="post" action="#tokens">
<input type="hidden" name="csrf" value="${CSRF_TOKEN}"><input type="hidden" name="mcpha_action" value="create">
<div style="display:flex;gap:12px;padding:14px 16px;flex-wrap:wrap;align-items:center">
<label style="font-size:12px;color:var(--muted)">Name <input name="name" required maxlength="64" placeholder="voice-pipeline" style="font-family:inherit;font-size:13px;margin-left:6px;background:var(--bg);border:1px solid var(--btn-border);border-radius:6px;padding:6px 10px;color:var(--text)"></label>
<label style="font-size:12px;color:var(--muted)">Expires <select name="expires" style="font-family:inherit;font-size:13px;margin-left:6px;background:var(--bg);border:1px solid var(--btn-border);border-radius:6px;padding:6px 10px;color:var(--text)"><option value="never">never</option><option value="30d">in 30 days</option><option value="90d">in 90 days</option><option value="365d">in 1 year</option></select></label>
</div>
<div style="display:grid;grid-template-columns:1.4fr repeat(4,1fr);gap:6px;padding:8px 12px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);${STAT_LABEL}"><span>Category</span><span style="text-align:center">none</span><span style="text-align:center">read</span><span style="text-align:center">write</span><span style="text-align:center">manage</span></div>
${matrixRows}
<details style="padding:12px 16px"><summary style="font-size:12px;color:var(--muted);cursor:pointer">Entity restrictions (optional, glob patterns, one per line)</summary>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px">
<label style="font-size:12px;color:var(--muted)">Allowlist (empty = all)<textarea name="entity_allowlist" rows="3" placeholder="light.*&#10;automation.*" style="display:block;width:95%;font-size:12.5px;${MONO};margin-top:4px;background:var(--bg);border:1px solid var(--btn-border);border-radius:6px;padding:8px;color:var(--text)"></textarea></label>
<label style="font-size:12px;color:var(--muted)">Denylist (always wins)<textarea name="entity_denylist" rows="3" placeholder="lock.*" style="display:block;width:95%;font-size:12.5px;${MONO};margin-top:4px;background:var(--bg);border:1px solid var(--btn-border);border-radius:6px;padding:8px;color:var(--text)"></textarea></label>
</div><div style="font-size:11px;color:var(--muted);margin-top:8px">Applied on writes, on top of the global lists (both must agree; deny always wins).</div></details>
<div style="padding:0 16px 14px"><button class="btn" type="submit" style="border-color:var(--ok-border);color:var(--ok)">Create token</button> <span style="font-size:11px;color:var(--muted)">The secret is shown once, then only its hash is kept.</span></div>
</form></div>`;

    // --- Write audit (#126) with client-side filters --------------------
    const auditRow = (a: Record<string, unknown>): string => {
      const time = String(a.ts ?? "").slice(11, 19) || "?";
      const target =
        a.entity_id ?? (a.domain && a.service ? `${a.domain}.${a.service}` : a.target ? JSON.stringify(a.target) : "");
      const kind = a.dry_run === true ? "dry" : a.confirmation_required === true ? "confirm" : a.allowed === true ? "ok" : "refused";
      const status =
        kind === "dry"
          ? `<span style="color:var(--warn);font-weight:600">dry run</span>`
          : kind === "confirm"
            ? `<span style="color:var(--warn);font-weight:600">confirmation asked</span>`
            : kind === "ok"
              ? `<span style="color:var(--ok);font-weight:600">ok</span>`
              : `<span style="color:var(--err);font-weight:600">refused</span> <span style="color:var(--muted)">${esc(a.reason ?? "")}</span>`;
      return `<div class="arow" data-kind="${kind}" style="display:grid;grid-template-columns:.7fr .9fr 1.6fr 1.8fr 1.4fr;gap:12px;padding:10px 16px;border-bottom:1px solid var(--row-border);align-items:center;${MONO};font-size:12.5px"><span style="color:var(--muted)">${esc(time)}</span><span>${esc(a.client ?? "")}</span><span style="color:var(--code)">${esc(a.tool ?? "")}</span><span style="color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(target)}</span><span>${status}</span></div>`;
    };
    const auditTable =
      audit === null || audit.length === 0
        ? `<div style="${CARD};margin-top:12px;padding:16px;font-size:12px;color:var(--muted)">No audit entries yet. Every write attempt lands here and in /data/audit.log; MCP clients can never read or clear it.</div>`
        : `<div style="${CARD};margin-top:12px;overflow:hidden"><div style="display:grid;grid-template-columns:.7fr .9fr 1.6fr 1.8fr 1.4fr;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);${STAT_LABEL}"><span>Time</span><span>Client</span><span>Tool</span><span>Target</span><span>Status</span></div>${audit.map(auditRow).join("")}</div>
<div style="font-size:12px;color:var(--muted);margin-top:12px">Every write attempt lands here and in <code style="${MONO}">/data/audit.log</code>; MCP clients can never read or clear it.</div>`;

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>MCP Home Assistant</title>
<style>
body{--bg:#0d1117;--card:#161b22;--border:#21262d;--row-border:#1c2128;--btn-border:#30363d;--muted:#8b949e;--text:#e6edf3;--faint:#484f58;--code:#79c0ff;--link:#58a6ff;--accent:#33ff66;--ok:#3fb950;--ok-glow:#3fb95088;--ok-bg:#0f1f14;--ok-border:#1f4429;--warn:#d29922;--warn-bg:#2d2308;--warn-border:#4d3d0e;--err:#f85149;margin:0;background:var(--bg);font-family:'IBM Plex Sans',-apple-system,system-ui,sans-serif;color:var(--text)}
body[data-theme="light"]{--bg:#f6f8fa;--card:#ffffff;--border:#d0d7de;--row-border:#eaeef2;--btn-border:#afb8c1;--muted:#57606a;--text:#1f2328;--faint:#8c959f;--code:#0550ae;--link:#0969da;--accent:#1a7f37;--ok:#1a7f37;--ok-glow:rgba(26,127,55,.35);--ok-bg:#dafbe1;--ok-border:#aceebb;--warn:#9a6700;--warn-bg:#fff8c5;--warn-border:#d4a72c;--err:#cf222e}
@media (prefers-color-scheme: light){body:not([data-theme="dark"]){--bg:#f6f8fa;--card:#ffffff;--border:#d0d7de;--row-border:#eaeef2;--btn-border:#afb8c1;--muted:#57606a;--text:#1f2328;--faint:#8c959f;--code:#0550ae;--link:#0969da;--accent:#1a7f37;--ok:#1a7f37;--ok-glow:rgba(26,127,55,.35);--ok-bg:#dafbe1;--ok-border:#aceebb;--warn:#9a6700;--warn-bg:#fff8c5;--warn-border:#d4a72c;--err:#cf222e}}
a{color:var(--link)}
.btn{font-family:inherit;font-size:12px;font-weight:600;padding:5px 12px;border:1px solid var(--btn-border);border-radius:6px;background:var(--border);color:var(--text);cursor:pointer}
.btn:hover{background:var(--btn-border)}
.tab{font-family:inherit;font-size:13px;font-weight:600;padding:9px 16px;background:none;border:none;border-bottom:2px solid transparent;color:var(--muted);cursor:pointer}
.tab:hover{color:var(--text)}
.tab.on{color:var(--text);border-bottom-color:var(--accent)}
.ctab{font-family:inherit;font-size:12.5px;font-weight:600;padding:8px 16px;border:1px solid var(--border);border-bottom:none;border-radius:8px 8px 0 0;background:var(--bg);color:var(--muted);cursor:pointer}
.ctab.on{background:var(--card);color:var(--text)}
.fpill{font-family:inherit;font-size:12px;font-weight:600;padding:5px 14px;border:1px solid var(--btn-border);border-radius:16px;background:none;color:var(--muted);cursor:pointer}
.fpill:hover{border-color:var(--muted)}
.fpill.on{border-color:var(--accent);background:var(--ok-bg);color:var(--accent)}
</style></head><body>
<script>try{var _t=localStorage.getItem("mcpha-theme");if(_t)document.body.setAttribute("data-theme",_t)}catch(e){}</script>
<div style="max-width:980px;margin:0 auto;padding:28px 24px 48px">
<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
${logoHtml}
<div style="display:flex;flex-direction:column;gap:1px"><div style="font-size:18px;font-weight:700;letter-spacing:-.01em">MCP Home Assistant</div><div style="font-size:12px;color:var(--muted);${MONO}">v${esc(VERSION)} · uptime ${esc(fmtUptime(Date.now() - startedAt))}</div></div>
<div style="margin-left:auto;display:flex;align-items:center;gap:10px">${wsBadge}<div style="font-size:11px;color:var(--muted)">auto-refresh 60s</div><button class="btn" id="theme"></button></div>
</div>

<div style="display:flex;gap:2px;margin-top:24px;border-bottom:1px solid var(--border)">
<button class="tab on" data-tab="overview">Overview</button>
<button class="tab" data-tab="connect">Connect a client</button>
<button class="tab" data-tab="tokens">Tokens</button>
<button class="tab" data-tab="audit">Write audit</button>
</div>

<div data-panel="overview">
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:20px">${statCards}</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">${safetyCard}${topToolsCard}</div>
</div>

<div data-panel="connect" hidden>
<div style="${CARD};padding:16px;margin-top:20px">
<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><div style="font-size:13px;font-weight:700">MCP endpoint</div><code style="${MONO};font-size:13px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:5px 10px;color:var(--code)">${esc(mcpUrl)}</code><button class="btn" id="reveal" style="margin-left:auto"></button></div>
<div style="font-size:12px;color:var(--muted);margin-top:8px">Snippets embed your API token, masked on screen. <b style="color:var(--text)">Copy</b> always copies the full working version.</div>
</div>
<div style="display:flex;gap:2px;margin-top:16px">${clientTabs}</div>
<div style="${CARD};border-radius:0 8px 8px 8px;padding:16px">${clientPanels}</div>
</div>

<div data-panel="tokens" hidden>
${flashHtml}
<div style="${CARD};margin-top:${flash ? "12px" : "20px"};overflow:hidden">
<div style="display:grid;grid-template-columns:1.2fr 2fr 1.4fr 1fr .6fr;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);${STAT_LABEL}"><span>Name</span><span>Token</span><span>Grants</span><span>Lifecycle</span><span></span></div>
${legacyRows}
${storeRows}
</div>
${createCard}
<div style="font-size:12px;color:var(--muted);margin-top:12px">Tokens created here are stored <b style="color:var(--text)">hashed</b> (sha256) with fine-grained per-category grants, capped by the <code style="${MONO}">allow_*</code> options on every request. The primary <code style="${MONO}">api_token</code> (Configuration tab) keeps full access as the bootstrap and recovery path.</div>
</div>

<div data-panel="audit" hidden>
<div style="display:flex;gap:8px;margin-top:20px;align-items:center;flex-wrap:wrap">
<button class="fpill on" data-filter="all">All</button>
<button class="fpill" data-filter="ok">OK</button>
<button class="fpill" data-filter="refused">Refused</button>
<button class="fpill" data-filter="dryconfirm">Dry run / confirm</button>
<span style="margin-left:auto;font-size:12px;color:var(--muted)">${audit?.length ?? 0} entries · newest first · full history in /data/audit.log</span>
</div>
${auditTable}
</div>

<div style="font-size:11px;color:var(--faint);margin-top:32px;border-top:1px solid var(--border);padding-top:14px">This page is only reachable through your authenticated Home Assistant session, like the Configuration tab where the token already lives.</div>
</div>
<script>
(function () {
  var TOKEN = ${JSON.stringify(cfg.apiToken)};
  var MASK = ${JSON.stringify(maskSecret(cfg.apiToken))};

  // Theme cycle dark/light/auto, persisted across the 60s refresh. "auto"
  // removes the attribute so the prefers-color-scheme media query rules.
  var THEMES = ["auto", "dark", "light"];
  function applyTheme(t) {
    if (t === "auto") document.body.removeAttribute("data-theme");
    else document.body.setAttribute("data-theme", t);
    document.getElementById("theme").textContent = "Theme: " + t;
  }
  var theme = "auto";
  try { theme = localStorage.getItem("mcpha-theme") || "auto"; } catch (e) {}
  applyTheme(theme);
  document.getElementById("theme").addEventListener("click", function () {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try {
      if (theme === "auto") localStorage.removeItem("mcpha-theme");
      else localStorage.setItem("mcpha-theme", theme);
    } catch (e) {}
    applyTheme(theme);
  });

  // Tabs: state lives in location.hash so it survives the 60s refresh.
  var tabs = document.querySelectorAll(".tab");
  function showTab(name) {
    var known = false;
    tabs.forEach(function (t) { known = known || t.getAttribute("data-tab") === name; });
    if (!known) name = "overview";
    tabs.forEach(function (t) { t.classList.toggle("on", t.getAttribute("data-tab") === name); });
    document.querySelectorAll("[data-panel]").forEach(function (p) {
      p.hidden = p.getAttribute("data-panel") !== name;
    });
  }
  tabs.forEach(function (t) {
    t.addEventListener("click", function () {
      location.hash = t.getAttribute("data-tab");
      showTab(t.getAttribute("data-tab"));
    });
  });
  showTab((location.hash || "#overview").slice(1));

  // Client sub-tabs.
  document.querySelectorAll(".ctab").forEach(function (t) {
    t.addEventListener("click", function () {
      document.querySelectorAll(".ctab").forEach(function (x) { x.classList.toggle("on", x === t); });
      document.querySelectorAll("[data-cpanel]").forEach(function (p) {
        p.hidden = p.getAttribute("data-cpanel") !== t.getAttribute("data-client");
      });
    });
  });

  // Reveal/copy: unchanged #92 mechanics, revealed state in sessionStorage.
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
      var panel = btn.closest("[data-cpanel]");
      var tpl = panel.querySelector("pre[data-tpl]").getAttribute("data-tpl");
      navigator.clipboard.writeText(tpl.split("___TOKEN___").join(TOKEN)).then(function () {
        btn.textContent = "Copied!";
        setTimeout(function () { btn.textContent = "Copy"; }, 1200);
      });
    });
  });
  render();

  // One-time secret copy (#167): present only in the POST answer.
  var copyBtn = document.getElementById("copysecret");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      navigator.clipboard.writeText(document.getElementById("newsecret").textContent).then(function () {
        copyBtn.textContent = "Copied!";
      });
    });
  }

  // Audit filters, pure client-side.
  document.querySelectorAll(".fpill").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll(".fpill").forEach(function (x) { x.classList.toggle("on", x === b); });
      var f = b.getAttribute("data-filter");
      document.querySelectorAll(".arow").forEach(function (r) {
        var k = r.getAttribute("data-kind");
        var show = f === "all" || (f === "ok" && k === "ok") || (f === "refused" && k === "refused") || (f === "dryconfirm" && (k === "dry" || k === "confirm"));
        r.style.display = show ? "grid" : "none";
      });
    });
  });
})();
</script>
</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  };
}
