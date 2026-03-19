# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VNoctis Manager is a self-hosted Docker-based web application for managing, building, and playing Ren'Py visual novels in the browser. It provides a Netflix-style library interface with VNDB/Steam metadata enrichment and one-click WebAssembly builds.

## Architecture

Three Docker services communicate over an internal bridge network:

```
vnm-ui (nginx:80) → vnm-api (fastify:3001) → vnm-builder (fastapi:3002)
```

| Service | Stack | Purpose |
|---------|-------|---------|
| **vnm-api** | Node.js 24, Fastify 5, Prisma, SQLite | REST API, game scanning, metadata enrichment, build orchestration |
| **vnm-builder** | Python 3.11, FastAPI | Ren'Py SDK web_build compilation, image compression |
| **vnm-ui** | React 19, Vite 6, Tailwind CSS v4, Nginx | SPA frontend |

## Development Commands

### vnm-api (Node.js backend)
```bash
cd services/vnm-api
npm install
npx prisma generate
npm run dev          # Starts with --watch for hot reload
```

### vnm-ui (React frontend)
```bash
cd services/vnm-ui
npm install
npm run dev          # Vite dev server with HMR
npm run build        # Production build to dist/
```

**Note:** The Vite proxy forwards `/api` to `http://vnm-api:3001`. For local development without Docker, change the proxy target in `vite.config.js` to `http://localhost:3001`.

### vnm-builder (Python build service)
```bash
cd services/vnm-builder
pip install -r requirements.txt
python src/main.py
```

### Docker
```bash
docker compose up -d                              # Pre-built images
docker compose -f compose_local_build.yml up -d --build  # Build from source
```

### Database (Prisma)
```bash
cd services/vnm-api
npx prisma migrate dev      # Create migration
npx prisma generate         # Regenerate client
npx prisma migrate deploy   # Apply migrations (production)
```

## Key Files

- `compose.yml` / `compose_local_build.yml` - Docker orchestration
- `.env.example` - All configuration (copy to `.env`, set `VNM_ROOT` and `VNM_ADMIN_PASSWORD`)
- `services/vnm-api/prisma/schema.prisma` - Database schema (Game, User, UserFavorite, BuildJob, ScanJob)
- `services/vnm-api/src/index.js` - API entry point with auth middleware
- `services/vnm-builder/src/builder.py` - Ren'Py web_build logic

## Code Patterns

### API Routes (vnm-api)
Routes are in `services/vnm-api/src/routes/`. Admin-only endpoints check `request.user.role === 'admin'`. Auth middleware at `index.js:190-240` verifies JWT and fetches current role from database on every request.

### Services (vnm-api)
Business logic in `services/vnm-api/src/services/`:
- `scanner.js` - Directory scanning, game fingerprinting
- `enrichment.js` - VNDB/Steam metadata fetching orchestration
- `vndbClient.js` / `steamClient.js` - External API clients
- `buildOrchestrator.js` - Build queue management, SSE log streaming

### React Hooks (vnm-ui)
Custom hooks in `services/vnm-ui/src/hooks/`:
- `useAuth.jsx` - JWT token management, login/logout
- `useLibrary.js` - Game list fetching
- `useBuildLog.js` - SSE log streaming for builds

### External Commands
All shell commands use `execFile` (not `exec`) to prevent injection. See `services/vnm-api/src/routes/import.js` and `services/vnm-api/src/services/rpaExtractor.js`.

## Security Notes

See `README_Security.md` for the full audit. Key points:
- Passwords: bcrypt cost factor 12
- JWT: Auto-generated secret, persisted to `/data/.jwt-secret`
- Roles: `admin` / `viewer`, DB-verified on every request
- Internal endpoints (`/api/v1/internal/*`) are unauthenticated but should only be reachable on the Docker network
