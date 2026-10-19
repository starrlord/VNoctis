/* Ren'Py 8.5 IDBFS bridge. Loaded before renpy-pre.js by the serving layer. */
(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const gameId = params.get('vnmGame');
  const userId = params.get('vnmUser');
  const token = localStorage.getItem('vnm-token');
  if (!gameId || !userId || !token || window.parent === window) return;
  try {
    const claim = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (claim.userId !== userId) return;
  } catch { return; }
  const root = '/home/web_user/.renpy';
  const maxSnapshotBytes = 128 * 1024 * 1024;
  const namespace = `vnm-saves:${encodeURIComponent(userId)}:${encodeURIComponent(gameId)}`;
  const metaKey = `${namespace}:meta`;
  let meta;
  try { meta = JSON.parse(localStorage.getItem(metaKey)) || { revision: 0, dirty: false }; }
  catch { meta = { revision: 0, dirty: true }; }
  let initialized = false, startupLoaded = false, blocked = false, busy = false, timer;
  let mutationVersion = 0;
  const snapshotVersions = new WeakMap();
  const snapshotCatalogs = new WeakMap();
  let logicalCatalog = null, referenceUploads = false, catalogWrites = Promise.resolve();
  let catalogOrder = 0, newestCatalogOrder = 0;
  let scheduledCatalogKey = null;
  let lazyRuntime = null, installing = false;
  let preparedSaves = null;
  const residentHashes = new Map();
  let lastUploadedContents = null, lastStatus, noticeSequence = 0;
  let lastUploadedSlots = new Map();
  let lastUploadedFiles = null, deltaUploads = false;
  // IDBFS belongs to the engine thread; only copy bytes there. Comparisons,
  // base64 encoding and large request serialization belong to this worker.
  function saveProcessor() {
    const encoded = new Map();
    const hashBytes = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      byte => byte.toString(16).padStart(2, '0')).join('');
    const encode = bytes => {
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(binary);
    };
    return ({ operation, value }) => {
      if (operation === 'hashes') return Promise.all(value.files.map(async file => {
        const cached = encoded.get(file.path);
        const hash = cached?.data === file.data && cached.hash || await hashBytes(Uint8Array.from(atob(file.data), c => c.charCodeAt(0)));
        if (cached?.data === file.data) cached.hash = hash;
        return { ...file, hash };
      }));
      if (operation === 'download') return hashBytes(value).then(hash => ({ hash, size: value.length, data: encode(value) }));
      if (operation === 'json') return JSON.stringify(value);
      const present = new Set(value.map(file => file.path));
      for (const path of encoded.keys()) if (!present.has(path)) encoded.delete(path);
      return { version: 1, files: value.map(({ path, mtime, bytes }) => {
        const cached = encoded.get(path);
        let same = cached?.bytes.length === bytes.length;
        if (same) for (let i = 0; i < bytes.length; i++) {
          if (bytes[i] !== cached.bytes[i]) { same = false; break; }
        }
        let data = cached?.data;
        if (!same) {
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          data = btoa(binary); encoded.set(path, { bytes, data });
        }
        return { path, mtime, data };
      }) };
    };
  }
  const processLocally = saveProcessor();
  let saveWorker, taskId = 0;
  const workerTasks = new Map();
  try {
    if (typeof Worker === 'function') {
      const script = `const process = (${saveProcessor.toString()})();
        onmessage = async ({data: {id, operation, value}}) => {
          try { postMessage({id, result: await process({operation, value})}); }
          catch (error) { postMessage({id, error: error.message}); }
        };`;
      const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
      try { saveWorker = new Worker(url); } finally { URL.revokeObjectURL(url); }
      saveWorker.onmessage = ({ data }) => {
        const task = workerTasks.get(data.id); if (!task) return;
        workerTasks.delete(data.id);
        if (data.error) task.reject(new Error(data.error)); else task.resolve(data.result);
      };
      saveWorker.onerror = event => {
        event.preventDefault?.(); saveWorker.terminate(); saveWorker = null;
        for (const task of workerTasks.values()) task.reject(new Error('Save processing interrupted — browser saves retained'));
        workerTasks.clear();
      };
    }
  } catch { saveWorker = null; }
  async function processSave(operation, value) {
    if (!saveWorker) return processLocally({ operation, value });
    return new Promise((resolve, reject) => {
      const id = ++taskId; workerTasks.set(id, { resolve, reject });
      try {
        saveWorker.postMessage({ id, operation, value }, operation === 'snapshot' ? value.map(file => file.bytes.buffer)
          : operation === 'download' ? [value.buffer] : []);
      } catch (error) { workerTasks.delete(id); reject(error); }
    });
  }
  let slotWritePending = false, urgentUploadPending = false;
  let pendingUpload = null, acceptedUpload = null, preparationRetry = null;
  let acknowledgedSlots = null;
  let fs, nativeSync, originalGetDB;
  const status = (message, saveUploaded = false, notice = false) => {
    if (message === lastStatus && !saveUploaded && !notice) return;
    lastStatus = message;
    parent.postMessage({ type: 'vnm-save-status', message, saveUploaded, ...(notice ? { noticeId: ++noticeSequence } : {}) }, location.origin);
  };
  function reportFailure(stage, error) {
    // Never log request bodies, save contents, or credentials.
    console.warn('[VNoctis save sync]', {
      stage: error.saveStage || stage, name: error.name || 'Error',
      message: String(error.message || (Number.isInteger(error.errno) ? `Browser filesystem error (${error.errno})` : 'Unknown error')).slice(0, 200),
      errno: Number.isInteger(error.errno) ? error.errno : null,
      status: error.httpStatus || null, worker: Boolean(saveWorker),
    });
  }
  function failureStatus(stage, error) {
    if (blocked) return error.message;
    if (error.saveStage === 'download') return 'Server saves could not be loaded — browser saves only. Reopen the game to retry.';
    if (stage === 'restore') return 'Server saves could not be restored — browser copy retained. Reopen the game to retry.';
    if (stage === 'storage') return 'Browser save storage failed — browser copy retained. Reopen the game to retry.';
    if (stage === 'prepare') return 'Save processing failed — browser saves retained; retrying.';
    return 'Save upload failed — browser saves retained; retrying.';
  }
  const slots = copy => new Map(copy.files.filter(file => file.path.endsWith('.save'))
    .map(file => [file.path, file.data]));
  const slotContents = copy => processSave('json', [...slots(copy)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const catalogSignature = (catalog, slotsOnly = false) => processSave('json', catalog.files
    .filter(file => !slotsOnly || file.path.endsWith('.save')).map(file => [file.path, file.hash])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  async function checkpoint(copy, revision, saveChecksum = null, catalog = null) {
    const next = { revision, contents: await slotContents(copy), saveChecksum };
    if (catalog) { next.catalogContents = await catalogSignature(catalog); next.catalogSlots = await catalogSignature(catalog, true); }
    await outbox('put', next, 'baselines'); acknowledgedSlots = next;
  }
  // Ren'Py may flush repeatedly or touch mtimes without changing save bytes.
  // Exact comparisons avoid hash collisions and work on HTTP LAN deployments.
  const contents = copy => new Map(copy.files.map(file => [file.path, file.data]));
  const sameContents = (a, b) => a?.size === b?.size && [...a].every(([path, data]) => b.get(path) === data);
  const remember = () => localStorage.setItem(metaKey, JSON.stringify(meta));
  const deviceLabel = /Mobi|Android|iPad/i.test(window.navigator?.userAgent || '') ? 'Mobile browser' : 'Desktop browser';
  const requestFor = async copy => {
    const request = { uploadId: window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,
    revision: meta.revision, snapshot: copy, baseSaveChecksum: meta.baseSaveChecksum || null,
    ...(deltaUploads && lastUploadedFiles && !meta.alternate ? { delta: { version: 1,
      files: copy.files.filter(file => lastUploadedFiles.get(file.path) !== file.data),
      deleted: [...lastUploadedFiles.keys()].filter(path => !copy.files.some(file => file.path === path)),
    } } : {}),
    alternate: Boolean(meta.alternate), branchId: meta.branchId || null, deviceLabel };
    if (referenceUploads && logicalCatalog) {
      const captured = snapshotCatalogs.get(copy) || logicalCatalog.export();
      const prepared = createSaveCatalog(captured);
      const hashed = await processSave('hashes', copy);
      if (mutationVersion !== snapshotVersions.get(copy) || logicalCatalog.export().generation !== captured.generation) {
        throw Object.assign(new Error('Save catalog changed during preparation'), { code: 'SAVE_CATALOG_CHANGED' });
      }
      prepared.mergeResident(hashed);
      logicalCatalog = prepared;
      request.fileSnapshot = prepared.request(); request.catalog = prepared.export(); delete request.delta;
    }
    return request;
  };
  const api = async (method, body, query = '', binary = false, signal = null) => {
    // Never upload an old session's filesystem using a newly logged-in account.
    if (localStorage.getItem('vnm-token') !== token) throw new Error('Account changed');
    // Preparing a large snapshot must not consume the network timeout.
    const encodedBody = body ? await processSave('json', body) : undefined;
    if (localStorage.getItem('vnm-token') !== token) throw new Error('Account changed');
    const saveStage = method === 'GET' ? 'download' : 'upload';
    let response;
    try {
      response = await fetch(`/api/v1/games/${encodeURIComponent(gameId)}/saves${query}`, {
        method, cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(encodedBody === undefined ? {} : { body: encodedBody }),
      });
    } catch (error) { throw Object.assign(error, { saveStage, retryable: true }); }
    if ([401, 403].includes(response.status)) {
      blocked = true;
      throw Object.assign(new Error(response.status === 401
        ? 'Save sync paused — sign in again. Browser saves retained.'
        : 'Save sync paused — access denied. Browser saves retained.'), { saveStage, httpStatus: response.status });
    }
    if (response.status === 409 && query === '/directory') {
      throw Object.assign(new Error('Save directory belongs to a different build'), { code: 'SAVE_BUILD_CHANGED' });
    }
    if (response.status === 409) {
      const details = await response.json();
      if (['SAVE_BASE_CHANGED', 'SAVE_MANIFEST_CHANGED', 'SAVE_REFERENCE_BASE_MISSING'].includes(details.code)) throw Object.assign(new Error(details.message), {
        code: details.code, saveStage, retryable: details.code === 'SAVE_MANIFEST_CHANGED',
      });
      blocked = true; throw new Error('Save upload could not be verified — device saves retained');
    }
    if (!response.ok) {
      if (method === 'PUT' && response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
        const details = await response.json().catch(() => ({}));
        // A rejected delta can retry once as its preserved full snapshot.
        if (details.code === 'SAVE_INVALID_RESULT') throw Object.assign(new Error(details.message), { code: details.code });
        blocked = true;
        throw new Error(`Save sync paused — ${typeof details.message === 'string' ? details.message.slice(0, 200) : `upload rejected (${response.status})`}. Browser saves retained.`);
      }
      throw Object.assign(new Error(`Save service unavailable (${response.status})`), {
        saveStage, httpStatus: response.status,
        retryable: response.status >= 500 || [408, 429].includes(response.status),
      });
    }
    try {
      const result = binary ? new Uint8Array(await response.arrayBuffer()) : await response.json();
      if (localStorage.getItem('vnm-token') !== token) throw new Error('Account changed');
      return result;
    }
    catch (error) {
      throw Object.assign(error, { saveStage, retryable: ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name) });
    }
  };
  // Logical save state is independent of which immutable files are resident.
  // Partial startup remains gated until the engine adapter owns remote aliases.
  function createSaveCatalog(saved) {
    const state = { ...saved, files: saved.files.map(file => ({ ...file })) };
    const rows = new Map(state.files.map(file => [file.path, file]));
    let generation = state.generation || 0;
    const baseHashes = new Set(state.baseHashes || state.files.filter(file => !Object.hasOwn(file, 'data')).map(file => file.hash));
    const copy = value => ({ ...value });
    const equal = (a, b) => a && a.path === b.path && a.mtime === b.mtime && a.hash === b.hash && a.size === b.size &&
      Object.hasOwn(a, 'data') === Object.hasOwn(b, 'data');
    function put(file) {
      const before = rows.get(file.path);
      if (!equal(before, file)) { rows.set(file.path, copy(file)); generation++; }
    }
    return {
      mergeResident(files, expectedGeneration = generation) {
        if (generation !== expectedGeneration) throw Object.assign(new Error('Save catalog changed during preparation'), { code: 'SAVE_CATALOG_CHANGED' });
        // Absence is a cache miss. Only explicit remove/rename operations can
        // delete logical paths. Hydration with identical bytes is not a save.
        for (const file of files) {
          if (typeof file.data !== 'string' || !/^[a-f0-9]{64}$/.test(file.hash)) throw new Error('Verified save bytes are required');
          const size = file.size ?? file.data.length / 4 * 3 - (file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0);
          const row = { path: file.path, mtime: file.mtime, hash: file.hash, size };
          // Support files are small and can change between slot versions.
          // Always retain their bytes instead of referencing an older slot baseline.
          if (!file.path.endsWith('.save') || !baseHashes.has(file.hash)) row.data = file.data;
          put(row);
        }
      },
      remove(path) { if (rows.delete(path)) generation++; },
      rename(from, to) {
        if (from === to || !rows.has(from)) return;
        const row = rows.get(from); rows.delete(from); put({ ...row, path: to }); generation++;
      },
      duplicate(from, to) { if (rows.has(from)) put({ ...rows.get(from), path: to }); },
      export() { return { version: 1, revision: state.revision, baseVersionId: state.baseVersionId,
        ...(state.runtime ? { runtime: state.runtime } : {}),
        baseHashes: [...baseHashes], generation,
        files: [...rows.values()].map(copy).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }; },
      request() {
        return { version: 1, baseVersionId: state.baseVersionId,
          files: [...rows.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file =>
            Object.hasOwn(file, 'data') ? { path: file.path, mtime: file.mtime, data: file.data }
              : { path: file.path, mtime: file.mtime, hash: file.hash, size: file.size }) };
      },
      acknowledge(accepted, baseVersionId, revision) {
        // Advance the reference authorization without replacing newer local
        // writes, aliases or explicit deletions made while this upload ran.
        if (accepted.files.some(file => !/^[a-f0-9]{64}$/.test(file.hash))) throw new Error('Verified baseline hashes are required');
        const nextHashes = new Set(accepted.files.map(file => file.hash));
        for (const row of rows.values()) {
          if (!Object.hasOwn(row, 'data') && !nextHashes.has(row.hash)) throw new Error('Save baseline no longer contains a required file');
        }
        baseHashes.clear(); for (const hash of nextHashes) baseHashes.add(hash);
        for (const row of rows.values()) if (row.path.endsWith('.save') && nextHashes.has(row.hash)) delete row.data;
        state.baseVersionId = baseVersionId; state.revision = revision;
      },
    };
  }
  // Content transfers never install files. A future lazy-load caller must
  // recheck its slot alias and local mutation owner before touching IDBFS.
  function createSaveDownloads(fetchFile, verify, { concurrency = 2, cacheBytes = 16 * 1024 * 1024, authorize = () => {} } = {}) {
    const jobs = new Map(), queue = [], cache = new Map();
    let active = 0, cachedBytes = 0;
    const aborted = () => new DOMException('Save download cancelled', 'AbortError');
    function remember(hash, content) {
      const old = cache.get(hash); if (old) cachedBytes -= old.size;
      cache.delete(hash);
      if (content.size <= cacheBytes) { cache.set(hash, Object.freeze({ ...content, hash })); cachedBytes += content.size; }
      while (cachedBytes > cacheBytes) {
        const hash = cache.keys().next().value; cachedBytes -= cache.get(hash).size; cache.delete(hash);
      }
    }
    function pump() {
      queue.sort((a, b) => b.priority - a.priority);
      while (active < concurrency && queue.length) {
        const job = queue.shift(); if (!job.waiters.size) continue;
        active++;
        (async () => {
          authorize();
          const bytes = await fetchFile(job.file, job.revision, job.controller.signal);
          if (bytes.length !== job.file.size) throw new Error('Save file size could not be verified');
          const content = await verify(bytes);
          authorize();
          if (job.controller.signal.aborted) throw aborted();
          if (content.hash !== job.file.hash || content.size !== job.file.size) throw new Error('Save file could not be verified');
          remember(job.file.hash, content);
          return content;
        })().then(content => finish(null, content), error => finish(error));
        function finish(error, content) {
          if (jobs.get(job.key) === job) jobs.delete(job.key);
          active--;
          for (const waiter of job.waiters) {
            waiter.cleanup();
            if (error) waiter.reject(error); else waiter.resolve(content);
          }
          job.waiters.clear(); pump();
        }
      }
    }
    return { seed: remember, get(file, revision, { priority = 0, signal } = {}) {
      try { authorize(); } catch (error) { return Promise.reject(error); }
      if (signal?.aborted) return Promise.reject(aborted());
      if (!/^[a-f0-9]{64}$/.test(file.hash) || !Number.isSafeInteger(file.size) || file.size < 0 ||
          !Number.isSafeInteger(revision) || revision < 0) return Promise.reject(new Error('Invalid save download'));
      const hit = cache.get(file.hash);
      if (hit) {
        if (hit.size !== file.size) return Promise.reject(new Error('Save file size could not be verified'));
        remember(file.hash, hit); return Promise.resolve(hit);
      }
      const key = `${revision}:${file.versionId || ''}:${file.hash}`;
      let job = jobs.get(key);
      if (!job) {
        job = { key, file: { ...file }, revision, priority, controller: new AbortController(), waiters: new Set() };
        jobs.set(key, job); queue.push(job);
      }
      if (job.file.size !== file.size) return Promise.reject(new Error('Save file size could not be verified'));
      job.priority = Math.max(job.priority, priority);
      const promise = new Promise((resolve, reject) => {
        const cancel = () => {
          job.waiters.delete(waiter); waiter.cleanup(); reject(aborted());
          if (!job.waiters.size) {
            if (jobs.get(key) === job) jobs.delete(key);
            job.controller.abort();
          }
        };
        const waiter = { resolve, reject, cleanup: () => signal?.removeEventListener('abort', cancel) };
        job.waiters.add(waiter); signal?.addEventListener('abort', cancel, { once: true });
      });
      pump(); return promise;
    } };
  }
  const downloads = createSaveDownloads(
    async (file, revision, signal) => {
      // Prepared copies are scoped and rehashed before use. Storage failures do
      // not prevent ordinary server downloads or touch the engine filesystem.
      const cached = await preparedSaves?.readFile(file).catch(() => null);
      return cached || api('GET', null, file.versionId
        ? `/versions/${encodeURIComponent(file.versionId)}/files/${file.hash}` : `/files/${file.hash}?revision=${revision}`, true, signal);
    },
    bytes => processSave('download', bytes),
    { authorize: () => { if (localStorage.getItem('vnm-token') !== token) throw new Error('Account changed'); } },
  );
  function validateManifest(remote) {
    if (remote.manifest === null) return;
    const manifest = remote.manifest;
    if (!Number.isSafeInteger(remote.revision) || remote.revision < 0 || manifest?.version !== 1 ||
        !Array.isArray(manifest.files) || manifest.files.length > 4096) throw new Error('Invalid save manifest');
    const paths = new Set(); let total = 0;
    for (const file of manifest.files) {
      if (typeof file.path !== 'string' || !file.path || file.path.length > 512 ||
          /[\\\x00-\x1f]/.test(file.path) || file.path.split('/').some(p => !p || p === '.' || p === '..') ||
          paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.hash) ||
          !Number.isSafeInteger(file.mtime) || file.mtime < 0 || file.mtime > 8640000000000000 ||
          !Number.isSafeInteger(file.size) || file.size < 0 || (total += file.size) > maxSnapshotBytes) throw new Error('Invalid save manifest');
      paths.add(file.path);
    }
    for (const path of paths) {
      const parts = path.split('/');
      while (parts.length > 1) { parts.pop(); if (paths.has(parts.join('/'))) throw new Error('Invalid save manifest tree'); }
    }
  }
  async function materialize(remote, local) {
    if (!remote.fileDownloads) return remote; // Older APIs still return snapshots.
    if (remote.manifest === null) return { ...remote, snapshot: null };
    validateManifest(remote);
    const manifest = remote.manifest;
    // The populated, account-scoped engine filesystem is our initial cache.
    // Hash bytes rather than trusting mtimes or a remembered clean flag, and
    // reuse content across autosave filename rotation. No files change here.
    const cached = new Map((await processSave('hashes', local)).map(file => [file.hash, {
      data: file.data, size: file.data.length / 4 * 3 - (file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0),
    }]));
    for (const [hash, content] of cached) downloads.seed(hash, content);
    const files = new Array(manifest.files.length); let next = 0;
    const controller = new AbortController();
    try { await Promise.all([0, 1].map(async () => {
      while (next < manifest.files.length) {
        const index = next++, file = manifest.files[index];
        const content = cached.get(file.hash) || await downloads.get(file, remote.revision, { signal: controller.signal });
        if (content.size !== file.size) throw new Error('Save file size could not be verified');
        cached.set(file.hash, content);
        files[index] = { path: file.path, mtime: file.mtime, data: content.data };
      }
    })); } catch (error) { controller.abort(); throw error; }
    if (localStorage.getItem('vnm-token') !== token) throw new Error('Account changed');
    return { ...remote, snapshot: { version: 1, files } };
  }
  function canUseLazy(remote) {
    const directory = remote.saveDirectory;
    return window.__VNM_SAVE_ADAPTER__?.version === 1 && window.__VNM_SAVE_ADAPTER__.engine === '8.5.2.26010301' &&
      remote.referenceUploads && remote.previewDownloads && remote.fileDownloads &&
      remote.saveBuildVersion === (params.get('vnmBuild') || null) && typeof directory === 'string' && directory &&
      !/[\\:\x00-\x1f]/.test(directory) && directory.split('/').every(p => p && p !== '.' && p !== '..') && directory.split('/')[0] !== 'tokens';
  }
  async function prepareLazy(remote, local) {
    validateManifest(remote);
    const all = remote.manifest?.files || [], directory = remote.saveDirectory, prefix = `${directory}/`, suffix = '-LT1.save';
    const slots = all.filter(file => file.path.startsWith(prefix) && !file.path.slice(prefix.length).includes('/') && file.path.endsWith(suffix));
    // Custom suffixes/backends retain complete hydration.
    if (all.some(file => file.path.startsWith(prefix) && !file.path.slice(prefix.length).includes('/') &&
      file.path.endsWith('.save') && !slots.includes(file))) return materialize(remote, local);
    const mirrors = all.filter(file => file.path.startsWith(`${prefix}sync/`) &&
      slots.some(slot => slot.path === prefix + file.path.slice((`${prefix}sync/`).length) && slot.hash === file.hash));
    const previews = {}, need = new Set(all.filter(file => !slots.includes(file) && !mirrors.includes(file)).map(file => file.path));
    const latest = [...slots].sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))[0];
    if (latest) need.add(latest.path);
    let previewBytes = 0, nextPreview = 0;
    const unique = [...new Map(slots.map(file => [file.hash, file])).values()], unsupported = new Set();
    await Promise.all([0, 1].map(async () => {
      while (nextPreview < unique.length && previewBytes <= 8 * 1024 * 1024) {
        const file = unique[nextPreview++];
        const preview = await api('GET', null, `/files/${file.hash}/preview?revision=${remote.revision}`);
        previewBytes += JSON.stringify(preview).length;
        if (!preview.supported || !preview.metadata || typeof preview.metadata !== 'object' || Array.isArray(preview.metadata)) unsupported.add(file.hash);
        else previews[file.hash] = preview;
      }
    }));
    if (previewBytes > 8 * 1024 * 1024) return materialize(remote, local);
    for (const file of slots) if (unsupported.has(file.hash)) need.add(file.path);
    const cached = new Map((await processSave('hashes', local)).map(file => [file.hash, file.data]));
    const partial = { ...remote, manifest: { version: 1, files: all.filter(file => need.has(file.path) || cached.has(file.hash)) } };
    const hydrated = await materialize(partial, local);
    return { ...remote, snapshot: hydrated.snapshot || { version: 1, files: [] }, lazy: { directory, suffix, previews, revision: remote.revision, buildVersion: remote.saveBuildVersion } };
  }
  async function downloadSaves(query = '', lazy = false) {
    const incremental = Boolean(window.crypto?.subtle);
    const download = async () => {
      const suffix = incremental ? `${query}${query ? '&' : '?'}manifest=1` : query;
      const remote = await api('GET', null, suffix);
      try {
        if (!incremental || !remote.fileDownloads) return remote;
        const local = await snapshot();
        return lazy && canUseLazy(remote) ? await prepareLazy(remote, local) : await materialize(remote, local);
      }
      catch (error) { throw Object.assign(error, { saveStage: 'download' }); }
    };
    try {
      try { return await download(); }
      catch (error) {
        if (!error.retryable) throw error;
        reportFailure('download', error); status('Retrying save download…');
        // Retry only before startup releases the game.
        return await download();
      }
    } catch (error) {
      // An explicitly prepared server checkpoint is a startup-only fallback.
      // Pending/dirty progress retains the existing local/outbox recovery path.
      if (error.retryable && !blocked && !meta.dirty && !pendingUpload && preparedSaves) {
        const prepared = await preparedSaves.manifest(params.get('vnmBuild') || null,
          { revision: meta.revision, saveChecksum: meta.baseSaveChecksum }).catch(() => null);
        if (prepared) return materialize({ ...prepared.remote, offline: true }, await snapshot());
      }
      throw error;
    }
  }
  function activateLazy(runtime) {
    lazyRuntime = runtime;
    fs.mkdirTree('/tmp/vnm-save-previews');
    for (const [hash, preview] of Object.entries(runtime.previews)) {
      if (preview.screenshot?.type === 'image/png' && /^[a-f0-9]{64}$/.test(hash)) {
        fs.writeFile(`/tmp/vnm-save-previews/${hash}.png`, Uint8Array.from(atob(preview.screenshot.data), c => c.charCodeAt(0)));
      }
    }
  }
  function catalogRow(path) { return logicalCatalog?.export().files.find(file => file.path === path); }
  function exists(path) { try { return fs.isFile(fs.stat(path).mode) && Boolean(fs.readFile(path)); } catch { return false; } }
  async function hydrate(path, { foreground = false, signal } = {}) {
    const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : '';
    const row = catalogRow(relative);
    if (!row || !relative) throw new Error('Save slot is no longer available');
    if (exists(path)) return;
    const base = logicalCatalog.export();
    const content = Object.hasOwn(row, 'data') ? await processSave('download', Uint8Array.from(atob(row.data), c => c.charCodeAt(0)))
      : await downloads.get({ ...row, versionId: base.baseVersionId }, base.revision, { priority: foreground ? 10 : 0, signal });
    if (content.hash !== row.hash || content.size !== row.size) throw new Error('Save file could not be verified');
    if (signal?.aborted) throw new DOMException('Save download cancelled', 'AbortError');
    if (localStorage.getItem('vnm-token') !== token) throw new Error('Account changed');
    if (catalogRow(relative)?.hash !== row.hash) throw new Error('Save slot changed during download');
    if (exists(path)) {
      if (residentHashes.get(relative) === row.hash) return;
      throw new Error('A newer browser save replaced this slot');
    }
    const bytes = Uint8Array.from(atob(content.data), c => c.charCodeAt(0));
    installing = true;
    try {
      fs.mkdirTree(path.slice(0, path.lastIndexOf('/'))); fs.writeFile(path, bytes); fs.utime(path, row.mtime, row.mtime);
      residentHashes.set(relative, row.hash);
    } finally { installing = false; }
    await flush();
    if (catalogRow(relative)?.hash !== row.hash || residentHashes.get(relative) !== row.hash) throw new Error('Save slot changed while caching');
    // Cache growth must not become progress or a deletion on the next flush.
    lastUploadedContents?.set(relative, content.data);
    if (relative.endsWith('.save')) lastUploadedSlots.set(relative, content.data);
  }
  window.vnmSaves = {
    get active() { return Boolean(lazyRuntime); },
    transfer: { pending: false, error: null },
    rows(directory, suffix) {
      if (!lazyRuntime || directory !== `${root}/${lazyRuntime.directory}` || suffix !== lazyRuntime.suffix) return {};
      const prefix = `${lazyRuntime.directory}/`, rows = {};
      for (const file of logicalCatalog.export().files) {
        if (!file.path.startsWith(prefix) || file.path.slice(prefix.length).includes('/') || !file.path.endsWith(suffix)) continue;
        const preview = lazyRuntime.previews[file.hash];
        rows[file.path.slice(prefix.length, -suffix.length)] = { hash: file.hash, mtime: file.mtime / 1000,
          metadata: preview?.metadata || {}, thumbnail: preview?.screenshot ? `/tmp/vnm-save-previews/${file.hash}.png` : null };
      }
      return rows;
    },
    mutate(directory, operation, old, next, suffix) {
      if (!lazyRuntime || directory !== `${root}/${lazyRuntime.directory}` || suffix !== lazyRuntime.suffix) return;
      const prefix = `${lazyRuntime.directory}/`, from = prefix + old + suffix, to = prefix + next + suffix;
      const before = logicalCatalog.export().generation;
      const invalidateDestination = (source, destination) => {
        if (!['rename', 'copy'].includes(operation) || !catalogRow(source) || exists(`${root}/${source}`) || !exists(`${root}/${destination}`)) return;
        // Native FileLocation skips an absent source and leaves an old
        // destination on disk. It must not override the newly moved alias.
        installing = true;
        try { fs.unlink(`${root}/${destination}`); residentHashes.delete(destination); }
        finally { installing = false; }
      };
      invalidateDestination(from, to);
      if (operation === 'rename') logicalCatalog.rename(from, to);
      if (operation === 'copy') logicalCatalog.duplicate(from, to);
      if (operation === 'remove') logicalCatalog.remove(from);
      const mirrorFrom = prefix + 'sync/' + old + suffix, mirrorTo = prefix + 'sync/' + next + suffix;
      invalidateDestination(mirrorFrom, mirrorTo);
      if (operation === 'rename') logicalCatalog.rename(mirrorFrom, mirrorTo);
      if (operation === 'copy') logicalCatalog.duplicate(mirrorFrom, mirrorTo);
      if (operation === 'remove') logicalCatalog.remove(mirrorFrom);
      if (logicalCatalog.export().generation !== before) {
        mutationVersion++; meta.dirty = true; remember(); fs.syncfs(false);
      }
    },
    begin(path) {
      const transfer = { pending: true, error: null }, controller = new AbortController();
      window.vnmSaves.transfer = transfer;
      const panel = document.createElement('div'), text = document.createElement('p'), cancel = document.createElement('button');
      panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#111e;color:white;display:grid;place-content:center;gap:16px;padding:24px;font:16px sans-serif';
      text.textContent = 'Downloading selected save…'; cancel.textContent = 'Cancel'; cancel.type = 'button';
      cancel.style.cssText = 'min-width:120px;min-height:44px'; cancel.onclick = () => controller.abort();
      panel.append(text, cancel); document.body.append(panel);
      hydrate(path, { foreground: true, signal: controller.signal }).catch(error => {
        transfer.error = error.message; reportFailure('download', error);
        status(error.name === 'AbortError' ? 'Save download cancelled — current progress unchanged.'
          : 'Could not load this save — current progress unchanged. Check your connection and try again.', false, true);
      }).finally(() => { transfer.pending = false; panel.remove(); });
    },
  };
  async function prefetchSaves() {
    if (!lazyRuntime || blocked) return;
    const files = logicalCatalog.export().files.filter(file => file.path.endsWith(lazyRuntime.suffix));
    let next = 0;
    await Promise.all([0, 1].map(async () => {
      while (next < files.length) {
        const file = files[next++];
        try { await hydrate(`${root}/${file.path}`); }
        catch (error) { reportFailure('prefetch', error); }
      }
    }));
  }
  let directoryPending = false, directoryRecorded = false;
  async function recordDirectory() {
    if (directoryPending || directoryRecorded || typeof window.renpy_get !== 'function') return;
    directoryPending = true;
    try {
      // Query the initialized engine rather than guessing from game titles or
      // uploaded PC paths. This metadata must not delay saves or game startup.
      const savedir = await window.renpy_get('config.savedir');
      if (typeof savedir !== 'string' || !savedir.startsWith(`${root}/`)) return;
      const directory = savedir.slice(root.length + 1).replace(/\/+$/, '');
      if (!directory || directory.length > 400 || /[\\:\x00-\x1f]/.test(directory) ||
          directory.split('/').some(part => !part || part === '.' || part === '..') || directory.split('/')[0] === 'tokens') return;
      await api('POST', { directory, buildVersion: params.get('vnmBuild') || null }, '/directory');
      directoryRecorded = true;
    } catch (error) {
      // An old open tab must not replace metadata from a newly built game.
      if (error.code === 'SAVE_BUILD_CHANGED') directoryRecorded = true;
      /* Offline or older API: retry later without affecting sync. */
    }
    finally { directoryPending = false; }
  }
  async function sendUpload(request) {
    const { snapshot: fullSnapshot, delta, fileSnapshot, catalog: localCatalog, ...metadata } = request;
    let full = fullSnapshot;
    if (fileSnapshot) {
      try { return await api('PUT', { ...metadata, fileSnapshot }); }
      catch (error) {
        if (error.code !== 'SAVE_REFERENCE_BASE_MISSING') throw error;
        // Recover only with verified complete bytes. An uncached reference is
        // not permission to omit a slot from an offline alternate.
        const available = new Map((await processSave('hashes', full || { files: [] })).map(file => [file.hash, file.data]));
        if (fileSnapshot.files.some(file => !Object.hasOwn(file, 'data') && !available.has(file.hash))) {
          blocked = true;
          throw new Error('Save sync paused — an older save baseline expired. Pending browser progress is retained.');
        }
        full = { version: 1, files: fileSnapshot.files.map(file => ({ path: file.path, mtime: file.mtime,
          data: Object.hasOwn(file, 'data') ? file.data : available.get(file.hash) })) };
        request.snapshot = full; delete request.fileSnapshot; delete request.delta;
        await outbox('put', request);
        return api('PUT', { ...metadata, snapshot: full });
      }
    }
    if (delta) {
      try { return await api('PUT', { ...metadata, delta }); }
      catch (error) {
        if (!['SAVE_BASE_CHANGED', 'SAVE_INVALID_RESULT'].includes(error.code)) throw error;
        // Persist the fallback before sending it, so a lost full-upload response
        // or reload retries exactly the same request and upload ID.
        delete request.delta; await outbox('put', request);
      }
    }
    return api('PUT', { ...metadata, snapshot: full });
  }
  async function snapshot() {
    const capturedVersion = mutationVersion;
    const capturedCatalog = logicalCatalog?.export();
    const files = [];
    function walk(directory) {
      for (const name of fs.readdir(directory).filter(n => n !== '.' && n !== '..').sort()) {
        const path = `${directory}/${name}`;
        const stat = fs.stat(path);
        if (fs.isDir(stat.mode)) walk(path);
        else if (fs.isFile(stat.mode)) {
          const bytes = fs.readFile(path);
          // Own the transferred buffer even if a filesystem implementation
          // returns a view into the engine's memory rather than a fresh copy.
          files.push({ path: path.slice(root.length + 1), mtime: stat.mtime.getTime(), bytes: new Uint8Array(bytes) });
        }
      }
    }
    walk(root);
    try {
      const copy = await processSave('snapshot', files);
      snapshotVersions.set(copy, capturedVersion);
      if (capturedCatalog) snapshotCatalogs.set(copy, capturedCatalog);
      return copy;
    }
    catch (error) {
      // A blocked/crashed worker has transferred its buffers. Recapture from
      // the untouched filesystem for the compatibility fallback.
      if (!saveWorker) return snapshot();
      throw error;
    }
  }
  function restore(copy, previous = null) {
    // Validate completely before touching the filesystem, even for server data.
    const seen = new Set();
    let total = 0;
    if (copy?.version !== 1 || !Array.isArray(copy.files) || copy.files.length > 4096) throw new Error('Unsupported snapshot');
    const decoded = copy.files.map(file => {
      if (!file.path || file.path.length > 512 || /[\\\x00-\x1f]/.test(file.path) ||
          file.path.split('/').some(p => !p || p === '.' || p === '..') || seen.has(file.path) ||
          !Number.isSafeInteger(file.mtime) || file.mtime < 0 || file.mtime > 8640000000000000) throw new Error('Invalid snapshot path');
      seen.add(file.path);
      const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
      total += bytes.length;
      if (total > maxSnapshotBytes) throw new Error('Snapshot exceeds the 128 MiB limit');
      return { ...file, bytes };
    });
    for (const path of seen) {
      const parts = path.split('/');
      while (parts.length > 1) { parts.pop(); if (seen.has(parts.join('/'))) throw new Error('Invalid snapshot tree'); }
    }
    function clear(path) {
      for (const name of fs.readdir(path).filter(n => n !== '.' && n !== '..')) {
        const child = `${path}/${name}`;
        if (fs.isDir(fs.stat(child).mode)) {
          clear(child);
          if (!fs.readdir(child).some(name => name !== '.' && name !== '..')) fs.rmdir(child);
        }
        else if (!previous || !seen.has(child.slice(root.length + 1))) fs.unlink(child);
      }
    }
    clear(root);
    const oldFiles = new Map(previous?.files.map(file => [file.path, file]) || []);
    for (const file of decoded) {
      const path = `${root}/${file.path}`;
      fs.mkdirTree(path.slice(0, path.lastIndexOf('/')));
      if (oldFiles.get(file.path)?.data !== file.data) fs.writeFile(path, file.bytes);
      if (oldFiles.get(file.path)?.mtime !== file.mtime) fs.utime(path, file.mtime, file.mtime);
    }
  }
  const flush = () => new Promise((resolve, reject) => nativeSync(false, err => err ? reject(err) : resolve()));
  function persistCatalog(state = logicalCatalog?.export(), order = ++catalogOrder) {
    if (!state) return Promise.resolve();
    if (order < newestCatalogOrder) return catalogWrites;
    newestCatalogOrder = order;
    const key = JSON.stringify([state.baseVersionId, state.revision, state.generation]);
    if (key === scheduledCatalogKey) return catalogWrites;
    scheduledCatalogKey = key;
    const task = catalogWrites.catch(() => {}).then(() => outbox('put', state, 'catalogs')).catch(error => {
      if (scheduledCatalogKey === key) scheduledCatalogKey = null;
      throw error;
    });
    catalogWrites = task; return task;
  }
  // Keep the exact request across network failures and reloads. Storing its
  // potentially large snapshot in IndexedDB avoids localStorage's small quota.
  function outbox(operation, value, storeName = 'uploads') {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('vnm-save-outbox', 3);
      req.onupgradeneeded = () => {
        for (const name of ['uploads', 'baselines', 'catalogs']) {
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
        }
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(storeName, operation === 'get' ? 'readonly' : 'readwrite');
        const store = tx.objectStore(storeName);
        const action = operation === 'put' ? store.put(value, namespace) : store[operation](namespace);
        tx.oncomplete = () => { db.close(); resolve(action.result); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }
  // Legacy storage has no account owner. Offer only this game's verified path;
  // importing is explicit and leaves the original shared browser copy intact.
  function choose(message, options) {
    return new Promise(resolve => {
      const panel = document.createElement('div');
      panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#111e;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;font:16px sans-serif';
      const text = document.createElement('p'); text.textContent = message;
      text.style.cssText = 'width:100%;max-width:480px;line-height:1.5'; panel.append(text);
      for (const [label, value, description] of options) {
        const button = document.createElement('button'); button.textContent = label;
        button.style.cssText = `width:100%;max-width:480px;padding:16px;text-align:left;background:${value === 'server' ? '#047857' : '#334155'};color:white;border:1px solid #94a3b8;border-radius:6px;cursor:pointer;font:inherit`;
        if (description) {
          const detail = document.createElement('span'); detail.textContent = description;
          detail.style.cssText = 'display:block;margin-top:6px;font-size:14px;line-height:1.5;opacity:.85';
          button.append(detail);
        }
        button.onclick = () => { panel.remove(); resolve(value); }; panel.append(button);
      }
      document.body.append(panel);
    });
  }
  async function legacyCopy(directory) {
    if (typeof directory !== 'string' || !directory || directory.length > 400 ||
        /[\\:\x00-\x1f]/.test(directory) || directory.split('/').some(part => !part || part === '.' || part === '..') ||
        directory.split('/')[0] === 'tokens') return null;
    const db = await new Promise((resolve, reject) => originalGetDB(root, (err, db) => err ? reject(err) : resolve(db)));
    const entries = await new Promise((resolve, reject) => {
      const tx = db.transaction('FILE_DATA', 'readonly');
      const list = []; const req = tx.objectStore('FILE_DATA').openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { list.push([c.key, c.value]); c.continue(); } };
      tx.oncomplete = () => resolve(list); tx.onabort = () => reject(tx.error);
    });
    const prefix = `${root}/${directory}/`;
    if (!entries.some(([path, entry]) => entry.contents && path.startsWith(prefix) &&
        (path.endsWith('.save') || path === `${prefix}persistent`))) return null;
    const folder = await choose('Existing browser saves found for this game. Import a copy into your account? The original stays untouched.',
      [['Start without importing', null], [`Import ${directory}`, directory]]);
    if (!folder) return null;
    return { version: 1, files: entries.filter(([path, entry]) => entry.contents &&
      (path.startsWith(`${root}/${folder}/`) || path.startsWith(`${root}/tokens/`))).map(([path, entry]) => {
        const bytes = new Uint8Array(entry.contents); let data = '';
        for (let i = 0; i < bytes.length; i += 8192) data += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return { path: path.slice(root.length + 1), mtime: new Date(entry.timestamp).getTime(), data: btoa(data) };
      }) };
  }
  async function start() {
    let local;
    try { local = await snapshot(); }
    catch (error) { reportFailure('prepare', error); blocked = true; status('Save sync paused — unable to prepare browser saves. Browser saves retained.'); return; }
    if (!meta.dirty) {
      lastUploadedContents = contents(local);
      lastUploadedSlots = slots(local);
    }
    let stage = 'storage';
    try {
      if (window.isSecureContext && window.crypto?.subtle && window.indexedDB) {
        // Avoid loading an optional preparation module in browsers that have
        // never prepared saves. A missing module must not delay game startup.
        let timeout;
        try {
          const databases = await indexedDB.databases?.();
          if (!databases || databases.some(database => database.name === 'vnm-prepared-saves')) {
            const module = await Promise.race([import('/save-offline.js'), new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error('Prepared storage unavailable')), 2000);
            })]);
            preparedSaves = module.createSavePreparation({ userId, gameId, token });
          }
        } catch { /* Ordinary sync and the outbox remain available. */ }
        finally { clearTimeout(timeout); }
      }
      pendingUpload = await outbox('get') || null;
      acknowledgedSlots = await outbox('get', undefined, 'baselines') || null;
      const savedCatalog = window.crypto?.subtle ? await outbox('get', undefined, 'catalogs') : null;
      if (savedCatalog) { logicalCatalog = createSaveCatalog(savedCatalog); referenceUploads = true; }
      if (savedCatalog?.runtime && window.__VNM_SAVE_ADAPTER__?.version === 1 && savedCatalog.runtime.buildVersion === (params.get('vnmBuild') || null)) activateLazy(savedCatalog.runtime);
      if (pendingUpload) { meta.revision = pendingUpload.revision; meta.dirty = true; }
      else if (acknowledgedSlots && acknowledgedSlots.revision > meta.revision) meta.revision = acknowledgedSlots.revision;
      // The outbox also protects resident bytes if the engine database is lost.
      // Recover before contacting the server so an outage cannot hide that copy.
      // A populated engine filesystem may contain later writes; never replace it.
      if (pendingUpload && !local.files.length && pendingUpload.snapshot.files.length) {
        stage = 'restore';
        local = pendingUpload.snapshot; restore(local); await flush();
        stage = 'storage';
      }
      let remote = await downloadSaves(pendingUpload ? `?uploadId=${encodeURIComponent(pendingUpload.uploadId)}` : '', !meta.dirty && !pendingUpload);
      deltaUploads = Boolean(remote.deltaUploads);
      referenceUploads = Boolean(remote.referenceUploads && window.crypto?.subtle);
      if (!referenceUploads) logicalCatalog = null;
      else if (!logicalCatalog && pendingUpload?.catalog) logicalCatalog = createSaveCatalog(pendingUpload.catalog);
      let preserved = false;
      if (remote.lazy) {
        lazyRuntime = null;
        restore(remote.snapshot, local); await flush();
        logicalCatalog = createSaveCatalog({ version: 1, revision: remote.revision, baseVersionId: remote.currentVersionId || null,
          generation: 0, files: remote.manifest?.files || [], runtime: remote.lazy });
        meta = { revision: remote.revision, dirty: false, baseSaveChecksum: remote.saveChecksum, alternate: false }; remember();
        await checkpoint(remote.snapshot, remote.revision, remote.saveChecksum, logicalCatalog.export()); await persistCatalog();
        lastUploadedContents = contents(remote.snapshot); lastUploadedSlots = slots(remote.snapshot);
        for (const file of remote.snapshot.files) residentHashes.set(file.path, remote.manifest.files.find(row => row.path === file.path).hash);
        activateLazy(remote.lazy); startupLoaded = true; status('Saves synced'); return;
      }
      lazyRuntime = null;
      // Receipts outlive history pruning and later writes by other devices.
      if (pendingUpload) {
        const result = remote.acknowledgement || await sendUpload(pendingUpload);
        preserved = result.disposition === 'alternate';
        await acknowledge(pendingUpload.snapshot, result);
        remote = await downloadSaves();
      }
      if (!remote.snapshot && !local.files.length) {
        const legacy = await legacyCopy(remote.saveBuildVersion === (params.get('vnmBuild') || null) ? remote.saveDirectory : null);
        if (legacy) { local = legacy; restore(local); await flush(); meta.dirty = true; remember(); }
      }
      const knownBaseline = acknowledgedSlots?.revision === meta.revision;
      stage = 'prepare';
      let localSlots = await slotContents(local);
      let remoteSlots = remote.snapshot ? await slotContents(remote.snapshot) : null;
      let baselineSlots = acknowledgedSlots?.contents;
      if (logicalCatalog && acknowledgedSlots?.catalogSlots && remote.manifest) {
        logicalCatalog.mergeResident(await processSave('hashes', local));
        localSlots = await catalogSignature(logicalCatalog.export(), true);
        remoteSlots = await catalogSignature(remote.manifest, true);
        baselineSlots = acknowledgedSlots.catalogSlots;
      }
      const slotChanges = knownBaseline ? meta.dirty && baselineSlots !== localSlots
        : (meta.dirty || meta.revision === 0) && local.files.length > 0;
      const slotsAgree = remote.snapshot && localSlots === remoteSlots;
      const needsUpload = !remote.snapshot ? local.files.length > 0 : !slotsAgree &&
        (slotChanges || (meta.alternate && meta.dirty));
      if (needsUpload) {
        // Publish one-sided offline progress, or preserve it as an alternate if
        // another device also advanced. Neither case needs a blocking choice.
        if (knownBaseline && baselineSlots === (remoteSlots ?? await slotContents({ files: [] }))) {
          meta.baseSaveChecksum = remote.saveChecksum;
        }
        const next = await requestFor(local);
        await outbox('put', next); pendingUpload = next;
        const result = await sendUpload(next);
        preserved ||= result.disposition === 'alternate';
        await acknowledge(local, result);
        remote = await downloadSaves();
      }
      if (remote.snapshot) {
        stage = 'restore';
        restore(remote.snapshot, local); await flush();
        stage = 'storage';
        await checkpoint(remote.snapshot, remote.revision, remote.saveChecksum);
        meta = { revision: remote.revision, dirty: false, baseSaveChecksum: remote.saveChecksum, alternate: false }; remember();
        lastUploadedContents = contents(remote.snapshot); lastUploadedSlots = slots(remote.snapshot);
        lastUploadedFiles = new Map(remote.snapshot.files.map(file => [file.path, file.data]));
      } else {
        stage = 'storage';
        await checkpoint({ version: 1, files: [] }, 0, remote.saveChecksum);
        meta.revision = 0; meta.baseSaveChecksum = remote.saveChecksum; remember();
        lastUploadedFiles = new Map();
      }
      if (referenceUploads) {
        logicalCatalog = createSaveCatalog({ version: 1, revision: remote.revision,
          baseVersionId: remote.currentVersionId || null, generation: 0, files: remote.manifest?.files || [] });
        await persistCatalog();
        await checkpoint(remote.snapshot || { version: 1, files: [] }, remote.revision, remote.saveChecksum, logicalCatalog.export());
      }
      startupLoaded = !remote.offline;
      status(remote.offline ? 'Offline — using prepared saves' : preserved ? 'Unsynced device saves preserved in history' : 'Saves synced');
    } catch (error) {
      reportFailure(stage, error);
      // Unknown server revision must never become permission to overwrite it later.
      // Restore failures also leave the previously loaded local files available.
      try { restore(local); }
      catch (restoreError) {
        reportFailure('restore', restoreError);
        blocked = true;
        status(`Save sync paused — ${restoreError.message}. Browser saves retained.`);
        return;
      }
      status(failureStatus(stage, error));
    }
  }
  async function acknowledge(copy, result) {
    const alternate = result.disposition === 'alternate';
    const base = alternate ? meta.baseSaveChecksum || null : result.saveChecksum;
    const current = await snapshot();
    if (logicalCatalog && pendingUpload?.catalog) {
      const captured = snapshotCatalogs.get(current);
      const hashed = await processSave('hashes', current);
      if (mutationVersion !== snapshotVersions.get(current)) throw Object.assign(new Error('Save catalog changed during preparation'), { code: 'SAVE_CATALOG_CHANGED' });
      logicalCatalog.mergeResident(hashed, captured.generation);
      const previous = logicalCatalog.export();
      logicalCatalog.acknowledge(result.versionId ? pendingUpload.catalog : { files: previous.baseHashes.map(hash => ({ hash })) },
        result.versionId || previous.baseVersionId, result.revision);
      if (!sameContents(contents(current), contents(copy))) await flush();
      await persistCatalog();
    }
    await checkpoint(copy, result.revision, base, pendingUpload?.catalog || null);
    await outbox('delete'); pendingUpload = null;
    meta.revision = result.revision; meta.baseSaveChecksum = base; meta.alternate = alternate;
    meta.branchId = alternate ? result.branchId : null;
    meta.dirty = mutationVersion !== snapshotVersions.get(current) || !sameContents(contents(current), contents(copy)); remember();
    lastUploadedContents = contents(copy); lastUploadedSlots = slots(copy);
    lastUploadedFiles = alternate ? null : new Map(copy.files.map(file => [file.path, file.data]));
    return current;
  }
  async function upload() {
    if (!initialized || blocked || busy || !meta.dirty) return;
    busy = true;
    clearTimeout(preparationRetry);
    let retryPreparation = false;
    let syncingNotice;
    let stage = 'prepare';
    try {
      const copy = pendingUpload?.snapshot || await snapshot(); const copyContents = contents(copy);
      const preparedRequest = !pendingUpload && referenceUploads && logicalCatalog ? await requestFor(copy) : null;
      const catalogUnchanged = preparedRequest && acknowledgedSlots?.catalogContents === await catalogSignature(preparedRequest.catalog);
      if (!pendingUpload && (preparedRequest ? catalogUnchanged : sameContents(copyContents, lastUploadedContents))) {
        meta.dirty = false; remember();
        return;
      }
      // Confirm actual Ren'Py slot uploads separately from persistent-only writes.
      // Only server-acknowledged additions/changes qualify; deletions do not.
      const saveUploaded = copy.files.some(file => file.path.endsWith('.save') &&
        lastUploadedSlots.get(file.path) !== file.data);
      if (!pendingUpload) {
        // Alternate continuations retain real save changes, without archiving
        // every seen-text/preference flush as another unresolved alternative.
        if (meta.alternate && await slotContents(copy) === acknowledgedSlots?.contents) {
          meta.dirty = false; remember(); return;
        }
        const next = preparedRequest || await requestFor(copy);
        stage = 'storage';
        await outbox('put', next); pendingUpload = next;
      }
      // Fast background uploads should not flash the status on each interaction.
      syncingNotice = setTimeout(() => status('Syncing…'), 500);
      stage = 'upload';
      const result = acceptedUpload?.request === pendingUpload ? acceptedUpload.result : await sendUpload(pendingUpload);
      acceptedUpload = { request: pendingUpload, result };
      const acceptedCopy = pendingUpload.snapshot;
      clearTimeout(syncingNotice);
      stage = 'storage';
      const current = await acknowledge(acceptedCopy, result);
      acceptedUpload = null;
      meta.dirty = mutationVersion !== snapshotVersions.get(current) || !sameContents(contents(current), contents(acceptedCopy));
      if (current.files.some(file => file.path.endsWith('.save') && lastUploadedSlots.get(file.path) !== file.data)) {
        urgentUploadPending = true;
      }
      remember(); status(!startupLoaded ? 'Browser save uploaded — server saves were not loaded. Reopen the game.'
        : result.disposition === 'alternate' ? 'Save backed up as alternate version'
        : meta.dirty ? 'Syncing…' : 'Saves synced', saveUploaded);
    } catch (error) {
      if (error.code === 'SAVE_CATALOG_CHANGED') {
        // Ren'Py can rotate autosave aliases or finish another flush while the
        // worker hashes an earlier copy. Discard that stale preparation, keep
        // local progress/outbox intact, and retry after the write burst settles.
        // If the server already accepted it, reuse the acknowledgement locally.
        retryPreparation = true;
      } else { reportFailure(stage, error); status(failureStatus(stage, error)); }
    }
    finally {
      clearTimeout(syncingNotice); busy = false;
      if (retryPreparation) {
        urgentUploadPending = false;
        preparationRetry = setTimeout(() => { preparationRetry = null; upload(); }, 250);
      } else if (urgentUploadPending) { urgentUploadPending = false; upload(); }
    }
  }
  window.Module = window.Module || {};
  const oldPreInit = Module.preInit;
  Module.preInit = [...(Array.isArray(oldPreInit) ? oldPreInit : oldPreInit ? [oldPreInit] : []), () => {
    fs = Module.FS || window.FS;
    if (!fs || !window.IDBFS?.getDB) { status('Unsupported runtime — browser saves only'); return; }
    originalGetDB = IDBFS.getDB.bind(IDBFS);
    IDBFS.getDB = (name, callback) => originalGetDB(name === root ? namespace : name, callback);
    const engineSync = fs.syncfs.bind(fs);
    let persistenceGeneration = 0;
    const syncQueue = [];
    let syncing = false;
    const drainSync = () => {
      if (syncing || !syncQueue.length) return;
      syncing = true;
      const batch = syncQueue.shift();
      let completed = false, retries = 0;
      const attempt = () => {
        const capturedMutation = persistenceGeneration;
        let returned = false;
        const finish = error => {
          if (returned || completed) return;
          returned = true;
          // The pinned runtime reports ENOENT as 44. A rotating slot can vanish
          // between IDBFS's local-tree scan and its asynchronous reconciliation.
          // Retry a changed tree, never quota/permission errors or an unchanged
          // missing path, and bound retries so genuine failures still surface.
          if (!batch.populate && error?.name === 'ErrnoError' && error.errno === 44 &&
              capturedMutation !== persistenceGeneration && retries < 3) {
            setTimeout(attempt, 25 * (2 ** retries++)); return;
          }
          completed = true;
          try {
            for (const callback of batch.callbacks) {
              try { callback(error); }
              catch (callbackError) { setTimeout(() => { throw callbackError; }, 0); }
            }
          } finally {
            // Let IDBFS finish unwinding its reconcile callback before starting
            // another transaction, including when it failed part-way through.
            Promise.resolve().then(() => { syncing = false; drainSync(); });
          }
        };
        try { engineSync(batch.populate, finish); }
        catch (error) { finish(error); }
      };
      attempt();
    };
    // All native persistence, including bridge hydration/checkpoints, shares one
    // queue. IDBFS reconciles an asynchronously enumerated tree and overlapping
    // reconciliations can overwrite each other or access rotated-away slots.
    nativeSync = (populate, callback) => {
      const pending = syncQueue.at(-1);
      if (!populate && pending && !pending.populate) pending.callbacks.push(callback);
      else syncQueue.push({ populate, callbacks: [callback] });
      drainSync();
    };
    let slotFlushTimer, flushes = 0, slotWriteGeneration = 0;
    const scheduleSlotFlush = (written = true) => {
      if (written) { slotWritePending = true; slotWriteGeneration++; }
      if (slotFlushTimer !== undefined) return;
      // Let the engine finish its synchronous writes/renames, then persist the
      // completed slot ourselves instead of waiting for its periodic syncfs.
      slotFlushTimer = setTimeout(() => {
        slotFlushTimer = undefined;
        if (slotWritePending && !flushes) fs.syncfs(false);
      }, 0);
    };
    const isSaveSlot = path => typeof path === 'string' && path.startsWith(`${root}/`) && path.endsWith('.save');
    // Ren'Py writes slots directly or renames a temporary file into place.
    // Watch these operations without scanning/encoding the tree on every frame.
    const nativeClose = fs.close.bind(fs);
    fs.close = stream => {
      const wroteSlot = initialized && !installing && (stream.flags & 3) !== 0 && isSaveSlot(stream.path);
      const result = nativeClose(stream);
      if ((stream.flags & 3) !== 0 && typeof stream.path === 'string' && stream.path.startsWith(`${root}/`)) persistenceGeneration++;
      if (wroteSlot) { residentHashes.delete(stream.path.slice(root.length + 1)); mutationVersion++; scheduleSlotFlush(); }
      return result;
    };
    const nativeRename = fs.rename.bind(fs);
    fs.rename = (from, to) => {
      const result = nativeRename(from, to);
      if (from.startsWith(`${root}/`) || to.startsWith(`${root}/`)) persistenceGeneration++;
      if (initialized && !installing) {
        residentHashes.delete(from.slice(root.length + 1)); residentHashes.delete(to.slice(root.length + 1));
      }
      if (initialized && !installing && logicalCatalog && from.startsWith(`${root}/`)) {
        if (to.startsWith(`${root}/`)) logicalCatalog.rename(from.slice(root.length + 1), to.slice(root.length + 1));
        else logicalCatalog.remove(from.slice(root.length + 1));
      }
      if (initialized && !installing && (isSaveSlot(from) || isSaveSlot(to))) { mutationVersion++; scheduleSlotFlush(); }
      return result;
    };
    const nativeUnlink = fs.unlink.bind(fs);
    fs.unlink = path => {
      const result = nativeUnlink(path);
      if (path.startsWith(`${root}/`)) persistenceGeneration++;
      if (initialized && !installing && path.startsWith(`${root}/`)) {
        residentHashes.delete(path.slice(root.length + 1)); logicalCatalog?.remove(path.slice(root.length + 1));
        if (isSaveSlot(path)) { mutationVersion++; scheduleSlotFlush(); }
      }
      return result;
    };
    fs.syncfs = (populate, callback = () => {}) => {
      if (typeof populate === 'function') { callback = populate; populate = false; }
      const capturedSlotGeneration = slotWriteGeneration;
      if (!populate && initialized) {
        mutationVersion++;
        meta.dirty = true;
        try { remember(); } catch { blocked = true; status('Browser storage full — sync paused'); }
      }
      const catalogState = !populate && initialized ? logicalCatalog?.export() : null;
      const capturedCatalogOrder = catalogState ? ++catalogOrder : 0;
      flushes++;
      nativeSync(populate, async err => {
        flushes--;
        if (err) { reportFailure('storage', err); status('Browser save storage failed'); callback(err); return; }
        if (catalogState) {
          try { await persistCatalog(catalogState, capturedCatalogOrder); }
          catch (error) { reportFailure('storage', error); status('Browser save catalog storage failed — browser saves retained'); callback(error); return; }
        }
        if (populate && !initialized) {
          start().finally(() => {
            initialized = true; callback(null);
            resume();
            if (lazyRuntime) setTimeout(() => prefetchSaves().catch(error => reportFailure('prefetch', error)), 1000);
          });
        } else {
          // Start slot uploads only after their browser storage flush succeeds.
          // Persistent-only writes retain the five-second batching interval.
          const urgent = !populate && slotWritePending && capturedSlotGeneration === slotWriteGeneration;
          if (urgent) slotWritePending = false;
          callback(null);
          if (urgent) {
            if (busy) urgentUploadPending = true;
            else upload();
          }
          if (slotWritePending && !flushes) scheduleSlotFlush(false);
        }
      });
    };
  }];
  function resume() {
    if (!initialized) return;
    clearInterval(timer); timer = setInterval(() => { upload(); recordDirectory(); }, 5000);
    upload(); recordDirectory();
  }
  window.addEventListener('online', upload);
  window.addEventListener('pagehide', () => { clearInterval(timer); timer = undefined; upload(); });
  window.addEventListener('pageshow', resume);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
    else upload();
  });
})();
