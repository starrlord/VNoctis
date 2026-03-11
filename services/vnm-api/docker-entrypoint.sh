#!/bin/sh
set -e

PUID=${PUID:-0}
PGID=${PGID:-0}

if [ "$(id -u)" = "0" ] && [ "$PUID" != "0" ]; then
    # Ensure writable directories exist
    mkdir -p /data /covers /screenshots /games /web-builds

    # Set ownership using numeric IDs (no user creation needed)
    # Use -R for small dirs, top-level only for large dirs (games/web-builds)
    chown -R "$PUID:$PGID" /data /covers /screenshots
    chown "$PUID:$PGID" /games /web-builds

    # Ensure game subdirectories are writable (for delete support)
    find /games -maxdepth 1 -mindepth 1 -type d -exec chown -R "$PUID:$PGID" {} + 2>/dev/null || true
    find /web-builds -maxdepth 1 -mindepth 1 -type d -exec chown -R "$PUID:$PGID" {} + 2>/dev/null || true

    # Use gosu with numeric UID:GID — no passwd entry required
    exec gosu "$PUID:$PGID" "$@"
fi

# Running as root with PUID=0, or already non-root
exec "$@"
