const CACHE_NAME = /^vnm-game-assets-v1-([a-f0-9]{32})-([a-f0-9]{24})$/;
const WORKER_VERSION = '1';
export function workerMessage(worker, data) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error('Browser storage did not respond. Try again.')); }, 15000);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); event.data.ok ? resolve(event.data) : reject(new Error('Browser storage is unavailable.')); };
    worker.postMessage(data, [channel.port2]);
  });
}
export async function prepareGameCache(game) {
  const direct = `${game.webBuildPath}/index.html`;
  if (!window.isSecureContext || !navigator.serviceWorker || !window.caches || !crypto.subtle) {
    return { src: direct, warning: 'Downloads cannot be retained in this browser. Use HTTPS and a browser that supports game storage.' };
  }
  const source = new URL(`${game.webBuildPath}/`, location.origin);
  if (source.origin !== location.origin || !source.pathname.startsWith('/web-builds/')) return { src: direct, warning: 'Downloads from this game host cannot be retained here.' };
  if (!game.builtAt) return { src: direct, warning: 'Rebuild this game to enable retained downloads.' };
  const version = new Date(game.builtAt).toISOString();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${source.href}:${version}`));
  const build = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
  const scope = `/web-builds/.vnm-cache/${game.id}/${build}/`;
  const script = new URL('/game-cache-worker.js', location.origin);
  script.search = new URLSearchParams({ game: game.id, build, version, source: source.href, worker: WORKER_VERSION });
  const registration = await navigator.serviceWorker.register(script.href, { scope, updateViaCache: 'none' });
  const worker = registration.installing || registration.waiting || registration.active;
  if (!worker) throw new Error('Game storage could not start.');
  if (worker.state !== 'activated') await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { worker.removeEventListener('statechange', changed); reject(new Error('Game storage took too long to start.')); }, 15000);
    function changed() { if (worker.state === 'activated' || worker.state === 'redundant') { clearTimeout(timeout); worker.removeEventListener('statechange', changed); worker.state === 'activated' ? resolve() : reject(new Error('Game storage could not start.')); } }
    worker.addEventListener('statechange', changed); changed();
  });
  // An unavailable quota must never prevent playing; the worker still maps files.
  let warning;
  try {
    const result = await workerMessage(worker, { type: 'vnm-cache-enable', title: game.vndbTitle || game.extractedTitle });
    for (const old of await navigator.serviceWorker.getRegistrations()) {
      if (result.removedScopes?.includes(old.scope) && old.scope.startsWith(new URL(`/web-builds/.vnm-cache/${game.id}/`, location.origin).href)) await old.unregister();
    }
  }
  catch { warning = 'Browser storage is unavailable. The game can load, but downloads may not be kept.'; }
  return { src: `${scope}index.html`, warning };
}
export async function listGameDownloads() {
  if (!window.caches) return [];
  const rows = [];
  for (const name of (await caches.keys()).filter(name => CACHE_NAME.test(name))) {
    const assets = await caches.open(name), keys = await assets.keys();
    if (!keys.length) continue;
    const info = await caches.open(name.replace('assets', 'info'));
    const [, gameId, build] = CACHE_NAME.exec(name);
    const scope = new URL(`/web-builds/.vnm-cache/${gameId}/${build}/`, location.origin).href;
    const descriptors = (await info.keys()).filter(key => key.url.endsWith('/__descriptor__'));
    const response = descriptors.length ? await info.match(descriptors[0]) : null;
    const data = { ...(response ? await response.json() : {}), gameId, build, scope };
    let bytes = 0;
    for (const key of keys) { const entry = await info.match(key); if (entry) bytes += (await entry.json()).bytes || 0; }
    rows.push({ ...data, name, bytes, files: keys.length });
  }
  return rows.sort((a, b) => String(a.title || a.gameId).localeCompare(String(b.title || b.gameId)));
}
export async function removeGameDownloads(names) {
  const registrations = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
  for (const name of names) {
    const parts = CACHE_NAME.exec(name);
    if (!parts) throw new Error('Invalid game storage');
    const infoName = name.replace('assets', 'info');
    const info = await caches.open(infoName);
    const descriptorKey = (await info.keys()).find(key => key.url.endsWith('/__descriptor__'));
    const response = descriptorKey ? await info.match(descriptorKey) : null;
    const descriptor = response ? await response.json() : null;
    const scope = new URL(`/web-builds/.vnm-cache/${parts[1]}/${parts[2]}/`, location.origin).href;
    const registration = registrations.find(item => item.scope === scope);
    if (registration?.active) await workerMessage(registration.active, { type: 'vnm-cache-pause' });
    else if (descriptor) await info.put(descriptorKey, new Response(JSON.stringify({ ...descriptor, paused: true })));
    if (registration) await registration.unregister();
    await caches.delete(name);
    // Keep the tiny pause marker so a surviving game tab cannot recreate downloads.
    for (const key of await info.keys()) if (!key.url.endsWith('/__descriptor__')) await info.delete(key);
  }
}
