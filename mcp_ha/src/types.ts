// Minimal shapes of the Home Assistant objects the tools work with. The real
// payloads carry many more fields, we only type what we read.

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

/** Entity enriched by joining states with the registries. */
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
