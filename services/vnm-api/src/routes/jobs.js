import { createReadStream } from 'node:fs';
import { jobLogPath, logExists, readJobLog, validJobId } from '../services/jobLogs.js';
import { publicJob, terminalJob } from '../services/jobRunner.js';
import { rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export default async function jobsRoutes(app) {
  const logs = process.env.WEB_BUILDS_PATH || '/web-builds';
  const options = { preHandler: async (request, reply) => {
    if (request.user?.role !== 'admin') return reply.code(request.user ? 403 : 401).send({ message: 'Admin access required.' });
  } };
  async function lookup(id) {
    if (!validJobId(id)) return null;
    const job = await app.prisma.workJob.findUnique({ where: { id } });
    if (job) return publicJob(job);
    // Existing builds and their logs remain available after upgrading.
    const build = await app.prisma.buildJob.findUnique({ where: { id } });
    return build ? { ...build, kind: 'build', title: build.gameId, stage: build.status } : null;
  }
  app.get('/jobs', options, async request => {
    const offset = Math.max(0, Math.min(100000, Number.parseInt(request.query.offset, 10) || 0));
    const jobs = await app.prisma.workJob.findMany({ where: request.query.active === '1' ? { status: { in: ['queued', 'running'] } } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: offset, take: 51 });
    return { items: jobs.slice(0, 50).map(publicJob), nextOffset: jobs.length > 50 ? offset + 50 : null };
  });
  app.get('/jobs/:id', options, async (request, reply) => {
    const job = await lookup(request.params.id);
    return job || reply.code(404).send({ message: 'Job not found.' });
  });
  app.get('/jobs/:id/log', options, async (request, reply) => {
    const job = await lookup(request.params.id);
    if (!job) return reply.code(404).send({ message: 'Job not found.' });
    reply.header('Cache-Control', 'no-store');
    if (request.query.download === '1') {
      if (!await logExists(logs, job.id)) return reply.code(404).send({ message: 'No log output yet.' });
      reply.header('Content-Disposition', `attachment; filename="${job.id}.log"`);
      return reply.type('text/plain; charset=utf-8').send(createReadStream(jobLogPath(logs, job.id)));
    }
    const offset = Number(request.query.offset || 0);
    return { ...await readJobLog(logs, job.id, offset), status: job.status, stage: job.stage, done: terminalJob(job.status) };
  });
  app.post('/jobs/:id/cancel', options, async (request, reply) => {
    const job = await lookup(request.params.id);
    if (!job) return reply.code(404).send({ message: 'Job not found.' });
    if (terminalJob(job.status)) return reply.code(409).send({ message: 'Job already finished.' });
    if (['publishing', 'scanning'].includes(job.stage)) return reply.code(409).send({ message: 'Publication is finishing. Wait for its result.' });
    if (job.kind === 'build') {
      const result = await app.inject({ method: 'DELETE', url: `/api/v1/build/${job.id}`, headers: { authorization: request.headers.authorization } });
      return reply.code(result.statusCode).send(result.json());
    }
    if (!await app.jobRunner.cancel(job.id)) return reply.code(409).send({ message: 'Job is finished or publication is completing.' });
    return { cancelled: true };
  });
  app.post('/jobs/:id/retry', options, async (request, reply) => {
    const source = await app.prisma.workJob.findUnique({ where: { id: request.params.id } });
    if (!source || !['failed', 'cancelled'].includes(source.status)) return reply.code(409).send({ message: 'Only a failed or cancelled job can be retried.' });
    const input = JSON.parse(source.input);
    if (source.kind === 'build') {
      const result = await app.inject({ method: 'POST', url: `/api/v1/build/${source.gameId}`, headers: { authorization: request.headers.authorization }, payload: input });
      return reply.code(result.statusCode).send(result.json());
    }
    // Upload archives belong to their original job and are retained for retry.
    if (source.result) input.publishedResult = JSON.parse(source.result);
    if (!input.publishedResult && input.archive && !await import('node:fs/promises').then(fs => fs.access(input.archive).then(() => true, () => false))) {
      return reply.code(409).send({ message: 'The staged archive is no longer available. Upload it again.' });
    }
    const job = await app.jobRunner.create({ kind: 'import', ownerId: request.user.userId, title: source.title, input });
    app.jobRunner.wake(); return reply.code(202).send({ jobId: job.id, status: 'queued' });
  });
  app.delete('/jobs/:id', options, async (request, reply) => {
    const job = await lookup(request.params.id);
    if (!job) return reply.code(404).send({ message: 'Job not found.' });
    if (!terminalJob(job.status)) return reply.code(409).send({ message: 'Cancel or finish the job before removing its record.' });
    const directory = app.jobRunner.directory(job.id);
    const otherImports = await app.prisma.workJob.findMany({ where: { kind: 'import', id: { not: job.id }, status: { not: 'done' } }, select: { input: true } });
    const sharedArchive = otherImports.some(other => {
      const archive = JSON.parse(other.input).archive;
      return archive && resolve(archive).startsWith(resolve(directory) + sep);
    });
    if (!sharedArchive) await rm(directory, { recursive: true, force: true });
    await rm(jobLogPath(logs, job.id), { force: true });
    await rm(join(logs, '.vnm-jobs', `${job.id}.json`), { force: true });
    await app.prisma.$transaction([
      app.prisma.game.updateMany({ where: { buildJobId: job.id }, data: { buildJobId: null } }),
      app.prisma.buildJob.deleteMany({ where: { id: job.id } }),
      app.prisma.workJob.deleteMany({ where: { id: job.id } }),
    ]);
    return { removed: true, archiveRetainedForRetry: sharedArchive };
  });
}
