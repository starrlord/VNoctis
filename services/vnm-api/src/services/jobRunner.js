import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendJobLog } from './jobLogs.js';
import { buildFailureStatus } from './buildJobs.js';

export const terminalJob = status => ['done', 'failed', 'cancelled'].includes(status);
export function jobFailureMessage(error) {
  const detail = String(error.stderr || error.message || 'Processing failed. Open the log for details.');
  if (error.code === 'EEXIST') return 'A game folder with this name already exists. Nothing was overwritten.';
  if (error.code === 'ENOSPC' || /No space left on device/.test(detail)) return 'Not enough free disk space for this operation.';
  if (/BadZipFile/.test(detail)) return 'The archive is damaged or is not a supported ZIP file.';
  if (error.name?.startsWith('Prisma')) return 'A database operation failed. Open the job log for details.';
  if (error.stderr) return detail.trim().split(/\r?\n/).at(-1).replace(/^(?:\w+\.)*\w+(?:Error|Exception):\s*/, '').slice(0, 1000);
  return detail.split(/\r?\n/)[0].slice(0, 1000);
}
export const publicJob = job => ({ ...job, input: undefined, bytesDone: Number(job.bytesDone || 0), bytesTotal: Number(job.bytesTotal || 0),
  result: job.result ? JSON.parse(job.result) : null });

/** One durable FIFO for API preparation/import work. Builder has its own bounded queue. */
export function createJobRunner(app, { storage, logs, interval = 1000, reconcileInterval = 10000 }) {
  const handlers = new Map(), controllers = new Map();
  let timer, draining = false, reconciling = false, stopped = false, lastReconcile = 0;
  const directory = id => join(storage, id);
  const log = (id, message) => appendJobLog(logs, id, message);
  async function patch(id, data) {
    return app.prisma.workJob.updateMany({ where: { id, status: { in: ['queued', 'running'] } }, data });
  }
  async function fail(job, error) {
    const status = error.name === 'AbortError' && !stopped ? 'cancelled' : 'failed';
    const message = stopped ? 'Processing was interrupted by API shutdown. Retry to start this stage again.' : status === 'cancelled' ? 'Job cancelled.' : jobFailureMessage(error);
    await log(job.id, `[${status}] ${message}${status === 'failed' ? `\n${error.stack || error.message || ''}` : ''}`).catch(error => app.log.warn({ err: error.message }, 'Could not write job failure log'));
    await patch(job.id, { status, stage: status, error: message, completedAt: new Date() });
    if (job.kind === 'build') {
      const game = await app.prisma.game.findUnique({ where: { id: job.gameId } });
      await app.prisma.buildJob.updateMany({ where: { id: job.id, status: { in: ['queued', 'building'] } },
        data: { status, error: message, completedAt: new Date() } });
      await app.prisma.game.updateMany({ where: { id: job.gameId, buildJobId: job.id, buildStatus: { in: ['queued', 'building'] } }, data: { buildStatus: await buildFailureStatus(game) } });
    }
  }
  async function reconcile() {
    if (reconciling || stopped || Date.now() - lastReconcile < reconcileInterval) return;
    reconciling = true;
    lastReconcile = Date.now();
    try {
      const delegated = await app.prisma.workJob.findMany({ where: { kind: 'build', status: 'running',
        stage: { in: ['builder-queued', 'unpacking-rpa', 'optimizing', 'packaging', 'publishing', 'building'] } } });
      for (const job of delegated) {
        if (stopped) break;
        try {
          const response = await fetch(`${process.env.BUILDER_URL || 'http://vnm-builder:3002'}/build/${job.id}`, { signal: AbortSignal.timeout(3000) });
          if (response.status === 404) {
            await patch(job.id, { status: 'queued', stage: 'queued' });
          } else if (response.ok) {
            const worker = await response.json();
            if (['done', 'failed'].includes(worker.status)) {
              await app.inject({ method: 'POST', url: `/api/v1/internal/build/${job.id}/status`, payload: {
                status: worker.status, error: worker.error, webBuildPath: worker.webBuildPath,
              } });
            } else if (worker.status === 'cancelled') await fail(job, Object.assign(new Error('Build cancelled.'), { name: 'AbortError' }));
          }
        } catch { /* A worker outage leaves the durable job available for recovery. */ }
      }
    } catch (error) { app.log.error({ err: error }, 'Build reconciliation failed'); }
    finally { reconciling = false; }
  }
  async function drain() {
    if (draining || stopped) return;
    draining = true;
    try {
      while (!stopped) {
        const job = await app.prisma.workJob.findFirst({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' } });
        if (!job) break;
        const handler = handlers.get(job.kind);
        if (!handler) break;
        const claimed = await app.prisma.workJob.updateMany({ where: { id: job.id, status: 'queued' },
          data: { status: 'running', startedAt: new Date() } });
        if (!claimed.count) continue;
        const controller = new AbortController(); controllers.set(job.id, controller);
        try {
          const context = { signal: controller.signal, directory: directory(job.id),
            log: message => log(job.id, message),
            progress: async data => {
              controller.signal.throwIfAborted();
              await patch(job.id, data);
            } };
          await handler(job, JSON.parse(job.input), context);
        } catch (error) { await fail(job, error); }
        finally { controllers.delete(job.id); }
      }
    } catch (error) { app.log.error({ err: error }, 'Background queue failed'); }
    finally { draining = false; }
  }
  return {
    directory, log, patch,
    register(kind, handler) { handlers.set(kind, handler); },
    async create(data) {
      const id = data.id || randomUUID();
      await mkdir(directory(id), { recursive: true });
      const job = await app.prisma.workJob.create({ data: { ...data, id, input: JSON.stringify(data.input) } });
      await log(id, `[queued] ${data.title}`);
      return job;
    },
    async start() {
      // Preserve discoverability of build logs created before this feature.
      for (const build of await app.prisma.buildJob.findMany({ orderBy: { createdAt: 'desc' }, take: 200 })) {
        const game = await app.prisma.game.findUnique({ where: { id: build.gameId }, select: { extractedTitle: true } });
        await app.prisma.workJob.upsert({ where: { id: build.id }, update: {}, create: {
          id: build.id, kind: 'build', gameId: build.gameId, title: game?.extractedTitle || build.gameId,
          input: JSON.stringify({ compressAssets: true }), status: ['queued', 'building'].includes(build.status) ? 'running' : build.status,
          stage: ['queued', 'building'].includes(build.status) ? 'builder-queued' : build.status,
          error: build.error, createdAt: build.createdAt, startedAt: build.startedAt, completedAt: build.completedAt,
        } });
      }
      // Interrupted subprocesses cannot safely resume. Retain their archive and log for explicit retry.
      const interrupted = await app.prisma.workJob.findMany({ where: { status: 'running', OR: [
        { kind: 'import' },
        { kind: 'build', stage: { notIn: ['builder-queued', 'unpacking-rpa', 'optimizing', 'packaging', 'publishing', 'building'] } },
      ] } });
      for (const job of interrupted) await fail(job, new Error('Processing was interrupted by an API restart. Retry to start this stage again.'));
      // Builder recovery must keep running even while an import occupies the FIFO.
      const tick = () => { drain(); reconcile(); };
      timer = setInterval(tick, interval); timer.unref(); setImmediate(tick);
    },
    wake() { setImmediate(drain); },
    async cancel(id) {
      const job = await app.prisma.workJob.findUnique({ where: { id } });
      if (!job || terminalJob(job.status)) return false;
      const cancelled = await app.prisma.workJob.updateMany({ where: { id, status: { in: ['queued', 'running'] }, stage: { notIn: ['publishing', 'scanning'] } },
        data: { status: 'cancelled', stage: 'cancelled', completedAt: new Date() } });
      if (!cancelled.count) return false;
      const controller = controllers.get(id); controller?.abort();
      if (!controller && job.kind === 'import') {
        await rm(directory(id), { recursive: true, force: true });
      }
      await log(id, '[cancelled] Cancellation requested.');
      return true;
    },
    async stop() {
      stopped = true; clearInterval(timer);
      for (const controller of controllers.values()) controller.abort();
      while (draining || reconciling) await new Promise(resolve => setTimeout(resolve, 20));
    },
  };
}
