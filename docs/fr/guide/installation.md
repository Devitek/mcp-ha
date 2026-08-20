# Installation

## Prérequis

- **Home Assistant OS** ou **Home Assistant Supervised**. L'add-on tourne dans un conteneur géré par le Supervisor ; les installations Container et Core n'ont pas d'add-ons.
- Architecture aarch64 (Raspberry Pi 4/5 et autres cartes ARM 64 bits) ou amd64 (NUC, VM, serveur x86).

## Ajouter le dépôt

Cliquez sur le bouton :

[![Ajouter le dépôt](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FDevitek%2Fmcp-ha)

Ou manuellement : **Paramètres → Modules complémentaires → Boutique → ⋮ → Dépôts**, puis collez :

```
https://github.com/Devitek/mcp-ha
```

## Installer et démarrer

1. Trouvez **MCP Home Assistant** dans la boutique (rafraîchissez la page si besoin) et cliquez sur **Installer**. Le Supervisor tire une image préconstruite depuis GitHub Container Registry, cela prend quelques secondes.
2. Cliquez sur **Démarrer**.

## Récupérer votre jeton API

Au premier démarrage, l'add-on génère un jeton API aléatoire (32 octets) et l'enregistre dans l'onglet **Configuration** de l'add-on, dans l'option `api_token`. Cet onglet est le seul endroit où la valeur complète est visible : l'onglet **Journal** n'affiche jamais qu'un préfixe masqué du type `d370f4f8**********`, car un secret n'a rien à faire dans des logs.

Chaque installation a son propre jeton : réinstaller l'add-on efface ses données et en produit un neuf. Vous pouvez aussi définir votre propre valeur dans `api_token` à tout moment ; redémarrez l'add-on pour l'appliquer. Si l'option semble vide, redémarrez l'add-on : l'enregistrement du jeton y est retenté à chaque démarrage.

Étape suivante : [connecter un client](/fr/guide/clients).
