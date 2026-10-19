import { verifiedAsset, verifyAsset } from './assetVerification.js';
import { createSavePreparation } from '../../public/save-offline.js';
import {
  prepareGameCache,
  workerMessage,
  removeGameDownloads,
} from './gameCache.js';
import { offlineStorage, recordKey, tokenUser } from './offlineStore.js';

export const digest = async (bytes) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (x) => x.toString(16).padStart(2, '0')
  ).join('');
const assetURL = (scope, file) =>
  new URL(file.split('/').map(encodeURIComponent).join('/'), scope).href;
const launchData = (game) =>
  Object.fromEntries(
    [
      'id',
      'extractedTitle',
      'vndbTitle',
      'directoryName',
      'webBuildPath',
      'builtAt',
      'buildStatus',
    ].map((key) => [key, game[key]])
  );
function identity(userId) {
  const { token, userId: current } = tokenUser();
  if (!token || current !== userId) throw Error('Account changed');
  return {
    token,
    check() {
      if (tokenUser().token !== token) throw Error('Account changed');
    },
  };
}
async function json(url, token, signal) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw Object.assign(
      Error(detail.message || 'Could not verify game files'),
      { status: response.status }
    );
  }
  return response.json();
}
async function abortable(task, signal) {
  if (!signal) return task;
  if (signal.aborted)
    throw new DOMException('Preparation cancelled', 'AbortError');
  let cancel;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        cancel = () =>
          reject(new DOMException('Preparation cancelled', 'AbortError'));
        signal.addEventListener('abort', cancel, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
async function activated(registration) {
  const worker =
    registration.installing || registration.waiting || registration.active;
  if (!worker) throw Error('Offline storage could not start');
  if (worker.state !== 'activated')
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.removeEventListener('statechange', changed);
        reject(Error('Offline app preparation took too long'));
      }, 60000);
      function changed() {
        if (['activated', 'redundant'].includes(worker.state)) {
          clearTimeout(timer);
          worker.removeEventListener('statechange', changed);
          worker.state === 'activated'
            ? resolve()
            : reject(Error('App files changed; try preparation again'));
        }
      }
      worker.addEventListener('statechange', changed);
      changed();
    });
  return worker;
}
export async function shellStatus() {
  const registration = await navigator.serviceWorker?.getRegistration('/');
  if (
    !registration ||
    new URL(registration.scope).pathname !== '/' ||
    !registration.active
  )
    return null;
  try {
    return await workerMessage(registration.active, {
      type: 'vnm-shell-check',
    });
  } catch {
    return null;
  }
}
async function prepareShell(signal) {
  if (
    !window.isSecureContext ||
    !navigator.serviceWorker ||
    !window.caches ||
    !crypto.subtle
  )
    throw Error(
      'Offline preparation requires HTTPS and browser storage support'
    );
  const registration = await abortable(
    navigator.serviceWorker.register('/app-offline-worker.js', {
      scope: '/',
      updateViaCache: 'none',
    }),
    signal
  );
  return abortable(
    workerMessage(await abortable(activated(registration), signal), {
      type: 'vnm-shell-check',
    }),
    signal
  );
}
export async function retainGameAccess(game, userId, launch) {
  const session = identity(userId),
    store = offlineStorage(),
    key = recordKey(userId, game.id),
    old = await store.get(key);
  session.check();
  if (
    old?.prepared ||
    (old?.game.builtAt === game.builtAt && (!launch || old.scope))
  )
    return old;
  const scope = launch?.src?.includes('/.vnm-cache/')
    ? new URL(launch.src, location.origin).href.replace(/index\.html$/, '')
    : null;
  const match =
    scope && /\/\.vnm-cache\/([a-f0-9]{32})\/([a-f0-9]{24})\/$/.exec(scope);
  const record = {
    ...(old?.game.builtAt === game.builtAt ? old : {}),
    userId,
    game: launchData(game),
    prepared: false,
    ...(scope
      ? { scope, cacheName: `vnm-game-assets-v1-${match[1]}-${match[2]}` }
      : {}),
  };
  await store.put(key, record);
  session.check();
  return record;
}
export async function checkOfflineGame(record, { deep = false } = {}) {
  const session = identity(record.userId);
  if (!record.prepared) return { ready: false, reason: 'Not prepared' };
  const store = offlineStorage(),
    manifest = await store.get(record.inventoryKey);
  session.check();
  if (!manifest || manifest.id !== record.manifestId)
    return { ready: false, reason: 'Game inventory is missing' };
  const shell = await shellStatus();
  if (!shell || shell.version !== record.shellVersion)
    return { ready: false, reason: 'App files need updating' };
  const cache = await caches.open(record.cacheName);
  const info = await caches.open(record.cacheName.replace('assets', 'info'));
  const receipt = await info.match(record.scope + '__offline_verification__');
  const verified = receipt && (await receipt.json());
  if (
    verified?.manifestId !== record.manifestId ||
    verified.shellVersion !== record.shellVersion
  )
    return { ready: false, reason: 'Game files need verification' };
  const keys = new Set((await cache.keys()).map((key) => key.url));
  for (const file of manifest.files) {
    if (!keys.has(assetURL(record.scope, file.path)))
      return { ready: false, reason: 'Some game files are missing' };
    if (!deep) continue;
    const response = await cache.match(assetURL(record.scope, file.path));
    session.check();
    if (
      !response ||
      response.headers.get('X-VNM-Verified-Hash') !== file.hash
    ) {
      await info.delete(record.scope + '__offline_verification__');
      return { ready: false, reason: 'Some game files are missing' };
    }
    if (
      deep &&
      !(await verifyAsset(
        response,
        { hash: response.headers.get('X-VNM-Stored-Hash') },
        { check: session.check }
      ))
    ) {
      await info.delete(record.scope + '__offline_verification__');
      return { ready: false, reason: 'A game file failed verification' };
    }
  }
  const saves = await createSavePreparation({
    userId: record.userId,
    gameId: record.game.id,
    token: session.token,
  }).readiness(record.game.builtAt);
  // New browser progress does not invalidate a complete server checkpoint. The
  // bridge preserves the engine/outbox copy and reconciles it on reconnection.
  session.check();
  return {
    ready: saves.available,
    localChanges: saves.localChanges,
    reason: saves.available ? null : 'Saves need preparing again',
    saves,
  };
}
export async function prepareOfflineGame(
  game,
  userId,
  { signal, onProgress = () => {} } = {}
) {
  const session = identity(userId),
    store = offlineStorage(),
    previous = await store.get(recordKey(userId, game.id));
  session.check();
  const savePreparation = createSavePreparation({
    userId,
    gameId: game.id,
    token: session.token,
  });
  await savePreparation.checkProgress();
  const check = () => {
    session.check();
    if (signal?.aborted)
      throw new DOMException('Preparation cancelled', 'AbortError');
  };
  check();
  onProgress({
    stage: 'Preparing app files',
    files: 0,
    totalFiles: 0,
    bytes: 0,
  });
  const shell = await prepareShell(signal);
  check();
  const manifest = await json(
    `/api/v1/games/${game.id}/offline-manifest`,
    session.token,
    signal
  );
  check();
  if (
    manifest.gameId !== game.id ||
    manifest.buildVersion !== game.builtAt ||
    manifest.path !== game.webBuildPath ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 200000 ||
    (await digest(new TextEncoder().encode(JSON.stringify(manifest.files)))) !==
      manifest.id
  )
    throw Error('Game inventory changed; reopen the dashboard');
  for (const file of manifest.files) {
    if (
      typeof file.path !== 'string' ||
      !file.path ||
      file.path.length > 2048 ||
      file.path
        .split('/')
        .some((p) => !p || p === '.' || p === '..' || p.startsWith('.')) ||
      /[\\\x00-\x1f]/.test(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/.test(file.hash)
    )
      throw Error('Invalid game inventory');
  }
  const launch = await abortable(prepareGameCache(game), signal);
  check();
  const scope = new URL(launch.src, location.origin).href.replace(
    /index\.html$/,
    ''
  );
  const match = /\/\.vnm-cache\/([a-f0-9]{32})\/([a-f0-9]{24})\/$/.exec(scope);
  if (!match)
    throw Error(
      launch.warning || 'Retained downloads are unavailable for this game'
    );
  const cacheName = `vnm-game-assets-v1-${match[1]}-${match[2]}`,
    cache = await caches.open(cacheName),
    info = await caches.open(cacheName.replace('assets', 'info'));
  const partial = {
    userId,
    game: launchData(game),
    prepared: false,
    scope,
    cacheName,
  };
  await store.put(
    recordKey(userId, game.id),
    previous?.prepared ? { ...previous, pending: partial } : partial
  );
  check();
  const initialDescriptor = await info.match(scope + '__descriptor__');
  if (initialDescriptor)
    await info.put(
      scope + '__descriptor__',
      Response.json({
        ...(await initialDescriptor.json()),
        offlinePinned: true,
      })
    );
  check();
  if (previous?.pending?.cacheName && previous.pending.cacheName !== cacheName)
    await unpinUnused(previous.pending, session);
  const bridge = await fetch('/save-sync.js', {
    cache: 'no-store',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000),
  });
  if (!bridge.ok) throw Error('Save bridge is unavailable');
  const bridgeHash = await digest(await bridge.arrayBuffer());
  check();
  const controller = new AbortController(),
    transfer = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
  let next = 0,
    done = 0,
    bytes = 0;
  const tasks = [0, 1].map(async () => {
    while (next < manifest.files.length) {
      check();
      if (transfer.aborted)
        throw new DOMException('Preparation cancelled', 'AbortError');
      const file = manifest.files[next++],
        url = assetURL(scope, file.path),
        existing = await cache.match(url);
      let reuse = false;
      if (
        existing?.headers.get('X-VNM-Verified-Hash') === file.hash &&
        (!file.path.endsWith('.html') ||
          existing.headers.get('X-VNM-Bridge-Hash') === bridgeHash)
      ) {
        reuse = await verifyAsset(
          existing,
          { hash: existing.headers.get('X-VNM-Stored-Hash') },
          { signal: transfer, check }
        );
      }
      // On-demand caches have no preparation marker yet: verify and adopt them.
      if (existing && !reuse && !file.path.endsWith('.html')) {
        if (
          await verifyAsset(await cache.match(url), file, {
            signal: transfer,
            check,
          })
        ) {
          const headers = new Headers(existing.headers);
          headers.delete('Content-Encoding');
          headers.delete('Content-Length');
          headers.set('X-VNM-Verified-Hash', file.hash);
          headers.set('X-VNM-Stored-Hash', file.hash);
          await cache.put(
            url,
            verifiedAsset(await cache.match(url), file, {
              headers,
              signal: transfer,
              check,
            })
          );
          reuse = true;
        }
      }
      if (!reuse) {
        const query = new URLSearchParams({
          manifest: manifest.id,
          build: manifest.buildVersion,
          path: file.path,
        });
        const response = await fetch(
          `/api/v1/games/${game.id}/offline-file?${query}`,
          {
            headers: { Authorization: `Bearer ${session.token}` },
            cache: 'no-store',
            signal: transfer,
          }
        );
        if (!response.ok)
          throw Error(
            'A game file could not be prepared; the build may have changed'
          );
        const headers = new Headers({
          'X-VNM-Verified-Hash': file.hash,
          'X-VNM-Stored-Hash': file.hash,
        });
        let retained,
          storedSize = file.size;
        if (file.path.endsWith('.html')) {
          if (file.size > 16 * 1024 * 1024)
            throw Error('Game launch HTML exceeds the preparation limit');
          const data = await verifiedAsset(response, file, {
            signal: transfer,
            check,
          }).arrayBuffer();
          check();
          const body = new TextEncoder().encode(
            new TextDecoder()
              .decode(data)
              .replace(
                '<head>',
                '<head><script src="/save-sync.js?v=' +
                  bridgeHash +
                  '"></script>'
              )
          );
          headers.set('Content-Type', 'text/html');
          headers.set('X-VNM-Bridge-Hash', bridgeHash);
          headers.set('X-VNM-Stored-Hash', await digest(body));
          retained = new Response(body, { headers });
          storedSize = body.byteLength;
        } else {
          headers.set(
            'Content-Type',
            {
              '.js': 'application/javascript',
              '.wasm': 'application/wasm',
              '.json': 'application/json',
              '.css': 'text/css',
              '.webm': 'video/webm',
              '.ogg': 'audio/ogg',
              '.mp3': 'audio/mpeg',
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.webp': 'image/webp',
            }[/\.[^.]+$/.exec(file.path)?.[0]] || 'application/octet-stream'
          );
          retained = verifiedAsset(response, file, {
            headers,
            signal: transfer,
            check,
          });
        }
        check();
        if (transfer.aborted)
          throw new DOMException('Preparation cancelled', 'AbortError');
        await cache.put(url, retained);
        await info.put(url, Response.json({ bytes: storedSize }));
      }
      bytes += file.size;
      onProgress({
        stage: 'Preparing game files',
        files: ++done,
        totalFiles: manifest.files.length,
        bytes,
      });
    }
  });
  try {
    await Promise.all(tasks);
  } catch (error) {
    controller.abort();
    await Promise.allSettled(tasks);
    throw error;
  }
  check();
  onProgress({ stage: 'Preparing saves', files: 0, totalFiles: 0, bytes });
  await savePreparation.prepare({
    buildVersion: game.builtAt,
    signal,
    onProgress: (p) => onProgress({ ...p, stage: 'Preparing saves' }),
  });
  check();
  const current = await json(
    `/api/v1/games/${game.id}/offline-manifest`,
    session.token,
    signal
  );
  if (
    current.id !== manifest.id ||
    current.buildVersion !== manifest.buildVersion
  )
    throw Error('Game changed during preparation; try again');
  const inventoryKey = `inventory:${encodeURIComponent(userId)}:${game.id}:${manifest.id}`;
  await store.put(inventoryKey, manifest);
  check();
  const record = {
    userId,
    game: launchData(game),
    prepared: true,
    preparedAt: Date.now(),
    scope,
    cacheName,
    manifestId: manifest.id,
    inventoryKey,
    shellVersion: shell.version,
    assetBytes: bytes,
    assetFiles: manifest.files.length,
  };
  await store.put(recordKey(userId, game.id), record);
  check();
  const catalog = await cache.match(scope + 'pwa_catalog.json');
  if (catalog) await cache.put(scope + 'pwa_catalog.json?uncached', catalog);
  await info.put(
    scope + '__offline_verification__',
    Response.json({
      manifestId: manifest.id,
      shellVersion: shell.version,
      bytes,
      files: manifest.files.length,
    })
  );
  check();
  const descriptor = await info.match(scope + '__descriptor__');
  if (descriptor)
    await info.put(
      scope + '__descriptor__',
      Response.json({
        ...(await descriptor.json()),
        offlinePinned: true,
        shellVersion: shell.version,
      })
    );
  // Replacing a checkpoint must not strand multi-gigabyte pinned old builds.
  if (previous?.inventoryKey && previous.inventoryKey !== inventoryKey)
    await store.delete(previous.inventoryKey);
  if (previous?.cacheName && previous.cacheName !== cacheName) {
    await unpinUnused(previous, session);
    await prepareGameCache(game);
  }
  session.check();
  return record;
}
async function unpinUnused(record, session) {
  const store = offlineStorage(),
    records = await Promise.all(
      (await store.keys('game:')).map((key) => store.get(key))
    );
  session.check();
  if (
    records.some((row) =>
      [row?.cacheName, row?.pending?.cacheName].includes(record.cacheName)
    )
  )
    return;
  const info = await caches.open(record.cacheName.replace('assets', 'info')),
    key = record.scope + '__descriptor__',
    response = await info.match(key);
  session.check();
  if (response)
    await info.put(
      key,
      Response.json({ ...(await response.json()), offlinePinned: false })
    );
}
export async function removeOfflineGame(record) {
  const session = identity(record.userId),
    store = offlineStorage();
  const others = await Promise.all(
    (await store.keys('game:')).map((key) => store.get(key))
  );
  session.check();
  const owned = [record.cacheName, record.pending?.cacheName].filter(Boolean);
  const names = [...new Set(owned)].filter(
    (name) =>
      !others.some(
        (other) =>
          other.userId !== record.userId &&
          [other.cacheName, other.pending?.cacheName].includes(name)
      )
  );
  await removeGameDownloads(names);
  session.check();
  // Keep engine saves, the prepared-save checkpoint, and pending uploads.
  await store.delete(recordKey(record.userId, record.game.id));
  if (record.inventoryKey) await store.delete(record.inventoryKey);
  session.check();
}
