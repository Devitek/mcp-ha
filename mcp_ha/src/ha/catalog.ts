import type { HaWsClient } from "./ws.js";
import type { HaState, IndexedEntity } from "../types.js";
import { areasSchema, devicesSchema, entityEntriesSchema, haStatesSchema, parseHaPayload } from "./schemas.js";

const REGISTRY_TTL_MS = 60_000;
/**
 * Short-lived state cache (audit F1): a conversation fires many tool calls
 * in bursts, and each get_states can weigh megabytes on large instances.
 * A few seconds of reuse removes the per-call storm while staying fresh
 * enough for interactive use.
 */
const STATES_TTL_MS = 3_000;

interface RegistryCache {
  at: number;
  areas: Array<{ area_id: string; name: string }>;
  devices: Array<{ id: string; name: string | null; name_by_user: string | null; manufacturer: string | null; model: string | null; area_id: string | null; disabled_by: string | null }>;
  entities: Array<{ entity_id: string; area_id: string | null; device_id: string | null; disabled_by: string | null; hidden_by: string | null; entity_category: string | null }>;
}

/**
 * Join of states + registries (areas, devices, entities). Registries rarely
 * change (60 s TTL), states are cached a few seconds. Concurrent callers
 * share the in-flight promise instead of stampeding Home Assistant, and the
 * whole cache is invalidated when the WebSocket reconnects.
 */
export class Catalog {
  private regCache: RegistryCache | null = null;
  private regInflight: Promise<RegistryCache> | null = null;
  private statesCache: { at: number; states: HaState[] } | null = null;
  private statesInflight: Promise<HaState[]> | null = null;

  constructor(private ws: HaWsClient) {}

  /** Drops every cache; wired to the WS reconnection (audit B5/C9). */
  invalidate(): void {
    this.regCache = null;
    this.statesCache = null;
  }

  async registries(): Promise<RegistryCache> {
    if (this.regCache && Date.now() - this.regCache.at < REGISTRY_TTL_MS) return this.regCache;
    if (this.regInflight) return this.regInflight;
    this.regInflight = (async () => {
      try {
        const [areasRaw, devicesRaw, entitiesRaw] = await Promise.all([
          this.ws.send("config/area_registry/list"),
          this.ws.send("config/device_registry/list"),
          this.ws.send("config/entity_registry/list"),
        ]);
        const cache: RegistryCache = {
          at: Date.now(),
          areas: parseHaPayload(areasSchema, areasRaw, "area registry"),
          devices: parseHaPayload(devicesSchema, devicesRaw, "device registry"),
          entities: parseHaPayload(entityEntriesSchema, entitiesRaw, "entity registry"),
        };
        this.regCache = cache;
        return cache;
      } finally {
        this.regInflight = null;
      }
    })();
    return this.regInflight;
  }

  async states(): Promise<HaState[]> {
    if (this.statesCache && Date.now() - this.statesCache.at < STATES_TTL_MS) return this.statesCache.states;
    if (this.statesInflight) return this.statesInflight;
    this.statesInflight = (async () => {
      try {
        const raw = await this.ws.send("get_states");
        const states = parseHaPayload(haStatesSchema, raw, "get_states") as HaState[];
        this.statesCache = { at: Date.now(), states };
        return states;
      } finally {
        this.statesInflight = null;
      }
    })();
    return this.statesInflight;
  }

  async index(): Promise<IndexedEntity[]> {
    const [states, regs] = await Promise.all([this.states(), this.registries()]);
    const areaById = new Map(regs.areas.map((a) => [a.area_id, a.name]));
    const entryByEid = new Map(regs.entities.map((e) => [e.entity_id, e]));
    const deviceById = new Map(regs.devices.map((d) => [d.id, d]));

    return states.map((s) => {
      const entry = entryByEid.get(s.entity_id);
      const device = entry?.device_id ? deviceById.get(entry.device_id) : undefined;
      const areaId = entry?.area_id ?? device?.area_id ?? null;
      return {
        entity_id: s.entity_id,
        name: String(s.attributes?.friendly_name ?? s.entity_id),
        domain: s.entity_id.split(".")[0] ?? "",
        state: s.state,
        area: areaId ? (areaById.get(areaId) ?? null) : null,
        device_id: entry?.device_id ?? null,
        last_changed: s.last_changed,
        hidden: Boolean(entry?.hidden_by),
        category: entry?.entity_category ?? null,
        attributes: s.attributes ?? {},
      };
    });
  }
}
