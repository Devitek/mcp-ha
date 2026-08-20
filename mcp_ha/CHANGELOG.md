# Changelog

## 0.1.4

- Security: the API token no longer appears in full in the add-on log, on any code path. Only a masked prefix with fixed-length padding is shown (e.g. `d370f4f8**********`), which reveals neither the value nor its length. The full token lives in the Configuration tab (`api_token` option). A unit test guards this invariant.
- The documentation site now documents its own LLM-friendly resources (llms.txt, llms-full.txt, raw `.md` twin of every page) and their availability on Context7.

## 0.1.3

- Fixed: history and logbook responses were sized above the global response cap, so maxed-out responses always arrived truncated. History now downsamples to 250 points and the logbook caps at 100 events, both fitting under the cap. Found by the new unit tests.
- LLM-friendly documentation on the site following the llms.txt convention: [/llms.txt](https://devitek.github.io/mcp-ha/llms.txt) (index) and [/llms-full.txt](https://devitek.github.io/mcp-ha/llms-full.txt) (full docs in one file), regenerated on every site build.
- Test suite grown from 29 to 100 unit tests: WebSocket client against a real local server, HTTP client, registry catalog join, configuration loading, and every tool including the full ha_call_service safety matrix.

## 0.1.2

- Documentation, logs, error messages and tool descriptions switched to English. Issues and commits stay in French (project knowledge base).
- New `log_level` option (trace, debug, info, notice, warning, error, fatal) applied to both the Node server and bashio. Write audit lines are emitted at any level.
- The API token generated on first start is now written back into the add-on options: it is visible and editable in the Configuration tab instead of hiding in the log.
- Documentation site (English and French) on GitHub Pages: [devitek.github.io/mcp-ha](https://devitek.github.io/mcp-ha/), diagrams in Mermaid.

## 0.1.1

- Add-on icon and logo.
- Node 26 runtime: the binary comes from the official node:26-alpine image (the Alpine apk package does not track the latest LTS), Home Assistant Alpine 3.24 base.
- Dependency updates: zod 4, vitest 4, TypeScript 7, CI actions.
- CI: Docker image validation build on every change.

## 0.1.0

First version.

- MCP server over Streamable HTTP (port 9583) with bearer token authentication, token generated on first start.
- 15 read tools: entity search and listings, areas, devices, services, automations (with config), scripts, history, long-term statistics, logbook, add-ons, template rendering, system info.
- One write tool, `ha_call_service`, disabled by default (`allow_write: false`) and guarded: entity glob lists, service denylist, dry_run, audit trail.
- Home Assistant connection over WebSocket with automatic reconnection.
