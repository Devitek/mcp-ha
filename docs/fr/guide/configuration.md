# Configuration

Toutes les options se trouvent dans l'onglet **Configuration** de l'add-on. Redémarrez l'add-on après modification.

## Options

| Option | Défaut | Description |
|--------|--------|-------------|
| `log_level` | `info` | Verbosité du journal : `trace`, `debug`, `info`, `notice`, `warning`, `error`, `fatal`. Voir [Journalisation](/fr/reference/logging). |
| `api_token` | vide | Jeton attendu des clients MCP dans l'en-tête `Authorization: Bearer ...`. Laissez vide pour en générer un au premier démarrage (il est reporté dans cette option). |
| `allow_write` | `false` | Expose l'outil `ha_call_service`. Sans lui, l'add-on est strictement en lecture seule : aucun outil d'écriture n'est même visible du client. |
| `filter_reads` | `false` | Applique aussi `entity_denylist` aux lectures : les entités masquées disparaissent des listes, du détail, de l'historique et du logbook. |
| `entity_allowlist` | `[]` | Motifs glob des entités autorisées à l'écriture. Non vide, l'écriture devient interdite par défaut. |
| `entity_denylist` | `[]` | Motifs glob des entités toujours refusées à l'écriture. Gagne sur la liste blanche. |
| `service_denylist` | voir plus bas | Services refusés quel que soit le contexte. |

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

Chaque tentative, acceptée ou refusée, produit une ligne d'audit JSON dans le journal de l'add-on.

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
