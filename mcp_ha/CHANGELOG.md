# Changelog

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
