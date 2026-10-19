// A logical snapshot lists every desired path. Entries may contain new bytes
// or refer to immutable bytes in one authorized historical baseline. Missing
// browser cache files are therefore never inferred to be deletions.
export function referenceSnapshot(copy) {
  return { version: 1, baseVersionId: copy.baseVersionId,
    files: copy.files.map(file => Object.hasOwn(file, 'data')
      ? { path: file.path, mtime: file.mtime, data: file.data }
      : { path: file.path, mtime: file.mtime, hash: file.hash, size: file.size })
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}

export async function expandReferences(tx, key, copy) {
  const references = copy.files.filter(file => !Object.hasOwn(file, 'data'));
  const blobs = new Map();
  if (references.length) {
    const baseline = await tx.saveVersion.findFirst({ where: { id: copy.baseVersionId, ...key },
      select: { files: { select: { hash: true } } } });
    if (!baseline) return { error: 'The save baseline is no longer available. Browser progress is retained; a complete upload is required.', code: 'SAVE_REFERENCE_BASE_MISSING' };
    const permitted = new Set(baseline.files.map(file => file.hash));
    if (references.some(file => !permitted.has(file.hash))) return {
      error: 'Save reference is not part of this account and game baseline.', code: 'SAVE_INVALID_REFERENCE', status: 400,
    };
    const hashes = [...new Set(references.map(file => file.hash))];
    for (let i = 0; i < hashes.length; i += 100) {
      const rows = await tx.saveFileBlob.findMany({ where: { hash: { in: hashes.slice(i, i + 100) } }, select: { hash: true, data: true, size: true } });
      for (const row of rows) blobs.set(row.hash, row);
    }
    if (references.some(file => blobs.get(file.hash)?.size !== file.size)) return {
      error: 'Save reference size could not be verified.', code: 'SAVE_INVALID_REFERENCE', status: 400,
    };
  }
  return { snapshot: { version: 1, files: copy.files.map(file => ({ path: file.path, mtime: file.mtime,
    data: Object.hasOwn(file, 'data') ? file.data : Buffer.from(blobs.get(file.hash).data).toString('base64') })) } };
}
