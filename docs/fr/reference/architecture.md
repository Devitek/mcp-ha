# Architecture

## Vue d'ensemble

L'add-on fait tourner un serveur Node 26 dans un conteneur géré par le Supervisor. Les clients MCP le joignent sur le LAN ; l'add-on parle à Home Assistant via le proxy interne du Supervisor, authentifié par le `SUPERVISOR_TOKEN` injecté dans le conteneur. Pas de jeton utilisateur, pas d'URL externe.

```mermaid
flowchart LR
  subgraph lan["Votre LAN"]
    C["Client MCP<br/>Claude Code, Claude Desktop, Gemini CLI"]
  end
  subgraph haos["Home Assistant OS"]
    subgraph addon["Add-on mcp-ha"]
      T["Endpoint Streamable HTTP /mcp<br/>auth bearer, stateless"]
      S["Serveur MCP<br/>26 outils + couche de sécurité"]
      W["Client WebSocket"]
      H["Client HTTP"]
      T --> S
      S --> W
      S --> H
    end
    CORE["HA Core"]
    SUP["Supervisor"]
    W -->|"ws://supervisor/core/websocket"| CORE
    H -->|"REST http://supervisor/core/api"| CORE
    H -->|"http://supervisor/addons"| SUP
  end
  C -->|"POST /mcp<br/>Authorization: Bearer jeton"| T
```

## WebSocket d'abord

L'**API WebSocket de HA est le canal principal** : états, services, registres (pièces, appareils, entités), historique, statistiques, logbook, appels de service. Une connexion persistante, des commandes corrélées par un `id` croissant.

```mermaid
sequenceDiagram
  participant A as Add-on
  participant HA as WebSocket HA Core
  A->>HA: connexion
  HA-->>A: auth_required
  A->>HA: auth (SUPERVISOR_TOKEN)
  HA-->>A: auth_ok
  Note over A,HA: les commandes en attente d'auth_ok sont libérées
  A->>HA: get_states (id 1)
  HA-->>A: result (id 1)
  loop toutes les 30 s
    A->>HA: ping
    HA-->>A: pong
  end
  Note over A,HA: à la fermeture : commandes en vol rejetées,<br/>reconnexion avec backoff exponentiel (1 s à 30 s)
```

Deux restes HTTP existent faute d'équivalent WebSocket :

| Besoin | Canal |
|--------|-------|
| Liste et détail des add-ons | API Supervisor `http://supervisor/addons` |
| Config YAML des automations/scripts | REST `GET /api/config/automation/config/<id>` |
| Rendu de template | REST `POST /api/template` (la commande WS est un abonnement, inadapté au one-shot stateless) |
| Journal d'erreurs HA | REST `GET /api/error_log` |

## Transport MCP stateless

Le serveur implémente MCP en **Streamable HTTP** en mode stateless : une instance de serveur MCP et un transport par requête, aucune session. L'endpoint est ainsi trivialement compatible avec plusieurs clients simultanés et avec les redémarrages. `GET /mcp` répond 405 ; `/health` est la seule route sans authentification.

## Discipline de contexte

Les réponses des outils sont pensées pour la consommation par un LLM :

- projection par défaut : les listes renvoient des champs minimaux, le détail vit dans `ha_get_entity` ;
- enveloppe standard avec `total`, `has_more`, `next_offset` ;
- `ha_list_entities` sans filtre renvoie un histogramme, pas un dump ;
- fenêtres temporelles bornées, sous-échantillonnage au-delà de 250 points d'historique ;
- plafond global d'environ 15 Ko par réponse, avec une note expliquant comment affiner.

## Bootstrap du jeton

```mermaid
sequenceDiagram
  participant U as Utilisateur
  participant A as Add-on
  participant S as Supervisor
  A->>A: démarrage, option api_token vide
  A->>A: génère 32 octets aléatoires, écrit /data/token (0600)
  A->>S: GET /addons/self/info (options courantes)
  A->>S: POST /addons/self/options (fusion avec api_token)
  Note over A,S: retenté plusieurs fois, le Supervisor peut encore démarrer
  A->>A: affiche un préfixe masqué dans le journal
  U->>A: lit le jeton complet dans l'onglet Configuration
```

## Caches

Les registres pièces, appareils, entités, étages et labels sont mis en cache avec partage des requêtes en vol et **invalidés par les événements de registre** (`area_registry_updated` et consorts) : un renommage est visible à l'appel suivant. Un TTL de 60 secondes reste en filet de sécurité si un abonnement échoue silencieusement. **Les états sont une carte vivante** alimentée par un abonnement `state_changed` (v0.3) : l'add-on s'abonne d'abord, prend un instantané via un seul `get_states`, rejoue les événements tamponnés entre-temps, et sert toutes les lectures depuis la mémoire. L'abonnement est rétabli à chaque reconnexion ; s'il échoue, un repli en TTL court garde les outils fonctionnels.

## Page de statut

`ingress: true` expose une page de statut et d'onboarding dans la barre latérale de Home Assistant (authentifiée par la session HA, port interne au réseau du conteneur) : version, uptime, état du WebSocket, options actives, et des configs client prêtes à copier avec le jeton API masqué par défaut (même périmètre de confiance que l'onglet Configuration ; le jeton Supervisor n'y apparaît jamais).

## Organisation du dépôt

```
mcp-ha/
├── mcp_ha/            # l'add-on (contexte de build Docker autonome)
│   ├── config.yaml    # manifest (options, schéma, ports, permissions)
│   ├── Dockerfile     # multi-stage : build node:26-alpine, runtime base HA
│   ├── run.sh         # entrypoint bashio
│   └── src/           # serveur TypeScript (SDK MCP, ws, zod)
├── docs/              # ce site (VitePress, en + fr)
└── .github/workflows/ # CI, release (images multi-arch), déploiement du site
```
