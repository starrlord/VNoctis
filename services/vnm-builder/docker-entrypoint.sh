#!/bin/sh
set -e

PUID=${PUID:-0}
PGID=${PGID:-0}

# ── Ren'Py SDK auto-download ──────────────────────────────
# Downloads and extracts the Ren'Py SDK + web platform support
# into the /renpy-sdk volume on first start. Subsequent starts
# skip download if renpy.sh already exists.

RENPY_VERSION="${RENPY_SDK_VERSION:-8.5.2}"
SDK_URL="https://www.renpy.org/dl/${RENPY_VERSION}/renpy-${RENPY_VERSION}-sdk.tar.bz2"
WEB_URL="https://www.renpy.org/dl/${RENPY_VERSION}/renpy-${RENPY_VERSION}-web.zip"

# ── Download and extract SDK if not present ────────────────
if [ ! -f /renpy-sdk/renpy.sh ]; then
    echo "[vnm-builder] Ren'Py SDK not found at /renpy-sdk — downloading v${RENPY_VERSION}..."
    echo "[vnm-builder] SDK URL: ${SDK_URL}"

    TMPDIR=$(mktemp -d)
    trap 'rm -rf "${TMPDIR}"' EXIT

    curl -fSL --progress-bar -o "${TMPDIR}/sdk.tar.bz2" "${SDK_URL}"
    echo "[vnm-builder] Extracting SDK to /renpy-sdk/ ..."

    # Extract with --strip-components=1 so contents go flat into /renpy-sdk/
    tar -xjf "${TMPDIR}/sdk.tar.bz2" -C /renpy-sdk --strip-components=1

    rm -f "${TMPDIR}/sdk.tar.bz2"
    echo "[vnm-builder] ✅ Ren'Py SDK v${RENPY_VERSION} installed successfully"
else
    echo "[vnm-builder] Ren'Py SDK already present at /renpy-sdk"
fi

# ── Download and extract web platform if not present ───────
if [ ! -d /renpy-sdk/web ] || [ -z "$(ls -A /renpy-sdk/web 2>/dev/null)" ]; then
    echo "[vnm-builder] Ren'Py web platform not found — downloading v${RENPY_VERSION}..."
    echo "[vnm-builder] Web URL: ${WEB_URL}"

    TMPDIR=$(mktemp -d)

    curl -fSL --progress-bar -o "${TMPDIR}/web.zip" "${WEB_URL}"
    echo "[vnm-builder] Extracting web platform to /renpy-sdk/web/ ..."

    # The zip creates renpy-X.Y.Z-web/ with contents inside.
    # Extract to temp dir, then move contents to /renpy-sdk/web/
    unzip -q "${TMPDIR}/web.zip" -d "${TMPDIR}"
    rm -f "${TMPDIR}/web.zip"

    mkdir -p /renpy-sdk/web

    # Move contents from the extracted directory into /renpy-sdk/web/
    # The zip has a single top-level dir like renpy-8.5.2-web/
    EXTRACTED_DIR=$(find "${TMPDIR}" -mindepth 1 -maxdepth 1 -type d | head -1)
    if [ -n "${EXTRACTED_DIR}" ]; then
        cp -a "${EXTRACTED_DIR}/." /renpy-sdk/web/
    else
        # Fallback: files extracted flat (no wrapper directory)
        cp -a "${TMPDIR}/." /renpy-sdk/web/
    fi

    rm -rf "${TMPDIR}"
    echo "[vnm-builder] ✅ Ren'Py web platform v${RENPY_VERSION} installed successfully"
else
    echo "[vnm-builder] Ren'Py web platform already present at /renpy-sdk/web"
fi

# ── Copy custom web presplash image ───────────────────────
# Replaces the default Ren'Py loading screen with a custom branded one.
if [ -f /app/web-presplash.webp ] && [ -d /renpy-sdk/web ]; then
    cp /app/web-presplash.webp /renpy-sdk/web/web-presplash.webp
    echo "[vnm-builder] Custom web-presplash.webp applied"
fi

# ── Ensure SDK launcher is executable ──────────────────────
if [ -f /renpy-sdk/renpy.sh ]; then
    chmod +x /renpy-sdk/renpy.sh
fi

# ── Drop privileges if requested ──────────────────────────
if [ "$(id -u)" = "0" ] && [ "$PUID" != "0" ]; then
    # Ensure writable directories exist
    mkdir -p /web-builds/logs

    # Set ownership using numeric IDs
    chown -R "$PUID:$PGID" /web-builds

    # Use gosu with numeric UID:GID
    exec gosu "$PUID:$PGID" "$@"
fi

exec "$@"
