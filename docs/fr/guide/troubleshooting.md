# Dépannage

## Jeton API perdu

Il est visible dans l'onglet **Configuration** de l'add-on (option `api_token`) et conservé dans `/data/token`. Un redémarrage de l'add-on le réaffiche dans l'onglet **Journal**. Pour en forcer un nouveau : videz l'option, supprimez `/data/token`, redémarrez.

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
{ "status": "ok", "version": "0.1.2", "websocket": true }
```

`websocket: false` signifie que l'add-on tourne mais n'est pas (encore) connecté à Home Assistant.

## Autre chose ?

Ouvrez une [issue sur GitHub](https://github.com/Devitek/mcp-ha/issues) avec la version de l'add-on, celle de HA, le client utilisé et un extrait de journal (masquez votre jeton).
