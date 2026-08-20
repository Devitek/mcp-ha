# Logging

## Levels

The `log_level` option controls verbosity, from most to least verbose:

| Level | What you get |
|-------|--------------|
| `trace` | raw WebSocket frame metadata, tool arguments |
| `debug` | WebSocket commands, HTTP calls to HA, MCP requests, tool invocations |
| `info` | startup summary, connection lifecycle (default) |
| `notice` | noteworthy events: unauthorized attempts, token written to options |
| `warning` | recoverable problems: reconnections, failed tool calls |
| `error` | HA connection refusals, configuration read errors |
| `fatal` | startup failure |

The same value is applied to bashio (the `run.sh` wrapper), so Supervisor-side lines follow the same threshold.

## Format

One line per event on stderr, visible in the add-on **Log** tab:

```
[2026-08-20T15:30:12.345Z] INFO mcp-ha x.y.z listening on port 9583 (MCP endpoint /mcp, health /health)
[2026-08-20T15:30:12.401Z] DEBUG WS command get_states (id 12)
```

## Audit trail

Write attempts through `ha_call_service` produce one JSON line each, **regardless of the log level**. This is a security record, not debug output: lowering the verbosity never silences it.

```json
{"ts":"2026-08-20T15:31:02.000Z","audit":true,"tool":"ha_call_service","domain":"light","service":"turn_on","target":{"entity_id":["light.kitchen"]},"allowed":true,"result":"ok"}
```

Refused attempts carry `"allowed": false` and a `reason`. Secrets never appear in audit lines.

## Secrets

No secret is ever logged in full, at any level. The API token only appears as a masked prefix with fixed-length padding (`d370f4f8**********`); the full value lives in the add-on Configuration tab. A unit test guards this invariant.

## Diagnosing

- Connection issues: `debug` shows every WS command and reconnection with its backoff delay.
- Tool behaviour: `debug` logs each tool invocation, `trace` adds the (truncated) arguments.
- Client authentication: unauthorized requests are logged at `notice` with the source address.

In dev mode (outside the add-on), set the level with the `LOG_LEVEL` environment variable.
