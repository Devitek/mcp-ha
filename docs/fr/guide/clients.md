# Connecter des clients

Le serveur parle MCP en **Streamable HTTP** sur `http://IP_DE_HA:9583/mcp`, avec un jeton bearer. Remplacez `IP_DE_HA` et `VOTRE_JETON` dans les exemples.

::: tip
L'endpoint n'accepte que POST (mode stateless). `http://IP_DE_HA:9583/health` répond sans authentification et indique si l'add-on est connecté à Home Assistant.
:::

## Claude Code (CLI)

```bash
claude mcp add --transport http home-assistant \
  http://IP_DE_HA:9583/mcp \
  --header "Authorization: Bearer VOTRE_JETON"
```

Ensuite posez vos questions en session : « quelles lumières sont allumées ? », « montre-moi les automations qui ont tourné cette nuit ».

## Claude Desktop

Claude Desktop lance lui-même ses serveurs MCP, il lui faut donc un petit pont (`mcp-remote`) pour joindre un serveur HTTP. Dans `claude_desktop_config.json` :

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

Redémarrez Claude Desktop après modification du fichier.

## Gemini CLI

Dans `~/.gemini/settings.json` :

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

## OpenCode

La bonne façon : le jeton vit dans une variable d'environnement, jamais dans le fichier de config. Exportez-le depuis votre profil shell :

```sh
export HA_MCP_TOKEN="VOTRE_JETON"
```

Puis dans `opencode.json` (racine du projet, ou `~/.config/opencode/opencode.json`), avec la substitution native `{env:...}` d'OpenCode :

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "home-assistant": {
      "type": "remote",
      "url": "http://IP_DE_HA:9583/mcp",
      "enabled": true,
      "oauth": false,
      "headers": { "Authorization": "Bearer {env:HA_MCP_TOKEN}" }
    }
  }
}
```

Le `oauth: false` compte : l'add-on utilise des jetons bearer statiques (voir [pourquoi pas OAuth](https://github.com/Devitek/mcp-ha/issues/84)), il évite qu'OpenCode tente une découverte OAuth contre l'endpoint.

## Tout autre client MCP

Tout client qui parle MCP en **Streamable HTTP** se configure de la même façon :

| | |
|---|---|
| Transport | Streamable HTTP (JSON-RPC en POST) |
| Endpoint | `http://IP_DE_HA:9583/mcp` |
| Authentification | En-tête `Authorization: Bearer VOTRE_JETON` sur chaque requête |
| Mode | Stateless par défaut : chaque POST est indépendant, pas de négociation de session. Avec `enable_sessions: true`, un `initialize` ouvre une session SSE (abonnements, élicitation). |

Si votre client supporte la substitution de variables d'environnement dans sa config, préférez-la au jeton collé dans un fichier, comme l'exemple OpenCode ci-dessus.

## Depuis l'extérieur de votre réseau

Les exemples ci-dessus supposent un client sur votre LAN. Pour joindre l'add-on depuis un téléphone ou les connecteurs web claude.ai / Gemini, mettez en place un tunnel HTTPS authentifié : voir [Accès distant](/fr/guide/remote-access). Ne redirigez jamais le port 9583 directement.

## Premières questions à essayer

- « Quelles lumières sont allumées en ce moment ? »
- « Quelle est la température du salon et comment a-t-elle évolué aujourd'hui ? »
- « Liste mes automations, lesquelles ont tourné ces dernières 24 h ? »
- « Que s'est-il passé dans la maison cette nuit ? » (logbook)
- Avec `allow_write` activé : « Éteins toutes les lumières de la cuisine » (l'assistant utilisera `ha_call_service` ; demandez-lui un `dry_run` d'abord si vous voulez un aperçu)
