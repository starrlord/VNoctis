# ── Stage 1: Build React app ───────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 2: Serve with Nginx ─────────────────────────
FROM nginx:alpine

# Install curl for Docker healthcheck
RUN apk add --no-cache curl

RUN addgroup -S vnm && adduser -S vnm -G vnm

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# The runtime user must be able to read this even with restrictive host permissions.
COPY --chmod=0644 nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

# Give each bridge version its own URL, including in Ren'Py service-worker caches.
RUN save_sync_version="$(sha256sum /usr/share/nginx/html/save-sync.js | cut -d ' ' -f 1)" && \
    sed -i "s|VNM_SAVE_SYNC_VERSION|${save_sync_version}|g" /etc/nginx/conf.d/default.conf

RUN mkdir -p /web-builds /covers && \
    chown -R vnm:vnm /usr/share/nginx/html /web-builds /covers && \
    chmod -R a+rX /usr/share/nginx/html && \
    chown -R vnm:vnm /var/cache/nginx /var/log/nginx && \
    touch /var/run/nginx.pid && chown vnm:vnm /var/run/nginx.pid

USER vnm

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
