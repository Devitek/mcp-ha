# Changelog

## 0.1.0

Première version.

- Serveur MCP en Streamable HTTP (port 9583) avec authentification par jeton bearer, généré automatiquement au premier démarrage.
- 15 outils de lecture : recherche et listes d'entités, pièces, appareils, services, automations (avec config), scripts, historique, statistiques long terme, logbook, add-ons, rendu de template, infos système.
- Un outil d'écriture, `ha_call_service`, désactivé par défaut (`allow_write: false`) et encadré : listes glob d'entités, denylist de services, dry_run, journal d'audit.
- Connexion à Home Assistant en WebSocket avec reconnexion automatique.
