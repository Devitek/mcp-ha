# Sécurité

Donner à un LLM un accès à sa domotique n'est pas anodin. Ce document décrit ce que l'add-on protège, comment, et ce qu'il ne protège volontairement pas.

## Modèle de menace

**Ce qu'on protège :**

- L'instance Home Assistant contre des actions non voulues déclenchées par un client MCP (hallucination du modèle, prompt injection dans un contenu que le LLM lit, client compromis).
- Le jeton Supervisor : il ne quitte jamais l'add-on, les clients MCP n'y ont pas accès et aucun outil ne le renvoie.
- Le contexte de l'utilisateur : pas de fuite d'information vers des clients non authentifiés.

**Ce qu'on ne protège pas (hors périmètre v0.1) :**

- L'exposition sur internet. L'add-on parle HTTP en clair avec un jeton statique : c'est un design LAN. Si vous voulez un accès distant, passez par un VPN (WireGuard, Tailscale...), pas par une redirection de port.
- Un attaquant déjà présent sur votre LAN qui intercepte le trafic (pas de TLS).
- Un utilisateur légitime du client MCP qui demande des actions autorisées mais regrettables. Les listes d'autorisation limitent le rayon d'action, pas l'intention.

## Mécanismes en place

1. **Authentification bearer** sur l'endpoint MCP, comparaison en temps constant. Le jeton est généré aléatoirement (32 octets) au premier démarrage si non fourni, persisté dans `/data/token` en mode 600.
2. **Lecture seule par défaut.** `allow_write: false` fait que l'outil `ha_call_service` n'est pas enregistré du tout : il n'apparaît même pas dans la liste des outils du client.
3. **Denylist de services** livrée avec des défauts sérieux : `homeassistant.stop`, `homeassistant.restart`, `hassio.*`, `shell_command.*`, `python_script.*`, `recorder.purge*`, `backup.*`.
4. **Listes glob d'entités** pour l'écriture : `entity_allowlist` (si non vide, tout le reste est refusé) et `entity_denylist` (gagne toujours). Le ciblage par `area_id` ou `device_id` est refusé dès qu'une restriction d'entités est configurée, car il permettrait de la contourner.
5. **Audit** : chaque tentative d'écriture, acceptée ou refusée, est journalisée en JSON dans les logs de l'add-on avec sa raison.
6. **dry_run** pour prévisualiser un appel de service sans l'exécuter.
7. **filter_reads** (optionnel) pour masquer aussi en lecture les entités de la denylist (caméras, trackers...).
8. **Garde-fous d'API** : corps de requête plafonné, slug d'add-on validé par regex avant insertion dans une URL, messages d'erreur sans stack trace.

## Limites connues et assumées

- `ha_render_template` évalue du Jinja côté HA : c'est en lecture seule, mais un template peut lire l'état de n'importe quelle entité. `filter_reads` ne s'y applique pas. Si c'est un problème pour vous, il faudra attendre une option dédiée (ou ne pas exposer l'add-on à ce client).
- Le jeton généré est affiché dans le journal de l'add-on au démarrage : c'est le seul canal disponible pour vous le transmettre. Le journal n'est visible que des admins HA.
- L'add-on demande `hassio_role: manager` pour lire les add-ons. C'est peut-être plus que nécessaire, la réduction est suivie dans l'issue [#11](https://github.com/Devitek/mcp-ha/issues/11).

## Signaler une vulnérabilité

Utilisez les [advisories de sécurité GitHub](https://github.com/Devitek/mcp-ha/security/advisories/new) (signalement privé) plutôt qu'une issue publique. Décrivez le scénario d'attaque et, si possible, une reproduction. Réponse sous quelques jours au mieux : c'est un projet personnel, pas une équipe d'astreinte.
