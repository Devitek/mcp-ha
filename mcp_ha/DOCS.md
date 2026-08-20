# MCP Home Assistant

This add-on exposes an [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that lets an AI assistant (Claude Code, Claude Desktop, Gemini CLI...) query your Home Assistant instance: entities, areas, devices, services, automations, scripts, history, statistics and add-ons.

By default the add-on is **read only**. Writes (service calls) must be enabled explicitly and remain guarded by allow/deny lists.

Full documentation: [devitek.github.io/mcp-ha](https://devitek.github.io/mcp-ha/) (English and French).

## Getting started

1. Install the add-on and start it.
2. Open the add-on **Configuration** tab: an API token was generated and saved there on first start (the log only ever shows a masked prefix of it). Copy it.
3. Configure your MCP client (see below) with `http://HA_IP:9583/mcp` and that token.
4. Ask your assistant something like: "which lights are on?"

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `log_level` | `info` | Log verbosity: trace, debug, info, notice, warning, error, fatal. Write audit lines are always emitted. |
| `api_token` | empty | Token expected from MCP clients (`Authorization: Bearer ...`). Leave empty to have one generated on first start and saved back into this option. The log only shows a masked prefix. |
| `allow_write` | `false` | Exposes the `ha_call_service` tool. Without it, no write tool is even visible to the client. |
| `filter_reads` | `false` | Also applies `entity_denylist` to reads: hidden entities disappear from listings and from `ha_get_entity`. |
| `entity_allowlist` | `[]` | Glob patterns of entities allowed for writes (e.g. `light.*`). When non-empty, everything else is refused. |
| `entity_denylist` | `[]` | Glob patterns of entities forbidden for writes (e.g. `lock.*`). The denylist always wins. |
| `service_denylist` | see config | Services refused in any context. The defaults block HA shutdown, shell_command, recorder purge, etc. Think twice before removing entries. |

## Connecting clients

Replace `HA_IP` and `YOUR_TOKEN`.

**Claude Code (CLI)**:

```bash
claude mcp add --transport http home-assistant \
  http://HA_IP:9583/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://HA_IP:9583/mcp",
               "--header", "Authorization: Bearer YOUR_TOKEN"]
    }
  }
}
```

**Gemini CLI** (`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "home-assistant": {
      "httpUrl": "http://HA_IP:9583/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

## Security

- The add-on is designed for **LAN use only**. Do not expose port 9583 to the internet: there is no TLS and no OAuth.
- The API token is a secret: do not paste it in a ticket or a screen share.
- `allow_write` is disabled by default. Enable it only if you want the assistant to act, and consider `entity_allowlist` / `entity_denylist`.
- Every write attempt (allowed or refused) is logged as JSON in the add-on log, at any log level.
- Known limitation: `ha_render_template` evaluates Jinja templates on the HA side and can read any entity state, `filter_reads` does not apply to it.

The full threat model is in the repository's [SECURITY.md](https://github.com/Devitek/mcp-ha/blob/main/SECURITY.md).

## Troubleshooting

- **Lost token**: it is visible in the add-on Configuration tab (option `api_token`) and kept in `/data/token`; the log never shows it in full. If the option looks empty, restart the add-on: the write-back is retried at every start. To force a new token, clear the option and delete the file, then restart.
- **401 Unauthorized**: check the `Authorization: Bearer ...` header on the client side, without stray spaces.
- **Tools answer "WebSocket is not connected"**: check the log, the add-on reconnects continuously. A Home Assistant restart causes a short outage, reconnection is automatic.
- **`ha_get_addons` fails**: the Supervisor API is only reachable when running as a real add-on (not in dev mode).
- **Noisy or too quiet logs**: adjust the `log_level` option (debug and trace add WebSocket and HTTP details).
- **Health**: `http://HA_IP:9583/health` answers without authentication with the WebSocket connection state.
