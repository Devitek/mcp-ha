import type { HaWsClient } from "./ws.js";
import type { AreaEntry, DeviceEntry, EntityEntry, HaState, IndexedEntity } from "../types.js";

const REGISTRY_TTL_MS = 60_000;

interface RegistryCache {
  at: number;
  areas: AreaEntry[];
  devices: DeviceEntry[];
  entities: EntityEntry[];
}

/**
 * Jointure états + registres (areas, devices, entities). Les registres
 * changent rarement, on les met en cache 60 s. Les états sont toujours
 * relus à la demande.
 */
export class Catalog {
  private cache: RegistryCache | null = null;

  constructor(private ws: HaWsClient) {}

  async registries(): Promise<RegistryCache> {
    if (this.cache && Date.now() - this.cache.at < REGISTRY_TTL_MS) return this.cache;
    const [areas, devices, entities] = await Promise.all([
      this.ws.send("config/area_registry/list"),
      this.ws.send("config/device_registry/list"),
      this.ws.send("config/entity_registry/list"),
    ]);
    this.cache = { at: Date.now(), areas, devices, entities };
    return this.cache;
  }

  states(): Promise<HaState[]> {
    return this.ws.send("get_states");
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
