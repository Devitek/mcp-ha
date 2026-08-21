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
  floor_id: string | null;
}

export interface FloorEntry {
  floor_id: string;
  name: string;
  level: number | null;
}

export interface LabelEntry {
  label_id: string;
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
  aliases: string[];
  labels: string[];
}

/** Entity enriched by joining states with the registries. */
export interface IndexedEntity {
  entity_id: string;
  name: string;
  domain: string;
  state: string;
  area: string | null;
  /** Floor name resolved through the area (#89); null without floors. */
  floor: string | null;
  device_id: string | null;
  last_changed: string;
  hidden: boolean;
  category: string | null;
  /** Assist aliases from the entity registry (#89). */
  aliases: string[];
  /** Label names (ids resolved through the label registry, #89). */
  labels: string[];
  attributes: Record<string, unknown>;
}
