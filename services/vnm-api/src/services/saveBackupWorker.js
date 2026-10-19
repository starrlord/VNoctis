import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, writeFile, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import yazl from 'yazl';
import yauzl from 'yauzl';
import {
  BACKUP_FORMAT,
  BACKUP_LIMITS,
  MANIFEST_NAME,
  safePath,
  validateBackup,
} from './saveBackupFormat.js';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const progress = (value) => parentPort?.postMessage({ progress: value });
const iso = (value) => new Date(value).toISOString();
const README =
  'VNoctis save backup\n\nUse VNoctis Save History > Import backup for a single-game snapshot, or Dashboard > Save backups > Import backup for a library backup.\nKeep this ZIP intact; do not extract it before importing.\nThis archive is designed for VNoctis backup and migration. Desktop-game compatibility is not guaranteed.\nIt contains private save data, including signing keys.\n';

export async function exportBackup({
  dbPath,
  directory,
  userId,
  allUsers = false,
  gameId = null,
  versionId = null,
}) {
  const snapshotPath = join(directory, 'consistent.db');
  let source, db;
  const inline = new Map(),
    blobs = new Map();
  try {
    source = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
    progress({ stage: 'Capturing saves' });
    if (versionId) {
      source.exec('BEGIN');
      db = source;
      source = null;
    } else {
      await backup(source, snapshotPath, { rate: 100 });
      source.close();
      source = null;
      db = new DatabaseSync(snapshotPath, { readOnly: true });
    }
    const users = db
      .prepare(
        'SELECT id, username FROM User WHERE (? OR id=?) ORDER BY username'
      )
      .all(allUsers ? 1 : 0, userId);
    if (!users.length) throw new Error('Account no longer exists.');
    const manifest = {
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: new Date().toISOString(),
      scope: versionId ? 'snapshot' : allUsers ? 'all-users' : 'account',
      accounts: users.map((user) => ({
        key: user.id,
        username: user.username,
      })),
      games: [],
      blobs: [],
    };
    const blobQuery = db.prepare(
      'SELECT data, size FROM SaveFileBlob WHERE hash=?'
    );
    const blobSize = db.prepare('SELECT size FROM SaveFileBlob WHERE hash=?');
    const legacyDirectory = join(directory, 'legacy');
    mkdirSync(legacyDirectory, { recursive: true, mode: 0o700 });
    const prepare = (rows) =>
      rows.map((row) => {
        let { hash, size } = row;
        if (row.data !== undefined) {
          const bytes = Buffer.from(row.data, 'base64');
          hash = digest(bytes);
          size = bytes.length;
          if (!inline.has(hash)) {
            const filename = join(legacyDirectory, hash);
            writeFileSync(filename, bytes, { mode: 0o600 });
            inline.set(hash, filename);
          }
        }
        if (size === undefined) {
          size = blobs.get(hash) ?? blobSize.get(hash)?.size;
          if (size === undefined) throw new Error('A saved file is missing.');
        }
        blobs.set(hash, size);
        return { path: row.path, mtime: row.mtime, hash, size };
      });
    for (const user of users) {
      const states = db
        .prepare(
          'SELECT gameId,gameTitle,updatedAt FROM SaveSyncState WHERE userId=?'
        )
        .all(user.id);
      const versions = db
        .prepare(
          'SELECT * FROM SaveVersion WHERE userId=? ORDER BY createdAt, id'
        )
        .all(user.id);
      const ids = new Set([
        ...states.map((state) => state.gameId),
        ...versions.map((version) => version.gameId),
      ]);
      if (gameId) {
        ids.clear();
        ids.add(gameId);
      }
      for (const id of ids) {
        const game = db
          .prepare(
            'SELECT id, directoryName, extractedTitle, webSaveDirectory FROM Game WHERE id=?'
          )
          .get(id);
        const state = states.find((row) => row.gameId === id);
        const selected = versions.filter(
          (row) => row.gameId === id && (!versionId || row.id === versionId)
        );
        if (versionId && !selected.length)
          throw new Error('Save version not found.');
        const runtime = db
          .prepare(
            'SELECT directory FROM SaveRuntimeDirectory WHERE userId=? AND gameId=?'
          )
          .get(user.id, id);
        const identity = db
          .prepare('SELECT * FROM SaveGameIdentity WHERE userId=? AND gameId=?')
          .get(user.id, id);
        const entry = {
          account: user.id,
          game: {
            id,
            title:
              game?.extractedTitle ||
              identity?.gameTitle ||
              state?.gameTitle ||
              selected[0]?.gameTitle ||
              id,
            directoryName:
              game?.directoryName || identity?.directoryName || null,
          },
          saveDirectory:
            runtime?.directory ||
            game?.webSaveDirectory ||
            identity?.saveDirectory ||
            null,
          current: null,
          versions: [],
        };
        for (const version of selected) {
          const files = prepare(
            db
              .prepare(
                'SELECT path,mtime,hash FROM SaveVersionFile WHERE versionId=? ORDER BY path'
              )
              .all(version.id)
          );
          const details = {
            key: version.id,
            kind: version.kind,
            alternate: Boolean(version.alternate),
            branchId: version.branchId,
            createdAt: iso(version.createdAt),
            deviceLabel: version.deviceLabel,
            files,
          };
          if (versionId)
            entry.current = { files, updatedAt: details.createdAt };
          entry.versions.push(details);
        }
        if (!versionId && state) {
          const payload = JSON.parse(
            db
              .prepare(
                'SELECT payload FROM SaveSyncState WHERE userId=? AND gameId=?'
              )
              .get(user.id, id).payload
          );
          entry.current = {
            updatedAt: iso(state.updatedAt),
            files: prepare(
              payload.storage === 'blobs'
                ? db
                    .prepare(
                      'SELECT path,mtime,hash FROM SaveCurrentFile WHERE userId=? AND gameId=? ORDER BY path'
                    )
                    .all(user.id, id)
                : payload.files
            ),
          };
        }
        if (entry.current || entry.versions.length) manifest.games.push(entry);
      }
    }
    manifest.blobs = [...blobs].map(([hash, size]) => ({ hash, size }));
    const summary = validateBackup(manifest),
      metadata = Buffer.from(JSON.stringify(manifest));
    if (metadata.length > BACKUP_LIMITS.manifest)
      throw new Error(
        'Backup metadata exceeds the supported size. Export fewer games.'
      );
    const zip = new yazl.ZipFile(),
      output = join(directory, 'backup.zip');
    let archiveBytes = 0;
    const limitArchive = new Transform({
      transform(chunk, _, callback) {
        archiveBytes += chunk.length;
        callback(
          archiveBytes > BACKUP_LIMITS.archive
            ? new Error(
                'Backup exceeds the 16 GiB archive limit. Export individual accounts or snapshots.'
              )
            : null,
          chunk
        );
      },
    });
    const writing = pipeline(
      zip.outputStream,
      limitArchive,
      createWriteStream(output, { flags: 'wx', mode: 0o600 })
    );
    zip.addBuffer(metadata, MANIFEST_NAME);
    zip.addBuffer(Buffer.from(README), 'README.txt');
    let done = 0,
      bytesDone = 0;
    for (const [hash, size] of blobs)
      zip.addReadStreamLazy(
        'blobs/' + hash,
        { compress: false, size },
        (callback) => {
          try {
            if (inline.has(hash)) {
              callback(null, createReadStream(inline.get(hash)));
              return;
            }
            const bytes = Buffer.from(blobQuery.get(hash)?.data || []);
            if (bytes.length !== size || digest(bytes) !== hash)
              throw new Error('A saved file failed verification.');
            progress({
              stage: 'Writing backup',
              filesDone: ++done,
              filesTotal: blobs.size,
              bytesDone: (bytesDone += size),
              bytesTotal: summary.bytes,
            });
            callback(null, Readable.from([bytes]));
          } catch (error) {
            callback(error);
          }
        }
      );
    zip.on('error', (error) => zip.outputStream.destroy(error));
    zip.end();
    await writing;
    return {
      summary,
      gameTitle:
        manifest.games.length === 1 ? manifest.games[0].game.title : null,
    };
  } finally {
    source?.close();
    db?.close();
    await unlink(snapshotPath).catch(() => {});
    await rm(join(directory, 'legacy'), { recursive: true, force: true }).catch(
      () => {}
    );
  }
}

async function consume(zip, entry, { limit, file, expectedHash }) {
  const input = await zip.openReadStreamPromise(entry),
    hash = createHash('sha256');
  let size = 0,
    checksum = 0;
  const chunks = [];
  const check = new Transform({
    transform(chunk, _, callback) {
      size += chunk.length;
      if (size > limit)
        return callback(new Error('Backup entry exceeds its size limit.'));
      hash.update(chunk);
      checksum = crc32(chunk, checksum);
      callback(null, chunk);
    },
  });
  if (file)
    await pipeline(
      input,
      check,
      createWriteStream(file, { flags: 'wx', mode: 0o600 })
    );
  else {
    await pipeline(input, check, async function (stream) {
      for await (const chunk of stream) chunks.push(chunk);
    });
  }
  const actual = hash.digest('hex');
  if (
    size !== entry.uncompressedSize ||
    checksum !== entry.crc32 ||
    (expectedHash && expectedHash !== actual)
  )
    throw new Error('Backup data failed verification.');
  return { bytes: file ? null : Buffer.concat(chunks), hash: actual, size };
}
export async function inspectBackup({ directory }) {
  const filename = join(directory, 'upload.zip');
  const zip = await yauzl.openPromise(filename, {
    autoClose: false,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  try {
    const entries = new Map();
    let total = 0;
    for await (const entry of zip.eachEntry()) {
      if (
        entries.size >= BACKUP_LIMITS.entries + 2 ||
        entries.has(entry.fileName) ||
        entry.generalPurposeBitFlag & 1 ||
        ![0, 8].includes(entry.compressionMethod) ||
        ![0, 0o100000].includes(
          (entry.externalFileAttributes >>> 16) & 0o170000
        ) ||
        !safePath(entry.fileName) ||
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0
      )
        throw new Error(
          'Backup contains duplicate, encrypted, unsupported or unsafe entries.'
        );
      total += entry.uncompressedSize;
      if (total > BACKUP_LIMITS.archive + BACKUP_LIMITS.manifest + 65536)
        throw new Error('Backup is too large.');
      entries.set(entry.fileName, entry);
    }
    let manifest;
    await mkdir(join(directory, 'blobs'), { recursive: true, mode: 0o700 });
    if (entries.has(MANIFEST_NAME)) {
      const metadata = await consume(zip, entries.get(MANIFEST_NAME), {
        limit: BACKUP_LIMITS.manifest,
      });
      manifest = JSON.parse(metadata.bytes.toString('utf8'));
      validateBackup(manifest);
      const expected = new Map(
        manifest.blobs.map((file) => ['blobs/' + file.hash, file])
      );
      for (const [name] of entries)
        if (
          name !== MANIFEST_NAME &&
          name !== 'README.txt' &&
          !expected.has(name)
        )
          throw new Error('Unexpected file in VNoctis backup.');
      if (entries.has('README.txt'))
        await consume(zip, entries.get('README.txt'), { limit: 65536 });
      let done = 0;
      for (const blob of manifest.blobs) {
        const entry = entries.get('blobs/' + blob.hash);
        if (!entry) throw new Error('A backup file is missing.');
        await consume(zip, entry, {
          limit: blob.size,
          expectedHash: blob.hash,
          file: join(directory, 'blobs', blob.hash),
        });
        progress({
          stage: 'Verifying backup',
          filesDone: ++done,
          filesTotal: manifest.blobs.length,
        });
      }
    } else {
      // Older Save History exports were raw save-folder ZIPs. They can still be
      // restored, but the user must explicitly choose the destination game.
      const files = [],
        blobs = new Map();
      let bytes = 0;
      if (entries.size > BACKUP_LIMITS.files)
        throw new Error('Too many files in the save snapshot.');
      for (const entry of entries.values()) {
        const leaf = entry.fileName.split('/').at(-1);
        if (
          !entry.fileName.endsWith('.save') &&
          leaf !== 'persistent' &&
          entry.fileName !== 'tokens/security_keys.txt'
        )
          throw new Error('Choose a VNoctis backup or a save-folder ZIP.');
        if ((bytes += entry.uncompressedSize) > BACKUP_LIMITS.snapshot)
          throw new Error('Save snapshot exceeds 128 MiB.');
        const value = await consume(zip, entry, {
          limit: BACKUP_LIMITS.snapshot,
        });
        if (!blobs.has(value.hash)) {
          blobs.set(value.hash, value.size);
          await writeFile(join(directory, 'blobs', value.hash), value.bytes, {
            mode: 0o600,
          });
        }
        files.push({
          path: entry.fileName,
          mtime: Math.max(0, entry.getLastModDate().getTime()),
          hash: value.hash,
          size: value.size,
        });
      }
      if (!files.some((file) => file.path.endsWith('.save')))
        throw new Error('No save files found.');
      manifest = {
        format: BACKUP_FORMAT,
        version: 1,
        createdAt: new Date().toISOString(),
        scope: 'legacy',
        accounts: [{ key: 'legacy', username: 'Original account' }],
        games: [
          {
            account: 'legacy',
            game: {
              id: 'legacy',
              title: 'Imported save snapshot',
              directoryName: null,
            },
            saveDirectory: null,
            current: { files, updatedAt: new Date().toISOString() },
            versions: [],
          },
        ],
        blobs: [...blobs].map(([hash, size]) => ({ hash, size })),
      };
    }
    const summary = validateBackup(manifest);
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify(manifest),
      { mode: 0o600 }
    );
    return { summary };
  } finally {
    zip.close();
  }
}

if (parentPort) {
  try {
    const result = await (workerData.task === 'export'
      ? exportBackup(workerData)
      : inspectBackup(workerData));
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
}
