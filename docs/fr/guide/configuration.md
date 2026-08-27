# Configuration

Toutes les options se trouvent dans l'onglet **Configuration** de l'add-on. Redémarrez l'add-on après modification.

## Options

| Option | Défaut | Description |
|--------|--------|-------------|
| `log_level` | `info` | Verbosité du journal : `trace`, `debug`, `info`, `notice`, `warning`, `error`, `fatal`. Voir [Journalisation](/fr/reference/logging). |
| `api_token` | vide | Jeton principal (accès complet) attendu des clients MCP dans l'en-tête `Authorization: Bearer ...`. Laissez vide pour en générer un au premier démarrage (il est reporté dans cette option). |
| `api_tokens` | `[]` | **Dépréciée depuis 1.2.0.** Jetons nommés legacy avec une portée : toujours acceptés comme source d'import one-shot (hachés dans le store au démarrage), puis la clé est retirée des options stockées. Gérez les jetons depuis la page ingress ; l'option disparaîtra dans une release future. |
| `allow_write` | `false` | Expose l'outil `ha_call_service`. Sans lui, l'add-on est strictement en lecture seule : aucun outil d'écriture n'est même visible du client. |
| `allow_camera` | `false` | Expose `ha_get_camera_snapshot` (images fixes de caméras). Indépendant de `allow_write` ; voir chez soi n'est pas agir chez soi, mais mérite son propre interrupteur. `filter_reads` et `entity_denylist` s'appliquent toujours. |
| `allow_config_write` | `false` | Expose les huit outils d'écriture de configuration : création, modification et suppression d'automations et de scripts, instanciation de blueprints, cartes de dashboard (validés par HA quand c'est possible, confirmation en deux temps obligatoire). Indépendant d'`allow_write`, et depuis 0.31.0 il couvre aussi les commandes runtime de ce qu'il gère (lancer, déclencher, activer/désactiver) : qui peut réécrire une automation peut de toute façon lui faire faire n'importe quoi, les niveaux d'accès ont cessé de prétendre le contraire (#165). Voir le [modèle de sécurité](https://github.com/Devitek/mcp-ha/blob/main/SECURITY.md). |
| `enable_sessions` | `false` | Sessions MCP longues : flux SSE, abonnements `ha://entity/{id}` avec notifications de changement, et confirmations dans le protocole (elicitation). Les clients sans session fonctionnent inchangés. 16 sessions max, fermées après 30 min d'inactivité. |
| `filter_reads` | `false` | Applique aussi `entity_denylist` aux lectures : les entités masquées disparaissent des listes, du détail, de l'historique et du logbook. |
| `entity_allowlist` | `[]` | Motifs glob des entités autorisées à l'écriture. Non vide, l'écriture devient interdite par défaut. |
| `entity_denylist` | `[]` | Motifs glob des entités toujours refusées à l'écriture. Gagne sur la liste blanche. |
| `service_denylist` | voir plus bas | Services refusés quel que soit le contexte. |
| `confirm_domains` | `[lock, alarm_control_panel]` | Les écritures sur ces domaines exigent une confirmation en deux temps : l'assistant reçoit d'abord un aperçu et un jeton à usage unique, et doit rappeler avec pour exécuter. |

## Jetons nommés

L'unique `api_token` donne un accès complet (c'est le jeton d'amorçage et de secours). Les jetons nommés sont stockés **hachés** dans une base locale. L'option YAML `api_tokens` est **dépréciée** : les entrées ajoutées là sont encore importées une fois au prochain démarrage (avec les droits que leur portée implique), puis la clé quitte entièrement les options stockées, avec un warning dans le log. La création de jetons se fait sur la **page ingress** (entrée dans la barre latérale), onglet Tokens : un niveau (none / read / write / manage) par catégorie d'outils, une expiration optionnelle et des listes d'entités propres au jeton (appliquées aux écritures, en plus des listes globales). Le secret est montré une seule fois à la création ; les droits sont plafonnés par les options `allow_*` à chaque requête, fermer un gate dégrade donc tous les jetons instantanément. La révocation tient en un clic.

Forme legacy dépréciée, toujours acceptée comme source d'import one-shot (`scope: read` devient des droits lecture partout, `scope: write` des droits pleins, les deux plafonnés par les gates `allow_*`) :

```yaml
api_tokens:
  - name: assistant-principal
    token: <une longue chaîne aléatoire>
    scope: write
```

## Sauvegardes

Les backups Home Assistant (complets, ou partiels avec l'add-on coché) incluent le `/data` de l'add-on : le store de jetons voyage avec eux.

- **Rien de sensible ne fuit** : la base ne contient que des hachages sha256, des noms et des droits. Un backup volé ne donne aucun jeton utilisable (contrairement à l'option `api_tokens` en clair de l'ère pré-1.0, dépréciée).
- **La cohérence est garantie par un snapshot** : le Supervisor archive `/data` pendant que l'add-on tourne, le `tokens.db` vivant d'un backup pourrait donc être déchiré. Après chaque mutation, l'add-on écrit `tokens.snapshot.db` via le `VACUUM INTO` de SQLite suivi d'un rename atomique : le backup embarque toujours au moins une copie cohérente, et l'add-on restaure automatiquement depuis elle si la base principale devient illisible (le fichier fautif est conservé à côté comme preuve).
- **Restaurer un backup** ramène les jetons tels qu'ils étaient au moment du backup : les clients dont le secret a été créé après reçoivent un 401 et ont besoin d'un nouveau jeton.

## Motifs glob

Les listes acceptent des globs simples où `*` remplace n'importe quoi, tout le reste est littéral :

- `light.*` : toutes les lumières
- `lock.front_door` : une entité exacte
- `*.kitchen_*` : tout domaine, entités dont le nom commence par `kitchen_`

La correspondance est insensible à la casse.

## Règles d'écriture

Un appel de service doit passer **tous** ces contrôles, dans l'ordre :

1. `allow_write` est activé (sinon l'outil n'est pas enregistré du tout).
2. Le service n'est pas dans `service_denylist`.
3. Chaque `entity_id` ciblé passe les listes : autorisé si la liste blanche est vide ou correspond, et si la liste noire ne correspond pas. **La liste noire gagne toujours.**
4. Dès qu'une restriction d'entités est configurée, le ciblage par `area_id` ou `device_id` est refusé (il contournerait les listes) : ciblez des `entity_id` explicites.
5. Sur un domaine listé dans `confirm_domains`, l'appel doit porter un `confirm_token` valide obtenu lors d'un premier appel (usage unique, expire après 5 minutes, lié au même appel exact).

Ces règles s'appliquent à l'identique aux quatre outils d'écriture (`ha_call_service`, `ha_run_script`, `ha_trigger_automation`, `ha_set_automation`) : ils partagent un chemin d'écriture gardé unique. Chaque tentative, acceptée ou refusée, produit une ligne d'audit JSON dans le journal de l'add-on.

## Liste noire de services par défaut

```yaml
service_denylist:
  - homeassistant.stop
  - homeassistant.restart
  - hassio.*
  - shell_command.*
  - python_script.*
  - recorder.purge*
  - backup.*
```

Ces entrées bloquent l'arrêt et le redémarrage de Home Assistant, les commandes shell arbitraires, la purge du recorder et la manipulation des sauvegardes. La liste est modifiable, mais réfléchissez avant d'en retirer.

## Exemple : écriture prudente

Autoriser l'assistant à piloter lumières et lecteurs multimédia, rien d'autre, et masquer les caméras en lecture :

```yaml
allow_write: true
entity_allowlist:
  - light.*
  - media_player.*
entity_denylist:
  - light.baby_room
filter_reads: true
# entity_denylist masque aussi ces entités en lecture grâce à filter_reads
```
