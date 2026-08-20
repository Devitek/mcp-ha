# MCP Home Assistant

Un add-on Home Assistant qui expose un serveur [MCP](https://modelcontextprotocol.io) (Model Context Protocol), pour qu'un assistant IA comme Claude ou Gemini puisse interroger et, si vous l'autorisez, piloter votre instance.

> « Quelles lumières sont restées allumées ? », « Pourquoi l'automation du chauffage ne s'est pas déclenchée cette nuit ? », « Résume la consommation électrique de la semaine. »

## Ce que ça fait

- **Entités, pièces, appareils** : recherche floue, listes paginées, détail complet.
- **Services** : parcours du catalogue et, quand l'écriture est activée, appel de services avec garde-fous.
- **Automations et scripts** : état, dernier déclenchement, configuration complète des automations.
- **Historique** : changements d'état, statistiques long terme, logbook.
- **Add-ons et système** : add-ons installés, config HA, journal d'erreurs, rendu de templates Jinja.

16 outils au total, pensés pour préserver la fenêtre de contexte du LLM : réponses compactes, paginées, plafonnées.

L'add-on est en **lecture seule par défaut**. Le seul outil d'écriture, `ha_call_service`, n'existe qu'une fois `allow_write` activé, et reste contraint par des listes de services et d'entités, avec un journal d'audit JSON. Voir [Sécurité](/fr/guide/security).

## Démarrage rapide

1. [Installez l'add-on](/fr/guide/installation) depuis ce dépôt.
2. Démarrez-le, puis ouvrez l'onglet **Configuration** de l'add-on : un jeton API y a été généré et enregistré.
3. [Connectez votre client](/fr/guide/clients), par exemple Claude Code :

   ```bash
   claude mcp add --transport http home-assistant \
     http://IP_DE_HA:9583/mcp \
     --header "Authorization: Bearer VOTRE_JETON"
   ```

4. Demandez à votre assistant : « quelles lumières sont allumées en ce moment ? »

## Prérequis

- Home Assistant OS ou Supervised (l'add-on a besoin du Supervisor).
- Un client MCP sur votre réseau local : Claude Code, Claude Desktop, Gemini CLI, ou tout client MCP en Streamable HTTP.

## Documentation pour les LLMs

Cette documentation suit la [convention llms.txt](https://llmstxt.org), pour être consommée directement par les assistants IA et les agents :

- [`/llms.txt`](https://devitek.github.io/mcp-ha/llms.txt) : un index compact avec résumé et liens décrits, idéal pour un agent qui choisit quoi lire.
- [`/llms-full.txt`](https://devitek.github.io/mcp-ha/llms-full.txt) : toute la documentation en un seul fichier markdown, idéal à coller dans une conversation ou à ingérer d'un bloc.
- Chaque page existe aussi en markdown brut : ajoutez `.md` à son URL (ex. [/reference/tools.md](https://devitek.github.io/mcp-ha/reference/tools.md)).

Ces fichiers sont régénérés à chaque build du site, en anglais uniquement. La documentation est aussi indexée sur [Context7](https://context7.com), pour les agents qui résolvent les docs via le serveur MCP Context7.

## Pour aller plus loin

- [Installation](/fr/guide/installation)
- [Options de configuration](/fr/guide/configuration)
- [Référence des outils](/fr/reference/tools)
- [Architecture](/fr/reference/architecture)
- [Code source sur GitHub](https://github.com/Devitek/mcp-ha)
