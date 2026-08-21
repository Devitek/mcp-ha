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
    // Extensionless URLs: cleaner canonicals, GitHub Pages resolves them.
    cleanUrls: true,
    sitemap: { hostname: "https://devitek.github.io/mcp-ha/" },
    head: [
      ["link", { rel: "icon", type: "image/png", href: "/mcp-ha/icon.png" }],
      ["meta", { property: "og:type", content: "website" }],
      ["meta", { property: "og:site_name", content: "MCP Home Assistant" }],
      ["meta", { property: "og:image", content: "https://devitek.github.io/mcp-ha/og.png" }],
      ["meta", { name: "twitter:card", content: "summary" }],
      ["meta", { name: "twitter:image", content: "https://devitek.github.io/mcp-ha/og.png" }],
    ],

    // Per-page SEO (issue #74): canonical, en/fr hreflang twins and Open
    // Graph tags derived from the page path and title.
    transformPageData(pageData) {
      const site = "https://devitek.github.io/mcp-ha/";
      const rel = pageData.relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "");
      const url = site + rel;
      const isFr = rel === "fr/" || rel.startsWith("fr/");
      const enTwin = site + (isFr ? rel.replace(/^fr\/?/, "") : rel);
      const frTwin = isFr ? url : site + "fr/" + rel;
      const title = pageData.title ? `${pageData.title} | MCP Home Assistant` : "MCP Home Assistant";
      const description =
        pageData.description ||
        (isFr
          ? "Add-on Home Assistant exposant un serveur MCP : interrogez et pilotez votre instance depuis Claude, Gemini ou tout client MCP."
          : "Home Assistant add-on exposing an MCP server: query and control your instance from Claude, Gemini or any MCP client.");
      pageData.frontmatter.head = [
        ...(pageData.frontmatter.head ?? []),
        ["link", { rel: "canonical", href: url }],
        ["link", { rel: "alternate", hreflang: "en", href: enTwin }],
        ["link", { rel: "alternate", hreflang: "fr", href: frTwin }],
        ["link", { rel: "alternate", hreflang: "x-default", href: enTwin }],
        ["meta", { property: "og:title", content: title }],
        ["meta", { property: "og:description", content: description }],
        ["meta", { property: "og:url", content: url }],
      ];
    },

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
          description: "Home Assistant add-on exposing an MCP server (22 tools) so AI assistants can query and control a Home Assistant instance.",
          details:
            "Read-only by default; four guarded write tools (ha_call_service, ha_run_script, ha_trigger_automation, ha_set_automation) " +
            "exist behind the allow_write option, with a two-step confirmation on sensitive domains. " +
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
                  { text: "Remote access", link: "/guide/remote-access" },
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
                  { text: "Accès distant", link: "/fr/guide/remote-access" },
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
