import { z } from "zod";
import type { ToolRegistrar } from "../registry.js";
import type { ToolContext } from "../../context.js";
import { listEnvelope, safe, trunc } from "../helpers.js";
import { entityReadVisible } from "../../safety.js";
import { log } from "../../logger.js";

export function registerAutomationTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    "ha_list_automations",
    {
      title: "List automations",
      description:
        "All automations: entity_id, name, state (on = enabled), last trigger time, and source " +
        "(ui = editable via the config tools, yaml = defined in the user's files, read/trace only). " +
        "include_config: true attaches each UI automation's full configuration (page size drops to " +
        "5, max 10): the paginated way to export or diff a fleet. For one automation use ha_get_automation.",
      inputSchema: {
        include_config: z.boolean().optional().describe("Attach each UI automation's config; yaml ones get config: null"),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_list_automations", async ({ include_config, limit, offset }) => {
      const entities = (await ctx.catalog.index()).filter(
        (e) => e.domain === "automation" && entityReadVisible(ctx.cfg, e.entity_id)
      );
      const all = entities.map((e) => ({
        entity_id: e.entity_id,
        name: e.name,
        enabled: e.state === "on",
        last_triggered: (e.attributes.last_triggered as string | null) ?? null,
        // "ui" means editable through the config tools; "yaml" lives in the
        // user's files and only ha_get_automation_trace works on it (#156).
        source: typeof e.attributes.id === "string" && e.attributes.id ? "ui" : "yaml",
      }));
      // Bulk read (#160): the configs travel through the agent's context, so
      // the page shrinks (default 5, max 10) and pagination is the guard.
      if (!include_config) return listEnvelope(all, limit ?? 100, offset ?? 0);
      const envelope = listEnvelope(
        all,
        Math.min(limit ?? 5, 10),
        offset ?? 0,
        "Page size is capped at 10 with include_config. A config too large for the page is omitted per item (config_omitted): fetch it individually with ha_get_automation."
      );
      const byId = new Map(entities.map((e) => [e.entity_id, e]));
      const items = envelope.items as Array<Record<string, unknown>>;
      await Promise.all(
        items.map(async (item) => {
          const cfgId = byId.get(item.entity_id as string)?.attributes.id;
          if (typeof cfgId !== "string" || !cfgId) {
            item.config = null; // YAML-defined: skip on purpose, source says why
            return;
          }
          try {
            item.config = await ctx.http.coreGet(`/config/automation/config/${encodeURIComponent(cfgId)}`);
          } catch (e) {
            // Same doctrine as ha_get_automation (audit B7): no raw HTTP
            // errors in the page, and a fetch failure must not sink it.
            log.warning(`Bulk config fetch failed for ${item.entity_id}: ${e instanceof Error ? e.message : e}`);
            item.config = null;
            item.config_note = "config not readable right now (Home Assistant API error)";
          }
        })
      );
      // The page must stay VALID JSON: never truncate a config mid-value.
      // When the page would blow the response cap, drop whole configs,
      // biggest first, until it fits.
      const PAGE_BUDGET_BYTES = 14_000;
      while (Buffer.byteLength(JSON.stringify(envelope), "utf8") > PAGE_BUDGET_BYTES) {
        const biggest = items
          .filter((i) => i.config)
          .sort((a, b) => JSON.stringify(b.config).length - JSON.stringify(a.config).length)[0];
        if (!biggest) break;
        delete biggest.config;
        biggest.config_omitted = "too large for the page, fetch it individually with ha_get_automation";
      }
      return envelope;
    })
  );

  server.registerTool(
    "ha_get_automation",
    {
      title: "Automation details",
      description:
        "State of one automation and, when it was created through the UI, its full configuration " +
        "(triggers, conditions, actions). YAML-defined automations only return their state.",
      inputSchema: {
        entity_id: z.string().describe("E.g. automation.night_heating"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_automation", async ({ entity_id }) => {
      if (!entityReadVisible(ctx.cfg, entity_id)) {
        throw new Error(`entity ${entity_id} is not accessible (filter_reads)`);
      }
      const all = await ctx.catalog.index();
      const e = all.find((x) => x.entity_id === entity_id && x.domain === "automation");
      if (!e) throw new Error(`unknown automation: ${entity_id}`);

      const base = {
        entity_id: e.entity_id,
        name: e.name,
        enabled: e.state === "on",
        last_triggered: (e.attributes.last_triggered as string | null) ?? null,
        mode: (e.attributes.mode as string | undefined) ?? undefined,
      };

      const cfgId = e.attributes.id;
      if (typeof cfgId !== "string" || !cfgId) {
        return { ...base, note: "No configuration id: probably a YAML-defined automation, config not readable." };
      }
      try {
        const config = await ctx.http.coreGet(`/config/automation/config/${encodeURIComponent(cfgId)}`);
        return { ...base, config };
      } catch (e) {
        // A 404 is the normal YAML case; anything else is a real failure and
        // must not be disguised as one (audit B7).
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("HTTP 404")) {
          return { ...base, note: "No stored configuration (YAML-defined automation)." };
        }
        log.warning(`Could not fetch the automation config for ${entity_id}: ${msg}`);
        return { ...base, note: "Configuration not readable right now (Home Assistant API error); the state above is still accurate." };
      }
    }, {
      // One config is not a fleet dump (#159): the raised cap lets every
      // reasonable automation round-trip into ha_update_automation intact.
      // Per-value truncation is deliberately refused: a truncated block fed
      // back to an update would write a corrupted config.
      maxBytes: 64_000,
      truncationNote:
        "This single configuration exceeds even the raised cap: it carries an unusually large inline payload (such as base64 media in an action). There is nothing to filter here; edit that automation in the Home Assistant UI instead, the config tools cannot round-trip it safely.",
    })
  );

  server.registerTool(
    "ha_get_automation_trace",
    {
      title: "Automation execution trace",
      description:
        "Step-by-step record of recent automation or script runs: which trigger fired, how each " +
        "condition evaluated, which actions ran, and any error. Without run_id: the list of recent " +
        "runs. With run_id: the detailed step path of that run. The first reflex to answer " +
        "'why did this fire (or not)?'.",
      inputSchema: {
        entity_id: z.string().describe("automation.* or script.* entity"),
        run_id: z.string().optional().describe("A run from the list, for the detailed steps"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_automation_trace", async ({ entity_id, run_id }) => {
      if (!entityReadVisible(ctx.cfg, entity_id)) {
        throw new Error(`entity ${entity_id} is not accessible (filter_reads)`);
      }
      const domain = entity_id.split(".")[0] ?? "";
      if (domain !== "automation" && domain !== "script") {
        throw new Error(`expected an automation.* or script.* entity_id, got: ${entity_id}`);
      }
      // trace/* wants the config item id, not the entity_id: for automations
      // it is the `id` attribute, for scripts the object id after the dot.
      let itemId: string;
      if (domain === "automation") {
        const e = (await ctx.catalog.index()).find((x) => x.entity_id === entity_id);
        if (!e) throw new Error(`unknown automation: ${entity_id}`);
        const cfgId = e.attributes.id;
        if (typeof cfgId !== "string" || !cfgId) {
          throw new Error("this automation has no configuration id (YAML-defined without id:): traces are not addressable");
        }
        itemId = cfgId;
      } else {
        itemId = entity_id.slice("script.".length);
      }

      if (!run_id) {
        const raw: any[] = (await ctx.ws.send("trace/list", { domain, item_id: itemId })) ?? [];
        const runs = raw.map((r) => ({
          run_id: String(r.run_id ?? ""),
          start: r.timestamp?.start ?? null,
          finish: r.timestamp?.finish ?? null,
          state: r.state ?? null,
          ...(r.script_execution ? { result: r.script_execution } : {}),
          ...(r.trigger ? { trigger: trunc(String(r.trigger), 200) } : {}),
          ...(r.last_step ? { last_step: r.last_step } : {}),
          ...(r.error ? { error: trunc(String(r.error), 300) } : {}),
        }));
        return {
          entity_id,
          runs,
          total: runs.length,
          note:
            runs.length > 0
              ? "Home Assistant keeps only the last few runs in memory. Pass run_id for the step-by-step detail."
              : "No stored run: it did not fire since the last Home Assistant restart.",
        };
      }

      const detail: any = await ctx.ws.send("trace/get", { domain, item_id: itemId, run_id });
      // detail.trace maps step paths (trigger/0, condition/0, action/1...) to
      // arrays of executions. Flatten, order by time, and DROP the variables:
      // they embed other entities' states (filter_reads bypass) and weigh a
      // lot; the path, verdicts and errors carry the diagnosis.
      const steps: Array<Record<string, unknown>> = [];
      for (const [path, entries] of Object.entries((detail?.trace ?? {}) as Record<string, any[]>)) {
        for (const s of entries ?? []) {
          steps.push({
            path,
            t: s?.timestamp ?? null,
            ...(s?.result !== undefined ? { result: s.result } : {}),
            ...(s?.error ? { error: trunc(String(s.error), 300) } : {}),
          });
        }
      }
      steps.sort((a, b) => String(a.t ?? "").localeCompare(String(b.t ?? "")));
      return {
        entity_id,
        run_id,
        state: detail?.state ?? null,
        ...(detail?.script_execution ? { result: detail.script_execution } : {}),
        ...(detail?.error ? { error: trunc(String(detail.error), 300) } : {}),
        steps,
        note: "Variables are omitted on purpose (size and privacy); condition results carry the verdicts.",
      };
    })
  );

  server.registerTool(
    "ha_list_scripts",
    {
      title: "List scripts",
      description:
        "All scripts: entity_id, name, last trigger time, state (on = currently running).",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_list_scripts", async ({ limit, offset }) => {
      const all = (await ctx.catalog.index())
        .filter((e) => e.domain === "script" && entityReadVisible(ctx.cfg, e.entity_id))
        .map((e) => ({
          entity_id: e.entity_id,
          name: e.name,
          running: e.state === "on",
          last_triggered: (e.attributes.last_triggered as string | null) ?? null,
        }));
      return listEnvelope(all, limit ?? 100, offset ?? 0);
    })
  );
}
