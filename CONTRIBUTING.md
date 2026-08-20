# Contribuer

Merci de votre intérêt ! Ce projet est petit mais tenu avec soin. Voici ce qu'il faut savoir.

## Développement local

Le serveur peut tourner hors add-on, contre n'importe quelle instance HA, avec un [jeton longue durée](https://my.home-assistant.io/redirect/profile_security/) :

```bash
cd mcp_ha
npm install
npm run build
HA_URL=http://homeassistant.local:8123 HA_TOKEN=votre_jeton_longue_duree \
MCP_API_TOKEN=un-jeton-de-dev npm start
```

Le serveur écoute sur `http://localhost:9583/mcp`. Limites du mode dev : l'outil `ha_get_addons` répond une erreur claire (pas d'API Supervisor hors add-on).

Tests et vérifications :

```bash
npm run build   # tsc strict
npm test        # vitest
```

Pour builder l'image comme le Supervisor le ferait : commentez la ligne `image:` de `config.yaml` et ajoutez le dossier du repo comme dépôt local d'add-ons, ou utilisez `docker build` dans `mcp_ha/`.

## Conventions

- **Commits** : [conventional commits](https://www.conventionalcommits.org/fr/), description en français. Types usuels : `feat`, `fix`, `docs`, `ci`, `chore`, `refactor`, `test`.
- **Langue** : tout est en français (code excepté) : issues, commits, docs, messages d'erreur destinés à l'utilisateur.
- **Style rédactionnel** : ton naturel et direct. Pas de tirets cadratins dans les textes, préférez la virgule, les deux-points ou les parenthèses.
- **Issues comme base de connaissances** : chaque décision de conception se trace dans une issue labellisée `décision` (fermée quand actée), chaque problème non trivial rencontré dans une issue `écueil` avec sa cause et sa solution. Des modèles d'issues sont fournis. C'est une habitude du projet, pas une option.
- **Sécurité d'abord** : tout changement touchant `safety.ts`, l'authentification ou les permissions de l'add-on doit venir avec ses tests et une mise à jour de SECURITY.md si le comportement change.
- **Documentation** : si le comportement visible change, DOCS.md et le README changent dans la même PR, et CHANGELOG.md prend une ligne.

## Publier une release

1. Monter la version dans `mcp_ha/config.yaml` et `mcp_ha/package.json` (elles doivent être identiques, la CI le vérifie).
2. Compléter `mcp_ha/CHANGELOG.md`.
3. Commit puis tag :

   ```bash
   git tag v0.2.0 && git push origin main --tags
   ```

4. Le workflow `release.yaml` construit les images aarch64 et amd64, les pousse sur ghcr et crée la GitHub Release avec notes générées.

Rappel première fois : les paquets ghcr doivent être rendus publics à la main (voir issue [#13](https://github.com/Devitek/mcp-ha/issues/13)), sinon le Supervisor ne peut pas tirer les images.
