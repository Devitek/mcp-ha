# MCP Home Assistant

A Home Assistant add-on that exposes an [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server, so an AI assistant such as Claude or Gemini can query and, if you allow it, control your instance.

> "Which lights were left on?", "Why didn't the heating automation trigger last night?", "Summarize this week's energy usage."

## What it does

- **Entities, areas, devices**: fuzzy search, paginated listings, full details.
- **Services**: browse the catalog and, when writes are enabled, call services with guard rails.
- **Automations and scripts**: state, last trigger, full automation configuration.
- **History**: state changes, long-term statistics, logbook.
- **Add-ons and system**: installed add-ons, HA config, error log, Jinja template rendering.
- **MCP surface beyond tools**: resources (`ha://areas`, `ha://services`, `ha://config`), guided prompts (automation diagnosis, energy report), `structuredContent` on every response, and a status page in the HA sidebar with ready-to-copy client configs.

40 tools (25 read, 15 guarded write), designed to preserve the LLM context window: compact, paginated, capped responses.

The add-on is **read only by default**. The write tools (`ha_call_service`, `ha_run_script`, `ha_trigger_automation`, `ha_set_automation`) only exist once you enable `allow_write`, all go through the same guarded path (service and entity deny/allow lists, dry run, JSON audit trail), and sensitive domains such as locks and alarms require a two-step confirmation. See [Security](/guide/security).

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

## Documentation for LLMs

This documentation follows the [llms.txt convention](https://llmstxt.org), so AI assistants and agents can consume it directly:

- [`/llms.txt`](https://devitek.github.io/mcp-ha/llms.txt): a compact index with a summary and described links, ideal for an agent that picks what to read.
- [`/llms-full.txt`](https://devitek.github.io/mcp-ha/llms-full.txt): the entire documentation in a single markdown file, ideal to paste into a conversation or ingest in one shot.
- Every English page also exists as raw markdown: append `.md` to its URL (e.g. [/reference/tools.md](https://devitek.github.io/mcp-ha/reference/tools.md)). The French mirror has no `.md` twins.

These files are regenerated on every site build, in English only. The documentation is also indexed on [Context7](https://context7.com), for agents that resolve library docs through the Context7 MCP server.

## Where next

- [Installation](/guide/installation)
- [Configuration options](/guide/configuration)
- [Tool reference](/reference/tools)
- [Architecture](/reference/architecture)
- [Source code on GitHub](https://github.com/Devitek/mcp-ha)
