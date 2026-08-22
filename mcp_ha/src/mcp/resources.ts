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
    new ResourceTemplate("ha://entity/{entity_id}", { list: undefined }),
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

  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    const uri = req.params.uri;
    const entityId = uri.match(/^ha:\/\/entity\/(.+)$/)?.[1];
    if (!entityId) throw new Error(`only ha://entity/{entity_id} resources are subscribable, got: ${uri}`);
    if (!entityReadVisible(ctx.cfg, entityId)) throw new Error(`entity ${entityId} is not accessible (filter_reads)`);
    if (subscribed.size >= MAX_SUBSCRIPTIONS && !subscribed.has(uri)) {
      throw new Error(`subscription cap reached (${MAX_SUBSCRIPTIONS}); unsubscribe something first`);
    }
    subscribed.add(uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscribed.delete(req.params.uri);
    return {};
  });

  const detach = ctx.catalog.onEntityChange((entityId) => {
    const uri = `ha://entity/${entityId}`;
    if (!subscribed.has(uri)) return;
    const now = Date.now();
    if (now - (lastNotified.get(uri) ?? 0) < NOTIFY_MIN_INTERVAL_MS) return;
    lastNotified.set(uri, now);
    server.server.sendResourceUpdated({ uri }).catch((e) => {
      log.debug(`resources/updated notification failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  });
  const prevOnClose = server.server.onclose;
  server.server.onclose = () => {
    detach();
    prevOnClose?.();
  };
}
