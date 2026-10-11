import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, open } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { archiveType, registerImportJobs } from '../services/importJobs.js';

export default async function importRoutes(app) {
  const games = process.env.GAMES_PATH || '/games';
  const maxBytes = (Number(process.env.MAX_IMPORT_SIZE_MB) || 24576) * 1024 * 1024;
  registerImportJobs(app, games, maxBytes);
  app.post('/library/import', { bodyLimit: maxBytes }, async (request, reply) => {
    const data = await request.file({ limits: { fileSize: maxBytes } });
    if (!data) return reply.code(400).send({ message: 'Select a game archive.' });
    const name = basename(data.filename || 'import.zip'), suffix = archiveType(name);
    if (!suffix) { data.file.resume(); return reply.code(400).send({ message: 'Select a .zip, .tar.bz2, or .rar archive.' }); }
    const id = randomUUID(), directory = app.jobRunner.directory(id), archive = join(directory, `archive${suffix}`);
    let accepted = false;
    try {
      await mkdir(directory, { recursive: true });
      await pipeline(data.file, createWriteStream(archive));
      if (data.file.truncated) throw Object.assign(new Error('Upload exceeds the import size limit.'), { statusCode: 413 });
      if (!(await stat(archive)).size) throw Object.assign(new Error('The uploaded archive is empty.'), { statusCode: 400 });
      const uploaded = await open(archive, 'r+');
      try { await uploaded.sync(); } finally { await uploaded.close(); }
      await app.jobRunner.create({ id, kind: 'import', ownerId: request.user?.userId, title: name, input: { name, archive } });
      accepted = true; app.jobRunner.wake();
      return reply.code(202).send({ jobId: id, status: 'queued', message: 'Upload accepted. Processing continues in the background.' });
    } finally {
      if (!accepted) await rm(directory, { recursive: true, force: true });
    }
  });
  app.post('/library/import-url', async (request, reply) => {
    const value = request.body?.url;
    let url;
    try { url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); }
    catch { return reply.code(400).send({ message: 'Enter a valid HTTP or HTTPS download URL.' }); }
    let name = basename(url.pathname) || 'download.zip';
    if (!archiveType(name)) name += '.zip';
    const job = await app.jobRunner.create({ kind: 'import', ownerId: request.user?.userId, title: name, input: { name, url: url.href } });
    app.jobRunner.wake();
    return reply.code(202).send({ jobId: job.id, status: 'queued' });
  });
}
