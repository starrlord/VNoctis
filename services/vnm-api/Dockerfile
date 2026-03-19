# ── Stage 1: Build ─────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY prisma ./prisma/
RUN npx prisma generate

COPY . .

# ── Stage 2: Production ───────────────────────────────
FROM node:24-alpine

# Install gosu for user switching
# Install extraction tools: unzip (ZIP), bzip2+tar (tar.bz2), 7zip (RAR)
RUN ALPINE_VER=$(cat /etc/alpine-release | cut -d. -f1,2) \
 && apk add --no-cache gosu unzip bzip2 tar python3 py3-pip \
 && apk add --no-cache --repository=https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VER}/community 7zip \
 && pip3 install --no-cache-dir --break-system-packages unrpa

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/templates ./templates

# Create directories that may be used as mount points
RUN mkdir -p /data /data/logs /covers /web-builds /games

EXPOSE 3001

# Use entrypoint script for PUID/PGID support
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN sed -i 's/\r$//' /docker-entrypoint.sh && chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
