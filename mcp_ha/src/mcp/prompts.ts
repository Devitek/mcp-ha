import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Reusable prompt recipes (v0.3, #79): they encode proven tool workflows so
 * any client can run them without rediscovering the right call order.
 * Prompt arguments are strings per the MCP specification.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "diagnose-automation",
    {
      title: "Diagnose an automation",
      description: "Investigates why an automation did not run (or ran unexpectedly).",
      argsSchema: { automation: z.string().describe("Automation entity_id, e.g. automation.night_heating") },
    },
    ({ automation }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Diagnose the Home Assistant automation "${automation}". Proceed step by step:\n` +
              `1. ha_get_automation on "${automation}": is it enabled? When did it last trigger? Read its triggers, conditions and actions.\n` +
              `1b. ha_get_automation_trace on "${automation}": the recent runs and, for the most relevant one, the step-by-step detail (condition verdicts, errors). This often answers the question directly.\n` +
              `2. ha_get_logbook filtered on "${automation}" over the relevant window: did it fire, and what happened around it?\n` +
              "3. For each entity referenced by its triggers and conditions, check the current state (ha_get_entity) and the recent history (ha_get_history) to see whether the trigger condition was ever met.\n" +
              "4. Conclude: state clearly whether the automation is disabled, never triggered, triggered but blocked by a condition, or failed in its actions, and what to change.",
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "health-report",
    {
      title: "Instance health report",
      description: "Guided reading of ha_get_health: prioritize, explain, and propose remediations.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Run a health check of my Home Assistant instance. Proceed step by step:\n" +
              "1. Call ha_get_health.\n" +
              "2. Start with the repairs section: these are Home Assistant's own diagnostics, treat 'error' severity first.\n" +
              "3. Then the long-unavailable entities: for the oldest ones, check the device (ha_get_entity, ha_list_devices) and suggest causes (battery dead, integration down, device removed).\n" +
              "4. List the low batteries worth replacing soon, worst first.\n" +
              "5. For enabled automations that have not fired in a long time, use ha_get_automation_trace to see whether they ever ran and why not; some may be seasonal, say so instead of flagging them.\n" +
              "6. Conclude with a short prioritized action list; do not execute anything without asking.",
          },
        },
      ],
    })
  );

  // Proposal prompts (#94, tier 2): the assistant DRAFTS a complete YAML
  // that the user pastes into the HA editor. Zero new permission, the write
  // stays in human hands.
  server.registerPrompt(
    "propose-automation",
    {
      title: "Propose an automation",
      description: "Drafts a complete, paste-ready automation YAML for a stated goal, without writing anything.",
      argsSchema: { goal: z.string().describe("What the automation should do, in plain words") },
    },
    ({ goal }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Draft a Home Assistant automation for this goal: "${goal}". Proceed step by step:\n` +
              "1. Find the real entities involved with ha_search_entities / ha_list_entities, and check their current state and attributes (ha_get_entity) so triggers use values that actually exist.\n" +
              "2. If a similar automation exists (ha_list_automations, ha_get_automation), reuse its conventions.\n" +
              "3. Write the complete YAML: alias, description, mode, triggers, conditions (only if truly needed) and actions, using the verified entity_ids. Prefer simple, readable constructs.\n" +
              "4. Present the YAML in one block, explain in two sentences what it does and when it fires, and remind me to paste it in Settings > Automations & scenes > Create automation > Edit in YAML.\n" +
              "Do NOT create or modify anything in Home Assistant yourself.",
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "propose-script",
    {
      title: "Propose a script",
      description: "Drafts a complete, paste-ready script YAML for a stated goal, without writing anything.",
      argsSchema: { goal: z.string().describe("What the script should do, in plain words") },
    },
    ({ goal }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Draft a Home Assistant script for this goal: "${goal}". Proceed step by step:\n` +
              "1. Find the real entities involved with ha_search_entities / ha_list_entities and verify their domains and attributes (ha_get_entity).\n" +
              "2. If similar scripts exist (ha_list_scripts), reuse their conventions.\n" +
              "3. Write the complete YAML: alias, description, mode and the sequence, using the verified entity_ids and correct service data.\n" +
              "4. Present the YAML in one block, explain in two sentences what it does, and remind me to paste it in Settings > Automations & scenes > Scripts > Create script > Edit in YAML.\n" +
              "Do NOT create or modify anything in Home Assistant yourself.",
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "energy-report",
    {
      title: "Energy report",
      description: "Summarizes energy consumption over a time window using long-term statistics.",
      argsSchema: {
        hours: z.string().optional().describe("Window in hours, default 24 (e.g. 168 for a week)"),
      },
    },
    ({ hours }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Build an energy report for the last ${hours ?? "24"} hours. Proceed step by step:\n` +
              "1. Call ha_get_energy first (period day or week, compare: true when a comparison helps): it reads the exact statistics the energy dashboard is configured with.\n" +
              "2. Only if the dashboard is not configured, fall back to ha_list_entities (domain 'sensor', search 'energy'/'power'/'consumption') and ha_get_statistics on the most relevant ids.\n" +
              "3. Summarize: totals per source, the comparison if requested, and the biggest consumers. Keep the numbers honest: name the statistics you used.",
          },
        },
      ],
    })
  );
}
