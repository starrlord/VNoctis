// Portable, opaque save data. No Python/pickle code is executed during backup.
export const BACKUP_FORMAT = 'vnoctis-save-backup';
export const MANIFEST_NAME = 'vnoctis-save-backup.json';
export const BACKUP_LIMITS = {
  archive: 16 * 1024 ** 3,
  manifest: 32 * 1024 ** 2,
  snapshot: 128 * 1024 ** 2,
  entries: 200000,
  games: 10000,
  versions: 50000,
  files: 4096,
};
export const safeId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const safePath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\\:\x00-\x1f]/.test(value) &&
  !value.split('/').some((part) => !part || part === '.' || part === '..');
const text = (value, max = 512) =>
  typeof value === 'string' && value.length <= max;
const date = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
export function validateBackup(manifest) {
  const fail = () => {
    throw new Error('Invalid or unsupported VNoctis save backup.');
  };
  if (
    manifest?.format !== BACKUP_FORMAT ||
    manifest.version !== 1 ||
    !date(manifest.createdAt) ||
    !Array.isArray(manifest.accounts) ||
    !manifest.accounts.length ||
    manifest.accounts.length > 10000 ||
    !Array.isArray(manifest.games) ||
    manifest.games.length > BACKUP_LIMITS.games ||
    !Array.isArray(manifest.blobs) ||
    manifest.blobs.length > BACKUP_LIMITS.entries
  )
    fail();
  const accounts = new Set(),
    blobs = new Map(),
    used = new Set(),
    games = new Set();
  let bytes = 0,
    versions = 0;
  for (const account of manifest.accounts) {
    if (
      !safeId(account.key) ||
      accounts.has(account.key) ||
      !text(account.username, 128)
    )
      fail();
    accounts.add(account.key);
  }
  for (const blob of manifest.blobs) {
    if (
      !/^[a-f0-9]{64}$/.test(blob.hash) ||
      blobs.has(blob.hash) ||
      !Number.isSafeInteger(blob.size) ||
      blob.size < 0 ||
      blob.size > BACKUP_LIMITS.snapshot
    )
      fail();
    blobs.set(blob.hash, blob.size);
    bytes += blob.size;
    if (bytes > BACKUP_LIMITS.archive) fail();
  }
  function files(rows) {
    if (!Array.isArray(rows) || rows.length > BACKUP_LIMITS.files) fail();
    const paths = new Set();
    let total = 0;
    for (const file of rows) {
      if (
        !safePath(file.path) ||
        paths.has(file.path) ||
        !Number.isSafeInteger(file.mtime) ||
        file.mtime < 0 ||
        file.mtime > 8640000000000000 ||
        !blobs.has(file.hash) ||
        file.size !== blobs.get(file.hash)
      )
        fail();
      total += file.size;
      paths.add(file.path);
      used.add(file.hash);
      if (total > BACKUP_LIMITS.snapshot) fail();
    }
    for (const path of paths) {
      const parts = path.split('/');
      while (parts.length > 1) {
        parts.pop();
        if (paths.has(parts.join('/'))) fail();
      }
    }
  }
  for (const entry of manifest.games) {
    const key = JSON.stringify([entry.account, entry.game?.id]);
    if (
      !accounts.has(entry.account) ||
      !safeId(entry.game?.id) ||
      !text(entry.game.title) ||
      !(entry.game.directoryName === null || text(entry.game.directoryName)) ||
      games.has(key) ||
      !(
        entry.saveDirectory === null ||
        (safePath(entry.saveDirectory) &&
          entry.saveDirectory !== 'tokens' &&
          !entry.saveDirectory.startsWith('tokens/'))
      ) ||
      !Array.isArray(entry.versions)
    )
      fail();
    games.add(key);
    if (entry.current !== null) {
      if (!entry.current || !date(entry.current.updatedAt)) fail();
      files(entry.current.files);
    }
    const keys = new Set();
    for (const version of entry.versions) {
      if (
        ++versions > BACKUP_LIMITS.versions ||
        !safeId(version.key) ||
        keys.has(version.key) ||
        !['auto', 'manual', 'checkpoint', 'restored', 'imported'].includes(
          version.kind
        ) ||
        typeof version.alternate !== 'boolean' ||
        !date(version.createdAt) ||
        !text(version.deviceLabel, 200) ||
        !(version.branchId === null || safeId(version.branchId))
      )
        fail();
      keys.add(version.key);
      files(version.files);
    }
  }
  if (used.size !== blobs.size) fail();
  return { games: manifest.games.length, versions, files: blobs.size, bytes };
}
