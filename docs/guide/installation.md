# Installation

## Requirements

- **Home Assistant OS** or **Home Assistant Supervised**. The add-on runs as a Supervisor-managed container; Container and Core installations have no add-on support.
- Architecture aarch64 (Raspberry Pi 4/5 and other 64-bit ARM boards) or amd64 (NUC, VM, x86 server).

## Add the repository

Click the button:

[![Add repository](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FDevitek%2Fmcp-ha)

Or manually: **Settings → Add-ons → Add-on store → ⋮ → Repositories**, then paste:

```
https://github.com/Devitek/mcp-ha
```

## Install and start

1. Find **MCP Home Assistant** in the store (refresh the page if needed) and click **Install**. The Supervisor pulls a prebuilt image from GitHub Container Registry, this takes a few seconds.
2. Click **Start**.

## Get your API token

On first start, the add-on generates a random API token (32 bytes) and:

- saves it into the **Configuration** tab of the add-on, in the `api_token` option;
- prints it in the **Log** tab.

Every installation gets its own token: reinstalling the add-on wipes its data and produces a fresh one. You can also set your own value in `api_token` at any time; restart the add-on to apply it.

Next step: [connect a client](/guide/clients).
