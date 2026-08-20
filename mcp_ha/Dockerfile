ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.24

# Étape de build : compilation TypeScript avec les dépendances de dev
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Image finale : base Home Assistant (s6 + bashio) et runtime Node seul.
# Le binaire node vient de l'image officielle node:26-alpine plutôt que du
# paquet apk : Alpine ne suit pas la dernière LTS de Node, la copie garantit
# la version voulue. Seule dépendance système requise : libstdc++.
FROM ${BUILD_FROM}
ENV NODE_ENV=production
RUN apk add --no-cache libstdc++
COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY run.sh /run.sh
RUN chmod a+x /run.sh

# Santé du conteneur : le linter add-on impose HEALTHCHECK plutôt que
# l'option watchdog de config.yaml, désormais obsolète.
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9583/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD [ "/run.sh" ]
