# Security Audit — VNoctis Manager

**Audit date:** 2026-03-19 (re-audited after R2 modal/gallery player changes)
**Previous audits:** 2026-03-17 (multi-user feature), 2026-03-12 (Node.js 24 upgrade + logging), initial audit
**Scope:** Full codebase review — authentication, session management, input validation, Docker configuration, API security, error handling, multi-user role-based access control, static gallery security

---

## Scorecard vs. Common AI-Generated Vulnerabilities

| Common AI Pitfall | Your App | Verdict |
|---|---|---|
| Hardcoded JWT secret | Auto-generated with `randomBytes(64)`, persisted to `/data/.jwt-secret` with `0o600` perms | **PASS** |
| Cookie HttpOnly/Secure/SameSite missing | N/A — uses `localStorage` + `Authorization: Bearer` headers, not cookies | **See Finding #1** |
| Password hashed with SHA-256 instead of bcrypt | `bcrypt` with cost factor 12, stored in database; dummy hash on user-not-found prevents timing enumeration | **PASS** |
| No rate limiting on login | `@fastify/rate-limit` — 5 attempts per minute on `POST /auth/login` | **PASS** |
| Reset token never expires | No email-based reset flow; admin password reset is via authenticated endpoint or env var | **PASS** |
| No role separation | Two roles (`admin` / `viewer`) enforced in auth middleware with DB-verified role on every request | **PASS** |
| Admin can't be locked out | Cannot delete self, cannot demote last admin; `RESET_ADMIN_PASSWORD` env var for recovery | **PASS** |

---

## Findings

### Finding #1 — Token stored in localStorage (Low–Medium)

**File:** `services/vnm-ui/src/hooks/useAuth.jsx` lines 5, 51

```js
const TOKEN_KEY = 'vnm-token';
// ...
localStorage.setItem(TOKEN_KEY, data.token);
```

**Risk:** `localStorage` is accessible to any JavaScript running on the same origin. If an XSS vulnerability ever exists (even from a third-party library), the attacker can steal the JWT with `localStorage.getItem('vnm-token')`. With multi-user support, a stolen token could impersonate any user — including admins.

**Mitigation context:** For a self-hosted app on a private network, this is low risk. The alternative (HttpOnly cookies) would require a cookie-based auth flow with CSRF protection, which adds complexity. The current approach is the standard SPA pattern.

**Recommendation:** Acceptable for the current threat model. If ever exposed to the internet, consider switching to HttpOnly cookie-based sessions.

---

### Finding #2 — Plaintext password comparison — ✅ RESOLVED

**File:** `services/vnm-api/src/routes/auth.js`

**Previously:** Passwords were compared as plaintext environment variables using `timingSafeEqual`. While timing-safe, passwords were never hashed.

**Resolution:** Passwords are now hashed with **bcrypt cost factor 12** and stored in the database. The login flow uses `bcrypt.compare()`. A dummy hash (`DUMMY_HASH` constant on line 9) is compared when a user doesn't exist, preventing timing-based user enumeration. The `VNM_ADMIN_PASSWORD` env var is only used for the initial admin seed on first startup and explicit reset via `RESET_ADMIN_PASSWORD=true`.

---

### Finding #3 — Internal API endpoints unauthenticated (Medium)

**File:** `services/vnm-api/src/index.js` lines 190–197

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
- `POST /api/v1/internal/client-error` — client-side error reporting from the UI's ErrorBoundary

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

**File:** `services/vnm-api/src/index.js` line 195

```js
/^\/api\/v1\/build\/[^/]+\/log/.test(url)  // Skips auth
```

The SSE build log endpoint at `services/vnm-api/src/routes/build.js` is unauthenticated (comment says "EventSource cannot attach Authorization headers"). This leaks build log content to anyone who can guess a job ID.

**Risk:** Low — job IDs are UUIDs, and the logs contain only build output (no secrets). But it's still information disclosure.

**Recommendation:** Pass the token as a query parameter (`?token=...`) and verify it manually in the SSE route, since `EventSource` doesn't support custom headers. Many apps do this.

---

### Finding #5 — Cover images endpoint unauthenticated (Low)

**File:** `services/vnm-api/src/index.js` line 194, `services/vnm-api/src/routes/covers.js`

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

**File:** `services/vnm-api/src/index.js`

```js
await fastify.register(cors, {
  origin: true, // Allow all origins (self-hosted)
});
```

**Risk:** With Bearer token auth (not cookies), open CORS is much less dangerous than it would be with cookie-based auth. An attacker's page can't steal the token from localStorage cross-origin.

**Recommendation:** Acceptable for the current threat model.

---

### Finding #8 — No server-side token revocation (Low–Medium)

**File:** `services/vnm-api/src/routes/auth.js` line 89

```js
fastify.post('/auth/logout', async (request, reply) => {
  reply.code(204).send(); // Client-side only
});
```

JWTs are stateless — once issued, they're valid until expiry (30 days by default). The `logout` endpoint only discards the token client-side.

**Risk:** Low–Medium with multi-user. If a token is leaked, it remains valid for up to 30 days. However, the impact of Finding #13 (stale roles) has been **resolved** — the auth middleware now verifies users against the database on every request, so deleted users and role changes take effect immediately (see Finding #13).

Remaining risk: a user who logs out still has a technically valid token until it expires (cannot be server-side revoked). Since the app is self-hosted and the token must be stolen from `localStorage` (same-origin only), this is acceptable.

**Recommendation:** Acceptable for the current threat model. If defense in depth is desired, implement a token blacklist or rotate `jwtSecret` on admin action.

---

### Finding #9 — vnm-builder runs as root (Low — Intentional)

**File:** `compose.yml`

```yaml
environment:
  PUID: "0"
  PGID: "0"
```

The builder container runs as root. The comment explains this is intentional because the Ren'Py SDK scripts may have restrictive permissions. The container has `mem_limit: 16g` and `cpus: 8` resource caps.

**Risk:** If an attacker could execute arbitrary code inside the builder container (e.g., through a malicious Ren'Py script), they'd have root inside the container. Docker's namespace isolation still applies, but the blast radius within the container is larger.

**Recommendation:** Acceptable given the constraint. The builder has access to `/games` (rw), `/renpy-sdk` (rw), `/web-builds`, and `/data/logs` (rw, shared log directory) — no access to `/data/vnm.db` (database) or `/data/.jwt-secret`.

---

### Finding #10 — SSRF via import-url (Low)

**File:** `services/vnm-api/src/routes/import.js`

```js
const response = await fetch(url, {
  headers: { 'User-Agent': 'VN-Manager/1.0' },
  redirect: 'follow',
});
```

The `POST /library/import-url` endpoint accepts a user-supplied URL and makes an HTTP request from the server. It validates protocol (`http:` / `https:` only) but doesn't block internal network ranges.

**Risk:** Previously Low–Medium when any authenticated user could trigger it. **Now reduced to Low** — the import endpoints are admin-only (enforced by the role middleware at `index.js`). Exploitation requires a compromised admin token.

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

**Recommendation:** Acceptable for the current threat model. The rate limit and field truncation prevent meaningful abuse.

---

### Finding #13 — Stale JWT role after user modification — ✅ RESOLVED

**File:** `services/vnm-api/src/index.js` auth middleware (lines ~206–240)

**Original issue:** The auth middleware read `decoded.role` from the JWT, which was set at sign-time and never re-validated against the database. This meant:
- A deleted user could continue making API calls with their old token
- A demoted user (admin→viewer) retained admin access until token expiry
- A password-reset user's old token remained valid

**Resolution:** The auth middleware now performs a **database lookup on every authenticated request**:

```js
const decoded = jwt.verify(token, fastify.jwtSecret);

// Verify user still exists and get current role from database
const dbUser = await fastify.prisma.user.findUnique({
  where: { id: decoded.userId },
  select: { id: true, role: true },
});

if (!dbUser) {
  reply.code(401).send({ code: 'UNAUTHORIZED', message: 'User account no longer exists' });
  return;
}

// Use database role (authoritative) instead of JWT role (potentially stale)
request.user = { ...decoded, role: dbUser.role };
```

**Effects:**
- Deleted users are immediately rejected (401)
- Role changes take effect immediately (no waiting for token expiry)
- Password resets don't need to invalidate tokens — the user record still exists with the new hash

**Trade-off:** One extra `SELECT id, role FROM User WHERE id = ?` per authenticated request. For SQLite on a self-hosted single-server deployment, this adds negligible latency (<1ms).

---

### Finding #14 — userId format validation in user management — ✅ RESOLVED

**File:** `services/vnm-api/src/routes/users.js`

**Original issue:** The `userId` path parameter in `PATCH /users/:userId`, `DELETE /users/:userId`, and `POST /users/:userId/reset-password` was not validated for format. While Prisma handles invalid UUIDs gracefully (returns null → 404), explicit validation provides defense-in-depth.

**Resolution:** Added UUID format validation via a shared `isInvalidUserId()` helper that checks against a UUID v4 regex and returns 400 with `INVALID_USER_ID` for malformed IDs:

```js
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isInvalidUserId(userId, reply) {
  if (!userId || !UUID_REGEX.test(userId)) {
    reply.code(400).send({ code: 'INVALID_USER_ID', message: 'userId must be a valid UUID.' });
    return true;
  }
  return false;
}
```

---

### Finding #15 — `RESET_ADMIN_PASSWORD` env var has no auto-disable (Low)

**File:** `services/vnm-api/src/index.js` lines ~392–419

If `RESET_ADMIN_PASSWORD=true` is left in the `.env` file after a password reset, every container restart will re-hash and overwrite the admin password from the env var — even if the admin changed their password through the UI.

**Risk:** Low — self-hosted users control their own `.env`. The README and `.env.example` document removing the flag after use.

**Mitigation in place:** The startup log clearly states `Admin password reset from VNM_ADMIN_PASSWORD (RESET_ADMIN_PASSWORD=true)`, so container logs would show the behavior.

**Recommendation:** Acceptable. The documentation is clear. Further hardening could record when the password was last reset via env var and skip subsequent resets unless the env-var password value changes.

---

### Finding #17 — Same-origin iframe in static gallery player (Low)

**File:** `services/vnm-api/templates/gallery.html`

The static gallery (hosted on Cloudflare R2) now loads games in a same-origin `<iframe>` with `sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads"` instead of opening them in a new tab via `target="_blank"`.

```html
<iframe id="player-iframe" sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads"></iframe>
```

**Risk:** With `allow-same-origin`, JavaScript inside the game iframe can access the parent page's DOM via `window.parent.document` because both the gallery and games live under the same R2 public domain (e.g., `https://games.example.com/` and `https://games.example.com/games/{id}/index.html`). A malicious game could manipulate the gallery page's content.

**Mitigating factors:**
- Games are admin-curated content — only admins can publish to R2
- The static gallery contains **zero sensitive data** — no auth tokens, no API access, no user credentials; it's a purely public static page
- Ren'Py web builds are compiled WebAssembly (Emscripten), not hand-written JavaScript
- Previously with `target="_blank"`, the game ran in its own tab with full JavaScript capabilities (no sandbox at all) — the iframe sandbox is actually **more restrictive** than the previous behavior
- Removing `allow-same-origin` would break WebAssembly games that need to access their own origin for asset loading

**Recommendation:** Acceptable. The sandbox is more restrictive than the previous new-tab behavior, and the gallery has no sensitive data to protect. If maximum isolation is desired in the future, games could be served from a different subdomain (e.g., `play.example.com`) so the iframe would be cross-origin.

---

### Finding #16 — bcrypt DoS via login endpoint (Low — Mitigated)

**File:** `services/vnm-api/src/routes/auth.js` lines 50, 61

Every login attempt (including failures) triggers a `bcrypt.compare()` with cost factor 12 (~250ms per call). The dummy hash on line 50 ensures even non-existent usernames trigger the computation.

**Risk:** Low — this is by design (prevents timing-based user enumeration). The existing rate limit of **5 attempts per minute** on `POST /auth/login` caps CPU cost at ~1.25 seconds/minute. Not exploitable at this rate.

**Recommendation:** No action needed. Rate limiting is sufficient.

---

## Summary Matrix

| # | Finding | Severity | Action Needed |
|---|---------|----------|---------------|
| 1 | Token in localStorage | Low | Acceptable for self-hosted SPA |
| ~~2~~ | ~~Plaintext password comparison~~ | ~~Low~~ | ✅ **Resolved** — bcrypt with cost 12 |
| **3** | **Internal endpoints unauthenticated** | **Medium** | **Add shared secret for builder callbacks, or nginx block** |
| 4 | Build log SSE unauthenticated | Low | Optional: token-in-query-param |
| 5 | Cover images unauthenticated | Low | Acceptable for images |
| ~~6~~ | ~~Shell injection risk in exec~~ | ~~Medium~~ | ✅ **Resolved** — switched to `execFileAsync` (no shell) |
| 7 | CORS allows all origins | Low | Acceptable with Bearer tokens |
| 8 | No server-side token revocation | Low–Medium | Partially mitigated by Finding #13 fix; logout still client-only |
| 9 | Builder runs as root | Low | Intentional, isolated volumes |
| 10 | SSRF via import-url | Low | Reduced — now admin-only; optional: block internal ranges |
| 11 | Nginx missing security headers | Low | Add standard headers |
| 12 | Client error endpoint log injection | Low | Rate-limited + field-truncated; acceptable |
| ~~13~~ | ~~Stale JWT role after user modification~~ | ~~Medium~~ | ✅ **Resolved** — DB lookup per request |
| ~~14~~ | ~~No userId format validation~~ | ~~Low~~ | ✅ **Resolved** — UUID regex validation added |
| 15 | `RESET_ADMIN_PASSWORD` no auto-disable | Low | Acceptable — well-documented |
| 16 | bcrypt DoS via login | Low | Mitigated by rate limiting |
| 17 | Same-origin iframe in static gallery player | Low | Acceptable — gallery has no sensitive data; sandbox more restrictive than previous new-tab behavior |

---

## What's Already Done Right

- **bcrypt password hashing** — cost factor 12, dummy hash on user-not-found prevents timing-based enumeration
- **JWT secret:** Cryptographically random, auto-generated, persisted with restrictive file permissions (`0o600`)
- **Role-based access control** — two roles (`admin` / `viewer`) enforced in auth middleware with DB-verified role on every request
- **Admin safety guards** — cannot delete yourself, cannot demote/delete the last admin
- **Rate limiting** on login (5 per minute via `@fastify/rate-limit`) and on client error reporting (100 per minute)
- **Login failure logging** with IP address
- **JWT expiration** enforced (configurable TTL, default 30 days)
- **DB-verified user on every request** — deleted users immediately rejected, role changes take effect instantly
- **Password required at startup** — hard fail with `process.exit(1)` if missing
- **User input validation** — username regex (`[a-zA-Z0-9_]{3,32}`), password minimum length (8), role whitelist, UUID format checks on userId params
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
- **Idempotent favorites** — upsert prevents duplicate entries; deleteMany is safe on non-existent rows
- **Cascade deletes** — deleting a user cascades favorites; deleting a game cascades all users' favorites
- **Admin seed idempotency** — seed only runs when `adminCount === 0`, safe for repeated restarts
- **Per-user data isolation** — favorites are scoped to `userId` in every query; no cross-user data leakage
- **Graceful shutdown** with proper resource cleanup
