# Pinned by digest (audit F5/D7): the node binary is copied into the HA base
# image below, and an unpinned tag could silently switch to a musl version
# newer than the base. Digest resolved from node:26-alpine on 2026-08-21.
# Note: Node 26 is the Current release line, not LTS.
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.24

# Build stage: TypeScript compilation with the dev dependencies
FROM node:26-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Final image: Home Assistant base (s6 + bashio) plus the bare Node runtime.
# The node binary comes from the official image rather than the apk package:
# Alpine does not track the latest Node release line, copying guarantees the
# wanted version. Only system dependency required: libstdc++.
FROM ${BUILD_FROM}
ENV NODE_ENV=production
# Dedicated unprivileged user (audit D8): run.sh drops to it after fixing
# /data ownership, so an RCE in a dependency does not mean container root.
RUN apk add --no-cache libstdc++ && adduser -S -D -H mcpha
COPY --from=build /usr/local/bin/node /usr/local/bin/node
# Fails the BUILD (not the runtime) if the copied binary is incompatible with
# the base image musl (audit F5).
RUN /usr/local/bin/node --version
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Inlined by the ingress page header (data URI, #136 follow-up).
COPY icon.png ./icon.png
COPY run.sh /run.sh
RUN chmod a+x /run.sh

# Container health: the add-on linter mandates HEALTHCHECK over the obsolete
# watchdog option of config.yaml. /health answers 503 once the Home
# Assistant connection has been down for several minutes. curl ships with
# the HA base image and is far cheaper than spawning node every probe
# (audit F10); the port follows MCP_PORT (audit A9).
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -sf "http://127.0.0.1:${MCP_PORT:-9583}/health" || exit 1

CMD [ "/run.sh" ]
