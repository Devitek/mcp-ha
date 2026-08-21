# Référence des outils

19 outils, préfixés `ha_`. Tous les outils de lecture portent l'annotation `readOnlyHint`. Les réponses sont du JSON compact avec une enveloppe de liste standard :

```json
{ "items": [...], "returned": 50, "total": 734, "has_more": true, "next_offset": 50, "note": "..." }
```

## Entités

### ha_search_entities

Recherche floue par nom, entity_id ou pièce. Le point d'entrée naturel.

| Paramètre | Type | Notes |
|-----------|------|-------|
| `query` | string, requis | ex. `lumière cuisine` |
| `limit` | number | défaut 20, max 50 |

### ha_list_entities

Liste paginée. **Appelé sans aucun filtre, il renvoie un histogramme** (comptes par domaine et par pièce) au lieu d'un dump.

| Paramètre | Type | Notes |
|-----------|------|-------|
| `domain` | string | ex. `light`, `sensor`, `automation` |
| `area` | string | nom de pièce, insensible à la casse |
| `search` | string | filtre flou |
| `state` | string | état exact, ex. `on` |
| `limit` / `offset` | number | défaut 50, max 200 |

### ha_get_entity

État complet et attributs d'une entité (les valeurs d'attributs très longues sont tronquées).

| Paramètre | Type |
|-----------|------|
| `entity_id` | string, requis |

### ha_list_areas

Toutes les pièces avec leur nombre d'entités. Sans paramètre.

### ha_list_devices

Appareils avec fabricant, modèle, pièce. Paramètres : `area`, `limit`, `offset`.

## Services

### ha_list_services

Sans paramètre : les domaines et leur nombre de services. Avec `domain` : le détail des services et leurs champs. Avec `search` : recherche transverse.

### ha_call_service <Badge type="danger" text="écriture" />

Enregistré uniquement quand `allow_write` est activé. Soumis aux [règles d'écriture](/fr/guide/configuration#regles-d-ecriture).

| Paramètre | Type | Notes |
|-----------|------|-------|
| `domain` / `service` | string, requis | ex. `light` / `turn_on` |
| `target` | object | `entity_id`, `device_id`, `area_id` (préférez `entity_id`) |
| `data` | object | données du service, ex. `{ "brightness_pct": 50 }` |
| `dry_run` | boolean | aperçu sans exécution |
| `confirm_token` | string | jeton issu d'une réponse `confirmation_required` (domaines sensibles) |
| `return_response` | boolean | pour les services qui renvoient des données |

Sur les domaines listés dans `confirm_domains` (serrures et alarmes par défaut), le premier appel répond `confirmation_required` avec un `confirm_token` à usage unique lié à cet appel exact ; l'exécution se fait en rappelant avec les mêmes arguments plus le jeton.

### ha_run_script <Badge type="danger" text="écriture" />

Lance un script, avec variables optionnelles. Même chemin gardé que `ha_call_service`.

| Paramètre | Type | Notes |
|-----------|------|-------|
| `entity_id` | string, requis | doit être une entité `script.*` |
| `variables` | object | transmises au script |
| `dry_run` / `confirm_token` | | comme `ha_call_service` |

### ha_trigger_automation <Badge type="danger" text="écriture" />

Déclenche une automation immédiatement. `skip_condition` vaut `true` par défaut (les actions tournent même si les conditions ne tiennent pas).

| Paramètre | Type | Notes |
|-----------|------|-------|
| `entity_id` | string, requis | doit être une entité `automation.*` |
| `skip_condition` | boolean | défaut `true` |
| `dry_run` / `confirm_token` | | comme `ha_call_service` |

### ha_set_automation <Badge type="danger" text="écriture" />

Active ou désactive une automation.

| Paramètre | Type | Notes |
|-----------|------|-------|
| `entity_id` | string, requis | doit être une entité `automation.*` |
| `enabled` | boolean, requis | `true` pour activer |
| `dry_run` / `confirm_token` | | comme `ha_call_service` |

## Automations et scripts

### ha_list_automations

entity_id, nom, enabled, last_triggered. Paramètres : `limit`, `offset`.

### ha_get_automation

L'état plus, pour les automations créées via l'interface, la configuration complète (déclencheurs, conditions, actions). Les automations définies en YAML renvoient leur état avec une note.

### ha_list_scripts

entity_id, nom, running, last_triggered. Paramètres : `limit`, `offset`.

## Historique

### ha_get_history

Changements d'état d'une entité. Fenêtre : `hours` (min 0.25, défaut 24, max 168) ou `start`/`end` en ISO 8601. Le premier point est l'état déjà en vigueur au début de la fenêtre ; au-delà de 250 points, sous-échantillonnage avec une note.

### ha_get_statistics

Agrégats du recorder (moyenne, min, max, somme) pour les capteurs numériques. `statistic_id` (chaîne ou liste jusqu'à 10), `period` parmi `5minute`, `hour`, `day`, `week`, `month`, fenêtre jusqu'à un an. À préférer à `ha_get_history` sur les longues durées.

### ha_get_logbook

Événements lisibles, filtrables par `entity_id`, fenêtre de 0.25 h à 7 jours, plafonné à 100 événements.

## Add-ons et système

### ha_get_addons

Sans `slug` : la liste des add-ons installés. Avec `slug` : le détail d'un add-on. Lecture seule. Nécessite le Supervisor (indisponible en mode dev).

### ha_render_template

Évalue un template Jinja2 côté serveur et renvoie le rendu. Lecture seule, très puissant pour les requêtes calculées. Non enregistré quand `filter_reads` est actif (un template peut lire n'importe quelle entité) :

```
{{ states.light | selectattr('state','eq','on') | list | count }}
```

### ha_get_system

`section: "config"` : version de HA, nom, fuseau, unités, nombre d'intégrations. `section: "error_log"` : les 100 dernières lignes du journal d'erreurs de HA.
