# MCP Home Assistant add-on

Home Assistant add-on exposing an MCP (Model Context Protocol) server, so AI
assistants such as Claude or Gemini can query and, when explicitly allowed,
control your instance.

- User documentation: [DOCS.md](DOCS.md) (shown in the HA interface) and the
  [documentation site](https://devitek.github.io/mcp-ha/) (English and French).
- Source layout: `src/` TypeScript server, `config.yaml` add-on manifest,
  `Dockerfile` multi-stage build.
- Repository root: [github.com/Devitek/mcp-ha](https://github.com/Devitek/mcp-ha).
