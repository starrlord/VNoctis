import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../public/save-sync.js', import.meta.url), 'utf8');
const root = '/home/web_user/.renpy';
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const saveHash = copy => createHash('sha256').update(JSON.stringify((copy?.files || [])
  .filter(file => file.path.endsWith('.save')).map(file => [file.path, file.data])
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');

// Model the IDBFS populate/flush boundary rather than Ren'Py save semantics.
function browser(server, databases, { user = 'A', game = 'X', metadata = new Map(), choices = [], savedir, buildVersion = null, adapter = false } = {}) {
  server.receipts ||= new Map(); server.alternates ||= [];
  server.uploads ||= [];
  server.referenceVersions ||= new Map();
  const files = new Map(); const dirs = new Set([root]); const statuses = [], warnings = [], requestTimeouts = [];
  const events = [];
  const backups = new Map();
  let interval, offline = false, encodings = 0;
  let nextUploadGate, nextFlushGate, nextFlushFailure;
  let activeFlushes = 0, maxFlushes = 0, nativeFlushCalls = 0;
  let loseResponse = false;
  const listeners = new Map(); const documentListeners = new Map();
  const timers = new Map(); let timerId = 0;
  const token = `header.${Buffer.from(JSON.stringify({ userId: user })).toString('base64url')}.signature`;
  metadata.set('vnm-token', token);
  const namespace = `vnm-saves:${user}:${game}`;
  const fs = {
    readdir: path => ['.', '..', ...new Set([...dirs, ...files.keys()].filter(p => p.startsWith(`${path}/`)).map(p => p.slice(path.length + 1).split('/')[0]))],
    stat: path => ({ mode: dirs.has(path) ? 0o40777 : 0o100666, mtime: new Date(files.get(path)?.mtime || 0) }),
    isDir: mode => (mode & 0o170000) === 0o40000,
    isFile: mode => (mode & 0o170000) === 0o100000,
    readFile: path => files.get(path).bytes,
    writeFile: (path, bytes) => { files.set(path, { bytes: new Uint8Array(bytes), mtime: 1234 }); fs.close({ path, flags: 1 }); },
    close() {},
    rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    mkdirTree: path => { const parts = path.split('/'); while (parts.length) { dirs.add(parts.join('/')); parts.pop(); } },
    utime: (path, atime, mtime) => { files.get(path).mtime = mtime; },
    unlink: path => files.delete(path), rmdir: path => dirs.delete(path),
    syncfs: (populate, callback) => context.IDBFS.getDB(root, (err, db) => {
      activeFlushes++; nativeFlushCalls++; maxFlushes = Math.max(maxFlushes, activeFlushes);
      const failure = nextFlushFailure || server.onNativeFlush?.(fs); nextFlushFailure = null;
      const complete = error => { activeFlushes--; callback(failure || error); };
      if (failure) { /* Keep the prior durable copy on a failed flush. */ }
      else if (populate) {
        files.clear(); for (const [path, value] of db.files) { fs.mkdirTree(path.slice(0, path.lastIndexOf('/'))); files.set(path, value); }
      } else db.files = new Map(files);
      const gate = nextFlushGate; nextFlushGate = null;
      if (gate) gate.then(() => complete(err)); else complete(err);
    }),
  };
  const context = {
    location: { search: `?vnmGame=${game}&vnmUser=${user}&vnmBuild=${encodeURIComponent(buildVersion || '')}`, origin: 'https://vnm.test' },
    URLSearchParams, Uint8Array, AbortController, DOMException,
    ...(server.fileDownloads ? { crypto: webcrypto } : {}),
    ...(adapter ? { __VNM_SAVE_ADAPTER__: { version: 1, engine: '8.5.2.26010301' } } : {}),
    AbortSignal: { any: signals => AbortSignal.any(signals), timeout: ms => { requestTimeouts.push(ms); return AbortSignal.timeout(ms); } },
    console: { warn: (...args) => warnings.push(args) },
    setTimeout: (fn, ms, ...args) => server.pausePrefetch && ms === 1000 ? 0 : setTimeout(fn, ms, ...args), clearTimeout,
    atob: s => Buffer.from(s, 'base64').toString('binary'), btoa: s => { encodings++; return Buffer.from(s, 'binary').toString('base64'); },
    localStorage: { getItem: key => metadata.get(key) ?? null, setItem: (key, value) => metadata.set(key, value) },
    parent: { postMessage: data => { statuses.push(data.message); events.push(data); } },
    Module: { FS: fs },
    ...(savedir === undefined ? {} : { renpy_get: async expression => { assert.equal(expression, 'config.savedir'); return savedir; } }),
    IDBFS: { getDB: (name, callback) => {
      if (!databases.has(name)) databases.set(name, { files: new Map() });
      const db = databases.get(name);
      db.transaction = () => {
        const tx = { objectStore: () => ({ openCursor: () => {
          const req = {}; const entries = [...db.files]; let index = 0;
          const next = () => queueMicrotask(() => {
            const item = entries[index++];
            req.result = item ? { key: item[0], value: { contents: item[1].bytes, timestamp: new Date(item[1].mtime) }, continue: next } : null;
            req.onsuccess(); if (!item) tx.oncomplete();
          }); next(); return req;
        } }) }; return tx;
      };
      callback(null, db);
    } },
    setInterval: callback => { interval = callback; timers.set(++timerId, callback); return timerId; },
    clearInterval: id => timers.delete(id),
    addEventListener: (event, callback) => listeners.set(event, callback),
    document: { visibilityState: 'visible', addEventListener: (event, callback) => documentListeners.set(event, callback), createElement: tag => ({ style: {}, append() {}, remove() {}, tag }), body: {
      append: panel => { /* replaced below to capture actual buttons */ },
    } },
    indexedDB: { open: name => {
      const req = {};
      if (server.storageFailure) {
        queueMicrotask(() => { req.error = new DOMException('Browser storage denied', 'SecurityError'); req.onerror(); });
        return req;
      }
      if (!databases.has(name)) databases.set(name, { files: new Map() });
      const storage = name === 'vnm-save-backups' ? backups : databases.get(name).files;
      queueMicrotask(() => {
        req.result = { close() {}, transaction: storeName => {
          const storeKey = key => name === 'vnm-save-outbox' ? `${storeName}:${key}` : key;
          const action = (operation, key, value) => {
            const result = { result: undefined };
            queueMicrotask(() => {
              if (operation === 'put') {
                if (storeName === 'catalogs') server.catalogWrites = (server.catalogWrites || 0) + 1;
                storage.set(storeKey(key), JSON.parse(JSON.stringify(value)));
              }
              if (operation === 'delete') storage.delete(storeKey(key));
              if (operation === 'get') result.result = storage.get(storeKey(key));
              tx.oncomplete();
            }); return result;
          };
          const tx = { objectStore: () => ({
            put: (copy, key) => action('put', key, copy),
            get: key => action('get', key), delete: key => action('delete', key),
          }) }; return tx;
        } }; req.onsuccess();
      }); return req;
    } },
    fetch: async (url, options) => {
      if (options.method === 'GET') server.downloadAttempts = (server.downloadAttempts || 0) + 1;
      if (offline) throw new Error('network down');
      const key = `${user}:${game}`;
      const state = server.get(key) || { revision: 0, snapshot: null };
      if (options.method === 'GET') {
        if (server.downloadFailures) { server.downloadFailures--; throw new TypeError('Failed to fetch'); }
        if (server.downloadRejection) return { ok: false, status: server.downloadRejection, json: async () => ({}) };
        if (server.downloadBodyFailures) {
          server.downloadBodyFailures--;
          return { ok: true, status: 200, json: async () => { throw new DOMException('Body download aborted', 'AbortError'); } };
        }
        const id = new URLSearchParams(url.split('?')[1] || '').get('uploadId');
        if (url.includes('/preview?')) return { ok: true, status: 200, json: async () => ({ version: 1, supported: true,
          metadata: { _save_name: 'Remote slot' }, screenshot: null }) };
        if (url.includes('/files/')) {
          const hash = url.split('/files/')[1].split('?')[0];
          server.binaryRequests ||= []; server.binaryRequests.push(hash);
          if (server.changeDuringDownload) {
            const change = server.changeDuringDownload; delete server.changeDuringDownload;
            server.set(key, { revision: state.revision + 1, snapshot: change });
            return { ok: false, status: 409, json: async () => ({ code: 'SAVE_MANIFEST_CHANGED', message: 'Server changed' }) };
          }
          const versionId = url.includes('/versions/') ? decodeURIComponent(url.split('/versions/')[1].split('/')[0]) : null;
          const source = versionId ? server.referenceVersions.get(versionId) : state.snapshot;
          const file = source.files.find(file => createHash('sha256').update(Buffer.from(file.data, 'base64')).digest('hex') === hash);
          const bytes = server.corruptDownload ? Buffer.from('corrupt') : Buffer.from(file.data, 'base64');
          return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
        }
        if (server.fileDownloads && url.includes('manifest=1')) {
          const versionId = state.snapshot ? state.currentVersionId || `${key}-version-${state.revision}` : null;
          if (versionId && !server.referenceVersions.has(versionId)) server.referenceVersions.set(versionId, structuredClone(state.snapshot));
          return { ok: true, status: 200, json: async () => ({
          revision: state.revision, fileDownloads: true, deltaUploads: true, saveChecksum: saveHash(state.snapshot),
          referenceUploads: Boolean(server.referenceUploads), currentVersionId: versionId,
          previewDownloads: Boolean(server.referenceUploads), saveDirectory: server.directories?.get(key) || null, saveBuildVersion: server.buildVersion || null,
          manifest: state.snapshot && { version: 1, files: state.snapshot.files.map(file => ({ path: file.path, mtime: file.mtime,
            size: Buffer.byteLength(file.data, 'base64'), hash: createHash('sha256').update(Buffer.from(file.data, 'base64')).digest('hex') })) },
          acknowledgement: server.receipts.get(`${key}:${id}`)?.response || null,
        }) }; }
        return { ok: true, status: 200, json: async () => ({ saveDirectory: server.directories?.get(key) || null, saveBuildVersion: server.buildVersion || null,
          ...state, deltaUploads: server.deltaUploads !== false, saveChecksum: saveHash(state.snapshot),
          acknowledgement: server.receipts.get(`${key}:${id}`)?.response || null }) };
      }
      const body = JSON.parse(options.body);
      if (url.endsWith('/directory') && options.method === 'POST') {
        server.directoryRequests = (server.directoryRequests || 0) + 1;
        if (server.directoryStatus === 409) return { ok: false, status: 409, json: async () => ({ code: 'SAVE_BUILD_CHANGED' }) };
        server.directories ||= new Map(); server.directories.set(key, body.directory);
        return { ok: true, status: 200, json: async () => body };
      }
      server.uploads.push(structuredClone(body));
      const identity = JSON.stringify(body.fileSnapshot || body.delta || body.snapshot);
      const receiptKey = `${key}:${body.uploadId}`, receipt = server.receipts.get(receiptKey);
      if (receipt) {
        if (receipt.payload !== identity) return { ok: false, status: 409, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => receipt.response };
      }
      if (body.fileSnapshot) {
        if (server.referenceRejection) return { ok: false, status: 409, json: async () => ({ code: 'SAVE_REFERENCE_BASE_MISSING', message: 'Baseline expired' }) };
        const baseline = server.referenceVersions.get(body.fileSnapshot.baseVersionId) || state.snapshot;
        const available = new Map((baseline?.files || []).map(file => [createHash('sha256').update(Buffer.from(file.data, 'base64')).digest('hex'), file.data]));
        body.snapshot = { version: 1, files: body.fileSnapshot.files.map(file => ({ path: file.path, mtime: file.mtime, data: file.data ?? available.get(file.hash) })) };
      }
      if (server.uploadRejection && (!server.uploadRejection.deltaOnly || body.delta)) {
        const { status: code, ...details } = server.uploadRejection;
        return { ok: false, status: code, json: async () => details };
      }
      if (body.delta) {
        if (body.alternate || body.revision !== state.revision) return { ok: false, status: 409,
          json: async () => ({ code: 'SAVE_BASE_CHANGED', message: 'Server changed' }) };
        const files = new Map((state.snapshot?.files || []).map(file => [file.path, file]));
        for (const path of body.delta.deleted) files.delete(path);
        for (const file of body.delta.files) files.set(file.path, file);
        body.snapshot = { version: 1, files: [...files.values()] };
      }
      const alternate = state.snapshot && (body.alternate || (state.revision !== body.revision &&
        body.baseSaveChecksum !== saveHash(state.snapshot) && saveHash(body.snapshot) !== saveHash(state.snapshot)));
      const next = { revision: alternate ? body.revision : state.revision + 1, snapshot: body.snapshot, uploadId: body.uploadId };
      const versionId = server.referenceUploads && (alternate || !state.snapshot || saveHash(state.snapshot) !== saveHash(body.snapshot)) ? `${key}-${body.uploadId}` : null;
      if (versionId) server.referenceVersions.set(versionId, structuredClone(body.snapshot));
      if (server.referenceUploads) next.currentVersionId = versionId || state.currentVersionId || `${key}-version-${state.revision}`;
      const branchId = alternate ? body.branchId || body.uploadId : null;
      if (alternate) server.alternates.push({ key, branchId, snapshot: body.snapshot });
      else server.set(key, next);
      const response = { revision: next.revision, disposition: alternate ? 'alternate' : 'current', branchId, saveChecksum: saveHash(body.snapshot),
        ...(server.referenceUploads ? { versionId } : {}) };
      server.receipts.set(receiptKey, { payload: identity, response });
      if (loseResponse) { loseResponse = false; throw new Error('response lost after commit'); }
      const gate = nextUploadGate; nextUploadGate = null;
      if (gate) await gate;
      return { ok: true, status: 200, json: async () => response };
    },
  };
  const buttons = [];
  const prompts = [];
  context.document.createElement = tag => ({ style: {}, append(...children) { for (const child of children) if (child.tag === 'button') buttons.push(child); }, remove() {}, tag });
  context.document.body.append = () => { if (buttons.at(-1)?.textContent === 'Cancel') { buttons.length = 0; return; }
    prompts.push(buttons.map(button => button.textContent)); const index = choices.shift() ?? 0; queueMicrotask(() => buttons.splice(0)[index].onclick()); };
  context.window = context;
  vm.createContext(context); vm.runInContext(source, context);
  return {
    fs, statuses, events, metadata, namespace, backups, prompts, warnings, requestTimeouts,
    flushMetrics: () => ({ active: activeFlushes, max: maxFlushes, calls: nativeFlushCalls }),
    runtime: () => context.vnmSaves,
    async loadSlot(path) { context.vnmSaves.begin(`${root}/${path}`); while (context.vnmSaves.transfer.pending) await settle(); return context.vnmSaves.transfer; },
    encodedCount: () => encodings,
    offline: value => { offline = value; },
    pauseNextUpload() { let release; nextUploadGate = new Promise(resolve => { release = resolve; }); return release; },
    failNextFlush(error) { nextFlushFailure = error; },
    pauseNextFlushCallback() { let release; nextFlushGate = new Promise(resolve => { release = resolve; }); return release; },
    loseNextResponse() { loseResponse = true; },
    activeTimers: () => timers.size,
    async event(name) { listeners.get(name)?.(); await settle(); },
    async visibility(state) { context.document.visibilityState = state; documentListeners.get('visibilitychange')?.(); await settle(); },
    async start() { context.Module.preInit.at(-1)(); await new Promise(resolve => fs.syncfs(true, resolve)); await settle(); },
    async flush() { await new Promise(resolve => fs.syncfs(false, resolve)); await settle(); },
    async save(data = 'progress') { fs.mkdirTree(`${root}/game`); fs.writeFile(`${root}/game/1.save`, Buffer.from(data)); await new Promise(resolve => fs.syncfs(false, resolve)); await settle(); await interval(); await settle(); },
    async retry() { await interval(); await settle(); },
  };
}

test('guarded lazy startup loads the newest slot and keeps remote slots visible and loadable after a save', async () => {
  const make = (slot, mtime) => ({ path: `game/${slot}-LT1.save`, mtime, data: Buffer.from(slot).toString('base64') });
  const server = new Map([['A:X', { revision: 1, snapshot: { version: 1, files: [make('1-1', 100), make('1-2', 200), make('auto-1', 300)] } }]]);
  server.fileDownloads = true; server.referenceUploads = true; server.pausePrefetch = true; server.directories = new Map([['A:X', 'game']]);
  const databases = new Map(), metadata = new Map();
  const page = browser(server, databases, { metadata, adapter: true }); await page.start();
  assert.equal(page.runtime().active, true); assert.equal(server.binaryRequests.length, 1);
  assert.deepEqual(page.fs.readdir(`${root}/game`).filter(name => name.endsWith('.save')), ['auto-1-LT1.save']);
  assert.equal(Object.keys(page.runtime().rows(`${root}/game`, '-LT1.save')).length, 3);
  assert.equal(Object.keys(page.runtime().rows(`${root}/game/sync`, '-LT1.save')).length, 0);
  page.fs.writeFile(`${root}/game/1-1-LT1.save`, Buffer.from('new manual')); await page.flush(); await page.retry();
  assert.equal(server.uploads.at(-1).fileSnapshot.files.length, 3);
  const before = server.uploads.length;
  assert.equal((await page.loadSlot('game/1-2-LT1.save')).error, null);
  await page.flush(); await page.retry();
  assert.equal(server.uploads.length, before, 'cache hydration is not progress');
  assert.equal(Buffer.from(page.fs.readFile(`${root}/game/1-2-LT1.save`)).toString(), '1-2');
  const reload = browser(server, databases, { metadata, adapter: true }); await reload.start();
  assert.equal(reload.runtime().active, true); assert.equal(server.alternates.length, 0);
});

test('remote-only rotation and offline recovery preserve the logical folder', async () => {
  const server = new Map([['A:X', { revision: 1, snapshot: { version: 1, files: [1, 2, 3].flatMap(n => ['', 'sync/'].map(folder => ({ path: `game/${folder}auto-${n}-LT1.save`, mtime: n,
    data: Buffer.from(`auto-${n}`).toString('base64') }))) } }]]);
  server.fileDownloads = true; server.referenceUploads = true; server.pausePrefetch = true; server.directories = new Map([['A:X', 'game']]);
  const databases = new Map(), metadata = new Map(); const page = browser(server, databases, { metadata, adapter: true }); await page.start();
  assert.equal(server.binaryRequests.length, 1, 'matching sync mirrors must not force eager hydration');
  page.runtime().mutate(`${root}/game`, 'copy', 'auto-1', 'auto-3', '-LT1.save');
  assert.equal(page.fs.readdir(`${root}/game`).includes('auto-3-LT1.save'), false,
    'a remote-only source must invalidate an old resident destination');
  page.runtime().mutate(`${root}/game`, 'copy', 'auto-1', 'copied', '-LT1.save'); await settle(); await page.retry();
  assert.ok(server.get('A:X').snapshot.files.some(file => file.path === 'game/copied-LT1.save'));
  assert.ok(server.get('A:X').snapshot.files.some(file => file.path === 'game/sync/copied-LT1.save'));
  page.offline(true);
  page.runtime().mutate(`${root}/game`, 'rename', 'auto-1', 'moved', '-LT1.save'); await settle(); await page.retry();
  const reload = browser(server, databases, { metadata, adapter: true }); await reload.start();
  assert.ok(server.get('A:X').snapshot.files.some(file => file.path === 'game/moved-LT1.save'));
  assert.ok(!server.get('A:X').snapshot.files.some(file => file.path === 'game/auto-1-LT1.save'));
  assert.ok(!reload.statuses.some(message => message.includes('paused')));
});

test('catalog-enabled sessions persist scoped state and upload mixed references with explicit deletions', async () => {
  const f = (path, text) => ({ path, mtime: 1234, data: Buffer.from(text).toString('base64') });
  const server = new Map([['A:X', { revision: 1, snapshot: { version: 1, files: [f('game/1.save', 'manual'), f('game/auto-1.save', 'auto'), f('game/persistent', 'prefs')] } }]]);
  server.fileDownloads = true; server.referenceUploads = true;
  const databases = new Map(), metadata = new Map();
  const page = browser(server, databases, { metadata }); await page.start();
  const catalogKey = 'catalogs:vnm-saves:A:X';
  assert.equal(databases.get('vnm-save-outbox').files.get(catalogKey).baseVersionId, 'A:X-version-1');
  const catalogWrites = server.catalogWrites;
  for (let i = 0; i < 25; i++) await page.flush();
  await page.retry();
  assert.equal(server.catalogWrites, catalogWrites, 'routine unchanged flushes must not rewrite the catalog');
  assert.equal(server.uploads.length, 0);
  await page.save('changed');
  assert.ok(server.uploads[0].fileSnapshot); assert.equal('catalog' in server.uploads[0], false, 'local recovery data must not be sent');
  const entries = new Map(server.uploads[0].fileSnapshot.files.map(file => [file.path, file]));
  assert.equal(entries.get('game/auto-1.save').data, undefined); assert.ok(entries.get('game/auto-1.save').hash);
  assert.ok(entries.get('game/1.save').data); assert.ok(entries.get('game/persistent').data);
  page.fs.rename(`${root}/game/auto-1.save`, `${root}/game/auto-2.save`);
  page.fs.unlink(`${root}/game/1.save`); await page.flush(); await page.retry();
  const final = server.get('A:X').snapshot.files.map(file => file.path).sort();
  assert.deepEqual(final, ['game/auto-2.save', 'game/persistent']);
  const reload = browser(server, databases, { metadata }); await reload.start();
  assert.equal(reload.fs.readdir(`${root}/game`).includes('1.save'), false);
  const uploads = server.uploads.length;
  const other = browser(server, databases, { user: 'B', metadata: new Map() }); await other.start();
  assert.equal(server.uploads.length, uploads);
  assert.equal(databases.get('vnm-save-outbox').files.get('catalogs:vnm-saves:B:X').files.length, 0);
});

test('browser filesystem flush bursts serialize native work and coalesce queued writes', async () => {
  const databases = new Map(), page = browser(new Map(), databases); await page.start(); page.offline(true);
  const before = page.flushMetrics().calls, release = page.pauseNextFlushCallback();
  const pending = [page.flush()];
  for (let i = 0; i < 10; i++) {
    page.fs.mkdirTree(`${root}/game`);
    page.fs.writeFile(`${root}/game/persistent`, Buffer.from(`preferences-${i}`));
    pending.push(page.flush());
  }
  await settle();
  const concurrent = page.flushMetrics().max;
  release(); await Promise.all(pending);
  assert.equal(concurrent, 1, 'IDBFS reconciliation must never overlap');
  assert.equal(page.flushMetrics().active, 0);
  assert.equal(page.flushMetrics().calls - before, 2, 'ten queued writes share one follow-up flush');
  assert.equal(Buffer.from(databases.get(page.namespace).files.get(`${root}/game/persistent`).bytes).toString(), 'preferences-9');
});

test('slot writes during an active flush receive another durable flush without an engine request', async () => {
  const databases = new Map(), page = browser(new Map(), databases); await page.start(); page.offline(true);
  const release = page.pauseNextFlushCallback(), first = page.flush();
  page.fs.mkdirTree(`${root}/game`); page.fs.writeFile(`${root}/game/auto-1.save`, Buffer.from('latest autosave'));
  await new Promise(resolve => setTimeout(resolve,10));
  release(); await first; await new Promise(resolve => setTimeout(resolve,50)); await settle();
  assert.equal(Buffer.from(databases.get(page.namespace).files.get(`${root}/game/auto-1.save`).bytes).toString(),'latest autosave');
  assert.equal(page.flushMetrics().max,1); assert.deepEqual(page.warnings.filter(entry=>entry[1].stage==='storage'),[]);
});

test('a rotated-away slot retries a changed filesystem before acknowledging persistence', async () => {
  const databases = new Map(), page = browser(new Map(), databases); await page.start(); page.offline(true);
  page.failNextFlush({name:'ErrnoError',errno:44});
  const release = page.pauseNextFlushCallback();
  const first = new Promise(resolve => page.fs.syncfs(false,resolve));
  page.fs.mkdirTree(`${root}/game`); page.fs.writeFile(`${root}/game/auto-1.save`,Buffer.from('newer autosave'));
  release(); assert.equal(await first,null); await new Promise(resolve => setTimeout(resolve,50)); await settle();
  assert.equal(Buffer.from(databases.get(page.namespace).files.get(`${root}/game/auto-1.save`).bytes).toString(),'newer autosave');
  assert.equal(page.flushMetrics().max,1); assert.deepEqual(page.warnings.filter(entry=>entry[1].stage==='storage'),[]);
});

test('real storage failures reach callbacks and do not prevent the next queued flush', async () => {
  const databases = new Map(), page = browser(new Map(),databases); await page.start(); page.offline(true);
  const before = page.flushMetrics().calls, error = new DOMException('Browser disk quota full','QuotaExceededError');
  page.failNextFlush(error); const release=page.pauseNextFlushCallback();
  const first=new Promise(resolve=>page.fs.syncfs(false,resolve)), next=new Promise(resolve=>page.fs.syncfs(false,resolve));
  release(); assert.equal(await first,error); assert.equal(await next,null);
  assert.equal(page.flushMetrics().calls-before,2,'quota failures must not be retried as rotation races');
  assert.equal(page.warnings[0][1].name,'QuotaExceededError'); assert.equal(page.flushMetrics().max,1);
});

test('a continuously changing missing-file race stops retrying after three retries', async () => {
  const server=new Map(),page=browser(server,new Map());await page.start();page.offline(true);page.fs.mkdirTree(`${root}/game`);
  const before=page.flushMetrics().calls,error={name:'ErrnoError',errno:44};let mutations=0;
  server.onNativeFlush=fs=>{fs.writeFile(`${root}/game/auto-1.save`,Buffer.from('rotation-'+(++mutations)));return error;};
  const failure=await new Promise(resolve=>page.fs.syncfs(false,resolve));server.onNativeFlush=null;
  assert.equal(failure,error);assert.equal(mutations,4);assert.equal(page.flushMetrics().calls-before,4);
  assert.ok(page.warnings.some(entry=>entry[1].stage==='storage'&&entry[1].errno===44));
  await new Promise(resolve=>setTimeout(resolve,40));await settle();assert.equal(page.flushMetrics().active,0);
});

test('unchanged missing paths remain errors with a useful filesystem error number', async () => {
  const page=browser(new Map(),new Map()); await page.start(); page.offline(true);
  const before=page.flushMetrics().calls,error={name:'ErrnoError',errno:44};page.failNextFlush(error);
  assert.equal(await new Promise(resolve=>page.fs.syncfs(false,resolve)),error);
  assert.equal(page.flushMetrics().calls-before,1);assert.equal(page.warnings[0][1].errno,44);assert.match(page.warnings[0][1].message,/44/);
});

test('queued flush requests alone cannot disguise an unchanged missing-file failure', async () => {
  const page=browser(new Map(),new Map());await page.start();page.offline(true);
  const before=page.flushMetrics().calls,error={name:'ErrnoError',errno:44};page.failNextFlush(error);
  const release=page.pauseNextFlushCallback();const first=new Promise(resolve=>page.fs.syncfs(false,resolve)),next=new Promise(resolve=>page.fs.syncfs(false,resolve));
  release();assert.equal(await first,error);assert.equal(await next,null);assert.equal(page.flushMetrics().calls-before,2);
});

test('the callback-only syncfs overload flushes without repopulating browser files', async () => {
  const databases=new Map(),page=browser(new Map(),databases);await page.start();page.offline(true);
  page.fs.mkdirTree(`${root}/game`);page.fs.writeFile(`${root}/game/persistent`,Buffer.from('latest preferences'));
  await new Promise(resolve=>page.fs.syncfs(resolve));
  assert.equal(Buffer.from(databases.get(page.namespace).files.get(`${root}/game/persistent`).bytes).toString(),'latest preferences');
});

test('an older filesystem flush callback cannot overwrite a newer saved catalog', async () => {
  const server = new Map([['A:X', { revision: 1, snapshot: { version: 1, files: [
    { path: 'game/auto-1.save', mtime: 1234, data: Buffer.from('auto').toString('base64') },
  ] } }]]); server.fileDownloads = true; server.referenceUploads = true;
  const databases = new Map(), page = browser(server, databases); await page.start(); page.offline(true);
  page.fs.rename(`${root}/game/auto-1.save`, `${root}/game/auto-2.save`);
  const release = page.pauseNextFlushCallback(); const oldFlush = page.flush();
  page.fs.unlink(`${root}/game/auto-2.save`); const newFlush = page.flush(); release(); await Promise.all([oldFlush, newFlush]);
  const stored = databases.get('vnm-save-outbox').files.get('catalogs:vnm-saves:A:X');
  assert.equal(stored.files.length, 0);
});

test('catalog recovery keeps offline mutations and lost reference acknowledgements across reloads', async () => {
  const server = new Map(); server.fileDownloads = true; server.referenceUploads = true;
  const databases = new Map(), metadata = new Map();
  const page = browser(server, databases, { metadata }); await page.start(); await page.save('initial');
  page.offline(true); await page.save('offline progress');
  const pending = databases.get('vnm-save-outbox').files.get('uploads:vnm-saves:A:X'); assert.ok(pending.fileSnapshot); assert.ok(pending.catalog);
  const reload = browser(server, databases, { metadata }); await reload.start();
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'offline progress');
  reload.loseNextResponse(); await reload.save('accepted before response lost');
  const revision = server.get('A:X').revision;
  const again = browser(server, databases, { metadata }); await again.start();
  assert.equal(server.get('A:X').revision, revision); assert.equal(server.alternates.length, 0);
  assert.equal(Buffer.from(again.fs.readFile(`${root}/game/1.save`)).toString(), 'accepted before response lost');
});

test('offline startup recovers a pending backup after engine storage eviction without replacing newer resident progress', async () => {
  for (const evicted of [true, false]) {
    const file = (slot, mtime) => ({ path: `game/${slot}-LT1.save`, mtime, data: Buffer.from(slot).toString('base64') });
    const server = new Map([['A:X', { revision: 1, snapshot: { version: 1, files: [file('1-1', 100), file('auto-1', 200)] } }]]);
    server.fileDownloads = true; server.referenceUploads = true; server.pausePrefetch = true;
    server.directories = new Map([['A:X', 'game']]);
    const databases = new Map(), metadata = new Map();
    const page = browser(server, databases, { metadata, adapter: true }); await page.start(); page.offline(true);
    page.fs.writeFile(`${root}/game/1-1-LT1.save`, Buffer.from('pending progress')); await page.flush(); await page.retry();
    const pending = databases.get('vnm-save-outbox').files.get('uploads:vnm-saves:A:X');
    assert.ok(pending.fileSnapshot.files.some(row => row.hash && !row.data));
    if (evicted) databases.delete('vnm-saves:A:X');
    else { page.fs.writeFile(`${root}/game/1-1-LT1.save`, Buffer.from('newer resident progress')); await page.flush(); }
    const reload = browser(server, databases, { metadata, adapter: true }); reload.offline(true); await reload.start();
    assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1-1-LT1.save`)).toString(), evicted ? 'pending progress' : 'newer resident progress');
    assert.equal(databases.get('vnm-save-outbox').files.get('uploads:vnm-saves:A:X').uploadId, pending.uploadId);
    assert.equal(reload.runtime().active, true);
    assert.equal(Object.keys(reload.runtime().rows(`${root}/game`, '-LT1.save')).length, 2);
    const otherUser = browser(server, databases, { metadata, adapter: true, user: 'B' });
    otherUser.offline(true); await otherUser.start();
    assert.equal(otherUser.fs.readdir(root).filter(name => name !== '.' && name !== '..').length, 0);
    assert.equal(otherUser.runtime().active, false, 'another account cannot recover this pending backup or catalog');
  }
});

test('a write during a catalog upload follows the acknowledgement without being cleared', async () => {
  const server = new Map(); server.fileDownloads = true; server.referenceUploads = true;
  const page = browser(server, new Map()); await page.start(); await page.save('initial');
  const release = page.pauseNextUpload();
  page.fs.writeFile(`${root}/game/1.save`, Buffer.from('first')); await page.flush();
  page.fs.writeFile(`${root}/game/1.save`, Buffer.from('second')); await page.flush(); release();
  await settle(); await page.retry(); await settle();
  assert.equal(Buffer.from(server.get('A:X').snapshot.files[0].data, 'base64').toString(), 'second');
  assert.ok(server.uploads.every(request => request.fileSnapshot));
  assert.ok(!page.statuses.some(message => message.includes('paused')));
});

test('expired reference baselines fall back only when every logical file has verified local bytes', async () => {
  const native = (path, text) => ({ path, mtime: 1234, data: Buffer.from(text).toString('base64') });
  const owned = native('game/1.save', 'offline progress'), original = native('game/auto-1.save', 'older remote');
  const ref = { path: original.path, mtime: original.mtime, size: Buffer.byteLength(original.data, 'base64'),
    hash: createHash('sha256').update(Buffer.from(original.data, 'base64')).digest('hex') };
  for (const complete of [true, false]) {
    const server = new Map([['A:X', { revision: 1, snapshot: { version: 1, files: [original] } }]]);
    server.referenceRejection = true; server.fileDownloads = true;
    const request = { revision: 1, uploadId: 'logical-pending', snapshot: { version: 1, files: [owned, ...(complete ? [original] : [])] },
      fileSnapshot: { version: 1, baseVersionId: 'expired', files: [owned, ref] } };
    const databases = new Map([['vnm-save-outbox', { files: new Map([['uploads:vnm-saves:A:X', request]]) }]]);
    const page = browser(server, databases); await page.start();
    if (complete) {
      assert.equal(server.uploads.length, 2);
      assert.ok(server.uploads[0].fileSnapshot); assert.ok(server.uploads[1].snapshot);
      assert.equal(server.get('A:X').snapshot.files.length, 2);
      assert.equal(Buffer.from(server.get('A:X').snapshot.files.find(file => file.path === owned.path).data, 'base64').toString(), 'offline progress');
    } else {
      await page.retry(); await page.event('online');
      assert.equal(server.uploads.length, 1, 'an incomplete browser copy must never become a full upload');
      assert.ok(page.statuses.some(message => message.includes('baseline expired')));
      assert.ok(databases.get('vnm-save-outbox').files.get('uploads:vnm-saves:A:X').fileSnapshot);
      assert.equal(server.get('A:X').revision, 1);
    }
  }
});

test('manifest startup reuses verified bytes, downloads changed files only, and handles rotation/deletion', async () => {
  const file = (path, text, mtime = 1234) => ({ path, mtime, data: Buffer.from(text).toString('base64') });
  const copy = { version: 1, files: [file('game/1.save', 'first'), file('game/2.save', 'second'), file('game/persistent', 'prefs')] };
  const server = new Map([['A:X', { revision: 1, snapshot: copy }]]); server.fileDownloads = true;
  const databases = new Map(), metadata = new Map();
  await browser(server, databases, { metadata }).start();
  assert.equal(server.binaryRequests.length, 3);
  server.binaryRequests = [];
  const reload = browser(server, databases, { metadata }); let writes = 0;
  const write = reload.fs.writeFile; reload.fs.writeFile = (...args) => { writes++; return write(...args); };
  await reload.start();
  assert.equal(server.binaryRequests.length, 0, 'unchanged launches transfer no save bytes');
  assert.equal(writes, 0, 'unchanged launches do not rewrite resident files');
  server.set('A:X', { revision: 2, snapshot: { version: 1, files: [
    file('game/auto-2.save', 'first'), file('game/2.save', 'new second'), file('tokens/key', 'signing'),
  ] } });
  const changed = browser(server, databases, { metadata }); await changed.start();
  assert.equal(server.binaryRequests.length, 2, 'rotated content is reused across filenames');
  assert.equal(Buffer.from(changed.fs.readFile(`${root}/game/auto-2.save`)).toString(), 'first');
  assert.equal(Buffer.from(changed.fs.readFile(`${root}/game/2.save`)).toString(), 'new second');
  assert.equal(changed.fs.readdir(`${root}/game`).includes('1.save'), false);
  assert.equal(changed.fs.readdir(`${root}/game`).includes('persistent'), false);
  assert.equal(server.uploads.length, 0);
});

test('a revision change retries the manifest and never installs a mixed download', async () => {
  const make = text => ({ version: 1, files: [{ path: 'game/1.save', mtime: 1234, data: Buffer.from(text).toString('base64') }] });
  const server = new Map([['A:X', { revision: 1, snapshot: make('old') }]]);
  server.fileDownloads = true; server.changeDuringDownload = make('new');
  const page = browser(server, new Map()); await page.start();
  assert.equal(Buffer.from(page.fs.readFile(`${root}/game/1.save`)).toString(), 'new');
  assert.equal(server.binaryRequests.length, 2);
  assert.ok(page.statuses.includes('Retrying save download…'));
});

test('corrupt binary content preserves the browser copy and reports through the save status channel', async () => {
  const make = text => ({ version: 1, files: [{ path: 'game/1.save', mtime: 1234, data: Buffer.from(text).toString('base64') }] });
  const server = new Map([['A:X', { revision: 1, snapshot: make('browser') }]]); server.fileDownloads = true;
  const databases = new Map(), metadata = new Map();
  await browser(server, databases, { metadata }).start();
  server.set('A:X', { revision: 2, snapshot: make('changed') }); server.corruptDownload = true;
  const page = browser(server, databases, { metadata }); await page.start();
  assert.equal(Buffer.from(page.fs.readFile(`${root}/game/1.save`)).toString(), 'browser');
  assert.ok(page.statuses.some(message => message.startsWith('Server saves could not be loaded')));
  assert.equal(server.uploads.length, 0);
});

test('manifest downloads preserve divergent offline browser progress in history', async () => {
  const server = new Map(); server.fileDownloads = true;
  const db = new Map(), metadata = new Map();
  const desktop = browser(server, db, { metadata }); await desktop.start(); await desktop.save('first');
  const mobile = browser(server, new Map()); await mobile.start(); await mobile.save('mobile progress');
  desktop.offline(true); await desktop.save('offline desktop progress');
  const reload = browser(server, db, { metadata }); await reload.start();
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'mobile progress');
  assert.equal(server.alternates.length, 1);
  assert.equal(Buffer.from(server.alternates[0].snapshot.files[0].data, 'base64').toString(), 'offline desktop progress');
});

test('startup retries a transient save download or interrupted response body before releasing the game', async () => {
  for (const failure of ['downloadFailures', 'downloadBodyFailures']) {
    const copy = { version: 1, files: [{ path: 'game/1.save', mtime: 1234, data: Buffer.from('server progress').toString('base64') }] };
    const server = new Map([['A:X', { revision: 1, snapshot: copy }]]); server[failure] = 1;
    const page = browser(server, new Map()); await page.start();
    assert.equal(server.downloadAttempts, 2);
    assert.equal(Buffer.from(page.fs.readFile(`${root}/game/1.save`)).toString(), 'server progress');
    assert.equal(page.statuses.at(-1), 'Saves synced');
    assert.ok(page.requestTimeouts.every(ms => ms === 60000));
    assert.equal(page.warnings[0][1].stage, 'download');
    assert.equal(server.uploads.length, 0);
  }
});

test('failed startup downloads are bounded, keep local saves, and later upload acknowledgement does not imply a successful load', async () => {
  const server = new Map(), databases = new Map(); server.downloadFailures = 2;
  const page = browser(server, databases); await page.start();
  assert.equal(server.downloadAttempts, 2);
  assert.match(page.statuses.at(-1), /Server saves could not be loaded/);
  await page.save('new local progress');
  assert.match(page.statuses.at(-1), /server saves were not loaded/);
  assert.equal(Buffer.from(page.fs.readFile(`${root}/game/1.save`)).toString(), 'new local progress');
  assert.ok(page.warnings.every(([, detail]) => !JSON.stringify(detail).includes('signature')));
});

test('browser persistence failures report storage instead of pretending the network is offline', async () => {
  const server = new Map(); server.storageFailure = true;
  const page = browser(server, new Map()); await page.start();
  assert.match(page.statuses.at(-1), /Browser save storage failed/);
  assert.equal(page.warnings[0][1].stage, 'storage');
  assert.equal(page.warnings[0][1].name, 'SecurityError');
  assert.equal(server.downloadAttempts, undefined);
});

test('expired authentication pauses startup and upload triggers without retrying or disguising it as offline', async () => {
  const server = new Map(); server.downloadRejection = 401;
  const page = browser(server, new Map()); await page.start(); await page.save('retained'); await page.retry();
  assert.equal(server.downloadAttempts, 1);
  assert.equal(server.uploads.length, 0);
  assert.match(page.statuses.at(-1), /sign in again/);
  assert.equal(page.warnings[0][1].status, 401);
});

test('startup restores a server snapshot larger than 32 MiB', async () => {
  const data = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64');
  const copy = { version: 1, files: Array.from({ length: 11 }, (_, i) => ({
    path: `game/${i}.save`, mtime: 1234, data,
  })) };
  const server = new Map([['A:X', { revision: 1, snapshot: copy }]]);
  const page = browser(server, new Map()); await page.start();
  assert.equal(page.fs.readFile(`${root}/game/10.save`).length, 3 * 1024 * 1024);
  assert.ok(page.statuses.includes('Saves synced'));
  assert.equal(server.uploads.length, 0);
});

test('startup recovery validation failure retains local files and pauses without rejecting initialization', async () => {
  const databases = new Map([['vnm-saves:A:X', { files: new Map([
    [`${root}/game/bad\\name.save`, { bytes: Buffer.from('retained'), mtime: 1234 }],
  ]) }]]);
  const server = new Map(); const page = browser(server, databases);
  page.offline(true); await page.start();
  assert.equal(Buffer.from(page.fs.readFile(`${root}/game/bad\\name.save`)).toString(), 'retained');
  assert.ok(page.statuses.some(message => message.startsWith('Save sync paused')));
  page.offline(false); await page.retry();
  assert.equal(server.uploads.length, 0);
});

test('permanent upload rejection pauses all triggers and retains latest local saves and outbox across reload', async () => {
  const server = new Map(), databases = new Map();
  server.uploadRejection = { status: 400, message: 'Invalid resulting save snapshot.' };
  const first = browser(server, databases); await first.start(); await first.save('first');
  assert.equal(server.uploads.length, 1);
  assert.match(first.statuses.at(-1), /Save sync paused/);
  await first.save('latest'); await first.retry(); await first.event('online'); await first.visibility('visible');
  assert.equal(server.uploads.length, 1, 'Permanent rejection must not repeatedly upload');
  const restarted = browser(server, databases); await restarted.start(); await restarted.retry();
  assert.equal(server.uploads.length, 2, 'Reload attempts once and pauses again');
  assert.match(restarted.statuses.at(-1), /Save sync paused/);
  assert.equal(Buffer.from(restarted.fs.readFile(`${root}/game/1.save`)).toString(), 'latest');
  delete server.uploadRejection;
  const recovered = browser(server, databases); await recovered.start(); await recovered.retry();
  assert.equal(Buffer.from(server.get('A:X').snapshot.files.find(file => file.path.endsWith('1.save')).data, 'base64').toString(), 'latest');
});

test('temporary server errors retry the same pending upload and recover', async () => {
  const server = new Map(), databases = new Map();
  const page = browser(server, databases); await page.start();
  server.uploadRejection = { status: 503, message: 'Temporary failure' };
  await page.save('offline progress'); await page.retry();
  assert.ok(server.uploads.length >= 2);
  assert.equal(new Set(server.uploads.map(upload => upload.uploadId)).size, 1);
  delete server.uploadRejection; await page.retry();
  assert.equal(server.get('A:X').revision, 1);
});

test('invalid expanded delta retries once as its preserved full snapshot', async () => {
  const server = new Map(), databases = new Map();
  const page = browser(server, databases); await page.start(); await page.save('baseline');
  server.uploadRejection = { status: 400, code: 'SAVE_INVALID_RESULT', message: 'File overlaps folder', deltaOnly: true };
  const prior = server.uploads.length; await page.save('new progress');
  const attempts = server.uploads.slice(prior);
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0].delta); assert.ok(attempts[1].snapshot);
  assert.equal(attempts[0].uploadId, attempts[1].uploadId);
  assert.equal(server.get('A:X').revision, 2);
});

test('runtime directory reporting is independent of saves and retries after offline startup', async () => {
  const server = new Map();
  const a = browser(server, new Map(), { savedir: `${root}/Lewd Town Adventures` });
  a.offline(true); await a.start();
  assert.equal(server.directories, undefined);
  a.offline(false); await a.retry();
  assert.equal(server.directories.get('A:X'), 'Lewd Town Adventures');
  assert.equal(server.has('A:X'), false); assert.equal(server.uploads.length, 0);
  for (const savedir of ['/game/saves', `${root}/../Other`, `${root}/tokens`, `${root}/Game//saves`]) {
    const b = browser(server, new Map(), { user: 'B', savedir }); await b.start();
    assert.equal(server.directories.has('B:X'), false);
  }
});

test('a stale build directory report stops retrying without pausing save uploads', async () => {
  const server = new Map(); server.directoryStatus = 409;
  const a = browser(server, new Map(), { savedir: `${root}/game` }); await a.start();
  await a.save('still playing'); await a.retry();
  assert.equal(server.directoryRequests, 1);
  assert.equal(server.get('A:X').snapshot.files[0].data, Buffer.from('still playing').toString('base64'));
  assert.ok(a.statuses.includes('Saves synced'));
});

test('device handoff retains complete files and isolates users and games', async () => {
  const server = new Map();
  const a = browser(server, new Map()); await a.start(); await a.save();
  const b = browser(server, new Map()); await b.start();
  assert.equal(Buffer.from(b.fs.readFile(`${root}/game/1.save`)).toString(), 'progress');
  const otherUser = browser(server, new Map(), { user: 'B' }); await otherUser.start();
  assert.equal(otherUser.fs.readdir(root).length, 2);
  const otherGame = browser(server, new Map(), { game: 'Y' }); await otherGame.start();
  assert.equal(otherGame.fs.readdir(root).length, 2);
  assert.ok(a.statuses.includes('Saves synced'));
});

test('offline writes survive reload and resume against the acknowledged revision', async () => {
  const server = new Map(), databases = new Map(), metadata = new Map();
  const a = browser(server, databases, { metadata }); await a.start(); await a.save('first');
  a.offline(true); await a.save('offline');
  assert.equal(server.get('A:X').revision, 1);
  const reload = browser(server, databases, { metadata }); reload.offline(true); await reload.start();
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'offline');
  reload.offline(false); await reload.retry();
  assert.equal(server.get('A:X').revision, 2);
});

test('competing sessions preserve the rejected browser copy', async () => {
  const server = new Map();
  const a = browser(server, new Map()); await a.start(); await a.save('initial');
  const b = browser(server, new Map()); await b.start();
  await a.save('winner'); await b.save('conflicting');
  assert.equal(server.get('A:X').revision, 2);
  assert.equal(Buffer.from(b.fs.readFile(`${root}/game/1.save`)).toString(), 'conflicting');
  assert.ok(b.statuses.includes('Save backed up as alternate version'));
  assert.equal(server.alternates.length, 1);
  await b.save('alternate continuation');
  assert.equal(server.alternates.length, 2);
  assert.equal(server.alternates[0].branchId, server.alternates[1].branchId);
  await b.retry(); assert.equal(server.get('A:X').revision, 2);
});

test('explicit legacy import copies only the selected game plus signing keys', async () => {
  const server = new Map(), databases = new Map();
  server.directories = new Map([['A:X', 'old-game']]);
  databases.set(root, { files: new Map([
    [`${root}/old-game/1.save`, { bytes: Buffer.from('legacy'), mtime: 1000 }],
    [`${root}/other-game/1.save`, { bytes: Buffer.from('other'), mtime: 1000 }],
    [`${root}/tokens/security_keys.txt`, { bytes: Buffer.from('keys'), mtime: 1000 }],
  ]) });
  const a = browser(server, databases, { choices: [1] }); await a.start();
  assert.deepEqual(a.prompts, [['Start without importing', 'Import old-game']]);
  const files = server.get('A:X').snapshot.files;
  assert.deepEqual(files.map(f => f.path).sort(), ['old-game/1.save', 'tokens/security_keys.txt']);
  assert.equal(databases.get(root).files.size, 3);
});

test('declining legacy import leaves original saves untouched', async () => {
  const databases = new Map([[root, { files: new Map([[`${root}/old/1.save`, { bytes: Buffer.from('legacy'), mtime: 1 }]]) }]]);
  const server = new Map(); server.directories = new Map([['A:X', 'old']]);
  const a = browser(server, databases); await a.start();
  assert.equal(a.prompts.length, 1);
  assert.equal(server.size, 0); assert.equal(databases.get(root).files.size, 1);
});

test('legacy migration skips unrelated, unknown, and stale-build directories', async () => {
  for (const [directory, buildVersion] of [['Lewd Town Adventures', null], [null, null], ['Abnormal-1686524459', 'new-build']]) {
    const server = new Map(); server.directories = new Map([['A:X', directory]]); server.buildVersion = buildVersion;
    const databases = new Map([[root, { files: new Map([
      [`${root}/Abnormal-1686524459/1.save`, { bytes: Buffer.from('other game'), mtime: 1 }],
    ]) }]]);
    const a = browser(server, databases, { choices: [1] }); await a.start();
    assert.deepEqual(a.prompts, []); assert.equal(server.uploads.length, 0);
    assert.equal(databases.get(root).files.size, 1);
  }
});

test('legacy migration matches nested directory paths exactly', async () => {
  const server = new Map(); server.directories = new Map([['A:X', 'Games/Abnormal']]);
  const databases = new Map([[root, { files: new Map([
    [`${root}/Games/Abnormal/1.save`, { bytes: Buffer.from('matching'), mtime: 1 }],
    [`${root}/Games/Abnormal-other/1.save`, { bytes: Buffer.from('unrelated'), mtime: 1 }],
    [`${root}/Games/Lewd Town/persistent`, { bytes: Buffer.from('unrelated'), mtime: 1 }],
  ]) }]]);
  const a = browser(server, databases, { choices: [1] }); await a.start();
  assert.deepEqual(a.prompts, [['Start without importing', 'Import Games/Abnormal']]);
  assert.deepEqual(server.get('A:X').snapshot.files.map(file => file.path), ['Games/Abnormal/1.save']);
  assert.equal(databases.get(root).files.size, 3);
});

test('startup preserves offline progress as an alternate and loads synced saves without a prompt', async () => {
  const server = new Map(), databases = new Map(), metadata = new Map();
  const a = browser(server, databases, { metadata }); await a.start(); await a.save('initial');
  a.offline(true); await a.save('offline progress');
  const b = browser(server, new Map()); await b.start(); await b.save('server progress');
  const reload = browser(server, databases, { metadata }); await reload.start();
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'server progress');
  assert.ok(reload.statuses.includes('Unsynced device saves preserved in history'));
  assert.equal(server.alternates.length, 1);
  const copy = server.alternates[0].snapshot;
  assert.equal(Buffer.from(copy.files[0].data, 'base64').toString(), 'offline progress');
});

test('unchanged filesystem flushes and timestamp-only touches do not upload or flash status', async () => {
  const server = new Map(); const a = browser(server, new Map());
  await a.start(); await a.save('saved progress');
  const notices = [...a.statuses];
  for (let i = 0; i < 30; i++) await a.flush();
  await a.retry();
  assert.equal(server.get('A:X').revision, 1);
  assert.deepEqual(a.statuses, notices);
  a.fs.utime(`${root}/game/1.save`, 9999, 9999);
  await a.flush(); await a.retry();
  assert.equal(server.get('A:X').revision, 1);
  assert.deepEqual(a.statuses, notices);
});

test('frequent real changes are batched and persistent-only changes and deletions still sync', async () => {
  const server = new Map(); const a = browser(server, new Map()); await a.start(); await a.save();
  for (let i = 0; i < 30; i++) {
    a.fs.writeFile(`${root}/game/persistent`, Buffer.from(`seen text ${i}`));
    await a.flush();
  }
  assert.equal(server.get('A:X').revision, 1);
  await a.retry();
  assert.equal(server.get('A:X').revision, 2);
  const persistent = server.get('A:X').snapshot.files.find(f => f.path.endsWith('/persistent'));
  assert.equal(Buffer.from(persistent.data, 'base64').toString(), 'seen text 29');
  a.fs.unlink(`${root}/game/1.save`); await a.flush(); await a.retry();
  assert.equal(server.get('A:X').revision, 3);
  assert.equal(server.get('A:X').snapshot.files.length, 1);
  assert.equal(a.events.filter(event => event.saveUploaded).length, 1);
});

test('each successful save-slot upload is acknowledged; offline failures are not', async () => {
  const server = new Map(); const a = browser(server, new Map()); await a.start();
  await a.save('first'); await a.save('second');
  assert.equal(a.events.filter(event => event.saveUploaded).length, 2);
  a.offline(true); await a.save('offline save');
  assert.equal(a.events.filter(event => event.saveUploaded).length, 2);
  a.offline(false); await a.retry();
  assert.equal(a.events.filter(event => event.saveUploaded).length, 3);
  for (const filename of ['auto-1.save', 'quick-1.save']) {
    a.fs.writeFile(`${root}/game/${filename}`, Buffer.from(filename));
    await a.flush(); await a.retry();
  }
  assert.equal(a.events.filter(event => event.saveUploaded).length, 5);
});

test('direct and atomic slot writes upload after flush without waiting for the timer', async () => {
  const server = new Map(); const a = browser(server, new Map()); await a.start();
  a.fs.mkdirTree(`${root}/game`);
  a.fs.writeFile(`${root}/game/1.save`, Buffer.from('first'));
  assert.equal(server.has('A:X'), false);
  await a.flush();
  assert.equal(server.get('A:X').revision, 1);
  a.fs.writeFile(`${root}/game/1.save`, Buffer.from('first')); await a.flush();
  assert.equal(server.get('A:X').revision, 1, 'identical slot bytes are deduplicated');
  a.fs.writeFile(`${root}/game/persistent`, Buffer.from('preferences')); await a.flush();
  assert.equal(server.get('A:X').revision, 1, 'persistent data stays batched');
  a.fs.writeFile(`${root}/game/tmp`, Buffer.from('quick save'));
  a.fs.rename(`${root}/game/tmp`, `${root}/game/quick-1.save`);
  await a.flush();
  assert.equal(server.get('A:X').revision, 2);
  assert.equal(a.events.filter(event => event.saveUploaded).length, 2);
});

test('completed slot writes persist and upload without an engine flush or retry timer', async () => {
  const server = new Map(), databases = new Map(); const a = browser(server, databases); await a.start();
  a.fs.mkdirTree(`${root}/game`);
  a.fs.writeFile(`${root}/game/1.save`, Buffer.from('manual save'));
  await new Promise(resolve => setTimeout(resolve, 20)); await settle();
  assert.equal(server.get('A:X').revision, 1);
  assert.ok(databases.get(a.namespace).files.has(`${root}/game/1.save`), 'Persist before acknowledging');
  a.fs.writeFile(`${root}/game/temp`, Buffer.from('quick save'));
  a.fs.rename(`${root}/game/temp`, `${root}/game/quick-1.save`);
  await new Promise(resolve => setTimeout(resolve, 20)); await settle();
  assert.equal(server.get('A:X').revision, 2);
  assert.equal(a.events.filter(event => event.saveUploaded).length, 2);
});

test('changed-file uploads omit untouched slots, include deletions, and fall back safely on a stale baseline', async () => {
  const server = new Map(), a = browser(server, new Map()); await a.start();
  a.fs.mkdirTree(`${root}/game`);
  a.fs.writeFile(`${root}/game/2.save`, Buffer.alloc(1024 * 1024, 42)); await a.save('first');
  await a.save('second');
  const patch = server.uploads.at(-1);
  assert.equal(patch.snapshot, undefined);
  assert.equal(patch.delta.files.length, 1);
  assert.equal(patch.delta.files[0].path, 'game/1.save');
  assert.ok(JSON.stringify(patch).length < 1024, 'Unchanged large slot does not cross the network');
  a.fs.unlink(`${root}/game/2.save`); await a.flush(); await a.retry();
  assert.deepEqual(server.uploads.at(-1).delta.deleted, ['game/2.save']);
  assert.equal(server.get('A:X').snapshot.files.length, 1);
  const other = browser(server, new Map()); await other.start(); await other.save('another device');
  await a.save('independent progress');
  const attempts = server.uploads.slice(-2);
  assert.ok(attempts[0].delta); assert.ok(attempts[1].snapshot);
  assert.equal(attempts[0].uploadId, attempts[1].uploadId);
  assert.equal(server.alternates.at(-1).snapshot.files[0].data, Buffer.from('independent progress').toString('base64'));
  assert.equal(server.get('A:X').snapshot.files[0].data, Buffer.from('another device').toString('base64'));
});

test('encoding cache skips unchanged bytes but detects same-size edits with unchanged timestamps', async () => {
  const server = new Map(), a = browser(server, new Map()); await a.start(); await a.save('abc');
  const count = a.encodedCount();
  a.fs.utime(`${root}/game/1.save`, 9999, 9999); await a.flush(); await a.retry();
  assert.equal(a.encodedCount(), count);
  a.fs.writeFile(`${root}/game/1.save`, Buffer.from('def'));
  a.fs.utime(`${root}/game/1.save`, 9999, 9999); await a.flush();
  assert.equal(a.encodedCount(), count + 1);
  assert.equal(Buffer.from(server.get('A:X').snapshot.files[0].data, 'base64').toString(), 'def');
});

test('servers without delta capability keep receiving complete snapshots', async () => {
  const server = new Map(); server.deltaUploads = false;
  const a = browser(server, new Map()); await a.start(); await a.save('first'); await a.save('second');
  assert.ok(server.uploads.every(upload => upload.snapshot && !upload.delta));
});

test('lost full-fallback acknowledgement survives reload without duplicating an alternate', async () => {
  const server = new Map(), databases = new Map(), metadata = new Map();
  const a = browser(server, databases, { metadata }); await a.start(); await a.save('baseline');
  const other = browser(server, new Map()); await other.start(); await other.save('server progress');
  a.loseNextResponse();
  a.fs.writeFile(`${root}/game/1.save`, Buffer.from('independent progress')); await a.flush();
  assert.equal(server.alternates.length, 1);
  const stored = databases.get('vnm-save-outbox').files.get('uploads:vnm-saves:A:X');
  assert.equal(stored.delta, undefined, 'Fallback mode is durable before sending');
  assert.ok(stored.snapshot);
  const reload = browser(server, databases, { metadata }); await reload.start();
  assert.equal(server.alternates.length, 1);
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'server progress');
});

test('a slot saved during an upload follows immediately after its acknowledgement', async () => {
  const server = new Map(); const a = browser(server, new Map()); await a.start();
  const release = a.pauseNextUpload();
  a.fs.mkdirTree(`${root}/game`);
  a.fs.writeFile(`${root}/game/auto-1.save`, Buffer.from('first')); await a.flush();
  a.fs.writeFile(`${root}/game/auto-1.save`, Buffer.from('second')); await a.flush();
  assert.equal(server.get('A:X').revision, 1);
  release(); await settle();
  assert.equal(server.get('A:X').revision, 2);
  const slot = server.get('A:X').snapshot.files.find(file => file.path.endsWith('auto-1.save'));
  assert.equal(Buffer.from(slot.data, 'base64').toString(), 'second');
});

test('lost acknowledgement retries the same upload before uploading newer offline progress', async () => {
  const server = new Map(), databases = new Map(), metadata = new Map();
  const a = browser(server, databases, { metadata }); await a.start();
  a.loseNextResponse();
  a.fs.mkdirTree(`${root}/game`);
  a.fs.writeFile(`${root}/game/1.save`, Buffer.from('committed')); await a.flush();
  assert.equal(server.get('A:X').revision, 1);
  const firstId = server.get('A:X').uploadId;
  a.offline(true); a.fs.writeFile(`${root}/game/1.save`, Buffer.from('offline progress')); await a.flush();
  const reload = browser(server, databases, { metadata }); reload.offline(true); await reload.start();
  reload.offline(false); await reload.retry();
  assert.equal(server.get('A:X').revision, 2);
  assert.notEqual(server.get('A:X').uploadId, firstId);
  assert.equal(Buffer.from(server.get('A:X').snapshot.files.find(file => file.path.endsWith('.save')).data, 'base64').toString(), 'offline progress');
  assert.ok(!reload.statuses.some(status => status.startsWith('Conflict')));
});

test('reload recognizes an already committed upload even when its response was lost', async () => {
  const server = new Map(), databases = new Map(), metadata = new Map();
  const a = browser(server, databases, { metadata }); await a.start();
  a.loseNextResponse(); a.fs.mkdirTree(`${root}/game`);
  a.fs.writeFile(`${root}/game/1.save`, Buffer.from('committed')); await a.flush();
  const reload = browser(server, databases, { metadata }); await reload.start();
  assert.equal(server.get('A:X').revision, 1);
  assert.ok(!reload.statuses.some(status => status.startsWith('Conflict')));
  assert.ok(!databases.get('vnm-save-outbox').files.has('uploads:vnm-saves:A:X'));
});

test('page and visibility restoration restart one timer and upload pending offline data', async () => {
  const server = new Map(); const a = browser(server, new Map()); await a.start();
  a.offline(true); a.fs.mkdirTree(`${root}/game`);
  a.fs.writeFile(`${root}/game/persistent`, Buffer.from('preferences')); await a.flush();
  await a.event('pagehide'); assert.equal(a.activeTimers(), 0);
  a.offline(false); await a.event('pageshow');
  assert.equal(a.activeTimers(), 1); assert.equal(server.get('A:X').revision, 1);
  await a.event('pageshow'); await a.visibility('visible');
  assert.equal(a.activeTimers(), 1);
  assert.equal(server.get('A:X').revision, 1);
});

test('desktop-to-mobile handoff silently replaces stale slots despite dirty persistent data', async () => {
  const server = new Map(), mobileDatabases = new Map(), mobileMetadata = new Map();
  const desktop = browser(server, new Map()); await desktop.start(); await desktop.save('first');
  const mobile = browser(server, mobileDatabases, { metadata: mobileMetadata }); await mobile.start();
  mobile.offline(true);
  mobile.fs.writeFile(`${root}/game/persistent`, Buffer.from('local seen text')); await mobile.flush();
  await desktop.save('new desktop progress');
  const reload = browser(server, mobileDatabases, { metadata: mobileMetadata }); await reload.start();
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'new desktop progress');
  assert.equal(server.get('A:X').revision, 2);
  assert.ok(!reload.statuses.some(status => status.startsWith('Conflict')));
});

test('actual offline slot progress on both devices is archived before loading the server continuation', async () => {
  const server = new Map(), mobileDatabases = new Map(), mobileMetadata = new Map();
  const desktop = browser(server, new Map()); await desktop.start(); await desktop.save('first');
  const mobile = browser(server, mobileDatabases, { metadata: mobileMetadata }); await mobile.start();
  mobile.offline(true); await mobile.save('offline mobile progress');
  await desktop.save('desktop progress');
  const reload = browser(server, mobileDatabases, { metadata: mobileMetadata }); await reload.start();
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'desktop progress');
  assert.ok(reload.statuses.includes('Unsynced device saves preserved in history'));
  assert.equal(Buffer.from(server.alternates[0].snapshot.files.find(file => file.path.endsWith('.save')).data, 'base64').toString(), 'offline mobile progress');
});

test('offline save progress publishes without conflict when only server preferences advanced', async () => {
  const server = new Map(), mobileDatabases = new Map(), mobileMetadata = new Map();
  const desktop = browser(server, new Map()); await desktop.start(); await desktop.save('first');
  const mobile = browser(server, mobileDatabases, { metadata: mobileMetadata }); await mobile.start();
  mobile.offline(true); await mobile.save('offline mobile progress');
  desktop.fs.writeFile(`${root}/game/persistent`, Buffer.from('desktop preferences'));
  await desktop.flush(); await desktop.retry();
  assert.equal(server.get('A:X').revision, 2);
  const reload = browser(server, mobileDatabases, { metadata: mobileMetadata }); await reload.start();
  assert.equal(server.get('A:X').revision, 3);
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'offline mobile progress');
  assert.ok(!reload.statuses.some(status => status.startsWith('Conflict')));
});

test('a lost acknowledgement remains valid after another device advances the server', async () => {
  const server = new Map(), databases = new Map(), metadata = new Map();
  const desktop = browser(server, databases, { metadata }); await desktop.start(); await desktop.save('first');
  desktop.loseNextResponse(); desktop.fs.writeFile(`${root}/game/1.save`, Buffer.from('accepted desktop save')); await desktop.flush();
  const mobile = browser(server, new Map()); await mobile.start(); await mobile.save('new mobile save');
  const reload = browser(server, databases, { metadata }); await reload.start();
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'new mobile save');
  assert.equal(server.alternates.length, 0);
  assert.equal(server.get('A:X').revision, 3);
});

test('an evicted clean browser filesystem restores the server copy instead of publishing deletions', async () => {
  const server = new Map(), databases = new Map(), metadata = new Map();
  const a = browser(server, databases, { metadata }); await a.start(); await a.save('server progress');
  databases.get(a.namespace).files.clear();
  const reload = browser(server, databases, { metadata }); await reload.start();
  assert.equal(Buffer.from(reload.fs.readFile(`${root}/game/1.save`)).toString(), 'server progress');
  assert.equal(server.get('A:X').revision, 1);
});
