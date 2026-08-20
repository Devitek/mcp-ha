# MCP Home Assistant

Cet add-on expose un serveur [MCP](https://modelcontextprotocol.io) (Model Context Protocol) qui permet à un assistant IA (Claude Code, Claude Desktop, Gemini CLI...) d'interroger votre instance Home Assistant : entités, pièces, appareils, services, automations, scripts, historique, statistiques et add-ons.

Par défaut l'add-on est en **lecture seule**. L'écriture (appel de services) doit être activée explicitement et reste encadrée par des listes d'autorisation.

## Premiers pas

1. Installez l'add-on et démarrez-le.
2. Ouvrez le **Journal** de l'add-on : au premier démarrage, un jeton d'API est généré et affiché. Copiez-le.
3. Configurez votre client MCP (voir plus bas) avec l'adresse `http://IP_DE_HA:9583/mcp` et ce jeton.
4. Demandez par exemple à votre assistant : « quelles sont les lumières allumées ? »

## Options

| Option | Défaut | Description |
|--------|--------|-------------|
| `api_token` | vide | Jeton attendu des clients MCP (en-tête `Authorization: Bearer ...`). Laissez vide pour qu'un jeton soit généré au premier démarrage et affiché dans le journal. |
| `allow_write` | `false` | Expose l'outil `ha_call_service`. Sans cette option, aucun outil d'écriture n'est même visible du client. |
| `filter_reads` | `false` | Applique aussi `entity_denylist` aux lectures : les entités masquées disparaissent des listes et de `ha_get_entity`. |
| `entity_allowlist` | `[]` | Motifs glob d'entités autorisées à l'écriture (ex. `light.*`). Si la liste n'est pas vide, tout ce qui n'y figure pas est refusé. |
| `entity_denylist` | `[]` | Motifs glob d'entités interdites à l'écriture (ex. `lock.*`). La denylist gagne toujours sur l'allowlist. |
| `service_denylist` | voir config | Services interdits quel que soit le contexte. Les défauts bloquent l'arrêt de HA, les shell_command, la purge du recorder, etc. Réfléchissez avant d'en retirer. |

## Connexion des clients

Remplacez `IP_DE_HA` et `VOTRE_JETON`.

**Claude Code (CLI)** :

```bash
claude mcp add --transport http home-assistant \
  http://IP_DE_HA:9583/mcp \
  --header "Authorization: Bearer VOTRE_JETON"
```

**Claude Desktop** (`claude_desktop_config.json`) :

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://IP_DE_HA:9583/mcp",
               "--header", "Authorization: Bearer VOTRE_JETON"]
    }
  }
}
```

**Gemini CLI** (`~/.gemini/settings.json`) :

```json
{
  "mcpServers": {
    "home-assistant": {
      "httpUrl": "http://IP_DE_HA:9583/mcp",
      "headers": { "Authorization": "Bearer VOTRE_JETON" }
    }
  }
}
```

## Sécurité

- L'add-on est pensé pour un usage **LAN uniquement**. N'exposez pas le port 9583 sur internet : il n'y a ni TLS ni OAuth en v0.1.
- Le jeton d'API est un secret : ne le collez pas dans un ticket ou un partage d'écran.
- `allow_write` est désactivé par défaut. Activez-le seulement si vous voulez que l'assistant puisse agir, et pensez aux listes `entity_allowlist` et `entity_denylist`.
- Chaque tentative d'écriture (acceptée ou refusée) est tracée en JSON dans le journal de l'add-on.
- Limite connue : `ha_render_template` évalue des templates Jinja côté HA et peut lire l'état de n'importe quelle entité, `filter_reads` ne s'y applique pas.

Le détail du modèle de menace est dans le fichier [SECURITY.md](https://github.com/Devitek/mcp-ha/blob/main/SECURITY.md) du dépôt.

## Dépannage

- **Jeton perdu** : le jeton généré est conservé dans `/data/token`. Redémarrez l'add-on, il est réaffiché dans le journal. Pour en forcer un nouveau, renseignez `api_token` dans les options, ou supprimez le fichier `/data/token` puis redémarrez.
- **401 Unauthorized** : vérifiez l'en-tête `Authorization: Bearer ...` côté client, sans espace parasite.
- **Les outils répondent « WebSocket HA non connecté »** : consultez le journal, l'add-on retente la connexion en continu. Un redémarrage de Home Assistant provoque une coupure brève, la reconnexion est automatique.
- **`ha_get_addons` échoue** : l'API Supervisor n'est accessible que si l'add-on tourne bien en tant qu'add-on (pas en mode dev hors HA).
- **Santé** : `http://IP_DE_HA:9583/health` répond sans authentification avec l'état de la connexion WebSocket.
