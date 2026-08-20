# MCP Home Assistant

A Home Assistant add-on that exposes an [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server, so an AI assistant such as Claude or Gemini can query and, if you allow it, control your instance.

> "Which lights were left on?", "Why didn't the heating automation trigger last night?", "Summarize this week's energy usage."

## What it does

- **Entities, areas, devices**: fuzzy search, paginated listings, full details.
- **Services**: browse the catalog and, when writes are enabled, call services with guard rails.
- **Automations and scripts**: state, last trigger, full automation configuration.
- **History**: state changes, long-term statistics, logbook.
- **Add-ons and system**: installed add-ons, HA config, error log, Jinja template rendering.

16 tools in total, designed to preserve the LLM context window: compact, paginated, capped responses.

The add-on is **read only by default**. The single write tool, `ha_call_service`, only exists once you enable `allow_write`, and stays constrained by service and entity deny/allow lists, with a JSON audit trail. See [Security](/guide/security).

## Quick start

1. [Install the add-on](/guide/installation) from this repository.
2. Start it, then open the add-on **Configuration** tab: an API token was generated and saved there.
3. [Connect your client](/guide/clients), for example Claude Code:

   ```bash
   claude mcp add --transport http home-assistant \
     http://HA_IP:9583/mcp \
     --header "Authorization: Bearer YOUR_TOKEN"
   ```

4. Ask your assistant: "which lights are on right now?"

## Requirements

- Home Assistant OS or Supervised (the add-on needs the Supervisor).
- An MCP client on your LAN: Claude Code, Claude Desktop, Gemini CLI, or anything speaking MCP over Streamable HTTP.

## Where next

- [Installation](/guide/installation)
- [Configuration options](/guide/configuration)
- [Tool reference](/reference/tools)
- [Architecture](/reference/architecture)
- [Source code on GitHub](https://github.com/Devitek/mcp-ha)
