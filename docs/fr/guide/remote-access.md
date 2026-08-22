# Accès distant

L'add-on est pensé pour un usage **LAN** : HTTP en clair, jeton bearer statique, pas de TLS. C'est le bon défaut pour un serveur domestique, mais l'endpoint n'est alors joignable que depuis votre réseau local. Pour parler à votre maison depuis l'extérieur (un téléphone, un portable en déplacement, les connecteurs web claude.ai ou Gemini), il vous faut un point d'entrée HTTPS authentifié.

::: danger Ne redirigez jamais le port
N'exposez pas le port 9583 directement sur internet via une redirection de port de votre box. C'est du HTTP en clair protégé par un seul jeton : n'importe quel scan d'internet le trouverait, et un jeton fuité serait fatal. Utilisez plutôt l'un des tunnels ci-dessous.
:::

## Option A : Tailscale (recommandé)

[Tailscale](https://tailscale.com) place vos appareils sur un réseau maillé privé ; rien n'est publié sur l'internet public. Il existe un add-on Tailscale officiel pour Home Assistant.

1. Installez et démarrez l'add-on **Tailscale**, connectez-vous, et notez le nom machine attribué à votre HA (ex. `homeassistant`).
2. Votre téléphone ou portable, une fois sur le même tailnet, joint l'add-on à `http://homeassistant:9583/mcp` (ou l'IP tailnet). Pointez votre client MCP dessus.
3. Pour une URL HTTPS acceptée par les connecteurs web, activez **Tailscale Serve** afin d'exposer l'add-on en HTTPS dans votre tailnet :

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:9583
   ```

   Vous utilisez alors `https://<machine>.<tailnet>.ts.net/mcp`.

Modèle de confiance : votre trafic reste dans votre tailnet, le jeton bearer ne traverse jamais l'internet public, et seuls les appareils que vous avez autorisés joignent l'endpoint. C'est l'option la plus sûre.

## Option B : Cloudflare Tunnel

Un [tunnel Cloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) expose un service en HTTPS sur un domaine que vous contrôlez, sans ouvrir de port. Combinez-le avec **Cloudflare Access** pour que seuls des utilisateurs authentifiés y accèdent.

1. Créez un tunnel et routez un nom d'hôte (ex. `mcp.example.com`) vers `http://homeassistant:9583`.
2. Placez une politique Cloudflare Access devant ce nom d'hôte (liste blanche d'emails, ou un service token pour les clients programmatiques). Sans Access, le tunnel est public et seul votre jeton bearer se dresse entre internet et votre maison ; ajoutez Access.
3. Votre client MCP utilise `https://mcp.example.com/mcp` avec le jeton bearer.

Modèle de confiance : Cloudflare termine le TLS et voit votre trafic (jeton bearer compris). C'est un tiers de plus à qui faire confiance. Cloudflare Access est ce qui empêche l'endpoint d'être ouvert à tous.

## Et l'OAuth intégré ?

Évalué et volontairement non implémenté ([issue #84](https://github.com/Devitek/mcp-ha/issues/84)). En résumé :

- L'add-on ne termine pas le TLS : des flux OAuth sur du HTTP en clair seraient pires que le bearer actuel, pas meilleurs. Toute couche TLS viendrait d'un tunnel ou d'un reverse proxy, qui portent déjà leur propre authentification forte (identité Tailscale, Cloudflare Access).
- Un serveur d'autorisation MCP complet (enregistrement dynamique des clients, PKCE, écran de consentement, émission et rotation de jetons) est une grosse surface sensible à maintenir dans un add-on LAN mono-utilisateur, pour un besoin que le tunnel plus les [jetons nommés à portées](/fr/guide/configuration#jetons-nommes) couvrent déjà.
- On réévalue quand un client MCP majeur exigera OAuth en refusant les bearers statiques, ou si l'add-on termine un jour le TLS lui-même. Si vous rencontrez ce cas, dites-le sur l'issue.

## Quelle que soit l'option

- Gardez `allow_write` désactivé sauf si vous voulez vraiment des actions à distance ; un endpoint distant élargit le rayon d'explosion d'un jeton fuité.
- Renouvelez votre jeton s'il transite un jour par un service en qui vous n'avez pas pleine confiance.
- La confirmation en deux temps sur serrures et alarmes s'applique toujours, à distance comme en local.
