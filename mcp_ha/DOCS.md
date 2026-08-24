# MCP Home Assistant

This add-on exposes an [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that lets an AI assistant (Claude Code, Claude Desktop, Gemini CLI...) query your Home Assistant instance: entities, areas, devices, services, automations, scripts, history, statistics and add-ons. Beyond the tools it also exposes MCP resources (`ha://areas`, `ha://services`, `ha://config`) and guided prompts (automation diagnosis, energy report).

By default the add-on is **read only**. Writes (service calls) must be enabled explicitly and remain guarded by allow/deny lists.

Full documentation: [devitek.github.io/mcp-ha](https://devitek.github.io/mcp-ha/) (English and French).

## Getting started

1. Install the add-on and start it.
2. Open the add-on **Configuration** tab: an API token was generated and saved there on first start (the log only ever shows a masked prefix of it). Copy it.
3. Configure your MCP client (see below) with `http://HA_IP:9583/mcp` and that token.
4. Ask your assistant something like: "which lights are on?"

## Status page

The add-on adds an entry in the Home Assistant sidebar (and an **Open Web UI** button): a status page showing version, uptime, WebSocket state and active options, plus a **Connect a client** section with ready-to-copy configs for Claude Code, Claude Desktop and Gemini CLI, **usage counters** (tool calls since start, per token) and the **recent write audit** (last 50 entries; MCP clients can never read or clear the audit, only you can, behind your HA session). The snippets embed the URL you browse HA through and your API token, masked on screen (the Copy button always copies the full working version). The page is served through HA ingress: your HA session authenticates you, the same trust level as the Configuration tab where the token already lives. The Supervisor token never appears.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `log_level` | `info` | Log verbosity: trace, debug, info, notice, warning, error, fatal. Write audit lines are always emitted, and also persisted to `/data/audit.log` (size-rotated; no MCP tool can read or clear it). |
| `api_token` | empty | Token expected from MCP clients (`Authorization: Bearer ...`). Leave empty to have one generated on first start and saved back into this option. The log only shows a masked prefix. |
| `allow_write` | `false` | Exposes the six write tools (`ha_call_service`, `ha_run_script`, `ha_trigger_automation`, `ha_set_automation`, `ha_create_helper`, `ha_delete_helper`). Without it, no write tool is even visible to the client. |
| `allow_camera` | `false` | Exposes `ha_get_camera_snapshot` (camera still images). Independent from `allow_write`. |
| `allow_config_write` | `false` | Exposes `ha_create_automation` and `ha_create_script` (creation only, HA-validated, mandatory two-step confirmation with the full YAML). Independent from `allow_write`. |
| `enable_sessions` | `false` | Long-lived MCP sessions: entity subscriptions with notifications and in-protocol confirmations. Stateless clients keep working. 16 max, 30 min idle timeout. |
| `filter_reads` | `false` | Also applies `entity_denylist` to reads: hidden entities disappear from listings, entity details, history, statistics and the logbook. Also disables `ha_render_template`, which could otherwise read any entity through Jinja. |
| `entity_allowlist` | `[]` | Glob patterns of entities allowed for writes (e.g. `light.*`). When non-empty, everything else is refused. |
| `entity_denylist` | `[]` | Glob patterns of entities forbidden for writes (e.g. `lock.*`). The denylist always wins. |
| `service_denylist` | see config | Services refused in any context. The defaults block HA shutdown, shell_command, recorder purge, etc. Think twice before removing entries. |
| `confirm_domains` | `[lock, alarm_control_panel]` | Writes on these domains require a two-step confirmation: preview plus single-use token first, execution only with the token. |

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
- `allow_write` is disabled by default. Enable it only if you want the assistant to act, and consider `entity_allowlist` / `entity_denylist`. Locks and alarms additionally require a two-step confirmation (`confirm_domains`).
- Every write attempt (allowed or refused) is logged as JSON in the add-on log, at any log level.
- `ha_render_template` evaluates Jinja templates on the HA side and can read any entity state: with `filter_reads` enabled the tool is disabled entirely.
- Repeated failed authentications from the same IP are progressively blocked (HTTP 429).

### Rotating the API token

The token lives in three places: the `api_token` option, `/data/token`, and any add-on backup taken since it was generated. To rotate it:

1. Clear the `api_token` option in the Configuration tab and save.
2. Restart the add-on: a fresh token is generated, saved into the option and persisted in `/data/token`.
3. Update your MCP clients with the new value.

Rotate immediately if you ever shared add-on logs produced by a version older than 0.1.4: those versions printed the token in full in the log.

The full threat model is in the repository's [SECURITY.md](https://github.com/Devitek/mcp-ha/blob/main/SECURITY.md).

## Troubleshooting

When asking for help in an issue, paste the output of the `ha_get_self_test` tool: it diagnoses the add-on itself (connectivity, latencies, live map) and contains no data from your home.

- **Lost token**: it is visible in the add-on Configuration tab (option `api_token`) and kept in `/data/token`; the log never shows it in full. If the option looks empty, restart the add-on: the write-back is retried at every start. To force a new token, clear the option and delete the file, then restart.
- **401 Unauthorized**: check the `Authorization: Bearer ...` header on the client side, without stray spaces.
- **Tools answer "WebSocket is not connected"**: check the log, the add-on reconnects continuously. A Home Assistant restart causes a short outage, reconnection is automatic.
- **`ha_get_addons` fails**: the Supervisor API is only reachable when running as a real add-on (not in dev mode).
- **Noisy or too quiet logs**: adjust the `log_level` option (debug and trace add WebSocket and HTTP details).
- **Health**: `http://HA_IP:9583/health` answers without authentication with the WebSocket connection state.
