# Référence des outils

40 outils, préfixés `ha_`. Tous les outils de lecture portent l'annotation `readOnlyHint`. Les réponses sont du JSON compact avec une enveloppe de liste standard :

```json
{ "items": [...], "returned": 50, "total": 734, "has_more": true, "next_offset": 50, "note": "..." }
```

## Entités

### ha_search_entities

Recherche floue par nom, entity_id, alias Assist, pièce, étage ou label. Le point d'entrée naturel. Les alias pèsent comme le nom ; pièce, étage et labels pèsent moins.

| Paramètre | Type | Notes |
|-----------|------|-------|
| `query` | string, requis | ex. `lumière cuisine` |
| `limit` | number | défaut 20, max 50 |

### ha_list_entities

Liste paginée, filtrable par `domain`, `area`, `floor`, `label`, `search` et `state`. **Appelé sans aucun filtre, il renvoie un histogramme** (comptes par domaine et par pièce) au lieu d'un dump.

| Paramètre | Type | Notes |
|-----------|------|-------|
| `domain` | string | ex. `light`, `sensor`, `automation` |
| `area` | string | nom de pièce, insensible à la casse |
| `search` | string | filtre flou |
| `state` | string | état exact, ex. `on` |
| `limit` / `offset` | number | défaut 50, max 200 |

### ha_get_entity

État complet et attributs d'une entité (les valeurs d'attributs très longues sont tronquées), plus son étage, ses alias Assist et ses labels quand elle en a.

| Paramètre | Type |
|-----------|------|
| `entity_id` | string, requis |

### ha_list_areas

Toutes les pièces avec leur étage et leur nombre d'entités. Sans paramètre.

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

### ha_create_helper <Badge type="danger" text="écriture" />

Crée un helper : un pur conteneur d'état sans comportement (`input_boolean`, `input_number`, `input_select`, `input_text`, `input_datetime`, `counter`, `timer`). Audité ; pas d'étape de confirmation, créer un helper ne fait rien agir dans la maison.

| Paramètre | Type | Notes |
|-----------|------|-------|
| `helper_type` | string, requis | un des sept types ci-dessus |
| `name` | string, requis | nom d'affichage |
| `options` | object | réglages propres au type (ex. `min`/`max` pour `input_number`, liste `options` pour `input_select`), transmis à HA tels quels |

### ha_delete_helper <Badge type="danger" text="écriture" />

Supprime un helper géré par l'interface, par entity_id. L'id de collection est résolu via le registre d'entités, les helpers renommés sont donc gérés ; les helpers définis en YAML sont refusés avec un message clair. Soumis aux listes d'entités, audité.

### ha_snapshot_scene <Badge type="danger" text="écriture" />

Capture l'état COURANT des entités données en une scène (« capture l'ambiance du salon en Soirée cinéma »), via `scene.create` avec `snapshot_entities`. La scène est **volatile par conception de Home Assistant** (elle vit jusqu'au rechargement des scènes ou un redémarrage) ; rejouez-la avec `scene.turn_on`. Les listes d'entités bornent ce qui est capturable ; un id de scène existant est refusé.

### ha_send_notification <Badge type="danger" text="écriture" />

Envoie une notification vers un téléphone ou toute cible notify. Sans `target` : liste les cibles disponibles (services `notify.*` historiques et entités notify modernes) ; le bon appel est routé automatiquement. Passe par le même chemin gardé que `ha_call_service` (denylist, audit, dry_run) et plafonné à **6 notifications par minute et par cible** : une notification dérange physiquement, un assistant en boucle ne doit pas marteler.

| Paramètre | Type | Notes |
|-----------|------|-------|
| `message` | string, requis | tronqué au-delà de ~1000 caractères |
| `target` | string | ex. `mobile_app_pixel` ou `notify.telephone` ; omettre pour lister |
| `title` / `data` | string / object | extras plateforme transmis tels quels |
| `dry_run` / `confirm_token` | | comme `ha_call_service` |

### ha_announce <Badge type="danger" text="écriture" />

Fait parler la maison (« annonce que le dîner est prêt »). Sans `target` : liste les satellites Assist, les media players et les moteurs TTS. Les satellites utilisent leur `announce` natif ; les media players passent par `tts.speak` (moteur choisi automatiquement ou passé via `engine`). Même chemin gardé que tout appel de service, et plafonné à **3 annonces par minute et par cible** : une voix dans le salon dérange plus qu'une vibration. Messages tronqués à ~500 caractères (c'est de l'audio).

### ha_create_automation <Badge type="danger" text="écriture config" />

Crée une NOUVELLE automation. Enregistré uniquement quand `allow_config_write` est activé (indépendant d'`allow_write`). Le parcours est volontairement lourd : Home Assistant valide d'abord les blocs, puis la réponse porte le YAML complet et un `confirm_token` ; le client doit montrer le YAML à l'humain et rappeler avec le jeton. Une automation existante (même alias) est refusée : création seule, pas de modification.

| Paramètre | Type | Notes |
|-----------|------|-------|
| `alias` | string, requis | nom de l'automation |
| `description` / `mode` | string / enum | `single` (défaut), `restart`, `queued`, `parallel` |
| `triggers` | array, requis | syntaxe moderne, ex. `[{"trigger": "state", ...}]` |
| `conditions` | array | optionnel |
| `actions` | array, requis | ex. `[{"action": "light.turn_on", ...}]` |
| `dry_run` / `confirm_token` | | aperçu / jeton de seconde étape |

### ha_create_script <Badge type="danger" text="écriture config" />

Crée un NOUVEAU script, même parcours gardé en deux temps. L'entity_id dérive de l'alias (`script.<slug>`) ; un existant est refusé.

| Paramètre | Type | Notes |
|-----------|------|-------|
| `alias` | string, requis | nom du script |
| `description` / `mode` | | comme ci-dessus |
| `sequence` | array, requis | séquence d'actions |
| `dry_run` / `confirm_token` | | aperçu / jeton de seconde étape |

### ha_create_from_blueprint <Badge type="danger" text="écriture config" />

Crée une NOUVELLE automation (ou script) depuis un blueprint installé : le comportement est déjà écrit et éprouvé, l'assistant ne remplit que ses inputs typés (les requis sont vérifiés avant toute offre, les inconnus refusés). Paradoxalement le chemin le PLUS SÛR pour programmer la maison. Même parcours gardé en deux temps et même règle de création seule que `ha_create_automation`.

### ha_update_automation / ha_update_script <Badge type="danger" text="écriture config" />

Modifient une automation ou un script EXISTANT géré par l'interface. Les blocs fournis remplacent intégralement les blocs courants (une liste `actions` fournie remplace toutes les actions) ; les blocs non fournis sont conservés. La confirmation montre un **diff avant/après**, et la configuration de base est empreinte : si elle change entre les deux passes (édition simultanée dans l'interface), le jeton est refusé et le parcours recommence. La réponse de succès porte le YAML précédent complet pour un retour arrière manuel. Les cibles définies en YAML sont refusées ; la suppression n'existe pas.

## Automations et scripts

### ha_list_automations

entity_id, nom, enabled, last_triggered. Paramètres : `limit`, `offset`.

### ha_get_automation

L'état plus, pour les automations créées via l'interface, la configuration complète (déclencheurs, conditions, actions). Les automations définies en YAML renvoient leur état avec une note.

### ha_list_scripts

entity_id, nom, running, last_triggered. Paramètres : `limit`, `offset`.

### ha_list_blueprints

Les blueprints d'automations (ou de scripts) installés avec leurs inputs : nom, description, lesquels sont requis, défauts et types de selectors. Le premier arrêt naturel avant de créer une automation : `ha_create_from_blueprint` remplit des trous typés dans du comportement éprouvé.

### ha_get_automation_trace

Le pas à pas des exécutions récentes d'une automation ou d'un script, le premier réflexe du « pourquoi ça s'est déclenché (ou pas) ? ». Sans `run_id` : la liste des exécutions récentes (déclencheur, issue, dernier step, erreur). Avec `run_id` : le chemin ordonné des steps avec les verdicts des conditions et les erreurs. Les variables sont volontairement omises (taille, et elles divulgueraient les états d'autres entités malgré `filter_reads`). Home Assistant ne garde que les dernières exécutions en mémoire, depuis son dernier redémarrage.

## Diagnostics

### ha_explain_event

Explique POURQUOI une entité a changé : suit la chaîne de contexte de Home Assistant (l'acteur immédiat, ce qui l'a déclenché à son tour, l'humain le cas échéant, résolu vers son entité person quand elle est liée et visible), jusqu'à 4 sauts. Sans `at` : le dernier changement de l'entité. Les causes masquées apparaissent comme `(hidden entity)` sous `filter_reads`. Le chaînon manquant entre le logbook (quoi) et `ha_get_automation_trace` (comment) ; la réponse renvoie vers la trace quand une automation est dans la chaîne.

### ha_get_health

Le bilan de santé en un appel : les problèmes du système **Réparations** de Home Assistant, les entités `unavailable`/`unknown` avec leur ancienneté, les batteries faibles (`battery_threshold`, défaut 20 %), les automations actives qui ne se déclenchent plus (`stale_days`, défaut 30), les entités sans pièce. Sections plafonnées avec les comptes totaux, qualifiées plutôt que jugées : un capteur saisonnier n'est pas un défaut. À utiliser avec le prompt `health-report`.

## Historique

### ha_get_history

Changements d'état d'une entité, ou de 5 au maximum en un appel pour les comparer (`entity_id` accepte une chaîne ou une liste ; une liste renvoie un objet `series` par entité). Fenêtre : `hours` (min 0.25, défaut 24, max 168) ou `start`/`end` en ISO 8601. Le premier point est l'état déjà en vigueur au début de la fenêtre ; le budget de 250 points se partage entre les entités demandées, sous-échantillonnage avec une note au-delà.

### ha_get_statistics

Agrégats du recorder (moyenne, min, max, somme) pour les capteurs numériques. `statistic_id` (chaîne ou liste jusqu'à 10), `period` parmi `5minute`, `hour`, `day`, `week`, `month`, fenêtre jusqu'à un an. À préférer à `ha_get_history` sur les longues durées.

### ha_get_logbook

Événements lisibles, filtrables par `entity_id`, fenêtre de 0.25 h à 7 jours, plafonné à 100 événements.

## Dashboards

### ha_list_dashboards

Sans `dashboard` : les dashboards Lovelace (titre, url_path, éditable ou géré en YAML). Avec `dashboard` : ses vues (index, titre, layout, nombre de cartes), ce dont `ha_add_dashboard_card` a besoin.

### ha_add_dashboard_card <Badge type="danger" text="écriture config" />

Insère UNE carte dans une vue de dashboard (rédigez-la d'abord avec `propose-dashboard-card`). Même parcours gardé que `ha_update_automation` : diff avant/après **de la vue**, hash du dashboard entier dans l'empreinte de confirmation (une édition simultanée dans l'interface invalide le jeton), YAML de la vue précédente renvoyé pour retour arrière. Les layouts classiques `cards` et modernes `sections` sont gérés ; les dashboards en YAML sont refusés. Seule l'insertion existe : pas de suppression de carte, pas de réécriture de vue.

## Énergie et présence

### ha_get_energy

Les totaux d'énergie du **dashboard énergie configuré** (`energy/get_prefs` nomme les statistiques exactes : import/export réseau, solaire, batterie, gaz, eau, consommation par appareil) sur `period` (`day` par défaut, `week`, `month`). Avec `compare: true`, la période précédente et les deltas en pourcentage (« cette semaine vs la semaine dernière »). Les totaux somment la statistique `change` par période, le calcul du dashboard lui-même. Erreur claire si aucun dashboard n'est configuré.

### ha_get_presence

Qui est à la maison, dans quelle zone, depuis quand, plus une timeline compacte des changements de zone sur la fenêtre (`hours`, défaut 24, max 168) et les zones avec leur nombre d'occupants. **Noms de zones uniquement, jamais de coordonnées** : latitude, longitude et sources de trackers ne sont jamais lues, par conception. `filter_reads` masque les personnes comme toute entité ; si vous confiez des jetons read à des tiers, denylister `person.*` est le contrôle prévu.

## Calendrier et todo

### ha_get_calendar

Sans `entity_id` : liste les entités calendrier. Avec `entity_id` : les événements sur une fenêtre (`hours` défaut 24, max 720, ou `start`/`end` en ISO 8601).

### ha_get_todo_list

Sans `entity_id` : liste les entités todo. Avec `entity_id` : les éléments de la liste (filtre `status` optionnel). Lecture seule, via `todo.get_items`.

## Caméras

### ha_get_camera_snapshot <Badge type="tip" text="opt-in" />

Renvoie l'image fixe courante d'une entité `camera.*` sous forme d'image MCP, pour que l'assistant décrive ce qu'il voit. Enregistré uniquement quand l'option `allow_camera` est active (indépendante de `allow_write`) ; `filter_reads` et `entity_denylist` s'appliquent toujours, et chaque capture est auditée.

## Add-ons et système

### ha_get_addons

Sans `slug` : la liste des add-ons installés. Avec `slug` : le détail d'un add-on. Lecture seule. Nécessite le Supervisor (indisponible en mode dev).

### ha_render_template

Évalue un template Jinja2 côté serveur et renvoie le rendu. Lecture seule, très puissant pour les requêtes calculées. Non enregistré quand `filter_reads` est actif (un template peut lire n'importe quelle entité) :

```
{{ states.light | selectattr('state','eq','on') | list | count }}
```

### ha_get_system

`section: "config"` : version de HA, nom, fuseau, unités, nombre d'intégrations. `section: "error_log"` : les 100 dernières lignes du journal d'erreurs de HA. `section: "updates"` : mises à jour Core, OS et add-ons en attente. `section: "backups"` : âge de la dernière sauvegarde et sauvegardes récentes (répond honnêtement si le rôle Supervisor minimal ne peut pas les lister).

## Resources et prompts

Depuis la v0.3, chaque réponse d'outil porte aussi `structuredContent` (le même JSON que le texte, typé pour les clients qui le gèrent), et le serveur expose :

Depuis la 0.18.0, les arguments de forme entité supportent les **complétions MCP** (`completion/complete`) : un client qui les implémente propose les vrais identifiants de votre instance pendant la frappe, pour l'argument `automation` de `diagnose-automation` et l'`entity_id` de `ha://entity/{entity_id}`. Mêmes règles de visibilité que toute lecture (`filter_reads` s'applique) ; le support côté clients varie.

**Resources** (`application/json`, pour les clients qui épinglent du contexte sans appel d'outil) :

| URI | Contenu |
|-----|---------|
| `ha://areas` | toutes les pièces avec leur nombre d'entités |
| `ha://services` | les domaines de services avec leur nombre de services |
| `ha://config` | configuration compacte de l'instance (version, nom, fuseau, unités) |

**Prompts** (parcours guidés) :

| Nom | Arguments | Ce que ça fait |
|-----|-----------|----------------|
| `diagnose-automation` | `automation` (entity_id) | enquête pas à pas sur une automation qui n'a pas tourné |
| `energy-report` | `hours` (optionnel) | bilan de consommation bâti sur les statistiques long terme |
| `health-report` | aucun | bilan de santé guidé bâti sur ha_get_health |
| `propose-automation` | `goal` | rédige un YAML d'automation prêt à coller depuis des entités vérifiées, n'écrit rien |
| `propose-dashboard-card` | `goal` | rédige un YAML de carte Lovelace prêt à coller depuis des entités vérifiées, n'écrit rien |
| `propose-script` | `goal` | rédige un YAML de script prêt à coller depuis des entités vérifiées, n'écrit rien |
