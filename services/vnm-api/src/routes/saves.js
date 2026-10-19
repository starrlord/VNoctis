import { createHash } from 'node:crypto';
import { currentFile, currentManifest } from '../services/saveManifest.js';
import { extractSavePreview, SAVE_PREVIEW_VERSION } from '../services/savePreview.js';
import { expandReferences, referenceSnapshot } from '../services/saveReferences.js';
import { archive, canonical, collectBlobs, digest, ensureCurrentVersion, prepareFiles, prune, pruneAll, readCurrent, readVersion, saveChecksum, saveKind, writeCurrent, writeTransaction } from '../services/saveHistory.js';

export const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;

// Never deserialize Ren'Py saves or write client-supplied paths on the server.
export function snapshotValidationError(snapshot) {
  const invalid = message => ({ code: 'SAVE_INVALID_SNAPSHOT', message });
  const tooLarge = () => ({ code: 'SAVE_SNAPSHOT_TOO_LARGE', message: 'Save data exceeds the 128 MiB limit.' });
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.files)) return invalid('Invalid save snapshot format.');
  if (snapshot.files.length > 4096) return invalid('Save data exceeds the 4096-file limit.');
  const paths = new Set();
  let bytes = 0;
  for (const file of snapshot.files) {
    if (!file || typeof file.path !== 'string' || file.path.length > 512 ||
        !file.path || file.path.split('/').some(p => !p || p === '.' || p === '..') ||
        /[\\\x00-\x1f]/.test(file.path) || paths.has(file.path) ||
        !Number.isSafeInteger(file.mtime) || file.mtime < 0 || file.mtime > 8640000000000000 ||
        typeof file.data !== 'string' ||
        file.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(file.data) ||
        file.data.slice(0, -2).includes('=') ||
        (file.data.at(-2) === '=' && file.data.at(-1) !== '=')) return invalid('Save data contains an invalid path, timestamp, duplicate file, or encoding.');
    if (file.data.length > Math.ceil(MAX_SNAPSHOT_BYTES / 3) * 4) return tooLarge();
    paths.add(file.path);
    bytes += Buffer.byteLength(file.data, 'base64');
    if (bytes > MAX_SNAPSHOT_BYTES) return tooLarge();
  }
  // A file cannot also be an ancestor directory.
  for (const path of paths) {
    const parts = path.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (paths.has(parts.join('/'))) return invalid('Save data contains a file that overlaps a folder.');
    }
  }
  return null;
}

export const validateSnapshot = snapshot => snapshotValidationError(snapshot) === null;

export function validateReferenceSnapshot(copy) {
  if (!copy || copy.version !== 1 || !Array.isArray(copy.files) || copy.files.length > 4096 ||
      !(copy.baseVersionId === null || typeof copy.baseVersionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(copy.baseVersionId))) return false;
  let total = 0;
  for (const file of copy.files) {
    if (!file || typeof file !== 'object') return false;
    if (Object.hasOwn(file, 'data')) {
      if (Object.hasOwn(file, 'hash') || Object.hasOwn(file, 'size') || typeof file.data !== 'string') return false;
      total += Buffer.byteLength(file.data, 'base64');
    } else {
      if (!copy.baseVersionId || typeof file.hash !== 'string' || !/^[a-f0-9]{64}$/.test(file.hash) ||
          !Number.isSafeInteger(file.size) || file.size < 0) return false;
      total += file.size;
    }
    if (total > MAX_SNAPSHOT_BYTES) return false;
  }
  return validateSnapshot({ version: copy.version, files: copy.files.map(file => ({ ...file, data: file.data ?? '' })) });
}

export function validateDelta(delta) {
  if (!delta || !validateSnapshot({ version: delta.version, files: delta.files }) ||
      !Array.isArray(delta.deleted) || delta.deleted.length > 4096) return false;
  const changed = new Set(delta.files.map(file => file.path));
  return delta.deleted.every(path => !changed.has(path)) && validateSnapshot({ version: 1,
    files: delta.deleted.map(path => ({ path, mtime: 0, data: '' })) });
}

export default async function savesRoutes(fastify) {
  let retentionTimer, retentionTask = null;
  fastify.addHook('onReady', async () => {
    await pruneAll(fastify.prisma);
    retentionTimer = setInterval(() => {
      if (retentionTask) return;
      retentionTask = pruneAll(fastify.prisma)
        .catch(err => fastify.log.error({ err }, 'Save history retention failed'))
        .finally(() => { retentionTask = null; });
    }, 3600000);
    retentionTimer.unref();
  });
  fastify.addHook('onClose', async () => { clearInterval(retentionTimer); await retentionTask; });
  const options = {
    bodyLimit: Math.ceil(MAX_SNAPSHOT_BYTES * 4 / 3) + 8 * 1024 * 1024,
    onRequest: async request => { request.saveStartedAt = performance.now(); },
    schema: { params: { type: 'object', required: ['gameId'], properties: {
      gameId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
    } }, querystring: { type: 'object', properties: {
      uploadId: { type: 'string', maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
      manifest: { type: 'string', enum: ['1'] },
    } } },
    preHandler: async (request, reply) => {
      if (!request.user?.userId) return reply.code(401).send({ message: 'Authentication required' });
      // VNoctis shares its library with all authenticated users, including hidden games.
      const game = await fastify.prisma.game.findUnique({ where: { id: request.params.gameId }, select: { id: true, extractedTitle: true } });
      if (!game) return reply.code(404).send({ message: 'Game not found' });
      request.saveGameTitle = game.extractedTitle;
      reply.header('Cache-Control', 'no-store');
    },
  };
  fastify.post('/games/:gameId/saves/directory', options, async (request, reply) => {
    const { directory, buildVersion = null } = request.body || {};
    if (typeof directory !== 'string' || directory.length > 400 ||
        /[\\:\x00-\x1f]/.test(directory) || directory.split('/').some(part => !part || part === '.' || part === '..') ||
        directory.split('/')[0] === 'tokens' ||
        (buildVersion !== null && (typeof buildVersion !== 'string' || buildVersion.length > 40))) {
      return reply.code(400).send({ message: 'Invalid runtime save directory.' });
    }
    const key = { userId: request.user.userId, gameId: request.params.gameId };
    const accepted = await writeTransaction(fastify.prisma, async tx => {
      const game = await tx.game.findUnique({ where: { id: key.gameId }, select: { builtAt: true } });
      if (!game || (game.builtAt?.toISOString() || null) !== buildVersion) return false;
      await tx.saveRuntimeDirectory.upsert({ where: { userId_gameId: key }, create: { ...key, directory }, update: { directory } });
      return true;
    });
    if (!accepted) return reply.code(409).send({ code: 'SAVE_BUILD_CHANGED', message: 'Game build changed; reopen the game to identify its save directory.' });
    return { directory };
  });
  fastify.get('/games/:gameId/saves', options, async request => {
    return writeTransaction(fastify.prisma, async tx => {
      const state = await tx.saveSyncState.findUnique({ where: {
        userId_gameId: { userId: request.user.userId, gameId: request.params.gameId },
      } });
      const key = { userId: request.user.userId, gameId: request.params.gameId };
      const runtime = await tx.saveRuntimeDirectory.findUnique({ where: { userId_gameId: key } });
      const identity = await tx.saveGameIdentity.findUnique({ where: { userId_gameId: key } });
      const game = await tx.game.findUnique({ where: { id: key.gameId }, select: { webSaveDirectory: true, builtAt: true } });
      const acknowledgement = request.query.uploadId ? await tx.saveUploadReceipt.findUnique({ where: {
        userId_gameId_uploadId: { ...key, uploadId: request.query.uploadId },
      } }) : null;
      const manifest = request.query.manifest === '1' ? await currentManifest(tx, state) : undefined;
      const referenceVersionId = request.query.manifest === '1' && state ? await ensureCurrentVersion(tx, state) : null;
      const snapshot = manifest === undefined && state ? await readCurrent(tx, state) : null;
      return { revision: state?.revision || 0, checksum: state?.checksum, uploadId: state?.uploadId,
        deltaUploads: true,
        previewDownloads: true,
        referenceUploads: true,
        ...(request.query.manifest === '1' ? { fileDownloads: true, manifest } : { snapshot }),
        saveDirectory: runtime?.directory || game?.webSaveDirectory || identity?.saveDirectory || null,
        saveBuildVersion: game?.builtAt?.toISOString() || null,
        currentVersionId: referenceVersionId || state?.currentVersionId,
        saveChecksum: state && manifest !== undefined ? JSON.parse(state.payload).saveChecksum || saveChecksum(JSON.parse(state.payload))
          : saveChecksum(snapshot || { files: [] }),
        acknowledgement: acknowledgement ? receiptResponse(acknowledgement, state?.revision || 0) : null };
    });
  });
  const fileOptions = {
    ...options,
    schema: {
      params: { type: 'object', required: ['gameId', 'hash'], properties: {
        ...options.schema.params.properties,
        hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      } },
      querystring: { type: 'object', required: ['revision'], properties: {
        revision: { type: 'integer', minimum: 0, maximum: 2147483647 },
      } },
    },
  };
  fastify.get('/games/:gameId/saves/files/:hash', fileOptions, async (request, reply) => {
    const result = await writeTransaction(fastify.prisma, async tx => {
      const state = await tx.saveSyncState.findUnique({ where: { userId_gameId: {
        userId: request.user.userId, gameId: request.params.gameId,
      } } });
      if ((state?.revision || 0) !== request.query.revision) return { changed: true };
      return { bytes: await currentFile(tx, state, request.params.hash) };
    });
    if (result.changed) return reply.code(409).send({ code: 'SAVE_MANIFEST_CHANGED', message: 'Server saves changed; refresh the manifest.' });
    if (!result.bytes) return reply.code(404).send({ message: 'Save file not found.' });
    return reply.type('application/octet-stream').header('X-Content-Type-Options', 'nosniff').send(result.bytes);
  });
  const previewTasks = new Map();
  fastify.get('/games/:gameId/saves/versions/:versionId/files/:hash', {
    ...fileOptions, schema: { params: { type: 'object', required: ['gameId', 'versionId', 'hash'], properties: {
      ...fileOptions.schema.params.properties,
      versionId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
    } } },
  }, async (request, reply) => {
    const file = await writeTransaction(fastify.prisma, tx => tx.saveVersionFile.findFirst({ where: {
      hash: request.params.hash, version: { id: request.params.versionId, userId: request.user.userId, gameId: request.params.gameId },
    }, select: { blob: { select: { data: true } } } }));
    if (!file) return reply.code(404).send({ message: 'Save version file not found.' });
    return reply.type('application/octet-stream').header('X-Content-Type-Options', 'nosniff').send(Buffer.from(file.blob.data));
  });
  fastify.get('/games/:gameId/saves/files/:hash/preview', fileOptions, async (request, reply) => {
    const { hash, gameId } = request.params;
    const result = await writeTransaction(fastify.prisma, async tx => {
      const state = await tx.saveSyncState.findUnique({ where: { userId_gameId: { userId: request.user.userId, gameId } } });
      if ((state?.revision || 0) !== request.query.revision) return { changed: true };
      if (!state) return {};
      if (JSON.parse(state.payload).storage === 'blobs') {
        // Check account/game association before consulting the shared cache.
        const file = await tx.saveCurrentFile.findFirst({ where: { userId: request.user.userId, gameId, hash, path: { endsWith: '.save' } },
          select: { blob: { select: { preview: true } } } });
        if (!file) return {};
        if (file.blob.preview) {
          const cached = JSON.parse(file.blob.preview);
          if (cached.version === SAVE_PREVIEW_VERSION) return { cached };
        }
      } else {
        const manifest = await currentManifest(tx, state);
        if (!manifest.files.some(file => file.hash === hash && file.path.endsWith('.save'))) return {};
      }
      if (previewTasks.size >= 4 && !previewTasks.has(hash)) return { busy: true };
      return { bytes: await currentFile(tx, state, hash) };
    });
    if (result.changed) return reply.code(409).send({ code: 'SAVE_MANIFEST_CHANGED', message: 'Server saves changed; refresh the manifest.' });
    if (result.busy) return reply.code(503).header('Retry-After', '1').send({ message: 'Save previews are busy; retry shortly.' });
    if (result.cached) return result.cached;
    if (!result.bytes) return reply.code(404).send({ message: 'Save file not found.' });
    let task = previewTasks.get(hash);
    if (!task) {
      task = (async () => {
        const preview = await extractSavePreview(result.bytes);
        // Decompression uses libuv outside the SQLite writer transaction. The
        // immutable blob may have been pruned meanwhile; updateMany tolerates it.
        await writeTransaction(fastify.prisma, tx => tx.saveFileBlob.updateMany({ where: { hash }, data: { preview: JSON.stringify(preview) } }));
        return preview;
      })();
      previewTasks.set(hash, task);
      task.finally(() => previewTasks.delete(hash)).catch(() => {});
    }
    return task;
  });
  fastify.put('/games/:gameId/saves', options, async (request, reply) => {
    const timings = {};
    let measuredAt = request.saveStartedAt ?? performance.now();
    const startedAt = measuredAt;
    const mark = name => {
      const now = performance.now();
      timings[name] = Math.round((now - measuredAt) * 10) / 10;
      measuredAt = now;
    };
    mark('beforeHandlerMs');
    const { revision, snapshot, delta, fileSnapshot, uploadId = null, baseSaveChecksum = null, alternate = false, branchId = null, deviceLabel = 'Browser' } = request.body || {};
    const incremental = delta !== undefined;
    const referenced = fileSnapshot !== undefined, encoded = incremental || referenced;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= 2147483647 ||
        (referenced ? snapshot !== undefined || incremental || uploadId === null || !validateReferenceSnapshot(fileSnapshot)
          : incremental ? snapshot !== undefined || !validateDelta(delta) || uploadId === null : !validateSnapshot(snapshot)) ||
        (uploadId !== null && (typeof uploadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uploadId))) ||
        (baseSaveChecksum !== null && (typeof baseSaveChecksum !== 'string' || !/^[a-f0-9]{64}$/.test(baseSaveChecksum))) ||
        (branchId !== null && (typeof branchId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(branchId))) ||
        typeof alternate !== 'boolean' || typeof deviceLabel !== 'string' || !deviceLabel || deviceLabel.length > 80 || /[\x00-\x1f]/.test(deviceLabel)) {
      return reply.code(400).send((referenced ? null : incremental ? snapshotValidationError({ version: delta?.version, files: delta?.files }) : snapshotValidationError(snapshot)) ||
        { code: 'SAVE_INVALID_SNAPSHOT', message: 'Invalid save upload metadata or deleted file paths.' });
    }
    let copy = encoded ? null : canonical(snapshot);
    let payload = encoded ? null : JSON.stringify(copy);
    let checksum = encoded ? null : createHash('sha256').update(payload).digest('hex');
    const deltaPayload = incremental ? JSON.stringify({ revision, delta: { ...canonical(delta), deleted: [...delta.deleted].sort() },
      baseSaveChecksum, alternate, branchId, deviceLabel }) : null;
    const referencePayload = referenced ? JSON.stringify({ revision, fileSnapshot: referenceSnapshot(fileSnapshot),
      baseSaveChecksum, alternate, branchId, deviceLabel }) : null;
    const requestChecksum = encoded ? digest(referencePayload || deltaPayload) : checksum;
    const key = { userId: request.user.userId, gameId: request.params.gameId };
    const id = uploadId || digest(`${revision}:${payload}`);
    let prepared = encoded ? null : prepareFiles(copy);
    let incomingSlots = encoded ? null : saveChecksum(copy);
    mark('validateAndHashMs');
    const result = await writeTransaction(fastify.prisma, async tx => {
      mark('queueAndBeginMs');
      const state = await tx.saveSyncState.findUnique({ where: { userId_gameId: key } });
      const receipt = await tx.saveUploadReceipt.findUnique({ where: { userId_gameId_uploadId: { ...key, uploadId: id } } });
      mark('readStateMs');
      if (receipt) return receipt.checksum === requestChecksum ? receiptResponse(receipt, state?.revision || 0)
        : { error: 'Upload ID already used for different save data.' };
      if (referenced) {
        const expanded = await expandReferences(tx, key, fileSnapshot);
        if (expanded.error) return expanded;
        copy = canonical(expanded.snapshot);
      }
      if (incremental) {
        // A patch is meaningful only against the exact acknowledged revision.
        // Reject before writing anything; the client retains its complete copy
        // and can use the normal alternate-preservation path instead.
        if (alternate || revision !== (state?.revision || 0)) return {
          error: 'Server saves changed; retry with the complete snapshot.', code: 'SAVE_BASE_CHANGED',
        };
        const baseline = state ? await readCurrent(tx, state) : { version: 1, files: [] };
        const files = new Map(baseline.files.map(file => [file.path, file]));
        for (const path of delta.deleted) files.delete(path);
        for (const file of delta.files) files.set(file.path, file);
        copy = canonical({ version: 1, files: [...files.values()] });
      }
      if (encoded) {
        const validationError = snapshotValidationError(copy);
        if (validationError) {
          request.log.warn({ saveValidation: { ...validationError, files: copy.files.length,
            decodedBytes: copy.files.reduce((sum, file) => sum + Buffer.byteLength(file.data, 'base64'), 0),
            maxBytes: MAX_SNAPSHOT_BYTES } }, 'Save upload rejected after delta expansion');
          return { error: validationError.message, code: validationError.code === 'SAVE_SNAPSHOT_TOO_LARGE' ? validationError.code : 'SAVE_INVALID_RESULT', status: 400 };
        }
        payload = JSON.stringify(copy); checksum = digest(payload);
        prepared = prepareFiles(copy); incomingSlots = saveChecksum(copy);
        mark(referenced ? 'expandReferencesMs' : 'expandDeltaMs');
      }
      const stored = state ? JSON.parse(state.payload) : { version: 1, files: [] };
      // Compact manifests let us compare slots without reading tens of MB of
      // unchanged file bytes back out of SQLite on every upload.
      const previous = stored.storage === 'blobs'
        ? { files: stored.files.map(file => ({ path: file.path, data: file.hash })) } : canonical(stored);
      // Import an old acknowledged request when upgrading from the earlier bridge.
      if (!encoded && state?.uploadId === id && (stored.storage === 'blobs' ? state.checksum : digest(JSON.stringify(previous))) === checksum) {
        const imported = await tx.saveUploadReceipt.create({ data: { ...key, uploadId: id, checksum,
          revision: state.revision, disposition: 'current', saveChecksum: incomingSlots } });
        return receiptResponse(imported, state.revision);
      }
      const serverSlots = stored.storage === 'blobs' ? stored.saveChecksum : saveChecksum(previous);
      const divergent = Boolean(state && (alternate || (revision !== state.revision &&
        baseSaveChecksum !== serverSlots && incomingSlots !== serverSlots)));
      const kind = saveKind(previous, stored.storage === 'blobs'
        ? { files: prepared.map(file => ({ path: file.path, data: file.hash })) } : copy);
      mark('compareMs');
      // Existing saves are archived lazily before their first replacement.
      let currentVersionId = state?.currentVersionId || null;
      if (state && (kind || divergent || !currentVersionId)) currentVersionId = await ensureCurrentVersion(tx, state);
      mark('ensureHistoryMs');
      const nextRevision = divergent ? revision : (state?.revision || 0) + 1;
      const continuation = divergent ? branchId || id : null;
      let versionId = null;
      if (kind || divergent || !state) {
        versionId = await archive(tx, copy, { ...key, gameTitle: request.saveGameTitle,
          kind: kind || 'checkpoint', alternate: Boolean(divergent), branchId: continuation, baseRevision: revision,
          revision: nextRevision, deviceLabel }, prepared);
      }
      mark('archiveMs');
      if (!divergent) {
        if (versionId) currentVersionId = versionId;
        const data = { payload, checksum, uploadId: id, gameTitle: request.saveGameTitle, revision: nextRevision, currentVersionId };
        await writeCurrent(tx, key, copy, data, prepared);
      }
      mark('writeCurrentMs');
      const accepted = await tx.saveUploadReceipt.create({ data: { ...key, uploadId: id, checksum: requestChecksum,
        revision: nextRevision, disposition: divergent ? 'alternate' : 'current', versionId, branchId: continuation,
        saveChecksum: incomingSlots } });
      mark('receiptMs');
      if (versionId) await prune(tx, key, currentVersionId);
      mark('pruneMs');
      return receiptResponse(accepted, divergent ? state?.revision || 0 : nextRevision);
    });
    mark('commitMs');
    const totalMs = Math.round((performance.now() - startedAt) * 10) / 10;
    if (totalMs >= 500) request.log.info({ saveTiming: { totalMs, ...timings,
      files: copy?.files.length, snapshotBytes: payload ? Buffer.byteLength(payload) : 0,
      incremental, referenced, uploadBytes: encoded ? Buffer.byteLength(referencePayload || deltaPayload) : Buffer.byteLength(payload),
    } }, 'Slow save upload');
    return result.error ? reply.code(result.status || 409).send({ message: result.error, code: result.code }) : result;
  });

  const historyOptions = { ...options, schema: { ...options.schema, querystring: { type: 'object', properties: {
    offset: { type: 'integer', minimum: 0, maximum: 2147483647, default: 0 },
  } } } };
  fastify.get('/games/:gameId/saves/history', historyOptions, async request => {
    const key = { userId: request.user.userId, gameId: request.params.gameId };
    return writeTransaction(fastify.prisma, async tx => {
      const state = await tx.saveSyncState.findUnique({ where: { userId_gameId: key } });
      const currentVersionId = await ensureCurrentVersion(tx, state);
      await prune(tx, key, currentVersionId);
      const versions = await tx.saveVersion.findMany({ where: key, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: request.query.offset, take: 51, select: { id: true, kind: true, alternate: true, baseRevision: true,
          revision: true, deviceLabel: true, createdAt: true, byteSize: true, restoredFrom: true } });
      const runtime = await tx.saveRuntimeDirectory.findUnique({ where: { userId_gameId: key } });
      const identity = await tx.saveGameIdentity.findUnique({ where: { userId_gameId: key } });
      const game = await tx.game.findUnique({ where: { id: key.gameId }, select: { webSaveDirectory: true, builtAt: true } });
      // Persistent data exists before the first slot is saved. The engine's sync
      // subdirectory is a mirror, not a separate import destination.
      const saveFolders = [...new Set((state ? JSON.parse(state.payload).files : [])
        .filter(file => file.path.endsWith('.save') || file.path.endsWith('/persistent'))
        .map(file => file.path.split('/').slice(0, -1).join('/'))
        .filter(folder => folder && folder.split('/')[0] !== 'tokens'))];
      const candidates = saveFolders.filter(folder => !saveFolders.includes(folder.replace(/\/sync$/, '')) || !folder.endsWith('/sync'));
      const snapshotDirectory = candidates.length === 1 && (!game?.builtAt || state.updatedAt >= game.builtAt) ? candidates[0] : null;
      return { currentRevision: state?.revision || 0, currentVersionId,
        saveFolders: candidates.sort(), saveDirectory: runtime?.directory || game?.webSaveDirectory || identity?.saveDirectory || snapshotDirectory,
        saveDirectorySource: runtime ? 'runtime' : game?.webSaveDirectory ? 'build' : identity?.saveDirectory ? 'backup' : snapshotDirectory ? 'snapshot' : null,
        versions: versions.slice(0, 50), nextOffset: versions.length > 50 ? request.query.offset + 50 : null };
    });
  });
  fastify.post('/games/:gameId/saves/history/import', options, async (request, reply) => {
    const { revision, uploadId, snapshot } = request.body || {};
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= 2147483647 ||
        typeof uploadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uploadId) || !validateSnapshot(snapshot) ||
        !snapshot.files.some(file => file.path.endsWith('.save')) || snapshot.files.some(file => file.path.includes(':') ||
          (!file.path.endsWith('.save') && file.path.split('/').at(-1) !== 'persistent' && file.path !== 'tokens/security_keys.txt'))) {
      return reply.code(400).send({ message: 'Select valid Ren’Py save files, persistent data, and optional signing keys (up to 128 MiB).' });
    }
    const key = { userId: request.user.userId, gameId: request.params.gameId };
    const marker = digest(`import:${JSON.stringify(canonical(snapshot))}`);
    const result = await writeTransaction(fastify.prisma, async tx => {
      const state = await tx.saveSyncState.findUnique({ where: { userId_gameId: key } });
      const receipt = await tx.saveUploadReceipt.findUnique({ where: { userId_gameId_uploadId: { ...key, uploadId } } });
      if (receipt) return receipt.checksum === marker ? receiptResponse(receipt, state?.revision || 0) : { error: 'Upload ID already used for different save data.' };
      if (revision !== (state?.revision || 0)) return { error: 'Synced saves changed. Refresh history and review the import again.' };
      const runtime = await tx.saveRuntimeDirectory.findUnique({ where: { userId_gameId: key } });
      const identity = await tx.saveGameIdentity.findUnique({ where: { userId_gameId: key } });
      const game = await tx.game.findUnique({ where: { id: key.gameId }, select: { webSaveDirectory: true } });
      const destination = runtime?.directory || game?.webSaveDirectory || identity?.saveDirectory;
      if (destination && snapshot.files.some(file => file.path !== 'tokens/security_keys.txt' &&
          file.path.split('/').slice(0, -1).join('/') !== destination)) {
        return { error: 'The game’s save directory changed. Refresh history and review the import destination.', status: 409 };
      }
      const copy = canonical(snapshot);
      // Keep existing signing keys if the user selected just the game folder.
      // An explicitly imported key file takes precedence.
      if (state && !copy.files.some(file => file.path === 'tokens/security_keys.txt')) {
        const previous = await readCurrent(tx, state);
        copy.files.push(...previous.files.filter(file => file.path === 'tokens/security_keys.txt'));
      }
      if (!validateSnapshot(copy)) return { error: 'The imported snapshot exceeds the save limits.', status: 400 };
      if (state) await ensureCurrentVersion(tx, state, true);
      const nextRevision = revision + 1;
      const versionId = await archive(tx, copy, { ...key, gameTitle: request.saveGameTitle, kind: 'imported',
        baseRevision: revision, revision: nextRevision, deviceLabel: 'Imported in launcher' });
      await writeCurrent(tx, key, copy, { checksum: digest(JSON.stringify(canonical(copy))), uploadId,
        revision: nextRevision, currentVersionId: versionId, gameTitle: request.saveGameTitle });
      const accepted = await tx.saveUploadReceipt.create({ data: { ...key, uploadId, checksum: marker,
        revision: nextRevision, disposition: 'current', versionId, saveChecksum: saveChecksum(copy) } });
      await prune(tx, key, versionId);
      return receiptResponse(accepted, nextRevision);
    });
    return result.error ? reply.code(result.status || 409).send({ message: result.error }) : result;
  });
  const versionOptions = { ...options, schema: { params: { ...options.schema.params,
    required: ['gameId', 'versionId'], properties: { ...options.schema.params.properties,
      versionId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
    } } } };
  fastify.get('/games/:gameId/saves/history/:versionId', versionOptions, async (request, reply) => {
    const key = { userId: request.user.userId, gameId: request.params.gameId };
    const copy = await readVersion(fastify.prisma, request.params.versionId, key);
    if (!copy) return reply.code(404).send({ message: 'Save version not found' });
    return { version: 1, ...key, gameTitle: copy.version.gameTitle, createdAt: copy.version.createdAt,
      snapshot: copy.snapshot };
  });
  fastify.post('/games/:gameId/saves/history/:versionId/restore', { ...versionOptions, schema: { ...versionOptions.schema,
    body: { type: 'object', required: ['revision', 'uploadId'], properties: {
      revision: { type: 'integer', minimum: 0, maximum: 2147483646 },
      uploadId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
    } } },
  }, async (request, reply) => {
    const key = { userId: request.user.userId, gameId: request.params.gameId };
    const result = await writeTransaction(fastify.prisma, async tx => {
      const state = await tx.saveSyncState.findUnique({ where: { userId_gameId: key } });
      const id = request.body.uploadId, marker = digest(`restore:${request.params.versionId}`);
      const receipt = await tx.saveUploadReceipt.findUnique({ where: { userId_gameId_uploadId: { ...key, uploadId: id } } });
      if (receipt) return receipt.checksum === marker ? receiptResponse(receipt, state?.revision || 0) : { error: 'Upload ID already used' };
      if ((state?.revision || 0) !== request.body.revision) return { error: 'Synced saves changed. Refresh history before restoring.' };
      const selected = await readVersion(tx, request.params.versionId, key);
      if (!selected) return { missing: true };
      if (state) await ensureCurrentVersion(tx, state, true);
      const revision = (state?.revision || 0) + 1;
      const versionId = await archive(tx, selected.snapshot, { ...key, gameTitle: request.saveGameTitle,
        kind: 'restored', baseRevision: state?.revision || 0, revision, deviceLabel: 'Restored in launcher',
        restoredFrom: selected.version.id });
      const payload = JSON.stringify(canonical(selected.snapshot));
      const data = { payload, checksum: digest(payload), revision, uploadId: id,
        currentVersionId: versionId, gameTitle: request.saveGameTitle };
      await writeCurrent(tx, key, selected.snapshot, data);
      if (selected.version.alternate) await tx.saveVersion.updateMany({ where: { ...key,
        ...(selected.version.branchId ? { branchId: selected.version.branchId } : { id: selected.version.id }),
      }, data: { alternate: false } });
      const accepted = await tx.saveUploadReceipt.create({ data: { ...key, uploadId: id, checksum: marker,
        revision, disposition: 'current', versionId, saveChecksum: saveChecksum(selected.snapshot) } });
      await prune(tx, key, versionId);
      return receiptResponse(accepted, revision);
    });
    if (result.missing) return reply.code(404).send({ message: 'Save version not found' });
    return result.error ? reply.code(409).send({ message: result.error }) : result;
  });
  fastify.delete('/games/:gameId/saves/history/:versionId', versionOptions, async (request, reply) => {
    const key = { userId: request.user.userId, gameId: request.params.gameId };
    const result = await writeTransaction(fastify.prisma, async tx => {
      const state = await tx.saveSyncState.findUnique({ where: { userId_gameId: key } });
      if (state?.currentVersionId === request.params.versionId) return { error: 'The current save version cannot be deleted.' };
      const deleted = await tx.saveVersion.deleteMany({ where: { ...key, id: request.params.versionId } });
      if (deleted.count) await collectBlobs(tx);
      return { deleted: Boolean(deleted.count) };
    });
    if (result.error) return reply.code(409).send({ message: result.error });
    if (!result.deleted) return reply.code(404).send({ message: 'Save version not found' });
    return result;
  });

  // Each admin operation checks the authoritative database role as well as auth.
  const admin = { preHandler: async (request, reply) => {
    if (!request.user?.userId) return reply.code(401).send({ message: 'Authentication required' });
    const user = await fastify.prisma.user.findUnique({ where: { id: request.user.userId }, select: { role: true } });
    if (user?.role !== 'admin') return reply.code(403).send({ message: 'Administrator role required' });
    reply.header('Cache-Control', 'no-store');
  } };
  fastify.get('/admin/orphaned-saves', {
    ...admin, schema: { querystring: { type: 'object', properties: { offset: { type: 'integer', minimum: 0, maximum: 2147483647, default: 0 } } } },
  }, async request => {
    const rows = await fastify.prisma.$queryRaw`
      SELECT s.userId, s.gameId, s.gameTitle, s.revision, s.updatedAt, u.username,
             CASE WHEN json_extract(s.payload, '$.storage') = 'blobs'
               THEN json_extract(s.payload, '$.byteSize') ELSE length(s.payload) END AS storedBytes
      FROM SaveSyncState s JOIN User u ON u.id = s.userId
      WHERE NOT EXISTS (SELECT 1 FROM Game g WHERE g.id = s.gameId)
      ORDER BY s.updatedAt DESC, s.userId, s.gameId LIMIT 51 OFFSET ${request.query.offset}`;
    return { items: rows.slice(0, 50).map(row => ({ ...row, storedBytes: Number(row.storedBytes) })),
      nextOffset: rows.length > 50 ? request.query.offset + 50 : null };
  });
  const orphanOptions = { ...admin, schema: { params: { type: 'object', required: ['userId', 'gameId'], properties: {
    userId: { type: 'string', minLength: 1, maxLength: 128 },
    gameId: options.schema.params.properties.gameId,
  } } } };
  fastify.get('/admin/orphaned-saves/:userId/:gameId', orphanOptions, async (request, reply) => {
    return writeTransaction(fastify.prisma, async tx => {
      const { userId, gameId } = request.params;
      const rows = await tx.$queryRaw`
        SELECT s.* FROM SaveSyncState s WHERE s.userId = ${userId} AND s.gameId = ${gameId}
        AND NOT EXISTS (SELECT 1 FROM Game g WHERE g.id = s.gameId)`;
      if (!rows.length) return reply.code(404).send({ message: 'Orphaned saves not found. The game may have returned.' });
      const state = rows[0];
      return { version: 1, userId, gameId, gameTitle: state.gameTitle, revision: state.revision,
        snapshot: await readCurrent(tx, state) };
    });
  });
  fastify.delete('/admin/orphaned-saves/:userId/:gameId', {
    ...orphanOptions, schema: { ...orphanOptions.schema, body: { type: 'object', required: ['revision'], properties: {
      revision: { type: 'integer', minimum: 1, maximum: 2147483647 },
    } } },
  }, async (request, reply) => {
    const { userId, gameId } = request.params;
    // One atomic statement prevents a stale dialog from purging a returned game.
    const count = await writeTransaction(fastify.prisma, async tx => {
      const removed = await tx.$executeRaw`
      DELETE FROM SaveSyncState WHERE userId = ${userId} AND gameId = ${gameId}
      AND revision = ${request.body.revision}
      AND NOT EXISTS (SELECT 1 FROM Game g WHERE g.id = SaveSyncState.gameId)`;
      if (removed) {
        await tx.saveVersion.deleteMany({ where: { userId, gameId } });
        await tx.saveUploadReceipt.deleteMany({ where: { userId, gameId } });
        await collectBlobs(tx);
      }
      return removed;
    });
    if (count !== 1) return reply.code(409).send({ message: 'Saves changed or the game returned. Refresh the list.' });
    return { deleted: true };
  });
}

function receiptResponse(receipt, serverRevision) {
  return { revision: receipt.revision, serverRevision, checksum: receipt.checksum,
    disposition: receipt.disposition, versionId: receipt.versionId, branchId: receipt.branchId, saveChecksum: receipt.saveChecksum };
}
