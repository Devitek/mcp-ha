import { z } from "zod";

// Runtime validation of the Home Assistant payloads we depend on (audit B2).
// TypeScript types guarantee nothing at runtime: when HA changes a shape,
// these schemas turn a confusing TypeError deep in a tool into an explicit
// "unexpected payload" error naming the offending field. Schemas are loose:
// extra fields flow through untouched.

export const haStateSchema = z
  .object({
    entity_id: z.string(),
    state: z.string(),
    attributes: z.record(z.string(), z.unknown()).default({}),
    last_changed: z.string().default(""),
    last_updated: z.string().default(""),
  })
  .loose();

export const haStatesSchema = z.array(haStateSchema);

export const areaSchema = z
  .object({
    area_id: z.string(),
    name: z.string(),
    floor_id: z.string().nullable().default(null),
  })
  .loose();

export const areasSchema = z.array(areaSchema);

// Floor and label registries (#89). Both appeared in HA 2024.x, so the
// catalog treats them as optional: an older core answering unknown_command
// must not take down the whole join.
export const floorSchema = z
  .object({
    floor_id: z.string(),
    name: z.string(),
    level: z.number().nullable().default(null),
  })
  .loose();

export const floorsSchema = z.array(floorSchema);

export const labelSchema = z
  .object({
    label_id: z.string(),
    name: z.string(),
  })
  .loose();

export const labelsSchema = z.array(labelSchema);

export const deviceSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().default(null),
    name_by_user: z.string().nullable().default(null),
    manufacturer: z.string().nullable().default(null),
    model: z.string().nullable().default(null),
    area_id: z.string().nullable().default(null),
    disabled_by: z.string().nullable().default(null),
  })
  .loose();

export const devicesSchema = z.array(deviceSchema);

export const entityEntrySchema = z
  .object({
    entity_id: z.string(),
    area_id: z.string().nullable().default(null),
    device_id: z.string().nullable().default(null),
    disabled_by: z.string().nullable().default(null),
    hidden_by: z.string().nullable().default(null),
    entity_category: z.string().nullable().default(null),
    // Assist aliases and label ids (#89); absent on older cores.
    aliases: z.array(z.string()).default([]),
    labels: z.array(z.string()).default([]),
  })
  .loose();

export const entityEntriesSchema = z.array(entityEntrySchema);

/** get_services: domain -> service -> definition (kept opaque). */
export const servicesSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

/** Parses a payload and translates failures into actionable errors. */
export function parseHaPayload<S extends z.ZodType>(schema: S, payload: unknown, what: string): z.output<S> {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const where = first && first.path.length > 0 ? ` at ${first.path.join(".")}` : "";
  throw new Error(
    `Unexpected payload from Home Assistant (${what})${where}: ${first?.message ?? "unknown mismatch"}. ` +
      "The HA API may have changed; please report this."
  );
}
