# ── Stage 1: Build React app ───────────────────────────
FROM node:20-alpine AS builder

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

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

RUN mkdir -p /web-builds /covers && \
    chown -R vnm:vnm /usr/share/nginx/html /web-builds /covers && \
    chown -R vnm:vnm /var/cache/nginx /var/log/nginx && \
    touch /var/run/nginx.pid && chown vnm:vnm /var/run/nginx.pid

USER vnm

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
