# Tool reference

24 tools, prefixed `ha_`. All read tools carry the `readOnlyHint` annotation. Responses are compact JSON with a standard list envelope:

```json
{ "items": [...], "returned": 50, "total": 734, "has_more": true, "next_offset": 50, "note": "..." }
```

## Entities

### ha_search_entities

Fuzzy search by name, entity_id, Assist alias, area, floor or label. The natural entry point. Aliases weigh like the name; area, floor and labels weigh less.

| Param | Type | Notes |
|-------|------|-------|
| `query` | string, required | e.g. `kitchen light` |
| `limit` | number | default 20, max 50 |

### ha_list_entities

Paginated list, filterable by `domain`, `area`, `floor`, `label`, `search` and `state`. **Called without any filter, it returns a histogram** (counts per domain and per area) instead of a dump.

| Param | Type | Notes |
|-------|------|-------|
| `domain` | string | e.g. `light`, `sensor`, `automation` |
| `area` | string | area name, case insensitive |
| `search` | string | fuzzy filter |
| `state` | string | exact state, e.g. `on` |
| `limit` / `offset` | number | default 50, max 200 |

### ha_get_entity

Full state and attributes of one entity (long attribute values truncated), plus its floor, Assist aliases and labels when it has any.

| Param | Type |
|-------|------|
| `entity_id` | string, required |

### ha_list_areas

All areas with their floor and entity counts. No parameters.

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
| `confirm_token` | string | token from a `confirmation_required` answer (sensitive domains) |
| `return_response` | boolean | for services that return data |

On domains listed in `confirm_domains` (locks and alarms by default), the first call answers `confirmation_required` with a single-use `confirm_token` bound to that exact call; execute by calling again with the same arguments plus the token.

### ha_run_script <Badge type="danger" text="write" />

Runs a script, optionally with variables. Same guarded path as `ha_call_service`.

| Param | Type | Notes |
|-------|------|-------|
| `entity_id` | string, required | must be a `script.*` entity |
| `variables` | object | passed to the script |
| `dry_run` / `confirm_token` | | as in `ha_call_service` |

### ha_trigger_automation <Badge type="danger" text="write" />

Triggers an automation now. `skip_condition` defaults to `true` (actions run even if conditions do not hold).

| Param | Type | Notes |
|-------|------|-------|
| `entity_id` | string, required | must be an `automation.*` entity |
| `skip_condition` | boolean | default `true` |
| `dry_run` / `confirm_token` | | as in `ha_call_service` |

### ha_set_automation <Badge type="danger" text="write" />

Enables or disables an automation.

| Param | Type | Notes |
|-------|------|-------|
| `entity_id` | string, required | must be an `automation.*` entity |
| `enabled` | boolean, required | `true` to enable |
| `dry_run` / `confirm_token` | | as in `ha_call_service` |

### ha_create_helper <Badge type="danger" text="write" />

Creates a helper: a pure state container with no behaviour (`input_boolean`, `input_number`, `input_select`, `input_text`, `input_datetime`, `counter`, `timer`). Audited; no confirmation step, creating a helper cannot make the house act.

| Param | Type | Notes |
|-------|------|-------|
| `helper_type` | string, required | one of the seven types above |
| `name` | string, required | display name |
| `options` | object | type-specific settings (e.g. `min`/`max` for `input_number`, `options` list for `input_select`), passed to HA as-is |

### ha_delete_helper <Badge type="danger" text="write" />

Deletes a UI-managed helper by entity_id. The collection id is resolved through the entity registry, so renamed helpers are handled; YAML-defined helpers are refused with a clear message. Subject to the entity allow/deny lists, audited.

## Automations and scripts

### ha_list_automations

entity_id, name, enabled, last_triggered. Params: `limit`, `offset`.

### ha_get_automation

State plus, for UI-created automations, the full configuration (triggers, conditions, actions). YAML-defined automations return their state with a note.

### ha_list_scripts

entity_id, name, running, last_triggered. Params: `limit`, `offset`.

## History

### ha_get_history

State changes of one entity, or of up to 5 at once to compare them (`entity_id` accepts a string or a list; a list returns a `series` object keyed by entity). Window: `hours` (min 0.25, default 24, max 168) or `start`/`end` ISO 8601. The first point is the state already in effect at window start; the 250-point budget is shared between the requested entities and downsampled with a note beyond it.

### ha_get_statistics

Recorder aggregates (mean, min, max, sum) for numeric sensors. `statistic_id` (string or list up to 10), `period` among `5minute`, `hour`, `day`, `week`, `month`, window up to one year. Prefer this over `ha_get_history` for long ranges.

### ha_get_logbook

Human-readable events, filterable by `entity_id`, window from 0.25 h up to 7 days, capped at 100 events.

## Calendar and to-do

### ha_get_calendar

Without `entity_id`: lists the calendar entities. With `entity_id`: events over a window (`hours` default 24, max 720, or `start`/`end` ISO 8601).

### ha_get_todo_list

Without `entity_id`: lists the to-do entities. With `entity_id`: the items on that list (optional `status` filter). Read only, via `todo.get_items`.

## Cameras

### ha_get_camera_snapshot <Badge type="tip" text="opt-in" />

Returns the current still image of a `camera.*` entity as an MCP image, so the assistant can describe what it sees. Registered only when the `allow_camera` option is enabled (independent from `allow_write`); `filter_reads` and `entity_denylist` still apply, and every snapshot is audited.

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

## Resources and prompts

Since v0.3 every tool response also carries `structuredContent` (the same JSON as the text, typed for clients that support it), and the server exposes:

**Resources** (`application/json`, for clients that pin context without tool calls):

| URI | Content |
|-----|---------|
| `ha://areas` | all areas with their entity counts |
| `ha://services` | service domains with their service counts |
| `ha://config` | compact instance configuration (version, name, timezone, units) |

**Prompts** (guided workflows):

| Name | Arguments | What it does |
|------|-----------|--------------|
| `diagnose-automation` | `automation` (entity_id) | step-by-step investigation of why an automation did not run |
| `energy-report` | `hours` (optional) | consumption summary built on long-term statistics |
| `propose-automation` | `goal` | drafts a paste-ready automation YAML from verified entities, writes nothing |
| `propose-script` | `goal` | drafts a paste-ready script YAML from verified entities, writes nothing |
