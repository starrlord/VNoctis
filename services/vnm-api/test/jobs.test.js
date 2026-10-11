import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { PrismaClient } from '@prisma/client';
import jobsRoutes from '../src/routes/jobs.js';
import buildRoutes from '../src/routes/build.js';
import internalRoutes from '../src/routes/internal.js';
import importRoutes from '../src/routes/import.js';
import libraryRoutes from '../src/routes/library.js';
import { createJobRunner, jobFailureMessage } from '../src/services/jobRunner.js';
import { appendJobLog, readJobLog } from '../src/services/jobLogs.js';
import { appendLogChunk } from '../../vnm-ui/src/utils/jobLog.js';

const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out waiting for job');
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vnm-jobs-'));
  const url = `file:${join(root, 'test.db').replaceAll('\\', '/')}`;
  const database = new DatabaseSync(join(root, 'test.db'));
  for (const name of readdirSync('prisma/migrations').sort()) {
    if (name !== 'migration_lock.toml') database.exec(readFileSync(join('prisma/migrations', name, 'migration.sql'), 'utf8'));
  }
  database.exec('ALTER TABLE Game ADD COLUMN publishStatus TEXT NOT NULL DEFAULT "not_published"; ALTER TABLE Game ADD COLUMN publishedAt DATETIME; ALTER TABLE Game ADD COLUMN publishedVersion TEXT;');
  database.close();
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const app = Fastify({ logger: false });
  app.decorate('prisma', prisma);
  app.addHook('onRequest', async request => { if (request.headers['x-role']) request.user = { role: request.headers['x-role'], userId: 'admin' }; });
  process.env.WEB_BUILDS_PATH = root;
  const runner = createJobRunner(app, { storage: join(root, 'imports'), logs: root, interval: 50, reconcileInterval: 50 });
  runner.wake = () => {}; // Request tests observe acceptance before any worker runs.
  app.decorate('jobRunner', runner);
  await app.register(multipart);
  await app.register(jobsRoutes, { prefix: '/api/v1' });
  await app.register(buildRoutes, { prefix: '/api/v1' });
  await app.register(internalRoutes, { prefix: '/api/v1' });
  await app.register(importRoutes, { prefix: '/api/v1' });
  await app.register(libraryRoutes, { prefix: '/api/v1' });
  await app.ready();
  t.after(async () => { await runner.stop(); await app.close(); await prisma.$disconnect(); await rm(root, { recursive: true, force: true }); });
  const gameId = 'a'.repeat(32);
  await prisma.game.create({ data: { id: gameId, directoryPath: join(root, 'game'), directoryName: 'game', extractedTitle: 'Test Game' } });
  return { app, prisma, root, runner, gameId };
}
const admin = { 'x-role': 'admin' };

test('job cards report actionable errors while detailed tracebacks stay in the log', () => {
  assert.equal(jobFailureMessage({ code: 'EEXIST' }), 'A game folder with this name already exists. Nothing was overwritten.');
  assert.equal(jobFailureMessage({ stderr: 'Traceback:\nzipfile.BadZipFile: File is not a zip file' }), 'The archive is damaged or is not a supported ZIP file.');
  assert.equal(jobFailureMessage({ stderr: 'Traceback:\nValueError: Archive contains an unsafe path or link: ../escape' }), 'Archive contains an unsafe path or link: ../escape');
});

test('log cursors preserve UTF-8, partial lines, and resume without duplicates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vnm-log-')); t.after(() => rm(root, { recursive: true, force: true }));
  const original = `${'a'.repeat(65535)}🎮\r\n\r\nsecond\npartial`;
  await mkdir(join(root, 'logs')); await writeFile(join(root, 'logs', 'test.log'), original);
  let offset = 0, text = '';
  do { const chunk = await readJobLog(root, 'test', offset); assert.ok(chunk.offset > offset); offset = chunk.offset; text += chunk.text; } while (offset < Buffer.byteLength(original));
  assert.equal(text, original);
  const parsed = appendLogChunk('first\r\n\r\npart'); assert.deepEqual(parsed.lines, ['first']);
  assert.deepEqual(appendLogChunk('ial\nlast', parsed.pending, true).lines, ['partial', 'last']);
  await assert.rejects(readJobLog(root, '../secret'), /Invalid job/);
  await assert.rejects(readJobLog(root, 'test', -1), /Invalid log cursor/);
  assert.equal((await readJobLog(root, 'test', offset + 1)).reset, true);
});

test('job snapshots and full logs require admin; private job input is excluded', async t => {
  const { app, runner } = await fixture(t);
  const job = await runner.create({ kind: 'import', title: 'Test.zip', input: { url: 'https://private.example/token' } });
  assert.equal((await app.inject('/api/v1/jobs')).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/v1/jobs', headers: { 'x-role': 'viewer' } })).statusCode, 403);
  const result = await app.inject({ url: `/api/v1/jobs/${job.id}`, headers: admin });
  assert.equal(result.statusCode, 200); assert.equal(result.json().input, undefined);
  const log = await app.inject({ url: `/api/v1/jobs/${job.id}/log?download=1`, headers: admin });
  assert.equal(log.statusCode, 200); assert.match(log.body, /queued/);
  assert.equal((await app.inject({ url: `/api/v1/jobs/${job.id}/log?offset=-1`, headers: admin })).statusCode, 400);
});

test('build acceptance is detached, duplicate builds rejected, late callbacks cannot resurrect cancellation', async t => {
  const { app, prisma, gameId } = await fixture(t);
  const accepted = await app.inject({ method: 'POST', url: `/api/v1/build/${gameId}`, headers: admin, payload: {} });
  assert.equal(accepted.statusCode, 202); const { jobId } = accepted.json();
  assert.equal((await prisma.workJob.findUnique({ where: { id: jobId } })).status, 'queued');
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/build/${gameId}`, headers: admin, payload: {} })).statusCode, 409);
  assert.equal(await prisma.buildJob.count(), 1);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/build/${jobId}`, headers: admin })).statusCode, 200);
  await app.inject({ method: 'POST', url: `/api/v1/internal/build/${jobId}/status`, payload: { status: 'done', webBuildPath: '/unexpected' } });
  assert.equal((await prisma.buildJob.findUnique({ where: { id: jobId } })).status, 'cancelled');
  assert.equal((await prisma.game.findUnique({ where: { id: gameId } })).webBuildPath, null);
});

test('worker callbacks update stage and retain the current build identity', async t => {
  const { app, prisma, gameId } = await fixture(t);
  const { jobId } = (await app.inject({ method: 'POST', url: `/api/v1/build/${gameId}`, headers: admin, payload: {} })).json();
  await app.inject({ method: 'POST', url: `/api/v1/internal/build/${jobId}/status`, payload: { status: 'building', stage: 'optimizing' } });
  assert.equal((await prisma.workJob.findUnique({ where: { id: jobId } })).stage, 'optimizing');
  await app.inject({ method: 'POST', url: `/api/v1/internal/build/${jobId}/status`, payload: { status: 'done', webBuildPath: '/web-builds/game' } });
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  assert.equal(game.buildJobId, jobId); assert.equal(game.buildStatus, 'built');
});

test('uploads persist before acknowledgement; URL imports are queued without downloading', async t => {
  const { app, prisma } = await fixture(t);
  const payload = Buffer.from('--boundary\r\nContent-Disposition: form-data; name="file"; filename="game.zip"\r\nContent-Type: application/zip\r\n\r\narchive bytes\r\n--boundary--\r\n');
  const response = await app.inject({ method: 'POST', url: '/api/v1/library/import', headers: { ...admin, 'content-type': 'multipart/form-data; boundary=boundary' }, payload });
  assert.equal(response.statusCode, 202);
  const job = await prisma.workJob.findUnique({ where: { id: response.json().jobId } });
  assert.equal(await readFile(JSON.parse(job.input).archive, 'utf8'), 'archive bytes');
  const remote = await app.inject({ method: 'POST', url: '/api/v1/library/import-url', headers: admin, payload: { url: 'https://example.invalid/game.zip' } });
  assert.equal(remote.statusCode, 202);
});

test('FIFO cancellation releases the worker and processes the next queued job', async t => {
  const { prisma, runner } = await fixture(t);
  const started = [];
  runner.register('import', async (job, input, context) => {
    started.push(input.order);
    if (input.order === 1) await new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
    else { await context.log('finished'); await context.progress({ status: 'done', stage: 'done', completedAt: new Date() }); }
  });
  const first = await runner.create({ kind: 'import', title: 'one', input: { order: 1 } });
  const second = await runner.create({ kind: 'import', title: 'two', input: { order: 2 } });
  await runner.start(); await waitFor(() => started.length === 1); assert.equal(await runner.cancel(first.id), true);
  await waitFor(async () => (await prisma.workJob.findUnique({ where: { id: second.id } })).status === 'done');
  assert.deepEqual(started, [1, 2]);
  assert.equal((await prisma.workJob.findUnique({ where: { id: first.id } })).status, 'cancelled');
});

test('a long import does not delay recovery of a lost build completion callback', async t => {
  const { app, prisma, runner, gameId } = await fixture(t);
  let completed = false, importing = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: completed ? 'done' : 'building', webBuildPath: '/web-builds/game' }), { status: 200 });
  t.after(() => { globalThis.fetch = originalFetch; });
  runner.register('import', async (job, input, context) => {
    importing = true;
    await new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
  });
  const upload = await runner.create({ kind: 'import', title: 'large archive', input: {} });
  const { jobId } = (await app.inject({ method: 'POST', url: `/api/v1/build/${gameId}`, headers: admin, payload: {} })).json();
  await prisma.workJob.update({ where: { id: jobId }, data: { status: 'running', stage: 'packaging' } });
  await runner.start();
  await waitFor(() => importing);
  completed = true;
  await waitFor(async () => (await prisma.workJob.findUnique({ where: { id: jobId } })).status === 'done');
  assert.equal((await prisma.workJob.findUnique({ where: { id: upload.id } })).status, 'running');
  assert.equal((await prisma.game.findUnique({ where: { id: gameId } })).buildStatus, 'built');
});

test('restart marks an interrupted published import failed and retry resumes registration', async t => {
  const { app, prisma, runner, root } = await fixture(t);
  const job = await runner.create({ kind: 'import', title: 'restart', input: { name: 'restart.zip', archive: join(root, 'missing.zip') } });
  const result = { folderName: 'restart', path: '/games/restart' };
  await prisma.workJob.update({ where: { id: job.id }, data: { status: 'running', stage: 'scanning', result: JSON.stringify(result) } });
  await runner.start();
  assert.equal((await prisma.workJob.findUnique({ where: { id: job.id } })).status, 'failed');
  const retried = await app.inject({ method: 'POST', url: `/api/v1/jobs/${job.id}/retry`, headers: admin });
  assert.equal(retried.statusCode, 202);
  const retry = await prisma.workJob.findUnique({ where: { id: retried.json().jobId } });
  assert.deepEqual(JSON.parse(retry.input).publishedResult, result);
});

test('cancellation refuses publication and leaves staged game data intact', async t => {
  const { prisma, runner } = await fixture(t);
  const job = await runner.create({ kind: 'import', title: 'publishing', input: {} });
  await prisma.workJob.update({ where: { id: job.id }, data: { status: 'running', stage: 'publishing' } });
  assert.equal(await runner.cancel(job.id), false);
  assert.equal((await prisma.workJob.findUnique({ where: { id: job.id } })).status, 'running');
});

test('failed rebuild keeps a previously validated game playable', async t => {
  const { app, prisma, root, gameId } = await fixture(t);
  await mkdir(join(root, 'game')); await writeFile(join(root, 'game/index.html'), 'previous build');
  await prisma.game.update({ where: { id: gameId }, data: { buildStatus: 'built', webBuildPath: '/web-builds/game', builtAt: new Date() } });
  const { jobId } = (await app.inject({ method: 'POST', url: `/api/v1/build/${gameId}`, headers: admin, payload: {} })).json();
  await app.inject({ method: 'POST', url: `/api/v1/internal/build/${jobId}/status`, payload: { status: 'failed', error: 'SDK failed' } });
  assert.equal((await prisma.game.findUnique({ where: { id: gameId } })).buildStatus, 'built');
  assert.equal((await prisma.workJob.findUnique({ where: { id: jobId } })).status, 'failed');
  assert.equal(await readFile(join(root, 'game/index.html'), 'utf8'), 'previous build');
});

test('removing a terminal job protects uploads referenced by another retry', async t => {
  const { app, prisma, runner } = await fixture(t);
  const source = await runner.create({ kind: 'import', title: 'source', input: {} });
  const archive = join(runner.directory(source.id), 'archive.zip'); await writeFile(archive, 'archive');
  await prisma.workJob.update({ where: { id: source.id }, data: { status: 'failed' } });
  const retry = await runner.create({ kind: 'import', title: 'retry', input: { archive } });
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/jobs/${retry.id}`, headers: admin })).statusCode, 409);
  const removed = await app.inject({ method: 'DELETE', url: `/api/v1/jobs/${source.id}`, headers: admin });
  assert.equal(removed.statusCode, 200); assert.equal(removed.json().archiveRetainedForRetry, true);
  assert.equal(await readFile(archive, 'utf8'), 'archive');
});


test('compression status reflects published metadata and force choice survives acceptance', async t => {
  const { app, prisma, root, gameId } = await fixture(t);
  let response = await app.inject({ method: 'GET', url: '/api/v1/library/' + gameId + '/compression', headers: admin });
  assert.deepEqual(response.json(), { compressed: null, reusableImages: 0 });
  await mkdir(join(root, 'game')); await writeFile(join(root, 'game/.vnm-compression.json'), JSON.stringify({ version: 1, compressed: true, reusableImages: 42 }));
  await writeFile(join(root, 'game/.vnm-assets.json'), '{}');
  response = await app.inject({ method: 'GET', url: '/api/v1/library/' + gameId + '/compression', headers: admin });
  assert.deepEqual(response.json(), { compressed: true, reusableImages: 42 });
  response = await app.inject({ method: 'POST', url: '/api/v1/build/' + gameId, headers: admin, payload: { compressAssets: false, forceRecompress: true } });
  assert.equal(response.statusCode, 400);
  response = await app.inject({ method: 'POST', url: '/api/v1/build/' + gameId, headers: admin, payload: { compressAssets: true, forceRecompress: true } });
  const work = await prisma.workJob.findUnique({ where: { id: response.json().jobId } });
  assert.deepEqual(JSON.parse(work.input), { compressAssets: true, forceRecompress: true });
});
