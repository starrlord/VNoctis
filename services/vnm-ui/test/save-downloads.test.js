import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const source = readFileSync(new URL('../public/save-sync.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  function createSaveDownloads('), source.indexOf('\n  const downloads ='));
const create = vm.runInNewContext(`(${code.trim()})`, { AbortController, DOMException });
const bytes = id => new Uint8Array([id]);
const hash = value => createHash('sha256').update(value).digest('hex');
const file = id => ({ hash: hash(bytes(id)), size: 1 });
const verify = async value => ({ hash: hash(value), size: value.length, data: Buffer.from(value).toString('base64') });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const requests = [];
  const downloads = create((file, revision, signal) => new Promise((resolve, reject) => {
    const item = { file, revision, signal, resolve, reject }; requests.push(item);
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }), verify, options);
  return { downloads, requests };
}

test('foreground joins an existing prefetch; cancelling one consumer preserves the other', async () => {
  const { downloads, requests } = fixture();
  const controller = new AbortController();
  const prefetch = downloads.get(file(1), 7, { signal: controller.signal });
  const foreground = downloads.get(file(1), 7, { priority: 10 });
  assert.equal(requests.length, 1);
  const cancelled = assert.rejects(prefetch, { name: 'AbortError' }); controller.abort(); await cancelled;
  assert.equal(requests[0].signal.aborted, false);
  requests[0].resolve(bytes(1));
  assert.equal((await foreground).data, 'AQ==');
  assert.equal((await downloads.get(file(1), 8)).data, 'AQ==', 'verified immutable bytes survive a revision change');
  assert.equal(requests.length, 1);
});

test('foreground promotion overtakes queued prefetch while maintaining a two-transfer limit', async () => {
  const { downloads, requests } = fixture();
  const a = downloads.get(file(1), 1), b = downloads.get(file(2), 1);
  const c = downloads.get(file(3), 1), d = downloads.get(file(4), 1);
  const foreground = downloads.get(file(4), 1, { priority: 10 });
  assert.equal(requests.length, 2);
  requests[0].resolve(bytes(1)); await a; await tick();
  assert.equal(requests.length, 3); assert.equal(requests[2].file.hash, file(4).hash);
  requests[2].resolve(bytes(4)); await Promise.all([d, foreground]); await tick();
  assert.equal(requests.length, 4); assert.equal(requests[3].file.hash, file(3).hash);
  requests[1].resolve(bytes(2)); requests[3].resolve(bytes(3)); await Promise.all([b, c]);
});

test('abandoned transfers abort, queued cancellations never fetch, and a fresh retry works', async () => {
  const { downloads, requests } = fixture({ concurrency: 1 });
  const active = new AbortController(), queued = new AbortController();
  const a = downloads.get(file(1), 1, { signal: active.signal });
  const b = downloads.get(file(2), 1, { signal: queued.signal });
  const checks = [assert.rejects(a, { name: 'AbortError' }), assert.rejects(b, { name: 'AbortError' })];
  queued.abort(); active.abort(); await Promise.all(checks); await tick();
  assert.equal(requests.length, 1); assert.equal(requests[0].signal.aborted, true);
  const retry = downloads.get(file(1), 1); assert.equal(requests.length, 2);
  requests[1].resolve(bytes(1)); await retry;
});

test('failed verification is not cached and authorization is checked before cache reuse', async () => {
  let allowed = true;
  const { downloads, requests } = fixture({ authorize: () => { if (!allowed) throw new Error('Account changed'); } });
  const corrupt = downloads.get(file(1), 1); const rejected = assert.rejects(corrupt, /verified/);
  requests[0].resolve(bytes(2)); await rejected;
  const valid = downloads.get(file(1), 1); requests[1].resolve(bytes(1)); await valid;
  allowed = false;
  await assert.rejects(downloads.get(file(1), 1), /Account changed/);
  assert.equal(requests.length, 2);
});

test('revision-specific in-flight requests remain distinct and the verified cache is bounded', async () => {
  const { downloads, requests } = fixture({ cacheBytes: 1 });
  const a = downloads.get(file(1), 1), b = downloads.get(file(1), 2);
  assert.equal(requests.length, 2); requests[0].resolve(bytes(1)); requests[1].resolve(bytes(1)); await Promise.all([a, b]);
  const next = downloads.get(file(2), 2); requests[2].resolve(bytes(2)); await next;
  const evicted = downloads.get(file(1), 2); assert.equal(requests.length, 4); requests[3].resolve(bytes(1)); await evicted;
});

test('an account change during download prevents verification results from entering the cache', async () => {
  let allowed = true;
  const { downloads, requests } = fixture({ authorize: () => { if (!allowed) throw new Error('Account changed'); } });
  const pending = downloads.get(file(1), 1); const rejected = assert.rejects(pending, /Account changed/);
  allowed = false; requests[0].resolve(bytes(1)); await rejected;
  allowed = true; const retry = downloads.get(file(1), 1); assert.equal(requests.length, 2); requests[1].resolve(bytes(1)); await retry;
});
