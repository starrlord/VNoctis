import { randomUUID, randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  stat,
  rename,
} from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { BACKUP_LIMITS, safeId } from '../services/saveBackupFormat.js';
import { backupPreview, importBackup } from '../services/saveBackupImport.js';

export default async function saveBackupRoutes(fastify, options = {}) {
  const jobs = new Map(),
    tickets = new Map();
  const root = resolve(
    options.backupPath || process.env.SAVE_BACKUP_PATH || '/data/save-backups'
  );
  let queue = Promise.resolve(),
    cleanup,
    closing = false;
  const active = new Set();
  const publicJob = (job) => ({
    id: job.id,
    kind: job.kind,
    status: job.status,
    scope: job.scope,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    progress: job.progress,
    error: job.error,
    result: job.result,
    filename: job.filename,
    summary: job.summary,
  });
  const save = async (job) => {
    job.updatedAt = new Date().toISOString();
    const record = JSON.stringify({
      ...publicJob(job),
      ownerId: job.ownerId,
      directory: job.directory,
    });
    const task = (job.saving || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await writeFile(join(job.directory, 'job.json.tmp'), record, {
          mode: 0o600,
        });
        await rename(
          join(job.directory, 'job.json.tmp'),
          join(job.directory, 'job.json')
        );
      });
    job.saving = task;
    await task;
  };
  const authenticate = async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!request.user?.userId)
      return reply.code(401).send({ message: 'Authentication required' });
    const account = await fastify.prisma.user.findUnique({
      where: { id: request.user.userId },
      select: { username: true, role: true },
    });
    if (!account)
      return reply.code(401).send({ message: 'Authentication required' });
    request.user = { ...request.user, ...account };
  };
  const getJob = (request, reply) => {
    const job = jobs.get(request.params.id);
    if (
      !job ||
      job.ownerId !== request.user.userId ||
      (job.scope === 'all-users' && request.user.role !== 'admin')
    ) {
      reply.code(404).send({ message: 'Save backup task not found' });
      return null;
    }
    return job;
  };
  async function createJob(actor, kind, scope) {
    if (
      [...jobs.values()].filter(
        (job) =>
          job.ownerId === actor.userId &&
          !['failed', 'done', 'ready', 'review', 'interrupted'].includes(
            job.status
          )
      ).length >= 2
    )
      throw Object.assign(
        new Error(
          'A save backup task is already running. Wait for it to finish.'
        ),
        { statusCode: 409 }
      );
    if (
      [...jobs.values()].filter((job) => job.ownerId === actor.userId).length >=
      20
    )
      throw Object.assign(
        new Error('Remove temporary backups before creating another task.'),
        { statusCode: 409 }
      );
    const id = randomUUID(),
      directory = join(root, id);
    const job = {
      id,
      directory,
      ownerId: actor.userId,
      kind,
      scope,
      status: 'queued',
      createdAt: new Date().toISOString(),
      progress: { stage: 'Queued' },
      error: null,
      result: null,
    };
    jobs.set(id, job);
    try {
      await mkdir(directory, { mode: 0o700 });
      await save(job);
      return job;
    } catch (error) {
      jobs.delete(id);
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  const update = (job, value) => {
    job.progress = value;
    job.updatedAt = new Date().toISOString();
  };
  async function runWorker(job, params) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL('../services/saveBackupWorker.js', import.meta.url),
        { workerData: { ...params, directory: job.directory } }
      );
      active.add(worker);
      let settled = false;
      worker.on('message', (message) => {
        if (message.progress) update(job, message.progress);
        if (message.error) {
          settled = true;
          reject(new Error(message.error));
        } else if (message.result) {
          settled = true;
          resolve(message.result);
        }
      });
      worker.on('error', reject);
      worker.on('exit', (code) => {
        active.delete(worker);
        if (!settled)
          reject(new Error('Save backup processing was interrupted.'));
      });
    });
  }
  function enqueue(job, task) {
    queue = queue
      .catch(() => {})
      .then(async () => {
        if (closing || !jobs.has(job.id)) return;
        try {
          job.status = 'working';
          await save(job);
          await task();
          await save(job);
        } catch (error) {
          job.status = 'failed';
          job.error =
            error.code === 'ENOSPC'
              ? 'Not enough server disk space to prepare the save backup.'
              : String(error.message || 'Save backup failed').slice(0, 300);
          await save(job).catch(() => {});
        }
      });
  }
  fastify.addHook('onReady', async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    // Only task directories created by this service are considered for cleanup.
    for (const item of await readdir(root, { withFileTypes: true })) {
      if (!item.isDirectory() || !safeId(item.name)) continue;
      const directory = join(root, item.name);
      try {
        const job = JSON.parse(
          await readFile(join(directory, 'job.json'), 'utf8')
        );
        if (Date.now() - Date.parse(job.createdAt) > 86400000) {
          await rm(directory, { recursive: true, force: true });
          continue;
        }
        if (job.id !== item.name || typeof job.ownerId !== 'string') continue;
        job.directory = directory;
        if (!['done', 'ready', 'review', 'failed'].includes(job.status)) {
          job.status = 'interrupted';
          job.error =
            'The server restarted. Start the export or upload the backup again.';
        }
        jobs.set(job.id, job);
      } catch {
        if (Date.now() - (await stat(directory)).mtimeMs > 86400000)
          await rm(directory, { recursive: true, force: true });
      }
    }
    cleanup = setInterval(async () => {
      for (const job of jobs.values())
        if (
          Date.now() - Date.parse(job.createdAt) > 86400000 &&
          ['done', 'ready', 'review', 'failed', 'interrupted'].includes(
            job.status
          )
        ) {
          jobs.delete(job.id);
          await rm(job.directory, { recursive: true, force: true }).catch(
            () => {}
          );
        }
      for (const [key, value] of tickets)
        if (value.expires < Date.now()) tickets.delete(key);
    }, 60000);
    cleanup.unref();
  });
  fastify.addHook('onClose', async () => {
    closing = true;
    clearInterval(cleanup);
    for (const worker of active) await worker.terminate();
    await queue;
  });

  fastify.post(
    '/save-backups/exports',
    { preHandler: authenticate },
    async (request, reply) => {
      const {
        allUsers = false,
        gameId = null,
        versionId = null,
      } = request.body || {};
      if (typeof allUsers !== 'boolean')
        return reply.code(400).send({ message: 'Invalid backup scope.' });
      if (allUsers && request.user.role !== 'admin')
        return reply
          .code(403)
          .send({ message: 'Only administrators can export all users.' });
      if (
        (gameId !== null && !safeId(gameId)) ||
        (versionId !== null && !safeId(versionId)) ||
        Boolean(gameId) !== Boolean(versionId) ||
        (allUsers && gameId)
      )
        return reply
          .code(400)
          .send({ message: 'Invalid save backup selection.' });
      const database = (
        await fastify.prisma.$queryRawUnsafe('PRAGMA database_list')
      ).find((row) => row.name === 'main')?.file;
      if (!database)
        return reply.code(409).send({
          message: 'Save backups require a persistent SQLite database.',
        });
      const job = await createJob(
        request.user,
        'export',
        allUsers ? 'all-users' : versionId ? 'snapshot' : 'account'
      );
      job.filename = `vnoctis-${versionId ? 'snapshot' : allUsers ? 'all-users-saves' : 'saves'}-${new Date().toISOString().slice(0, 10)}.zip`;
      enqueue(job, async () => {
        const result = await runWorker(job, {
          task: 'export',
          dbPath: database,
          userId: request.user.userId,
          allUsers,
          gameId,
          versionId,
        });
        job.summary = result.summary;
        job.status = 'ready';
        job.progress = { stage: 'Backup ready' };
      });
      return reply.code(202).send(publicJob(job));
    }
  );
  fastify.get(
    '/save-backups/jobs',
    { preHandler: authenticate },
    async (request) => ({
      items: [...jobs.values()]
        .filter(
          (job) =>
            job.ownerId === request.user.userId &&
            (job.scope !== 'all-users' || request.user.role === 'admin')
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20)
        .map(publicJob),
    })
  );
  fastify.get(
    '/save-backups/jobs/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const job = getJob(request, reply);
      if (job) return publicJob(job);
    }
  );
  fastify.post(
    '/save-backups/jobs/:id/download',
    { preHandler: authenticate },
    async (request, reply) => {
      const job = getJob(request, reply);
      if (!job) return;
      if (job.kind !== 'export' || job.status !== 'ready')
        return reply
          .code(409)
          .send({ message: 'The backup is not ready to download.' });
      if (job.scope === 'all-users' && request.user.role !== 'admin')
        return reply.code(403).send({ message: 'Admin access required.' });
      const ticket = randomBytes(32).toString('hex');
      tickets.set(ticket, {
        jobId: job.id,
        ownerId: job.ownerId,
        expires: Date.now() + 60000,
      });
      return {
        url: `/api/v1/save-backups/download/${ticket}`,
        filename: job.filename,
      };
    }
  );
  // A short-lived, one-use capability lets the browser stream a native download
  // without holding a multi-gigabyte ZIP in JavaScript or exposing a login JWT.
  fastify.get('/save-backups/download/:ticket', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const ticket = tickets.get(request.params.ticket);
    tickets.delete(request.params.ticket);
    const job = ticket && jobs.get(ticket.jobId);
    const user =
      ticket &&
      (await fastify.prisma.user.findUnique({
        where: { id: ticket.ownerId },
        select: { id: true, role: true },
      }));
    if (
      !ticket ||
      ticket.expires < Date.now() ||
      !job ||
      job.status !== 'ready' ||
      !user ||
      (job.scope === 'all-users' && user.role !== 'admin')
    )
      return reply.code(404).send({
        message:
          'Download expired. Request another download from Save backups.',
      });
    const filename = join(job.directory, 'backup.zip'),
      info = await stat(filename);
    return reply
      .header('Content-Disposition', `attachment; filename="${job.filename}"`)
      .header('Content-Length', info.size)
      .header('X-Content-Type-Options', 'nosniff')
      .type('application/zip')
      .send(createReadStream(filename));
  });
  fastify.post(
    '/save-backups/imports',
    { preHandler: authenticate },
    async (request, reply) => {
      const allUsers = request.query.allUsers === '1';
      if (allUsers && request.user.role !== 'admin')
        return reply
          .code(403)
          .send({ message: 'Only administrators can restore all users.' });
      const job = await createJob(
        request.user,
        'import',
        allUsers ? 'all-users' : 'account'
      );
      job.status = 'uploading';
      await save(job);
      try {
        let received = false;
        for await (const part of request.parts({
          limits: {
            fileSize: BACKUP_LIMITS.archive,
            files: 1,
            fields: 0,
            parts: 1,
          },
        })) {
          if (part.type !== 'file' || part.fieldname !== 'backup' || received)
            throw new Error('Select one save backup ZIP.');
          received = true;
          let bytes = 0;
          const meter = new Transform({
            transform(chunk, _, callback) {
              bytes += chunk.length;
              update(job, { stage: 'Uploading backup', bytesDone: bytes });
              callback(null, chunk);
            },
          });
          await pipeline(
            part.file,
            meter,
            createWriteStream(join(job.directory, 'upload.zip'), {
              flags: 'wx',
              mode: 0o600,
            })
          );
          if (part.file.truncated)
            throw new Error('Backup exceeds the 16 GiB upload limit.');
        }
        if (!received) throw new Error('Select a save backup ZIP.');
        job.status = 'queued';
        await save(job);
        enqueue(job, async () => {
          const result = await runWorker(job, { task: 'inspect' });
          job.summary = result.summary;
          job.status = 'review';
          job.progress = { stage: 'Ready for review' };
        });
        return reply.code(202).send(publicJob(job));
      } catch (error) {
        job.status = 'failed';
        job.error = error.message;
        await save(job);
        return reply.code(400).send({ message: job.error });
      }
    }
  );
  fastify.get(
    '/save-backups/jobs/:id/contents',
    { preHandler: authenticate },
    async (request, reply) => {
      const job = getJob(request, reply);
      if (!job) return;
      if (job.kind !== 'import' || job.status !== 'review')
        return reply
          .code(409)
          .send({ message: 'This backup is not ready for review.' });
      const manifest = JSON.parse(
        await readFile(join(job.directory, 'manifest.json'), 'utf8')
      );
      return {
        users:
          job.scope === 'all-users'
            ? await fastify.prisma.user.findMany({
                select: { id: true, username: true },
              })
            : [],
        installedGames: await fastify.prisma.game.findMany({
          select: { id: true, directoryName: true, extractedTitle: true },
        }),
        accounts: manifest.accounts,
        games: [
          ...new Map(
            manifest.games.map((entry) => [entry.game.id, entry.game])
          ).values(),
        ],
        legacy: manifest.scope === 'legacy',
      };
    }
  );
  fastify.post(
    '/save-backups/jobs/:id/preview',
    { preHandler: authenticate },
    async (request, reply) => {
      const job = getJob(request, reply);
      if (!job) return;
      if (job.kind !== 'import' || job.status !== 'review')
        return reply
          .code(409)
          .send({ message: 'This backup is not ready for review.' });
      const manifest = JSON.parse(
        await readFile(join(job.directory, 'manifest.json'), 'utf8')
      );
      try {
        const choices = {
          ...request.body,
          allUsers: job.scope === 'all-users',
        };
        const plan = await backupPreview(
          fastify.prisma,
          manifest,
          request.user,
          choices
        );
        job.plan = plan;
        await writeFile(
          join(job.directory, 'plan.json'),
          JSON.stringify(plan),
          { mode: 0o600 }
        );
        return {
          ...plan,
          sourceAccounts: manifest.accounts,
          sourceGames: [
            ...new Map(
              manifest.games.map((entry) => [entry.game.id, entry.game])
            ).values(),
          ],
        };
      } catch (error) {
        return reply
          .code(400)
          .send({ message: error.message, sourceAccounts: manifest.accounts });
      }
    }
  );
  fastify.post(
    '/save-backups/jobs/:id/apply',
    { preHandler: authenticate },
    async (request, reply) => {
      const job = getJob(request, reply);
      if (!job) return;
      if (
        job.status === 'working' ||
        job.status === 'queued' ||
        job.status === 'done'
      )
        return publicJob(job);
      if (job.kind !== 'import' || job.status !== 'review')
        return reply
          .code(409)
          .send({ message: 'This backup is not ready to restore.' });
      if (job.scope === 'all-users' && request.user.role !== 'admin')
        return reply.code(403).send({ message: 'Admin access required.' });
      const plan =
        job.plan ||
        JSON.parse(
          await readFile(join(job.directory, 'plan.json'), 'utf8').catch(
            () => 'null'
          )
        );
      if (!plan || plan.id !== request.body?.planId)
        return reply
          .code(409)
          .send({ message: 'Review this backup again before importing.' });
      if (!plan.rows.length)
        return reply
          .code(400)
          .send({ message: 'Select at least one game to import.' });
      // Reserve the reviewed task before any filesystem awaits so duplicate
      // Apply requests cannot schedule the same import twice.
      if (job.status !== 'review') return publicJob(job);
      job.status = 'queued';
      let manifest;
      try {
        manifest = JSON.parse(
          await readFile(join(job.directory, 'manifest.json'), 'utf8')
        );
        await save(job);
      } catch (error) {
        job.status = 'review';
        throw error;
      }
      enqueue(job, async () => {
        const owner = await fastify.prisma.user.findUnique({
          where: { id: job.ownerId },
          select: { role: true },
        });
        if (!owner || (job.scope === 'all-users' && owner.role !== 'admin'))
          throw new Error('Backup restore authorization changed.');
        job.result = await importBackup(
          fastify.prisma,
          manifest,
          plan,
          job.directory,
          (progress) => update(job, progress)
        );
        job.status = 'done';
        job.progress = { stage: 'Import complete' };
      });
      return reply.code(202).send(publicJob(job));
    }
  );
  fastify.delete(
    '/save-backups/jobs/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const job = getJob(request, reply);
      if (!job) return;
      if (['working', 'queued', 'uploading'].includes(job.status))
        return reply.code(409).send({
          message: 'Wait for this task to finish before removing it.',
        });
      await job.saving;
      jobs.delete(job.id);
      await rm(job.directory, { recursive: true, force: true });
      return reply.code(204).send();
    }
  );
}
