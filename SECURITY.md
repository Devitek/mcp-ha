# Security

Giving an LLM access to your home automation is not a trivial decision. This document describes what the add-on protects, how, and what it deliberately does not protect.

## Threat model

**What we protect against:**

- Unwanted actions on the Home Assistant instance triggered through an MCP client (model hallucination, prompt injection in content the LLM reads, compromised client).
- Leakage of the Supervisor token: it never leaves the add-on, MCP clients have no access to it and no tool returns it.
- Information disclosure to unauthenticated clients.

**What we do not protect against (out of scope):**

- Internet exposure. The add-on speaks plain HTTP with a static token: it is a LAN design. For remote access, use a VPN (WireGuard, Tailscale...), not a port forward.
- An attacker already on your LAN sniffing traffic (no TLS).
- A legitimate MCP user requesting allowed but regrettable actions. Allowlists bound the blast radius, not the intent.

## Mechanisms in place

1. **Bearer authentication** on the MCP endpoint, constant-time comparison. The token is generated randomly (32 bytes) on first start when not provided, persisted in `/data/token` with mode 600, and written back into the add-on options so it is visible in the configuration panel. It never appears in full in the logs: only a masked prefix (e.g. `d370f4f8**********`) with fixed-length padding, so neither the value nor its length leaks.
2. **Read only by default.** With `allow_write: false`, the `ha_call_service` tool is not registered at all: it does not even appear in the client's tool list.
3. **Service denylist** shipped with serious defaults: `homeassistant.stop`, `homeassistant.restart`, `hassio.*`, `shell_command.*`, `python_script.*`, `recorder.purge*`, `backup.*`.
4. **Entity glob lists** for writes: `entity_allowlist` (when non-empty, everything else is refused) and `entity_denylist` (always wins). Targeting by `area_id` or `device_id` is refused as soon as an entity restriction is configured, because it would bypass the lists.
5. **Audit trail**: every write attempt, allowed or refused, is logged as a JSON line in the add-on log with its reason. Audit lines are emitted regardless of the configured log level.
6. **dry_run** to preview a service call without executing it.
7. **filter_reads** (optional) to hide denylisted entities from reads as well (cameras, trackers...).
8. **API guard rails**: capped request body, add-on slug validated by regex before being used in a URL, error messages without stack traces.

## Past advisories

- **Versions 0.1.0 to 0.1.3 printed the API token in full in the add-on log** at every start, and the documentation of the time invited users to read it there. Fixed in 0.1.4 (masked prefix only). If you ever shared logs produced by an affected version, rotate your token (see DOCS.md, "Rotating the API token").

## Known and accepted limitations

- `ha_render_template` evaluates Jinja on the HA side: read only, but a template can read the state of any entity. `filter_reads` does not apply to it.
- The generated token is stored in the add-on options, which means it also ends up in add-on backups. The options are only visible to HA admins; the log never contains it in full.
- The add-on runs with `hassio_role: default`, the least privileged role. If `ha_get_addons` answers a 403 on your installation, please report it so the required role can be reassessed.

## Reporting a vulnerability

Use [GitHub security advisories](https://github.com/Devitek/mcp-ha/security/advisories/new) (private reporting) rather than a public issue. Describe the attack scenario and, if possible, a reproduction. Expect an answer within a few days at best: this is a personal project, not an on-call team.
