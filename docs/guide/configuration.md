# Configuration

All options live in the add-on **Configuration** tab. Restart the add-on after changing them.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `log_level` | `info` | Log verbosity: `trace`, `debug`, `info`, `notice`, `warning`, `error`, `fatal`. See [Logging](/reference/logging). |
| `api_token` | empty | Primary token (full access) expected from MCP clients in the `Authorization: Bearer ...` header. Leave empty to have one generated on first start (it is saved back into this option). |
| `api_tokens` | `[]` | Legacy named tokens with a scope. Since 0.32.0 they are imported (hashed) into the token store at boot and the option is blanked; management moves to the ingress page. See [Named tokens](#named-tokens). |
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

The single `api_token` grants full access (it is the bootstrap and recovery token). Since 0.32.0, named tokens are stored **hashed** in a local database: entries added below are imported into it at the next start (with the grants their scope implies) and the clear-text option is blanked. Creating tokens happens on the **ingress page** (sidebar entry), Tokens tab: pick a level (none / read / write / manage) per tool category, optionally an expiry and per-token entity lists (applied on writes, on top of the global ones). The secret is shown once at creation; grants are capped by the `allow_*` options on every request, so closing a gate instantly degrades every token. Revocation is one click.

Legacy form, still accepted as an import source:

```yaml
api_tokens:
  - name: main-assistant
    token: <a long random string>
    scope: write
  - name: dashboard
    token: <another long random string>
    scope: read
```

- `scope: read` sees only the 15 read tools; the write tools are not even registered for that token.
- `scope: write` behaves like the primary token (subject to `allow_write` and all the lists).
- The **token name appears in the write audit log**, so you know which client acted.
- Generate strong values yourself (32+ hex chars); a token shorter than 16 characters triggers a startup warning.

The primary `api_token` keeps working alongside these and always has full access.

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
