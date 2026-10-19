import { prepareFiles } from './saveHistory.js';

// A manifest never reads blob contents. Legacy inline states remain readable
// until the next normal upload migrates them to content-addressed storage.
export async function currentManifest(tx, state) {
  if (!state) return null;
  const stored = JSON.parse(state.payload);
  if (stored.storage !== 'blobs') return { version: 1, files: prepareFiles(stored)
    .map(({ path, mtime, hash, bytes }) => ({ path, mtime, hash, size: bytes.length })) };
  const files = await tx.saveCurrentFile.findMany({
    where: { userId: state.userId, gameId: state.gameId },
    select: { path: true, mtime: true, hash: true, blob: { select: { size: true } } },
    orderBy: { path: 'asc' },
  });
  return { version: 1, files: files.map(({ blob, ...file }) => ({ ...file, size: blob.size })) };
}

export async function currentFile(tx, state, hash) {
  if (!state) return null;
  const stored = JSON.parse(state.payload);
  if (stored.storage !== 'blobs') return prepareFiles(stored).find(file => file.hash === hash)?.bytes ?? null;
  // The association is the authorization boundary: knowing a global hash is
  // insufficient, even when another user/game retains that blob in history.
  const file = await tx.saveCurrentFile.findFirst({
    where: { userId: state.userId, gameId: state.gameId, hash },
    select: { blob: { select: { data: true } } },
  });
  return file ? Buffer.from(file.blob.data) : null;
}
