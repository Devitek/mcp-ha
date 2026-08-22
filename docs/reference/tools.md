# Tool reference

34 tools, prefixed `ha_`. All read tools carry the `readOnlyHint` annotation. Responses are compact JSON with a standard list envelope:

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

### ha_snapshot_scene <Badge type="danger" text="write" />

Captures the CURRENT state of the given entities as a scene ("capture the living room mood as Movie night"), via `scene.create` with `snapshot_entities`. The scene is **volatile by Home Assistant design** (it lives until the scenes reload or a restart); replay it with `scene.turn_on`. Entity lists bound what is capturable; an existing scene id is refused.

### ha_send_notification <Badge type="danger" text="write" />

Sends a notification to a phone or any notify target. Without `target`: lists the available targets (legacy `notify.*` services and modern notify entities); the right call is routed automatically. Goes through the same guarded path as `ha_call_service` (denylist, audit, dry_run) and is capped at **6 notifications per minute per target**: a notification physically disturbs someone, a looping assistant must not hammer.

| Param | Type | Notes |
|-------|------|-------|
| `message` | string, required | truncated beyond ~1000 chars |
| `target` | string | e.g. `mobile_app_pixel` or `notify.telephone`; omit to list |
| `title` / `data` | string / object | platform extras passed as-is |
| `dry_run` / `confirm_token` | | as in `ha_call_service` |

### ha_create_automation <Badge type="danger" text="config write" />

Creates a NEW automation. Only registered when `allow_config_write` is enabled (independent from `allow_write`). The flow is deliberately heavy: Home Assistant validates the blocks first, then the answer carries the complete YAML and a `confirm_token`; the client must show the YAML to the human and call again with the token. Existing automations (same alias) are refused: creation only, no modification.

| Param | Type | Notes |
|-------|------|-------|
| `alias` | string, required | automation name |
| `description` / `mode` | string / enum | `single` (default), `restart`, `queued`, `parallel` |
| `triggers` | array, required | modern syntax, e.g. `[{"trigger": "state", ...}]` |
| `conditions` | array | optional |
| `actions` | array, required | e.g. `[{"action": "light.turn_on", ...}]` |
| `dry_run` / `confirm_token` | | preview / second-step token |

### ha_create_script <Badge type="danger" text="config write" />

Creates a NEW script, same guarded two-step flow. The entity id derives from the alias (`script.<slug>`); an existing one is refused.

| Param | Type | Notes |
|-------|------|-------|
| `alias` | string, required | script name |
| `description` / `mode` | | as above |
| `sequence` | array, required | action sequence |
| `dry_run` / `confirm_token` | | preview / second-step token |

### ha_update_automation / ha_update_script <Badge type="danger" text="config write" />

Update an EXISTING UI-managed automation or script. Provided blocks replace the current ones wholesale (a provided `actions` list replaces all actions); untouched blocks are preserved. The confirmation shows a **before/after diff**, and the base configuration is fingerprinted: if it changes between the two passes (simultaneous UI edit), the token is refused and the flow restarts. The success answer carries the full previous YAML for manual rollback. YAML-defined targets are refused; deletion does not exist.

## Automations and scripts

### ha_list_automations

entity_id, name, enabled, last_triggered. Params: `limit`, `offset`.

### ha_get_automation

State plus, for UI-created automations, the full configuration (triggers, conditions, actions). YAML-defined automations return their state with a note.

### ha_list_scripts

entity_id, name, running, last_triggered. Params: `limit`, `offset`.

### ha_get_automation_trace

Step-by-step record of recent automation or script runs, the first reflex for "why did this fire (or not)?". Without `run_id`: the list of recent runs (trigger, outcome, last step, error). With `run_id`: the ordered step path with condition verdicts and errors. Variables are deliberately omitted (size, and they would leak other entities' states past `filter_reads`). Home Assistant keeps only the last few runs in memory, since its last restart.

## Diagnostics

### ha_get_health

One-call health report: Home Assistant's own **Repairs** issues, entities `unavailable`/`unknown` with age, low batteries (`battery_threshold`, default 20 %), enabled automations that have not fired for a while (`stale_days`, default 30), entities without an area. Sections are capped with total counts, and qualified rather than judged: a seasonal sensor is not a defect. Pair it with the `health-report` prompt.

## History

### ha_get_history

State changes of one entity, or of up to 5 at once to compare them (`entity_id` accepts a string or a list; a list returns a `series` object keyed by entity). Window: `hours` (min 0.25, default 24, max 168) or `start`/`end` ISO 8601. The first point is the state already in effect at window start; the 250-point budget is shared between the requested entities and downsampled with a note beyond it.

### ha_get_statistics

Recorder aggregates (mean, min, max, sum) for numeric sensors. `statistic_id` (string or list up to 10), `period` among `5minute`, `hour`, `day`, `week`, `month`, window up to one year. Prefer this over `ha_get_history` for long ranges.

### ha_get_logbook

Human-readable events, filterable by `entity_id`, window from 0.25 h up to 7 days, capped at 100 events.

## Energy and presence

### ha_get_energy

Energy totals from the **configured energy dashboard** (`energy/get_prefs` names the exact statistics: grid import/export, solar, battery, gas, water, per-device consumption) over `period` (`day` default, `week`, `month`). With `compare: true`, the previous period and the deltas in percent ("this week vs last week"). Totals sum the per-period `change` statistic, the dashboard's own math. Clear error when no dashboard is configured.

### ha_get_presence

Who is home, in which zone, since when, plus a compact timeline of zone changes over the window (`hours`, default 24, max 168) and the zones with their occupant counts. **Zone names only, never coordinates**: latitude, longitude and tracker sources are never read, by design. `filter_reads` hides persons like any entity; if you hand out read tokens to third parties, denylisting `person.*` is the intended control.

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

`section: "config"`: HA version, name, timezone, units, integration count. `section: "error_log"`: last 100 lines of the HA error log. `section: "updates"`: pending Core, OS and add-on updates. `section: "backups"`: last backup age and recent backups (answers honestly if the minimal Supervisor role cannot list them).

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
| `health-report` | none | guided instance health check built on ha_get_health |
| `propose-automation` | `goal` | drafts a paste-ready automation YAML from verified entities, writes nothing |
| `propose-script` | `goal` | drafts a paste-ready script YAML from verified entities, writes nothing |
