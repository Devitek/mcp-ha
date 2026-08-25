import { z } from "zod";
import type { ToolRegistrar } from "../registry.js";
import type { ToolContext } from "../../context.js";
import { safe } from "../helpers.js";
import { guardedServiceCall } from "../writeflow.js";

/**
 * Dedicated write tools (v0.2, issue #15): safer and more legible for the
 * LLM than a raw ha_call_service, with constrained parameters. They all go
 * through the exact same guarded write path (lists, dry run, two-step
 * confirmation, audit). Only registered when allow_write is enabled.
 */
export function registerWriteTools(server: ToolRegistrar, ctx: ToolContext): void {
  // Gated by allow_write and by the token scope (#85).

  const requireDomain = (entityId: string, domain: string): void => {
    if (!entityId.startsWith(`${domain}.`)) {
      throw new Error(`expected a ${domain}.* entity_id, got: ${entityId}`);
    }
  };

  server.registerTool(
    "ha_run_script",
    {
      title: "Run a script",
      description:
        "Runs a Home Assistant script, optionally with variables. Find scripts with ha_list_scripts. " +
        "Use dry_run: true to preview without executing. Subject to the configured allow/deny lists.",
      inputSchema: {
        entity_id: z.string().describe("E.g. script.wake_up"),
        variables: z.record(z.string(), z.any()).optional().describe("Variables passed to the script"),
        dry_run: z.boolean().optional().describe("true: preview without executing"),
        confirm_token: z.string().optional().describe("Token from a previous confirmation_required answer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe("ha_run_script", async ({ entity_id, variables, dry_run, confirm_token }) => {
      requireDomain(entity_id, "script");
      return guardedServiceCall(ctx, {
        tool: "ha_run_script",
        domain: "script",
        service: "turn_on",
        target: { entity_id },
        data: variables ? { variables } : undefined,
        dry_run,
        confirm_token,
      });
    })
  );

  server.registerTool(
    "ha_trigger_automation",
    {
      title: "Trigger an automation",
      description:
        "Triggers a Home Assistant automation now. By default its conditions are skipped " +
        "(skip_condition: true), pass false to honour them. Find automations with ha_list_automations. " +
        "Use dry_run: true to preview without executing.",
      inputSchema: {
        entity_id: z.string().describe("E.g. automation.night_heating"),
        skip_condition: z.boolean().optional().describe("Default true: run the actions even if conditions do not hold"),
        dry_run: z.boolean().optional().describe("true: preview without executing"),
        confirm_token: z.string().optional().describe("Token from a previous confirmation_required answer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe("ha_trigger_automation", async ({ entity_id, skip_condition, dry_run, confirm_token }) => {
      requireDomain(entity_id, "automation");
      return guardedServiceCall(ctx, {
        tool: "ha_trigger_automation",
        domain: "automation",
        service: "trigger",
        target: { entity_id },
        data: { skip_condition: skip_condition ?? true },
        dry_run,
        confirm_token,
      });
    })
  );

  server.registerTool(
    "ha_set_automation",
    {
      title: "Enable or disable an automation",
      description:
        "Enables or disables a Home Assistant automation. Find automations with ha_list_automations. " +
        "Use dry_run: true to preview without executing.",
      inputSchema: {
        entity_id: z.string().describe("E.g. automation.night_heating"),
        enabled: z.boolean().describe("true to enable, false to disable"),
        dry_run: z.boolean().optional().describe("true: preview without executing"),
        confirm_token: z.string().optional().describe("Token from a previous confirmation_required answer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe("ha_set_automation", async ({ entity_id, enabled, dry_run, confirm_token }) => {
      requireDomain(entity_id, "automation");
      return guardedServiceCall(ctx, {
        tool: "ha_set_automation",
        domain: "automation",
        service: enabled ? "turn_on" : "turn_off",
        target: { entity_id },
        dry_run,
        confirm_token,
      });
    })
  );
}
