// Exercise real browser workers, IndexedDB, and asynchronous save writes.
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const bridge = readFileSync(require('node:path').resolve(__dirname, '../public/save-sync.js'));
const playerTest = readFileSync(require('node:path').resolve(__dirname, 'player-integration.cjs'), 'utf8');
const fixture = vm.runInNewContext(playerTest.match(/const fixture = (`[\s\S]*?`);/)[1]);
const token = `header.${Buffer.from(JSON.stringify({ userId: 'A' })).toString('base64url')}.signature`;
let state, uploads, slowDownload, manifestMode, binaryRequests, referenceMode, versions;
const server = createServer(async (req, res) => {
  const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (req.url === '/save-sync.js') { res.setHeader('Content-Type', 'application/javascript'); return res.end(bridge); }
  if (req.url.startsWith('/api/')) {
    if (req.method === 'GET') {
      if (slowDownload) { slowDownload = false; await new Promise(resolve => setTimeout(resolve, 9000)); }
      if (manifestMode && req.url.includes('/files/')) {
        binaryRequests++;
        const hash = req.url.split('/files/')[1].split('?')[0];
        const file = state.snapshot.files.find(file => createHash('sha256').update(Buffer.from(file.data, 'base64')).digest('hex') === hash);
        res.setHeader('Content-Type', 'application/octet-stream');
        return res.end(Buffer.from(file.data, 'base64'));
      }
      if (manifestMode && req.url.includes('manifest=1')) {
        const currentVersionId = state.currentVersionId || 'initial';
        if (!versions.has(currentVersionId)) versions.set(currentVersionId, structuredClone(state.snapshot));
        return json({
        revision: state.revision, fileDownloads: true, deltaUploads: false,
        referenceUploads: referenceMode, currentVersionId,
        manifest: { version: 1, files: state.snapshot.files.map(file => ({ path: file.path, mtime: file.mtime,
          size: Buffer.byteLength(file.data, 'base64'), hash: createHash('sha256').update(Buffer.from(file.data, 'base64')).digest('hex') })) },
      }); }
      return json({ ...state, deltaUploads: false });
    }
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); uploads.push(structuredClone(body));
    if (body.fileSnapshot) {
      const baseline = versions.get(body.fileSnapshot.baseVersionId);
      const available = new Map(baseline.files.map(file => [createHash('sha256').update(Buffer.from(file.data, 'base64')).digest('hex'), file.data]));
      body.snapshot = { version: 1, files: body.fileSnapshot.files.map(file => ({ path: file.path, mtime: file.mtime,
        data: file.data ?? available.get(file.hash) })) };
    }
    state = { revision: state.revision + 1, snapshot: body.snapshot, currentVersionId: `version-${state.revision + 1}` };
    versions.set(state.currentVersionId, structuredClone(state.snapshot));
    return json({ revision: state.revision, disposition: 'current', ...(referenceMode ? { versionId: state.currentVersionId } : {}) });
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url.startsWith('/game') ? fixture : '<iframe src="/game?vnmGame=X&vnmUser=A"></iframe>');
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    for (const mode of ['worker', 'blocked', 'crash', 'slow-download', 'manifest', 'reference', 'reference-race']) {
      state = { revision: 0, snapshot: null }; uploads = [];
      manifestMode = ['manifest', 'reference', 'reference-race'].includes(mode); binaryRequests = 0;
      referenceMode = mode.startsWith('reference'); versions = new Map();
      slowDownload = mode === 'slow-download';
      if (slowDownload) state = { revision: 1, snapshot: { version: 1, files: [
        { path: 'game/1.save', mtime: 1234, data: Buffer.from([13]).toString('base64') },
      ] } };
      if (manifestMode) state = { revision: 1, snapshot: { version: 1, files: [
        { path: 'game/1.save', mtime: 1000, data: Buffer.alloc(800 * 1024, 17).toString('base64') },
        { path: 'game/auto-2.save', mtime: 1000, data: Buffer.alloc(800 * 1024, 17).toString('base64') },
        { path: 'game/persistent', mtime: 1000, data: Buffer.from('preferences').toString('base64') },
      ] } };
      const context = await browser.newContext();
      await context.addInitScript(({ token, mode }) => {
        localStorage.setItem('vnm-token', token);
        window.raceWarnings = [];
        const warn = console.warn; console.warn = (...args) => { raceWarnings.push(args[1]); warn(...args); };
        if (mode === 'reference-race') {
          const nativeFetch = fetch;
          window.fetch = async (...args) => {
            const response = await nativeFetch(...args);
            if (args[1]?.method === 'PUT' && window.raceAfterUpload) {
              window.raceAfterUpload = false; window.raceNextHash = true;
            }
            return response;
          };
        }
        window.workerOperations = []; window.mainEncodings = 0; window.mainLargeJson = 0;
        const jsonTasks = new Set(); window.timeoutDuringJson = false;
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        AbortSignal.timeout = ms => { if (jsonTasks.size) window.timeoutDuringJson = true; return timeout(ms); };
        const encode = window.btoa; window.btoa = value => { mainEncodings++; return encode(value); };
        const stringify = JSON.stringify;
        JSON.stringify = (...args) => {
          if (args[0]?.snapshot || (Array.isArray(args[0]) && typeof args[0][0]?.[1] === 'string' && args[0][0][1].length > 10000)) mainLargeJson++;
          return stringify(...args);
        };
        const NativeWorker = Worker;
        window.Worker = class extends NativeWorker {
          constructor(url) {
            if (mode === 'blocked') throw new Error('Workers blocked');
            super(url);
            this.crashed = false;
            this.addEventListener('message', event => jsonTasks.delete(event.data.id));
          }
          postMessage(message, transfers) {
            workerOperations.push(message.operation);
            if (message.operation === 'json') jsonTasks.add(message.id);
            if (mode === 'reference-race' && message.operation === 'hashes' && window.raceNextHash) {
              window.raceNextHash = false; window.delaySaveWorker = 150;
              setTimeout(() => {
                window.races = (window.races || 0) + 1;
                FS.rename('/home/web_user/.renpy/game/1.save', '/home/web_user/.renpy/game/auto-race.save');
                savedBytes[0] = window.races === 1 ? 9 : 11;
                FS.writeFile('/home/web_user/.renpy/game/1.save', savedBytes);
                FS.syncfs(false, () => {});
              }, 10);
            }
            if (mode === 'worker' && message.operation === 'snapshot' && workerOperations.filter(operation => operation === 'snapshot').length === 3) {
              // A later write after the acknowledgement scan has captured its
              // bytes must not be cleared by that scan's asynchronous result.
              window.delaySaveWorker = 150;
              setTimeout(() => {
                savedBytes[0] = 11;
                FS.writeFile('/home/web_user/.renpy/game/1.save', savedBytes);
                FS.syncfs(false, () => {});
              }, 10);
            }
            if (mode === 'crash' && !this.crashed) {
              this.crashed = true;
              setTimeout(() => this.onerror({ preventDefault() {} }), 0);
              return;
            }
            const delay = window.delaySaveWorker || 0;
            window.delaySaveWorker = 0;
            if (delay) setTimeout(() => super.postMessage(message, transfers), delay);
            else super.postMessage(message, transfers);
          }
        };
      }, { token, mode });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const frame = page.frames().find(frame => frame.url().includes('/game?'));
      await frame.waitForFunction(() => document.body.dataset.ready === 'true');
      if (mode === 'manifest') {
        assert.equal(binaryRequests, 2, 'duplicate/rotated content downloads only once');
        assert.equal(uploads.length, 0);
        assert.equal(await frame.evaluate(() => FS.readFile('/home/web_user/.renpy/game/1.save')[0]), 17);
        assert.equal(await frame.evaluate(() => FS.readFile('/home/web_user/.renpy/game/auto-2.save').length), 800 * 1024);
        assert.equal(await frame.evaluate(() => mainEncodings), 0, 'download encoding runs in the worker');
        assert.ok((await frame.evaluate(() => workerOperations)).includes('download'));
        assert.deepEqual(errors, []);
        console.log('PASS manifest: verified binary downloads, shared-hash reuse, worker encoding');
        await context.close(); continue;
      }
      if (mode === 'slow-download') {
        assert.equal(await frame.evaluate(() => FS.readFile('/home/web_user/.renpy/game/1.save')[0]), 13);
        assert.equal(uploads.length, 0);
        assert.deepEqual(errors, []);
        console.log('PASS slow-download: server progress loads after a nine-second response delay');
        await context.close(); continue;
      }
      await frame.evaluate(mode => {
        FS.mkdirTree('/home/web_user/.renpy/game');
        window.savedBytes = new Uint8Array((mode === 'worker' ? 12 : 1) * 1024 * 1024).fill(7);
        window.mainEncodings = 0; window.mainLargeJson = 0;
        window.animationTicks = 0;
        const animate = () => { animationTicks++; requestAnimationFrame(animate); }; requestAnimationFrame(animate);
        window.delaySaveWorker = mode === 'worker' ? 150 : 0;
        if (mode === 'reference-race') { window.raceNextHash = true; window.raceAfterUpload = true; }
        FS.writeFile('/home/web_user/.renpy/game/1.save', savedBytes);
        FS.syncfs(false, () => {});
      }, mode);
      // Change the engine's bytes while the previous snapshot is in flight.
      if (mode === 'worker') {
        await frame.waitForTimeout(30);
        await frame.evaluate(() => {
          savedBytes[0] = 9;
          FS.writeFile('/home/web_user/.renpy/game/1.save', savedBytes);
          FS.syncfs(false, () => {});
        });
      }
      const deadline = Date.now() + 15000;
      const expected = ['worker', 'reference-race'].includes(mode) ? 11 : 7;
      while ((!state.snapshot || Buffer.from(state.snapshot.files.find(file => file.path === 'game/1.save')?.data || '', 'base64')[0] !== expected) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.equal(Buffer.from(state.snapshot?.files.find(file => file.path === 'game/1.save')?.data || '', 'base64')[0], expected);
      const metrics = await frame.evaluate(() => ({ operations: workerOperations, mainEncodings, mainLargeJson, animationTicks,
        firstByte: FS.readFile('/home/web_user/.renpy/game/1.save')[0], bytes: FS.readFile('/home/web_user/.renpy/game/1.save').length }));
      assert.equal(metrics.firstByte, expected, 'worker transfer must not detach or mutate engine memory');
      assert.equal(await frame.evaluate(() => timeoutDuringJson), false, 'request timeout starts after JSON preparation');
      assert.ok(metrics.bytes > 0);
      if (referenceMode) {
        await frame.waitForFunction(() => !JSON.parse(localStorage.getItem('vnm-saves:A:X:meta')).dirty);
        assert.ok(uploads[0].fileSnapshot); assert.equal('catalog' in uploads[0], false);
        assert.ok(uploads[0].fileSnapshot.files.find(file => file.path.endsWith('auto-2.save')).hash);
        const catalog = await frame.evaluate(() => new Promise((resolve, reject) => {
          const request = indexedDB.open('vnm-save-outbox', 3);
          request.onsuccess = () => {
            const db = request.result, tx = db.transaction('catalogs');
            const read = tx.objectStore('catalogs').get('vnm-saves:A:X');
            tx.oncomplete = () => { db.close(); resolve(read.result); }; tx.onabort = () => reject(tx.error);
          };
        }));
        assert.equal(catalog.baseVersionId, state.currentVersionId);
        assert.equal(metrics.mainEncodings, 0); assert.equal(metrics.mainLargeJson, 0);
        if (mode === 'reference-race') {
          assert.equal(await frame.evaluate(() => races), 2, 'exercise preparation and acknowledgement races');
          assert.deepEqual(await frame.evaluate(() => raceWarnings), [], 'ordinary autosave races are not storage failures');
          assert.equal(uploads.length, 2, 'acknowledgement retries must not resend an accepted request');
          assert.ok(state.snapshot.files.some(file => file.path === 'game/auto-race.save'));
        }
        const before = uploads.length;
        await page.reload();
        const reopened = page.frames().find(frame => frame.url().includes('/game?'));
        await reopened.waitForFunction(() => document.body.dataset.ready === 'true');
        assert.equal(await reopened.evaluate(() => FS.readFile('/home/web_user/.renpy/game/1.save')[0]), expected);
        assert.equal(uploads.length, before, 'reload restores the catalog without publishing an empty filesystem');
      }
      if (mode === 'worker') {
        assert.ok(metrics.operations.includes('snapshot') && metrics.operations.includes('json'));
        assert.equal(metrics.mainEncodings, 0, 'base64 encoding belongs to the worker');
        assert.equal(metrics.mainLargeJson, 0, 'large JSON serialization belongs to the worker');
        assert.ok(metrics.animationTicks > 1, 'animation continues while save processing is pending');
        assert.ok(uploads.length >= 2, 'a save during preparation must follow the older captured snapshot');
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${mode}: ${JSON.stringify(metrics)}`);
      await context.close();
    }
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
