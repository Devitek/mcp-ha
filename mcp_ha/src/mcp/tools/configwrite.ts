import { z } from "zod";
import { stringify } from "yaml";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { safe } from "../helpers.js";
import { CONFIRM_TTL_SECONDS, ConfirmationStore } from "../../confirm.js";
import { audit } from "../../logger.js";
import { entityWriteAllowed } from "../../safety.js";

/**
 * Minimal unified diff (LCS on lines, full context, no hunks): the configs
 * at stake are a few dozen YAML lines, a whole-file diff stays readable and
 * spares a dependency. Exported for its own tests.
 */
export function unifiedDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = n - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < m) out.push(`- ${a[i++]}`);
  while (j < n) out.push(`+ ${b[j++]}`);
  return out.join("\n");
}

/**
 * Config writes (#94, tier 3): the assistant gets the power to program
 * behaviour into the house. Deliberately the most guarded path in the
 * add-on:
 *  - its own allow_config_write option (default false, independent from
 *    allow_write) plus the token write scope;
 *  - Home Assistant validates the blocks BEFORE anything is offered;
 *  - two-step confirmation is MANDATORY (not tied to confirm_domains) and
 *    the confirmation answer carries the complete YAML for human review;
 *  - creation only: existing automations and scripts are never overwritten
 *    (modification is a later, separate decision);
 *  - every step lands in the audit trail with the token name.
 */

const freeObjects = z.array(z.record(z.string(), z.unknown()));

/** entity object_id derivation, mirroring HA's slugify closely enough. */
function slugify(alias: string): string {
  return alias
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function registerConfigWriteTools(server: McpServer, ctx: ToolContext): void {
  // Gated by allow_config_write and by the token scope (#85). Independent
  // from allow_write: service calls and config writes are separate grants.
  if (!ctx.cfg.allowConfigWrite || ctx.canWrite === false) return;
  const client = (): string => ctx.client ?? "default";

  interface CreateRequest {
    tool: string;
    kind: "automation" | "script";
    /** Complete config object, exactly what will be written. */
    payload: Record<string, unknown>;
    /** REST path (relative to /api) receiving the POST. */
    path: string;
    /** Resulting entity id, for the collision check and the answer. */
    entityId: string;
    /**
     * Blueprint payloads have no triggers/actions blocks for validate_config;
     * their inputs are checked against the blueprint metadata instead and HA
     * validates at write time (#127).
     */
    skipWsValidation?: boolean | undefined;
    dry_run?: boolean | undefined;
    confirm_token?: string | undefined;
  }

  async function refuseCollisions(req: CreateRequest): Promise<void> {
    const all = await ctx.catalog.index();
    if (all.some((e) => e.entity_id === req.entityId)) {
      throw new Error(
        `${req.entityId} already exists. Creation only: modifying existing ${req.kind}s is deliberately unsupported.`
      );
    }
    if (req.kind === "automation") {
      const alias = String(req.payload.alias ?? "").toLowerCase();
      const clash = all.find((e) => e.domain === "automation" && e.name.toLowerCase() === alias);
      if (clash) {
        throw new Error(
          `An automation named "${req.payload.alias}" already exists (${clash.entity_id}). ` +
            "Creation only: pick another alias instead of duplicating it."
        );
      }
    }
  }

  async function validateBlocks(kind: "automation" | "script", payload: Record<string, unknown>): Promise<void> {
    const blocks: Record<string, unknown> =
      kind === "automation"
        ? {
            triggers: payload.triggers,
            ...(payload.conditions ? { conditions: payload.conditions } : {}),
            actions: payload.actions,
          }
        : { actions: payload.sequence };
    const res: Record<string, { valid: boolean; error?: string }> = await ctx.ws.send("validate_config", blocks);
    const bad = Object.entries(res ?? {}).filter(([, v]) => v && v.valid === false);
    if (bad.length > 0) {
      throw new Error(
        "Home Assistant rejected the configuration: " + bad.map(([k, v]) => `${k}: ${v.error ?? "invalid"}`).join("; ")
      );
    }
  }

  async function guardedCreate(req: CreateRequest): Promise<unknown> {
    const yaml = stringify(req.payload);
    const hash = ConfirmationStore.fingerprint({ domain: "_config", service: req.tool, data: req.payload });
    await refuseCollisions(req);

    if (req.dry_run) {
      audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: true, dry_run: true });
      return { dry_run: true, would_create: req.entityId, yaml };
    }

    if (!req.confirm_token) {
      // Validate before offering anything: an invalid config must never
      // reach the confirmation stage.
      if (!req.skipWsValidation) await validateBlocks(req.kind, req.payload);
      // In a session with an elicitation-capable client (#90), the human
      // reviews the YAML in-protocol; the token flow stays the fallback.
      const answer = ctx.elicit
        ? await ctx.elicit(`About to create ${req.entityId} with this configuration:\n\n${yaml}\nConfirm the creation?`)
        : null;
      if (answer === false) {
        audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: false, reason: "declined by the user (elicitation)" });
        throw new Error("creation declined by the user");
      }
      if (answer === null) {
        const confirm_token = ctx.confirmations.issue(hash);
        audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: false, reason: "confirmation_required" });
        return {
          confirmation_required: true,
          confirm_token,
          expires_in_seconds: CONFIRM_TTL_SECONDS,
          would_create: req.entityId,
          yaml,
          note:
            "Show this YAML to the user and get their explicit approval, then call again with the SAME arguments plus confirm_token.",
        };
      }
      audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: true, confirmed_via: "elicitation" });
    } else {
      const verdict = ctx.confirmations.consume(req.confirm_token, hash);
      if (verdict !== "ok") {
        audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: false, reason: `confirm_token ${verdict}` });
        throw new Error(
          `confirm_token ${verdict}: ` +
            (verdict === "mismatch"
              ? "the arguments differ from the confirmed ones; restart the confirmation."
              : "request a fresh confirmation and try again.")
        );
      }
    }
    await ctx.http.corePost(req.path, req.payload);
    audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: true });
    return {
      created: req.entityId,
      note: "It appears within a couple of seconds after the automatic reload; check it with ha_get_entity.",
    };
  }

  /**
   * Guarded update (#108): reads the current UI-managed config, replaces
   * the provided blocks wholesale (fine-grained merges are undebuggable),
   * validates, then demands confirmation on a before/after diff. The base
   * config hash is part of the confirmation fingerprint: if the automation
   * changes between the two passes (simultaneous UI edit), the token
   * mismatches and the flow restarts. The success answer carries the full
   * previous YAML as the rollback.
   */
  interface UpdateRequest {
    tool: string;
    kind: "automation" | "script";
    entityId: string;
    patch: Record<string, unknown>;
    /** Replaces use_blueprint.input wholesale, blueprint targets only (#139). */
    blueprintInputs?: Record<string, unknown> | undefined;
    dry_run?: boolean | undefined;
    confirm_token?: string | undefined;
  }

  /** Required/unknown input checks against the installed blueprint (#127/#139). */
  async function checkBlueprintInputs(kind: "automation" | "script", path: unknown, inputs: Record<string, unknown>): Promise<void> {
    const list: Record<string, any> = ((await ctx.ws.send("blueprint/list", { domain: kind })) as Record<string, any>) ?? {};
    const bp = list[String(path)];
    if (!bp) throw new Error(`blueprint ${String(path)} is not installed (anymore); its automations can only be edited in the UI`);
    const declared: Record<string, any> = bp?.metadata?.input ?? {};
    const missing = Object.entries(declared)
      .filter(([, def]) => !("default" in ((def ?? {}) as object)))
      .map(([name]) => name)
      .filter((name) => !(name in inputs));
    if (missing.length > 0) throw new Error(`missing required blueprint inputs: ${missing.join(", ")} (inputs replaces the whole set)`);
    const unknown = Object.keys(inputs).filter((k) => !(k in declared));
    if (unknown.length > 0) {
      throw new Error(`unknown blueprint inputs: ${unknown.join(", ")} (this blueprint declares: ${Object.keys(declared).join(", ")})`);
    }
  }

  async function currentConfig(kind: "automation" | "script", entityId: string): Promise<{ config: Record<string, unknown>; path: string }> {
    const e = (await ctx.catalog.index()).find((x) => x.entity_id === entityId);
    if (!e) throw new Error(`unknown ${kind}: ${entityId}. Use ha_search_entities to find the right id.`);
    let path: string;
    if (kind === "automation") {
      const cfgId = e.attributes.id;
      if (typeof cfgId !== "string" || !cfgId) {
        throw new Error("this automation has no configuration id (YAML-defined): changes are only possible for UI-managed ones");
      }
      path = `/config/automation/config/${encodeURIComponent(cfgId)}`;
    } else {
      path = `/config/script/config/${encodeURIComponent(entityId.slice("script.".length))}`;
    }
    try {
      const config = await ctx.http.coreGet(path);
      return { config, path };
    } catch (err) {
      if (String(err instanceof Error ? err.message : err).includes("HTTP 404")) {
        throw new Error(`no stored configuration for ${entityId} (YAML-defined): changes are only possible for UI-managed ones`);
      }
      throw err;
    }
  }

  async function guardedUpdate(req: UpdateRequest): Promise<unknown> {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.patch)) if (v !== undefined) patch[k] = v;
    if (Object.keys(patch).length === 0 && !req.blueprintInputs) {
      throw new Error(
        "nothing to change: provide at least one field (alias, description, mode, triggers, conditions, actions/sequence, variables, max_exceeded, initial_state, trace, or inputs for a blueprint automation)"
      );
    }
    const { config: before, path } = await currentConfig(req.kind, req.entityId);
    // Blueprint-based configs have no raw blocks (#139): their behaviour is
    // edited through use_blueprint.input, never through triggers/actions.
    const blueprint = (before as { use_blueprint?: { path?: unknown; input?: unknown } }).use_blueprint;
    const isBlueprint = typeof blueprint === "object" && blueprint !== null;
    const blockKeys = ["triggers", "conditions", "actions", "sequence"].filter((k) => k in patch);
    if (isBlueprint && blockKeys.length > 0) {
      throw new Error(
        `${req.entityId} is blueprint-based (${String(blueprint.path)}): update its inputs (or alias, description, mode), not raw ${blockKeys.join("/")} blocks`
      );
    }
    if (!isBlueprint && req.blueprintInputs) {
      throw new Error(`inputs only applies to blueprint-based ${req.kind}s; ${req.entityId} has raw blocks, update those instead`);
    }
    const final: Record<string, unknown> = { ...before, ...patch };
    // Root-key removal (#158): null explicitly DROPS the key from the
    // stored config (an empty object writes an empty object; undefined
    // leaves the key untouched). Only the optional root keys are nullable
    // in the schemas; the blocks stay non-null.
    for (const [k, v] of Object.entries(patch)) if (v === null) delete final[k];
    // Legacy twin keys (#146): stored configs may use the old singular keys
    // (trigger/condition/action). A provided modern block must REPLACE its
    // legacy twin, not sit next to it: HA refuses "both 'trigger' and
    // 'triggers'". This also makes legacy-to-modern migrations possible
    // through the tool. Untouched pairs keep their legacy key: mixing
    // syntaxes across DIFFERENT pairs is valid for HA.
    for (const [modern, legacy] of [
      ["triggers", "trigger"],
      ["conditions", "condition"],
      ["actions", "action"],
    ] as const) {
      if (modern in patch) delete final[legacy];
    }
    if (isBlueprint && req.blueprintInputs) {
      await checkBlueprintInputs(req.kind, blueprint.path, req.blueprintInputs);
      final.use_blueprint = { ...blueprint, input: req.blueprintInputs };
    }
    const beforeYaml = stringify(before);
    const afterYaml = stringify(final);
    const diff = unifiedDiff(beforeYaml, afterYaml);
    const baseHash = createHash("sha256").update(JSON.stringify(before)).digest("hex");
    // The base hash inside the fingerprint IS the concurrent-edit guard: a
    // config changed between the passes yields a different hash, so the
    // token verdict is "mismatch" and nothing is written.
    const hash = ConfirmationStore.fingerprint({
      domain: "_config",
      service: req.tool,
      data: { entity_id: req.entityId, config: final, base: baseHash },
    });

    if (req.dry_run) {
      audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: true, dry_run: true });
      return { dry_run: true, would_update: req.entityId, diff, yaml: afterYaml };
    }

    if (!req.confirm_token) {
      // Blueprint payloads have no blocks for validate_config; the inputs
      // were checked against the blueprint metadata above and HA validates
      // the values at write time.
      if (!isBlueprint) await validateBlocks(req.kind, final);
      const answer = ctx.elicit
        ? await ctx.elicit(`About to update ${req.entityId}. Review the change:\n\n${diff}\nConfirm the update?`)
        : null;
      if (answer === false) {
        audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: false, reason: "declined by the user (elicitation)" });
        throw new Error("update declined by the user");
      }
      if (answer === null) {
        const confirm_token = ctx.confirmations.issue(hash);
        audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: false, reason: "confirmation_required" });
        return {
          confirmation_required: true,
          confirm_token,
          expires_in_seconds: CONFIRM_TTL_SECONDS,
          would_update: req.entityId,
          diff,
          yaml: afterYaml,
          note:
            "Show this diff to the user and get their explicit approval, then call again with the SAME arguments plus confirm_token.",
        };
      }
      audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: true, confirmed_via: "elicitation", before: baseHash.slice(0, 12) });
    } else {
      const verdict = ctx.confirmations.consume(req.confirm_token, hash);
      if (verdict !== "ok") {
        audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: false, reason: `confirm_token ${verdict}` });
        throw new Error(
          `confirm_token ${verdict}: ` +
            (verdict === "mismatch"
              ? "the configuration changed since the confirmation (or the arguments differ); review and restart the confirmation."
              : "request a fresh confirmation and try again.")
        );
      }
    }

    await ctx.http.corePost(path, final);
    audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: true, before: baseHash.slice(0, 12) });
    return {
      updated: req.entityId,
      previous_yaml: beforeYaml,
      note: "Keep previous_yaml somewhere if you may want to revert; the add-on does not store it.",
    };
  }

  /**
   * Guarded deletion (#155): the last piece of the lifecycle, deliberately
   * refused until real-world need proved it (orphaned automations of a
   * removed device). The maximum-destruction path gets maximum belts: the
   * first answer carries the COMPLETE YAML of what disappears, the config
   * hash rides the fingerprint (a change between passes invalidates the
   * token), and the success answer returns the deleted YAML, which makes
   * the deletion reversible through ha_create_automation.
   */
  async function guardedDelete(req: { tool: string; kind: "automation" | "script"; entityId: string; dry_run?: boolean | undefined; confirm_token?: string | undefined }): Promise<unknown> {
    const verdict0 = entityWriteAllowed(ctx.cfg, req.entityId);
    if (!verdict0.allowed) {
      audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: false, reason: verdict0.reason });
      throw new Error(verdict0.reason ?? `entity denied: ${req.entityId}`);
    }
    const { config, path } = await currentConfig(req.kind, req.entityId);
    const yaml = stringify(config);
    const baseHash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    const hash = ConfirmationStore.fingerprint({
      domain: "_config",
      service: req.tool,
      data: { entity_id: req.entityId, base: baseHash },
    });

    if (req.dry_run) {
      audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: true, dry_run: true });
      return { dry_run: true, would_delete: req.entityId, yaml };
    }
    if (!req.confirm_token) {
      const answer = ctx.elicit
        ? await ctx.elicit(`About to DELETE ${req.entityId}. This is its full configuration:\n\n${yaml}\nConfirm the deletion?`)
        : null;
      if (answer === false) {
        audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: false, reason: "declined by the user (elicitation)" });
        throw new Error("deletion declined by the user");
      }
      if (answer === null) {
        const confirm_token = ctx.confirmations.issue(hash);
        audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: false, reason: "confirmation_required" });
        return {
          confirmation_required: true,
          confirm_token,
          expires_in_seconds: CONFIRM_TTL_SECONDS,
          would_delete: req.entityId,
          yaml,
          note:
            "Deletion is final on the Home Assistant side. Show this YAML to the user, get their explicit approval, then call again with the SAME arguments plus confirm_token.",
        };
      }
      audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: true, confirmed_via: "elicitation", before: baseHash.slice(0, 12) });
    } else {
      const verdict = ctx.confirmations.consume(req.confirm_token, hash);
      if (verdict !== "ok") {
        audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: false, reason: `confirm_token ${verdict}` });
        throw new Error(
          `confirm_token ${verdict}: ` +
            (verdict === "mismatch"
              ? "the configuration changed since the confirmation; review and restart."
              : "request a fresh confirmation and try again.")
        );
      }
    }
    await ctx.http.coreDelete(path);
    audit({ client: client(), tool: req.tool, entity_id: req.entityId, allowed: true, before: baseHash.slice(0, 12) });
    return {
      deleted: req.entityId,
      deleted_yaml: yaml,
      note: `Recreate it with ha_create_${req.kind} from deleted_yaml if you change your mind; the add-on does not store it.`,
    };
  }

  server.registerTool(
    "ha_delete_automation",
    {
      title: "Delete an automation",
      description:
        "DELETES an existing UI-managed automation. Two-step: the first call returns the complete YAML " +
        "of what will disappear plus a confirm_token; show it to the user, then call again with the " +
        "token. The deleted YAML is returned on success, so ha_create_automation can undo the deletion.",
      inputSchema: {
        entity_id: z.string().describe("E.g. automation.orphaned_doorbell"),
        dry_run: z.boolean().optional().describe("true: preview the YAML only"),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe("ha_delete_automation", async ({ entity_id, dry_run, confirm_token }) => {
      if (!entity_id.startsWith("automation.")) throw new Error(`expected an automation.* entity_id, got: ${entity_id}`);
      return guardedDelete({ tool: "ha_delete_automation", kind: "automation", entityId: entity_id, dry_run, confirm_token });
    })
  );

  server.registerTool(
    "ha_delete_script",
    {
      title: "Delete a script",
      description:
        "DELETES an existing UI-managed script, same guarded two-step flow as ha_delete_automation " +
        "(full YAML shown before confirmation, deleted YAML returned for undo).",
      inputSchema: {
        entity_id: z.string().describe("E.g. script.obsolete_routine"),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe("ha_delete_script", async ({ entity_id, dry_run, confirm_token }) => {
      if (!entity_id.startsWith("script.")) throw new Error(`expected a script.* entity_id, got: ${entity_id}`);
      return guardedDelete({ tool: "ha_delete_script", kind: "script", entityId: entity_id, dry_run, confirm_token });
    })
  );

  server.registerTool(
    "ha_add_dashboard_card",
    {
      title: "Add a dashboard card",
      description:
        "Inserts ONE card into a Lovelace dashboard view (draft it with the propose-dashboard-card " +
        "prompt first). Two-step: the first call returns a before/after diff of the VIEW plus a " +
        "confirm_token; show it to the user, then call again with the token. Classic and sections " +
        "layouts are both handled; YAML-managed dashboards are refused. Find targets with " +
        "ha_list_dashboards.",
      inputSchema: {
        dashboard: z.string().describe("url_path from ha_list_dashboards; 'lovelace' for the default"),
        view: z.union([z.number().int().min(0), z.string()]).describe("View index, or its path/title"),
        card: z.record(z.string(), z.unknown()).describe("The card config (type, entities...)"),
        dry_run: z.boolean().optional().describe("true: return the diff preview only"),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe("ha_add_dashboard_card", async ({ dashboard, view, card, dry_run, confirm_token }) => {
      const urlPath = dashboard === "lovelace" || dashboard === "" ? null : dashboard;
      // YAML-managed dashboards are not editable through this API; refuse
      // upfront when the listing knows it (the default dashboard's mode is
      // only known at save time: its error is relayed).
      try {
        const list: any[] = ((await ctx.ws.send("lovelace/dashboards/list", {})) as any[]) ?? [];
        const entry = list.find((d) => d.url_path === urlPath);
        if (entry && entry.mode !== "storage") {
          throw new Error(`dashboard ${dashboard} is YAML-managed: edit its YAML file directly`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("YAML-managed")) throw e;
        // listing unavailable: proceed, the save will tell
      }

      const config: any = await ctx.ws.send("lovelace/config", { url_path: urlPath });
      const views: any[] = config?.views ?? [];
      const idx =
        typeof view === "number"
          ? view
          : views.findIndex(
              (v) =>
                String(v?.path ?? "").toLowerCase() === view.toLowerCase() ||
                String(v?.title ?? "").toLowerCase() === view.toLowerCase()
            );
      const target = views[idx];
      if (!target) {
        throw new Error(
          `view not found: ${view}. Views: ${views.map((v, i) => `${i}: ${v?.title ?? v?.path ?? "untitled"}`).join(", ") || "none"}`
        );
      }

      const beforeViewYaml = stringify(target);
      // Both layouts (#129): classic views carry cards[], modern ones carry
      // sections[] of grids. Insert at the end of the last grid, or open one.
      const newView = JSON.parse(JSON.stringify(target)) as Record<string, any>;
      if (newView.type === "sections" || Array.isArray(newView.sections)) {
        newView.sections = Array.isArray(newView.sections) ? newView.sections : [];
        let last = newView.sections[newView.sections.length - 1];
        if (!last || !Array.isArray(last.cards)) {
          last = { type: "grid", cards: [] };
          newView.sections.push(last);
        }
        last.cards.push(card);
      } else {
        newView.cards = [...(Array.isArray(newView.cards) ? newView.cards : []), card];
      }
      const afterViewYaml = stringify(newView);
      const diff = unifiedDiff(beforeViewYaml, afterViewYaml);
      // The whole-dashboard hash inside the fingerprint is the concurrent
      // edit guard, same pattern as ha_update_automation (#108).
      const baseHash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
      const hash = ConfirmationStore.fingerprint({
        domain: "_config",
        service: "ha_add_dashboard_card",
        data: { dashboard, view: idx, card, base: baseHash },
      });
      const label = `${dashboard} (view ${idx}${target.title ? `: ${target.title}` : ""})`;

      if (dry_run) {
        audit({ client: client(), tool: "ha_add_dashboard_card", target: label, allowed: true, dry_run: true });
        return { dry_run: true, would_update: label, diff };
      }
      if (!confirm_token) {
        const answer = ctx.elicit
          ? await ctx.elicit(`About to add a card to ${label}. Review the view change:\n\n${diff}\nConfirm?`)
          : null;
        if (answer === false) {
          audit({ client: client(), tool: "ha_add_dashboard_card", target: label, allowed: false, reason: "declined by the user (elicitation)" });
          throw new Error("card insertion declined by the user");
        }
        if (answer === null) {
          const token = ctx.confirmations.issue(hash);
          audit({ client: client(), tool: "ha_add_dashboard_card", target: label, allowed: false, reason: "confirmation_required" });
          return {
            confirmation_required: true,
            confirm_token: token,
            expires_in_seconds: CONFIRM_TTL_SECONDS,
            would_update: label,
            diff,
            note: "Show this view diff to the user and get their approval, then call again with the SAME arguments plus confirm_token.",
          };
        }
        audit({ client: client(), tool: "ha_add_dashboard_card", target: label, allowed: true, confirmed_via: "elicitation" });
      } else {
        const verdict = ctx.confirmations.consume(confirm_token, hash);
        if (verdict !== "ok") {
          audit({ client: client(), tool: "ha_add_dashboard_card", target: label, allowed: false, reason: `confirm_token ${verdict}` });
          throw new Error(
            `confirm_token ${verdict}: ` +
              (verdict === "mismatch"
                ? "the dashboard changed since the confirmation (or the arguments differ); review and restart."
                : "request a fresh confirmation and try again.")
          );
        }
      }

      const newConfig = { ...config, views: views.map((v, i) => (i === idx ? newView : v)) };
      await ctx.ws.send("lovelace/config/save", { url_path: urlPath, config: newConfig });
      audit({ client: client(), tool: "ha_add_dashboard_card", target: label, allowed: true, before: baseHash.slice(0, 12) });
      return {
        updated: label,
        previous_view_yaml: beforeViewYaml,
        note: "Keep previous_view_yaml if you may want to revert this view; the add-on does not store it.",
      };
    })
  );

  server.registerTool(
    "ha_create_from_blueprint",
    {
      title: "Create from a blueprint",
      description:
        "Creates a NEW automation (or script) from an installed blueprint: the behaviour is already " +
        "written and vetted, only its typed inputs are filled. Discover blueprints and their inputs with " +
        "ha_list_blueprints. Same guarded two-step flow as ha_create_automation (YAML preview, " +
        "confirm_token, creation only).",
      inputSchema: {
        blueprint_path: z.string().describe("Blueprint path from ha_list_blueprints, e.g. homeassistant/motion_light.yaml"),
        alias: z.string().min(1).describe("Name of the new automation"),
        inputs: z.record(z.string(), z.unknown()).default({}).describe("Blueprint inputs; required ones must all be present"),
        domain: z.enum(["automation", "script"]).optional().describe("Default automation"),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe("ha_create_from_blueprint", async ({ blueprint_path, alias, inputs, domain, dry_run, confirm_token }) => {
      const kind = domain ?? "automation";
      // The blueprint must exist and its required inputs must all be there
      // BEFORE anything is offered; HA validates the values at write time.
      const list: Record<string, any> = (await ctx.ws.send("blueprint/list", { domain: kind })) ?? {};
      const bp = list[blueprint_path];
      if (!bp) {
        throw new Error(`unknown blueprint: ${blueprint_path}. List them with ha_list_blueprints (domain ${kind}).`);
      }
      const declared: Record<string, any> = bp?.metadata?.input ?? {};
      const missing = Object.entries(declared)
        .filter(([, def]) => !("default" in ((def ?? {}) as object)))
        .map(([name]) => name)
        .filter((name) => !(name in inputs));
      if (missing.length > 0) {
        throw new Error(`missing required blueprint inputs: ${missing.join(", ")}`);
      }
      const unknown = Object.keys(inputs).filter((k) => !(k in declared));
      if (unknown.length > 0) {
        throw new Error(`unknown blueprint inputs: ${unknown.join(", ")} (this blueprint declares: ${Object.keys(declared).join(", ")})`);
      }

      const objectId = slugify(alias);
      if (!objectId) throw new Error("the alias must contain at least one alphanumeric character");
      const payload: Record<string, unknown> = {
        alias,
        use_blueprint: { path: blueprint_path, input: inputs },
      };
      return guardedCreate({
        tool: "ha_create_from_blueprint",
        kind,
        payload,
        path: kind === "automation" ? `/config/automation/config/${Date.now()}` : `/config/script/config/${objectId}`,
        entityId: `${kind}.${objectId}`,
        skipWsValidation: true,
        dry_run,
        confirm_token,
      });
    })
  );

  // Root-level tuning keys (#158): variables is where non-trivial automation
  // logic lives; the others tune concurrency reporting, startup state and
  // tracing. HA validates the values at write time.
  const variablesSchema = z.record(z.string(), z.unknown());
  const maxExceededSchema = z.enum(["silent", "critical", "fatal", "error", "warning", "warn", "info", "debug", "notice"]);
  const traceSchema = z.object({ stored_traces: z.number().int().min(1).max(100) });

  server.registerTool(
    "ha_update_automation",
    {
      title: "Update an automation",
      description:
        "Updates an EXISTING UI-managed automation. Provided blocks replace the current ones wholesale " +
        "(a provided actions list replaces all actions). For blueprint-based automations, pass inputs " +
        "(replaces the whole use_blueprint input set) instead of raw blocks. Two-step: the first call " +
        "validates and returns a before/after diff plus a confirm_token; show the diff to the user, then " +
        "call again with the token. The success answer carries the previous YAML for manual rollback.",
      inputSchema: {
        entity_id: z.string().describe("E.g. automation.night_heating"),
        alias: z.string().optional(),
        description: z.string().optional(),
        mode: z.enum(["single", "restart", "queued", "parallel"]).optional(),
        triggers: freeObjects.min(1).optional(),
        conditions: freeObjects.optional(),
        actions: freeObjects.min(1).optional(),
        variables: variablesSchema.nullable().optional().describe("Root variables, replaced wholesale; null removes the key"),
        max_exceeded: maxExceededSchema.nullable().optional().describe("Log level when mode limit is hit; null removes the key"),
        initial_state: z.boolean().nullable().optional().describe("Forced enabled state at HA start; null removes the key"),
        trace: traceSchema.nullable().optional().describe("E.g. {stored_traces: 20}; null removes the key"),
        inputs: z.record(z.string(), z.unknown()).optional().describe("Blueprint automations only: replaces use_blueprint.input wholesale"),
        dry_run: z.boolean().optional().describe("true: return the diff preview only"),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe("ha_update_automation", async ({ entity_id, alias, description, mode, triggers, conditions, actions, variables, max_exceeded, initial_state, trace, inputs, dry_run, confirm_token }) => {
      if (!entity_id.startsWith("automation.")) throw new Error(`expected an automation.* entity_id, got: ${entity_id}`);
      return guardedUpdate({
        tool: "ha_update_automation",
        kind: "automation",
        entityId: entity_id,
        patch: { alias, description, mode, triggers, conditions, actions, variables, max_exceeded, initial_state, trace },
        blueprintInputs: inputs,
        dry_run,
        confirm_token,
      });
    })
  );

  server.registerTool(
    "ha_update_script",
    {
      title: "Update a script",
      description:
        "Updates an EXISTING UI-managed script, same guarded two-step flow as ha_update_automation " +
        "(wholesale block replacement, blueprint inputs supported, before/after diff, previous YAML " +
        "returned for rollback).",
      inputSchema: {
        entity_id: z.string().describe("E.g. script.movie_night"),
        alias: z.string().optional(),
        description: z.string().optional(),
        mode: z.enum(["single", "restart", "queued", "parallel"]).optional(),
        sequence: freeObjects.min(1).optional(),
        variables: variablesSchema.nullable().optional().describe("Root variables, replaced wholesale; null removes the key"),
        max_exceeded: maxExceededSchema.nullable().optional().describe("Log level when mode limit is hit; null removes the key"),
        trace: traceSchema.nullable().optional().describe("E.g. {stored_traces: 20}; null removes the key"),
        inputs: z.record(z.string(), z.unknown()).optional().describe("Blueprint scripts only: replaces use_blueprint.input wholesale"),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe("ha_update_script", async ({ entity_id, alias, description, mode, sequence, variables, max_exceeded, trace, inputs, dry_run, confirm_token }) => {
      if (!entity_id.startsWith("script.")) throw new Error(`expected a script.* entity_id, got: ${entity_id}`);
      return guardedUpdate({
        tool: "ha_update_script",
        kind: "script",
        entityId: entity_id,
        patch: { alias, description, mode, sequence, variables, max_exceeded, trace },
        blueprintInputs: inputs,
        dry_run,
        confirm_token,
      });
    })
  );

  server.registerTool(
    "ha_create_automation",
    {
      title: "Create an automation",
      description:
        "Creates a NEW automation (never modifies existing ones). Two-step: the first call validates the " +
        "config with Home Assistant and returns the full YAML plus a confirm_token; show the YAML to the " +
        "user, then call again with the same arguments plus the token. Use the propose-automation prompt " +
        "first to draft with verified entities. dry_run: true previews the YAML only.",
      inputSchema: {
        alias: z.string().min(1).describe("Automation name, e.g. 'Hallway light on motion'"),
        description: z.string().optional(),
        mode: z.enum(["single", "restart", "queued", "parallel"]).optional().describe("Default single"),
        triggers: freeObjects.min(1).describe("Trigger list, modern syntax (e.g. [{trigger: 'state', entity_id: '...'}])"),
        conditions: freeObjects.optional(),
        actions: freeObjects.min(1).describe("Action list (e.g. [{action: 'light.turn_on', target: {...}}])"),
        variables: variablesSchema.optional().describe("Root variables available to all templates (#158)"),
        max_exceeded: maxExceededSchema.optional().describe("Log level when the mode limit is hit"),
        dry_run: z.boolean().optional().describe("true: return the YAML preview only"),
        confirm_token: z.string().optional().describe("Token from the confirmation_required answer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe("ha_create_automation", async ({ alias, description, mode, triggers, conditions, actions, variables, max_exceeded, dry_run, confirm_token }) => {
      const payload: Record<string, unknown> = {
        alias,
        ...(description ? { description } : {}),
        mode: mode ?? "single",
        ...(variables ? { variables } : {}),
        ...(max_exceeded ? { max_exceeded } : {}),
        triggers,
        ...(conditions && conditions.length > 0 ? { conditions } : {}),
        actions,
      };
      return guardedCreate({
        tool: "ha_create_automation",
        kind: "automation",
        payload,
        path: `/config/automation/config/${Date.now()}`,
        entityId: `automation.${slugify(alias)}`,
        dry_run,
        confirm_token,
      });
    })
  );

  server.registerTool(
    "ha_create_script",
    {
      title: "Create a script",
      description:
        "Creates a NEW script (never modifies existing ones). Same two-step confirmation as " +
        "ha_create_automation: validate, show the YAML to the user, confirm with the token. " +
        "Use the propose-script prompt first to draft with verified entities.",
      inputSchema: {
        alias: z.string().min(1).describe("Script name, e.g. 'Movie night'"),
        description: z.string().optional(),
        mode: z.enum(["single", "restart", "queued", "parallel"]).optional().describe("Default single"),
        sequence: freeObjects.min(1).describe("Action sequence (e.g. [{action: 'light.turn_off', target: {...}}])"),
        variables: variablesSchema.optional().describe("Root variables available to all templates (#158)"),
        max_exceeded: maxExceededSchema.optional().describe("Log level when the mode limit is hit"),
        dry_run: z.boolean().optional().describe("true: return the YAML preview only"),
        confirm_token: z.string().optional().describe("Token from the confirmation_required answer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe("ha_create_script", async ({ alias, description, mode, sequence, variables, max_exceeded, dry_run, confirm_token }) => {
      const objectId = slugify(alias);
      if (!objectId) throw new Error("the alias must contain at least one alphanumeric character");
      const payload: Record<string, unknown> = {
        alias,
        ...(description ? { description } : {}),
        mode: mode ?? "single",
        ...(variables ? { variables } : {}),
        ...(max_exceeded ? { max_exceeded } : {}),
        sequence,
      };
      return guardedCreate({
        tool: "ha_create_script",
        kind: "script",
        payload,
        path: `/config/script/config/${objectId}`,
        entityId: `script.${objectId}`,
        dry_run,
        confirm_token,
      });
    })
  );
}
