import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AddonConfig } from "../config.js";

/**
 * Central tool registry (#165, epic #164): the single source of truth for
 * WHAT each tool is. Registration gating, the ingress tool counts and the
 * future per-token grants (#166/#167) all derive from this table; adding a
 * tool without an entry here fails the exhaustiveness test in index.test.ts.
 */

/** Tool families, the granularity of the future fine-grained tokens. */
export const CATEGORIES = [
  "entities",
  "history",
  "diagnostics",
  "automations",
  "scripts",
  "services",
  "helpers",
  "camera",
  "calendar",
  "notify",
  "scenes",
  "dashboards",
  "environment",
] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Access levels, strictly ordered: none < read < write < manage. A grant
 * INCLUDES the levels below it (GitHub permission model). In particular
 * manage includes write by design: whoever can rewrite an automation's
 * config can make it do anything, so a manage-without-write tier would be
 * an illusory boundary, not a real one.
 */
export const LEVELS = ["none", "read", "write", "manage"] as const;
export type Level = (typeof LEVELS)[number];

export interface ToolEntry {
  category: Category;
  /** Minimum level a grant must reach for the tool to exist. */
  level: Exclude<Level, "none">;
}

/** All 45 tools. Kept sorted by category, then level, then name. */
export const TOOL_REGISTRY: Record<string, ToolEntry> = {
  // entities: the read surface of the state machine. ha_render_template can
  // read any state, so it belongs here rather than in a category of its own.
  ha_get_entity: { category: "entities", level: "read" },
  ha_list_areas: { category: "entities", level: "read" },
  ha_list_devices: { category: "entities", level: "read" },
  ha_list_entities: { category: "entities", level: "read" },
  ha_render_template: { category: "entities", level: "read" },
  ha_search_entities: { category: "entities", level: "read" },
  // history
  ha_get_history: { category: "history", level: "read" },
  ha_get_logbook: { category: "history", level: "read" },
  ha_get_statistics: { category: "history", level: "read" },
  // diagnostics
  ha_explain_event: { category: "diagnostics", level: "read" },
  ha_get_addons: { category: "diagnostics", level: "read" },
  ha_get_health: { category: "diagnostics", level: "read" },
  ha_get_self_test: { category: "diagnostics", level: "read" },
  ha_get_system: { category: "diagnostics", level: "read" },
  // automations (blueprints ride along: they exist to create automations)
  ha_get_automation: { category: "automations", level: "read" },
  ha_get_automation_trace: { category: "automations", level: "read" },
  ha_list_automations: { category: "automations", level: "read" },
  ha_list_blueprints: { category: "automations", level: "read" },
  ha_set_automation: { category: "automations", level: "write" },
  ha_trigger_automation: { category: "automations", level: "write" },
  ha_create_automation: { category: "automations", level: "manage" },
  ha_create_from_blueprint: { category: "automations", level: "manage" },
  ha_delete_automation: { category: "automations", level: "manage" },
  ha_update_automation: { category: "automations", level: "manage" },
  // scripts
  ha_list_scripts: { category: "scripts", level: "read" },
  ha_run_script: { category: "scripts", level: "write" },
  ha_create_script: { category: "scripts", level: "manage" },
  ha_delete_script: { category: "scripts", level: "manage" },
  ha_update_script: { category: "scripts", level: "manage" },
  // services
  ha_list_services: { category: "services", level: "read" },
  ha_call_service: { category: "services", level: "write" },
  // helpers (no read tools: a read grant exposes nothing here)
  ha_create_helper: { category: "helpers", level: "write" },
  ha_delete_helper: { category: "helpers", level: "write" },
  // camera
  ha_get_camera_snapshot: { category: "camera", level: "read" },
  // calendar
  ha_get_calendar: { category: "calendar", level: "read" },
  ha_get_todo_list: { category: "calendar", level: "read" },
  ha_manage_todo: { category: "calendar", level: "write" },
  // notify (write-only category)
  ha_announce: { category: "notify", level: "write" },
  ha_send_notification: { category: "notify", level: "write" },
  // scenes (write-only category)
  ha_snapshot_scene: { category: "scenes", level: "write" },
  // dashboards
  ha_list_dashboards: { category: "dashboards", level: "read" },
  ha_add_dashboard_card: { category: "dashboards", level: "manage" },
  // environment
  ha_get_energy: { category: "environment", level: "read" },
  ha_get_forecast: { category: "environment", level: "read" },
  ha_get_presence: { category: "environment", level: "read" },
};

/** One level per category; "none" hides even the read tools. */
export type Grants = Record<Category, Level>;

export function atLeast(grant: Level, required: Level): boolean {
  return LEVELS.indexOf(grant) >= LEVELS.indexOf(required);
}

/** Whether a tool exists for these grants. Unknown tools never do. */
export function allows(grants: Grants, tool: string): boolean {
  const entry = TOOL_REGISTRY[tool];
  if (!entry) return false;
  return atLeast(grants[entry.category], entry.level);
}

/**
 * Compatibility mapping: the global option gates expressed as Grants. One
 * assumed behaviour change against the pre-registry gating, documented in
 * #165: with allow_config_write on and allow_write off, the manage grant on
 * automations/scripts now includes their runtime write tools (run, trigger,
 * set). The old separation was illusory (manage can author an automation
 * that does anything), so the hierarchy stops pretending otherwise.
 */
export function grantsFromConfig(cfg: AddonConfig, canWrite?: boolean | undefined): Grants {
  const write = cfg.allowWrite && canWrite !== false;
  const manage = cfg.allowConfigWrite && canWrite !== false;
  const configurable: Level = manage ? "manage" : write ? "write" : "read";
  const actionable: Level = write ? "write" : "read";
  return {
    entities: "read",
    history: "read",
    diagnostics: "read",
    environment: "read",
    camera: cfg.allowCamera ? "read" : "none",
    automations: configurable,
    scripts: configurable,
    dashboards: manage ? "manage" : "read",
    services: actionable,
    helpers: actionable,
    calendar: actionable,
    notify: actionable,
    scenes: actionable,
  };
}

/**
 * The epic #164 ceiling: a stored token can never exceed the option gates.
 * Applied per request, so closing a gate instantly degrades every token.
 */
export function capGrants(requested: Partial<Grants>, cfg: AddonConfig): Grants {
  const ceiling = grantsFromConfig(cfg, true);
  const out = {} as Grants;
  for (const c of CATEGORIES) {
    const asked = LEVELS.indexOf(requested[c] ?? "none");
    out[c] = LEVELS[Math.min(asked < 0 ? 0 : asked, LEVELS.indexOf(ceiling[c]))] as Level;
  }
  return out;
}

/** Everything, before capping: what a legacy write-scope token meant. */
export function fullGrants(): Grants {
  const out = {} as Grants;
  for (const c of CATEGORIES) {
    const levels = new Set(Object.values(TOOL_REGISTRY).filter((e) => e.category === c).map((e) => e.level));
    out[c] = levels.has("manage") ? "manage" : levels.has("write") ? "write" : "read";
  }
  return out;
}

/** Read everywhere, before capping: what a legacy read-scope token meant. */
export function readOnlyGrants(): Grants {
  const out = {} as Grants;
  for (const c of CATEGORIES) out[c] = "read";
  return out;
}

/** Tool counts for these grants, the ingress breakdown derives from this. */
export function toolCounts(grants: Grants): { read: number; write: number; total: number } {
  let read = 0;
  let write = 0;
  for (const entry of Object.values(TOOL_REGISTRY)) {
    if (!atLeast(grants[entry.category], entry.level)) continue;
    if (entry.level === "read") read += 1;
    else write += 1;
  }
  return { read, write, total: read + write };
}

/**
 * The only surface the tool modules need: gating happens HERE, centrally,
 * not in per-module early returns. buildServer hands the modules a gated
 * registrar; the tests hand them a plain fake with the same shape.
 */
export interface ToolRegistrar {
  registerTool: McpServer["registerTool"];
}

export function gatedRegistrar(server: McpServer, grants: Grants): ToolRegistrar {
  return {
    registerTool: ((name: string, meta: unknown, handler: unknown) => {
      if (!allows(grants, name)) return undefined;
      return (server.registerTool as (n: string, m: unknown, h: unknown) => unknown)(name, meta, handler);
    }) as McpServer["registerTool"],
  };
}
