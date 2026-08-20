ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.21

# Étape de build : compilation TypeScript avec les dépendances de dev
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Image finale : base Home Assistant (s6 + bashio) et runtime Node seul
FROM ${BUILD_FROM}
ENV NODE_ENV=production
RUN apk add --no-cache nodejs
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY run.sh /run.sh
RUN chmod a+x /run.sh
CMD [ "/run.sh" ]
