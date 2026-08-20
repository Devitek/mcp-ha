// Formes minimales des objets Home Assistant manipulés par les outils.
// Les payloads réels contiennent bien plus de champs, on ne type que ce qu'on lit.

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface AreaEntry {
  area_id: string;
  name: string;
}

export interface DeviceEntry {
  id: string;
  name: string | null;
  name_by_user: string | null;
  manufacturer: string | null;
  model: string | null;
  area_id: string | null;
  disabled_by: string | null;
}

export interface EntityEntry {
  entity_id: string;
  area_id: string | null;
  device_id: string | null;
  disabled_by: string | null;
  hidden_by: string | null;
  entity_category: string | null;
}

/** Entité enrichie par la jointure états + registres. */
export interface IndexedEntity {
  entity_id: string;
  name: string;
  domain: string;
  state: string;
  area: string | null;
  device_id: string | null;
  last_changed: string;
  hidden: boolean;
  category: string | null;
  attributes: Record<string, unknown>;
}
