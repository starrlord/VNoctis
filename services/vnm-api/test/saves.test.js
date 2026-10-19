import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import savesRoutes, { validateDelta, validateSnapshot, snapshotValidationError, validateReferenceSnapshot } from '../src/routes/saves.js';
import { readCurrent, readVersion } from '../src/services/saveHistory.js';
import internalRoutes from '../src/routes/internal.js';
import { saveZip, thumbnail } from './helpers/saveZip.js';

const snapshot = (data = 'device A') => ({ version: 1, files: [
  { path: 'test/1-1-LT1.save', mtime: 1000, data: Buffer.from(data).toString('base64') },
  { path: 'test/persistent', mtime: 1001, data: 'AA==' },
  { path: 'tokens/security_keys.txt', mtime: 1002, data: 'AQ==' },
] });

test('snapshot rejects traversal, ambiguous trees, malformed bytes and invalid timestamps', () => {
  assert.equal(validateSnapshot(snapshot()), true);
  for (const path of ['../save', '/save', 'x/../save', 'x\\save', 'x//save', 'x\0save']) {
    const copy = snapshot(); copy.files[0].path = path;
    assert.equal(validateSnapshot(copy), false, path);
  }
  const duplicate = snapshot(); duplicate.files.push(duplicate.files[0]);
  assert.equal(validateSnapshot(duplicate), false);
  const ancestor = snapshot(); ancestor.files.push({ path: 'test', mtime: 0, data: '' });
  assert.equal(validateSnapshot(ancestor), false);
  const bad = snapshot(); bad.files[0].data = '*invalid*';
  assert.equal(validateSnapshot(bad), false);
  bad.files[0] = { path: 'test/save', data: '', mtime: -1 };
  assert.equal(validateSnapshot(bad), false);
});

test('save limit accepts folders over 32 MiB and still bounds aggregate decoded bytes', () => {
  const data = 'A'.repeat(4 * 1024 * 1024); // 3 MiB decoded per entry.
  const copy = { version: 1, files: Array.from({ length: 12 }, (_, i) => ({ path: `game/${i}.save`, mtime: 1, data })) };
  assert.equal(validateSnapshot(copy), true, '36 MiB is a legitimate bounded snapshot');
  copy.files = Array.from({ length: 43 }, (_, i) => ({ path: `game/${i}.save`, mtime: 1, data }));
  assert.equal(validateSnapshot(copy), false, '129 MiB remains rejected');
  assert.equal(snapshotValidationError(copy).code, 'SAVE_SNAPSHOT_TOO_LARGE');
});

test('delta validation rejects unsafe, duplicate, overlapping, and malformed paths', () => {
  const delta = { version: 1, files: snapshot().files, deleted: ['old.save'] };
  assert.equal(validateDelta(delta), true);
  for (const deleted of [['../old.save'], ['old.save', 'old.save'], [delta.files[0].path], [12]]) {
    assert.equal(validateDelta({ ...delta, deleted }), false);
  }
  assert.equal(validateDelta({ ...delta, files: [{ path: 'new.save', mtime: 1, data: '*' }] }), false);
});

test('large legitimate base64 files validate without regex stack exhaustion', () => {
  const copy = snapshot(); copy.files[0].data = 'A'.repeat(40 * 1024 * 1024);
  assert.equal(validateSnapshot(copy), true);
});

test('logical snapshots validate reference ownership metadata, file trees and aggregate size', () => {
  const ref = { path: 'game/1.save', mtime: 1, hash: 'a'.repeat(64), size: 10 };
  const good = { version: 1, baseVersionId: 'baseline', files: [ref, snapshot().files[1]] };
  assert.equal(validateReferenceSnapshot(good), true);
  for (const copy of [ { ...good, baseVersionId: null }, { ...good, baseVersionId: '../other' },
    { ...good, files: [{ ...ref, size: -1 }] }, { ...good, files: [{ ...ref, size: 129 * 1024 * 1024 }] },
    { ...good, files: [{ ...ref, data: '' }] }, { ...good, files: [{ ...ref, hash: 'known but invalid' }] },
    { ...good, files: [ref, { ...ref, path: 'game' }] }, { ...good, files: [ref, ref] },
    { ...good, files: [{ ...ref, path: '../bad' }] } ]) assert.equal(validateReferenceSnapshot(copy), false);
});

test('SQLite migration and authenticated per-user/game revision API', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'vnm-save-test-'));
  const queries = [];
  const prisma = new PrismaClient({ datasourceUrl: `file:${join(directory, 'test.db').replaceAll('\\', '/')}`,
    log: [{ emit: 'event', level: 'query' }] });
  prisma.$on('query', event => queries.push(event.query));
  const app = Fastify(); app.decorate('prisma', prisma);
  try {
    // Apply the committed migrations, not db push; the existing missing R2 columns
    // do not block this feature's id-only game access check.
    const migrations = new URL('../prisma/migrations/', import.meta.url);
    for (const name of readdirSync(migrations).filter(n => n !== 'migration_lock.toml').sort()) {
      if (name === '20261007000000_save_sync_retention') {
        await prisma.$executeRawUnsafe('INSERT INTO User (id,username,passwordHash,updatedAt) VALUES (?,?,?,?)', 'seed', 'seed', 'unused', new Date());
        await prisma.$executeRawUnsafe('INSERT INTO Game (id,directoryPath,directoryName,extractedTitle,updatedAt) VALUES (?,?,?,?,?)', 'seed', '/games/seed', 'seed', 'Original Title', new Date());
        await prisma.$executeRawUnsafe('INSERT INTO SaveSyncState (userId,gameId,revision,payload,checksum,updatedAt) VALUES (?,?,?,?,?,?)', 'seed', 'seed', 7, JSON.stringify(snapshot('existing progress')), 'existing-checksum', new Date());
      }
      const sql = readFileSync(new URL(`${name}/migration.sql`, migrations), 'utf8');
      for (const statement of sql.split(';').filter(s => s.trim())) await prisma.$executeRawUnsafe(statement);
    }
    const migrated = await prisma.saveSyncState.findUnique({ where: { userId_gameId: { userId: 'seed', gameId: 'seed' } } });
    assert.equal(migrated.revision, 7); assert.equal(migrated.gameTitle, 'Original Title');
    assert.equal(migrated.checksum, 'existing-checksum');
    assert.deepEqual(JSON.parse(migrated.payload), snapshot('existing progress'));
    await prisma.user.delete({ where: { id: 'seed' } });
    await prisma.$executeRawUnsafe('DELETE FROM Game WHERE id = ?', 'seed');
    await prisma.user.createMany({ data: ['A', 'B'].map(id => ({ id, username: id, passwordHash: 'unused' })) });
    await prisma.user.update({ where: { id: 'A' }, data: { role: 'admin' } });
    for (const id of ['X', 'Y']) await prisma.$executeRawUnsafe(
      'INSERT INTO Game (id,directoryPath,directoryName,extractedTitle,updatedAt) VALUES (?,?,?,?,?)', id, `/games/${id}`, id, id, new Date());
    app.addHook('onRequest', async (request, reply) => {
      // Route integration fixture: production assigns this from a verified JWT.
      const userId = request.headers.authorization;
      if (!['A', 'B'].includes(userId)) return reply.code(401).send({});
      request.user = { userId };
    });
    await app.register(savesRoutes, { prefix: '/api/v1' });
    await app.register(internalRoutes, { prefix: '/api/v1' });
    const get = (user, game = 'X') => app.inject({ method: 'GET', url: `/api/v1/games/${game}/saves`, headers: { authorization: user } });
    const put = (user, revision, copy = snapshot(), game = 'X') => app.inject({ method: 'PUT', url: `/api/v1/games/${game}/saves`, headers: { authorization: user }, payload: { revision, snapshot: copy, userId: 'B' } });
    await t.test('manifest downloads are binary, revision-pinned and isolated by user/game', async () => {
      const request = (user, suffix, game = 'Y') => app.inject({ method: 'GET',
        url: `/api/v1/games/${game}/saves${suffix}`, headers: { authorization: user } });
      const cleanup = async () => {
        await prisma.saveSyncState.deleteMany({ where: { userId: 'A', gameId: 'Y' } });
        await prisma.saveVersion.deleteMany({ where: { userId: 'A', gameId: 'Y' } });
        await prisma.saveUploadReceipt.deleteMany({ where: { userId: 'A', gameId: 'Y' } });
      };
      assert.equal((await request('A', '?manifest=1')).json().manifest, null);
      const copy = snapshot('binary save contents');
      assert.equal((await put('A', 0, copy, 'Y')).statusCode, 200);
      const response = await request('A', '?manifest=1');
      const manifest = response.json();
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(manifest.fileDownloads, true); assert.equal('snapshot' in manifest, false);
      assert.equal(manifest.referenceUploads, true); assert.ok(manifest.currentVersionId);
      assert.equal(manifest.revision, 1); assert.equal(manifest.manifest.files.length, 3);
      const file = manifest.manifest.files.find(file => file.path.endsWith('.save'));
      assert.equal(file.size, Buffer.byteLength('binary save contents'));
      assert.equal('data' in file, false);
      const path = `/files/${file.hash}?revision=1`;
      const bytes = await request('A', path);
      assert.equal(bytes.statusCode, 200); assert.equal(bytes.body, 'binary save contents');
      assert.equal(bytes.headers['content-type'], 'application/octet-stream');
      assert.equal(bytes.headers['cache-control'], 'no-store');
      assert.equal(bytes.headers['x-content-type-options'], 'nosniff');
      assert.equal((await request('missing', path)).statusCode, 401);
      assert.equal((await request('B', `/files/${file.hash}?revision=0`)).statusCode, 404);
      assert.equal((await request('A', `/files/${file.hash}?revision=0`, 'X')).statusCode, 404);
      assert.equal((await request('A', `/files/${'0'.repeat(64)}?revision=1`)).statusCode, 404);
      for (const suffix of [`/files/${file.hash}`, `/files/${file.hash}?revision=-1`, '/files/nope?revision=1']) {
        assert.equal((await request('A', suffix)).statusCode, 400);
      }
      assert.equal((await put('A', 1, snapshot('next revision'), 'Y')).statusCode, 200);
      const stale = await request('A', path);
      assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'SAVE_MANIFEST_CHANGED');
      const pinned = `/api/v1/games/Y/saves/versions/${manifest.currentVersionId}/files/${file.hash}`;
      assert.equal((await app.inject({ method: 'GET', url: pinned, headers: { authorization: 'A' } })).body, 'binary save contents');
      assert.equal((await app.inject({ method: 'GET', url: pinned, headers: { authorization: 'B' } })).statusCode, 404);
      assert.equal((await app.inject({ method: 'GET', url: pinned.replace('/games/Y/', '/games/X/'), headers: { authorization: 'A' } })).statusCode, 404);
      assert.equal((await request('A', `/files/${file.hash}?revision=2`)).statusCode, 404, 'history alone grants no current-file access');
      await cleanup();
    });
    await t.test('cached native previews remain scoped and skip blob contents on subsequent requests', async () => {
      const native = saveZip({ json: '{"_save_name":"Chapter 2","custom":42}', 'screenshot.png': thumbnail, log: 'state never decoded' });
      const copy = snapshot(); copy.files[0].data = native.toString('base64');
      assert.equal((await put('A', 0, copy, 'Y')).statusCode, 200);
      const manifest = (await app.inject({ method: 'GET', url: '/api/v1/games/Y/saves?manifest=1', headers: { authorization: 'A' } })).json();
      assert.equal(manifest.previewDownloads, true);
      const hash = manifest.manifest.files.find(file => file.path.endsWith('.save')).hash;
      const request = (user = 'A', revision = 1, game = 'Y', fileHash = hash) => app.inject({ method: 'GET',
        url: `/api/v1/games/${game}/saves/files/${fileHash}/preview?revision=${revision}`, headers: { authorization: user } });
      const first = await request(); assert.equal(first.statusCode, 200); assert.equal(first.headers['cache-control'], 'no-store');
      assert.equal(first.json().supported, true); assert.equal(first.json().metadata.custom, 42);
      assert.deepEqual(Buffer.from(first.json().screenshot.data, 'base64'), thumbnail);
      assert.equal((await prisma.saveFileBlob.findUnique({ where: { hash } })).preview, first.body);
      const index = queries.length;
      assert.deepEqual((await request()).json(), first.json());
      assert.ok(!queries.slice(index).some(sql => sql.includes('"data"')), 'cached preview must not load full save bytes');
      await prisma.saveFileBlob.update({ where: { hash }, data: { preview: JSON.stringify({ version: 1, supported: false }) } });
      const refreshed = (await request()).json();
      assert.equal(refreshed.supported, true); assert.equal(refreshed.version, 2, 'old preview cache is regenerated');
      assert.equal((await request('missing')).statusCode, 401);
      assert.equal((await request('B', 0)).statusCode, 404, 'shared preview cache grants no cross-user access');
      assert.equal((await request('A', 0, 'X')).statusCode, 404);
      assert.equal((await request('A', 0)).statusCode, 409);
      const support = manifest.manifest.files.find(file => !file.path.endsWith('.save'));
      assert.equal((await request('A', 1, 'Y', support.hash)).statusCode, 404);
      await prisma.saveSyncState.deleteMany({ where: { userId: 'A', gameId: 'Y' } });
      await prisma.saveVersion.deleteMany({ where: { userId: 'A', gameId: 'Y' } });
      await prisma.saveUploadReceipt.deleteMany({ where: { userId: 'A', gameId: 'Y' } });
    });
    await t.test('inline legacy snapshots support the same manifest and original binary bytes', async () => {
      const copy = snapshot('legacy bytes');
      await prisma.saveSyncState.create({ data: { userId: 'A', gameId: 'Y', revision: 5,
        payload: JSON.stringify(copy), checksum: 'legacy-checksum' } });
      const manifest = (await app.inject({ method: 'GET', url: '/api/v1/games/Y/saves?manifest=1', headers: { authorization: 'A' } })).json();
      const file = manifest.manifest.files[0];
      const response = await app.inject({ method: 'GET', url: `/api/v1/games/Y/saves/files/${file.hash}?revision=5`, headers: { authorization: 'A' } });
      assert.equal(response.statusCode, 200); assert.equal(response.body, 'legacy bytes');
      assert.equal(manifest.saveChecksum, (await get('A', 'Y')).json().saveChecksum);
      await prisma.saveSyncState.deleteMany({ where: { userId: 'A', gameId: 'Y' } });
      await prisma.saveVersion.deleteMany({ where: { userId: 'A', gameId: 'Y' } });
    });
    await t.test('partial-cache snapshots retain uncached slots, rotate aliases and preserve stale offline alternatives', async () => {
      const encoded = text => Buffer.from(text).toString('base64');
      const initial = { version: 1, files: ['1-1', 'auto-1', 'auto-2', 'auto-3'].map((slot, i) => ({ path: `Game/${slot}.save`, mtime: i + 1, data: encoded(slot) })) };
      const manifest = async user => (await app.inject({ method: 'GET', url: '/api/v1/games/Y/saves?manifest=1', headers: { authorization: user } })).json();
      const send = (user, id, copy, revision = 1, extra = {}) => app.inject({ method: 'PUT', url: '/api/v1/games/Y/saves', headers: { authorization: user },
        payload: { revision, uploadId: id, fileSnapshot: copy, ...extra } });
      await put('A', 0, initial, 'Y');
      const base = await manifest('A');
      const ref = slot => ({ ...base.manifest.files.find(file => file.path === `Game/${slot}.save`) });
      const logical = { version: 1, baseVersionId: base.currentVersionId, files: [
        { path: 'Game/1-1.save', mtime: 10, data: encoded('new manual') },
        { ...ref('auto-1'), path: 'Game/auto-2.save' },
        { ...ref('auto-2'), path: 'Game/auto-3.save' },
        { path: 'Game/auto-1.save', mtime: 11, data: encoded('new auto') },
      ] };
      const result = await send('A', 'partial-1', logical, 1, { baseSaveChecksum: base.saveChecksum });
      assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().disposition, 'current');
      assert.equal((await send('A', 'partial-1', { ...logical, files: [...logical.files].reverse() }, 1,
        { baseSaveChecksum: base.saveChecksum })).statusCode, 200, 'wire ordering must not change receipt identity');
      const saved = (await get('A', 'Y')).json(); assert.equal(saved.revision, 2);
      const data = new Map(saved.snapshot.files.map(file => [file.path, Buffer.from(file.data, 'base64').toString()]));
      assert.equal(data.get('Game/auto-2.save'), 'auto-1'); assert.equal(data.get('Game/auto-3.save'), 'auto-2');
      assert.equal(data.get('Game/auto-1.save'), 'new auto'); assert.equal(data.get('Game/1-1.save'), 'new manual');
      const stale = { version: 1, baseVersionId: base.currentVersionId,
        files: [ ...base.manifest.files.filter(file => file.path !== 'Game/1-1.save'),
          { path: 'Game/1-1.save', mtime: 20, data: encoded('independent offline progress') } ] };
      const alternate = await send('A', 'partial-offline', stale, 1, { baseSaveChecksum: base.saveChecksum });
      assert.equal(alternate.statusCode, 200, alternate.body); assert.equal(alternate.json().disposition, 'alternate');
      assert.deepEqual((await get('A', 'Y')).json().snapshot, saved.snapshot, 'stale progress must not replace server continuation');
      const preserved = await readVersion(prisma, alternate.json().versionId, { userId: 'A', gameId: 'Y' });
      const offline = new Map(preserved.snapshot.files.map(file => [file.path, Buffer.from(file.data, 'base64').toString()]));
      assert.equal(offline.get('Game/1-1.save'), 'independent offline progress');
      assert.equal(offline.get('Game/auto-1.save'), 'auto-1', 'alternate uses the offline baseline, not current rotated aliases');
      const foreign = snapshot('foreign private progress'); await put('B', 0, foreign, 'Y'); const other = await manifest('B');
      const invalid = await send('A', 'foreign-ref', { ...logical, files: [other.manifest.files[0]] });
      assert.equal(invalid.statusCode, 400); assert.equal(invalid.json().code, 'SAVE_INVALID_REFERENCE');
      const foreignBase = await send('A', 'foreign-base', { version: 1, baseVersionId: other.currentVersionId, files: other.manifest.files });
      assert.equal(foreignBase.statusCode, 409); assert.equal(foreignBase.json().code, 'SAVE_REFERENCE_BASE_MISSING');
      const size = await send('A', 'bad-ref-size', { ...logical, files: [{ ...ref('auto-1'), size: 1 }] });
      assert.equal(size.statusCode, 400);
      await prisma.saveVersion.delete({ where: { id: base.currentVersionId } });
      const retry = await send('A', 'partial-1', logical, 1, { baseSaveChecksum: base.saveChecksum });
      assert.equal(retry.statusCode, 200); assert.equal(retry.json().revision, 2, 'receipt survives a pruned baseline');
      const lostBase = await send('A', 'missing-ref-base', stale, 1, { baseSaveChecksum: base.saveChecksum });
      assert.equal(lostBase.statusCode, 409); assert.equal(lostBase.json().code, 'SAVE_REFERENCE_BASE_MISSING');
      assert.equal((await get('A', 'Y')).json().revision, 2);
      const changedRetry = await send('A', 'partial-1', { ...logical, files: [] }, 1, { baseSaveChecksum: base.saveChecksum });
      assert.equal(changedRetry.statusCode, 409);
      for (const userId of ['A', 'B']) {
        await prisma.saveSyncState.deleteMany({ where: { userId, gameId: 'Y' } });
        await prisma.saveVersion.deleteMany({ where: { userId, gameId: 'Y' } });
        await prisma.saveUploadReceipt.deleteMany({ where: { userId, gameId: 'Y' } });
      }
      const allLocal = await send('A', 'no-reference-needed', { version: 1, baseVersionId: null, files: initial.files }, 0);
      assert.equal(allLocal.statusCode, 200, allLocal.body);
      await prisma.saveSyncState.deleteMany({ where: { userId: 'A', gameId: 'Y' } });
      await prisma.saveVersion.deleteMany({ where: { userId: 'A', gameId: 'Y' } });
      await prisma.saveUploadReceipt.deleteMany({ where: { userId: 'A', gameId: 'Y' } });
    });
    await t.test('runtime destination survives a launch without creating saves and stays scoped', async () => {
      const report = (user, directory, game = 'X') => app.inject({ method: 'POST', url: `/api/v1/games/${game}/saves/directory`,
        headers: { authorization: user }, payload: { directory, userId: 'B' } });
      const history = (user, game = 'X') => app.inject({ method: 'GET', url: `/api/v1/games/${game}/saves/history`, headers: { authorization: user } });
      for (const directory of ['', '../Game', '/Game', 'tokens', 'Game//saves', 'C:/saves', 'Game\\saves', 'x'.repeat(401)]) {
        assert.equal((await report('A', directory)).statusCode, 400);
      }
      assert.equal((await report('missing', 'test')).statusCode, 401);
      assert.equal((await report('A', 'test', 'absent')).statusCode, 404);
      assert.equal((await report('A', 'test')).statusCode, 200);
      const known = (await history('A')).json();
      assert.equal(known.saveDirectory, 'test'); assert.equal(known.saveDirectorySource, 'runtime');
      assert.equal(known.currentRevision, 0); assert.deepEqual(known.versions, []);
      assert.equal((await get('A')).json().snapshot, null);
      assert.equal((await get('A')).json().saveDirectory, 'test');
      assert.equal((await get('A')).json().saveBuildVersion, null);
      assert.equal((await get('B')).json().saveDirectory, null);
      assert.equal((await get('A', 'Y')).json().saveDirectory, null);
      assert.equal((await history('B')).json().saveDirectory, null);
      assert.equal((await history('A', 'Y')).json().saveDirectory, null);
      const persistent = { version: 1, files: ['Game/persistent', 'Game/sync/persistent', 'tokens/security_keys.txt']
        .map(path => ({ path, mtime: 1, data: 'AA==' })) };
      assert.equal((await put('B', 0, persistent, 'Y')).statusCode, 200);
      assert.equal((await history('B', 'Y')).json().saveDirectory, 'Game');
      persistent.files.push({ path: 'Other/persistent', mtime: 1, data: 'AA==' });
      assert.equal((await put('B', 1, persistent, 'Y')).statusCode, 200);
      const ambiguous = (await history('B', 'Y')).json();
      assert.equal(ambiguous.saveDirectory, null); assert.deepEqual(ambiguous.saveFolders, ['Game', 'Other']);
      await prisma.saveSyncState.deleteMany({ where: { userId: 'B', gameId: 'Y' } });
      await prisma.saveVersion.deleteMany({ where: { userId: 'B', gameId: 'Y' } });
      await prisma.saveUploadReceipt.deleteMany({ where: { userId: 'B', gameId: 'Y' } });
    });
    await t.test('successful builds enable imports before play and invalidate old runtime destinations', async () => {
      const history = () => app.inject({ method: 'GET', url: '/api/v1/games/Y/saves/history', headers: { authorization: 'A' } });
      const runtime = async directory => {
        const game = await prisma.game.findUnique({ where: { id: 'Y' }, select: { builtAt: true } });
        return app.inject({ method: 'POST', url: '/api/v1/games/Y/saves/directory', headers: { authorization: 'A' },
          payload: { directory, buildVersion: game.builtAt?.toISOString() || null } });
      };
      const job = await prisma.buildJob.create({ data: { gameId: 'Y' } });
      const callback = body => app.inject({ method: 'POST', url: `/api/v1/internal/build/${job.id}/status`, headers: { authorization: 'A' }, payload: body });
      await runtime('OldBuild');
      assert.equal((await callback({ status: 'done', saveDirectory: '../bad' })).statusCode, 400);
      assert.equal((await history()).json().saveDirectory, 'OldBuild');
      assert.equal((await callback({ status: 'done', webBuildPath: '/web-builds/Y', saveDirectory: 'BuiltGame' })).statusCode, 200);
      const ready = (await history()).json();
      assert.equal(ready.currentRevision, 0); assert.deepEqual(ready.versions, []);
      assert.equal(ready.saveDirectory, 'BuiltGame'); assert.equal(ready.saveDirectorySource, 'build');
      const launch = (await get('A', 'Y')).json();
      assert.equal(launch.saveDirectory, 'BuiltGame');
      assert.equal(launch.saveBuildVersion, (await prisma.game.findUnique({ where: { id: 'Y' }, select: { builtAt: true } })).builtAt.toISOString());
      assert.equal((await get('B', 'Y')).json().saveDirectory, 'BuiltGame');
      const stale = await app.inject({ method: 'POST', url: '/api/v1/games/Y/saves/directory', headers: { authorization: 'A' },
        payload: { directory: 'OldBuild', buildVersion: null } });
      assert.equal(stale.statusCode, 409);
      assert.equal((await history()).json().saveDirectory, 'BuiltGame');
      const copy = { version: 1, files: [{ path: 'BuiltGame/1.save', mtime: 1, data: 'AA==' }] };
      const upload = snapshot => app.inject({ method: 'POST', url: '/api/v1/games/Y/saves/history/import', headers: { authorization: 'A' },
        payload: { revision: 0, uploadId: 'before-first-launch', snapshot } });
      assert.equal((await upload({ ...copy, files: [{ ...copy.files[0], path: 'saves/1.save' }] })).statusCode, 409);
      assert.equal((await upload(copy)).statusCode, 200);
      assert.deepEqual((await get('A', 'Y')).json().snapshot, copy);
      await runtime('RuntimeOverride');
      assert.equal((await history()).json().saveDirectorySource, 'runtime');
      assert.equal((await history()).json().saveDirectory, 'RuntimeOverride');
      assert.equal((await get('A', 'Y')).json().saveDirectory, 'RuntimeOverride');
      assert.equal((await get('B', 'Y')).json().saveDirectory, 'BuiltGame');
      await callback({ status: 'failed' });
      assert.equal((await history()).json().saveDirectory, 'RuntimeOverride');
      await callback({ status: 'done', saveDirectory: null });
      assert.equal((await history()).json().saveDirectorySource, null);
      assert.equal((await history()).json().saveDirectory, null, 'Old snapshots cannot establish a rebuilt game’s new destination');
      assert.deepEqual((await get('A', 'Y')).json().snapshot, copy);
      await prisma.saveSyncState.deleteMany({ where: { userId: 'A', gameId: 'Y' } });
      await prisma.saveVersion.deleteMany({ where: { userId: 'A', gameId: 'Y' } });
      await prisma.saveUploadReceipt.deleteMany({ where: { userId: 'A', gameId: 'Y' } });
    });
    await t.test('first browser upload is visible to another session of the same user', async () => {
      assert.equal((await put('A', 0)).statusCode, 200);
      const response = await get('A'); assert.equal(response.json().revision, 1);
      assert.deepEqual(response.json().snapshot, snapshot());
      assert.equal(response.headers['cache-control'], 'no-store');
    });
    await t.test('request body cannot select another user and games cannot collide', async () => {
      assert.equal((await get('B')).json().snapshot, null);
      assert.equal((await get('A', 'Y')).json().snapshot, null);
      assert.equal((await get('missing')).statusCode, 401);
      assert.equal((await get('A', 'absent')).statusCode, 404);
      assert.equal((await get('A', '..%2Fx')).statusCode, 400);
    });
    await t.test('concurrent progress preserves an alternate without overwriting the first writer', async () => {
      const results = await Promise.all([put('A', 1, snapshot('B')), put('A', 1, snapshot('C'))]);
      assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 200]);
      assert.deepEqual(results.map(r => r.json().disposition).sort(), ['alternate', 'current']);
      assert.equal((await get('A')).json().revision, 2);
      assert.equal((await put('A', 0)).json().revision, 1);
    });
    await t.test('invalid snapshot and oversized body leave server state intact', async () => {
      const copy = snapshot(); copy.files[0].path = '../attack';
      assert.equal((await put('A', 2, copy)).statusCode, 400);
      const huge = await app.inject({ method: 'PUT', url: '/api/v1/games/X/saves',
        headers: { authorization: 'A', 'content-length': String(180 * 1024 * 1024) }, payload: { revision: 2, snapshot: snapshot() } });
      assert.equal(huge.statusCode, 413);
      assert.equal((await get('A')).json().revision, 2);
    });
    await t.test('upload IDs acknowledge retries and reject reused IDs or competing progress', async () => {
      const send = (revision, uploadId, copy = snapshot()) => app.inject({ method: 'PUT', url: '/api/v1/games/Y/saves',
        headers: { authorization: 'B' }, payload: { revision, uploadId, snapshot: copy } });
      assert.equal((await send(0, 'request-1')).json().revision, 1);
      const retries = await Promise.all([send(0, 'request-1'), send(0, 'request-1')]);
      assert.ok(retries.every(response => response.statusCode === 200 && response.json().revision === 1));
      assert.equal((await send(1, 'request-1', snapshot('different'))).statusCode, 409);
      assert.equal((await get('B', 'Y')).json().uploadId, 'request-1');
      const newer = await send(1, 'request-2', snapshot('newer'));
      assert.equal(newer.statusCode, 200, newer.body);
      assert.equal(newer.json().revision, 2);
      assert.equal((await send(0, 'request-1')).json().revision, 1, 'older retry acknowledges its original receipt');
      assert.equal((await get('B', 'Y')).json().revision, 2, 'acknowledgement does not overwrite newer progress');
    });
    await t.test('missing games retain saves; admin cleanup protects active and returned games', async () => {
      const admin = (method, path = '', payload, user = 'A') => app.inject({ method,
        url: `/api/v1/admin/orphaned-saves${path}`, headers: { authorization: user }, payload });
      await prisma.$executeRawUnsafe('UPDATE Game SET webBuildPath = ? WHERE id = ?', '/web-builds/new-version', 'X');
      assert.equal((await get('A')).json().revision, 2);
      assert.equal((await admin('DELETE', '/A/X', { revision: 2 })).statusCode, 409);
      await prisma.$executeRawUnsafe('DELETE FROM Game WHERE id = ?', 'X');
      assert.equal((await get('A')).statusCode, 404);
      assert.equal(await prisma.saveSyncState.count(), 2);
      for (const [method, path, payload] of [['GET', ''], ['GET', '/A/X'], ['DELETE', '/A/X', { revision: 2 }]]) {
        assert.equal((await admin(method, path, payload, 'B')).statusCode, 403);
      }
      const list = (await admin('GET')).json();
      assert.equal(list.items.length, 1); assert.equal(list.items[0].gameTitle, 'X');
      assert.equal(list.items[0].username, 'A'); assert.equal('payload' in list.items[0], false);
      const stored = await prisma.saveSyncState.findUnique({ where: { userId_gameId: { userId: 'A', gameId: 'X' } } });
      assert.deepEqual((await admin('GET', '/A/X')).json().snapshot, await readCurrent(prisma, stored));
      assert.equal((await admin('DELETE', '/A/X', { revision: 1 })).statusCode, 409);
      await prisma.$executeRawUnsafe('INSERT INTO Game (id,directoryPath,directoryName,extractedTitle,updatedAt) VALUES (?,?,?,?,?)', 'X', '/games/X', 'X', 'X', new Date());
      assert.equal((await get('A')).json().revision, 2);
      assert.equal((await admin('GET')).json().items.length, 0);
      assert.equal((await admin('GET', '/A/X')).statusCode, 404);
      assert.equal((await admin('DELETE', '/A/X', { revision: 2 })).statusCode, 409);
      await prisma.$executeRawUnsafe('DELETE FROM Game WHERE id = ?', 'X');
      assert.equal((await admin('DELETE', '/A/X', { revision: 2 })).statusCode, 200);
      await prisma.user.delete({ where: { id: 'B' } });
      assert.equal(await prisma.saveSyncState.count(), 0);
    });
  } finally {
    await app.close(); await prisma.$disconnect(); rmSync(directory, { recursive: true, force: true });
  }
});
