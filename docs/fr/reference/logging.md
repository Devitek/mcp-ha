# Journalisation

## Niveaux

L'option `log_level` contrôle la verbosité, du plus bavard au plus silencieux :

| Niveau | Ce que vous obtenez |
|--------|---------------------|
| `trace` | métadonnées des trames WebSocket, arguments des outils |
| `debug` | commandes WebSocket, appels HTTP vers HA, requêtes MCP, invocations d'outils |
| `info` | résumé de démarrage, cycle de vie de la connexion (défaut) |
| `notice` | événements notables : tentatives non autorisées, jeton reporté dans les options |
| `warning` | problèmes récupérables : reconnexions, échecs d'outils |
| `error` | refus de connexion HA, erreurs de lecture de configuration |
| `fatal` | échec de démarrage |

La même valeur est appliquée à bashio (le wrapper `run.sh`), les lignes côté Supervisor suivent donc le même seuil.

## Format

Une ligne par événement sur stderr, visible dans l'onglet **Journal** de l'add-on :

```
[2026-08-20T15:30:12.345Z] INFO mcp-ha 0.1.2 listening on port 9583 (MCP endpoint /mcp, health /health)
[2026-08-20T15:30:12.401Z] DEBUG WS command get_states (id 12)
```

## Journal d'audit

Les tentatives d'écriture via `ha_call_service` produisent chacune une ligne JSON, **quel que soit le niveau de log**. C'est un enregistrement de sécurité, pas du debug : baisser la verbosité ne le fait jamais taire.

```json
{"ts":"2026-08-20T15:31:02.000Z","audit":true,"tool":"ha_call_service","domain":"light","service":"turn_on","target":{"entity_id":["light.kitchen"]},"allowed":true,"result":"ok"}
```

Les tentatives refusées portent `"allowed": false` et une `reason`. Aucun secret n'apparaît dans les lignes d'audit.

## Secrets

Aucun secret n'est jamais journalisé en entier, à aucun niveau. Le jeton API n'apparaît que sous forme de préfixe masqué à remplissage fixe (`d370f4f8**********`) ; la valeur complète vit dans l'onglet Configuration de l'add-on. Un test unitaire garde cet invariant.

## Diagnostiquer

- Problèmes de connexion : `debug` montre chaque commande WS et chaque reconnexion avec son délai de backoff.
- Comportement des outils : `debug` journalise chaque invocation, `trace` ajoute les arguments (tronqués).
- Authentification des clients : les requêtes non autorisées sont journalisées en `notice` avec l'adresse source.

En mode dev (hors add-on), le niveau se règle avec la variable d'environnement `LOG_LEVEL`.
