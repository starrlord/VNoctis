import { rm, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { scanGamesDirectory } from '../services/scanner.js';
import { runBatchEnrichment } from '../services/enrichment.js';
import { downloadCover } from '../services/coverDownloader.js';
import { removeScreenshots } from '../services/screenshotDownloader.js';

/**
 * Parse JSON string fields (tags, screenshots) on a game object.
 * Returns the game with tags/screenshots as parsed arrays.
 *
 * @param {object} game - A Game record from Prisma.
 * @returns {object} The game with parsed JSON fields.
 */
function parseGameJsonFields(game) {
  if (!game) return game;
  return {
    ...game,
    tags: safeJsonParse(game.tags, []),
    screenshots: safeJsonParse(game.screenshots, []),
  };
}

/**
 * Safely parse a JSON string, returning a fallback on failure.
 */
function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/** Valid sort columns */
const VALID_SORT_FIELDS = ['extractedTitle', 'vndbRating', 'releaseDate', 'createdAt', 'builtAt'];

/** Alias map for query-friendly sort names */
const SORT_ALIAS = {
  title: 'extractedTitle',
  rating: 'vndbRating',
  releaseDate: 'releaseDate',
  createdAt: 'createdAt',
  builtAt: 'builtAt',
};

/** Valid build status values */
const VALID_BUILD_STATUSES = ['not_built', 'queued', 'building', 'built', 'failed', 'stale'];

/** Valid metadata source values */
const VALID_METADATA_SOURCES = ['auto', 'manual', 'unmatched'];

/**
 * Library CRUD route plugin.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function libraryRoutes(fastify) {
  const gamesPath = process.env.GAMES_PATH || '/games';

  /**
   * GET /library
   * Returns all games with optional filtering and sorting.
   *
   * Query params:
   *   search       - Filter by title (case-insensitive contains)
   *   sort         - title | rating | releaseDate | createdAt (default: title)
   *   order        - asc | desc (default: asc)
   *   buildStatus  - Filter by build status
   *   metadataSource - Filter by metadata source
   */
  fastify.get('/library', async (request) => {
    const {
      search,
      sort = 'title',
      order = 'asc',
      buildStatus,
      metadataSource,
      includeHidden,
    } = request.query;

    // Build the where clause
    const where = {};

    if (search) {
      where.extractedTitle = { contains: search };
    }

    if (buildStatus) {
      if (!VALID_BUILD_STATUSES.includes(buildStatus)) {
        return { error: { code: 'INVALID_BUILD_STATUS', message: `Invalid buildStatus. Must be one of: ${VALID_BUILD_STATUSES.join(', ')}` } };
      }
      where.buildStatus = buildStatus;
    }

    if (metadataSource) {
      if (!VALID_METADATA_SOURCES.includes(metadataSource)) {
        return { error: { code: 'INVALID_METADATA_SOURCE', message: `Invalid metadataSource. Must be one of: ${VALID_METADATA_SOURCES.join(', ')}` } };
      }
      where.metadataSource = metadataSource;
    }

    // Exclude hidden games by default
    if (includeHidden !== 'true') {
      where.hidden = false;
    }

    // Resolve sort field
    const sortField = SORT_ALIAS[sort] || sort;
    if (!VALID_SORT_FIELDS.includes(sortField)) {
      return { error: { code: 'INVALID_SORT', message: `Invalid sort field. Must be one of: title, rating, releaseDate, createdAt` } };
    }

    const orderDir = order === 'desc' ? 'desc' : 'asc';

    const games = await fastify.prisma.game.findMany({
      where,
      orderBy: { [sortField]: orderDir },
    });

    return games.map(parseGameJsonFields);
  });

  /**
   * POST /library/unhide-all
   * Bulk unhide all hidden games.
   */
  fastify.post('/library/unhide-all', async (request, reply) => {
    const result = await fastify.prisma.game.updateMany({
      where: { hidden: true },
      data: { hidden: false },
    });
    return { unhiddenCount: result.count };
  });

  /**
   * GET /library/:gameId
   * Returns full detail for one game.
   */
  fastify.get('/library/:gameId', async (request, reply) => {
    const { gameId } = request.params;

    if (!gameId || gameId.length !== 32) {
      return reply.code(400).send({
        code: 'INVALID_GAME_ID',
        message: 'gameId must be a 32-character hex string.',
      });
    }

    const game = await fastify.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      return reply.code(404).send({
        code: 'GAME_NOT_FOUND',
        message: `Game with id "${gameId}" not found.`,
      });
    }

    return parseGameJsonFields(game);
  });

  /**
   * POST /library/scan
   * Triggers a full directory rescan. Returns immediately with a job ID.
   */
  fastify.post('/library/scan', async (request, reply) => {
    // Create a scan job record
    const scanJob = await fastify.prisma.scanJob.create({
      data: {
        status: 'running',
      },
    });

    // Run the scan asynchronously (don't await)
    runScanAsync(scanJob.id, gamesPath, fastify.prisma, fastify.vndbClient, fastify.coversPath, fastify.screenshotsPath, fastify.log);

    reply.code(202);
    return { jobId: scanJob.id };
  });

  /**
   * GET /library/scan/:jobId
   * Returns scan job status.
   */
  fastify.get('/library/scan/:jobId', async (request, reply) => {
    const { jobId } = request.params;

    const job = await fastify.prisma.scanJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      return reply.code(404).send({
        code: 'JOB_NOT_FOUND',
        message: `Scan job with id "${jobId}" not found.`,
      });
    }

    return job;
  });

  /**
   * PATCH /library/:gameId
   * Updates manual overrides for metadata fields.
   */
  fastify.patch('/library/:gameId', async (request, reply) => {
    const { gameId } = request.params;

    if (!gameId || gameId.length !== 32) {
      return reply.code(400).send({
        code: 'INVALID_GAME_ID',
        message: 'gameId must be a 32-character hex string.',
      });
    }

    const game = await fastify.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      return reply.code(404).send({
        code: 'GAME_NOT_FOUND',
        message: `Game with id "${gameId}" not found.`,
      });
    }

    const body = request.body;
    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
      return reply.code(400).send({
        code: 'EMPTY_BODY',
        message: 'Request body must include at least one field to update.',
      });
    }

    // Whitelist of editable fields
    const editableFields = [
      'extractedTitle',
      'vndbId',
      'steamAppId',
      'vndbTitle',
      'vndbTitleOriginal',
      'synopsis',
      'developer',
      'releaseDate',
      'lengthMinutes',
      'vndbRating',
      'coverPath',
      'tags',
      'screenshots',
      'hidden',
      'favorite',
    ];

    const updateData = {};
    for (const field of editableFields) {
      if (field in body) {
        let value = body[field];

        // Serialize arrays/objects to JSON strings for tags/screenshots
        if ((field === 'tags' || field === 'screenshots') && Array.isArray(value)) {
          value = JSON.stringify(value);
        }

        // Parse releaseDate string to Date
        if (field === 'releaseDate' && value !== null) {
          value = new Date(value);
        }

        updateData[field] = value;
      }
    }

    if (Object.keys(updateData).length === 0) {
      return reply.code(400).send({
        code: 'NO_VALID_FIELDS',
        message: `No valid editable fields provided. Allowed: ${editableFields.join(', ')}`,
      });
    }

    // If coverPath looks like a URL, download it locally
    if (updateData.coverPath && /^https?:\/\//.test(updateData.coverPath)) {
      const coversPath = fastify.coversPath || '/covers';

      // Remove existing cover so downloadCover doesn't skip
      try {
        const existingCovers = await readdir(coversPath);
        for (const f of existingCovers) {
          if (f.startsWith(gameId)) {
            await rm(join(coversPath, f), { force: true });
          }
        }
      } catch {
        // covers dir may not exist yet — downloadCover will create it
      }

      const localPath = await downloadCover(updateData.coverPath, gameId, coversPath);
      if (localPath) {
        updateData.coverPath = localPath;
      } else {
        return reply.code(400).send({
          code: 'COVER_DOWNLOAD_FAILED',
          message: 'Failed to download the cover image from the provided URL.',
        });
      }
    }

    // Mark as manually edited (but not for hide/favorite-only toggles)
    const nonHiddenFields = Object.keys(updateData).filter(k => k !== 'hidden' && k !== 'favorite');
    if (nonHiddenFields.length > 0) {
      updateData.metadataSource = 'manual';
    }

    const updated = await fastify.prisma.game.update({
      where: { id: gameId },
      data: updateData,
    });

    return parseGameJsonFields(updated);
  });

  /**
   * POST /library/:gameId/mark-playable
   *
   * Manually marks a game as playable by verifying that a valid web build
   * already exists on disk at /web-builds/<directoryName>/index.html.
   *
   * This is useful when:
   *  - A pre-built ZIP was manually extracted into /web-builds/
   *  - The automatic ZIP import during scan failed or was incomplete
   *  - The user wants to bypass the normal build process
   *
   * Returns 200 with the updated game on success, or 422 if no valid
   * web build is found on disk.
   */
  fastify.post('/library/:gameId/mark-playable', async (request, reply) => {
    const { gameId } = request.params;

    if (!gameId || gameId.length !== 32) {
      return reply.code(400).send({
        code: 'INVALID_GAME_ID',
        message: 'gameId must be a 32-character hex string.',
      });
    }

    const game = await fastify.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      return reply.code(404).send({
        code: 'GAME_NOT_FOUND',
        message: `Game with id "${gameId}" not found.`,
      });
    }

    const webBuildsPath = process.env.WEB_BUILDS_PATH || '/web-builds';
    const webBuildDir = join(webBuildsPath, game.directoryName);
    const indexPath = join(webBuildDir, 'index.html');

    // Verify a valid web build exists on disk
    try {
      await access(indexPath);
    } catch {
      return reply.code(422).send({
        code: 'NO_WEB_BUILD',
        message: `No valid web build found. Expected index.html at: /web-builds/${game.directoryName}/index.html`,
      });
    }

    const updated = await fastify.prisma.game.update({
      where: { id: gameId },
      data: {
        buildStatus: 'built',
        webBuildPath: `/web-builds/${game.directoryName}`,
        builtAt: new Date(),
      },
    });

    request.log.info(
      { gameId, webBuildPath: `/web-builds/${game.directoryName}` },
      'Game manually marked as playable'
    );

    return parseGameJsonFields(updated);
  });

  /**
   * DELETE /library/:gameId
   * Fully removes a game: source directory, web-build assets, covers,
   * build logs, BuildJob records, and the Game database record.
   */
  fastify.delete('/library/:gameId', async (request, reply) => {
    const { gameId } = request.params;

    if (!gameId || gameId.length !== 32) {
      return reply.code(400).send({
        code: 'INVALID_GAME_ID',
        message: 'gameId must be a 32-character hex string.',
      });
    }

    const game = await fastify.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      return reply.code(404).send({
        code: 'GAME_NOT_FOUND',
        message: `Game with id "${gameId}" not found.`,
      });
    }

    const webBuildsPath = process.env.WEB_BUILDS_PATH || '/web-builds';
    const coversPath = fastify.coversPath || '/covers';
    const screenshotsPath = fastify.screenshotsPath || '/screenshots';

    // 1. Delete the game source folder (/games/<folder>)
    //    ZIP archives (especially from Windows) can contain directories with
    //    no write permission, causing recursive rm to fail with EACCES.
    //    Ensure all entries are writable before attempting removal.
    try {
      try {
        await access(game.directoryPath);
        await execFileAsync('chmod', ['-R', 'u+rwX', game.directoryPath]);
      } catch {
        // Directory may not exist — rm with force will handle that
      }
      await rm(game.directoryPath, { recursive: true, force: true });
      request.log.info({ path: game.directoryPath }, 'Deleted game source directory');
    } catch (err) {
      request.log.error({ err: err.message, path: game.directoryPath }, 'Failed to delete game source directory');
      return reply.code(500).send({
        code: 'DELETE_FAILED',
        message: `Could not delete game source folder: ${err.message}`,
      });
    }

    // 2. Delete web-build directory: /web-builds/<directoryName>/
    try {
      await rm(join(webBuildsPath, game.directoryName), { recursive: true, force: true });
      request.log.info({ path: join(webBuildsPath, game.directoryName) }, 'Deleted web-build directory');
    } catch (err) {
      request.log.warn({ err: err.message }, 'Failed to delete web-build directory');
    }

    // 3. Delete web-build zip: /web-builds/<directoryName>.zip
    try {
      await rm(join(webBuildsPath, `${game.directoryName}.zip`), { force: true });
    } catch (err) {
      request.log.warn({ err: err.message }, 'Failed to delete web-build zip');
    }

    // 4. Delete cover images: /covers/<gameId>.*
    try {
      const coverFiles = await readdir(coversPath);
      for (const file of coverFiles) {
        if (file.startsWith(gameId)) {
          await rm(join(coversPath, file), { force: true });
        }
      }
    } catch (err) {
      request.log.warn({ err: err.message }, 'Failed to clean up cover files');
    }

    // 5. Delete cached screenshots: /screenshots/<gameId>/
    try {
      await removeScreenshots(gameId, screenshotsPath);
      request.log.info({ gameId }, 'Deleted cached screenshots');
    } catch (err) {
      request.log.warn({ err: err.message }, 'Failed to clean up screenshot files');
    }

    // 6. Delete build logs for related BuildJobs
    const buildJobs = await fastify.prisma.buildJob.findMany({
      where: { gameId },
      select: { id: true },
    });
    for (const job of buildJobs) {
      try {
        await rm(join(webBuildsPath, 'logs', `${job.id}.log`), { force: true });
      } catch {
        // Best-effort log cleanup
      }
    }

    // 7. Delete BuildJob DB records
    await fastify.prisma.buildJob.deleteMany({ where: { gameId } });

    // 8. Delete the Game DB record
    await fastify.prisma.game.delete({ where: { id: gameId } });

    request.log.info({ gameId, title: game.extractedTitle }, 'Game fully deleted');
    reply.code(204);
    return;
  });
}

/**
 * Run a scan in the background, then trigger batch enrichment for newly
 * discovered games. Updates the ScanJob record when done.
 */
async function runScanAsync(jobId, gamesPath, prisma, vndbClient, coversPath, screenshotsPath, logger) {
  try {
    const result = await scanGamesDirectory(gamesPath, prisma, logger);

    await prisma.scanJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        gamesFound: result.found,
        gamesNew: result.new,
        gamesRemoved: result.removed,
        completedAt: new Date(),
      },
    });

    logger.info({ jobId, ...result }, 'Library scan completed');

    // Trigger batch enrichment for any games needing metadata
    if (vndbClient && coversPath) {
      logger.info('Starting post-scan batch VNDB enrichment');
      try {
        const enrichResult = await runBatchEnrichment(prisma, vndbClient, coversPath, screenshotsPath, logger);
        logger.info(
          {
            enriched: enrichResult.enriched,
            failed: enrichResult.failed,
            skipped: enrichResult.skipped,
          },
          'Post-scan batch enrichment completed'
        );
      } catch (enrichErr) {
        logger.warn({ err: enrichErr.message }, 'Post-scan batch enrichment failed');
      }
    }
  } catch (err) {
    logger.error({ jobId, err: err.message }, 'Library scan failed');

    await prisma.scanJob.update({
      where: { id: jobId },
      data: {
        status: 'failed',
        error: err.message,
        completedAt: new Date(),
      },
    });
  }
}
