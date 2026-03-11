import { extractRpaArchives } from '../services/rpaExtractor.js';

/**
 * Build management route plugin.
 *
 * Delegates actual build work to the vnm-builder service and provides
 * SSE log streaming with a fallback to reading log files directly.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function buildRoutes(fastify) {
  const BUILDER_URL =
    process.env.BUILDER_URL || 'http://vnm-builder:3002';
  const WEB_BUILDS_PATH = process.env.WEB_BUILDS_PATH || '/web-builds';

  /**
   * POST /build/:gameId
   *
   * Queue a web build for a game:
   *  1. Find game (404 if not found)
   *  2. Check if already building (409 if so)
   *  3. Create BuildJob record with status 'queued'
   *  4. Update game buildStatus to 'queued'
   *  5. POST to vnm-builder to enqueue the build
   *  6. Return 202 { jobId, status: 'queued' }
   */
  fastify.post('/build/:gameId', async (request, reply) => {
    const { gameId } = request.params;
    const { compressAssets = true } = request.body || {};

    if (!gameId || gameId.length !== 32) {
      return reply.code(400).send({
        code: 'INVALID_GAME_ID',
        message: 'gameId must be a 32-character hex string.',
      });
    }

    // Verify game exists
    const game = await fastify.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      return reply.code(404).send({
        code: 'GAME_NOT_FOUND',
        message: `Game with id "${gameId}" not found.`,
      });
    }

    // Don't allow queueing if already queued or building
    if (game.buildStatus === 'queued' || game.buildStatus === 'building') {
      return reply.code(409).send({
        code: 'BUILD_ALREADY_IN_PROGRESS',
        message: `Game already has a ${game.buildStatus} build. Cancel it first.`,
      });
    }

    // Create the build job
    const buildJob = await fastify.prisma.buildJob.create({
      data: {
        gameId,
        status: 'queued',
      },
    });

    // Update the game's build status and link to this job
    await fastify.prisma.game.update({
      where: { id: gameId },
      data: {
        buildStatus: 'queued',
        buildJobId: buildJob.id,
      },
    });

    // Extract any .rpa archives before building — same as the import flow.
    // Games that were added manually (not through import) or that had
    // .rpa files restored after a previous extraction need this step.
    // Skipped when the user opts out of asset compression from the UI.
    if (compressAssets) {
      try {
        await extractRpaArchives(game.directoryPath, request.log);
      } catch (rpaErr) {
        request.log.warn(
          { err: rpaErr.message, gameId },
          'Pre-build .rpa extraction failed — continuing with build anyway'
        );
      }
    } else {
      request.log.info({ gameId }, 'Skipping .rpa extraction (compressAssets=false)');
    }

    // Delegate to vnm-builder
    try {
      const res = await fetch(`${BUILDER_URL}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: buildJob.id,
          gameId,
          gamePath: game.directoryPath,
          compressAssets: !!compressAssets,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        request.log.error(
          { status: res.status, body },
          'vnm-builder rejected build request'
        );

        // Rollback: mark the job as failed
        await fastify.prisma.buildJob.update({
          where: { id: buildJob.id },
          data: {
            status: 'failed',
            error: `Builder rejected: ${res.status} — ${body}`,
            completedAt: new Date(),
          },
        });
        await fastify.prisma.game.update({
          where: { id: gameId },
          data: {
            buildStatus: 'failed',
            buildJobId: buildJob.id,
          },
        });

        return reply.code(502).send({
          code: 'BUILDER_REJECTED',
          message: `Build service rejected the request: ${res.status}`,
          jobId: buildJob.id,
        });
      }
    } catch (err) {
      request.log.error(
        { err: err.message },
        'Failed to contact vnm-builder'
      );

      // Rollback: mark the job as failed
      await fastify.prisma.buildJob.update({
        where: { id: buildJob.id },
        data: {
          status: 'failed',
          error: `Builder unreachable: ${err.message}`,
          completedAt: new Date(),
        },
      });
      await fastify.prisma.game.update({
        where: { id: gameId },
        data: {
          buildStatus: 'failed',
          buildJobId: buildJob.id,
        },
      });

      return reply.code(502).send({
        code: 'BUILDER_UNAVAILABLE',
        message: 'Build service is unreachable. Is vnm-builder running?',
        jobId: buildJob.id,
      });
    }

    reply.code(202);
    return { jobId: buildJob.id, status: 'queued' };
  });

  /**
   * GET /build/:jobId
   *
   * Returns full BuildJob record with current status.
   */
  fastify.get('/build/:jobId', async (request, reply) => {
    const { jobId } = request.params;

    const job = await fastify.prisma.buildJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      return reply.code(404).send({
        code: 'JOB_NOT_FOUND',
        message: `Build job with id "${jobId}" not found.`,
      });
    }

    return job;
  });

  /**
   * GET /build/:jobId/log
   *
   * SSE endpoint that streams build log lines.
   *
   * Strategy:
   *  1. Try to proxy the SSE stream from vnm-builder's GET /build/{jobId}/log
   *  2. If the builder is unreachable, fall back to reading the log file
   *     from the shared /web-builds/logs/ volume.
   */
  fastify.get('/build/:jobId/log', async (request, reply) => {
    const { jobId } = request.params;

    const job = await fastify.prisma.buildJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      return reply.code(404).send({
        code: 'JOB_NOT_FOUND',
        message: `Build job with id "${jobId}" not found.`,
      });
    }

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Try to proxy from vnm-builder first
    const controller = new AbortController();
    const connTimeout = setTimeout(() => controller.abort(), 10000);
    try {
      const builderRes = await fetch(`${BUILDER_URL}/build/${jobId}/log`, {
        signal: controller.signal,
      });
      clearTimeout(connTimeout); // Connection established, no longer need timeout

      if (builderRes.ok && builderRes.body) {
        request.log.info({ jobId }, 'Proxying SSE from vnm-builder');

        const reader = builderRes.body.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            reply.raw.write(chunk);

            // Check if the client disconnected
            if (request.raw.destroyed) {
              reader.cancel();
              break;
            }
          }
        } catch (streamErr) {
          request.log.warn(
            { err: streamErr.message, jobId },
            'SSE proxy stream error — falling back to log file'
          );
          // Fall through to log file fallback
          await streamFromLogFile(jobId, job.status, reply, request);
        }

        reply.raw.end();
        return reply;
      }

      // Builder responded but not with a successful SSE stream
      request.log.warn(
        { status: builderRes.status, jobId },
        'Builder SSE endpoint returned non-OK — falling back to log file'
      );
      await streamFromLogFile(jobId, job.status, reply, request);
      reply.raw.end();
      return reply;
    } catch (err) {
      clearTimeout(connTimeout);
      // Builder unreachable — fall back to log file
      request.log.info(
        { jobId },
        'Builder unreachable — streaming from log file'
      );
      await streamFromLogFile(jobId, job.status, reply, request);
      reply.raw.end();
      return reply;
    }
  });

  /**
   * Stream log lines from the log file on disk.
   * Used as a fallback when vnm-builder's SSE endpoint is unavailable.
   */
  async function streamFromLogFile(jobId, jobStatus, reply, request) {
    const { createReadStream, existsSync } = await import('node:fs');
    const { createInterface } = await import('node:readline');
    const logPath = `${WEB_BUILDS_PATH}/logs/${jobId}.log`;

    if (!existsSync(logPath)) {
      reply.raw.write(`data: [No build log available for job ${jobId}]\n\n`);
      reply.raw.write(`event: done\ndata: ${jobStatus}\n\n`);
      return;
    }

    try {
      const fileStream = createReadStream(logPath, { encoding: 'utf-8' });
      const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (request.raw.destroyed) break;
        reply.raw.write(`data: ${line}\n\n`);
      }
    } catch (err) {
      request.log.warn(
        { err: err.message, jobId },
        'Error reading log file'
      );
      reply.raw.write(`data: [Error reading log file: ${err.message}]\n\n`);
    }

    // Send final status event
    // Re-fetch the job to get the latest status
    try {
      const latestJob = await fastify.prisma.buildJob.findUnique({
        where: { id: jobId },
      });
      const finalStatus = latestJob?.status || jobStatus;
      reply.raw.write(`event: done\ndata: ${finalStatus}\n\n`);
    } catch {
      reply.raw.write(`event: done\ndata: ${jobStatus}\n\n`);
    }
  }

  /**
   * DELETE /build/:jobId
   *
   * Cancel a queued or running build:
   *  1. Find BuildJob (404 if not found)
   *  2. If status is 'queued' or 'building':
   *     - Forward DELETE to vnm-builder
   *     - Update BuildJob.status to 'cancelled'
   *     - Update game.buildStatus to 'not_built'
   *  3. If status is 'done' or 'failed': return 400
   */
  fastify.delete('/build/:jobId', async (request, reply) => {
    const { jobId } = request.params;

    const job = await fastify.prisma.buildJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      return reply.code(404).send({
        code: 'JOB_NOT_FOUND',
        message: `Build job with id "${jobId}" not found.`,
      });
    }

    if (job.status !== 'queued' && job.status !== 'building') {
      return reply.code(400).send({
        code: 'CANNOT_CANCEL',
        message: `Cannot cancel a build with status "${job.status}".`,
      });
    }

    // Forward cancellation to vnm-builder (best-effort)
    try {
      await fetch(`${BUILDER_URL}/build/${jobId}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      request.log.warn(
        { err: err.message, jobId },
        'Failed to forward cancel to vnm-builder (continuing with local update)'
      );
    }

    // Update the job status
    const updatedJob = await fastify.prisma.buildJob.update({
      where: { id: jobId },
      data: {
        status: 'cancelled',
        completedAt: new Date(),
      },
    });

    // Reset the game's build status
    await fastify.prisma.game.updateMany({
      where: { buildJobId: jobId },
      data: {
        buildStatus: 'not_built',
        buildJobId: null,
      },
    });

    return updatedJob;
  });
}
