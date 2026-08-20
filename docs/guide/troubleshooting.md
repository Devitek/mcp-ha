# Troubleshooting

## Lost API token

It is visible in the add-on **Configuration** tab (`api_token` option) and kept in `/data/token`. The log never shows it in full, only a masked prefix. If the option looks empty, restart the add-on: the write-back is retried at every start. To force a new token: clear the option, delete `/data/token`, restart.

## 401 Unauthorized

- Check the header: `Authorization: Bearer YOUR_TOKEN`, no stray spaces or quotes.
- The token in your client must match the `api_token` option exactly.
- Each unauthorized attempt is logged (`Unauthorized MCP request from ...`), which confirms the request reaches the add-on.

## Tools answer "Home Assistant WebSocket is not connected"

The add-on maintains a permanent WebSocket to Home Assistant and reconnects with backoff. A short outage right after an HA restart is normal.

- Check the add-on log: you should see `Connecting to Home Assistant WebSocket...` then `Authenticated with Home Assistant`.
- If it loops on reconnection, raise `log_level` to `debug` and look at the reason.

## `ha_get_addons` fails

The Supervisor API only exists when running as a real add-on. In dev mode (outside HA), this tool answers a clear error; everything else works.

## Responses look truncated

That is by design: responses are capped (about 15 KB) to protect the LLM context window. The `note` field tells the assistant how to refine (domain/area filters, shorter time window, pagination). It is a feature, not a bug.

## Logs too quiet or too noisy

Adjust the `log_level` option: `debug` adds WebSocket commands, HTTP calls and tool invocations; `trace` adds raw frame details and tool arguments. See [Logging](/reference/logging).

## Is the server alive?

`http://HA_IP:9583/health` answers without authentication:

```json
{ "status": "ok", "websocket": true }
```

`websocket: false` means the add-on runs but is not (yet) connected to Home Assistant. After more than 5 minutes of lost connection the endpoint answers 503 with `"status": "degraded"`, which lets the container healthcheck restart the add-on.

## Something else?

Open an [issue on GitHub](https://github.com/Devitek/mcp-ha/issues) with the add-on version, your HA version, the client used and a log excerpt (mask your token).
