import { z } from "zod";
import type { ToolRegistrar } from "../registry.js";
import type { ToolContext } from "../../context.js";
import { safe, toIso } from "../helpers.js";
import { entityReadVisible } from "../../safety.js";

/** How far the cause chain is followed; real chains are 2-3 hops. */
const MAX_DEPTH = 4;
/** Logbook window around the moment to explain. */
const BEFORE_MS = 5 * 60_000;
const AFTER_MS = 60_000;

interface LogEntry {
  when?: unknown;
  name?: unknown;
  message?: unknown;
  state?: unknown;
  entity_id?: unknown;
  context_entity_id?: unknown;
  context_entity_id_name?: unknown;
  context_domain?: unknown;
  context_service?: unknown;
  context_event_type?: unknown;
  context_message?: unknown;
  context_user_id?: unknown;
}

/**
 * Causality by context (#124): "who turned this light on?" has an exact
 * answer in HA. The logbook enriches every entry with context_* fields
 * pointing to the immediate cause; following them a few hops yields the
 * human, the automation and the physical trigger.
 */
export function registerExplainTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    "ha_explain_event",
    {
      title: "Explain an event",
      description:
        "Explains WHY an entity changed: follows the Home Assistant context chain (who or what caused it, " +
        "what triggered that in turn). Without 'at': explains the entity's last change. The missing link " +
        "between the logbook (what happened) and ha_get_automation_trace (how the automation ran).",
      inputSchema: {
        entity_id: z.string().describe("The entity whose change to explain"),
        at: z.string().optional().describe("ISO 8601 moment to explain; default: the last change"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_explain_event", async ({ entity_id, at }) => {
      if (!entityReadVisible(ctx.cfg, entity_id)) {
        throw new Error(`entity ${entity_id} is not accessible (filter_reads)`);
      }
      let moment = at ? Date.parse(at) : NaN;
      if (at && !Number.isFinite(moment)) throw new Error(`invalid ISO 8601 date: ${at}`);
      const index = await ctx.catalog.index();
      if (!at) {
        const e = index.find((x) => x.entity_id === entity_id);
        if (!e) throw new Error(`unknown entity: ${entity_id}`);
        moment = Date.parse(e.last_changed);
        if (!Number.isFinite(moment)) throw new Error(`no last change recorded for ${entity_id}`);
      }

      // Resolving a user id needs no admin rights (#134): person entities
      // carry their linked user_id as an attribute, and the catalog is
      // already cached. Hidden persons do not resolve: causality must not
      // leak identities past filter_reads.
      const personByUserId = new Map(
        index
          .filter((e) => e.domain === "person" && entityReadVisible(ctx.cfg, e.entity_id) && typeof e.attributes.user_id === "string")
          .map((e) => [String(e.attributes.user_id), e])
      );
      const userInfo = (userId: string): Record<string, unknown> => {
        const p = personByUserId.get(userId);
        return p
          ? { user: p.name, person: p.entity_id, user_id: userId }
          : {
              user_id: userId,
              user_note: "a Home Assistant user without a linked visible person; resolving the name would need admin rights",
            };
      };

      const fetchAround = async (id: string): Promise<LogEntry[]> =>
        ((await ctx.ws.send("logbook/get_events", {
          start_time: new Date(moment - BEFORE_MS).toISOString(),
          end_time: new Date(moment + AFTER_MS).toISOString(),
          entity_ids: [id],
        })) ?? []) as LogEntry[];

      const closest = (entries: LogEntry[]): LogEntry | null => {
        let best: LogEntry | null = null;
        let bestDist = Infinity;
        for (const e of entries) {
          const t = typeof e.when === "number" ? (e.when > 1e12 ? e.when : e.when * 1000) : Date.parse(String(e.when ?? ""));
          if (!Number.isFinite(t)) continue;
          const d = Math.abs(t - moment);
          if (d < bestDist) {
            bestDist = d;
            best = e;
          }
        }
        return best;
      };

      const chain: Array<Record<string, unknown>> = [];
      const seen = new Set<string>([entity_id]);
      let currentId = entity_id;

      for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const entry = closest(await fetchAround(currentId));
        if (!entry) {
          if (depth === 0) {
            return {
              entity_id,
              at: new Date(moment).toISOString(),
              chain: [],
              note: "No recorded cause: nothing in the logbook around that moment (purged history, or a low-level integration without context).",
            };
          }
          break;
        }
        chain.push({
          entity_id: currentId,
          when: toIso(entry.when),
          ...(entry.state !== undefined ? { state: entry.state } : {}),
          ...(entry.message ? { message: String(entry.message) } : {}),
          ...(entry.context_message ? { context_message: String(entry.context_message) } : {}),
          ...(entry.context_service ? { via_service: `${entry.context_domain ?? "?"}.${entry.context_service}` } : {}),
          ...(entry.context_user_id ? userInfo(String(entry.context_user_id)) : {}),
        });

        const actor = typeof entry.context_entity_id === "string" ? entry.context_entity_id : null;
        if (!actor || seen.has(actor)) break;
        if (!entityReadVisible(ctx.cfg, actor)) {
          chain.push({ actor: "(hidden entity)", note: "the cause is hidden by filter_reads; the chain stops here" });
          break;
        }
        chain.push({
          caused_by: actor,
          ...(entry.context_entity_id_name ? { name: String(entry.context_entity_id_name) } : {}),
        });
        seen.add(actor);
        currentId = actor;
      }

      return {
        entity_id,
        at: new Date(moment).toISOString(),
        chain,
        note:
          chain.some((c) => String(c.caused_by ?? "").startsWith("automation.")) ?
            "An automation is in the chain: ha_get_automation_trace on it gives the step-by-step detail."
          : "Chain built from Home Assistant's context records around that moment.",
      };
    })
  );
}
