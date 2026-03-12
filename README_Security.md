# Security Audit — VNoctis Manager

**Audit date:** 2026-03-12 (re-audited after Node.js 24 upgrade + logging improvements)
**Scope:** Full codebase review — authentication, session management, input validation, Docker configuration, API security, error handling

---

## Scorecard vs. Common AI-Generated Vulnerabilities

| Common AI Pitfall | Your App | Verdict |
|---|---|---|
| Hardcoded JWT secret | Auto-generated with `randomBytes(64)`, persisted to `/data/.jwt-secret` with `0o600` perms | **PASS** |
| Cookie HttpOnly/Secure/SameSite missing | N/A — uses `localStorage` + `Authorization: Bearer` headers, not cookies | **See Finding #1** |
| Password hashed with SHA-256 instead of bcrypt | N/A — env-var sourced, not DB-stored; uses timing-safe comparison | **See Finding #2** |
| No rate limiting on login | `@fastify/rate-limit` — 5 attempts per minute on `POST /auth/login` | **PASS** |
| Reset token never expires | No password reset flow exists | **PASS** |

---

## Findings

### Finding #1 — Token stored in localStorage (Low–Medium)

**File:** `services/vnm-ui/src/hooks/useAuth.jsx` lines 9, 51

```js
const TOKEN_KEY = 'vnm-token';
// ...
localStorage.setItem(TOKEN_KEY, data.token);
```

**Risk:** `localStorage` is accessible to any JavaScript running on the same origin. If an XSS vulnerability ever exists (even from a third-party library), the attacker can steal the JWT with `localStorage.getItem('vnm-token')`.

**Mitigation context:** For a self-hosted single-user app on a private network, this is low risk. The alternative (HttpOnly cookies) would require a cookie-based auth flow with CSRF protection, which adds complexity. The current approach is the standard SPA pattern.

**Recommendation:** Acceptable for the current threat model. If ever exposed to the internet, consider switching to HttpOnly cookie-based sessions.

---

### Finding #2 — Plaintext password comparison (Low — Acceptable)

**File:** `services/vnm-api/src/routes/auth.js` lines 40–51

```js
const passBuf = Buffer.from(String(password));
const expectedPassBuf = Buffer.from(expectedPass);
const passwordMatch =
  passBuf.length === expectedPassBuf.length &&
  timingSafeEqual(passBuf, expectedPassBuf);
```

**What is done right:** Uses `timingSafeEqual` for constant-time comparison — this prevents timing attacks. The password lives only in an environment variable, never a database.

**Context:** The password exists as a runtime environment variable and is compared directly. This is the standard pattern for single-user self-hosted apps (e.g., Portainer, Mealie, and many other Docker apps handle admin passwords the same way).

**Recommendation:** No change needed for this use case.

---

### Finding #3 — Internal API endpoints unauthenticated (Medium)

**File:** `services/vnm-api/src/index.js` lines 163–171

```js
if (
  url.startsWith('/api/v1/health') ||
  url.startsWith('/api/v1/auth/') ||
  url.startsWith('/api/v1/internal/') ||  // ← No auth
  url.startsWith('/api/v1/covers/') ||
  /^\/api\/v1\/build\/[^/]+\/log/.test(url)
) {
  return; // Skip auth
}
```

The following endpoints in `services/vnm-api/src/routes/internal.js` are unauthenticated:
- `POST /api/v1/internal/build/:jobId/status` — builder status callbacks
- `POST /api/v1/internal/build/:jobId/log` — builder log line forwarding
- `POST /api/v1/internal/client-error` — **[NEW]** client-side error reporting from the UI's ErrorBoundary

These are intended for inter-service and client-error communication, but they're reachable through the nginx reverse proxy at `/api/internal/...`.

**Risk:** An attacker who can reach the nginx front-end could:
- Forge build status callbacks (`POST /api/v1/internal/build/:jobId/status` with `{ status: "done" }`)
- Inject arbitrary log lines (`POST /api/v1/internal/build/:jobId/log`)
- Change any game's `buildStatus` to `built`, `failed`, etc.
- Inject fake client error reports (see Finding #12)

**Mitigation added (partial):** The new `/internal/client-error` endpoint is rate-limited to 100 requests/minute via `@fastify/rate-limit` with a 64 KB body cap, and all fields are truncated before logging. The builder callback endpoints remain unprotected.

**Recommendation:** Add a shared secret header between vnm-api and vnm-builder for builder callbacks:
```js
// In internal.js onRequest hook:
if (request.headers['x-internal-secret'] !== process.env.INTERNAL_SECRET) {
  return reply.code(403).send({ code: 'FORBIDDEN' });
}
```
Or block `/api/v1/internal/build/` at the nginx layer so builder callbacks are only reachable on the Docker internal network, while keeping `/api/v1/internal/client-error` open for the browser.

---

### Finding #4 — Build log SSE endpoint unauthenticated (Low)

**File:** `services/vnm-api/src/index.js` line 148

```js
/^\/api\/v1\/build\/[^/]+\/log/.test(url)  // Skips auth
```

The SSE build log endpoint at `services/vnm-api/src/routes/build.js` line 194 is unauthenticated (comment says "EventSource cannot attach Authorization headers"). This leaks build log content to anyone who can guess a job ID.

**Risk:** Low — job IDs are UUIDs, and the logs contain only build output (no secrets). But it's still information disclosure.

**Recommendation:** Pass the token as a query parameter (`?token=...`) and verify it manually in the SSE route, since `EventSource` doesn't support custom headers. Many apps do this.

---

### Finding #5 — Cover images endpoint unauthenticated (Low)

**File:** `services/vnm-api/src/index.js` line 147, `services/vnm-api/src/routes/covers.js` line 27

Cover images are served without authentication. Game IDs are 32-character hex strings (SHA-256 truncated), so they're not trivially guessable, but they're not secret either (they appear in API responses).

**Risk:** Low — this is standard for image assets. The nginx config at `services/vnm-ui/nginx.conf` also serves `/covers/`, `/screenshots/`, and `/web-builds/` as static files without auth.

**Recommendation:** Acceptable. These are image files, not sensitive data.

---

### Finding #6 — Shell injection risk in import/extraction (Medium) — ✅ RESOLVED

**Files changed:**
- `services/vnm-api/src/routes/import.js` — 8 calls (unzip, tar, 7z, chmod)
- `services/vnm-api/src/routes/library.js` — 1 call (chmod)
- `services/vnm-api/src/services/rpaExtractor.js` — 1 call (unrpa)
- `services/vnm-api/src/services/scanner.js` — 1 call (unzip)

**Original issue:** 11 places used `execAsync()` (`child_process.exec`) which spawns `/bin/sh -c "..."`, making shell metacharacters like `` ` ``, `$()`, `!`, `;`, and `\n` in file paths potentially dangerous.

**Fix applied:** All 11 calls replaced with `execFileAsync()` (`child_process.execFile`) which invokes binaries directly with an argv array — no shell, so metacharacters in paths are treated as literal characters.

```js
// Before (shell — vulnerable)
await execAsync(`unzip -o "${archivePath}" -d "${gamesPath}"`);

// After (no shell — safe)
await execFileAsync('unzip', ['-o', archivePath, '-d', gamesPath]);
```

**Note:** The `execSync('npx prisma migrate deploy')` call in `services/vnm-api/src/index.js` was intentionally left unchanged — it's a hardcoded command with zero user input.

---

### Finding #7 — CORS allows all origins (Low — Intentional)

**File:** `services/vnm-api/src/index.js` line 103

```js
await fastify.register(cors, {
  origin: true, // Allow all origins (single-user self-hosted)
});
```

**Risk:** With Bearer token auth (not cookies), open CORS is much less dangerous than it would be with cookie-based auth. An attacker's page can't steal the token from localStorage cross-origin. The comment correctly notes this is intentional for self-hosted use.

**Recommendation:** Acceptable for the current threat model.

---

### Finding #8 — No server-side token revocation (Low)

**File:** `services/vnm-api/src/routes/auth.js` line 79

```js
fastify.post('/auth/logout', async (request, reply) => {
  reply.code(204).send(); // Client-side only
});
```

The comment says "Placeholder for future server-side token invalidation." JWTs are stateless — once issued, they're valid until expiry (30 days by default). The `logout` endpoint only discards the token client-side.

**Risk:** Low — if a token is leaked, it remains valid for up to 30 days. However, the single-user nature means there's no horizontal privilege escalation risk.

**Recommendation:** For a single-user app, this is acceptable. If defense in depth is desired, rotate `jwtSecret` on password change (invalidating all existing tokens), or implement a token blacklist.

---

### Finding #9 — vnm-builder runs as root (Low — Intentional)

**File:** `compose.yml` line 67

```yaml
environment:
  PUID: "0"
  PGID: "0"
```

The builder container runs as root. The comment explains this is intentional because the Ren'Py SDK scripts may have restrictive permissions. The container has `mem_limit: 16g` and `cpus: 8` resource caps.

**Risk:** If an attacker could execute arbitrary code inside the builder container (e.g., through a malicious Ren'Py script), they'd have root inside the container. Docker's namespace isolation still applies, but the blast radius within the container is larger.

**Recommendation:** Acceptable given the constraint. The builder has access to `/games` (rw), `/renpy-sdk` (rw), `/web-builds`, and `/data/logs` (rw, shared log directory) — no access to `/data/vnm.db` (database) or `/data/.jwt-secret`.

---

### Finding #10 — SSRF via import-url (Low–Medium)

**File:** `services/vnm-api/src/routes/import.js` line 413

```js
const response = await fetch(url, {
  headers: { 'User-Agent': 'VN-Manager/1.0' },
  redirect: 'follow',
});
```

The `POST /library/import-url` endpoint accepts a user-supplied URL and makes an HTTP request from the server. It validates protocol (`http:` / `https:` only) but doesn't block internal network ranges.

**Risk:** An authenticated user could request `http://vnm-builder:3002/build` or `http://169.254.169.254/latest/meta-data/` (cloud metadata). Since the app is self-hosted and single-user (the user is the admin), this is only a risk if the admin account is compromised.

**Recommendation:** If hardening is desired, block RFC 1918 / link-local / loopback ranges:
```js
const blockedRanges = ['127.', '10.', '172.16.', '192.168.', '169.254.', '0.', 'localhost'];
if (blockedRanges.some(r => parsedUrl.hostname.startsWith(r))) {
  return reply.code(400).send({ code: 'BLOCKED_URL' });
}
```

---

### Finding #11 — Nginx missing security headers (Low)

**File:** `services/vnm-ui/nginx.conf`

The nginx config doesn't set common security headers. The `/web-builds/` location correctly sets `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` for SharedArrayBuffer (required by WebAssembly).

**Recommendation:** Add a `server`-level block:
```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

---

### Finding #12 — Client error endpoint allows log injection (Low)

**File:** `services/vnm-api/src/routes/internal.js`

```js
fastify.post('/internal/client-error', {
  config: { rateLimit: { max: 100, timeWindow: '1 minute' } },
  bodyLimit: 65536,
}, async (request, reply) => { ... });
```

The `POST /api/v1/internal/client-error` endpoint accepts error reports from the UI's `ErrorBoundary` and logs them to the persistent log file. It's unauthenticated (part of the `/api/v1/internal/` prefix).

**Risk:** An attacker who can reach the nginx front-end could inject fake error entries into `vnm-api.log` at a rate of 100/minute. All fields are truncated (`message`: 1KB, `stack`: 4KB, `componentStack`: 2KB, `url`/`userAgent`: 256 bytes each), so individual payloads are bounded.

**Mitigations in place:**
- Rate limited to 100 requests per minute via `@fastify/rate-limit`
- Body capped at 64 KB
- All string fields truncated before logging
- Log entries are tagged with `source: "client"` so they can be filtered/identified
- Logs are structured JSON (not plaintext), so injected content can't break line parsing

**Recommendation:** Acceptable for the current threat model. The rate limit and field truncation prevent meaningful abuse. If hardening is desired, add auth-token-in-body or move to a separate authenticated endpoint.

---

## Summary Matrix

| # | Finding | Severity | Action Needed |
|---|---------|----------|---------------|
| 1 | Token in localStorage | Low | Acceptable for self-hosted SPA |
| 2 | Plaintext password comparison | Low | Acceptable — env var only, timing-safe |
| **3** | **Internal endpoints unauthenticated** | **Medium** | **Add shared secret for builder callbacks, or nginx block** |
| 4 | Build log SSE unauthenticated | Low | Optional: token-in-query-param |
| 5 | Cover images unauthenticated | Low | Acceptable for images |
| ~~6~~ | ~~Shell injection risk in exec~~ | ~~Medium~~ | ✅ **Resolved** — switched to `execFileAsync` (no shell) |
| 7 | CORS allows all origins | Low | Acceptable with Bearer tokens |
| 8 | No server-side token revocation | Low | Optional: rotate secret on change |
| 9 | Builder runs as root | Low | Intentional, isolated volumes (+`/data/logs` shared) |
| **10** | **SSRF via import-url** | **Low–Medium** | **Optional: block internal ranges** |
| 11 | Nginx missing security headers | Low | Add standard headers |
| 12 | Client error endpoint log injection | Low | Rate-limited + field-truncated; acceptable |

---

## What's Already Done Right

- **JWT secret:** Cryptographically random, auto-generated, persisted with restrictive file permissions (`0o600`)
- **Timing-safe comparison** for credentials (`timingSafeEqual`)
- **Rate limiting** on login (5 per minute via `@fastify/rate-limit`) and on client error reporting (100 per minute)
- **Login failure logging** with IP address
- **JWT expiration** enforced (configurable TTL, default 30 days)
- **Password required at startup** — hard fail with `process.exit(1)` if missing
- **Docker network isolation** — internal bridge network, only nginx exposes a port
- **Docker log rotation** — all containers configured with `json-file` driver, `max-size: 10m`, `max-file: 3` to prevent disk exhaustion
- **Resource limits** on the builder container (`mem_limit: 16g`, `cpus: 8`)
- **Multi-stage Docker builds** (smaller attack surface, no dev dependencies in production)
- **Non-root nginx container** (vnm-ui runs as `USER vnm`)
- **Input validation** with whitelisted editable fields in PATCH endpoints
- **Global error handler** that doesn't leak stack traces
- **Unhandled error safety nets** — `process.on('unhandledRejection')` and `process.on('uncaughtException')` catch and log errors that would otherwise crash silently
- **Persistent structured logging** — both vnm-api and vnm-builder write JSON logs to `/data/logs/` for post-mortem analysis, in addition to stdout for Docker
- **Client-side error forwarding** — React `ErrorBoundary` reports errors to the API with rate limiting and field truncation; entries tagged with `source: "client"` for easy filtering
- **Sanitised folder names** on import (strips path traversal and dangerous characters)
- **Shell-free command execution** — all external commands (`unzip`, `tar`, `7z`, `chmod`, `unrpa`) use `execFile` (no shell) to prevent injection
- **Game ID validation** — 32-character hex string check on all ID parameters
- **Graceful shutdown** with proper resource cleanup
