# Connecting clients

The server speaks MCP over **Streamable HTTP** at `http://HA_IP:9583/mcp`, with a bearer token. Replace `HA_IP` and `YOUR_TOKEN` in the examples below.

::: tip
The endpoint only accepts POST (stateless mode). `http://HA_IP:9583/health` answers without authentication and tells you whether the add-on is connected to Home Assistant.
:::

## Claude Code (CLI)

```bash
claude mcp add --transport http home-assistant \
  http://HA_IP:9583/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

Then just ask questions in a session: "which lights are on?", "show me the automations that ran tonight".

## Claude Desktop

Claude Desktop launches MCP servers itself, so it needs a small bridge (`mcp-remote`) to reach an HTTP server. In `claude_desktop_config.json`:

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

Restart Claude Desktop after editing the file.

## Gemini CLI

In `~/.gemini/settings.json`:

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

## Any other MCP client

Anything that supports MCP over Streamable HTTP works the same way: endpoint `http://HA_IP:9583/mcp`, header `Authorization: Bearer YOUR_TOKEN`. The server is stateless: no session negotiation, each POST is independent.

## From outside your network

The examples above assume the client is on your LAN. To reach the add-on from a phone or the claude.ai / Gemini web connectors, set up an authenticated HTTPS tunnel: see [Remote access](/guide/remote-access). Never port-forward 9583 directly.

## First prompts to try

- "Which lights are on right now?"
- "What is the temperature in the living room and how did it evolve today?"
- "List my automations, which ones ran in the last 24 hours?"
- "What happened in the house tonight?" (logbook)
- With `allow_write` enabled: "Turn off every light in the kitchen" (the assistant will use `ha_call_service`; ask it to use `dry_run` first if you want a preview)
