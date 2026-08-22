# Security

Giving an LLM access to your home automation is not a trivial decision. This document describes what the add-on protects, how, and what it deliberately does not protect.

## Threat model

**What we protect against:**

- Unwanted actions on the Home Assistant instance triggered through an MCP client (model hallucination, prompt injection in content the LLM reads, compromised client).
- Leakage of the Supervisor token: it never leaves the add-on, MCP clients have no access to it and no tool returns it.
- Information disclosure to unauthenticated clients.

**What we do not protect against (out of scope):**

- Internet exposure. The add-on speaks plain HTTP with a static token: it is a LAN design. For remote access, use an authenticated tunnel (Tailscale, Cloudflare Tunnel with Access), never a port forward. See the [Remote access guide](https://devitek.github.io/mcp-ha/guide/remote-access).
- An attacker already on your LAN sniffing traffic (no TLS).
- A legitimate MCP user requesting allowed but regrettable actions. Allowlists bound the blast radius, not the intent.

## Mechanisms in place

1. **Bearer authentication** on the MCP endpoint, constant-time comparison. The primary token is generated randomly (32 bytes) on first start when not provided, persisted in `/data/token` with mode 600, and written back into the add-on options so it is visible in the configuration panel. It never appears in full in the logs: only a masked prefix (e.g. `d370f4f8**********`) with fixed-length padding, so neither the value nor its length leaks. Additional **named tokens with a scope** (`read`/`write`) can be configured (#85): a read token never sees the write tools, and the token name is recorded on every write audit line, making the audit nominative.
2. **Read only by default.** With `allow_write: false`, none of the seven write tools (`ha_call_service`, `ha_run_script`, `ha_trigger_automation`, `ha_set_automation`, `ha_create_helper`, `ha_delete_helper`, `ha_send_notification`) is registered at all: they do not even appear in the client's tool list. Helper creation is deliberately the mildest write there is: helpers are pure state containers with no behaviour, and creating one cannot make the house act (#94 tier 1); deletion additionally honours the entity lists.
3. **Service denylist** shipped with serious defaults: `homeassistant.stop`, `homeassistant.restart`, `hassio.*`, `shell_command.*`, `python_script.*`, `recorder.purge*`, `backup.*`.
4. **Entity glob lists** for writes: `entity_allowlist` (when non-empty, everything else is refused) and `entity_denylist` (always wins). Targeting by `area_id` or `device_id` is refused as soon as an entity restriction is configured, because it would bypass the lists.
5. **Audit trail**: every write attempt, allowed or refused, is logged as a JSON line in the add-on log with its reason and the name of the token that made the call. Audit lines are emitted regardless of the configured log level, and since 0.7.0 they are also persisted to `/data/audit.log` (size-rotated, ~2 MB bounded). Deliberately, no MCP tool reads or clears that file: a compromised client cannot erase its traces; read it over SSH.
6. **dry_run** to preview a service call without executing it.
6b. **Two-step confirmation** on sensitive domains (`confirm_domains`, locks and alarms by default): the first call returns a preview and a single-use token bound to the exact call fingerprint (expires after 2 minutes); execution requires presenting that token with the same call. A token can never authorize a different action. The four service write tools share this single guarded path; the helper tools have their own simpler audited path (no behaviour to guard).
7. **filter_reads** (optional) to hide denylisted entities from reads as well (cameras, trackers...).
8. **API guard rails**: capped request body, add-on slug validated by regex before being used in a URL, error messages without stack traces.
9. **Brute-force friction**: after 5 failed authentications an IP gets progressively blocked (up to 60 s, HTTP 429 with Retry-After), and a user-set token shorter than 16 characters triggers a loud startup warning.
10. **Template gating**: `ha_render_template` can read any entity state server-side, so it is not registered at all when `filter_reads` is enabled; the denylist cannot be bypassed through Jinja.
10c. **Camera opt-in**: `ha_get_camera_snapshot` is gated by its own `allow_camera` option (off by default, independent from `allow_write`), honours `filter_reads`/`entity_denylist`, and audits every snapshot; an image leaving the house is worth a log line.
10b. **Ingress status page**: authenticated by the Home Assistant session through the Supervisor proxy, served on a port internal to the container network (never published on the LAN). Since 0.8.0 it carries the client onboarding snippets and therefore the API token, masked by default with an explicit reveal action; this is the same trust boundary as the add-on Configuration tab, which has always shown that token. The Supervisor token never appears there.
11. **Container hardening**: the Node server runs as a dedicated unprivileged user (privileges dropped after `/data` ownership is fixed) and is confined by a custom AppArmor profile. The service transitions into a tight child profile that denies `/etc/shadow`, writes outside `/data`, and `CAP_DAC_OVERRIDE`, while keeping the s6/bashio init tree working. The profile was validated on a real AppArmor-enforcing host against actual kernel denials (issue #72), after a first over-strict attempt broke container init in 0.1.6.

## Configuration writes (automations and scripts)

Since 0.10.0 the assistant can CREATE automations and scripts (#94 tier 3). This is categorically different from calling a service: a service call acts once, an automation programs standing behaviour into the house. The path is therefore the most guarded one in the add-on:

1. **Dedicated grant.** `allow_config_write` (default `false`) is independent from `allow_write`: enabling service calls never silently enables programming. Read-scoped tokens never see these tools.
2. **Validation before anything.** The trigger/condition/action blocks are validated by Home Assistant (`validate_config`) before a confirmation is even offered; an invalid config stops there.
3. **Mandatory two-step confirmation.** Unconditionally, not tied to `confirm_domains`: the first call answers with the complete YAML and a single-use token bound to the exact payload (2 min TTL). The client is instructed to show that YAML to the human and only then confirm. A token never authorizes a different payload.
4. **Creation and modification are strictly separated** (#108). Creation refuses existing targets (same alias or object id); modification (`ha_update_automation`, `ha_update_script`, since 0.14.0) only touches existing UI-managed ones, replaces blocks wholesale, and its confirmation shows a **before/after diff** rather than just the new YAML. The base config hash is part of the confirmation fingerprint: an automation edited in the UI between the two passes invalidates the token. The success answer returns the previous YAML as the rollback. Deletion stays unsupported.
5. **Nominative audit.** Every step (preview, confirmation request, refusal, write) lands in the audit trail with the token name, mirrored to `/data/audit.log`.

Residual risk to understand: once `allow_config_write` is on, a confirmed creation can program actions that `service_denylist` would have blocked as direct calls (the automation runs inside Home Assistant, not through the add-on). The YAML review step exists precisely for that reason; read it before confirming.

## Past advisories

- **Versions 0.1.0 to 0.1.3 printed the API token in full in the add-on log** at every start, and the documentation of the time invited users to read it there. Fixed in 0.1.4 (masked prefix only). If you ever shared logs produced by an affected version, rotate your token (see DOCS.md, "Rotating the API token").

## Known and accepted limitations

- `ha_render_template` evaluates Jinja on the HA side and can read the state of any entity. Without `filter_reads` the tool is available (nothing is hidden anyway); with `filter_reads` it is disabled entirely.
- The generated token is stored in the add-on options, which means it also ends up in add-on backups. The options are only visible to HA admins; the log never contains it in full.
- The add-on runs with `hassio_role: default`, the least privileged role. If `ha_get_addons` answers a 403 on your installation, please report it so the required role can be reassessed.

## Reporting a vulnerability

Use [GitHub security advisories](https://github.com/Devitek/mcp-ha/security/advisories/new) (private reporting) rather than a public issue. Describe the attack scenario and, if possible, a reproduction. Expect an answer within a few days at best: this is a personal project, not an on-call team.
