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

## Tout autre client MCP

Tout client qui parle MCP en Streamable HTTP se configure pareil : endpoint `http://IP_DE_HA:9583/mcp`, en-tête `Authorization: Bearer VOTRE_JETON`. Le serveur est stateless : pas de négociation de session, chaque POST est indépendant.

## Depuis l'extérieur de votre réseau

Les exemples ci-dessus supposent un client sur votre LAN. Pour joindre l'add-on depuis un téléphone ou les connecteurs web claude.ai / Gemini, mettez en place un tunnel HTTPS authentifié : voir [Accès distant](/fr/guide/remote-access). Ne redirigez jamais le port 9583 directement.

## Premières questions à essayer

- « Quelles lumières sont allumées en ce moment ? »
- « Quelle est la température du salon et comment a-t-elle évolué aujourd'hui ? »
- « Liste mes automations, lesquelles ont tourné ces dernières 24 h ? »
- « Que s'est-il passé dans la maison cette nuit ? » (logbook)
- Avec `allow_write` activé : « Éteins toutes les lumières de la cuisine » (l'assistant utilisera `ha_call_service` ; demandez-lui un `dry_run` d'abord si vous voulez un aperçu)
