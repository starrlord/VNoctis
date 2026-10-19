import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import savesRoutes from '../src/routes/saves.js';
import { archive, canonical, collectBlobs, digest, prune, retainedIds, saveChecksum, writeTransaction } from '../src/services/saveHistory.js';

const encoded = value => Buffer.from(value).toString('base64');
test('history uploads only new blob bytes and skips garbage collection when nothing expires', async () => {
  const previous = Buffer.from('existing save');
  const added = Buffer.from('new save');
  const writes = [];
  const tx = {
    saveFileBlob: { findMany: async () => [{ hash: digest(previous) }] },
    $executeRawUnsafe: async (...args) => { writes.push(args); },
    saveVersion: {
      create: async () => {},
      findMany: async () => [{ id: 'current', kind: 'manual', alternate: false, createdAt: new Date() }],
      deleteMany: async () => { assert.fail('Current version must remain'); },
    },
    saveVersionFile: { createMany: async () => {} },
  };
  await archive(tx, { version: 1, files: [
    { path: '1.save', mtime: 1, data: previous.toString('base64') },
    { path: '2.save', mtime: 1, data: added.toString('base64') },
  ] }, { userId: 'A', gameId: 'X', kind: 'manual' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1], digest(added));
  assert.deepEqual(writes[0][2], added);
  assert.equal(writes[0].length, 4);
  await prune(tx, { userId: 'A', gameId: 'X' }, 'current');
  assert.equal(writes.length, 1, 'No global blob scan for a retained version');
});

const autoSnapshot = step => ({ version: 1, files: [
  ...Array.from({ length: 10 }, (_, index) => ({ path: `game/auto-${index + 1}-LT1.save`, mtime: 1000,
    data: encoded(`progress ${Math.max(0, step - index)}`) })),
  { path: 'game/persistent', mtime: 1000, data: encoded('preferences') },
  { path: 'tokens/security_keys.txt', mtime: 1000, data: encoded('signing keys') },
] });

test('retention preserves 90 recent autosaves, separate manual history, and unresolved alternatives', () => {
  const now = Date.UTC(2026, 9, 6, 12), hour = 3600000, day = 24 * hour;
  const versions = [];
  const add = (id, age, kind = 'auto', alternate = false) => versions.push({ id, kind, alternate, createdAt: new Date(now - age) });
  for (let i = 0; i < 90; i++) add(`auto-${i}`, i * 120000);
  for (let i = 0; i < 60; i++) add(`manual-${i}`, (i + 1) * day, 'manual');
  add('hour-new', 2 * day + 5 * 60000); add('hour-old', 2 * day + 15 * 60000);
  add('next-hour', 2 * day + hour + 5 * 60000);
  add('day-new', 8 * day + hour); add('day-old', 8 * day + 2 * hour);
  add('expired-auto', 31 * day); add('old-alternate', 365 * day, 'auto', true);
  add('old-current', 365 * day);
  const keep = retainedIds(versions, 'old-current', now);
  assert.equal(versions.filter(v => v.id.startsWith('auto-') && keep.has(v.id)).length, 90);
  assert.equal(versions.filter(v => v.kind === 'manual' && keep.has(v.id)).length, 40);
  for (const id of ['hour-new', 'next-hour', 'day-new', 'old-alternate', 'old-current']) assert.ok(keep.has(id), id);
  for (const id of ['hour-old', 'day-old', 'expired-auto']) assert.ok(!keep.has(id), id);
});

test('deduplicated server history restores rotating RenPy slots without adding files', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'vnm-history-'));
  const prisma = new PrismaClient({ datasourceUrl: `file:${join(directory, 'test.db').replaceAll('\\', '/')}` });
  const app = Fastify(); app.decorate('prisma', prisma);
  try {
    const migrations = new URL('../prisma/migrations/', import.meta.url);
    for (const name of readdirSync(migrations).filter(name => name !== 'migration_lock.toml').sort()) {
      const sql = readFileSync(new URL(`${name}/migration.sql`, migrations), 'utf8');
      for (const statement of sql.split(';').filter(statement => statement.trim())) await prisma.$executeRawUnsafe(statement);
    }
    await prisma.user.createMany({ data: ['A', 'B'].map(id => ({ id, username: id, passwordHash: 'unused' })) });
    for (const id of ['X', 'Y']) await prisma.$executeRawUnsafe('INSERT INTO Game (id,directoryPath,directoryName,extractedTitle,updatedAt) VALUES (?,?,?,?,?)', id, `/games/${id}`, id, id, new Date());
    app.addHook('onRequest', async (request, reply) => {
      if (!['A', 'B'].includes(request.headers.authorization)) return reply.code(401).send({});
      request.user = { userId: request.headers.authorization };
    });
    await app.register(savesRoutes, { prefix: '/api/v1' });
    const call = (method, path = '', payload, user = 'A', game = 'X') => app.inject({ method,
      url: `/api/v1/games/${game}/saves${path}`, headers: { authorization: user }, payload });
    const put = (revision, step, uploadId = `auto-${step}`, extra = {}) => call('PUT', '', {
      revision, snapshot: autoSnapshot(step), uploadId, deviceLabel: 'Desktop browser', ...extra,
    });
    let firstId;
    await t.test('90 autosaves retain every recent version while the live folder has only ten slots', async () => {
      for (let step = 1; step <= 90; step++) {
        const result = await put(step - 1, step);
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(result.json().revision, step);
        if (step === 1) firstId = result.json().versionId;
      }
      const live = (await call('GET')).json();
      assert.equal(live.snapshot.files.filter(file => file.path.endsWith('.save')).length, 10);
      assert.deepEqual(live.snapshot.files.map(file => file.path).sort(), autoSnapshot(90).files.map(file => file.path).sort());
      assert.equal(await prisma.saveVersion.count(), 90);
      assert.ok(await prisma.saveFileBlob.count() <= 93, 'rotating files share content blobs rather than duplicating ten files per version');
      const first = (await call('GET', `/history/${firstId}`)).json();
      assert.deepEqual(first.snapshot.files.map(file => file.path).sort(), autoSnapshot(1).files.map(file => file.path).sort());
      assert.equal(first.snapshot.files.find(file => file.path === 'game/auto-1-LT1.save').data, encoded('progress 1'));
      const page1 = (await call('GET', '/history')).json();
      assert.equal(page1.versions.length, 50); assert.equal(page1.nextOffset, 50);
      assert.equal((await call('GET', '/history?offset=50')).json().versions.length, 40);
    });
    await t.test('persistent-only updates do not fill history, and history is isolated by user and game', async () => {
      const copy = autoSnapshot(90); copy.files.find(file => file.path.endsWith('persistent')).data = encoded('new preferences');
      assert.equal((await call('PUT', '', { revision: 90, snapshot: copy, uploadId: 'preferences' })).json().revision, 91);
      await call('GET', '/history');
      assert.equal(await prisma.saveVersion.count(), 90);
      await writeTransaction(prisma, collectBlobs);
      assert.deepEqual((await call('GET')).json().snapshot, canonical(copy), 'Current-only preferences survive garbage collection');
      const state = await prisma.saveSyncState.findUnique({ where: { userId_gameId: { userId: 'A', gameId: 'X' } } });
      assert.equal(JSON.parse(state.payload).storage, 'blobs');
      assert.equal(await prisma.saveCurrentFile.count({ where: { userId: 'A', gameId: 'X' } }), copy.files.length);
      assert.equal((await call('GET', '/history', undefined, 'B')).json().versions.length, 0);
      for (const [method, path, body] of [['GET', `/history/${firstId}`], ['POST', `/history/${firstId}/restore`, { revision: 0, uploadId: 'attack' }], ['DELETE', `/history/${firstId}`]]) {
        assert.equal((await call(method, path, body, 'B')).statusCode, 404);
        assert.equal((await call(method, path, body, 'A', 'Y')).statusCode, 404);
      }
    });
    let alternateId;
    await t.test('independent saves become alternatives and lost responses stay acknowledged after later progress', async () => {
      const alternate = await put(1, 999, 'phone-offline', { baseSaveChecksum: saveChecksum(autoSnapshot(1)), deviceLabel: 'Mobile browser' });
      assert.equal(alternate.statusCode, 200);
      assert.equal(alternate.json().disposition, 'alternate'); alternateId = alternate.json().versionId;
      assert.equal((await call('GET')).json().revision, 91);
      const repeat = await put(1, 999, 'phone-offline');
      assert.equal(repeat.json().versionId, alternateId);
      assert.equal(await prisma.saveVersion.count({ where: { alternate: true } }), 1);
      const later = await put(1, 1000, 'phone-offline-later', { alternate: true, branchId: alternate.json().branchId, deviceLabel: 'Mobile browser' });
      assert.equal(later.json().branchId, alternate.json().branchId);
      assert.equal(await prisma.saveVersion.count({ where: { alternate: true } }), 2);
      assert.equal((await put(0, 1, 'auto-1')).json().revision, 1);
      assert.equal((await call('GET', '?uploadId=auto-1')).json().acknowledgement.revision, 1);
      assert.equal((await call('GET')).json().revision, 91);
    });
    await t.test('restore preserves current progress and writes exactly the original ten-slot snapshot', async () => {
      const stale = await call('POST', `/history/${firstId}/restore`, { revision: 90, uploadId: 'stale-restore' });
      assert.equal(stale.statusCode, 409);
      const response = await call('POST', `/history/${firstId}/restore`, { revision: 91, uploadId: 'restore-first' });
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().revision, 92);
      const live = (await call('GET')).json();
      assert.deepEqual(live.snapshot.files.map(file => file.path).sort(), autoSnapshot(1).files.map(file => file.path).sort());
      assert.equal(live.snapshot.files.find(file => file.path === 'game/auto-1-LT1.save').data, encoded('progress 1'));
      assert.equal(live.snapshot.files.find(file => file.path.startsWith('tokens/')).data, encoded('signing keys'));
      assert.equal((await call('DELETE', `/history/${live.currentVersionId}`)).statusCode, 409);
      const backup = await prisma.saveVersion.findFirst({ where: { userId: 'A', gameId: 'X', kind: 'checkpoint', revision: 91 } });
      assert.ok(backup, 'exact current tree is backed up before restore');
      assert.equal((await call('POST', `/history/${firstId}/restore`, { revision: 91, uploadId: 'restore-first' })).json().revision, 92);
      const promote = await call('POST', `/history/${alternateId}/restore`, { revision: 92, uploadId: 'restore-alternate' });
      assert.equal(promote.statusCode, 200);
      assert.equal((await prisma.saveVersion.findUnique({ where: { id: alternateId } })).alternate, false);
      assert.equal(await prisma.saveVersion.count({ where: { alternate: true } }), 0, 'restoring a continuation resolves its earlier alternatives too');
    });
    await t.test('deleted history releases unreferenced bytes but retains receipts and shared content', async () => {
      const unique = await put(0, 5000, 'unique-alternate');
      const id = unique.json().versionId, count = await prisma.saveFileBlob.count();
      assert.equal((await call('DELETE', `/history/${id}`)).statusCode, 200);
      assert.ok(await prisma.saveFileBlob.count() < count);
      assert.ok(await prisma.saveVersionFile.count({ where: { hash: { in: (await prisma.saveFileBlob.findMany({ select: { hash: true } })).map(blob => blob.hash) } } }) > 0);
      assert.equal((await put(0, 5000, 'unique-alternate')).json().versionId, id);
      assert.equal((await call('GET', `/history/${id}`)).statusCode, 404);
    });
    await t.test('large legacy snapshots convert to compact live references and reuse unchanged bytes', async () => {
      const large = Buffer.alloc(2 * 1024 * 1024, 42);
      const initial = { version: 1, files: [
        { path: 'game/1.save', mtime: 1000, data: large.toString('base64') },
        { path: 'game/2.save', mtime: 1000, data: encoded('old slot') },
      ] };
      const key = { userId: 'A', gameId: 'Y' };
      const payload = JSON.stringify(canonical(initial));
      await prisma.saveSyncState.create({ data: { ...key, gameTitle: 'Y', revision: 4, payload, checksum: digest(payload) } });
      assert.deepEqual((await call('GET', '', undefined, 'A', 'Y')).json().snapshot, canonical(initial));
      const next = structuredClone(initial); next.files[1].data = encoded('new slot');
      const result = await call('PUT', '', { revision: 4, snapshot: next, uploadId: 'compact-large' }, 'A', 'Y');
      assert.equal(result.statusCode, 200, result.body);
      const state = await prisma.saveSyncState.findUnique({ where: { userId_gameId: key } });
      assert.ok(state.payload.length < 1024, 'Live row contains references rather than MB of unchanged save bytes');
      assert.deepEqual((await call('GET', '', undefined, 'A', 'Y')).json().snapshot, canonical(next));
      assert.equal(await prisma.saveFileBlob.count({ where: { hash: digest(large) } }), 1);
      assert.equal(await prisma.saveCurrentFile.count({ where: key }), 2);
      const oldVersion = await prisma.saveVersion.findFirst({ where: { ...key, revision: 4 } });
      assert.deepEqual((await call('GET', `/history/${oldVersion.id}`, undefined, 'A', 'Y')).json().snapshot, canonical(initial));
    });
    await t.test('delta updates retain complete history and idempotent receipts, reject stale bases, and validate the merged tree', async () => {
      const initial = autoSnapshot(1);
      const ownCall = (method, path, body) => call(method, path, body, 'B', 'Y');
      assert.equal((await ownCall('PUT', '', { revision: 0, snapshot: initial, uploadId: 'delta-initial' })).statusCode, 200);
      const changed = { ...initial.files[0], data: encoded('delta progress') };
      const patch = { revision: 1, uploadId: 'delta-next', delta: { version: 1, files: [changed], deleted: ['game/auto-10-LT1.save'] } };
      const accepted = await ownCall('PUT', '', patch);
      assert.equal(accepted.statusCode, 200, accepted.body);
      assert.equal(accepted.json().revision, 2);
      const expected = canonical({ version: 1, files: initial.files.filter(f => f.path !== changed.path && !patch.delta.deleted.includes(f.path)).concat(changed) });
      assert.deepEqual((await ownCall('GET', '')).json().snapshot, expected);
      assert.deepEqual((await ownCall('GET', `/history/${accepted.json().versionId}`)).json().snapshot, expected);
      const advance = structuredClone(expected); advance.files[0].data = encoded('newer device');
      assert.equal((await ownCall('PUT', '', { revision: 2, snapshot: advance, uploadId: 'delta-advance' })).json().revision, 3);
      assert.equal((await ownCall('DELETE', `/history/${accepted.json().versionId}`)).statusCode, 200);
      assert.equal((await ownCall('PUT', '', patch)).json().revision, 2, 'Receipt survives later writes and history deletion');
      assert.equal((await ownCall('GET', '')).json().revision, 3);
      const stale = { ...patch, uploadId: 'delta-stale' };
      const rejected = await ownCall('PUT', '', stale);
      assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().code, 'SAVE_BASE_CHANGED');
      const fallback = await ownCall('PUT', '', { revision: 1, snapshot: expected, uploadId: stale.uploadId });
      assert.equal(fallback.json().disposition, 'alternate');
      assert.equal((await ownCall('GET', '')).json().revision, 3);
      const invalid = await ownCall('PUT', '', { revision: 3, uploadId: 'delta-invalid',
        delta: { version: 1, files: [{ path: 'game', mtime: 1, data: encoded('file replacing a directory') }], deleted: [] } });
      assert.equal(invalid.statusCode, 400);
      assert.equal(invalid.json().code, 'SAVE_INVALID_RESULT');
      assert.equal((await ownCall('GET', '')).json().revision, 3);
      assert.equal((await ownCall('PUT', '', { ...patch, delta: { ...patch.delta, files: [{ ...changed, data: encoded('reused ID') }] } })).statusCode, 409);
    });
    await t.test('folder imports back up current saves, preserve keys, isolate users, and retry idempotently', async () => {
      const ownCall = (method, path, body) => call(method, path, body, 'B', 'Y');
      const before = (await ownCall('GET', '')).json();
      const priorCount = await prisma.saveVersion.count({ where: { userId: 'B', gameId: 'Y' } });
      const snapshot = { version: 1, files: [{ path: 'game/1.save', mtime: 1234, data: encoded('imported native progress') }] };
      const body = { revision: before.revision, uploadId: 'folder-import', snapshot };
      assert.equal((await ownCall('POST', '/directory', { directory: 'game' })).statusCode, 200);
      const wrongDestination = await ownCall('POST', '/history/import', { ...body, snapshot: { version: 1,
        files: [{ ...snapshot.files[0], path: 'saves/1.save' }] } });
      assert.equal(wrongDestination.statusCode, 409);
      assert.deepEqual((await ownCall('GET', '')).json().snapshot, before.snapshot);
      assert.equal(await prisma.saveVersion.count({ where: { userId: 'B', gameId: 'Y' } }), priorCount);
      assert.equal((await ownCall('POST', '/history/import', { ...body, revision: 0 })).statusCode, 409);
      const imported = await ownCall('POST', '/history/import', body);
      assert.equal(imported.statusCode, 200, imported.body);
      const after = (await ownCall('GET', '')).json();
      assert.equal(after.revision, before.revision + 1);
      assert.equal(after.snapshot.files.find(file => file.path === 'game/1.save').data, snapshot.files[0].data);
      assert.equal(after.snapshot.files.filter(file => file.path.endsWith('.save')).length, 1);
      assert.equal(after.snapshot.files.find(file => file.path === 'tokens/security_keys.txt').data,
        before.snapshot.files.find(file => file.path === 'tokens/security_keys.txt').data);
      const version = await prisma.saveVersion.findUnique({ where: { id: imported.json().versionId } });
      assert.equal(version.kind, 'imported');
      // A lost response is still acknowledged after a runtime-directory change.
      await ownCall('POST', '/directory', { directory: 'changed-game' });
      assert.equal((await ownCall('POST', '/history/import', body)).json().versionId, version.id);
      assert.equal(await prisma.saveVersion.count({ where: { userId: 'B', gameId: 'Y' } }), priorCount + 1);
      assert.equal((await call('GET', `/history/${version.id}`, undefined, 'A', 'Y')).statusCode, 404);
      assert.equal((await ownCall('POST', '/history/import', { ...body, snapshot: { version: 1, files: [{ path: '../1.save', mtime: 0, data: '' }] } })).statusCode, 400);
      assert.equal((await ownCall('POST', '/history/import', { ...body, snapshot: { version: 1, files: [{ path: 'game/1.save', mtime: 1, data: encoded('different') }] } })).statusCode, 409);
      const restore = await ownCall('POST', `/history/${before.currentVersionId}/restore`, { revision: after.revision, uploadId: 'restore-before-import' });
      assert.equal(restore.statusCode, 200);
      assert.deepEqual((await ownCall('GET', '')).json().snapshot, before.snapshot);
    });
    await t.test('a valid incremental update can grow the complete snapshot beyond 32 MiB', async () => {
      const ownCall = (method, body) => call(method, '', body, 'B', 'Y');
      const before = (await ownCall('GET')).json();
      const data = Buffer.alloc(17 * 1024 * 1024).toString('base64');
      const first = { path: 'game/1.save', mtime: 1, data };
      const full = await ownCall('PUT', { revision: before.revision, uploadId: 'large-baseline', snapshot: { version: 1, files: [first] } });
      assert.equal(full.statusCode, 200, full.body);
      const updated = await ownCall('PUT', { revision: full.json().revision, uploadId: 'large-delta',
        delta: { version: 1, files: [{ ...first, path: 'game/2.save' }], deleted: [] } });
      assert.equal(updated.statusCode, 200, updated.body);
      const complete = (await ownCall('GET')).json();
      assert.equal(complete.snapshot.files.length, 2);
      assert.equal(complete.snapshot.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.data, 'base64'), 0), 34 * 1024 * 1024);
    });
  } finally {
    await app.close(); await prisma.$disconnect(); rmSync(directory, { recursive: true, force: true });
  }
});
