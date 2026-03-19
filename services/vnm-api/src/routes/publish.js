import { readdir, stat, readFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getR2Config,
  createR2Client,
  uploadFile,
  deleteR2Prefix,
  deleteR2Object,
} from '../services/r2Client.js';
import { buildGalleryJson, buildGalleryHTML } from '../services/galleryGenerator.js';
import { Upload } from '@aws-sdk/lib-storage';
import { PutObjectCommand } from '@aws-sdk/client-s3';

// In-memory publish job state (supplement to DB for live progress)
// Maps jobId → { progress, filesTotal, filesUploaded, status, error }
const publishState = new Map();

// SSE subscriber sets: jobId → Set<reply.raw>
const publishSubscribers = new Map();

/**
 * Broadcasts a progress event to all SSE subscribers for a job.
 */
function broadcast(jobId, data) {
  const subs = publishSubscribers.get(jobId);
  if (!subs || subs.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const raw of subs) {
    try { raw.write(payload); } catch { /* subscriber disconnected */ }
  }
}

/**
 * Recursively lists all files in a directory.
 * @returns {Promise<string[]>} Absolute paths
 */
async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Uploads the static gallery (gallery.json + index.html) to R2.
 */
async function pushGallery(client, bucketName, prisma, publicUrl, logger) {
  const galleryJson = await buildGalleryJson(prisma, publicUrl);
  const galleryHtml = buildGalleryHTML(galleryJson);
  const galleryJsonStr = JSON.stringify(galleryJson, null, 2);

  const s3Upload = async (key, body, contentType) => {
    const upload = new Upload({
      client,
      params: { Bucket: bucketName, Key: key, Body: body, ContentType: contentType },
    });
    await upload.done();
  };

  await s3Upload('gallery.json', galleryJsonStr, 'application/json');
  await s3Upload('index.html', galleryHtml, 'text/html; charset=utf-8');
  logger.info({ count: galleryJson.games.length }, 'Gallery pushed to R2');
}

/**
 * Performs the actual publish: uploads web-build files + cover to R2.
 * Updates DB and broadcasts SSE progress.
 */
async function runPublishJob(jobId, game, prisma, logger, jwtSecret) {
  const webBuildsPath = process.env.WEB_BUILDS_PATH || '/web-builds';
  const coversPath = process.env.COVERS_PATH || '/covers';
  const buildDir = join(webBuildsPath, game.directoryName);

  const state = publishState.get(jobId);

  try {
    const config = await getR2Config(prisma, jwtSecret);
    if (!config) throw new Error('R2 is not configured. Set credentials in admin settings.');

    const client = createR2Client(config);
    const { bucketName, publicUrl } = config;

    // Mark as uploading
    await prisma.publishJob.update({
      where: { id: jobId },
      data: { status: 'uploading', startedAt: new Date() },
    });
    await prisma.game.update({
      where: { id: game.id },
      data: { publishStatus: 'publishing' },
    });

    // Enumerate web build files
    let files;
    try {
      files = await listFiles(buildDir);
    } catch {
      throw new Error(`Web build not found at ${buildDir}. Build the game first.`);
    }

    state.filesTotal = files.length + 1; // +1 for cover
    state.filesUploaded = 0;
    state.progress = 0;
    broadcast(jobId, { type: 'progress', progress: 0, filesTotal: state.filesTotal, filesUploaded: 0 });

    // Upload all web build files
    for (const filePath of files) {
      const relPath = relative(buildDir, filePath);
      const r2Key = `games/${game.id}/${relPath.replace(/\\/g, '/')}`;
      await uploadFile(client, bucketName, r2Key, filePath);
      state.filesUploaded += 1;
      state.progress = Math.round((state.filesUploaded / state.filesTotal) * 100);
      broadcast(jobId, { type: 'progress', progress: state.progress, filesTotal: state.filesTotal, filesUploaded: state.filesUploaded });
    }

    // Upload cover (if exists)
    if (game.coverPath) {
      const coverExt = extname(game.coverPath).toLowerCase() || '.webp';
      const coverLocalPath = game.coverPath.startsWith('/')
        ? game.coverPath
        : join(coversPath, game.coverPath);
      try {
        await uploadFile(client, bucketName, `covers/${game.id}${coverExt}`, coverLocalPath);
      } catch (err) {
        logger.warn({ err: err.message, gameId: game.id }, 'Failed to upload cover');
      }
    }

    state.filesUploaded = state.filesTotal;
    state.progress = 100;
    broadcast(jobId, { type: 'progress', progress: 100, filesTotal: state.filesTotal, filesUploaded: state.filesTotal });

    // Mark game published before generating gallery so it appears in the listing
    const publishedVersion = `${game.id}-${Date.now()}`;
    const now = new Date();
    await prisma.game.update({
      where: { id: game.id },
      data: { publishStatus: 'published', publishedAt: now, publishedVersion },
    });

    // Generate and upload gallery (game is now published, will be included)
    await pushGallery(client, bucketName, prisma, publicUrl, logger);

    // Mark job done
    await prisma.publishJob.update({
      where: { id: jobId },
      data: { status: 'done', progress: 100, filesTotal: state.filesTotal, filesUploaded: state.filesTotal, completedAt: now },
    });

    state.status = 'done';
    broadcast(jobId, { type: 'done', gameUrl: `${publicUrl}/games/${game.id}/index.html`, publicUrl });
    logger.info({ jobId, gameId: game.id }, 'Publish job completed');

  } catch (err) {
    const message = err.message || 'Publish failed';
    logger.error({ jobId, gameId: game.id, err: message }, 'Publish job failed');

    await prisma.publishJob.update({
      where: { id: jobId },
      data: { status: 'failed', error: message, completedAt: new Date() },
    }).catch(() => {});
    await prisma.game.update({
      where: { id: game.id },
      data: { publishStatus: 'failed' },
    }).catch(() => {});

    state.status = 'failed';
    state.error = message;
    broadcast(jobId, { type: 'error', message });
  } finally {
    // Close all SSE connections for this job
    const subs = publishSubscribers.get(jobId);
    if (subs) {
      for (const raw of subs) {
        try { raw.end(); } catch { /* already closed */ }
      }
      publishSubscribers.delete(jobId);
    }
    // Keep state in memory briefly for late-arriving status polls
    setTimeout(() => publishState.delete(jobId), 60_000);
  }
}

/**
 * Publish routes plugin (admin-only, only registered when VNM_R2_MODE=true).
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function publishRoutes(fastify) {
  const webBuildsPath = process.env.WEB_BUILDS_PATH || '/web-builds';
  const coversPath = process.env.COVERS_PATH || '/covers';

  /**
   * POST /publish/:gameId
   * Queues a publish job for a built game.
   */
  fastify.post('/publish/:gameId', async (request, reply) => {
    const { gameId } = request.params;

    const game = await fastify.prisma.game.findUnique({ where: { id: gameId } });
    if (!game) {
      return reply.code(404).send({ code: 'GAME_NOT_FOUND', message: 'Game not found.' });
    }
    if (game.buildStatus !== 'built') {
      return reply.code(409).send({ code: 'NOT_BUILT', message: 'Game must be built before publishing.' });
    }
    if (game.publishStatus === 'publishing') {
      return reply.code(409).send({ code: 'ALREADY_PUBLISHING', message: 'A publish job is already in progress.' });
    }

    const jobId = randomUUID();

    await fastify.prisma.publishJob.create({
      data: {
        id: jobId,
        gameId,
        status: 'queued',
        progress: 0,
        filesTotal: 0,
        filesUploaded: 0,
      },
    });

    // Initialise in-memory state
    publishState.set(jobId, { status: 'queued', progress: 0, filesTotal: 0, filesUploaded: 0, error: null });

    // Start publish in the background
    setImmediate(() => runPublishJob(jobId, game, fastify.prisma, fastify.log, fastify.jwtSecret));

    return reply.code(202).send({ jobId, status: 'queued' });
  });

  /**
   * GET /publish/:jobId
   * Returns publish job status from DB.
   */
  fastify.get('/publish/:jobId', async (request, reply) => {
    const { jobId } = request.params;
    const job = await fastify.prisma.publishJob.findUnique({ where: { id: jobId } });
    if (!job) {
      return reply.code(404).send({ code: 'JOB_NOT_FOUND', message: 'Publish job not found.' });
    }
    // Merge with in-memory progress for live updates
    const mem = publishState.get(jobId);
    return {
      ...job,
      progress: mem?.progress ?? job.progress,
      filesUploaded: mem?.filesUploaded ?? job.filesUploaded,
    };
  });

  /**
   * GET /publish/:jobId/progress
   * SSE stream of publish progress. Unauthenticated (UUIDs provide access control).
   */
  fastify.get('/publish/:jobId/progress', async (request, reply) => {
    const { jobId } = request.params;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders?.();

    // Send current state immediately
    const mem = publishState.get(jobId);
    if (mem) {
      const job = await fastify.prisma.publishJob.findUnique({ where: { id: jobId } });
      const merged = { ...mem, ...(job ?? {}) };
      reply.raw.write(`data: ${JSON.stringify({ type: 'snapshot', ...merged })}\n\n`);

      if (merged.status === 'done' || merged.status === 'failed') {
        reply.raw.end();
        return;
      }
    } else {
      // Job might have finished; check DB
      const job = await fastify.prisma.publishJob.findUnique({ where: { id: jobId } });
      if (job && (job.status === 'done' || job.status === 'failed')) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'snapshot', ...job })}\n\n`);
        reply.raw.end();
        return;
      }
    }

    // Register subscriber
    if (!publishSubscribers.has(jobId)) publishSubscribers.set(jobId, new Set());
    publishSubscribers.get(jobId).add(reply.raw);

    // Keep-alive ping every 15 seconds
    const ping = setInterval(() => {
      try { reply.raw.write(': ping\n\n'); } catch { clearInterval(ping); }
    }, 15_000);

    request.raw.on('close', () => {
      clearInterval(ping);
      publishSubscribers.get(jobId)?.delete(reply.raw);
    });
  });

  /**
   * DELETE /publish/:gameId
   * Unpublishes a game: removes files from R2, resets status, regenerates gallery.
   */
  fastify.delete('/publish/:gameId', async (request, reply) => {
    const { gameId } = request.params;

    const game = await fastify.prisma.game.findUnique({ where: { id: gameId } });
    if (!game) {
      return reply.code(404).send({ code: 'GAME_NOT_FOUND', message: 'Game not found.' });
    }
    if (game.publishStatus === 'not_published') {
      return reply.code(409).send({ code: 'NOT_PUBLISHED', message: 'Game is not published.' });
    }

    const config = await getR2Config(fastify.prisma, fastify.jwtSecret);
    if (!config) {
      return reply.code(500).send({ code: 'R2_NOT_CONFIGURED', message: 'R2 is not configured.' });
    }

    const client = createR2Client(config);
    const { bucketName, publicUrl } = config;

    // Delete game files and cover from R2
    await deleteR2Prefix(client, bucketName, `games/${gameId}/`);
    for (const ext of ['.webp', '.jpg', '.jpeg', '.png']) {
      try { await deleteR2Object(client, bucketName, `covers/${gameId}${ext}`); } catch { /* not found */ }
    }

    await fastify.prisma.game.update({
      where: { id: gameId },
      data: { publishStatus: 'not_published', publishedAt: null, publishedVersion: null },
    });

    // Regenerate gallery
    await pushGallery(client, bucketName, fastify.prisma, publicUrl, fastify.log);

    return reply.code(204).send();
  });

  /**
   * POST /publish/gallery
   * Manually regenerates and re-uploads the static gallery.
   */
  fastify.post('/publish/gallery', async (request, reply) => {
    const config = await getR2Config(fastify.prisma, fastify.jwtSecret);
    if (!config) {
      return reply.code(500).send({ code: 'R2_NOT_CONFIGURED', message: 'R2 is not configured.' });
    }

    const client = createR2Client(config);
    await pushGallery(client, config.bucketName, fastify.prisma, config.publicUrl, fastify.log);
    return { success: true };
  });
}
