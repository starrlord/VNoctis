/**
 * Internal route plugin.
 *
 * These endpoints are used for inter-service communication:
 *   - Builder callbacks (build status & log lines)
 *   - Client-side error reporting from the UI
 *
 * They are NOT protected by authentication (skipped in the onRequest hook).
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function internalRoutes(fastify) {
  // ── Client-side error reporting ───────────────────────────
  /**
   * POST /internal/client-error
   *
   * Accepts error reports from the UI's ErrorBoundary and logs them
   * server-side so they appear in the persistent log file and Docker logs.
   *
   * Rate-limited to 100 requests per minute to prevent log flooding.
   * Body capped at 64 KB.
   */
  fastify.post('/internal/client-error', {
    config: {
      rateLimit: {
        max: 100,
        timeWindow: '1 minute',
      },
    },
    bodyLimit: 65536,
  }, async (request, reply) => {
    const { message, stack, componentStack, url, userAgent } = request.body || {};

    if (!message || typeof message !== 'string') {
      return reply.code(400).send({ code: 'INVALID_BODY', message: 'Body must include a "message" string.' });
    }

    fastify.log.error(
      {
        source: 'client',
        errorMessage: message.slice(0, 1024),
        stack: typeof stack === 'string' ? stack.slice(0, 4096) : undefined,
        componentStack: typeof componentStack === 'string' ? componentStack.slice(0, 2048) : undefined,
        url: typeof url === 'string' ? url.slice(0, 256) : undefined,
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 256) : undefined,
      },
      'Client-side error reported'
    );

    return { ok: true };
  });

  /**
   * POST /internal/build/:jobId/status
   *
   * Called by vnm-builder whenever the build status changes.
   *
   * Body: { status: 'building'|'done'|'failed', error?: string, webBuildPath?: string }
   *
   * Updates both the BuildJob and the associated Game record.
   */
  fastify.post('/internal/build/:jobId/status', async (request, reply) => {
    const { jobId } = request.params;
    const { status, error, webBuildPath } = request.body || {};

    if (!status || !['building', 'done', 'failed'].includes(status)) {
      return reply.code(400).send({
        code: 'INVALID_STATUS',
        message: `status must be one of: building, done, failed. Got "${status}".`,
      });
    }

    // Find the build job
    const job = await fastify.prisma.buildJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      return reply.code(404).send({
        code: 'JOB_NOT_FOUND',
        message: `Build job "${jobId}" not found.`,
      });
    }

    const now = new Date();

    // ── Update BuildJob ───────────────────────────────────
    const jobUpdate = { status };

    if (status === 'building') {
      jobUpdate.startedAt = now;
    }

    if (status === 'done' || status === 'failed') {
      jobUpdate.completedAt = now;
    }

    if (status === 'failed' && error) {
      jobUpdate.error = error;
    }

    if (status === 'done') {
      jobUpdate.logPath = `/web-builds/logs/${jobId}.log`;
    }

    await fastify.prisma.buildJob.update({
      where: { id: jobId },
      data: jobUpdate,
    });

    // ── Update associated Game ────────────────────────────
    const gameUpdate = {};

    if (status === 'building') {
      gameUpdate.buildStatus = 'building';
    }

    if (status === 'done') {
      gameUpdate.buildStatus = 'built';
      gameUpdate.builtAt = now;
      if (webBuildPath) {
        gameUpdate.webBuildPath = webBuildPath;
      }
    }

    if (status === 'failed') {
      gameUpdate.buildStatus = 'failed';
    }

    if (Object.keys(gameUpdate).length > 0) {
      await fastify.prisma.game.update({
        where: { id: job.gameId },
        data: gameUpdate,
      });
    }

    request.log.info(
      { jobId, gameId: job.gameId, status },
      'Build status callback received'
    );

    return { ok: true, jobId, status };
  });

  /**
   * POST /internal/build/:jobId/log
   *
   * Called by vnm-builder to append a log line.
   * Currently stores lines in a per-job in-memory buffer that SSE
   * subscribers can read.  The canonical log is the file on disk at
   * /web-builds/logs/{jobId}.log.
   *
   * Body: { line: "build output line..." }
   */
  fastify.post('/internal/build/:jobId/log', async (request, reply) => {
    const { jobId } = request.params;
    const { line } = request.body || {};

    if (typeof line !== 'string') {
      return reply.code(400).send({
        code: 'INVALID_BODY',
        message: 'Body must include a "line" string.',
      });
    }

    // Append to in-memory log buffer (used by SSE subscribers)
    if (!fastify.buildLogBuffers) {
      fastify.buildLogBuffers = {};
    }

    if (!fastify.buildLogBuffers[jobId]) {
      fastify.buildLogBuffers[jobId] = [];
    }

    fastify.buildLogBuffers[jobId].push(line);

    // Broadcast to SSE subscribers
    if (fastify.buildLogSubscribers && fastify.buildLogSubscribers[jobId]) {
      for (const subscriber of fastify.buildLogSubscribers[jobId]) {
        try {
          subscriber(line);
        } catch {
          // ignore dead subscribers
        }
      }
    }

    return { ok: true };
  });
}
