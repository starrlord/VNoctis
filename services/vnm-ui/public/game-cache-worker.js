/* VNoctis game assets only. Saves, authentication and API responses are never cached. */
const config = new URL(self.location.href).searchParams;
const gameId = config.get('game');
const build = config.get('build');
const version = config.get('version');
const source = new URL(config.get('source'), self.location.origin);
const scope = self.registration.scope;
const name = `vnm-game-assets-v1-${gameId}-${build}`;
const infoName = name.replace('assets', 'info');
const descriptorURL = new URL('__descriptor__', scope).href;
const pending = new Map();
const cacheWrites = new Map();
const writeControllers = new Set();
const diagnostics = [];
let paused = false;
let storageWarningSent = false;

if (!/^[a-f0-9]{32}$/.test(gameId) || !/^[a-f0-9]{24}$/.test(build) ||
    source.origin !== self.location.origin || !source.pathname.startsWith('/web-builds/') ||
    source.pathname.includes('/.vnm-cache/')) throw new Error('Invalid game cache configuration');

async function descriptor(update = {}) {
  const cache = await caches.open(infoName);
  const previous = await cache.match(descriptorURL);
  const data = { gameId, build, version, scope, source: source.href, title: gameId,
    ...(previous ? await previous.json() : {}), ...update };
  await cache.put(descriptorURL, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
  return data;
}
async function notify(message) {
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
    client.postMessage({ type: 'vnm-game-cache-warning', gameId, message });
  }
}
async function pruneUnusedBuilds() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const removedScopes = [];
  for (const oldName of (await caches.keys()).filter(item => item.startsWith(`vnm-game-assets-v1-${gameId}-`) && item !== name)) {
    const oldInfoName = oldName.replace('assets', 'info');
    const oldInfo = await caches.open(oldInfoName);
    const key = (await oldInfo.keys()).find(key => key.url.endsWith('/__descriptor__'));
    const response = key ? await oldInfo.match(key) : null;
    const old = response ? await response.json() : null;
    if (old?.scope && clients.some(client => client.url?.startsWith(old.scope))) continue;
    await caches.delete(oldName); await caches.delete(oldInfoName);
    if (old?.scope) removedScopes.push(old.scope);
  }
  return removedScopes;
}
async function currentBuild() {
  const response = await fetch(`/api/v1/games/${gameId}/cache-build`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Cannot verify the current game build');
  const current = await response.json();
  if (current.version !== version || new URL(current.path + '/', self.location.origin).href !== source.href ||
      !['built', 'stale'].includes(current.status)) {
    await notify('This game has been rebuilt. Reopen it to load the updated version.');
    throw new Error('Game build changed');
  }
}
async function store(key, response) {
  let controller;
  try {
    const info = await caches.open(infoName);
    const state = await info.match(descriptorURL);
    if (paused || (state && (await state.json()).paused)) return;
    const cache = await caches.open(name);
    const length = Number(response.headers.get('Content-Length'));
    const compressed = response.headers.has('Content-Encoding');
    // Abort only the cache-writing branch when downloads are removed. A game
    // running in another tab can continue consuming its original fetch body.
    controller = new AbortController(); writeControllers.add(controller);
    const headers = new Headers(response.headers);
    if (compressed) { headers.delete('Content-Encoding'); headers.delete('Content-Length'); }
    const body = response.body.pipeThrough(new TransformStream(), { signal: controller.signal });
    await cache.put(key, new Response(body, { status: response.status, statusText: response.statusText, headers }));
    const bytes = length && !compressed ? length : (await (await cache.match(key)).blob()).size;
    await (await caches.open(infoName)).put(key, new Response(JSON.stringify({ bytes })));
  } catch (error) {
    if (paused) return;
    if (diagnostics.length < 10) diagnostics.push({ key, error: String(error) });
    console.warn('Could not retain game asset', key, error);
    if (!storageWarningSent) {
      storageWarningSent = true;
      await notify('Browser storage is full or unavailable. The game can still load, but some downloads could not be kept.');
    }
  } finally { if (controller) writeControllers.delete(controller); }
}
async function serve(request, event) {
  const url = new URL(request.url);
  const relative = url.pathname.slice(new URL(scope).pathname.length);
  if (!relative || relative.split('/').some(part => ['..', '.'].includes(decodeURIComponent(part)))) return new Response('Invalid asset path', { status: 400 });
  const key = new URL(relative, scope);
  key.search = url.search;
  if (key.searchParams.has('uncached')) key.searchParams.set('uncached', '');
  // Ren'Py records full-offline completion with ?uncached, then probes it using
  // ?cached. Ordinary play's catalog download is not that completion receipt.
  if (url.searchParams.has('cached')) {
    key.searchParams.delete('cached'); key.searchParams.set('uncached', '');
    return (await (await caches.open(name)).match(key.href)) || new Response('Not cached', { status: 404 });
  }
  // Range responses cannot be persisted as complete files. Reuse a complete cached
  // body for a single byte range; otherwise pass the range to the server.
  if (cacheWrites.has(key.href)) await cacheWrites.get(key.href);
  let cached;
  try { cached = await (await caches.open(name)).match(key.href); } catch { /* fetch normally */ }
  if (cached && request.headers.has('Range')) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range'));
    if (match && (match[1] || match[2])) {
      const blob = await cached.blob();
      const start = match[1] ? Number(match[1]) : Math.max(0, blob.size - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(Number(match[2]), blob.size - 1) : blob.size - 1;
      if (start > end || start >= blob.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
      const headers = new Headers(cached.headers); headers.set('Content-Range', `bytes ${start}-${end}/${blob.size}`); headers.set('Content-Length', String(end - start + 1));
      return new Response(blob.slice(start, end + 1), { status: 206, headers });
    }
  } else if (cached) return cached;
  await currentBuild();
  const target = new URL(relative, source); target.search = key.search;
  const headers = new Headers(request.headers); headers.delete('If-None-Match'); headers.delete('If-Modified-Since');
  const response = await fetch(target, { headers, credentials: 'same-origin', cache: 'no-store' });
  await currentBuild();
  let retained = response.status === 200 && !request.headers.has('Range') ? response.clone() : null;
  // Some media servers return the complete file as a 206 for "bytes=0-".
  // Persist it only when Content-Range proves that no bytes are missing.
  const fullRange = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
  if (response.status === 206 && fullRange && Number(fullRange[1]) + 1 === Number(fullRange[2])) {
    const headers = new Headers(response.headers); headers.delete('Content-Range');
    retained = new Response(response.clone().body, { status: 200, headers });
  }
  if (retained && !relative.endsWith('service-worker.js')) {
    const task = store(key.href, retained);
    pending.set(task, task); cacheWrites.set(key.href, task);
    event.waitUntil(task.finally(() => { pending.delete(task); cacheWrites.delete(key.href); }));
  }
  return response;
}
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(scope)) return;
  event.respondWith(serve(event.request, event).catch(async error => {
    await notify(error.message === 'Game build changed' ? 'This game has been rebuilt. Reopen it to load the updated version.' : 'A game file could not be downloaded. Check your connection and reopen the game.');
    return new Response(error.message, { status: 503 });
  }));
});
self.addEventListener('message', event => {
  const legacy = Array.isArray(event.data) ? event.data[0] : null;
  const data = legacy === 'loadCache' ? { type: 'vnm-cache-enable' } : legacy === 'clearCache' ? { type: 'vnm-cache-pause' } : event.data;
  if (!['vnm-cache-enable', 'vnm-cache-pause'].includes(data?.type)) return;
  event.waitUntil((async () => {
    try {
      paused = data.type === 'vnm-cache-pause';
      if (!paused) storageWarningSent = false;
      if (paused) {
        for (const controller of writeControllers) controller.abort();
        await Promise.allSettled([...pending.values()]);
        // Free the large data first, so even a full quota has room for the tiny
        // pause marker needed by a surviving game tab after worker restart.
        await caches.delete(name);
        const info = await caches.open(infoName);
        for (const key of await info.keys()) if (key.url !== descriptorURL) await info.delete(key);
      }
      await descriptor({ paused, ...(data.title ? { title: data.title } : {}), lastPlayedAt: new Date().toISOString() });
      const removedScopes = !paused ? await pruneUnusedBuilds() : [];
      event.ports?.[0]?.postMessage({ ok: true, removedScopes });
    } catch { event.ports?.[0]?.postMessage({ ok: false }); }
  })());
});
