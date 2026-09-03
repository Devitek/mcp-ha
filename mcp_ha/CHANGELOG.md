# Changelog

## 1.4.0 - 2026-09-03

Home Assistant 2026.9 batch, part two (#192, #193).

- **New** (#192): `ha_get_system` gains a `mounts` section: network storage mounts with usage and the same fill thresholds as the 2026.9 Storage page (warning above 85 %, critical above 95 %). The list comes from the Supervisor `/mounts` API and each mount gets an independent `/host/disks/<name>/usage` probe (both located by reading the Supervisor source): a failing or role-denied probe degrades to a structured note (#153 doctrine), an inactive mount is not probed, and more than 10 mounts are truncated with a note.
- **New** (#193): `ha_explain_event` opens its answer with `cause_kind`, the root-cause taxonomy the 2026.9 Activity dialog introduced: `person` (a resolved human anywhere in the chain), `schedule` (sun/time/calendar wording on the deepest link), `state_change`, `integration` (bare service call), or an honest `unknown`. `restart` is deliberately left out: it is not reliably detectable from the logbook alone.


## 1.3.0 - 2026-09-03

Home Assistant 2026.9 batch, part one (#190, #191), carrying the planned `api_tokens` removal (#182).

- **New** (#190): the run detail of `ha_get_automation_trace` reports the `targets` of each step (service, entity/device/area ids), joined from the stored config through the step paths, the way the 2026.9 trace UI does. Legacy/modern twin keys are bridged (#146); YAML-defined items simply carry no targets.
- **New** (#191): child devices (HA 2026.9) are first-class: `ha_list_devices` exposes `parent_device_id` and shows the parent's area, and entities living on a child device inherit that area too, matching the HA UI.
- **Removed** (#182, deprecated in 1.2.0): the `api_tokens` YAML option leaves the schema, the config parsing and the boot import. Tokens previously imported by 0.32-1.2 live hashed in the store and keep working; a leftover stored key is ignored by the Supervisor (#184 rule) and swept away at boot. The primary `api_token` remains the bootstrap and recovery path.


## 1.2.1 - 2026-08-27

- **Fix** (#184, field report on 1.2.0): removing the deprecated `api_tokens` key from the stored options is impossible while the schema declares it: the Supervisor requires every schema list key to exist (`Missing option 'api_tokens' in root`, the exact mechanism behind #81; verified in the Supervisor source, where a stored key missing from the schema is conversely just ignored with a warning). The boot goes back to BLANKING the option (`api_tokens: []`), the migration entry is restored, and `reconcileOptions` no longer retries a definitive HTTP 400 four times. Silver lining: the same source reading proves that dropping the schema key later (#182) is safe regardless of the stored options, so the removal plan got simpler.

## 1.2.0 - 2026-08-27

- **Deprecated** (#180): the `api_tokens` YAML option. It still works as a one-shot import source (entries are hashed into the token store at boot, with a deprecation warning), but the key is now REMOVED from the stored options afterwards (`reconcileOptions` learned key removal), and the docs mark it deprecated. Manage tokens from the ingress page. The option itself will be dropped in a follow-up release (#182), once existing installs have booted this version: removing the schema key first would prevent the add-on from starting (Supervisor validation, the #81 chicken-and-egg).
- **New** (#181): backup consistency for the token store. The Supervisor archives `/data` while the add-on runs, so the live `tokens.db` inside a backup could be torn; after every token mutation the add-on now writes `tokens.snapshot.db` (SQLite `VACUUM INTO` + atomic rename), seeded at first open. If the main database ever turns out unreadable, it is set aside as evidence (never deleted) and the snapshot is restored automatically. A backup therefore always carries at least one coherent copy, holding only sha256 hashes, never token secrets. New "Backups" sections in DOCS.md and the configuration guide (EN/FR).

## 1.1.0 - 2026-08-26

- **New** (#178): two onboarding blocks join the ingress Connect tab, the clients guide (EN/FR) and DOCS.md. **OpenCode**, shown the exemplary way: the token lives in an environment variable and reaches `opencode.json` through OpenCode's native `{env:HA_MCP_TOKEN}` substitution, with `oauth: false` so no OAuth discovery is attempted against our static-bearer endpoint. And a **generic MCP client** block: transport, endpoint, auth header and the stateless-vs-sessions behaviour, for everything not listed by name.

## 1.0.3 - 2026-08-26

- **Fix, root cause of the whole `database is locked` saga** (#176, closing the #172/#174 investigation): the add-on's own AppArmor profile granted `/data` read-write but NOT the `k` (file lock) permission, so under HA OS every `fcntl(F_SETLK)` from SQLite came back EACCES, which SQLite reports as "database is locked": instant, permanent, invisible in local Docker (which does not enforce the profile). The profile now grants `rwk` on `/data`; after updating, the token store boots straight into WAL with no warning. The 1.0.1/1.0.2 nets (busy_timeout, best-effort WAL, no-locking reopen, in-memory fallback) stay in place for genuinely degraded environments, and CONTRIBUTING gained the lesson: every new kernel-facing capability must be checked against `apparmor.txt`.

## 1.0.2 - 2026-08-26

- **Fix** (#174, follow-up of #172 with field logs): on filesystems that never grant the fcntl locks (every operation timing out with SQLITE_BUSY, typical of network mounts), the token store now reopens itself WITHOUT SQLite locking (`nolock=1`) instead of dying into the in-memory fallback. Safe by construction: the Supervisor runs a single add-on instance, and a phantom lock holder never commits anything. The warning names the detected filesystem (fs.statfs) so the real cause shows up in the log, and DOCS.md gained a troubleshooting entry. WAL is not attempted in no-locking mode (it requires locks by design).

## 1.0.1 - 2026-08-26

- **Fix** (#172, field report): the add-on could crashloop at startup with `database is locked` raised by the token store's WAL transition (seen on filesystems with fussy locking, or racing a dying predecessor). Triple belt: `busy_timeout = 5000` turns transient locks into short waits; `journal_mode = WAL` becomes best-effort (on refusal the store logs a warning and stays on the rollback journal, functionally identical for a token table); and if the on-disk database still cannot open, the server now boots on a loud in-memory fallback instead of dying, keeping the primary token working while stored tokens wait for the fix. The store is also closed properly on shutdown, shrinking the lock window on fast restarts.

## 1.0.0 - 2026-08-26

First stable release. The fine-grained access epic (#164) closed the last structural gap: per-token category × level grants, hashed at rest, managed from the ingress page, capped by the option gates. 45 tools (27 read, 18 guarded write), 7 prompts, 4 resources, 351 tests.

- **Change**: the Tokens tab adopts the final mockup design: five-column table (Name / Token / Grants / Lifecycle) with status pills (active / expired / revoked) under the lifecycle dates, the "capped by allow_*: off" note beneath the token prefix, a framed grants matrix with its own header row, restyled fields and buttons, and the one-time secret banner full width with its Copy button. The add-on icon stays the page logo (the mockup placeholder is only the no-icon fallback).
- No functional change: same flows, same guards, same tests plus the mockup assertions.

## 0.33.0 - 2026-08-26

Token management UI, closing the fine-grained access epic (#164, lot C #167).

- **New**: the ingress page manages tokens. The Tokens tab lists them (prefix, grants summary, lifecycle dates, active/expired/revoked state, a "capped by allow_*: off" note when the option gates limit a token) and creates them through a **category × level matrix** (levels a category does not have, or that sit above the gates, are greyed out); optional expiry and per-token entity lists. The secret is shown **exactly once** in the creation answer; one-click revocation, with `token_created` / `token_revoked` audit events.
- **New**: per-token entity lists are enforced on writes (#167), on top of the global ones: both allowlists must agree (real intersection, not a concat), deny always wins in either list, and area/device targeting is refused as soon as the token carries any list.
- **Security**: creation grants are validated server-side against the option gates too: the browser matrix is convenience, not the boundary. POSTs require an anti-CSRF form token on top of the HA-authenticated ingress session.

## 0.32.0 - 2026-08-26

Token store batch (epic #164, lot B #166).

- **New**: named tokens move into a local SQLite store (`/data/tokens.db`), **hashed at rest** (sha256 plus an 8-character prefix): the clear secret only exists in the creation answer, never in the options panel nor in Supervisor backups. Store tokens carry fine-grained grants per tool category (registry #165), **capped by the option gates on every request**; revocation and expiry are enforced per request with refused attempts audited by name; `last_used_at` is tracked (throttled).
- **Change**: legacy `api_tokens` entries are imported into the store at boot (grants mapped from their scope, idempotent) and the clear-text option is then blanked. The option remains in the schema as an import source; creating fine-grained tokens through the ingress page arrives with #167.
- **Internal**: Drizzle ORM over the built-in `node:sqlite` driver through the stable sqlite-proxy adapter (zero native dependency); migrations generated by drizzle-kit (dev-only), committed in `drizzle/` and applied at boot.

## 0.31.0 - 2026-08-26

Foundation batch for the fine-grained access rework (epic #164, lot A #165).

- **Internal**: every tool now declares its category and access level (read / write / manage) in a central registry (`src/mcp/registry.ts`); registration gating moved from per-module early returns to one gated registrar in buildServer, and the ingress tool counts derive from the registry. A two-way exhaustiveness test pins the registry to the actually-registered tools, ending the manual count maintenance across code, tests and docs.
- **Change** (the one behavioural deviation, documented in #165): access levels are strictly hierarchical, so `manage` includes `write` within its category. Concretely, `allow_config_write` without `allow_write` now also exposes `ha_run_script`, `ha_trigger_automation` and `ha_set_automation`. The old separation was illusory: whoever can rewrite an automation's config can make it do anything.
- No new tool, no option change: 45 tools (27 read, 18 guarded write).

## 0.30.0 - 2026-08-26

Bulk-read batch, closing the field feedback stream started in 0.28.0 (#160).

- **New**: `ha_list_automations` accepts `include_config: true`, attaching each UI automation's full configuration with a shrunken page (default 5, max 10): the paginated way to export or diff a fleet instead of one call per automation. Guardrails first: the page always stays valid JSON; a config too large for it is omitted whole per item (`config_omitted`, fetch it individually), never truncated mid-value; `yaml` items get `config: null` without wasting a fetch; a per-item fetch failure becomes a note, never a sunk page. For the one-shot bootstrap of a very large fleet, the plain REST API honestly remains the better tool.

## 0.29.0 - 2026-08-26

Edit-scope batch, same field feedback stream as 0.28.0 (#158, #159).

- **New**: the update tools cover the root tuning keys (#158): `variables` (where non-trivial automation logic lives), `max_exceeded`, `initial_state` (automations only) and `trace`, each replaced wholesale like the blocks. Passing `null` REMOVES the key from the stored config; an empty object writes an empty object. `ha_create_automation` and `ha_create_script` accept `variables` and `max_exceeded` at creation.
- **Change**: `ha_get_automation` gets a raised response cap, ~64 KB instead of the global ~15 KB (#159): one config is not a fleet dump, and its output feeds `ha_update_automation`, so it must round-trip whole; per-value truncation is refused by design. Beyond even that cap (inline base64 media), the message now says so honestly and points to the UI editor instead of advising filters the tool does not have.

## 0.28.0 - 2026-08-26

Lifecycle batch, from field feedback of an assistant managing a 66-automation repo through the MCP (#155, #156, #157).

- **New**: `ha_delete_automation` and `ha_delete_script` (#155) complete the lifecycle. Guarded like the updates and then some: the first answer carries the complete YAML of what will disappear plus the confirm token, the base config hash rides the fingerprint (a UI edit between the passes invalidates the token), and the success answer returns `deleted_yaml` so `ha_create_automation` / `ha_create_script` can undo a mistaken deletion. UI-managed items only; entity allow/deny lists apply; DELETE is never retried. 45 tools (27 read, 18 guarded write).
- **New**: `ha_list_automations` items carry `source: "ui" | "yaml"` (#156), so an assistant knows upfront which automations the config tools can touch instead of discovering it one failed call at a time.
- **Change**: confirmation tokens now expire after 5 minutes instead of 2 (#157). Reading a YAML diff, showing it to a human and answering back regularly took longer than the window; the token stays single-use and bound to the exact call fingerprint, so the longer window widens no surface.

## 0.27.1 - 2026-08-24

- **Fix** (#153, from an exemplary field bug report): `ha_get_system` no longer leaks raw HTTP errors. `updates` probes each endpoint independently: the add-on part always works under the minimal Supervisor role, the Core and OS parts answer a structured note when denied (they need a higher role, invalidating an assumption of #111). `error_log` moves to the modern `system_log` source (structured errors and warnings, better than the raw file the removed `/api/error_log` endpoint used to serve), with the legacy REST as fallback for old cores and a structured note if neither answers.

## 0.27.0 - 2026-08-24

- **Add-on self test** (`ha_get_self_test`): `ha_get_health` looks at the house, this looks at the add-on. WebSocket and REST connectivity with latencies, live state map status, Supervisor availability, and an ok / degraded / broken verdict with its reason. Contains no data from your home, by design: paste its output into a support issue. Every probe is bounded at 3 seconds, a diagnostic must never hang.
- 43 tools (27 read, 16 guarded write). 306 unit tests.

## 0.26.0 - 2026-08-24

- **Watch a whole room** (`ha://area/{area_id}` resource): the compact live state of an area (entity counts per domain, notable active entities), and in session mode it is subscribable: one notification when anything visible changes in the room, same one-per-second throttle as entity subscriptions. Hidden entities neither appear nor trigger notifications. Area ids autocomplete.
- 4 resources. 302 unit tests.

## 0.25.0 - 2026-08-24

- **Weather forecasts** (`ha_get_forecast`): "will it rain tomorrow?" finally has its tool. Hourly, daily and twice_daily forecasts straight from `weather.get_forecasts` (the read-by-service mechanic), projected compactly with units, closing the gap left when HA 2024.3 removed forecasts from the entity attributes.
- **To-do list management** (`ha_manage_todo`): "add milk to the shopping list". Add, complete, uncheck, remove or rename items, through the same guarded write path as every service call.
- **Daily briefing** (`daily-briefing` prompt): the morning ritual composing presence, today's agenda, the weather, yesterday's energy and only the urgent health items, in about ten prioritized lines, executing nothing.
- 42 tools (26 read, 16 guarded write), 7 prompts. 301 unit tests.

## 0.24.1 - 2026-08-23

- **Fix** (#146, caught in real-world use by the mandatory diff review, nothing was broken): `ha_update_automation` now removes the legacy twin key (`trigger`/`condition`/`action`) when the matching modern block is provided. Before, the modern key was added NEXT TO the legacy one and Home Assistant refuses such documents ("Cannot specify both 'trigger' and 'triggers'"). Legacy-to-modern syntax migrations now work through the tool; untouched pairs keep their legacy key.

## 0.24.0 - 2026-08-23

- **Blueprint automations can now be updated** (#139, found through real-world use): `ha_update_automation` and `ha_update_script` gain an `inputs` parameter that replaces the whole `use_blueprint` input set, checked against the installed blueprint (required inputs present, unknown ones refused). Raw trigger/condition/action blocks are refused on blueprint-based targets with a clear message instead of producing an invalid config after confirmation; alias, description and mode keep working on both kinds.

## 0.23.1 - 2026-08-23

- Ingress dashboard: a **theme switcher** (dark / light / auto, persisted, "auto" follows the OS) and the **real add-on icon** in the header (inlined as a data URI, no extra route, `>_` fallback when unavailable).

## 0.23.0 - 2026-08-23

- **Ingress page redesign**: the status page becomes a four-tab dashboard (Overview with stat cards, safety badges and top-tool bars; Connect a client with per-client sub-tabs; Tokens with the masked token table and scopes; Write audit with client-side filters All / OK / Refused / Dry run+confirm). Dark theme with a full light variant following the OS. Still one server-rendered response, vanilla JS only, system fonts, no network dependency; the token reveal/copy mechanics, escaping and audit contracts are unchanged. Named tokens are only ever rendered masked.

## 0.22.1 - 2026-08-23

- `ha_explain_event` now resolves a `context_user_id` to its person entity when one is linked ("by Thomas (person.thomas)" instead of an opaque id), with no extra privileges: person entities carry their user id as an attribute. Hidden persons do not resolve (`filter_reads`), unlinked accounts keep the raw id. Born from a real-world test of #124.

## 0.22.0 - 2026-08-22

- **Dashboard card insertion** (#129): `ha_list_dashboards` shows your Lovelace dashboards and views; `ha_add_dashboard_card` (behind `allow_config_write`) inserts ONE card into a view, with the full guarded flow: before/after diff of the view, concurrent-edit guard (a simultaneous UI edit invalidates the token), previous view YAML returned for rollback. Classic and sections layouts both handled, YAML dashboards refused, insertion only by design. The `propose-dashboard-card` prompt can now offer the direct insertion.
- 40 tools (25 read, 15 guarded write). 283 unit tests.

## 0.21.0 - 2026-08-22

- **Blueprints** (#127): `ha_list_blueprints` shows the installed blueprints with their typed inputs, and `ha_create_from_blueprint` creates an automation (or script) from one, the safest way to program the house: the behaviour is already written and vetted, required inputs are checked before anything is offered, and the usual guarded two-step flow applies. The `propose-automation` prompt now checks blueprints first.
- 38 tools (24 read, 14 guarded write). 277 unit tests.

## 0.20.0 - 2026-08-22

- **Causality chains** (`ha_explain_event`): "why did this light turn on at 3am?" now has an exact answer. Follows Home Assistant's context records from the entity to its immediate actor (an automation, a user) and to what triggered that in turn, up to 4 hops; points to `ha_get_automation_trace` when an automation is in the chain. Honest "no recorded cause" when the history has nothing.
- **Voice announcements** (`ha_announce`): "announce that dinner is ready" on Assist satellites (native announce) and media players (via `tts.speak`, engine auto-picked). Guarded path, capped at 3 per minute per target, messages truncated for audio.
- 36 tools (23 read, 13 guarded write). 272 unit tests.

## 0.19.0 - 2026-08-22

- **Audit viewer on the ingress page**: the last 50 write-audit entries, newest first, rendered behind your Home Assistant session. The #91 contract is untouched: MCP clients can never read or clear the audit; SSH remains the full-history path.
- **Usage counters on the ingress page**: total tool calls since start, per token and top tools, counted at the HTTP handler so no path can be missed. In memory only; restart resets, the persistent audit covers write history.
- 261 unit tests.

## 0.18.0 - 2026-08-22

- **MCP completions** (`completion/complete`): clients that support them autocomplete real entity ids while typing, on the `automation` argument of the `diagnose-automation` prompt and on the `ha://entity/{entity_id}` resource template. Suggestions follow the same visibility rules as every read (`filter_reads` applies), capped at 50.

## 0.17.0 - 2026-08-22

- **Dashboard card proposals** (`propose-dashboard-card` prompt): the assistant drafts a complete, paste-ready Lovelace card YAML for a stated goal, picking the card type from the real data (gauge with observed thresholds, history-graph, tiles for a room, thermostat...) and using verified entity ids and units. Nothing is written to Home Assistant: paste it in your dashboard's Manual card. 6 prompts.

## 0.16.0 - 2026-08-22

- **Energy report** (`ha_get_energy`): totals per source straight from the configured energy dashboard (grid import/export, solar, battery, gas, water, top consuming devices), over a day, week or month, with an optional comparison to the previous period ("this week vs last week"). The `energy-report` prompt now starts there and only falls back to sensor guessing without a dashboard.
- **Presence summary** (`ha_get_presence`): who is home, in which zone, since when, zone occupant counts and a compact zone-change timeline. Zone names only, never coordinates, by design; see the privacy note in SECURITY.md.
- 34 tools (22 read, 12 guarded write). 253 unit tests.

## 0.15.0 - 2026-08-22

- **Scene snapshots** (`ha_snapshot_scene`): capture the current state of chosen entities as a scene ("capture the living room mood as Movie night"), volatile by Home Assistant design, replayable with `scene.turn_on`. Entity lists apply, existing scene ids are refused.
- **System updates and backups**: `ha_get_system` gains `section: "updates"` (pending Core, OS and add-on updates) and `section: "backups"` (last backup age, recent list). If the add-on's deliberately minimal Supervisor role cannot list backups, the answer says so honestly instead of escalating privileges.
- 32 tools (20 read, 12 guarded write). 245 unit tests.

## 0.14.0 - 2026-08-22

- **Guarded automation and script modification** (`ha_update_automation`, `ha_update_script`, behind the existing `allow_config_write`): provided blocks replace the current ones wholesale, Home Assistant validates first, and the mandatory confirmation shows a **before/after diff** instead of just the new YAML. The base configuration is part of the confirmation fingerprint, so an automation edited in the UI between the two passes invalidates the token. The success answer returns the previous YAML for manual rollback. Deletion remains unsupported.
- 31 tools (20 read, 11 guarded write). 238 unit tests.

## 0.13.0 - 2026-08-22

- **Outbound notifications** (`ha_send_notification`): "tell me when the wash is done". Lists the real targets when called without one, routes legacy `notify.*` services and modern notify entities automatically, flows through the same guarded write path as every service call, and is capped at 6 notifications per minute per target because a notification physically disturbs someone.
- 29 tools (20 read, 9 guarded write). 233 unit tests.

## 0.12.0 - 2026-08-22

- **Automation traces** (`ha_get_automation_trace`): the step-by-step record of recent automation and script runs, straight from Home Assistant's trace store. Which trigger fired, how each condition evaluated, which action failed. Variables are deliberately omitted (size and privacy). The `diagnose-automation` prompt now starts there.
- **Health report** (`ha_get_health` + `health-report` prompt): Home Assistant's own Repairs issues, long-unavailable entities, low batteries, enabled automations that stopped firing, entities without an area. Capped sections, qualified signals.
- 28 tools (20 read, 8 guarded write), 5 prompts. 226 unit tests.

## 0.11.0 - 2026-08-22

- **Optional MCP sessions** (#90, new `enable_sessions` option, default off): an `initialize` opens a long-lived session (SSE streams) while stateless clients keep working unchanged. Sessions are bound to the token that opened them, capped at 16 with a 30-minute idle timeout, and unlock:
  - **entity subscriptions**: subscribe to the new `ha://entity/{entity_id}` resource and get notified when it changes (live state map, at most one notification per second per entity);
  - **in-protocol confirmations**: with an elicitation-capable client, sensitive calls and config writes ask the human directly; the `confirm_token` flow stays the universal fallback.
- 216 unit tests.

## 0.10.0 - 2026-08-22

- **Guarded automation and script creation** (#94 tier 3, new `allow_config_write` option, default off and independent from `allow_write`): `ha_create_automation` and `ha_create_script` let the assistant program NEW behaviour, through the most guarded path in the add-on. Home Assistant validates the blocks first (`validate_config`); the first call answers with the complete YAML and a single-use `confirm_token` bound to the exact payload, to be confirmed after human review; creation only, existing automations (same alias) and scripts (same id) are refused; every step is in the nominative audit trail. See the new "Configuration writes" chapter in SECURITY.md.
- 26 tools (18 read, 8 guarded write). 205 unit tests.

## 0.9.0 - 2026-08-21

- **Helpers** (#94 tier 1): `ha_create_helper` and `ha_delete_helper` manage the seven helper types (`input_boolean`, `input_number`, `input_select`, `input_text`, `input_datetime`, `counter`, `timer`). "Create a coffee counter", "a vacation mode boolean": helpers are pure state containers with no behaviour, the mildest possible write. Both tools are behind `allow_write` and the token scope, audited; deletion honours the entity lists, resolves renamed helpers through the registry and refuses YAML-defined ones.
- **Proposal prompts** (#94 tier 2): `propose-automation` and `propose-script` guide the assistant to draft a complete, paste-ready YAML from verified entities, without writing anything to Home Assistant.
- 24 tools (18 read, 6 guarded write), 4 prompts. 194 unit tests.

## 0.8.1 - 2026-08-21

- **Instant registry updates**: the registry cache (areas, devices, entities, floors, labels) is now invalidated by the Home Assistant registry events instead of waiting out a 60 s TTL. Rename a room or move a device and the very next tool call sees it; the TTL stays as a safety net.
- 188 unit tests.

## 0.8.0 - 2026-08-21

- **Onboarding on the ingress page**: the status page now carries a "Connect a client" section with ready-to-copy configs for Claude Code (`claude mcp add`), Claude Desktop (`mcp-remote`) and Gemini CLI, with the MCP URL derived from the host you browse HA through. The API token is embedded masked on screen (explicit Reveal button; Copy always copies the full working version). Same trust boundary as the Configuration tab: the page only exists behind your authenticated HA session, and the Supervisor token never appears.
- The page auto-refresh goes from 10 s to 60 s.
- 186 unit tests.

## 0.7.0 - 2026-08-21

- **Persistent audit log**: write audit lines are now also mirrored to `/data/audit.log` (JSON lines) so they survive restarts. The file rotates by size (~1 MB, one previous file kept, disk bounded at ~2 MB), writes are asynchronous and never block a request, and stdout behaviour is unchanged. Deliberately, no MCP tool reads or clears the file: read it over SSH.
- 185 unit tests.

## 0.6.0 - 2026-08-21

- **Multi-entity history**: `ha_get_history` now accepts a list of up to 5 entity ids to compare them in one call (a list returns a `series` object per entity). The 250-point budget is shared so the answer stays compact.
- **Richer search**: `ha_search_entities` also matches Assist aliases (same weight as the name), labels and floors. `ha_list_entities` gains `floor` and `label` filters, `ha_get_entity` exposes the entity's floor, aliases and labels, and `ha_list_areas` shows each area's floor.
- The floor and label registries are fetched alongside the others (same cache rules) and degrade gracefully on older Home Assistant cores that do not have them.
- 182 unit tests.

## 0.5.0 - 2026-08-21

- **Camera snapshots** (new `allow_camera` option, off by default and independent from `allow_write`): `ha_get_camera_snapshot` returns the current still image of a camera as an MCP image, so the assistant can describe what it sees. `filter_reads` and `entity_denylist` still apply, and every snapshot is audited. Images above 4 MB are refused (no resize dependency).
- **Calendar and to-do**: `ha_get_calendar` (events over a bounded window, or the list of calendars) and `ha_get_todo_list` (list items via `todo.get_items`, or the list of to-do entities). Both read only.
- 22 tools total (18 read including calendar/to-do/camera, 4 guarded write). 173 unit tests.

## 0.4.0 - 2026-08-21

- **Named tokens with scopes** (new `api_tokens` option): on top of the full-access primary token, configure extra tokens with a name and a `read` or `write` scope. A read token never sees the write tools; a write token behaves like the primary one. Give read-only access to an experimental client and write access to your main assistant.
- **Nominative audit**: every write audit line now carries the name of the token that made the call, so you know which client acted.
- 164 unit tests.

## 0.3.0 - 2026-08-21

The comfort milestone (issue #79).

- **Live state cache**: the add-on now subscribes to `state_changed` and serves every read from an in-memory map (subscribe-first with an event buffer, one snapshot, automatic resubscription on reconnect, short-TTL fallback if the subscription fails). No more repeated `get_states` fetches, reads are instant even on large instances.
- **MCP resources**: `ha://areas`, `ha://services` and `ha://config` as `application/json`.
- **MCP prompts**: `diagnose-automation` (step-by-step investigation of an automation that did not run) and `energy-report` (consumption summary on long-term statistics).
- **structuredContent** on every tool response: typed JSON next to the text for clients that support it.
- **Status page in the HA sidebar** (ingress): version, uptime, WebSocket state, active options; authenticated by your HA session, internal port, no secret displayed.
- 159 unit tests.

## 0.2.1 - 2026-08-21

- **Hotfix**: on installs upgraded from 0.1.x, saving the configuration failed with "Missing option 'confirm_domains' in root". The Supervisor never injects option keys added by updates into the stored options, so the new required key blocked every save. The add-on now reconciles its stored options at startup (missing keys are added with their defaults, on top of the existing token write-back): restart once after updating and the configuration saves normally. Workaround on 0.2.0: add `confirm_domains: [lock, alarm_control_panel]` manually in the YAML editor.

## 0.2.0 - 2026-08-21

The write milestone (issue #15).

- Three dedicated write tools join `ha_call_service` behind `allow_write`: `ha_run_script` (with variables), `ha_trigger_automation` (with `skip_condition`) and `ha_set_automation` (enable/disable). 19 tools in total: 15 read, 4 guarded write.
- **Two-step confirmation on sensitive domains** (new `confirm_domains` option, locks and alarms by default): the first call returns a preview and a single-use `confirm_token` bound to the exact call fingerprint (2 minutes TTL); execution requires calling again with the token. A token can never authorize a different action.
- All four write tools share one guarded write path: service denylist, entity allow/deny lists, area/device bypass guard, dry run, confirmation and audit trail can never diverge between tools.
- 149 unit tests (20 new, including the full confirmation matrix: issue, execute, burn, replay refused, mismatch refused).

## 0.1.8 - 2026-08-21

- AppArmor profile back, this time validated on a real AppArmor-enforcing host against actual kernel denials before shipping (issue #72). The Node server is confined in a tight child profile (denies `/etc/shadow`, writes outside `/data`, `CAP_DAC_OVERRIDE`) while the s6/bashio init tree keeps working, which is what the over-strict 0.1.6 attempt got wrong. Verified: starts healthy, full MCP round-trip, graceful SIGTERM, `/data` read/write as the service user, all under confinement.

## 0.1.7 - 2026-08-21

- **Hotfix**: the AppArmor profile shipped in 0.1.6 broke the container start on real installations (`/init: Permission denied` loop): the s6 init tree is made of interpreted scripts and the profile granted execute without read. The profile is removed; the add-on starts again. It will come back built from real denials (issue #72). Update straight to this version if 0.1.6 crash-loops; nothing else changed.

## 0.1.6 - 2026-08-21

Second and final batch of the external audit (every finding of AUDIT.md is now either shipped or tracked with an explicit blocker).

- Security: progressive per-IP blocking after repeated failed authentications (HTTP 429 with Retry-After); `ha_render_template` is disabled when `filter_reads` is on (a template could read any entity and bypass the denylist); the Node server now runs as a dedicated unprivileged user; custom AppArmor profile shipped; workflow permissions reduced to per-job minimums.
- Robustness: Home Assistant payloads (states, registries, services) are validated at runtime, an API change now yields an explicit "unexpected payload" error instead of a random TypeError; a 404 on automation config is no longer conflated with an API failure; tool errors keep their stack in debug logs.
- Performance: short-lived state cache (3 s) removes the full `get_states` per tool call, registries share in-flight fetches, and every cache is invalidated on reconnection.
- History: the first point now explicitly carries the state in effect at window start; response caps are measured in real bytes.
- Add-on: `startup: application` (waits for HA Core), container healthcheck via curl and honouring MCP_PORT.
- CI: aarch64 cross-build validated on every push, trivy image scan blocking on HIGH/CRITICAL, coverage measured with thresholds, WebSocket reconnection covered by tests. ESLint stays tracked (#70): typescript-eslint does not support TypeScript 7 yet.

## 0.1.5 - 2026-08-21

First batch of the external audit (see AUDIT.md and the `audit` label on the issue tracker).

- **Advisory**: versions 0.1.0 to 0.1.3 printed the API token in full in the add-on log. If you ever shared logs from those versions, rotate your token (DOCS, "Rotating the API token").
- Security hardening: `hassio_role` lowered to `default` (least privilege; report any 403 from `ha_get_addons`), `/health` no longer discloses the version, short user-set tokens now trigger a loud warning, generated token written atomically.
- Robustness: timeouts and one GET retry on every HTTP call to Home Assistant, hard 15 s deadline on the WebSocket handshake, long backoff after repeated `auth_invalid`, options write-back re-checked and retried while the Supervisor boots, corrupted `options.json` degrades to defaults instead of crash-looping, graceful shutdown drains in-flight requests.
- `/health` answers 503 `degraded` once the HA connection has been down for more than 5 minutes, so the container healthcheck finally reflects reality.
- Supply chain: `home-assistant/builder` pinned by commit SHA, `node` build image pinned by digest with a musl compatibility check at build time, release guard now also checks `src/config.ts` VERSION.
- run.sh survives running without a Supervisor (standalone Docker, CI smoke).
- Tests: 104 to 125 (HTTP auth boundary, token write-back, retries, config validation), plus a typecheck of the test files in CI.

## 0.1.4 - 2026-08-20

- Security: the API token no longer appears in full in the add-on log, on any code path. Only a masked prefix with fixed-length padding is shown (e.g. `d370f4f8**********`), which reveals neither the value nor its length. The full token lives in the Configuration tab (`api_token` option). A unit test guards this invariant.
- The documentation site now documents its own LLM-friendly resources (llms.txt, llms-full.txt, raw `.md` twin of every page) and their availability on Context7.

## 0.1.3 - 2026-08-20

- Fixed: history and logbook responses were sized above the global response cap, so maxed-out responses always arrived truncated. History now downsamples to 250 points and the logbook caps at 100 events, both fitting under the cap. Found by the new unit tests.
- LLM-friendly documentation on the site following the llms.txt convention: [/llms.txt](https://devitek.github.io/mcp-ha/llms.txt) (index) and [/llms-full.txt](https://devitek.github.io/mcp-ha/llms-full.txt) (full docs in one file), regenerated on every site build.
- Test suite grown from 29 to 100 unit tests: WebSocket client against a real local server, HTTP client, registry catalog join, configuration loading, and every tool including the full ha_call_service safety matrix.

## 0.1.2 - 2026-08-20

- Documentation, logs, error messages and tool descriptions switched to English. Issues and commits stay in French (project knowledge base).
- New `log_level` option (trace, debug, info, notice, warning, error, fatal) applied to both the Node server and bashio. Write audit lines are emitted at any level.
- The API token generated on first start is now written back into the add-on options: it is visible and editable in the Configuration tab instead of hiding in the log.
- Documentation site (English and French) on GitHub Pages: [devitek.github.io/mcp-ha](https://devitek.github.io/mcp-ha/), diagrams in Mermaid.

## 0.1.1 - 2026-08-20

- Add-on icon and logo.
- Node 26 runtime: the binary comes from the official node:26-alpine image (the Alpine apk package does not track the latest LTS), Home Assistant Alpine 3.24 base.
- Dependency updates: zod 4, vitest 4, TypeScript 7, CI actions.
- CI: Docker image validation build on every change.

## 0.1.0 - 2026-08-20

First version.

- MCP server over Streamable HTTP (port 9583) with bearer token authentication, token generated on first start.
- 15 read tools: entity search and listings, areas, devices, services, automations (with config), scripts, history, long-term statistics, logbook, add-ons, template rendering, system info.
- One write tool, `ha_call_service`, disabled by default (`allow_write: false`) and guarded: entity glob lists, service denylist, dry_run, audit trail.
- Home Assistant connection over WebSocket with automatic reconnection.
