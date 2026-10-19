// Immutable server-save checkpoints. Engine IDBFS and pending uploads stay separate.
const MAX_BYTES = 128 * 1024 * 1024;
const namespace = (user, game) =>
  `vnm-saves:${encodeURIComponent(user)}:${encodeURIComponent(game)}`;
const abort = (signal) => {
  if (signal?.aborted)
    throw new DOMException('Preparation cancelled', 'AbortError');
};

async function pendingProgress(scope) {
  const databases = await indexedDB.databases?.();
  if (
    databases &&
    !databases.some((database) => database.name === 'vnm-save-outbox')
  )
    return false;
  return new Promise((resolve, reject) => {
    let absent = false;
    const request = indexedDB.open('vnm-save-outbox');
    request.onupgradeneeded = () => {
      absent = true;
      request.transaction.abort();
    };
    request.onerror = () => (absent ? resolve(false) : reject(request.error));
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('uploads')) {
        db.close();
        resolve(false);
        return;
      }
      const tx = db.transaction('uploads'),
        action = tx.objectStore('uploads').get(scope);
      tx.oncomplete = () => {
        db.close();
        resolve(Boolean(action.result));
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

export function savePreparationStorage() {
  async function transaction(operation, key, value) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('vnm-prepared-saves', 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('entries');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction(
            'entries',
            ['get', 'keys'].includes(operation) ? 'readonly' : 'readwrite'
          );
        const store = tx.objectStore('entries');
        const action =
          operation === 'put'
            ? store.put(value, key)
            : operation === 'keys'
              ? store.getAllKeys(IDBKeyRange.bound(key, key + '\uffff'))
              : store[operation](key);
        tx.oncomplete = () => {
          db.close();
          resolve(action.result);
        };
        tx.onabort = tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  }
  return {
    get: (key) => transaction('get', key),
    put: (key, value) => transaction('put', key, value),
    delete: (key) => transaction('delete', key),
    keys: (prefix) => transaction('keys', prefix),
  };
}

function validate(remote) {
  if (remote?.manifest === null) remote.manifest = { version: 1, files: [] };
  if (
    !remote?.fileDownloads ||
    !Number.isSafeInteger(remote.revision) ||
    remote.revision < 0 ||
    !remote.manifest ||
    remote.manifest.version !== 1 ||
    !Array.isArray(remote.manifest.files) ||
    remote.manifest.files.length > 4096
  )
    throw new Error('Individual save downloads are unavailable');
  const paths = new Set();
  let total = 0;
  for (const file of remote.manifest.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      !file.path ||
      file.path.length > 512 ||
      /[\\\x00-\x1f]/.test(file.path) ||
      file.path
        .split('/')
        .some((part) => !part || part === '.' || part === '..') ||
      paths.has(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.hash) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !Number.isSafeInteger(file.mtime) ||
      file.mtime < 0 ||
      file.mtime > 8640000000000000
    )
      throw new Error('Invalid save manifest');
    paths.add(file.path);
    total += file.size;
    if (total > MAX_BYTES)
      throw new Error('Save data exceeds the offline preparation limit');
  }
  for (const file of remote.manifest.files) {
    const parts = file.path.split('/');
    parts.pop();
    while (parts.length) {
      if (paths.has(parts.join('/'))) throw new Error('Invalid save file tree');
      parts.pop();
    }
  }
  return total;
}

export function createSavePreparation({
  userId,
  gameId,
  token,
  storage = savePreparationStorage(),
  fetcher = (...args) => fetch(...args),
  currentToken = () => localStorage.getItem('vnm-token'),
  dirty = () =>
    Boolean(
      JSON.parse(
        localStorage.getItem(`${namespace(userId, gameId)}:meta`) || '{}'
      ).dirty
    ),
  pending = pendingProgress,
  baseline = () => {
    try {
      return JSON.parse(
        localStorage.getItem(`${namespace(userId, gameId)}:meta`) || '{}'
      );
    } catch {
      return {};
    }
  },
  digest = (bytes) => crypto.subtle.digest('SHA-256', bytes),
  now = () => Date.now(),
}) {
  if (!userId || !gameId || !token)
    throw new Error('An authenticated game is required');
  try {
    const claim = JSON.parse(
      atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
    );
    if (claim.userId !== userId) throw new Error();
  } catch {
    throw new Error('Save preparation account does not match the session');
  }
  const scope = namespace(userId, gameId),
    manifestKey = `${scope}:manifest`;
  const localChanges = async () => dirty() || (await pending(scope));
  const key = (hash) => `${scope}:blob:${hash}`;
  function authorize() {
    if (currentToken() !== token) throw new Error('Account changed');
  }
  async function hash(bytes) {
    return Array.from(new Uint8Array(await digest(bytes)), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
  }
  async function request(suffix, signal, file) {
    authorize();
    abort(signal);
    const response = await fetcher(
      `/api/v1/games/${encodeURIComponent(gameId)}/saves${suffix}`,
      {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
          : AbortSignal.timeout(60000),
      }
    );
    if (!response.ok)
      throw new Error(`Save preparation failed (${response.status})`);
    let result;
    if (file) {
      // Bound the actual response, including a server that sends a false length.
      const reader = response.body.getReader(),
        chunks = [];
      let size = 0;
      try {
        while (true) {
          abort(signal);
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > file.size)
            throw new Error('Save download is larger than its manifest');
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      }
      result = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      if (size !== file.size || (await hash(result)) !== file.hash)
        throw new Error('Save file could not be verified');
    } else result = await response.json();
    authorize();
    abort(signal);
    return result;
  }
  async function readFile(file) {
    authorize();
    if (
      !/^[a-f0-9]{64}$/.test(file.hash) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_BYTES
    )
      return null;
    const stored = await storage.get(key(file.hash));
    authorize();
    if (!stored) return null;
    const bytes = new Uint8Array(stored);
    if (bytes.length !== file.size || (await hash(bytes)) !== file.hash) {
      authorize();
      await storage.delete(key(file.hash));
      return null;
    }
    authorize();
    return bytes;
  }
  async function manifest(
    buildVersion,
    { revision = 0, saveChecksum = null } = {}
  ) {
    authorize();
    const prepared = await storage.get(manifestKey);
    authorize();
    if (
      !prepared ||
      prepared.userId !== userId ||
      prepared.gameId !== gameId ||
      prepared.version !== 1 ||
      prepared.remote.saveBuildVersion !== buildVersion ||
      prepared.remote.revision < revision ||
      (prepared.remote.revision === revision &&
        saveChecksum &&
        prepared.remote.saveChecksum !== saveChecksum)
    )
      return null;
    validate(prepared.remote);
    return prepared;
  }
  async function readiness(buildVersion) {
    const current = baseline();
    const prepared = await manifest(buildVersion, {
      revision: current.revision || 0,
      saveChecksum: current.saveChecksum || null,
    });
    if (!prepared)
      return {
        ready: false,
        scope: 'server-saves',
        reason: 'not-prepared',
        files: 0,
        bytes: 0,
      };
    let files = 0,
      bytes = 0;
    for (const file of prepared.remote.manifest.files) {
      const content = await readFile(file);
      if (content) {
        files++;
        bytes += content.length;
      }
    }
    authorize();
    const complete = files === prepared.remote.manifest.files.length;
    const changed = await localChanges();
    authorize();
    return {
      ready: complete && !changed,
      available: complete,
      localChanges: Boolean(changed),
      scope: 'server-saves',
      reason: !complete ? 'missing-files' : changed ? 'local-changes' : null,
      revision: prepared.remote.revision,
      buildVersion,
      preparedAt: prepared.preparedAt,
      files,
      bytes,
      totalFiles: prepared.remote.manifest.files.length,
    };
  }
  async function prepare({
    buildVersion = null,
    signal,
    onProgress = () => {},
  } = {}) {
    authorize();
    abort(signal);
    if (await localChanges())
      throw new Error('Sync browser progress before preparing server saves');
    const remote = await request('?manifest=1', signal);
    validate(remote);
    if (remote.saveBuildVersion !== buildVersion)
      throw new Error('Game build changed; reopen the game');
    const unique = [
      ...new Map(
        remote.manifest.files.map((file) => [file.hash, file])
      ).values(),
    ];
    const controller = new AbortController(),
      transferSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
    let next = 0,
      done = 0,
      bytes = 0;
    const tasks = [0, 1].map(async () => {
      while (next < unique.length) {
        abort(transferSignal);
        const file = unique[next++];
        const cached = await readFile(file);
        const contents =
          cached ||
          (await request(
            remote.currentVersionId
              ? `/versions/${encodeURIComponent(remote.currentVersionId)}/files/${file.hash}`
              : `/files/${file.hash}?revision=${remote.revision}`,
            transferSignal,
            file
          ));
        authorize();
        abort(transferSignal);
        if (!cached) await storage.put(key(file.hash), contents);
        authorize();
        abort(transferSignal);
        onProgress({
          files: ++done,
          totalFiles: unique.length,
          bytes: (bytes += contents.length),
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
    // Recheck the live revision/build before publishing a completeness marker.
    const latest = await request('?manifest=1', signal);
    validate(latest);
    if (
      JSON.stringify(latest.manifest) !== JSON.stringify(remote.manifest) ||
      latest.revision !== remote.revision ||
      latest.currentVersionId !== remote.currentVersionId ||
      latest.saveBuildVersion !== buildVersion
    )
      throw new Error('Server saves changed during preparation; try again');
    if (await localChanges())
      throw new Error(
        'Browser progress changed during preparation; sync it first'
      );
    authorize();
    abort(signal);
    await storage.put(manifestKey, {
      version: 1,
      userId,
      gameId,
      preparedAt: now(),
      remote,
    });
    authorize();
    abort(signal);
    return readiness(buildVersion);
  }
  async function clear() {
    authorize();
    await storage.delete(manifestKey);
    // Include bytes left by interrupted preparation, scoped to this user/game.
    // Engine IDBFS and the pending-upload database are never opened here.
    for (const entry of await storage.keys(`${scope}:blob:`)) {
      authorize();
      await storage.delete(entry);
    }
  }
  async function checkProgress() {
    authorize();
    if (await localChanges())
      throw new Error('Sync browser progress before preparing server saves');
    authorize();
  }
  return { prepare, readiness, manifest, readFile, clear, checkProgress };
}
