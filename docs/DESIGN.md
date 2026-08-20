# mcp-ha : Conception d'un add-on Home Assistant exposant un serveur MCP

## 1. Objectif & périmètre

Exposer un serveur **MCP (Model Context Protocol)** sous forme d'**add-on Home Assistant**,
permettant à un client LLM (Claude Code/Desktop, Gemini CLI…) d'interroger et de piloter
l'instance HA. Domaines couverts :

- **Entités** : devices, entities, helpers (`input_*`, compteurs, etc.), areas
- **Automations** : liste, état, déclenchement, activation/désactivation
- **Scripts** : liste, exécution avec variables
- **Historique** : évolution des états, statistiques long terme, logbook
- **Add-ons** : liste, infos, (start/stop/restart en option)
- **Services** : catalogue + appel de service

Périmètre v1 retenu : **lecture + actions simples**, accès **LAN uniquement**, stack **TypeScript**.

## 2. L'existant : et pourquoi un add-on custom

Home Assistant ships déjà une **intégration officielle « MCP Server »** (depuis 2025) qui
expose l'API **Assist** en MCP via SSE (`/mcp_server/sse`). Limites :

- ne couvre que les entités **exposées à Assist** ;
- outils **basés sur les intents** (langage naturel), pas d'accès granulaire ;
- **pas** d'historique/statistiques, **pas** de registres (devices/areas), **pas** de gestion
  des add-ons, pas d'accès à la config des automations/scripts.

→ Notre add-on apporte un accès **direct, typé et granulaire** à tous ces domaines. Les deux
peuvent coexister. (À noter : donner à un LLM un accès en écriture à la domotique est puissant
mais sensible : d'où le modèle de sécurité §8.)

## 3. Décisions retenues

| Axe | Choix | Conséquence |
|-----|-------|-------------|
| Installation | HA OS / Supervised | Vrai add-on Supervisor, `SUPERVISOR_TOKEN` auto |
| Accès | Local LAN | Port dédié + bearer token, pas d'OAuth/HTTPS public |
| Actions | Lecture + actions simples | Outils write derrière `allow_write` + allowlist |
| Stack | TypeScript / Node 20+ | `@modelcontextprotocol/sdk` |
| Canal HA | **WebSocket-first** | Connexion WS persistante ; HTTP résiduel (Supervisor add-ons, config YAML) |

## 4. Architecture générale

```
┌────────────────────────┐        Streamable HTTP (MCP)         ┌───────────────────────────┐
│  Client LLM (LAN)       │  POST http://<HA_IP>:9583/mcp        │  Add-on "mcp_ha"          │
│  Claude Code / Desktop  │ ───────────────────────────────────▶│  (conteneur Docker)       │
│  Gemini CLI             │   Authorization: Bearer <api_token>  │  Node + MCP server        │
└────────────────────────┘                                      └────────────┬──────────────┘
                                                                              │ SUPERVISOR_TOKEN
                                         ┌────────────────────────────────────┼───────────────────┐
                                         │                                    │                   │
                                REST http://supervisor/core/api      WS ws://supervisor/core   Supervisor API
                                (states, services, history,          /websocket (registres,    http://supervisor/addons
                                 template, logbook, config)           statistiques, call)      (list/info/start/stop)
                                         │                                    │                   │
                                         └──────────────── Home Assistant Core / Supervisor ──────┘
```

Le client MCP s'authentifie auprès de l'add-on (bearer). L'add-on s'authentifie auprès de HA
via le `SUPERVISOR_TOKEN` (injecté automatiquement dans le conteneur).

## 5. Communication add-on ↔ Home Assistant : **WebSocket-first**

Décision : le **WebSocket core** est le canal principal (une connexion persistante, authentifiée
par le `SUPERVISOR_TOKEN`). Il couvre états, services, registres, historique et statistiques -
tout ce dont les outils ont besoin. Deux compléments **HTTP** subsistent car il n'existe **pas**
d'équivalent WebSocket :

1. **API Supervisor add-ons** (`http://supervisor/addons…`) : purement HTTP :
   `GET /addons`, `GET /addons/<slug>/info`, `POST /addons/<slug>/{start,stop,restart}`
   (nécessite `hassio_api: true` (+ `hassio_role: manager` pour start/stop)).
2. **Config YAML des automations/scripts** : endpoints config REST uniquement :
   `GET /api/config/automation/config/<id>`, `GET /api/config/script/config/<id>`.

> « WebSocket-first » ≠ « zéro HTTP » : ces deux cas n'ont pas d'API WS. Le rendu de template
> peut se faire au choix en WS (`render_template`) ou en REST (`POST /api/template`).

### 5.1 Connexion & handshake WebSocket

`ws://supervisor/core/websocket` :

1. serveur → `{"type":"auth_required"}`
2. add-on → `{"type":"auth","access_token":"${SUPERVISOR_TOKEN}"}`
3. serveur → `{"type":"auth_ok"}` (sinon `auth_invalid` → fatal, retry différé)
4. commandes ensuite : `{"id":<n>,"type":"…"}` avec `id` **entier monotone croissant**
5. réponses : `{"id":<n>,"type":"result","success":true,"result":…}`
6. abonnements : `subscribe_events` → flux `{"id":<n>,"type":"event","event":…}`

### 5.2 Client `HaWsClient` (abstraction)

- **connexion unique** (singleton), commandes mises en file jusqu'à `auth_ok`
- `send(cmd) → Promise<result>` : attribue l'`id`, stocke la promesse *pending* par `id`, résout
  sur le `result` correspondant ; **timeout** par commande ; rejette si `success:false`
- `subscribe(cmd, onEvent) → unsubscribe`
- **reconnexion** avec backoff exponentiel ; ré-enregistrement des abonnements au reconnect
- **keep-alive** `ping`/`pong` pour détecter une connexion morte
- `auth_invalid` → log + retry différé (problème de token Supervisor)

### 5.3 Mapping outil MCP ↔ commande

| Outil MCP | Commande WS (ou **HTTP**) |
|-----------|---------------------------|
| `ha_list_entities` / `ha_get_entity` | `get_states` (+ cache) |
| `ha_list_areas` | `config/area_registry/list` |
| `ha_list_devices` | `config/device_registry/list` (+ `config/entity_registry/list`) |
| `ha_search_entities` | jointure registres + `get_states` |
| `ha_list_services` | `get_services` |
| `ha_call_service` **[W]** | `call_service` (`return_response:true` si le service renvoie des données) |
| `ha_trigger_automation` / `ha_set_automation` **[W]** | `call_service` (`automation.trigger` / `automation.turn_on/off`) |
| `ha_run_script` **[W]** | `call_service` (`script.<name>` ou `script.turn_on`) |
| `ha_list_automations` / `ha_list_scripts` | `get_states` (domaines `automation.*` / `script.*`) |
| `ha_get_automation` (config YAML) | **HTTP** `GET /api/config/automation/config/<id>` |
| `ha_get_history` | `history/history_during_period` |
| `ha_get_statistics` | `recorder/statistics_during_period` (+ `recorder/list_statistic_ids`) |
| `ha_get_logbook` | `logbook/get_events` |
| `ha_render_template` | `render_template` (WS) ou **HTTP** `POST /api/template` |
| `ha_get_config` | `get_config` |
| `ha_list_addons` / `ha_get_addon` / `ha_manage_addon` **[W]** | **HTTP** Supervisor `…/addons…` |

### 5.4 Cache & fraîcheur

- **Registres** (areas/devices/entities) : changent rarement → cache TTL (~60 s). v2 :
  invalidation via `subscribe_events` (`area_registry_updated`, `device_registry_updated`,
  `entity_registry_updated`).
- **États** : v0.1 = `get_states` à la demande (simple). v0.2 = **cache d'états live** alimenté
  par `subscribe_events: state_changed` → lectures instantanées + fondation pour exposer des
  **MCP resources**/streaming ultérieurement.
- **Écritures** : passent toutes par `call_service`, encapsulé par la couche `safety` (§8).

## 6. Transport MCP & authentification

- **Transport** : **Streamable HTTP** (standard MCP actuel ; SSE = legacy). Endpoint unique
  `POST /mcp`. Mode stateless recommandé pour un serveur multi-clients simple.
- **Auth client → add-on** : bearer token statique (`options.api_token`), vérifié sur `/mcp`.
  Généré à l'install ; LAN only → suffisant. (Évolution possible vers OAuth si accès distant.)
- **Bind** : port `9583/tcp` exposé sur le réseau HA. Documenter le pare-feu / accès LAN.
- Option future : servir aussi une petite page de statut via **ingress** HA (auth par session HA)
  : pratique pour vérifier l'état, mais pas pour les clients MCP programmatiques.

## 7. Catalogue d'outils MCP

Nommage `ha_*`. `[W]` = écriture (masqué/refusé si `allow_write=false`).

**Entités / registres**
- `ha_list_entities(domain?, area?, search?, limit?)` : liste compacte (id, nom, état)
- `ha_get_entity(entity_id)` : état complet + attributs
- `ha_search_entities(query)` : recherche floue (nom/id/area/device)
- `ha_list_areas()` · `ha_list_devices(area?)` : registres

**Services**
- `ha_list_services(domain?)` : services + champs/paramètres
- `ha_call_service(domain, service, target?, data?, dry_run?)` **[W]**

**Automations**
- `ha_list_automations()` : id, nom, état on/off, last_triggered
- `ha_get_automation(entity_id)` : état (+ config YAML si dispo)
- `ha_trigger_automation(entity_id, skip_condition?)` **[W]**
- `ha_set_automation(entity_id, enabled)` **[W]**

**Scripts**
- `ha_list_scripts()`
- `ha_run_script(entity_id, variables?)` **[W]**

**Historique / stats**
- `ha_get_history(entity_id, start, end?)` : changements d'état (fenêtre bornée)
- `ha_get_statistics(statistic_id, start, end?, period?)` : stats long terme
- `ha_get_logbook(start, end?, entity_id?)` : événements lisibles

**Add-ons**
- `ha_list_addons()` · `ha_get_addon(slug)` : lecture (v1)
- `ha_manage_addon(slug, action)` **[W]** : start/stop/restart, gated par `allow_addon_control`

**Système / utilitaire**
- `ha_render_template(template)` : rendu Jinja (lecture arbitraire, très utile)
- `ha_get_config()` · `ha_get_error_log()`

> ~20 outils. Descriptions riches + `inputSchema` (zod) précis = meilleure sélection par le LLM.
> Possibilité de consolider (les automations/scripts sont aussi joignables via
> `ha_call_service`), mais des outils explicites offrent de meilleures affordances.

## 8. Modèle de sécurité (garde-fous)

- `allow_write` (défaut **false**) : sans ça, les outils `[W]` sont **non enregistrés** (donc
  invisibles pour le LLM).
- `allow_addon_control` (défaut **false**) : gate séparé pour start/stop des add-ons.
- `entity_allowlist` / `entity_denylist` (globs, ex. `lock.*`, `alarm_control_panel.*`)
  appliqués aux écritures (et optionnellement aux lectures d'entités sensibles).
- `dry_run` sur `ha_call_service` : renvoie l'appel résolu **sans l'exécuter**.
- **Audit log** structuré sur stdout (visible dans les logs de l'add-on) pour toute mutation.
- Limites : fenêtre d'historique bornée, pagination/limite sur les listes, taille de réponse
  plafonnée (éviter de noyer le contexte du LLM).
- LAN only + bearer token = surface d'attaque réduite. Token à traiter comme un secret.

## 9. Structure du projet

```
mcp-ha/
├─ addon/                    # artefacts de l'add-on Supervisor
│  ├─ config.yaml            # manifest (voir §10)
│  ├─ build.yaml             # images de base par arch
│  ├─ Dockerfile            # base HA + Node, build TS
│  ├─ run.sh                 # entrypoint (bashio)
│  ├─ icon.png / logo.png
│  └─ DOCS.md / translations/
├─ src/                      # serveur MCP TypeScript
│  ├─ index.ts               # serveur HTTP + transport MCP + auth bearer
│  ├─ config.ts              # lit /data/options.json
│  ├─ safety.ts              # gating write + allow/deny list
│  ├─ mcp/
│  │  ├─ server.ts           # McpServer + enregistrement conditionnel des outils
│  │  └─ tools/{entities,services,automations,scripts,history,addons,system}.ts
│  ├─ ha/{rest.ts,ws.ts,supervisor.ts}   # clients HA
│  └─ types.ts
├─ package.json · tsconfig.json
├─ repository.yaml           # pour ajouter le repo d'add-on custom dans HA
├─ docs/DESIGN.md            # ce document
└─ README.md
```

L'add-on lit sa config dans `/data/options.json` (écrit par le Supervisor d'après `schema`),
et reçoit `SUPERVISOR_TOKEN` en variable d'environnement.

## 10. Manifest add-on (`addon/config.yaml`)

```yaml
name: MCP Home Assistant
slug: mcp_ha
version: "0.1.0"
description: Serveur MCP exposant entités, services, automations, scripts, historique et add-ons
arch: [aarch64, amd64, armv7]
init: false
homeassistant_api: true        # accès à l'API core via le proxy Supervisor
hassio_api: true               # accès à l'API Supervisor (add-ons)
hassio_role: manager           # 'default' si lecture seule des add-ons ; 'manager' pour start/stop
ports:
  "9583/tcp": 9583
ports_description:
  "9583/tcp": "Endpoint MCP (Streamable HTTP)"
options:
  api_token: ""                 # vide → généré au 1er démarrage (cf. §14.4)
  allow_write: false
  allow_addon_control: false
  filter_reads: false
  rotate_token: false
  entity_allowlist: []
  entity_denylist: []
  service_denylist:
    - homeassistant.stop
    - homeassistant.restart
    - hassio.*
    - shell_command.*
    - python_script.*
    - recorder.purge*
    - backup.*
  confirm_domains:
    - lock
    - alarm_control_panel
schema:
  api_token: password?
  allow_write: bool
  allow_addon_control: bool
  filter_reads: bool
  rotate_token: bool
  entity_allowlist:
    - str
  entity_denylist:
    - str
  service_denylist:
    - str
  confirm_domains:
    - str
```

## 11. Configuration côté client (LAN)

**Claude Code (CLI)**
```
claude mcp add --transport http home-assistant \
  http://<HA_IP>:9583/mcp \
  --header "Authorization: Bearer <API_TOKEN>"
```

**Claude Desktop** (`claude_desktop_config.json` : pont HTTP via `mcp-remote`)
```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://<HA_IP>:9583/mcp",
               "--header", "Authorization: Bearer <API_TOKEN>"]
    }
  }
}
```

**Gemini CLI** (`~/.gemini/settings.json`)
```json
{
  "mcpServers": {
    "home-assistant": {
      "httpUrl": "http://<HA_IP>:9583/mcp",
      "headers": { "Authorization": "Bearer <API_TOKEN>" }
    }
  }
}
```

## 12. Roadmap

- **v0.1 (lecture)** : squelette add-on + transport MCP + auth ; **`HaWsClient`** (handshake +
  corrélation par `id` + reconnexion) + petit client HTTP Supervisor ; outils `list/get`
  entités, areas, devices, services, automations, scripts, history, addons ; template.
- **v0.2 (actions)** : `call_service`, `trigger/set_automation`, `run_script` + `allow_write`,
  allowlist/denylist, `dry_run`, audit log.
- **v0.3 (add-ons + stats)** : `manage_addon` (gated), statistiques long terme, logbook enrichi.
- **v1.0** : durcissement, tests, `repository.yaml` publiable, docs utilisateur, icônes.
- **v2 (option)** : accès distant sécurisé (OAuth2 + HTTPS/ingress), notifications/streaming
  d'événements (subscribe WebSocket → MCP resources), gestion fine des permissions par outil.

## 13. Points à confirmer en implémentation

- URL exacte du WebSocket core via le proxy Supervisor (`ws://supervisor/core/websocket`) à
  vérifier sur une install réelle (vs `ws://homeassistant:8123/api/websocket`).
- Rôle Supervisor minimal pour **lister** vs **piloter** les add-ons (`default` vs `manager`).
- API `StreamableHTTPServerTransport` du SDK MCP (mode stateless, gestion des sessions).
- Format de réponse des endpoints config REST automations/scripts (structure du YAML renvoyé).
- Base image add-on (Debian HA base + Node, ou image Node + bashio).

---

# 14. Raffinements de conception (détaillés)

Cette partie approfondit §7 (format de sortie), §8 (sécurité), l'ergonomie LLM et les détails
add-on. Elle fait autorité sur les résumés précédents.

## 14.1 Format de sortie des outils (économie de contexte)

Problème : une instance HA a souvent des **centaines/milliers** d'entités. Un `get_states` brut
peut représenter des dizaines de KB et noyer le contexte du LLM. Règles :

**Projection par défaut.** Les listes renvoient un jeu de champs **minimal** ; le détail complet
est réservé à `ha_get_entity`.
- `list_entities` → `entity_id`, `name` (friendly_name), `state`, `domain`, `area`, `last_changed`.
- `get_entity` → tout, avec `attributes?: string[]` pour projeter, et **troncature** des valeurs
  d'attributs volumineuses (remplacées par `"…(tronqué, N car.)"`).

**Enveloppe de liste standard** (identique pour tous les outils `list_*`) :
```jsonc
{
  "items": [ /* objets projetés */ ],
  "returned": 50,          // nb renvoyé
  "total": 734,            // nb total correspondant au filtre
  "has_more": true,
  "next_offset": 50,
  "note": "Réponse tronquée. Affinez avec 'search', 'domain' ou 'area'."
}
```

**Filtrage côté serveur** poussé au maximum : `domain`, `area`, `state`, `search` (flou sur
nom/id/area). Le LLM filtre au lieu de tout rapatrier.

**Nudge « search-before-list ».** `list_entities` **sans filtre** ne dump PAS tout : il renvoie
un **histogramme** (comptes par domaine et par area) + une note invitant à filtrer. Le dump
complet exige au moins un filtre.

**Pagination** : `limit` (défaut 50, max 200) + `offset`. `total`/`has_more`/`next_offset`
toujours présents.

**Historique / statistiques** (potentiellement énormes) :
- fenêtre temporelle **obligatoire** et bornée (rejet si trop large sans `period`) ;
- privilégier `statistics` (buckets `5minute`/`hour`/`day` agrégés) au raw ;
- `ha_get_history` : `minimal_response` (état + timestamp, sans attributs), cap sur le nb de
  points, sinon **downsampling** + agrégats (`min/max/mean/first/last`) avec note.

**Garde-fou global de taille.** Plafond de réponse (~15 KB). Au-delà → troncature + `note`
demandant d'affiner. Sérialisation JSON compacte (pas d'indentation superflue).

## 14.2 Modèle de sécurité : sémantique détaillée

**Options** : `allow_write`, `allow_addon_control`, `entity_allowlist`, `entity_denylist`,
`service_denylist`, `filter_reads` (bool), `confirm_domains` (liste).

**Globs & précédence.** Motifs de type glob sur `entity_id` (`light.*`, `*.kitchen_*`,
`lock.front_door`). Règle d'autorisation d'une **écriture** sur une entité :
```
autorisé = (allowlist vide OU match allowlist) ET (NON match denylist)
```
→ **denylist prioritaire** ; une allowlist non vide bascule en **deny-by-default**.

**Portée lecture.** Par défaut les listes s'appliquent aux **écritures** seulement. Si
`filter_reads=true`, les entités deny sont **omises** des listes et `get_entity` les refuse
(confidentialité : `device_tracker.*`, `person.*`, caméras…).

**Denylist de services** (indépendante des entités) : bloque des services dangereux quel que
soit le contexte. Défaut recommandé :
`homeassistant.stop`, `homeassistant.restart`, `hassio.*`, `shell_command.*`, `python_script.*`,
`recorder.purge*`, `backup.*`. Un service non listé mais inconnu passe ; un service denylisté est
refusé avec message explicite.

**Flux d'une écriture** (`ha_call_service` & dérivés) :
1. `allow_write` faux → refus immédiat (message clair).
2. Résolution des `entity_id` cibles (depuis `target`/`data`).
3. Vérif allow/deny entités **et** service_denylist → refus nominatif si l'un échoue.
4. **Domaine sensible** (`confirm_domains`, ex. `lock`, `alarm_control_panel`, `cover`) →
   premier appel renvoie un **aperçu + `confirm_token`** sans exécuter ; l'exécution exige un
   second appel avec ce token. (Confirmation en 2 temps, sans interactivité serveur.)
5. `dry_run=true` → renvoie l'appel résolu (`domain/service/target/data`) sans exécuter.
6. Sinon exécution via `call_service`, capture du résultat.
7. **Audit log** (voir ci-dessous).

**Format d'audit** : une ligne JSON par mutation sur stdout (logs de l'add-on) :
```json
{"ts":"2026-08-20T14:05:00Z","tool":"ha_call_service","domain":"light","service":"turn_on",
 "target":{"entity_id":["light.kitchen"]},"dry_run":false,"allowed":true,"result":"ok",
 "client":"claude-code"}
```
Jamais de secret dans les logs. `client` dérivé d'un en-tête optionnel (`X-Client-Name`).

**Divers** : `api_token` de type `password` (masqué dans l'UI), comparaison à temps constant,
rate-limit optionnel des écritures (n/min).

## 14.3 Ergonomie LLM (nombre d'outils, resources, annotations)

**Réduire ~20 → ~14.** Trop d'outils dégrade la sélection. Principe : **outils génériques
costauds** + **quelques spécialisés à forte valeur**, et rien de redondant.

- **Garder générique** : `ha_search_entities` (découverte #1), `ha_list_entities`,
  `ha_get_entity`, `ha_call_service` (escape hatch d'écriture).
- **Garder spécialisé** (lecture naturelle + params contraints + plus sûrs) :
  `ha_run_script`, `ha_trigger_automation`, `ha_set_automation`.
- **Fusionner** : `list_addons`+`get_addon` → `ha_get_addons(slug?)` ; `get_config`+`error_log`
  → `ha_get_system(section?)`. Automations/scripts *listés* via `ha_list_entities(domain=…)`
  (garder une variante dédiée seulement si `last_triggered`/`enabled` justifient les champs).
- **Ne PAS créer** d'outil séparé pour chaque service : `ha_call_service` couvre le long tail.

**Conventions de nommage/description.** `ha_<verbe>_<nom>` (`list/get/search/call/run/trigger/
set/render/manage`). Chaque description dit **quand l'utiliser / quand ne pas**, le **pairing**
(`search`→`get`), le **format des params** (unités, ISO 8601), et un **exemple**. Les
descriptions sont le principal levier de pilotage du LLM.

**Annotations MCP** (par outil) : `readOnlyHint` (lectures), `destructiveHint` (`ha_call_service`,
`manage_addon`), `idempotentHint`, `openWorldHint`. Permet aux clients d'étiqueter/garder-fou.

**`outputSchema` + `structuredContent`.** Définir un schéma de sortie sur les outils `list/get`
→ le client reçoit du JSON typé exploitable programmatiquement (spec MCP récente).

**Resources vs tools.** v1 = **tools** (universellement supportés, y compris CLI). v2 =
**resources** en miroir des catalogs statiques (`ha://areas`, `ha://services`, `ha://config`) +
**resource d'état live** alimentée par `subscribe_events` (cf. §5.4), et éventuellement des
**prompts** MCP (workflows types : « diagnostique pourquoi l'automation X ne s'est pas
déclenchée », « résume la conso énergie du jour »).

## 14.4 Détails add-on (image, build, entrypoint, token)

**Base image.** Base officielle HA Alpine + Node :
```yaml
# addon/build.yaml
build_from:
  aarch64: ghcr.io/home-assistant/aarch64-base:3.19
  amd64:   ghcr.io/home-assistant/amd64-base:3.19
  armv7:   ghcr.io/home-assistant/armv7-base:3.19
```
Alpine récent fournit Node 20 (`apk add --no-cache nodejs npm`). bashio est inclus dans la base.

**Dockerfile multi-stage** (build TS → image finale légère) :
```dockerfile
ARG BUILD_FROM
# --- build ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
# --- runtime ---
FROM ${BUILD_FROM}
RUN apk add --no-cache nodejs
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY run.sh /run.sh
RUN chmod a+x /run.sh
CMD [ "/run.sh" ]
```

**Entrypoint `run.sh`** (bashio pour lire les options ; `SUPERVISOR_TOKEN` déjà en env) :
```sh
#!/usr/bin/with-contenv bashio
export MCP_PORT=9583
export ALLOW_WRITE="$(bashio::config 'allow_write')"
export ALLOW_ADDON_CONTROL="$(bashio::config 'allow_addon_control')"
bashio::log.info "Démarrage du serveur MCP HA sur :${MCP_PORT}"
exec node /app/dist/index.js
```
> Alternative sans bashio : lire directement `/data/options.json` dans `config.ts`. `SUPERVISOR_TOKEN`
> est de toute façon injecté en variable d'environnement par le Supervisor.

**Génération & rotation du `api_token`.** L'utilisateur ne devrait pas avoir à l'inventer :
- Au **1er démarrage**, si `api_token` vide → générer un token aléatoire (32 o), le **persister
  dans `/data/token`** (volume persistant à travers redémarrages/màj) et l'**afficher dans les
  logs** de l'add-on (l'utilisateur le copie).
- Option : le **réécrire dans les options** de l'add-on via l'API Supervisor
  `POST /addons/self/options` (nécessite `hassio_api`) → visible/éditable dans l'UI.
- **Rotation** : option booléenne `rotate_token` (ou suppression de `/data/token`) → régénère au
  prochain démarrage et invalide l'ancien.
- Jamais dans l'image ; type `password` dans le `schema` ; comparaison à temps constant.

**Réseau / santé.** `ports: "9583/tcp": 9583` (accessible sur le LAN de HA OS ; documenter le
pare-feu). Option `watchdog: true` + endpoint de santé TCP. Page de statut via **ingress**
(état WS + rappel du token) en option.
