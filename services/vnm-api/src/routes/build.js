
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
    if (!/^[a-f0-9]{32}$/.test(gameId)) return reply.code(400).send({ message: 'Invalid game ID.' });
    const game = await fastify.prisma.game.findUnique({ where: { id: gameId } });
    if (!game) return reply.code(404).send({ message: 'Game not found.' });
    const compressAssets = request.body?.compressAssets !== false;
    const forceRecompress = request.body?.forceRecompress === true;
    if (forceRecompress && !compressAssets) return reply.code(400).send({ message: "Force recompress requires asset compression." });
    const buildJob = await fastify.prisma.$transaction(async tx => {
      const job = await tx.buildJob.create({ data: { gameId } });
      const claimed = await tx.game.updateMany({ where: { id: gameId, buildStatus: { notIn: ['queued', 'building'] } },
        data: { buildStatus: 'queued', buildJobId: job.id } });
      if (!claimed.count) throw Object.assign(new Error('Build already in progress.'), { statusCode: 409 });
      await tx.workJob.create({ data: { id: job.id, kind: 'build', ownerId: request.user?.userId, gameId,
        title: game.vndbTitle || game.extractedTitle, input: JSON.stringify({ compressAssets, forceRecompress }) } });
      return job;
    });
    await fastify.jobRunner.log(buildJob.id, '[queued] Build accepted. Preparation continues in the background.');
    fastify.jobRunner.wake();
    return reply.code(202).send({ jobId: buildJob.id, status: 'queued' });
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

    const work = await fastify.prisma.workJob.findUnique({ where: { id: jobId } });
    if (work?.stage === 'publishing') return reply.code(409).send({ message: 'Build publication is finishing. Wait for its result.' });
    // During API preparation, abort the extraction process before touching the builder.
    const preparing = work && !['builder-queued', 'unpacking-rpa', 'optimizing', 'packaging', 'publishing', 'building'].includes(work.stage);
    try {
      if (!preparing) {
      const response = await fetch(`${BUILDER_URL}/build/${jobId}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return reply.code(409).send({ message: 'Build already finished or could not be cancelled. Refresh its status.' });
      }
    } catch (err) {
      return reply.code(503).send({ message: 'Build worker is unreachable. Cancellation was not confirmed.' });
    }
    if (!await fastify.jobRunner.cancel(jobId)) return reply.code(409).send({ message: 'Build finished while cancellation was requested.' });

    // Update the job status
    await fastify.prisma.buildJob.updateMany({
      where: { id: jobId, status: { in: ['queued', 'building'] } },
      data: {
        status: 'cancelled',
        completedAt: new Date(),
      },
    });

    // Reset the game's build status
    await fastify.prisma.game.updateMany({
      where: { buildJobId: jobId, buildStatus: { in: ['queued', 'building'] } },
      data: {
        buildStatus: await buildFailureStatus(await fastify.prisma.game.findUnique({ where: { id: job.gameId } })),
      },
    });

    return fastify.prisma.buildJob.findUnique({ where: { id: jobId } });
  });
}
import { buildFailureStatus } from '../services/buildJobs.js';
