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
              `2. ha_get_logbook filtered on "${automation}" over the relevant window: did it fire, and what happened around it?\n` +
              "3. For each entity referenced by its triggers and conditions, check the current state (ha_get_entity) and the recent history (ha_get_history) to see whether the trigger condition was ever met.\n" +
              "4. Conclude: state clearly whether the automation is disabled, never triggered, triggered but blocked by a condition, or failed in its actions, and what to change.",
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
              "1. ha_list_entities with domain: 'sensor' and search: 'energy' (also try 'power' and 'consumption') to find the relevant sensors.\n" +
              `2. ha_get_statistics on the most relevant statistic ids with period 'hour' (or 'day' for long windows) over ${hours ?? "24"} hours.\n` +
              "3. Summarize: total consumption, peak periods, and the biggest consumers if per-device sensors exist. Use the unit from the sensor attributes and keep the numbers honest: name the sensors you used.",
          },
        },
      ],
    })
  );
}
