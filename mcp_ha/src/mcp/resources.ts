import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import { entityReadVisible } from "../safety.js";
import { log } from "../logger.js";

/** Per-URI notification floor: a chatty sensor cannot flood the stream. */
const NOTIFY_MIN_INTERVAL_MS = 1_000;

/**
 * Static-ish catalogs exposed as MCP resources (v0.3, #79): clients that
 * support resources can pin them as context without spending a tool call.
 * The heavier, filterable listings stay tools. In session mode (#90) the
 * ha://entity/{entity_id} template is subscribable: the client gets a
 * notifications/resources/updated when the watched entity changes.
 */
export function registerResources(server: McpServer, ctx: ToolContext): void {
  const json = (uri: string, data: unknown) => ({
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data) }],
  });

  server.registerResource(
    "entity",
    new ResourceTemplate("ha://entity/{entity_id}", {
      list: undefined,
      // Completion (#115): clients discover real entity ids while typing,
      // same visibility rules as every read.
      complete: {
        entity_id: async (value: string) => {
          const q = String(value ?? "").toLowerCase();
          return (await ctx.catalog.index())
            .filter((e) => entityReadVisible(ctx.cfg, e.entity_id))
            .map((e) => e.entity_id)
            .filter((id) => id.toLowerCase().includes(q))
            .slice(0, 50);
        },
      },
    }),
    {
      title: "Entity state",
      description:
        "Compact live state of one entity. In session mode, subscribe to it to be notified when it changes.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const entityId = String(variables.entity_id ?? "");
      if (!entityReadVisible(ctx.cfg, entityId)) {
        throw new Error(`entity ${entityId} is not accessible (filter_reads)`);
      }
      const e = (await ctx.catalog.index()).find((x) => x.entity_id === entityId);
      if (!e) throw new Error(`unknown entity: ${entityId}`);
      return json(uri.href, {
        entity_id: e.entity_id,
        name: e.name,
        state: e.state,
        area: e.area,
        last_changed: e.last_changed,
      });
    }
  );

  server.registerResource(
    "area",
    new ResourceTemplate("ha://area/{area_id}", {
      list: undefined,
      complete: {
        area_id: async (value: string) => {
          const q = String(value ?? "").toLowerCase();
          return (await ctx.catalog.registries()).areas
            .map((a) => a.area_id)
            .filter((id) => id.toLowerCase().includes(q))
            .slice(0, 50);
        },
      },
    }),
    {
      title: "Area state",
      description:
        "Compact live state of one area: entity counts per domain and the notable active entities. " +
        "In session mode, subscribe to be notified when anything in the room changes (#143).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const areaId = String(variables.area_id ?? "");
      const regs = await ctx.catalog.registries();
      const area = regs.areas.find((a) => a.area_id === areaId);
      if (!area) throw new Error(`unknown area: ${areaId}. List areas with ha_list_areas.`);
      const floor = area.floor_id ? (regs.floors.find((f) => f.floor_id === area.floor_id)?.name ?? null) : null;
      const entities = (await ctx.catalog.index()).filter(
        (e) => e.area === area.name && entityReadVisible(ctx.cfg, e.entity_id)
      );
      const byDomain: Record<string, number> = {};
      for (const e of entities) byDomain[e.domain] = (byDomain[e.domain] ?? 0) + 1;
      const ACTIVE = new Set(["on", "open", "playing", "heat", "cool", "heat_cool", "unlocked"]);
      const notable = entities
        .filter((e) => ACTIVE.has(e.state))
        .slice(0, 10)
        .map((e) => ({ entity_id: e.entity_id, state: e.state }));
      return json(uri.href, {
        area_id: areaId,
        name: area.name,
        ...(floor ? { floor } : {}),
        entity_count: entities.length,
        by_domain: byDomain,
        notable,
      });
    }
  );

  if (ctx.sessionMode) registerEntitySubscriptions(server, ctx);

  server.registerResource(
    "areas",
    "ha://areas",
    {
      title: "Areas",
      description: "All Home Assistant areas with their entity counts.",
      mimeType: "application/json",
    },
    async (uri) => {
      const [regs, index] = await Promise.all([ctx.catalog.registries(), ctx.catalog.index()]);
      const counts = new Map<string, number>();
      for (const e of index) if (e.area) counts.set(e.area, (counts.get(e.area) ?? 0) + 1);
      return json(
        uri.href,
        regs.areas.map((a) => ({ area_id: a.area_id, name: a.name, entities: counts.get(a.name) ?? 0 }))
      );
    }
  );

  server.registerResource(
    "services",
    "ha://services",
    {
      title: "Service domains",
      description: "Callable service domains with their service counts (details via the ha_list_services tool).",
      mimeType: "application/json",
    },
    async (uri) => {
      const services: Record<string, Record<string, unknown>> = await ctx.ws.send("get_services");
      return json(
        uri.href,
        Object.entries(services).map(([domain, defs]) => ({ domain, services: Object.keys(defs).length }))
      );
    }
  );

  server.registerResource(
    "config",
    "ha://config",
    {
      title: "Home Assistant configuration",
      description: "Compact Home Assistant instance configuration (version, name, timezone, units).",
      mimeType: "application/json",
    },
    async (uri) => {
      const c = await ctx.ws.send("get_config");
      return json(uri.href, {
        version: c.version,
        location_name: c.location_name,
        time_zone: c.time_zone,
        unit_system: c.unit_system,
        currency: c.currency,
        country: c.country,
        components: Array.isArray(c.components) ? c.components.length : null,
        state: c.state,
      });
    }
  );
}

/**
 * Entity subscriptions (#90): "watch this sensor". Bounded by design
 * (audit lesson): capped subscription set, one notification per second per
 * URI at most (the notification carries no data, the client re-reads), and
 * the state_changed listener is detached when the session server closes.
 */
function registerEntitySubscriptions(server: McpServer, ctx: ToolContext): void {
  const MAX_SUBSCRIPTIONS = 50;
  const subscribed = new Set<string>();
  const lastNotified = new Map<string, number>();
  // Area subscriptions (#143): the state_changed listener is SYNCHRONOUS,
  // so entity-to-area resolution comes from a precomputed map, refreshed
  // asynchronously on each area subscribe and lazily (60 s) on events. A
  // just-moved entity may miss or over-fire one notification: accepted.
  let entityToArea = new Map<string, string>();
  let areaSubs = 0;
  let lastMapBuild = 0;
  const buildAreaMap = async (): Promise<void> => {
    lastMapBuild = Date.now();
    const [index, regs] = await Promise.all([ctx.catalog.index(), ctx.catalog.registries()]);
    const nameToId = new Map(regs.areas.map((a) => [a.name, a.area_id]));
    entityToArea = new Map(
      index.filter((e) => e.area !== null).map((e) => [e.entity_id, nameToId.get(e.area as string) ?? ""])
    );
  };

  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    const uri = req.params.uri;
    const entityId = uri.match(/^ha:\/\/entity\/(.+)$/)?.[1];
    const areaId = uri.match(/^ha:\/\/area\/(.+)$/)?.[1];
    if (!entityId && !areaId) {
      throw new Error(`only ha://entity/{entity_id} and ha://area/{area_id} resources are subscribable, got: ${uri}`);
    }
    if (entityId && !entityReadVisible(ctx.cfg, entityId)) {
      throw new Error(`entity ${entityId} is not accessible (filter_reads)`);
    }
    if (areaId) {
      const regs = await ctx.catalog.registries();
      if (!regs.areas.some((a) => a.area_id === areaId)) throw new Error(`unknown area: ${areaId}`);
      await buildAreaMap();
    }
    if (subscribed.size >= MAX_SUBSCRIPTIONS && !subscribed.has(uri)) {
      throw new Error(`subscription cap reached (${MAX_SUBSCRIPTIONS}); unsubscribe something first`);
    }
    if (areaId && !subscribed.has(uri)) areaSubs++;
    subscribed.add(uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    if (subscribed.delete(req.params.uri) && req.params.uri.startsWith("ha://area/")) areaSubs--;
    return {};
  });

  const notify = (uri: string): void => {
    const now = Date.now();
    if (now - (lastNotified.get(uri) ?? 0) < NOTIFY_MIN_INTERVAL_MS) return;
    lastNotified.set(uri, now);
    server.server.sendResourceUpdated({ uri }).catch((e) => {
      log.debug(`resources/updated notification failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  const detach = ctx.catalog.onEntityChange((entityId) => {
    const entityUri = `ha://entity/${entityId}`;
    if (subscribed.has(entityUri)) notify(entityUri);
    if (areaSubs > 0) {
      if (Date.now() - lastMapBuild > 60_000) void buildAreaMap();
      const areaId = entityToArea.get(entityId);
      // A hidden entity must not signal its activity through its room.
      if (areaId && subscribed.has(`ha://area/${areaId}`) && entityReadVisible(ctx.cfg, entityId)) {
        notify(`ha://area/${areaId}`);
      }
    }
  });
  const prevOnClose = server.server.onclose;
  server.server.onclose = () => {
    detach();
    prevOnClose?.();
  };
}
