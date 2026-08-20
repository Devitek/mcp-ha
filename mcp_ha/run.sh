#!/usr/bin/with-contenv bashio
# Add-on entrypoint. The Node server reads its configuration directly from
# /data/options.json, SUPERVISOR_TOKEN is injected by the Supervisor. bashio
# is only used here for clean startup logs in the HA interface.
#
# bashio::config queries the Supervisor API, which does not exist when the
# image runs standalone (dev, CI smoke): every lookup is therefore guarded so
# a missing Supervisor never kills the entrypoint.

declare level
level=$(bashio::config 'log_level' 2>/dev/null || true)
if bashio::var.has_value "${level}"; then
  bashio::log.level "${level}"
fi

bashio::log.info "Starting the MCP Home Assistant server on port 9583..."

if bashio::config.true 'allow_write' 2>/dev/null; then
  bashio::log.warning "allow_write is enabled: ha_call_service is exposed to MCP clients."
else
  bashio::log.info "Read-only mode (allow_write: false)."
fi

# Drop privileges (audit D8): the server does not need root. /data is
# root-owned by the Supervisor mount, hand it to the service user first.
chown -R mcpha /data 2>/dev/null || true
exec s6-setuidgid mcpha node /app/dist/index.js
