# Remote access

The add-on is designed for **LAN use**: plain HTTP, a static bearer token, no TLS. That is the right default for a home server, but it means the endpoint is only reachable from your local network. To talk to your home from outside (a phone, a laptop away from home, the claude.ai or Gemini web connectors), you need an authenticated HTTPS entry point.

::: danger Never port-forward
Do not expose port 9583 directly on the internet with a router port forward. It is plain HTTP protected by a single token: anyone scanning the internet would find it, and a leaked token would be game over. Use one of the tunnels below instead.
:::

## Option A: Tailscale (recommended)

[Tailscale](https://tailscale.com) puts your devices on a private mesh network; nothing is published to the public internet. There is an official Home Assistant Tailscale add-on.

1. Install and start the **Tailscale** add-on, log in, and note the machine name your HA gets (e.g. `homeassistant`).
2. Your phone or laptop, once on the same tailnet, reaches the add-on at `http://homeassistant:9583/mcp` (or the tailnet IP). Point your MCP client there.
3. For an HTTPS URL that the web connectors accept, enable **Tailscale Serve** to expose the add-on over HTTPS inside your tailnet:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:9583
   ```

   You then use `https://<machine>.<tailnet>.ts.net/mcp`.

Trust model: your traffic stays inside your tailnet, the bearer token never crosses the public internet, and only devices you authorized can reach the endpoint. This is the safest option.

## Option B: Cloudflare Tunnel

A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) exposes a service over HTTPS on a domain you control, without opening a port. Combine it with **Cloudflare Access** so only authenticated users reach it.

1. Create a tunnel and route a hostname (e.g. `mcp.example.com`) to `http://homeassistant:9583`.
2. Put a Cloudflare Access policy in front of that hostname (email allowlist, or a service token for programmatic clients). Without Access, the tunnel is public and only your bearer token stands between the internet and your home; add Access.
3. Your MCP client uses `https://mcp.example.com/mcp` with the bearer token.

Trust model: Cloudflare terminates TLS and sees your traffic (including the bearer token). That is an extra third party to trust. Cloudflare Access is what keeps the endpoint from being open to the world.

## What about built-in OAuth?

Evaluated and deliberately not implemented ([issue #84](https://github.com/Devitek/mcp-ha/issues/84)). The short version:

- The add-on does not terminate TLS: OAuth flows over plain HTTP would be worse than the current bearer, not better. Any TLS story would come from a tunnel or reverse proxy, which already carry their own strong authentication (Tailscale identity, Cloudflare Access).
- A spec-complete MCP authorization server (dynamic client registration, PKCE, consent UI, token issuance and rotation) is a large security-sensitive surface to maintain inside a single-user LAN add-on, for a need the tunnel plus [named scoped tokens](/guide/configuration#named-tokens) already cover.
- It gets reconsidered when a major MCP client requires OAuth and refuses static bearers, or if the add-on ever terminates TLS itself. If you hit such a case, say so on the issue.

## Whichever option you pick

- Keep `allow_write` off unless you truly want remote actions; a remote endpoint widens the blast radius of a leaked token.
- Rotate your token if it ever transits a service you do not fully trust.
- The two-step confirmation on locks and alarms still applies, remotely as locally.
