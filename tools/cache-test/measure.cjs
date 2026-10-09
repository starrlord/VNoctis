// Measure the real player without request routing (routing disables HTTP caching).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const base = process.env.CACHE_TEST_URL || 'http://localhost:3180';
const storage = path.resolve(__dirname, '../../test-data/cache-test');
const run = path.join(storage, 'results', new Date().toISOString().replace(/[:.]/g, '-'));
// Browser blob caching needs ample free disk space, independently of the quota
// reported by navigator.storage. Use the system temp drive, not the game drive.
const profile = path.join(process.env.CACHE_TEST_PROFILE_ROOT || path.join(os.tmpdir(), 'vnm-cache-test'), String(Date.now()));
const report = { base, profile, startedAt: new Date().toISOString(), phases: [], errors: [] };
fs.mkdirSync(run, { recursive: true });
const writeReport = () => fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
const readLog = () => {
  const file = path.join(storage, 'logs/cache-test.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
};
let context;
let token;
let game;
async function launch() {
  const chrome = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
  context = await chromium.launchPersistentContext(profile, {
    ...(chrome ? { executablePath: chrome } : {}), headless: process.env.CACHE_TEST_VISIBLE !== '1',
    viewport: { width: 1280, height: 720 },
    args: ['--enable-unsafe-swiftshader'],
  });
  await context.addInitScript(value => { if (!localStorage.getItem('vnm-token')) localStorage.setItem('vnm-token', value); }, token);
  return context.pages()[0] || await context.newPage();
}
async function measure(label, page, navigate) {
  const before = readLog().length;
  const phase = { label, startedAt: new Date().toISOString(), requests: [], console: [] };
  report.phases.push(phase);
  const session = await context.newCDPSession(page);
  const requests = new Map();
  await session.send('Network.enable');
  session.on('Network.requestWillBeSent', event => requests.set(event.requestId, { url: event.request.url }));
  session.on('Network.requestServedFromCache', event => {
    const item = requests.get(event.requestId); if (item) item.servedFromCache = true;
  });
  session.on('Network.responseReceived', event => {
    const item = requests.get(event.requestId); if (item) Object.assign(item, {
      status: event.response.status, fromDiskCache: event.response.fromDiskCache,
      fromServiceWorker: event.response.fromServiceWorker,
    });
  });
  session.on('Network.loadingFinished', event => {
    const item = requests.get(event.requestId);
    if (item && item.url.includes('/web-builds/')) phase.requests.push({ ...item, encodedBytes: event.encodedDataLength });
  });
  const onError = error => report.errors.push({ phase: label, message: error.message });
  const onConsole = message => {
    if (phase.console.length < 100) phase.console.push({ type: message.type(), text: message.text().slice(0, 1000) });
  };
  page.on('pageerror', onError); page.on('console', onConsole);
  const start = Date.now();
  try {
    await navigate();
    await page.waitForSelector('iframe');
    await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.getElementById('canvas'), null, { timeout: 30000 });
    const frame = page.frames().find(frame => frame.url().includes('/web-builds/'));
    assert.ok(frame, 'real game iframe must mount');
    await frame.waitForFunction(() => !document.getElementById('presplash') && !!window.Module?.calledRun, null, { timeout: 180000 });
    phase.readyMs = Date.now() - start;
    // Let startup asset requests and Nginx's completed-response logs settle.
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(run, `${label}.png`) });
    phase.storage = await frame.evaluate(async () => ({
      estimate: await navigator.storage.estimate(),
      caches: await Promise.all((await caches.keys()).map(async name => ({ name, entries: (await (await caches.open(name)).keys()).length }))),
      worker: navigator.serviceWorker.controller?.scriptURL || null,
    }));
    const worker = context.serviceWorkers().find(worker => worker.url().includes('game-cache-worker.js'));
    if (worker) phase.cacheDiagnostics = await worker.evaluate(() => ({ pending: pending.size, errors: diagnostics }));
    phase.notices = await page.getByRole('status').allTextContents();
  } finally {
    phase.serverRequests = readLog().slice(before).filter(row => row.uri.startsWith('/web-builds/'));
    phase.serverBodyBytes = phase.serverRequests.reduce((total, row) => total + row.bodyBytes, 0);
    phase.serverLargeFiles = phase.serverRequests.filter(row => /\/(game\.zip|renpy\.(data|wasm))($|\?)/.test(row.uri));
    page.off('pageerror', onError); page.off('console', onConsole);
    await session.detach(); writeReport();
    console.log(`${label}: ${phase.readyMs ?? 'FAILED'} ms to ready; ${phase.serverBodyBytes} game bytes served; large files: ${JSON.stringify(phase.serverLargeFiles)}`);
  }
}
(async () => {
  assert.equal(new URL(base).hostname, 'localhost', 'Use the stable localhost origin for these local measurements');
  const auth = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'cache-test', password: 'local-cache-test-only' }) });
  assert.ok(auth.ok, `test login returned ${auth.status}`); token = (await auth.json()).token;
  const library = await fetch(`${base}/api/v1/library`, { headers: { Authorization: `Bearer ${token}` } });
  assert.ok(library.ok, `library returned ${library.status}`);
  const data = await library.json();
  game = (Array.isArray(data) ? data : data.games || data.items || []).find(item => item.webBuildPath === '/web-builds/cache-test');
  assert.ok(game, 'seeded test game must exist'); report.gameId = game.id;
  let page = await launch();
  await measure('cold-launch', page, () => page.goto(`${base}/play/${game.id}`));
  await page.getByRole('button', { name: 'Back to library', exact: true }).click();
  await page.waitForSelector('iframe', { state: 'detached' });
  await measure('same-tab-reopen', page, async () => {
    // Navigate through the React router without reloading the surrounding app.
    await page.evaluate(url => { history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate')); }, `/play/${game.id}`);
  });
  await page.close(); page = await context.newPage();
  await measure('new-tab-reopen', page, () => page.goto(`${base}/play/${game.id}`));
  await context.close(); context = null;
  page = await launch();
  await measure('browser-restart', page, () => page.goto(`${base}/play/${game.id}`));
  for (const phase of report.phases.slice(1)) assert.equal(phase.serverBodyBytes, 0, `${phase.label} must reuse game assets`);
  assert.equal(report.errors.length, 0, 'game must load without page errors');
  assert.ok(report.phases.every(phase => !phase.cacheDiagnostics?.errors.length), 'cache writes must succeed');
  // Check another progressive asset and verify its second read uses stored bytes.
  const frame = page.frames().find(frame => frame.url().includes('/web-builds/'));
  const asset = await frame.evaluate(async () => {
    const catalog = await (await fetch('pwa_catalog.json')).json();
    const name = (await caches.keys()).find(name => name.startsWith('vnm-game-assets-v1-'));
    const cache = await caches.open(name);
    for (const file of catalog.files) {
      if (/\.(webp|png|jpg)$/.test(file) && !(await cache.match(new URL(file, location.href)))) return file;
    }
  });
  assert.ok(asset, 'fixture must contain an unvisited progressive image');
  const beforeAsset = readLog().length;
  const digestAsset = async frame => frame.evaluate(async file => {
    const data = await (await fetch(file)).arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  }, asset);
  const hash = await digestAsset(frame); assert.equal(await digestAsset(frame), hash);
  const assetRequests = readLog().slice(beforeAsset).filter(row => row.uri.startsWith('/web-builds/') && row.bodyBytes);
  assert.equal(assetRequests.length, 1, 'progressive image downloads once');
  report.progressiveAsset = { file: asset, hash, requests: assetRequests };
  // Sentinel stands for user save/outbox storage, which removal must never touch.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('cache-test-save-data', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onerror = () => reject(open.error); open.onsuccess = () => {
      const db = open.result, tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put({ save: 'keep', pendingUpload: true }, 'progress');
      tx.oncomplete = () => { db.close(); resolve(); };
    };
  }));
  // Make a regular viewer account and verify dashboard access and mobile layout.
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const users = await (await fetch(`${base}/api/v1/users`, { headers })).json();
  if (!users.some(user => user.username === 'cache_viewer')) {
    const created = await fetch(`${base}/api/v1/users`, { method: 'POST', headers,
      body: JSON.stringify({ username: 'cache_viewer', password: 'local-cache-test-only', role: 'viewer' }) });
    assert.ok(created.ok, 'viewer test account must be created');
  }
  const viewer = await (await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'cache_viewer', password: 'local-cache-test-only' }) })).json();
  assert.ok(viewer.token); await page.evaluate(value => localStorage.setItem('vnm-token', value), viewer.token);
  await page.goto(`${base}/dashboard`); await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'Downloaded game data' }).waitFor();
  await page.getByRole('button', { name: 'Remove downloads for Abnormal (cache test)', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'dashboard must fit mobile width');
  await page.screenshot({ path: path.join(run, 'dashboard-mobile.png') });
  await page.getByRole('button', { name: 'Remove downloads for Abnormal (cache test)', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove downloads', exact: true }).click();
  await page.getByText('No downloaded game data is retained in this browser yet.').waitFor();
  assert.equal(await page.evaluate(async () => {
    let count = 0; for (const name of (await caches.keys()).filter(name => name.startsWith('vnm-game-assets-v1-'))) count += (await (await caches.open(name)).keys()).length;
    return count;
  }), 0, 'dashboard removes all of the game assets');
  const saved = await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('cache-test-save-data'); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result, request = db.transaction('files').objectStore('files').get('progress');
      request.onsuccess = () => { resolve(request.result); db.close(); }; };
  }));
  assert.deepEqual(saved, { save: 'keep', pendingUpload: true }); report.dashboard = { viewerAccess: true, mobileFits: true, savesPreserved: true };
  await page.setViewportSize({ width: 1280, height: 720 });
  await measure('after-removal', page, () => page.goto(`${base}/play/${game.id}`));
  assert.ok(report.phases.at(-1).serverLargeFiles.some(row => row.uri.endsWith('/game.zip') && row.bodyBytes), 'removed archive must download again');
  // Simulate a completed replacement build using the real API database identity.
  const compose = path.resolve(__dirname, 'compose.yml');
  const alter = value => JSON.parse(execFileSync('docker', ['compose', '-f', compose, 'exec', '-T', 'vnm-api', 'node', '/cache-test/change-version.cjs', game.id, ...(value ? [value] : [])], { encoding: 'utf8' }).trim());
  const change = alter(); report.buildChange = change;
  try {
    await measure('replacement-build', page, () => page.goto(`${base}/play/${game.id}`));
    assert.ok(report.phases.at(-1).serverLargeFiles.some(row => row.uri.endsWith('/game.zip') && row.bodyBytes), 'replacement build must not use previous assets');
    await measure('replacement-reopen', page, () => page.goto(`${base}/play/${game.id}`));
    assert.equal(report.phases.at(-1).serverBodyBytes, 0, 'replacement build becomes reusable');
    await page.goto(`${base}/dashboard`);
    await page.getByRole('button', { name: 'Remove all downloads', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove downloads', exact: true }).click();
    await page.getByText('No downloaded game data is retained in this browser yet.').waitFor();
    report.dashboard.removeAll = true;
  } finally { alter(change.before); }
  assert.equal(report.errors.length, 0, 'all browser actions must finish without page errors');
  report.passed = true; writeReport();
  console.log(`Report: ${path.join(run, 'report.json')}`);
})().catch(error => { report.failure = error.stack; writeReport(); console.error(error); process.exitCode = 1; })
  .finally(async () => { if (context) await context.close(); });
