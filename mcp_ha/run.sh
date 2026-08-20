#!/usr/bin/with-contenv bashio
# Add-on entrypoint. The Node server reads its configuration directly from
# /data/options.json, SUPERVISOR_TOKEN is injected by the Supervisor. bashio
# is only used here for clean startup logs in the HA interface.

bashio::log.level "$(bashio::config 'log_level')"
bashio::log.info "Starting the MCP Home Assistant server on port 9583..."

if bashio::config.true 'allow_write'; then
  bashio::log.warning "allow_write is enabled: ha_call_service is exposed to MCP clients."
else
  bashio::log.info "Read-only mode (allow_write: false)."
fi

exec node /app/dist/index.js
