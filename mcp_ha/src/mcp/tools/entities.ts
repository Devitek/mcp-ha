import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../context.js";
import type { IndexedEntity } from "../../types.js";
import { listEnvelope, safe, trunc } from "../helpers.js";
import { entityReadVisible } from "../../safety.js";

/** Compact projection used by every entity list. */
function summary(e: IndexedEntity) {
  return {
    entity_id: e.entity_id,
    name: e.name,
    state: e.state,
    area: e.area,
    last_changed: e.last_changed,
  };
}

function matchQuery(e: IndexedEntity, query: string): number {
  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(Boolean);
  const id = e.entity_id.toLowerCase();
  const name = e.name.toLowerCase();
  const area = (e.area ?? "").toLowerCase();
  // Aliases are deliberate alternative names (Assist), so they weigh like
  // the name; labels and floor weigh like the area (#89).
  const aliases = e.aliases.map((a) => a.toLowerCase());
  const labels = e.labels.map((l) => l.toLowerCase());
  const floor = (e.floor ?? "").toLowerCase();
  if (id === q) return 100;
  let score = 0;
  for (const t of tokens) {
    if (id.includes(t)) score += 5;
    else if (name.includes(t) || aliases.some((a) => a.includes(t))) score += 4;
    else if (area.includes(t) || floor.includes(t) || labels.some((l) => l.includes(t))) score += 2;
    else return 0; // every word must match somewhere
  }
  return score;
}

export function registerEntityTools(server: McpServer, ctx: ToolContext): void {
  const visible = async (): Promise<IndexedEntity[]> =>
    (await ctx.catalog.index()).filter((e) => entityReadVisible(ctx.cfg, e.entity_id));

  server.registerTool(
    "ha_search_entities",
    {
      title: "Search entities",
      description:
        "Fuzzy search of Home Assistant entities by name, entity_id, alias (Assist), area, floor or label. " +
        "Use this first to find the right entity_id (e.g. query: 'kitchen light'). " +
        "Follow up with ha_get_entity for full details.",
      inputSchema: {
        query: z.string().min(1).describe("Search terms (name, id, alias, area, floor, label)"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results, default 20"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_search_entities", async ({ query, limit }) => {
      const all = await visible();
      const scored = all
        .map((e) => ({ e, score: matchQuery(e, query) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => summary(x.e));
      return listEnvelope(
        scored,
        limit ?? 20,
        0,
        scored.length === 0 ? "No result, try other words or ha_list_entities with a domain filter." : undefined
      );
    })
  );

  server.registerTool(
    "ha_list_entities",
    {
      title: "List entities",
      description:
        "Paginated compact list of entities, filterable by domain (light, sensor, switch, automation...), " +
        "area (room name), floor, label, search and state. With no filter at all it returns a histogram " +
        "per domain and per area instead of a full dump: filter to get actual entities.",
      inputSchema: {
        domain: z.string().optional().describe("Exact domain, e.g. light"),
        area: z.string().optional().describe("Area name (or id), case insensitive"),
        floor: z.string().optional().describe("Floor name, case insensitive (#89)"),
        label: z.string().optional().describe("Label name, case insensitive (#89)"),
        search: z.string().optional().describe("Fuzzy search in id, name, alias, area, floor, label"),
        state: z.string().optional().describe("Exact state, e.g. on"),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50, max 200"),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_list_entities", async ({ domain, area, floor, label, search, state, limit, offset }) => {
      let all = await visible();

      if (!domain && !area && !floor && !label && !search && !state) {
        const byDomain = new Map<string, number>();
        const byArea = new Map<string, number>();
        for (const e of all) {
          byDomain.set(e.domain, (byDomain.get(e.domain) ?? 0) + 1);
          if (e.area) byArea.set(e.area, (byArea.get(e.area) ?? 0) + 1);
        }
        const top = (m: Map<string, number>) =>
          [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => ({ [k]: v }));
        return {
          total: all.length,
          by_domain: top(byDomain),
          by_area: top(byArea),
          note: "Overview only. Call again with a filter (domain, area, search or state) to get entities.",
        };
      }

      if (domain) all = all.filter((e) => e.domain === domain.toLowerCase().trim());
      if (state) all = all.filter((e) => e.state === state);
      if (area) {
        const a = area.toLowerCase().trim();
        all = all.filter((e) => (e.area ?? "").toLowerCase() === a);
      }
      if (floor) {
        const f = floor.toLowerCase().trim();
        all = all.filter((e) => (e.floor ?? "").toLowerCase() === f);
      }
      if (label) {
        const l = label.toLowerCase().trim();
        all = all.filter((e) => e.labels.some((x) => x.toLowerCase() === l));
      }
      if (search) {
        all = all
          .map((e) => ({ e, score: matchQuery(e, search) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.e);
      }
      return listEnvelope(all.map(summary), limit ?? 50, offset ?? 0);
    })
  );

  server.registerTool(
    "ha_get_entity",
    {
      title: "Entity details",
      description:
        "Full state of one entity: state, all attributes, area, device, timestamps. " +
        "Very long attribute values are truncated.",
      inputSchema: {
        entity_id: z.string().describe("E.g. light.kitchen"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_get_entity", async ({ entity_id }) => {
      if (!entityReadVisible(ctx.cfg, entity_id)) {
        throw new Error(`entity ${entity_id} is not accessible (filter_reads)`);
      }
      const all = await ctx.catalog.index();
      const e = all.find((x) => x.entity_id === entity_id);
      if (!e) throw new Error(`unknown entity: ${entity_id}. Use ha_search_entities to find the right id.`);
      const attributes: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(e.attributes)) {
        const s = JSON.stringify(v) ?? "";
        attributes[k] = s.length > 500 ? trunc(v, 500) : v;
      }
      return {
        entity_id: e.entity_id,
        name: e.name,
        state: e.state,
        area: e.area,
        ...(e.floor ? { floor: e.floor } : {}),
        ...(e.aliases.length > 0 ? { aliases: e.aliases } : {}),
        ...(e.labels.length > 0 ? { labels: e.labels } : {}),
        category: e.category,
        hidden: e.hidden,
        last_changed: e.last_changed,
        attributes,
      };
    })
  );

  server.registerTool(
    "ha_list_areas",
    {
      title: "List areas",
      description: "All declared areas (rooms), with their floor and the number of entities in each.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("ha_list_areas", async () => {
      const [regs, all] = await Promise.all([ctx.catalog.registries(), visible()]);
      const counts = new Map<string, number>();
      for (const e of all) if (e.area) counts.set(e.area, (counts.get(e.area) ?? 0) + 1);
      const floorName = new Map(regs.floors.map((f) => [f.floor_id, f.name]));
      return {
        items: regs.areas.map((a) => ({
          area_id: a.area_id,
          name: a.name,
          ...(a.floor_id ? { floor: floorName.get(a.floor_id) ?? null } : {}),
          entities: counts.get(a.name) ?? 0,
        })),
        total: regs.areas.length,
      };
    })
  );

  server.registerTool(
    "ha_list_devices",
    {
      title: "List devices",
      description:
        "Devices from the registry: manufacturer, model, area. Filterable by area. " +
        "One device groups several entities.",
      inputSchema: {
        area: z.string().optional().describe("Area name, case insensitive"),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("ha_list_devices", async ({ area, limit, offset }) => {
      const regs = await ctx.catalog.registries();
      const areaById = new Map(regs.areas.map((a) => [a.area_id, a.name]));
      let devices = regs.devices
        .filter((d) => !d.disabled_by)
        .map((d) => ({
          device_id: d.id,
          name: d.name_by_user ?? d.name ?? "(unnamed)",
          manufacturer: d.manufacturer,
          model: d.model,
          area: d.area_id ? (areaById.get(d.area_id) ?? null) : null,
        }));
      if (area) {
        const a = area.toLowerCase().trim();
        devices = devices.filter((d) => (d.area ?? "").toLowerCase() === a);
      }
      return listEnvelope(devices, limit ?? 50, offset ?? 0);
    })
  );
}
