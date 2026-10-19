import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createSavePreparation } from '../public/save-offline.js';

const tokenFor = userId => `header.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.signature`;
const file = (path, value) => { const bytes = Buffer.from(value); return { path, mtime: 1, size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') }; };
function fixture(shared = new Map(), userId = 'A', gameId = 'X') {
  const requests = [], bodies = new Map(), rows = [file('game/1-LT1.save', 'one'), file('game/auto-LT1.save', 'one'), file('game/persistent', 'preferences')];
  bodies.set(rows[0].hash, Buffer.from('one')); bodies.set(rows[2].hash, Buffer.from('preferences'));
  const remote = { revision: 1, fileDownloads: true, referenceUploads: true, saveBuildVersion: 'build-1', currentVersionId: 'owned-version', manifest: { version: 1, files: rows } };
  let active = tokenFor(userId), changed = false;
  const storage = { get: async key => structuredClone(shared.get(key)), put: async (key, value) => { shared.set(key, structuredClone(value)); },
    delete: async key => shared.delete(key), keys: async prefix => [...shared.keys()].filter(key => key.startsWith(prefix)) };
  const options = { userId, gameId, token: active, currentToken: () => active, dirty: () => changed, pending: async () => false, storage,
    digest: bytes => webcrypto.subtle.digest('SHA-256', bytes), now: () => 123,
    fetcher: async (url, init) => {
      requests.push({ url, init });
      assert.equal(init.headers.Authorization, `Bearer ${tokenFor(userId)}`);
      if (url.endsWith('?manifest=1')) return Response.json(remote);
      const hash = url.split('/').at(-1).split('?')[0];
      return new Response(bodies.get(hash) || 'missing');
    } };
  return { ...createSavePreparation(options), options, shared, storage, requests, bodies, remote,
    switchAccount: user => { active = tokenFor(user); }, dirty: value => { changed = value; } };
}

test('preparation deduplicates and verifies individual files; an unchanged repeat transfers no save bytes', async () => {
  const f = fixture(), progress = [];
  assert.equal((await f.readiness('build-1')).ready, false);
  const ready = await f.prepare({ buildVersion: 'build-1', onProgress: row => progress.push(row) });
  assert.equal(ready.ready, true); assert.equal(ready.scope, 'server-saves'); assert.equal(ready.files, 3); assert.equal(ready.preparedAt, 123);
  assert.equal(f.requests.filter(row => !row.url.endsWith('?manifest=1')).length, 2);
  assert.ok(f.requests.filter(row => !row.url.endsWith('?manifest=1')).every(row => row.url.includes('/versions/owned-version/')));
  assert.equal(progress.at(-1).files, 2);
  f.requests.length = 0; await f.prepare({ buildVersion: 'build-1' });
  assert.equal(f.requests.length, 2); assert.ok(f.requests.every(row => row.url.endsWith('?manifest=1')));
});

test('readiness rechecks bytes after eviction or corruption and is scoped to the build and local progress', async () => {
  const f = fixture(); await f.prepare({ buildVersion: 'build-1' });
  assert.equal((await f.readiness('build-2')).reason, 'not-prepared');
  f.dirty(true); assert.equal((await f.readiness('build-1')).reason, 'local-changes');
  await assert.rejects(f.prepare({ buildVersion: 'build-1' }), /Sync browser progress/); f.dirty(false);
  const key = `vnm-saves:A:X:blob:${f.remote.manifest.files[0].hash}`;
  f.shared.set(key, Buffer.from('corrupt'));
  assert.equal((await f.readiness('build-1')).reason, 'missing-files'); assert.equal(f.shared.has(key), false);
  await f.prepare({ buildVersion: 'build-1' });
  f.shared.delete(key); assert.equal((await f.readiness('build-1')).ready, false);
});

test('accounts and games cannot reuse or clear each other’s prepared checkpoints', async () => {
  const shared = new Map(), a = fixture(shared), b = fixture(shared, 'B'), other = fixture(shared, 'A', 'Y');
  await a.prepare({ buildVersion: 'build-1' });
  assert.equal(await b.manifest('build-1'), null); assert.equal(await other.readFile(a.remote.manifest.files[0]), null);
  await b.prepare({ buildVersion: 'build-1' }); await other.prepare({ buildVersion: 'build-1' });
  await a.clear(); assert.equal((await a.readiness('build-1')).ready, false);
  assert.equal((await b.readiness('build-1')).ready, true); assert.equal((await other.readiness('build-1')).ready, true);
  assert.throws(() => createSavePreparation({ ...a.options, userId: 'B' }), /does not match/);
});

test('account changes during a download cannot publish or expose the previous account’s bytes', async () => {
  const f = fixture();
  const client = createSavePreparation({ ...f.options, fetcher: async (...args) => {
    const response = await f.options.fetcher(...args);
    if (!args[0].endsWith('?manifest=1')) f.switchAccount('B'); return response;
  } });
  await assert.rejects(client.prepare({ buildVersion: 'build-1' }), /Account changed/);
  assert.ok(!f.shared.has('vnm-saves:A:X:manifest'));
  await assert.rejects(client.readiness('build-1'), /Account changed/);
});

test('cancellation and quota failures leave no readiness marker; cleanup includes interrupted transfers', async () => {
  for (const quota of [false, true]) {
    const f = fixture(), controller = new AbortController();
    const client = quota ? createSavePreparation({ ...f.options, storage: { ...f.storage, put: async () => { throw new Error('Quota exceeded'); } } }) : f;
    await assert.rejects(client.prepare({ buildVersion: 'build-1', signal: controller.signal,
      onProgress: () => controller.abort() }), quota ? /Quota/ : { name: 'AbortError' });
    assert.ok(!f.shared.has('vnm-saves:A:X:manifest'));
    await f.clear(); assert.equal(f.shared.size, 0);
  }
});

test('changed revisions/builds and newly dirty browser progress never publish a completeness marker', async () => {
  for (const mode of ['revision', 'build', 'dirty']) {
    const f = fixture(); let manifests = 0;
    const client = createSavePreparation({ ...f.options, fetcher: async (...args) => {
      if (args[0].endsWith('?manifest=1') && ++manifests === 2) {
        if (mode === 'dirty') f.dirty(true);
        else if (mode === 'build') f.remote.saveBuildVersion = 'build-2'; else f.remote.revision++;
      }
      return f.options.fetcher(...args);
    } });
    await assert.rejects(client.prepare({ buildVersion: 'build-1' }), /changed/);
    assert.ok(!f.shared.has('vnm-saves:A:X:manifest'));
  }
});

test('corrupt or oversized responses and unsafe manifests cannot be marked ready', async () => {
  for (const mode of ['corrupt', 'oversize', 'path', 'size', 'collision']) {
    const f = fixture();
    if (mode === 'path') f.remote.manifest.files[0].path = '../bad';
    if (mode === 'size') f.remote.manifest.files[0].size = 129 * 1024 * 1024;
    if (mode === 'collision') f.remote.manifest.files[1].path = 'game/1-LT1.save/child';
    const client = createSavePreparation({ ...f.options, fetcher: async (...args) => args[0].endsWith('?manifest=1')
      ? f.options.fetcher(...args) : new Response(mode === 'oversize' ? 'too many bytes' : 'bad') });
    await assert.rejects(client.prepare({ buildVersion: 'build-1' }));
    assert.ok(!f.shared.has('vnm-saves:A:X:manifest'));
  }
});

test('a game without server saves can prepare an empty checkpoint', async () => {
  const f = fixture(); f.remote.manifest = null; f.remote.currentVersionId = null;
  const result = await f.prepare({ buildVersion: 'build-1' });
  assert.equal(result.ready, true); assert.equal(result.files, 0);
});

test('a pending upload blocks preparation/readiness even if the local dirty marker was lost', async () => {
  const f = fixture(); await f.prepare({ buildVersion: 'build-1' });
  const client = createSavePreparation({ ...f.options, pending: async scope => { assert.equal(scope, 'vnm-saves:A:X'); return true; } });
  const state = await client.readiness('build-1');
  assert.equal(state.reason, 'local-changes'); assert.equal(state.available, true); assert.equal(state.ready, false); assert.equal(state.localChanges, true);
  await assert.rejects(client.prepare({ buildVersion: 'build-1' }), /Sync browser progress/);
});

test('prepared checkpoints cannot roll back a newer acknowledged revision or a different same-revision baseline', async () => {
  const f = fixture(); f.remote.saveChecksum = 'acknowledged-checksum'; await f.prepare({ buildVersion: 'build-1' });
  assert.ok(await f.manifest('build-1', { revision: 1, saveChecksum: 'acknowledged-checksum' }));
  assert.ok(await f.manifest('build-1', { revision: 0 }));
  assert.equal(await f.manifest('build-1', { revision: 2 }), null);
  assert.equal(await f.manifest('build-1', { revision: 1, saveChecksum: 'different' }), null);
});


test('readiness never advertises an older checkpoint after a newer acknowledgement', async () => {
  const f = fixture(); await f.prepare({ buildVersion: 'build-1' });
  const client = createSavePreparation({ ...f.options, baseline: () => ({ revision: 2 }) });
  assert.equal((await client.readiness('build-1')).ready, false);
  assert.equal((await client.readiness('build-1')).reason, 'not-prepared');
});
