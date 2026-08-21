# Audit externe : mcp-ha v0.1.4 (bb15695)

Audit en lecture seule mené le 2026-08-20 par 7 revues indépendantes (une par axe), chaque fichier relu depuis le disque. Aucune modification apportée. Les findings fusionnés entre axes portent la mention (=Xn).

## 1. Synthèse

État général : projet jeune mais tenu, fondations sérieuses (auth timing-safe, écriture invisible par défaut, audit JSON, 104 tests, doc d'une exactitude rare). Les faiblesses sont concentrées sur trois fronts : la résilience des frontières réseau (aucun timeout HTTP, handshake WS sans garde), la chaîne d'approvisionnement de la release (action mutable avec droits d'écriture), et les séquelles d'un jeton loggé en clair dans les versions publiées 0.1.0 à 0.1.3.

Notes par axe : A conformité add-on 7/10, B TypeScript 6,5/10, C intégration HA 7/10, D sécurité 7/10, E tests et CI 6,5/10, F runtime 6,5/10, G documentation 9/10. Global : 7/10.

Trois risques majeurs :
1. **Jeton divulgué par les logs des versions publiées 0.1.0 à 0.1.3** (D1) : tout partage de journal antérieur à 0.1.4 expose le secret ; un advisory et une consigne de rotation s'imposent.
2. **Supply chain release** (D2) : `home-assistant/builder@master` est une référence mutable exécutée avec `packages: write` ; une compromission amont publie des images piégées sous ghcr.io/devitek.
3. **Blocages et écrasements silencieux** : fetch sans timeout (C1) et handshake WS sans garde (C2) peuvent suspendre tous les outils indéfiniment ; le write-back des options (F2) peut écraser une modification utilisateur et fige les défauts de `service_denylist` pour toujours.

## 2. Findings par axe

Sévérités : Critique > Élevée > Moyenne > Faible > Nit. Aucun finding Critique.

### Axe A : conformité add-on (7/10)

N/A justifiés : ingress et panel (clients MCP hors session HA), watchdog config.yaml (déprécié, remplacé par HEALTHCHECK), map (seul /data, monté d'office), armv7/i386 (32 bits dépréciés, incompatibles Node 26), boot (défaut auto suffisant).

| ID | Sévérité | Fichier:lignes | Problème | Impact | Correctif | Effort |
|----|----------|----------------|----------|--------|-----------|--------|
| A1 (=C8, D4) | Élevée | mcp_ha/config.yaml:15-18 | `hassio_role: manager` alors que le code n'appelle que `/addons/self/info` et `/addons/self/options` (index.ts:56-58, http.ts:70-80), endpoints self accessibles à tout add-on quel que soit le rôle | jeton Supervisor surprivilégié dans un process exposé au LAN ; en cas de compromission, gestion d'autres add-ons possible ; score de sécurité HA dégradé | passer à `hassio_role: default`, retester `ha_get_addons` et le write-back sur instance réelle (issue #11) | S |
| A2 | Moyenne | mcp_ha/ (apparmor.txt absent) | aucun profil AppArmor custom | pas de confinement du process node qui parse des requêtes réseau ; score de sécurité HA amputé d'un point | apparmor.txt basé sur l'exemple officiel (accès /data, réseau, node) | M |
| A4 | Faible | mcp_ha/config.yaml:12 | `startup: services` alors que l'add-on dépend de l'API Core dès le boot (index.ts:69-70) | erreurs de connexion et logs bruités à chaque démarrage machine le temps du backoff | `startup: application` | S |
| A6 | Nit | mcp_ha/ (README.md absent du dossier) | pas de README.md dans le dossier add-on (convention addons-example) | présentation GitHub du dossier vide | README court renvoyant vers DOCS.md | S |
| A7 | Nit | mcp_ha/Dockerfile:3,12-15,26-27 | commentaires en français, reste du dépôt commenté en anglais | incohérence post bascule anglais | traduire | S |
| A8 | Nit | repository.yaml:3 | `maintainer` sans email | écart à la convention Nom \<email\> | compléter | S |
| A9 | Nit | mcp_ha/Dockerfile:28-29 vs src/config.ts:53 | HEALTHCHECK code le port 9583 en dur alors que le serveur écoute cfg.port | incohérence latente si le port devient configurable | dériver de MCP_PORT | S |

### Axe B : qualité TypeScript (6,5/10)

Comptages vérifiés : 13 `any` (tous à la frontière HA), ~8 `as` hors imports, 0 assertion non-null. Points positifs : safeEqual correct, DI testable, `void persistGeneratedToken` assumé, garde area_id/device_id.

| ID | Sévérité | Fichier:lignes | Problème | Impact | Correctif | Effort |
|----|----------|----------------|----------|--------|-----------|--------|
| B2 | Élevée | mcp_ha/src/ha/ws.ts:83-90,121 (+catalog.ts:24-35, services.ts:35, history.ts:48,91,135, system.ts:43-52, addons.ts:39) | `send(): Promise<any>` : tous les payloads HA castés sans validation runtime | au premier changement de schéma HA, TypeError confuse (« x.map is not a function ») renvoyée au LLM, indiagnosticable | `send<T>` + parse zod minimal aux 3 entrées principales (registries, get_states, get_services), zod est déjà là | M |
| B4 | Moyenne | mcp_ha/src/config.ts:33-64 | options.json casté sans validation Node : `Number(MCP_PORT)` accepte NaN (l.53), `String(api_token)` coerce un objet en "[object Object]" (l.45) | démarrage qui plante avec erreur obscure ou jeton corrompu silencieusement (le schéma Supervisor ne protège pas le mode dev) | schéma zod avec bornes et défauts dans loadConfig | S |
| B5 (=C9) | Moyenne | mcp_ha/src/ha/catalog.ts:22-31 + tools/entities.ts:171 | pas de mémoïsation de la promesse en vol de `registries()` ; ha_list_areas déclenche registries() et index() en parallèle | cache froid = 6 commandes WS au lieu de 3 ; données périmées jusqu'à 60 s après un redémarrage de HA (pas d'invalidation sur auth_ok) | promesse in-flight partagée + invalidation du cache à la reconnexion | S |
| B6 | Moyenne | mcp_ha/src/mcp/helpers.ts:69-73 | `safe()` ne logge que e.message, jamais la stack | les TypeError de B2 sont localisables nulle part | log.debug(e.stack) dans le catch | S |
| B7 | Moyenne | mcp_ha/src/mcp/tools/automations.ts:66-71 | `catch {}` affirme « YAML automation or insufficient rights » même si HA est injoignable | diagnostic faux transmis au LLM, panne réseau maquillée en cas normal | distinguer 404 du reste, logger l'erreur réelle | S |
| B8 | Moyenne | mcp_ha/tsconfig.json:2-14 | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` absents ; target ES2022 sous Node 26 | services.ts:15 `Object.keys(f.selector)[0]` peut émettre `{selector: undefined}` ; index.ts:99 `match[1]` non signalé | activer les flags, target ES2024, corriger les erreurs révélées | S |
| B9 | Faible | mcp_ha/src/index.ts:120-125 | tout échec du handler répond -32700 « parse error » en 400 même quand le JSON était valide | code JSON-RPC faux pour les clients, débogage trompeur | réserver -32700 au parse, -32603 sinon | S |
| B12 | Faible | entities.ts:56-60,114-119,137-140 ; history.ts:44-46,87-89,129-131 ; automations.ts:28,47-49,58,94 | garde filter_reads répétée 5 fois, scoring dupliqué, extraction last_triggered castée 3 fois | dérive probable des règles et messages entre outils | helpers requireVisible() et rankEntities() | S |
| B13 | Faible | mcp_ha/ (racine) + ci.yaml:9-19 | aucun linter (eslint/biome) ; la CI ne lint que le manifest | no-floating-promises, no-unsafe-* non appliqués | typescript-eslint recommended-type-checked en CI | M |
| B14 | Nit | mcp_ha/src/mcp/helpers.ts:4,32-35,47 | MAX_RESPONSE_BYTES compare des unités UTF-16, pas des octets ; trunc peut couper une paire de substitution | budget dépassé jusqu'à 3x en contenu multi-octets | Buffer.byteLength + troncature sur points de code | S |

### Axe C : intégration Home Assistant (7/10)

N/A : MQTT absent, ingress absent, aucun abonnement WS à ré-établir, débordement de nextId non-problème (2^53). SUPERVISOR_TOKEN : aucune fuite trouvée sur l'ensemble des chemins (uniquement ws.ts:130 et http.ts:33, jamais loggé ni renvoyé).

| ID | Sévérité | Fichier:lignes | Problème | Impact | Correctif | Effort |
|----|----------|----------------|----------|--------|-----------|--------|
| C1 (=B1) | Élevée | mcp_ha/src/ha/http.ts:28-43 | fetch sans AbortController ni timeout, aucun retry, 429/5xx non différenciés | un Supervisor/Core qui ne répond pas suspend l'appel d'outil indéfiniment, le client MCP pend | `AbortSignal.timeout(15_000)` + 1 retry backoff sur 429/5xx (respecter Retry-After) | S |
| C2 | Élevée | mcp_ha/src/ha/ws.ts:56-74,92-101,169-177 | aucun timeout de handshake ni de phase auth ; le ping ne démarre qu'après auth_ok | connexion semi-ouverte (reboot HA, coupure pendant l'auth) : jamais de close, jamais de reconnexion, tous les outils échouent jusqu'au redémarrage du process | handshakeTimeout sur new WebSocket + timer qui terminate() si auth_ok n'arrive pas sous 15 s | S |
| C4 (=B11) | Moyenne | mcp_ha/src/ha/ws.ts:142-146,193-195 (+56-64) | auth_invalid = reconnexion infinie toutes les 30 s avec le même jeton ; et si url() échoue en dev, connect() abandonne sans jamais réessayer | boucle d'échecs d'auth qui pollue les logs HA ; ou serveur vivant dont chaque outil échoue après 10 s | compter les auth_invalid, passer en backoff long ou log.fatal après 3 ; réessayer aussi sur échec d'url | S |
| C5 (=F8) | Moyenne | mcp_ha/src/ha/ws.ts:76-80,180-196 | onClose ne vérifie pas que le socket fermé est encore this.ws ; waiters de ready() jamais rejetés au close ; shutdown() n'annule pas le setTimeout de reconnexion | close tardif en course avec un connect() neuf = double chaîne de reconnexion ; waiters bloqués 10 s sur socket morte ; timers orphelins à l'arrêt | capturer ws localement, garde `ws !== this.ws`, rejeter les waiters, tracer et clearTimeout le handle de reconnexion | S |
| C7 (=E6) | Moyenne | mcp_ha/src/index.ts:53-64,73 | persistGeneratedToken tenté une seule fois au boot alors que le Supervisor peut répondre 503 au démarrage de HA ; non testé, catch avale tout | le jeton n'atterrit jamais dans l'onglet Configuration alors que logs et doc le promettent | 3 tentatives espacées (5/30/120 s) + test unitaire avec mocks | S |
| C10 | Nit | mcp_ha/src/mcp/tools/history.ts:48-64 | include_start_time_state laissé au défaut HA (true) : le premier point peut précéder `from` et entre dans `count` | légère incohérence fenêtre annoncée vs points renvoyés | le passer explicitement ou documenter | S |

### Axe D : sécurité (7/10)

N/A : pas de TLS et LAN assumés et documentés ; dépendances à jour (sdk 1.30.0, ws 8.21.3, zod 4.4.3), lockfile cohérent ; aucun secret réel committé (le hex 64 de l'historique est une fixture de test) ; injections : rien trouvé (slug regexé, id encodé, reste en JSON WS).

| ID | Sévérité | Fichier:lignes | Problème | Impact | Correctif | Effort |
|----|----------|----------------|----------|--------|-----------|--------|
| D1 | Élevée | historique git : config.ts introduit en bf993a6 (l.68,82), corrigé en c926079 ; releases v0.1.0 à v0.1.3 | le jeton complet était loggé à chaque démarrage et la doc invitait à le lire dans les logs | tout partage de journal (issue, forum, capture) antérieur à 0.1.4 divulgue le jeton ; versions affectées toujours installables | advisory GitHub + consigne de rotation pour toute installation < 0.1.4 | S |
| D2 (=E2) | Élevée | .github/workflows/release.yaml:54 | home-assistant/builder@master : référence mutable, action en fin de vie, job avec packages: write | compromission amont = images piégées publiées sous ghcr.io/devitek | épingler par SHA à court terme, migrer vers docker/build-push-action (issue #25) | M |
| D3 | Moyenne | mcp_ha/src/index.ts:97-103 + src/config.ts:45 | aucun rate limit sur /mcp, aucune longueur minimale pour un api_token fourni par l'utilisateur | un jeton faible (« 1234 ») est brute-forçable depuis le LAN, échecs seulement loggés | longueur minimale 16+ au chargement + délai progressif par IP sur échecs | M |
| D5 (=C6) | Moyenne | mcp_ha/src/mcp/tools/system.ts:16-25 | ha_render_template contourne filter_reads et entity_denylist, toujours enregistré (limitation admise SECURITY.md:32) | toute entité masquée reste lisible via `{{ states(...) }}`, exfiltrable par prompt injection | refuser ou désenregistrer l'outil quand filter_reads est actif (ou option dédiée) | S |
| D6 | Moyenne | .github/workflows/release.yaml:8-10 | contents: write + packages: write au niveau workflow, hérités par les 3 jobs dont verify | toute action compromise dans n'importe quel job peut pousser code ou images | permissions par job (verify: aucune, build: packages, release: contents) | S |
| D8 | Faible | mcp_ha/Dockerfile (aucun USER) | node écoute sur 0.0.0.0 en root dans le conteneur | une RCE dans une dépendance donne root conteneur | drop des privilèges après bind | M |
| D9 | Faible | .github/workflows/ci.yaml:1-8 | aucun bloc permissions, token par défaut du repo | jeton surdimensionné si le défaut est write | permissions: contents: read | S |
| D10 (=E10) | Faible | .github/workflows/release.yaml (absence) | pas de scan trivy/grype, pas de signature/provenance des images | image vulnérable publiée sans détection, origine invérifiable | job trivy + attestation GitHub | M |
| D11 | Faible | mcp_ha/src/index.ts:78-83 | /health non authentifié renvoie la version exacte | fingerprinting d'une version vulnérable facilité | retirer version du payload non authentifié | S |
| D12 | Nit | mcp_ha/src/index.ts:53-64 + SECURITY.md:33 | jeton présent dans /data/token, options.json et les backups HA | trois emplacements à protéger, un backup exfiltré suffit | documenter la procédure de rotation dans DOCS.md | S |
| D13 | Nit | mcp_ha/src/index.ts:123 + src/ha/http.ts:40 | messages d'erreur internes bruts renvoyés au client | fuite mineure de détails internes, post-auth | message générique client, détail en log | S |

### Axe E : tests et CI (6,5/10)

N/A vérifiés : flakiness suspectées infondées (toIso/timeWindow indépendants de l'horloge ; ws.test sur port 0 avec shutdown propre). Versions 0.1.4 alignées entre config.yaml, package.json et config.ts.

| ID | Sévérité | Fichier:lignes | Problème | Impact | Correctif | Effort |
|----|----------|----------------|----------|--------|-----------|--------|
| E1 | Élevée | mcp_ha/src/index.ts:14-37,97-125 (aucun index.test.ts) | auth bearer, 401/405/404, limite body 4 Mo, JSON invalide : zéro test | la frontière de sécurité du produit peut régresser sans aucun échec CI | extraire le handler de main() et le tester par injection (http.request local) | M |
| E3 (=B3) | Moyenne | mcp_ha/tsconfig.json:16 + package.json:11-15 + ci.yaml:41-48 | tests exclus du build, vitest ne typecheck pas : ~1200 lignes de tests jamais passées sous tsc | erreurs de type dans les tests invisibles, dérive silencieuse des fakes | script typecheck (tsc --noEmit, tsconfig incluant les tests) en CI | S |
| E4 | Moyenne | .github/workflows/release.yaml:20-30 vs src/config.ts:6 | la garde de version ne vérifie pas VERSION de config.ts | /health et logs annoncent une version fausse après un oubli | grep supplémentaire dans le job verify | S |
| E5 | Moyenne | mcp_ha/src/ha/ws.ts:142-196 vs ws.test.ts:66-123 | reconnexion/backoff, ping keep-alive et auth_invalid non testés | la résilience, raison d'être du client WS, peut régresser sans échec | serveur qui ferme puis réécoute + vi.useFakeTimers | M |
| E7 | Moyenne | .github/workflows/docs.yaml:3-11 | build VitePress jamais exécuté sur PR | une PR docs cassée n'échoue qu'après merge et bloque Pages | job build-only sur pull_request paths docs/** | S |
| E8 | Faible | ci.yaml:50-60 vs release.yaml:36-44 | validation Docker amd64 seule ; aarch64 construit pour la première fois au tag | échec de cross-compilation découvert pendant la release | matrice amd64+aarch64 dans build-image | M |
| E9 | Faible | mcp_ha/package.json:13,21-26 + ci.yaml:44-45 | aucune couverture mesurée ni publiée | l'angle mort index.ts 0 % est passé inaperçu | vitest --coverage + seuils ciblés (index.ts, safety.ts) | S |
| E11 | Faible | mcp_ha/src/mcp/tools/testkit.test.ts:1-5,19,72,91-95 | utilitaires dans un .test.ts avec test bidon anti empty-suite, fakes en `as any` | contournement fragile, fakes qui peuvent diverger de ToolContext | renommer testkit.ts, glob d'exclusion dédié, typer fakeCtx | S |
| E12 | Nit | .github/workflows/ci.yaml:3-6 | pas de bloc concurrency | runs redondants empilés sur pushes successifs | concurrency + cancel-in-progress | S |

### Axe F : runtime (6,5/10)

N/A : analyse statique seule, aucune mesure réelle sur Pi.

| ID | Sévérité | Fichier:lignes | Problème | Impact | Correctif | Effort |
|----|----------|----------------|----------|--------|-----------|--------|
| F1 | Élevée | mcp_ha/src/ha/catalog.ts:33-38 + tools/entities.ts:37-38,141 | get_states COMPLET sans cache à chaque appel d'outil, même ha_get_entity pour une entité ; parse JSON multi-Mo + jointure + 3 Maps reconstruites | sur Pi avec 2000+ entités : 300 ms à 1 s par appel, pic RSS ~2x la flotte, GC churn sur toute conversation | micro-cache TTL 2-5 s sur states() (ou subscribe_entities), GET /api/states/{id} pour le détail | M |
| F2 (=C3) | Élevée | mcp_ha/src/index.ts:53-58 | write-back POST /addons/self/options avec l'objet options COMPLET renvoyé par info (défauts fusionnés inclus), sans re-vérification | fige tous les défauts en options utilisateur : les futures mises à jour de service_denylist (défauts sécurité) ne s'appliqueront jamais aux installs existantes ; écrase une modif UI concurrente entre GET et POST | ne poster que api_token, et re-vérifier juste avant le POST qu'il est encore vide | M |
| F3 (=A3, B10) | Moyenne | mcp_ha/src/index.ts:136-141 | process.exit(0) immédiat après httpServer.close() sans attendre le callback | chaque update/restart tronque les réponses MCP en vol (ECONNRESET), close frame WS jamais envoyée | attendre close() avec timeout 5 s puis closeAllConnections() avant exit | S |
| F4 | Moyenne | mcp_ha/src/index.ts:81 + Dockerfile:28-29 | /health renvoie 200 même si websocket:false ; le HEALTHCHECK ne teste que le listener HTTP | conteneur healthy et watchdog muet alors que 100 % des outils échouent | 503 si ws.connected faux depuis plus de N minutes | S |
| F5 (=A5, D7) | Moyenne | mcp_ha/Dockerfile:1,4 + build.yaml:2-3 | node:26-alpine flottant copié vers base HA 3.24 : versions musl non appariées ni épinglées ; commentaire « LTS » inexact (26 = Current) | un bump d'Alpine côté image node peut produire un binaire exigeant un musl plus récent que la base : crash au boot sur simple rebuild | épingler node:26.x.y-alpine3.24 (ou digest) + RUN node --version dans l'étape finale | S |
| F6 | Moyenne | mcp_ha/src/config.ts:92 | écriture de /data/token non atomique (pas de tmp+rename) | kill pendant l'écriture = token tronqué ; si le write-back a aussi échoué, 401 permanent après reboot | écrire token.tmp puis renameSync | S |
| F7 | Faible | mcp_ha/src/config.ts:34-42 | JSON.parse("null") passe le try, puis opts.log_level jette hors du catch | options.json corrompu = crash-loop s6 au lieu d'un fallback défauts | valider objet non-null après parse, sinon {} | S |
| F9 | Faible | mcp_ha/src/mcp/server.ts:15-32 + index.ts:109-118 | McpServer + 16 outils + schémas zod reconstruits à chaque POST | surcoût CPU et allocations par requête sur Pi | hoister les schémas zod au module, ne recréer que server/transport | S |
| F10 | Nit | mcp_ha/Dockerfile:28-29 | la sonde HEALTHCHECK lance un process node complet toutes les 60 s | ~200-400 ms CPU et pic ~40 Mo par sonde sur Pi | curl -sf (présent dans la base HA) | S |

### Axe G : documentation (9/10)

N/A : rendu en ligne (Pages, badge, Context7) non testé, audit disque uniquement. Tous les chiffres vérifiés conformes au code (250/100/15 Ko/16 outils/port/défauts/env vars/chaînes de log), miroir fr complet sans dérive factuelle.

| ID | Sévérité | Fichier:lignes | Problème | Impact | Correctif | Effort |
|----|----------|----------------|----------|--------|-----------|--------|
| G1 | Moyenne | docs/reference/architecture.md:88-89 + fr:88-89 | le diagramme de bootstrap dit encore « print the token in the add-on log » et « reads the token in the Configuration tab (or the log) », obsolète depuis 0.1.4 | contradiction inter pages, brouille le message sécurité | « print a masked prefix », supprimer « (or the log) », deux locales | S |
| G2 | Faible | docs/reference/logging.md:24 + fr:24 | exemple de log en version 0.1.2 | viole la règle chiffres = code de CONTRIBUTING | 0.1.4 ou placeholder X.Y.Z | S |
| G3 | Faible | docs/index.md:44 + fr:44 | « ajoutez .md à l'URL » est faux pour les pages /fr/ (ignoreFiles fr/** dans config.mts:24) | un lecteur fr obtient un 404 | préciser « pages anglaises uniquement » | S |
| G4 | Faible | mcp_ha/DOCS.md:23 + translations en/fr.yaml:19-23 | filter_reads décrit sans mentionner historique et logbook, pourtant filtrés (history.ts:44-46,136) | portée de l'option sous-documentée, incohérent avec le site | aligner sur « listings, détail, historique, logbook » | S |
| G5 | Faible | mcp_ha/CHANGELOG.md:3-30 | aucune date de sortie sur les entrées | impossible de corréler date d'installation et version en support | dates ISO (Keep a Changelog) | S |
| G6 | Nit | docs/reference/tools.md:84,92 + fr | `hours` documenté sans le minimum 0.25 imposé par zod | erreur de validation non annoncée | mentionner min 0.25 | S |
| G7 | Nit | CONTRIBUTING.md:61 | « the CI checks the first two » : le contrôle vit dans release.yaml (au tag), et config.ts VERSION n'est vérifié nulle part | contributeur cherche au mauvais endroit | corriger la phrase + lien E4 | S |

## 3. Backlog priorisé

| Ordre | ID | Sévérité | Effort | Impact |
|-------|----|----------|--------|--------|
| 1 | D1 | Élevée | S | advisory + rotation : seule action qui protège les installs existantes |
| 2 | D2 (=E2) | Élevée | S puis M | supprime le risque supply chain de la release (pin SHA immédiat, migration ensuite, issue #25) |
| 3 | C1 (=B1) | Élevée | S | plus aucun outil qui pend indéfiniment sur HTTP |
| 4 | C2 | Élevée | S | plus de connexion WS semi-ouverte qui neutralise tout l'add-on |
| 5 | F2 (=C3) | Élevée | M | ne plus figer les défauts de sécurité ni écraser la config utilisateur |
| 6 | A1 (=D4) | Élevée | S | moindre privilège Supervisor (test réel requis, issue #11) |
| 7 | E1 | Élevée | M | filet de tests sur la frontière d'auth |
| 8 | B4 | Moyenne | S | config validée, plus de crash obscur au boot (couvre F7) |
| 9 | F6 | Moyenne | S | écriture atomique du jeton |
| 10 | C4 (=B11) | Moyenne | S | fin des boucles auth_invalid |
| 11 | F4 | Moyenne | S | healthcheck qui reflète l'état réel, watchdog utile |
| 12 | F3 (=A3, B10) | Moyenne | S | arrêt gracieux |
| 13 | E3 (=B3) | Moyenne | S | tests typecheckés en CI |
| 14 | F5 (=A5, D7) | Moyenne | S | builds reproductibles, plus de risque musl |
| 15 | C7 (=E6) | Moyenne | S | write-back fiable au boot de HA |
| 16 | G1 | Moyenne | S | doc sécurité cohérente |
| 17 | D3 | Moyenne | M | longueur minimale de jeton + frein anti brute force |
| 18 | D5 (=C6) | Moyenne | S | filter_reads sans contournement |
| 19 | D6 + D9 | Moyenne | S | permissions CI au plus juste |
| 20 | B2 | Élevée | M | frontière HA validée (chantier, voir refactors) |
| 21 | F1 | Élevée | M | latence et RAM sur Pi (chantier, voir refactors) |
| 22 | C5 (=F8) | Moyenne | S | cycle de vie WS sans course ni fuite |
| 23 | B5 (=C9) | Moyenne | S | registres sans rafales ni données périmées |
| 24 | E7 | Moyenne | S | site testé avant merge |
| 25 | E4 + G7 | Moyenne | S | garde de version complète |
| 26 | B6, B7, B9 | Moyenne | S | erreurs diagnosticables |
| 27 | E5 | Moyenne | M | résilience WS testée |
| 28 | G2, G3, G4, G5 | Faible | S | exactitude doc |
| 29 | A2 | Moyenne | M | AppArmor |
| 30 | E8, D10, E9, B13, D8, B8, B12, F9, A4 | Faible | S-M | durcissements et hygiène |

## 4. Quick wins (< 1h chacun)

- C1 : AbortSignal.timeout sur les 4 méthodes de HaHttp.
- C2 : timer de handshake qui terminate() sous 15 s.
- D2 : épingler builder par SHA (la migration complète reste l'issue #25).
- F6 : tmp + renameSync pour /data/token.
- F7 + B4 : validation zod de options.json (un seul schéma couvre les deux).
- C4 : compteur d'auth_invalid avec backoff long.
- F4 : /health en 503 si WS down depuis N minutes.
- F3 : attendre httpServer.close() avant exit.
- E3 : script typecheck incluant les tests + step CI.
- E12, D9, D6 : concurrency et permissions des workflows.
- G1, G2, G3, G4, G6, G7, A7, A8 : corrections documentaires pures.
- A4 : startup: application.
- E4 : grep de VERSION dans la garde de release.

## 5. Refactors structurants

1. **Frontière HA typée et validée** (B2 + B4 + C1 + B6). Un module unique de schémas zod pour les payloads HA entrants (states, registres, services), `send<T>` qui parse, timeouts et retry uniformes sur HTTP. Coût : M (2-3 jours). Bénéfice : les évolutions de l'API HA deviennent des erreurs claires au lieu de TypeError aléatoires chez l'utilisateur ; prérequis sain avant d'ajouter les outils d'écriture v0.2. Le risque principal du projet est là : un serveur dont le contrat amont n'est pas le sien.

2. **Cache d'états vivant** (F1 + B5 + C9 + F9). Remplacer le get_states par appel par un cache alimenté par subscribe_entities (ou à défaut un TTL court), invalidé à la reconnexion, plus hoisting des schémas d'outils. Coût : M-L (3-5 jours, tests de reconnexion inclus). Bénéfice : latence divisée par 5 à 10 sur Pi, RAM stable, et c'est la fondation déjà prévue pour les resources MCP et le streaming (issue #15). À faire avant que la base utilisateurs grossisse.

3. **Harnais de test de la frontière réseau** (E1 + E5 + C7/E6). Extraire le handler HTTP de main() en fonction testable, tests d'intégration auth/transport (401, 405, body cap, JSON invalide, -32700 vs -32603), résilience WS sous fake timers (backoff, auth_invalid, handshake), persistGeneratedToken moqué. Coût : M (2 jours). Bénéfice : les deux couches actuellement à 0 % de couverture sont précisément celles qui portent l'authentification et la disponibilité.

## 6. Angles morts (à vérifier en conditions réelles)

- Comportement mémoire et latence réels sur aarch64 (Pi 4/5) avec une grosse flotte d'entités : F1 est une projection statique, pas une mesure.
- `hassio_role: default` suffit-il vraiment pour /addons, /addons/self/info et /addons/self/options ? À tester sur une instance réelle (issue #11) ; la doc Supervisor ne fait pas foi sur le middleware effectif.
- Le write-back d'options pendant la fenêtre de boot de HA (Supervisor en 503) et après restauration d'un backup dont options.json et /data/token divergent.
- Compatibilité musl du binaire node copié, sur les deux arches, au prochain rebuild où node:26-alpine changera de base Alpine (F5) : seul un build réel le prouve.
- Robustesse du format compressé s/lu de history/history_during_period sur les versions HA futures : le format n'est pas contractuel, seule une instance à jour le confirme.
- Brute force réel sur /mcp depuis le LAN (D3) : le coût pratique dépend du keep-alive et du parallélisme acceptés par le serveur Node, à mesurer.
- Rendu effectif de Pages, du badge Release et de l'indexation Context7 (G, N/A en ligne).
