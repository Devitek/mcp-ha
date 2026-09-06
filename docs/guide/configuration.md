# Configuration

All options live in the add-on **Configuration** tab. Restart the add-on after changing them.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `log_level` | `info` | Log verbosity: `trace`, `debug`, `info`, `notice`, `warning`, `error`, `fatal`. See [Logging](/reference/logging). |
| `api_token` | empty | Primary token (full access) expected from MCP clients in the `Authorization: Bearer ...` header. Leave empty to have one generated on first start (it is saved back into this option). |
| `allow_write` | `false` | Exposes the `ha_call_service` tool. Without it the add-on is strictly read only: no write tool is even visible to the client. |
| `allow_camera` | `false` | Exposes `ha_get_camera_snapshot` (still images from cameras). Independent from `allow_write`; seeing your home is not acting on it, but it gets its own switch. `filter_reads` and `entity_denylist` still apply. |
| `allow_config_write` | `false` | Exposes the eight config write tools: creation, modification and deletion of automations and scripts, blueprint instantiation, dashboard cards (HA-validated where possible, mandatory two-step confirmation). Independent from `allow_write`, and since 0.31.0 it also covers the runtime controls of what it manages (run, trigger, enable/disable): whoever can rewrite an automation can make it do anything anyway, so the access levels stopped pretending otherwise (#165). See the [security model](https://github.com/Devitek/mcp-ha/blob/main/SECURITY.md). |
| `enable_sessions` | `false` | Long-lived MCP sessions: SSE streams, `ha://entity/{id}` subscriptions with change notifications, and in-protocol confirmations (elicitation). Stateless clients keep working unchanged. 16 sessions max, 30 min idle timeout. |
| `filter_reads` | `false` | Also applies `entity_denylist` to reads: denied entities disappear from listings, details, history and logbook. |
| `entity_allowlist` | `[]` | Glob patterns of entities allowed for writes. When non-empty, writes are deny-by-default. |
| `entity_denylist` | `[]` | Glob patterns of entities always refused for writes. Wins over the allowlist. |
| `service_denylist` | see below | Services refused in any context. |
| `confirm_domains` | `[lock, alarm_control_panel]` | Writes on these domains require a two-step confirmation: the assistant first gets a preview and a single-use token, and must call again with it to execute. |

## Named tokens

The single `api_token` grants full access (it is the bootstrap and recovery token). Every other token is created on the ingress page and stored **hashed** in a local database. The YAML `api_tokens` option was removed in 1.3.0: tokens it used to hold were imported into the store by earlier versions (0.32 to 1.2) and keep working; a leftover key in the stored options is ignored by the Supervisor and cleaned up automatically at boot. Creating tokens happens on the **ingress page** (sidebar entry), Tokens tab: pick a level (none / read / write / manage) per tool category, optionally an expiry and per-token entity lists (applied on writes, on top of the global ones). The secret is shown once at creation; grants are capped by the `allow_*` options on every request, so closing a gate instantly degrades every token. Revocation is one click.

## Backups

Home Assistant backups (full, or partial with the add-on ticked) include the add-on's `/data`, so the token store travels with them:

- **Nothing sensitive leaks**: the database only holds sha256 hashes, names and grants. A stolen backup yields no usable token (unlike the deprecated clear-text `api_tokens` option of the pre-1.0 era).
- **Consistency is guaranteed by a snapshot**: the Supervisor archives `/data` while the add-on runs, so the live `tokens.db` inside a backup could be torn. After every mutation the add-on writes `tokens.snapshot.db` through SQLite's `VACUUM INTO` plus an atomic rename: the backup always carries at least one coherent copy, and the add-on restores from it automatically if the main database ever turns out unreadable (the broken file is kept alongside as evidence).
- **Restoring a backup** brings back the tokens as they were at backup time: clients holding secrets created after it get a 401 and need a fresh token.

## Glob patterns

Lists accept simple globs where `*` matches anything and every other character is literal:

- `light.*` : every light
- `lock.front_door` : one exact entity
- `*.kitchen_*` : any domain, entities whose name starts with `kitchen_`

Matching is case insensitive.

## Write rules

A service call must pass **all** of these checks, in order:

1. `allow_write` is enabled (otherwise the tool is not registered at all).
2. The service is not in `service_denylist`.
3. Every targeted `entity_id` passes the allow/deny lists: allowed when the allowlist is empty or matches, and the denylist does not match. **The denylist always wins.**
4. When any entity restriction is configured, targeting by `area_id` or `device_id` is refused (it would bypass the lists): target explicit `entity_id` values instead.
5. On a domain listed in `confirm_domains`, the call must carry a valid `confirm_token` obtained from a first call (single use, expires after 5 minutes, bound to the exact same call).

These rules apply identically to all four write tools (`ha_call_service`, `ha_run_script`, `ha_trigger_automation`, `ha_set_automation`): they share a single guarded write path. Every attempt, allowed or refused, produces a JSON audit line in the add-on log.

## Default service denylist

```yaml
service_denylist:
  - homeassistant.stop
  - homeassistant.restart
  - hassio.*
  - shell_command.*
  - python_script.*
  - recorder.purge*
  - backup.*
```

These block stopping or restarting Home Assistant, arbitrary shell commands, recorder purges and backup manipulation. You can edit the list, but think twice before removing entries.

## Example: cautious write setup

Allow the assistant to control lights and media players, nothing else, and hide cameras from reads:

```yaml
allow_write: true
entity_allowlist:
  - light.*
  - media_player.*
entity_denylist:
  - light.baby_room
filter_reads: true
# entity_denylist also hides these from reads thanks to filter_reads
```
