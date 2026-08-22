import { z } from "zod";
import { stringify } from "yaml";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import { safe } from "../helpers.js";
import { ConfirmationStore } from "../../confirm.js";
import { audit } from "../../logger.js";

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
      await validateBlocks(req.kind, req.payload);
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
          expires_in_seconds: 120,
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
    dry_run?: boolean | undefined;
    confirm_token?: string | undefined;
  }

  async function currentConfig(kind: "automation" | "script", entityId: string): Promise<{ config: Record<string, unknown>; path: string }> {
    const e = (await ctx.catalog.index()).find((x) => x.entity_id === entityId);
    if (!e) throw new Error(`unknown ${kind}: ${entityId}. Use ha_search_entities to find the right id.`);
    let path: string;
    if (kind === "automation") {
      const cfgId = e.attributes.id;
      if (typeof cfgId !== "string" || !cfgId) {
        throw new Error("this automation has no configuration id (YAML-defined): modification is only possible for UI-managed ones");
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
        throw new Error(`no stored configuration for ${entityId} (YAML-defined): modification is only possible for UI-managed ones`);
      }
      throw err;
    }
  }

  async function guardedUpdate(req: UpdateRequest): Promise<unknown> {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.patch)) if (v !== undefined) patch[k] = v;
    if (Object.keys(patch).length === 0) {
      throw new Error("nothing to change: provide at least one field (alias, description, mode, triggers, conditions, actions/sequence)");
    }
    const { config: before, path } = await currentConfig(req.kind, req.entityId);
    const final: Record<string, unknown> = { ...before, ...patch };
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
      await validateBlocks(req.kind, final);
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
          expires_in_seconds: 120,
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

  server.registerTool(
    "ha_update_automation",
    {
      title: "Update an automation",
      description:
        "Updates an EXISTING UI-managed automation. Provided blocks replace the current ones wholesale " +
        "(a provided actions list replaces all actions). Two-step: the first call validates and returns a " +
        "before/after diff plus a confirm_token; show the diff to the user, then call again with the token. " +
        "The success answer carries the previous YAML for manual rollback.",
      inputSchema: {
        entity_id: z.string().describe("E.g. automation.night_heating"),
        alias: z.string().optional(),
        description: z.string().optional(),
        mode: z.enum(["single", "restart", "queued", "parallel"]).optional(),
        triggers: freeObjects.min(1).optional(),
        conditions: freeObjects.optional(),
        actions: freeObjects.min(1).optional(),
        dry_run: z.boolean().optional().describe("true: return the diff preview only"),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe("ha_update_automation", async ({ entity_id, alias, description, mode, triggers, conditions, actions, dry_run, confirm_token }) => {
      if (!entity_id.startsWith("automation.")) throw new Error(`expected an automation.* entity_id, got: ${entity_id}`);
      return guardedUpdate({
        tool: "ha_update_automation",
        kind: "automation",
        entityId: entity_id,
        patch: { alias, description, mode, triggers, conditions, actions },
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
        "(wholesale block replacement, before/after diff, previous YAML returned for rollback).",
      inputSchema: {
        entity_id: z.string().describe("E.g. script.movie_night"),
        alias: z.string().optional(),
        description: z.string().optional(),
        mode: z.enum(["single", "restart", "queued", "parallel"]).optional(),
        sequence: freeObjects.min(1).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe("ha_update_script", async ({ entity_id, alias, description, mode, sequence, dry_run, confirm_token }) => {
      if (!entity_id.startsWith("script.")) throw new Error(`expected a script.* entity_id, got: ${entity_id}`);
      return guardedUpdate({
        tool: "ha_update_script",
        kind: "script",
        entityId: entity_id,
        patch: { alias, description, mode, sequence },
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
        dry_run: z.boolean().optional().describe("true: return the YAML preview only"),
        confirm_token: z.string().optional().describe("Token from the confirmation_required answer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe("ha_create_automation", async ({ alias, description, mode, triggers, conditions, actions, dry_run, confirm_token }) => {
      const payload: Record<string, unknown> = {
        alias,
        ...(description ? { description } : {}),
        mode: mode ?? "single",
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
        dry_run: z.boolean().optional().describe("true: return the YAML preview only"),
        confirm_token: z.string().optional().describe("Token from the confirmation_required answer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe("ha_create_script", async ({ alias, description, mode, sequence, dry_run, confirm_token }) => {
      const objectId = slugify(alias);
      if (!objectId) throw new Error("the alias must contain at least one alphanumeric character");
      const payload: Record<string, unknown> = {
        alias,
        ...(description ? { description } : {}),
        mode: mode ?? "single",
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
