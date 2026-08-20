# mcp-ha : un serveur MCP pour Home Assistant, en add-on

[![CI](https://github.com/Devitek/mcp-ha/actions/workflows/ci.yaml/badge.svg)](https://github.com/Devitek/mcp-ha/actions/workflows/ci.yaml)
[![Release](https://img.shields.io/github/v/release/Devitek/mcp-ha?sort=semver)](https://github.com/Devitek/mcp-ha/releases)
[![Licence MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

Cet add-on Home Assistant expose un serveur [MCP](https://modelcontextprotocol.io) (Model Context Protocol). Concrètement : vous connectez Claude, Gemini ou tout autre client MCP à votre instance, et vous discutez avec votre maison.

> « Quelles lumières sont restées allumées ? », « Pourquoi l'automation du chauffage ne s'est pas déclenchée cette nuit ? », « Trace-moi la conso électrique de la semaine. »

## Ce que ça couvre

| Domaine | Outils |
|---------|--------|
| Entités, pièces, appareils | recherche floue, listes paginées, détail complet |
| Services | catalogue par domaine, recherche, appel encadré (opt-in) |
| Automations | liste, état, dernier déclenchement, configuration complète |
| Scripts | liste, état d'exécution |
| Historique | changements d'état, statistiques long terme, logbook |
| Add-ons | liste et détail (lecture) |
| Système | rendu de template Jinja, config HA, journal d'erreurs |

16 outils au total, pensés pour économiser le contexte du LLM : réponses compactes, paginées et plafonnées, avec des messages qui guident l'assistant vers des requêtes plus précises.

## Pourquoi pas l'intégration MCP officielle de HA ?

Elle existe et fonctionne, mais elle passe par l'API Assist : uniquement les entités exposées à Assist, pas d'historique, pas de registres, pas d'add-ons, pas de config d'automations. Cet add-on donne un accès direct et granulaire. Les deux cohabitent sans problème.

## Installation

Prérequis : Home Assistant OS ou Supervised (l'add-on a besoin du Supervisor).

1. Ajoutez ce dépôt à vos dépôts d'add-ons :

   [![Ajouter le dépôt](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FDevitek%2Fmcp-ha)

   Ou manuellement : Paramètres, Modules complémentaires, Boutique, menu trois points, Dépôts, puis collez `https://github.com/Devitek/mcp-ha`.

2. Installez « MCP Home Assistant », démarrez-le.
3. Ouvrez le journal de l'add-on : un jeton d'API y est affiché au premier démarrage. Copiez-le.

## Connexion d'un client

**Claude Code** :

```bash
claude mcp add --transport http home-assistant \
  http://IP_DE_HA:9583/mcp \
  --header "Authorization: Bearer VOTRE_JETON"
```

**Claude Desktop** et **Gemini CLI** : voir la [documentation de l'add-on](mcp_ha/DOCS.md), les trois configurations y sont détaillées.

## Sécurité, en deux mots

- **Lecture seule par défaut.** L'outil d'appel de service n'existe pour le client que si vous activez `allow_write`.
- **Défense en profondeur** quand l'écriture est active : liste noire de services dangereux (arrêt de HA, shell_command...), listes glob d'entités autorisées/interdites, mode `dry_run`, audit JSON de chaque tentative dans le journal.
- **LAN uniquement.** Pas de TLS ni d'OAuth en v0.1 : n'exposez pas le port 9583 sur internet.

Le modèle de menace complet est dans [SECURITY.md](SECURITY.md).

## Documentation

- [Documentation utilisateur de l'add-on](mcp_ha/DOCS.md) : options, clients, dépannage
- [Conception détaillée](docs/DESIGN.md) : architecture, choix techniques, roadmap
- [Guide de contribution](CONTRIBUTING.md) : setup de dev, conventions, releases
- [Les issues du dépôt](https://github.com/Devitek/mcp-ha/issues?q=is%3Aissue) servent de base de connaissances : chaque décision de conception et chaque écueil rencontré y est tracé avec les labels `décision` et `écueil`

## Licence

[MIT](LICENSE)
