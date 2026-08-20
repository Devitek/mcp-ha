# Configuration

All options live in the add-on **Configuration** tab. Restart the add-on after changing them.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `log_level` | `info` | Log verbosity: `trace`, `debug`, `info`, `notice`, `warning`, `error`, `fatal`. See [Logging](/reference/logging). |
| `api_token` | empty | Token expected from MCP clients in the `Authorization: Bearer ...` header. Leave empty to have one generated on first start (it is saved back into this option). |
| `allow_write` | `false` | Exposes the `ha_call_service` tool. Without it the add-on is strictly read only: no write tool is even visible to the client. |
| `filter_reads` | `false` | Also applies `entity_denylist` to reads: denied entities disappear from listings, details, history and logbook. |
| `entity_allowlist` | `[]` | Glob patterns of entities allowed for writes. When non-empty, writes are deny-by-default. |
| `entity_denylist` | `[]` | Glob patterns of entities always refused for writes. Wins over the allowlist. |
| `service_denylist` | see below | Services refused in any context. |

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

Every attempt, allowed or refused, produces a JSON audit line in the add-on log.

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
