// This worker caches public app files only. Never cache API/auth responses.
const VERSION = '__VNM_SHELL_VERSION__';
const CACHE = `vnm-offline-shell-v1-${VERSION}`;
const allowed = (value) =>
  value === '/index.html' ||
  /^\/assets\/[A-Za-z0-9_.-]+$/.test(value) ||
  ['/save-sync.js', '/save-offline.js', '/game-cache-worker.js'].includes(
    value
  );
const checksum = async (bytes) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (x) => x.toString(16).padStart(2, '0')
  ).join('');
async function check() {
  const cache = await caches.open(CACHE),
    response = await cache.match('/offline-shell.json');
  if (!response) throw Error('App files are not prepared');
  const manifest = await response.json();
  if (
    manifest.version !== VERSION ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  )
    throw Error('App version changed');
  for (const file of manifest.files) {
    if (!allowed(file.path)) throw Error('Invalid app file');
    const entry = await cache.match(file.path);
    if (!entry) throw Error('App files were removed by the browser');
    const bytes = await entry.arrayBuffer();
    if (bytes.byteLength !== file.size || (await checksum(bytes)) !== file.hash)
      throw Error('App files need downloading again');
  }
  return VERSION;
}
self.addEventListener('install', (event) =>
  event.waitUntil(
    (async () => {
      const response = await fetch('/offline-shell.json', {
        cache: 'no-store',
      });
      if (!response.ok) throw Error('App inventory unavailable');
      const manifest = await response.json();
      if (
        manifest.version !== VERSION ||
        !Array.isArray(manifest.files) ||
        manifest.files.length > 100
      )
        throw Error('App changed during preparation');
      const cache = await caches.open(CACHE);
      for (const file of manifest.files) {
        if (!allowed(file.path) || file.size > 16 * 1024 * 1024)
          throw Error('Invalid app inventory');
        const fetched = await fetch(file.path, { cache: 'no-store' });
        if (!fetched.ok) throw Error('App file unavailable');
        const bytes = await fetched.clone().arrayBuffer();
        if (
          bytes.byteLength !== file.size ||
          (await checksum(bytes)) !== file.hash
        )
          throw Error('App changed during preparation');
        await cache.put(file.path, fetched);
      }
      await cache.put('/offline-shell.json', Response.json(manifest));
      await check();
      await self.skipWaiting();
    })()
  )
);
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim())
);
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'vnm-shell-check') return;
  event.waitUntil(
    check()
      .then((version) => event.ports[0]?.postMessage({ ok: true, version }))
      .catch((error) =>
        event.ports[0]?.postMessage({ ok: false, message: error.message })
      )
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  )
    return;
  const navigation =
    event.request.mode === 'navigate' &&
    /^\/(?:dashboard\/?|(?:gallery\/)?play\/[a-f0-9]{32}\/?|)$/.test(
      url.pathname
    );
  if (
    !navigation &&
    !allowed(url.pathname) &&
    url.pathname !== '/offline-shell.json'
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // Fresh app/navigation when online; the verified snapshot is the fallback.
      try {
        const response = await fetch(event.request, {
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) return response;
      } catch {
        /* use the verified local app files */
      }
      return (
        (await cache.match(navigation ? '/index.html' : url.pathname)) ||
        new Response('Offline app files unavailable', { status: 503 })
      );
    })()
  );
});
