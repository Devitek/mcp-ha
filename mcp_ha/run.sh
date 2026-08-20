#!/usr/bin/with-contenv bashio
# Entrypoint de l'add-on. La configuration est lue par le serveur Node
# directement dans /data/options.json, SUPERVISOR_TOKEN est injecté par le
# Supervisor. On garde bashio pour des logs propres dans l'interface HA.

bashio::log.info "Démarrage du serveur MCP Home Assistant sur le port 9583..."

if bashio::config.true 'allow_write'; then
  bashio::log.warning "allow_write est actif : l'outil ha_call_service est exposé aux clients MCP."
else
  bashio::log.info "Mode lecture seule (allow_write: false)."
fi

exec node /app/dist/index.js
