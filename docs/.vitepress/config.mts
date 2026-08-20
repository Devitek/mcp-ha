import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import llmstxt from "vitepress-plugin-llms";

// Documentation site, English at the root and French under /fr/.
// Hosted on GitHub Pages, hence the /mcp-ha/ base.
export default withMermaid(
  defineConfig({
    base: "/mcp-ha/",
    title: "MCP Home Assistant",
    lastUpdated: true,
    head: [["link", { rel: "icon", type: "image/png", href: "/mcp-ha/icon.png" }]],

    vite: {
      plugins: [
        // LLM-friendly docs (llms.txt convention): /llms.txt index,
        // /llms-full.txt with everything inlined, plus a .md twin of every
        // page. English only: mirroring French would double the tokens for
        // no benefit to an LLM.
        llmstxt({
          // Bare domain: the plugin appends the VitePress base (/mcp-ha/)
          // itself, a domain with the path would double it.
          domain: "https://devitek.github.io",
          ignoreFiles: ["fr/**"],
          description: "Home Assistant add-on exposing an MCP server (16 tools) so AI assistants can query and control a Home Assistant instance.",
          details:
            "Read-only by default; a single guarded write tool (ha_call_service) exists behind the allow_write option. " +
            "LAN-only design with bearer authentication. The add-on talks to Home Assistant over WebSocket through the Supervisor proxy.",
        }),
      ],
    },

    locales: {
      root: {
        label: "English",
        lang: "en",
        description: "MCP server add-on for Home Assistant",
        themeConfig: {
          nav: [
            { text: "Guide", link: "/guide/installation" },
            { text: "Reference", link: "/reference/tools" },
          ],
          sidebar: {
            "/": [
              {
                text: "Guide",
                items: [
                  { text: "Installation", link: "/guide/installation" },
                  { text: "Configuration", link: "/guide/configuration" },
                  { text: "Connecting clients", link: "/guide/clients" },
                  { text: "Security", link: "/guide/security" },
                  { text: "Troubleshooting", link: "/guide/troubleshooting" },
                ],
              },
              {
                text: "Reference",
                items: [
                  { text: "Tools", link: "/reference/tools" },
                  { text: "Architecture", link: "/reference/architecture" },
                  { text: "Logging", link: "/reference/logging" },
                ],
              },
            ],
          },
          editLink: {
            pattern: "https://github.com/Devitek/mcp-ha/edit/main/docs/:path",
            text: "Edit this page on GitHub",
          },
        },
      },
      fr: {
        label: "Français",
        lang: "fr",
        link: "/fr/",
        description: "Add-on serveur MCP pour Home Assistant",
        themeConfig: {
          nav: [
            { text: "Guide", link: "/fr/guide/installation" },
            { text: "Référence", link: "/fr/reference/tools" },
          ],
          sidebar: {
            "/fr/": [
              {
                text: "Guide",
                items: [
                  { text: "Installation", link: "/fr/guide/installation" },
                  { text: "Configuration", link: "/fr/guide/configuration" },
                  { text: "Connecter des clients", link: "/fr/guide/clients" },
                  { text: "Sécurité", link: "/fr/guide/security" },
                  { text: "Dépannage", link: "/fr/guide/troubleshooting" },
                ],
              },
              {
                text: "Référence",
                items: [
                  { text: "Outils", link: "/fr/reference/tools" },
                  { text: "Architecture", link: "/fr/reference/architecture" },
                  { text: "Journalisation", link: "/fr/reference/logging" },
                ],
              },
            ],
          },
          editLink: {
            pattern: "https://github.com/Devitek/mcp-ha/edit/main/docs/:path",
            text: "Modifier cette page sur GitHub",
          },
          outline: { label: "Sur cette page" },
          docFooter: { prev: "Page précédente", next: "Page suivante" },
          darkModeSwitchLabel: "Apparence",
          returnToTopLabel: "Retour en haut",
        },
      },
    },

    themeConfig: {
      logo: "/icon.png",
      search: { provider: "local" },
      socialLinks: [{ icon: "github", link: "https://github.com/Devitek/mcp-ha" }],
    },

    mermaid: {},
  })
);
