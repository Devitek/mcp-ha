# mcp-ha: an MCP server for Home Assistant, as an add-on

[![CI](https://github.com/Devitek/mcp-ha/actions/workflows/ci.yaml/badge.svg)](https://github.com/Devitek/mcp-ha/actions/workflows/ci.yaml)
[![Release](https://img.shields.io/github/v/release/Devitek/mcp-ha?sort=semver)](https://github.com/Devitek/mcp-ha/releases)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

This Home Assistant add-on exposes an [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server. In practice: you connect Claude, Gemini or any other MCP client to your instance, and you talk to your home.

> "Which lights were left on?", "Why didn't the heating automation trigger last night?", "Plot my energy usage for the week."

**Documentation: [devitek.github.io/mcp-ha](https://devitek.github.io/mcp-ha/)** (English and French)

## What it covers

| Domain | Tools |
|--------|-------|
| Entities, areas, devices | fuzzy search, paginated lists, full details |
| Services | catalog per domain, search, guarded call (opt-in) |
| Automations | list, state, last trigger, full configuration, execution traces, guarded creation (opt-in) |
| Diagnostics | one-call health report (repairs, unavailable, batteries, stale automations) |
| Scripts | list, running state |
| History | state changes, long-term statistics, logbook |
| Helpers | create and delete input_*, counters, timers (opt-in) |
| Calendar and to-do | events over a window, list items |
| Cameras | still snapshots as images (opt-in) |
| Add-ons | list and details (read) |
| System | Jinja template rendering, HA config, error log |

28 tools (20 read, 8 guarded write), designed to save the LLM context window: compact, paginated and capped responses, with notes that steer the assistant towards more precise queries.

## Why not the official HA MCP integration?

It exists and works, but it goes through the Assist API: only entities exposed to Assist, no history, no registries, no add-ons, no automation configs. This add-on gives direct, granular access. Both can coexist.

## Installation

Requirements: Home Assistant OS or Supervised (the add-on needs the Supervisor).

1. Add this repository to your add-on repositories:

   [![Add repository](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FDevitek%2Fmcp-ha)

   Or manually: Settings, Add-ons, Add-on store, three-dot menu, Repositories, then paste `https://github.com/Devitek/mcp-ha`.

2. Install "MCP Home Assistant" and start it.
3. Open the add-on Configuration tab: an API token was generated and saved there on first start (the log only ever shows a masked prefix).

## Connecting a client

**Claude Code**:

```bash
claude mcp add --transport http home-assistant \
  http://HA_IP:9583/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

**Claude Desktop** and **Gemini CLI**: see the [clients guide](https://devitek.github.io/mcp-ha/guide/clients) on the documentation site.

## Security, in short

- **Read only by default.** The service-call tool does not even exist for the client unless you enable `allow_write`.
- **Defense in depth** when writes are enabled: denylist of dangerous services (HA shutdown, shell_command...), glob allow/deny lists for entities, `dry_run` mode, JSON audit trail of every attempt in the log.
- **LAN only.** No TLS, no OAuth: do not expose port 9583 to the internet.

The full threat model is in [SECURITY.md](SECURITY.md).

## Documentation

- [Documentation site](https://devitek.github.io/mcp-ha/): installation, configuration, clients, tool reference, architecture (English and French)
- LLM-friendly docs following the llms.txt convention: [llms.txt](https://devitek.github.io/mcp-ha/llms.txt) (index) and [llms-full.txt](https://devitek.github.io/mcp-ha/llms-full.txt) (everything in one file), also indexed on [Context7](https://context7.com)
- [Add-on documentation](mcp_ha/DOCS.md): the page shown in the HA interface
- [Contributing guide](CONTRIBUTING.md): dev setup, conventions, releases
- [Repository issues](https://github.com/Devitek/mcp-ha/issues?q=is%3Aissue): the project knowledge base, every design decision and pitfall is tracked there with the `décision` and `écueil` labels (in French)

## License

[MIT](LICENSE)
