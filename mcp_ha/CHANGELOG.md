# Changelog

## 0.1.5 - 2026-08-21

First batch of the external audit (see AUDIT.md and the `audit` label on the issue tracker).

- **Advisory**: versions 0.1.0 to 0.1.3 printed the API token in full in the add-on log. If you ever shared logs from those versions, rotate your token (DOCS, "Rotating the API token").
- Security hardening: `hassio_role` lowered to `default` (least privilege; report any 403 from `ha_get_addons`), `/health` no longer discloses the version, short user-set tokens now trigger a loud warning, generated token written atomically.
- Robustness: timeouts and one GET retry on every HTTP call to Home Assistant, hard 15 s deadline on the WebSocket handshake, long backoff after repeated `auth_invalid`, options write-back re-checked and retried while the Supervisor boots, corrupted `options.json` degrades to defaults instead of crash-looping, graceful shutdown drains in-flight requests.
- `/health` answers 503 `degraded` once the HA connection has been down for more than 5 minutes, so the container healthcheck finally reflects reality.
- Supply chain: `home-assistant/builder` pinned by commit SHA, `node` build image pinned by digest with a musl compatibility check at build time, release guard now also checks `src/config.ts` VERSION.
- run.sh survives running without a Supervisor (standalone Docker, CI smoke).
- Tests: 104 to 125 (HTTP auth boundary, token write-back, retries, config validation), plus a typecheck of the test files in CI.

## 0.1.4 - 2026-08-20

- Security: the API token no longer appears in full in the add-on log, on any code path. Only a masked prefix with fixed-length padding is shown (e.g. `d370f4f8**********`), which reveals neither the value nor its length. The full token lives in the Configuration tab (`api_token` option). A unit test guards this invariant.
- The documentation site now documents its own LLM-friendly resources (llms.txt, llms-full.txt, raw `.md` twin of every page) and their availability on Context7.

## 0.1.3 - 2026-08-20

- Fixed: history and logbook responses were sized above the global response cap, so maxed-out responses always arrived truncated. History now downsamples to 250 points and the logbook caps at 100 events, both fitting under the cap. Found by the new unit tests.
- LLM-friendly documentation on the site following the llms.txt convention: [/llms.txt](https://devitek.github.io/mcp-ha/llms.txt) (index) and [/llms-full.txt](https://devitek.github.io/mcp-ha/llms-full.txt) (full docs in one file), regenerated on every site build.
- Test suite grown from 29 to 100 unit tests: WebSocket client against a real local server, HTTP client, registry catalog join, configuration loading, and every tool including the full ha_call_service safety matrix.

## 0.1.2 - 2026-08-20

- Documentation, logs, error messages and tool descriptions switched to English. Issues and commits stay in French (project knowledge base).
- New `log_level` option (trace, debug, info, notice, warning, error, fatal) applied to both the Node server and bashio. Write audit lines are emitted at any level.
- The API token generated on first start is now written back into the add-on options: it is visible and editable in the Configuration tab instead of hiding in the log.
- Documentation site (English and French) on GitHub Pages: [devitek.github.io/mcp-ha](https://devitek.github.io/mcp-ha/), diagrams in Mermaid.

## 0.1.1 - 2026-08-20

- Add-on icon and logo.
- Node 26 runtime: the binary comes from the official node:26-alpine image (the Alpine apk package does not track the latest LTS), Home Assistant Alpine 3.24 base.
- Dependency updates: zod 4, vitest 4, TypeScript 7, CI actions.
- CI: Docker image validation build on every change.

## 0.1.0 - 2026-08-20

First version.

- MCP server over Streamable HTTP (port 9583) with bearer token authentication, token generated on first start.
- 15 read tools: entity search and listings, areas, devices, services, automations (with config), scripts, history, long-term statistics, logbook, add-ons, template rendering, system info.
- One write tool, `ha_call_service`, disabled by default (`allow_write: false`) and guarded: entity glob lists, service denylist, dry_run, audit trail.
- Home Assistant connection over WebSocket with automatic reconnection.
