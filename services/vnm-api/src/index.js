import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { mkdirSync, accessSync, constants, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import pino from 'pino';

import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import libraryRoutes from './routes/library.js';
import buildRoutes from './routes/build.js';
import metadataRoutes from './routes/metadata.js';
import coversRoutes from './routes/covers.js';
import importRoutes from './routes/import.js';
import internalRoutes from './routes/internal.js';
import { scanGamesDirectory } from './services/scanner.js';
import { VNDBClient } from './services/vndbClient.js';
import { SteamClient } from './services/steamClient.js';
import { runBatchEnrichment } from './services/enrichment.js';
import { checkStaleBuilds } from './services/buildOrchestrator.js';
import { DirectoryWatcher } from './services/watcher.js';

// ── Persistent log file ───────────────────────────────────
const logDir = process.env.LOG_PATH || '/data/logs';
try {
  mkdirSync(logDir, { recursive: true });
} catch {
  // Will fall back to stdout-only if /data is not writable yet
}

const logStreams = [
  { stream: process.stdout },
];

// Add file transport for persistent logs if writable
try {
  accessSync(logDir, constants.W_OK);
  logStreams.push({
    stream: pino.destination({
      dest: `${logDir}/vnm-api.log`,
      sync: false,
      mkdir: true,
    }),
  });
} catch {
  // /data/logs not writable — stdout only until entrypoint fixes permissions
}

// ── Fastify instance ──────────────────────────────────────
const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    stream: pino.multistream(logStreams),
  },
});

// ── Prisma client ─────────────────────────────────────────
const prisma = new PrismaClient();

// Decorate the fastify instance so routes can access prisma via `fastify.prisma`
fastify.decorate('prisma', prisma);

// Ensure Prisma disconnects on shutdown
fastify.addHook('onClose', async () => {
  await prisma.$disconnect();
});

// ── Auth configuration ────────────────────────────────────
if (!process.env.VNM_ADMIN_PASSWORD) {
  console.error('FATAL: VNM_ADMIN_PASSWORD environment variable is required. Set it in your .env file.');
  process.exit(1);
}

// JWT secret: use env var, or load from /data/.jwt-secret, or generate and persist
const jwtSecretPath = '/data/.jwt-secret';
let jwtSecret = process.env.VNM_JWT_SECRET;
if (!jwtSecret) {
  if (existsSync(jwtSecretPath)) {
    jwtSecret = readFileSync(jwtSecretPath, 'utf-8').trim();
  } else {
    jwtSecret = randomBytes(64).toString('hex');
    try {
      writeFileSync(jwtSecretPath, jwtSecret, { mode: 0o600 });
      fastify.log.info('Generated and persisted new JWT secret');
    } catch (err) {
      fastify.log.warn({ err }, 'Could not persist JWT secret to disk — will regenerate on restart');
    }
  }
}
fastify.decorate('jwtSecret', jwtSecret);

// ── VNDB client ───────────────────────────────────────────
const vndbClient = new VNDBClient({
  apiBase: process.env.VNDB_API_BASE || 'https://api.vndb.org/kana',
  rateDelayMs: parseInt(process.env.VNDB_RATE_DELAY_MS, 10) || 200,
  matchThreshold: parseFloat(process.env.VNDB_MATCH_THRESHOLD) || 0.7,
  apiToken: process.env.VNDB_API_TOKEN || undefined,
  logger: fastify.log,
});

fastify.decorate('vndbClient', vndbClient);

// ── Steam client ──────────────────────────────────────────
const steamClient = new SteamClient({
  cachePath: process.env.STEAM_CACHE_PATH || '/data/steam-applist.json',
  ttlHours: parseInt(process.env.STEAM_APPLIST_TTL_HOURS, 10) || 24,
  rateDelayMs: parseInt(process.env.STEAM_RATE_DELAY_MS, 10) || 1500,
  logger: fastify.log,
});

fastify.decorate('steamClient', steamClient);

// ── Covers path ───────────────────────────────────────────
const coversPath = process.env.COVERS_PATH || '/covers';
fastify.decorate('coversPath', coversPath);

// ── Screenshots path ──────────────────────────────────────
const screenshotsPath = process.env.SCREENSHOTS_PATH || '/screenshots';
fastify.decorate('screenshotsPath', screenshotsPath);

// Ensure screenshots directory exists (same pattern as /data)
try {
  mkdirSync(screenshotsPath, { recursive: true });
} catch {
  // Will be created on first download if this fails
}

// ── Builder URL ───────────────────────────────────────────
const builderUrl = process.env.BUILDER_URL || 'http://vnm-builder:3002';
fastify.decorate('builderUrl', builderUrl);

// ── Build log buffers and SSE subscriber maps ─────────────
// Used by internal.js callback routes and build.js SSE endpoint
fastify.decorate('buildLogBuffers', {});
fastify.decorate('buildLogSubscribers', {});

// ── CORS ──────────────────────────────────────────────────
await fastify.register(cors, {
  origin: true, // Allow all origins (single-user self-hosted)
});

// ── Rate limiting ─────────────────────────────────────────
await fastify.register(rateLimit, {
  global: false, // Don't rate limit all routes, only specific ones
});

// ── Multipart (file uploads) ──────────────────────────────
const maxImportBytes =
  (parseInt(process.env.MAX_IMPORT_SIZE_MB, 10) || 24576) * 1024 * 1024;
await fastify.register(multipart, {
  limits: {
    fileSize: maxImportBytes,
    files: 1,
  },
});

// ── API routes (all prefixed under /api/v1) ───────────────
await fastify.register(healthRoutes, { prefix: '/api/v1' });
await fastify.register(libraryRoutes, { prefix: '/api/v1' });
await fastify.register(buildRoutes, { prefix: '/api/v1' });
await fastify.register(metadataRoutes, { prefix: '/api/v1' });
await fastify.register(coversRoutes, { prefix: '/api/v1' });
await fastify.register(importRoutes, { prefix: '/api/v1' });

// ── Auth routes ───────────────────────────────────────────
await fastify.register(authRoutes, { prefix: '/api/v1' });

// ── Internal routes (builder callbacks) ───────────────────
await fastify.register(internalRoutes, { prefix: '/api/v1' });

// ── Authentication middleware ─────────────────────────────
// Protect all routes except paths that either don't need auth or can't send headers
// (EventSource SSE and <img> tags cannot attach Authorization headers)
fastify.addHook('onRequest', async (request, reply) => {
  const url = request.url;

  // Skip auth for these paths
  if (
    url.startsWith('/api/v1/health') ||
    url.startsWith('/api/v1/auth/') ||
    url.startsWith('/api/v1/internal/') ||
    url.startsWith('/api/v1/covers/') ||
    /^\/api\/v1\/build\/[^/]+\/log/.test(url)
  ) {
    return;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, fastify.jwtSecret);
    request.user = decoded;
  } catch (err) {
    reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    return;
  }
});

// ── Global error handler ─────────────────────────────────
fastify.setErrorHandler((error, request, reply) => {
  const statusCode = error.statusCode || 500;

  request.log.error({ err: error }, 'Request error');

  reply.code(statusCode).send({
    code: error.code || 'INTERNAL_ERROR',
    message: error.message || 'An unexpected error occurred.',
  });
});

// ── 404 handler ───────────────────────────────────────────
fastify.setNotFoundHandler((request, reply) => {
  reply.code(404).send({
    code: 'NOT_FOUND',
    message: `Route ${request.method} ${request.url} not found.`,
  });
});

// ── Stale build detection interval ────────────────────────
const STALE_CHECK_INTERVAL_MS = parseInt(
  process.env.STALE_CHECK_INTERVAL_MS || String(5 * 60 * 1000),
  10
);
let staleCheckTimer = null;
let directoryWatcher = null;

/** Track whether shutdown has been initiated */
let isShuttingDown = false;

function startStaleDetection(gamesPath) {
  // Initial check after a short delay (let the scan finish first)
  const initialDelay = setTimeout(async () => {
    try {
      const result = await checkStaleBuilds(prisma, gamesPath, fastify.log);
      fastify.log.info(
        { checked: result.checkedCount, stale: result.staleCount },
        'Initial stale build check completed'
      );
    } catch (err) {
      fastify.log.warn({ err: err.message }, 'Initial stale build check failed');
    }
  }, 15_000);

  // Periodic check
  staleCheckTimer = setInterval(async () => {
    try {
      const result = await checkStaleBuilds(prisma, gamesPath, fastify.log);
      if (result.staleCount > 0) {
        fastify.log.info(
          { checked: result.checkedCount, stale: result.staleCount },
          'Periodic stale build check found stale games'
        );
      }
    } catch (err) {
      fastify.log.warn({ err: err.message }, 'Periodic stale build check failed');
    }
  }, STALE_CHECK_INTERVAL_MS);

  // Ensure timers don't prevent process exit
  if (staleCheckTimer.unref) staleCheckTimer.unref();
  if (initialDelay.unref) initialDelay.unref();
}

// ── Startup ───────────────────────────────────────────────
const start = async () => {
  try {
    // Ensure the /data directory exists and is writable before migration
    const dataDir = '/data';
    try {
      mkdirSync(dataDir, { recursive: true });
      accessSync(dataDir, constants.W_OK);
    } catch (err) {
      fastify.log.warn(
        { dataDir, err: err.message },
        'Data directory may not be writable — database operations may fail'
      );
    }

    // Run pending Prisma migrations before starting
    fastify.log.info('Running database migrations…');
    try {
      execSync('npx prisma migrate deploy', {
        cwd: process.cwd(),
        stdio: 'pipe',
        env: { ...process.env },
      });
      fastify.log.info('Database migrations applied successfully');
    } catch (migrationErr) {
      fastify.log.error(
        { err: migrationErr.message },
        'Database migration failed — continuing with existing schema'
      );
    }

    // Start the server
    const port = parseInt(process.env.PORT || '3001', 10);
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`vnm-api listening on 0.0.0.0:${port}`);

    // Trigger an initial library scan (non-blocking)
    const gamesPath = process.env.GAMES_PATH || '/games';
    fastify.log.info({ gamesPath }, 'Starting initial library scan');
    scanGamesDirectory(gamesPath, prisma, fastify.log)
      .then((result) => {
        fastify.log.info(
          { found: result.found, new: result.new, removed: result.removed },
          'Initial library scan completed'
        );

        // After scan, trigger batch enrichment in the background
        fastify.log.info('Starting batch VNDB enrichment');
        return runBatchEnrichment(prisma, vndbClient, coversPath, screenshotsPath, fastify.log);
      })
      .then((enrichResult) => {
        fastify.log.info(
          {
            enriched: enrichResult.enriched,
            failed: enrichResult.failed,
            skipped: enrichResult.skipped,
          },
          'Batch VNDB enrichment completed'
        );

        // After enrichment, run stale build detection
        return checkStaleBuilds(prisma, gamesPath, fastify.log);
      })
      .then((staleResult) => {
        fastify.log.info(
          { checked: staleResult.checkedCount, stale: staleResult.staleCount },
          'Post-scan stale build check completed'
        );
      })
      .then(() => {
        // After initial scan chain completes, start the directory watcher
        directoryWatcher = new DirectoryWatcher(
          gamesPath,
          async () => {
            try {
              const scanResult = await scanGamesDirectory(gamesPath, prisma, fastify.log);
              fastify.log.info(
                { found: scanResult.found, new: scanResult.new, removed: scanResult.removed },
                'Watcher-triggered rescan completed'
              );

              const enrichResult = await runBatchEnrichment(prisma, vndbClient, coversPath, screenshotsPath, fastify.log);
              fastify.log.info(
                { enriched: enrichResult.enriched, failed: enrichResult.failed, skipped: enrichResult.skipped },
                'Watcher-triggered enrichment completed'
              );

              const staleResult = await checkStaleBuilds(prisma, gamesPath, fastify.log);
              if (staleResult.staleCount > 0) {
                fastify.log.info(
                  { checked: staleResult.checkedCount, stale: staleResult.staleCount },
                  'Watcher-triggered stale check found stale games'
                );
              }
            } catch (err) {
              fastify.log.warn({ err: err.message }, 'Watcher-triggered rescan failed');
            }
          },
          { debounceMs: 5000, pollIntervalMs: 60000, logger: fastify.log }
        );
        directoryWatcher.start();
      })
      .catch((err) => {
        fastify.log.warn(
          { err: err.message },
          'Initial library scan, enrichment, or stale check failed (games directory may not be mounted)'
        );
      });

    // Start periodic stale detection
    startStaleDetection(gamesPath);
  } catch (err) {
    fastify.log.error(err, 'Failed to start vnm-api');
    process.exit(1);
  }
};

// ── Graceful Shutdown ─────────────────────────────────────
const shutdown = async (signal) => {
  // Prevent double shutdown
  if (isShuttingDown) return;
  isShuttingDown = true;

  fastify.log.info({ signal }, 'Shutting down gracefully…');

  // Set a forced exit timeout of 10 seconds
  const forceExitTimer = setTimeout(() => {
    fastify.log.error('Forced exit after 10s timeout');
    process.exit(1);
  }, 10_000);
  if (forceExitTimer.unref) forceExitTimer.unref();

  // 1. Stop the directory watcher
  if (directoryWatcher) {
    fastify.log.info('Stopping directory watcher');
    directoryWatcher.stop();
    directoryWatcher = null;
  }

  // 2. Clear all intervals (stale check timer)
  if (staleCheckTimer) {
    fastify.log.info('Clearing stale check timer');
    clearInterval(staleCheckTimer);
    staleCheckTimer = null;
  }

  // 3. Close the Fastify server (stops accepting new requests, waits for in-flight)
  try {
    fastify.log.info('Closing Fastify server');
    await fastify.close();
  } catch (err) {
    fastify.log.error({ err: err.message }, 'Error closing Fastify server');
  }

  // 4. Disconnect Prisma client (waits for in-progress queries)
  try {
    fastify.log.info('Disconnecting Prisma client');
    await prisma.$disconnect();
  } catch (err) {
    fastify.log.error({ err: err.message }, 'Error disconnecting Prisma');
  }

  // 5. Clear the force-exit timeout and exit cleanly
  clearTimeout(forceExitTimer);
  fastify.log.info('Shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Unhandled error safety net ────────────────────────────
process.on('unhandledRejection', (reason) => {
  fastify.log.error({ err: reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  fastify.log.fatal({ err: error }, 'Uncaught exception — shutting down');
  process.exit(1);
});

start();
