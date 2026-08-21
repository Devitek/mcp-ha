# Sécurité

Donner à un LLM l'accès à sa domotique mérite une vraie posture de sécurité. Cette page résume le modèle ; le document de référence est le [SECURITY.md](https://github.com/Devitek/mcp-ha/blob/main/SECURITY.md) du dépôt.

## Choix de conception

- **Lecture seule par défaut.** Avec `allow_write: false` (le défaut), l'outil d'écriture n'est pas enregistré : il n'apparaît pas du tout dans la liste des outils du client.
- **LAN uniquement.** HTTP en clair avec un jeton bearer statique. N'exposez pas le port 9583 sur internet ; pour un accès distant, passez par un VPN (WireGuard, Tailscale...).
- **Le jeton Supervisor ne quitte jamais l'add-on.** Les clients MCP s'authentifient avec leur propre jeton API ; aucun outil ne renvoie le moindre identifiant HA.

## Parcours d'une écriture

Chaque appel à `ha_call_service` traverse ce parcours :

```mermaid
flowchart TD
  A["ha_call_service"] --> B{"allow_write activé ?"}
  B -- "non" --> R0["Outil non enregistré :<br>invisible pour le client"]
  B -- "oui" --> C{"service dans<br>service_denylist ?"}
  C -- "oui" --> R1["Refusé + ligne d'audit"]
  C -- "non" --> D{"entités ciblées conformes<br>aux listes blanche/noire ?"}
  D -- "non" --> R1
  D -- "oui" --> E{"cible area_id / device_id<br>avec restrictions actives ?"}
  E -- "oui" --> R1
  E -- "non" --> F{"dry_run ?"}
  F -- "oui" --> P["Aperçu renvoyé + audit,<br>rien d'exécuté"]
  F -- "non" --> X["call_service exécuté + audit"]
```

Les lignes d'audit sont en JSON, une par tentative, et sont émises quel que soit le niveau de log configuré. Voir [Journalisation](/fr/reference/logging).

## Cycle de vie du jeton

- Généré au premier démarrage (32 octets aléatoires) quand `api_token` est vide.
- Persisté dans `/data/token` (mode 600) et reporté dans les options de l'add-on. Le journal ne le montre jamais en entier : seulement un préfixe masqué à remplissage fixe (`d370f4f8**********`), qui ne révèle ni la valeur ni sa longueur.
- Comparé en temps constant à chaque requête.
- Pour le renouveler : videz l'option `api_token`, supprimez `/data/token` (ou réinstallez), redémarrez, puis mettez à jour vos clients.

::: warning Versions antérieures à 0.1.4
Les versions 0.1.0 à 0.1.3 de l'add-on affichaient le jeton en entier dans le journal. Si vous avez partagé des logs produits par ces versions (issue, forum, capture), renouvelez votre jeton maintenant.
:::

## Autres garde-fous

- Après 5 échecs d'authentification, une IP est bloquée progressivement (jusqu'à 60 s, HTTP 429 avec `Retry-After`) ; un jeton saisi à la main de moins de 16 caractères déclenche un avertissement bruyant au démarrage.
- Le serveur Node tourne sous un utilisateur dédié non privilégié dans le conteneur, confiné par un profil AppArmor qui interdit `/etc/shadow`, l'écriture hors de `/data` et l'élévation de privilèges. Le profil a été validé sur un vrai hôte AppArmor en mode enforce.

## Limites assumées

- `ha_render_template` évalue du Jinja côté serveur et peut lire l'état de **n'importe quelle** entité : il est donc entièrement désactivé quand `filter_reads` est actif.
- Le jeton présent dans les options se retrouve dans les sauvegardes de l'add-on, et visible des admins HA. Les journaux aussi.
- Pas de TLS : quiconque peut sniffer votre LAN peut lire le jeton. C'est le compromis du choix LAN uniquement.

## Signalement

Une vulnérabilité ? Utilisez les [advisories privées](https://github.com/Devitek/mcp-ha/security/advisories/new) plutôt qu'une issue publique.
