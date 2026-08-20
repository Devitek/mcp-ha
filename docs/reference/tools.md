# Tool reference

16 tools, prefixed `ha_`. All read tools carry the `readOnlyHint` annotation. Responses are compact JSON with a standard list envelope:

```json
{ "items": [...], "returned": 50, "total": 734, "has_more": true, "next_offset": 50, "note": "..." }
```

## Entities

### ha_search_entities

Fuzzy search by name, entity_id or area. The natural entry point.

| Param | Type | Notes |
|-------|------|-------|
| `query` | string, required | e.g. `kitchen light` |
| `limit` | number | default 20, max 50 |

### ha_list_entities

Paginated list. **Called without any filter, it returns a histogram** (counts per domain and per area) instead of a dump.

| Param | Type | Notes |
|-------|------|-------|
| `domain` | string | e.g. `light`, `sensor`, `automation` |
| `area` | string | area name, case insensitive |
| `search` | string | fuzzy filter |
| `state` | string | exact state, e.g. `on` |
| `limit` / `offset` | number | default 50, max 200 |

### ha_get_entity

Full state and attributes of one entity (long attribute values truncated).

| Param | Type |
|-------|------|
| `entity_id` | string, required |

### ha_list_areas

All areas with their entity counts. No parameters.

### ha_list_devices

Devices with manufacturer, model, area. Params: `area`, `limit`, `offset`.

## Services

### ha_list_services

Without parameters: domains and their service counts. With `domain`: detailed services and fields. With `search`: cross-domain lookup.

### ha_call_service <Badge type="danger" text="write" />

Only registered when `allow_write` is enabled. Subject to the [write rules](/guide/configuration#write-rules).

| Param | Type | Notes |
|-------|------|-------|
| `domain` / `service` | string, required | e.g. `light` / `turn_on` |
| `target` | object | `entity_id`, `device_id`, `area_id` (prefer `entity_id`) |
| `data` | object | service data, e.g. `{ "brightness_pct": 50 }` |
| `dry_run` | boolean | preview without executing |
| `return_response` | boolean | for services that return data |

## Automations and scripts

### ha_list_automations

entity_id, name, enabled, last_triggered. Params: `limit`, `offset`.

### ha_get_automation

State plus, for UI-created automations, the full configuration (triggers, conditions, actions). YAML-defined automations return their state with a note.

### ha_list_scripts

entity_id, name, running, last_triggered. Params: `limit`, `offset`.

## History

### ha_get_history

State changes of one entity. Window: `hours` (min 0.25, default 24, max 168) or `start`/`end` ISO 8601. The first point is the state already in effect at window start; more than 250 points are downsampled with a note.

### ha_get_statistics

Recorder aggregates (mean, min, max, sum) for numeric sensors. `statistic_id` (string or list up to 10), `period` among `5minute`, `hour`, `day`, `week`, `month`, window up to one year. Prefer this over `ha_get_history` for long ranges.

### ha_get_logbook

Human-readable events, filterable by `entity_id`, window from 0.25 h up to 7 days, capped at 100 events.

## Add-ons and system

### ha_get_addons

Without `slug`: list of installed add-ons. With `slug`: details of one. Read only. Requires the Supervisor (unavailable in dev mode).

### ha_render_template

Evaluates a Jinja2 template server-side and returns the rendering. Read only, very powerful for computed queries. Not registered when `filter_reads` is enabled (a template can read any entity):

```
{{ states.light | selectattr('state','eq','on') | list | count }}
```

### ha_get_system

`section: "config"`: HA version, name, timezone, units, integration count. `section: "error_log"`: last 100 lines of the HA error log.
