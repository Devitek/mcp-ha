# Dépannage

## « Failed to save: Missing option '...' in root »

La sauvegarde de la configuration échoue juste après une mise à jour qui a introduit une nouvelle option. Le Supervisor matérialise les défauts dans vos options stockées à l'installation seulement et n'injecte jamais les clés ajoutées par les mises à jour : une nouvelle clé requise par le schéma bloque alors toute sauvegarde. Depuis la 0.2.1, l'add-on réconcilie ses options stockées au démarrage : redémarrez-le une fois et sauvegardez à nouveau. Sur une version antérieure, ajoutez la clé manquante à la main dans l'éditeur YAML (ex. `confirm_domains: [lock, alarm_control_panel]`) en même temps que votre changement.

## Jeton API perdu

Il est visible dans l'onglet **Configuration** de l'add-on (option `api_token`) et conservé dans `/data/token`. Le journal ne le montre jamais en entier, seulement un préfixe masqué. Si l'option semble vide, redémarrez l'add-on : le report y est retenté à chaque démarrage. Pour forcer un nouveau jeton : videz l'option, supprimez `/data/token`, redémarrez.

## 401 Unauthorized

- Vérifiez l'en-tête : `Authorization: Bearer VOTRE_JETON`, sans espace ni guillemet parasite.
- Le jeton côté client doit correspondre exactement à l'option `api_token`.
- Chaque tentative non autorisée est journalisée (`Unauthorized MCP request from ...`), ce qui confirme que la requête atteint bien l'add-on.

## Les outils répondent « Home Assistant WebSocket is not connected »

L'add-on maintient un WebSocket permanent vers Home Assistant et se reconnecte avec backoff. Une coupure brève juste après un redémarrage de HA est normale.

- Consultez le journal : vous devez voir `Connecting to Home Assistant WebSocket...` puis `Authenticated with Home Assistant`.
- Si ça boucle sur la reconnexion, passez `log_level` à `debug` et regardez la raison.

## `ha_get_addons` échoue

L'API Supervisor n'existe que dans un vrai add-on. En mode dev (hors HA), cet outil répond une erreur claire ; tout le reste fonctionne.

## Les réponses semblent tronquées

C'est voulu : les réponses sont plafonnées (environ 15 Ko) pour protéger la fenêtre de contexte du LLM. Le champ `note` explique à l'assistant comment affiner (filtres domain/area, fenêtre plus courte, pagination). C'est une fonctionnalité, pas un bug.

## Journal trop silencieux ou trop bavard

Ajustez l'option `log_level` : `debug` ajoute les commandes WebSocket, les appels HTTP et les invocations d'outils ; `trace` ajoute le détail des trames et les arguments des outils. Voir [Journalisation](/fr/reference/logging).

## Le serveur est-il vivant ?

`http://IP_DE_HA:9583/health` répond sans authentification :

```json
{ "status": "ok", "websocket": true }
```

`websocket: false` signifie que l'add-on tourne mais n'est pas (encore) connecté à Home Assistant. Après plus de 5 minutes de connexion perdue, l'endpoint répond 503 avec `"status": "degraded"`, ce qui permet au healthcheck du conteneur de redémarrer l'add-on.

## Autre chose ?

Ouvrez une [issue sur GitHub](https://github.com/Devitek/mcp-ha/issues) avec la version de l'add-on, celle de HA, le client utilisé et un extrait de journal (masquez votre jeton).
