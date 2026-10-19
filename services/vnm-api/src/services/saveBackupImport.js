import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import {
  digest,
  ensureCurrentVersion,
  writeTransaction,
} from './saveHistory.js';
import { safeId, validateBackup } from './saveBackupFormat.js';
const fingerprint = (name) => digest(name).slice(0, 32);
export async function backupPreview(prisma, manifest, actor, choices = {}) {
  validateBackup(manifest);
  const allUsers = choices.allUsers === true;
  if (allUsers && actor.role !== 'admin')
    throw new Error('Only administrators can restore multiple accounts.');
  const users = await prisma.user.findMany({
    where: allUsers ? {} : { id: actor.userId },
    select: { id: true, username: true },
  });
  const games = await prisma.game.findMany({
    select: {
      id: true,
      directoryName: true,
      extractedTitle: true,
      webSaveDirectory: true,
    },
  });
  const sourceAccount =
    choices.sourceAccount ||
    (manifest.accounts.length === 1
      ? manifest.accounts[0].key
      : manifest.accounts.find((row) => row.username === actor.username)?.key);
  if (!allUsers && !manifest.accounts.some((row) => row.key === sourceAccount))
    throw new Error('Choose which account to import from this backup.');
  const accounts = manifest.accounts
    .filter((row) => allUsers || row.key === sourceAccount)
    .map((source) => {
      const selected = choices.accounts?.[source.key];
      if (selected === 'skip')
        return { source: source.key, username: source.username, skip: true };
      if (!allUsers)
        return {
          source: source.key,
          username: source.username,
          target: actor.userId,
          targetUsername: actor.username,
        };
      const target =
        selected && selected !== 'create'
          ? users.find((user) => user.id === selected)
          : users.find((user) => user.username === source.username);
      if (selected && !['create', 'skip'].includes(selected) && !target)
        throw new Error('A selected account no longer exists.');
      if (target)
        return {
          source: source.key,
          username: source.username,
          target: target.id,
          targetUsername: target.username,
        };
      if (!/^[A-Za-z0-9_]{3,32}$/.test(source.username))
        throw new Error(
          'Map this backup account to an existing user: ' + source.username
        );
      return {
        source: source.key,
        username: source.username,
        target: null,
        targetUsername: source.username,
        create: true,
      };
    });
  const targets = accounts
    .filter((row) => !row.skip)
    .map((row) => row.target || 'create:' + row.targetUsername);
  if (new Set(targets).size !== targets.length)
    throw new Error('Map each backup account to a different destination user.');
  if (
    choices.onlyGameId &&
    !games.some((game) => game.id === choices.onlyGameId)
  )
    throw new Error('Destination game not found.');
  const rows = [];
  for (const entry of manifest.games) {
    const account = accounts.find(
      (row) => row.source === entry.account && !row.skip
    );
    if (!account) continue;
    if (
      choices.onlyGameId &&
      entry.game.id !== choices.onlyGameId &&
      manifest.scope !== 'legacy'
    )
      continue;
    const selected =
      choices.onlyGameId && manifest.scope === 'legacy'
        ? choices.onlyGameId
        : choices.games?.[entry.game.id];
    if (selected === 'skip') continue;
    if (manifest.scope === 'legacy' && (!selected || selected === 'orphan'))
      throw new Error(
        'Choose the destination game for this older save snapshot.'
      );
    // Identity is derived from the directory name. A title match is never enough.
    const original = games.find(
      (game) =>
        game.id === entry.game.id &&
        (!entry.game.directoryName ||
          game.directoryName === entry.game.directoryName)
    );
    const named =
      entry.game.directoryName &&
      games.find(
        (game) =>
          game.directoryName === entry.game.directoryName &&
          game.id === fingerprint(entry.game.directoryName)
      );
    const target =
      selected && selected !== 'orphan'
        ? games.find((game) => game.id === selected)
        : selected === 'orphan'
          ? null
          : original || named;
    if (selected && !['orphan', 'skip'].includes(selected) && !target)
      throw new Error('A selected game no longer exists.');
    if (!target && games.some((game) => game.id === entry.game.id))
      throw new Error(
        'The backup game identity conflicts with an installed game. Choose its destination explicitly.'
      );
    const gameId = target?.id || entry.game.id;
    if (!safeId(gameId)) throw new Error('Invalid backup game identity.');
    const state =
      account.target &&
      (await prisma.saveSyncState.findUnique({
        where: { userId_gameId: { userId: account.target, gameId } },
        select: { revision: true },
      }));
    rows.push({
      sourceAccount: entry.account,
      sourceGameId: entry.game.id,
      gameId,
      title: target?.extractedTitle || entry.game.title,
      installed: Boolean(target),
      directoryName: target?.directoryName || entry.game.directoryName,
      saveDirectory: target?.webSaveDirectory || entry.saveDirectory,
      originalDirectory: entry.saveDirectory,
      expectedRevision: state?.revision || 0,
      versions: entry.versions.length,
      files: entry.current?.files.length || 0,
      action: state
        ? choices.replace === true
          ? 'replace'
          : 'keep'
        : entry.current
          ? 'restore'
          : 'history',
      remapDirectory: Boolean(
        target?.webSaveDirectory &&
          entry.saveDirectory &&
          target.webSaveDirectory !== entry.saveDirectory
      ),
    });
  }
  if (choices.onlyGameId && !rows.length)
    throw new Error(
      'This backup belongs to a different game. Use Dashboard > Save backups to review game mappings.'
    );
  const keys = rows.map((row) =>
    JSON.stringify([row.sourceAccount, row.gameId])
  );
  if (keys.length !== new Set(keys).size)
    throw new Error(
      'Two backup games cannot be restored into the same destination.'
    );
  return {
    id: randomUUID(),
    allUsers,
    replace: choices.replace === true,
    accounts,
    rows,
    games,
    users,
    summary: {
      games: rows.length,
      orphaned: rows.filter((row) => !row.installed).length,
      versions: rows.reduce((sum, row) => sum + row.versions, 0),
      replacements: rows.filter((row) => row.action === 'replace').length,
    },
  };
}
function mappedFiles(files, row) {
  if (!row.remapDirectory) return files;
  const prefix = row.originalDirectory + '/';
  const mapped = files.map((file) => ({
    ...file,
    path: file.path.startsWith(prefix)
      ? row.saveDirectory + '/' + file.path.slice(prefix.length)
      : file.path,
  }));
  if (new Set(mapped.map((file) => file.path)).size !== mapped.length)
    throw new Error('Save directory mapping creates duplicate paths.');
  return mapped;
}
async function checksums(files, directory) {
  const copy = createHash('sha256'),
    slots = createHash('sha256');
  copy.update('{"version":1,"files":[');
  slots.update('[');
  let count = 0,
    slotCount = 0;
  for (const file of [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )) {
    const bytes = await readFile(join(directory, 'blobs', file.hash));
    if (bytes.length !== file.size || digest(bytes) !== file.hash)
      throw new Error('A staged backup file failed verification.');
    const data = bytes.toString('base64');
    copy.update(
      (count++ ? ',' : '') +
        JSON.stringify({ path: file.path, mtime: file.mtime, data })
    );
    if (file.path.endsWith('.save'))
      slots.update(
        (slotCount++ ? ',' : '') + JSON.stringify([file.path, data])
      );
  }
  copy.update(']}');
  slots.update(']');
  return { checksum: copy.digest('hex'), saveChecksum: slots.digest('hex') };
}
async function storeBlobs(tx, files, directory) {
  const unique = new Map(files.map((file) => [file.hash, file]));
  for (const file of unique.values()) {
    if (
      await tx.saveFileBlob.findUnique({
        where: { hash: file.hash },
        select: { hash: true },
      })
    )
      continue;
    const data = await readFile(join(directory, 'blobs', file.hash));
    if (data.length !== file.size || digest(data) !== file.hash)
      throw new Error('A staged backup file failed verification.');
    await tx.saveFileBlob.create({
      data: { hash: file.hash, size: file.size, data },
    });
  }
}
async function versionFiles(tx, files, directory, key, details, sums, source) {
  const previous = await tx.saveVersion.findFirst({
    where: { ...key, restoredFrom: source },
    select: { id: true },
  });
  if (previous) return { id: previous.id, added: false };
  await storeBlobs(tx, files, directory);
  const id = randomUUID();
  await tx.saveVersion.create({
    data: {
      id,
      ...key,
      ...details,
      ...sums,
      restoredFrom: source,
      byteSize: files.reduce((sum, file) => sum + file.size, 0),
    },
  });
  for (let start = 0; start < files.length; start += 100)
    await tx.saveVersionFile.createMany({
      data: files
        .slice(start, start + 100)
        .map(({ size, ...file }) => ({ ...file, versionId: id })),
    });
  return { id, added: true };
}
export async function importBackup(
  prisma,
  manifest,
  plan,
  directory,
  onProgress = () => {}
) {
  validateBackup(manifest);
  const result = {
    games: 0,
    historyImported: 0,
    restored: 0,
    kept: 0,
    orphaned: 0,
    usersCreated: [],
    conflicts: [],
  };
  const accountMap = new Map();
  for (const account of plan.accounts.filter(
    (row) =>
      !row.skip && plan.rows.some((game) => game.sourceAccount === row.source)
  )) {
    if (account.create) {
      const existing = await prisma.user.findUnique({
        where: { username: account.targetUsername },
        select: { id: true },
      });
      if (existing)
        throw new Error(
          'An account was created since preview. Review the import again.'
        );
      const passwordHash = await bcrypt.hash(randomUUID() + randomUUID(), 12);
      const user = await prisma.user.create({
        data: {
          username: account.targetUsername,
          passwordHash,
          role: 'viewer',
        },
        select: { id: true },
      });
      accountMap.set(account.source, user.id);
      result.usersCreated.push(account.targetUsername);
    } else {
      if (
        !(await prisma.user.findUnique({
          where: { id: account.target },
          select: { id: true },
        }))
      )
        throw new Error(
          'A destination account was removed. Review the import again.'
        );
      accountMap.set(account.source, account.target);
    }
  }
  for (const row of plan.rows) {
    const entry = manifest.games.find(
      (entry) =>
        entry.account === row.sourceAccount &&
        entry.game.id === row.sourceGameId
    );
    const key = {
      userId: accountMap.get(row.sourceAccount),
      gameId: row.gameId,
    };
    try {
      let baseRevision =
        (
          await prisma.saveSyncState.findUnique({
            where: { userId_gameId: key },
            select: { revision: true },
          })
        )?.revision || 0;
      for (const version of entry.versions) {
        const files = mappedFiles(version.files, row),
          sums = await checksums(files, directory);
        const source =
          'backup:' +
          digest(
            JSON.stringify([
              entry.account,
              entry.game.id,
              version.key,
              version.createdAt,
              sums.checksum,
            ])
          );
        const stored = await writeTransaction(prisma, (tx) =>
          versionFiles(
            tx,
            files,
            directory,
            key,
            {
              gameTitle: row.title,
              kind: version.kind,
              alternate: version.alternate,
              branchId: version.branchId,
              baseRevision,
              revision: baseRevision,
              deviceLabel: version.deviceLabel,
              createdAt: new Date(version.createdAt),
            },
            sums,
            source
          )
        );
        if (stored.added) result.historyImported++;
      }
      if (entry.current) {
        const files = mappedFiles(entry.current.files, row),
          sums = await checksums(files, directory);
        const outcome = await writeTransaction(prisma, async (tx) => {
          const game = await tx.game.findUnique({
            where: { id: key.gameId },
            select: { id: true, directoryName: true, webSaveDirectory: true },
          });
          if (
            Boolean(game) !== row.installed ||
            (game && game.directoryName !== row.directoryName)
          )
            throw new Error(
              'The game library changed. Review this game again.'
            );
          const state = await tx.saveSyncState.findUnique({
            where: { userId_gameId: key },
          });
          // An imported current snapshot is retained even when existing progress wins.
          const source =
            'backup-current:' +
            digest(
              JSON.stringify([
                entry.account,
                entry.game.id,
                entry.current.updatedAt,
                sums.checksum,
              ])
            );
          const stored = await versionFiles(
            tx,
            files,
            directory,
            key,
            {
              gameTitle: row.title,
              kind: 'imported',
              alternate: false,
              branchId: null,
              baseRevision: state?.revision || 0,
              revision: state?.revision || 0,
              deviceLabel: 'Imported VNoctis backup',
              createdAt: new Date(entry.current.updatedAt),
            },
            sums,
            source
          );
          const same = state?.checksum === sums.checksum;
          const changed = (state?.revision || 0) !== row.expectedRevision;
          const replace = !same && !changed && (!state || plan.replace);
          if (replace) {
            if (state) await ensureCurrentVersion(tx, state, true);
            const revision = (state?.revision || 0) + 1;
            const payload = JSON.stringify({
              version: 1,
              storage: 'blobs',
              saveChecksum: sums.saveChecksum,
              byteSize: files.reduce((sum, file) => sum + file.size, 0),
              files,
            });
            await tx.saveSyncState.upsert({
              where: { userId_gameId: key },
              create: {
                ...key,
                gameTitle: row.title,
                payload,
                checksum: sums.checksum,
                revision,
                currentVersionId: stored.id,
              },
              update: {
                gameTitle: row.title,
                payload,
                checksum: sums.checksum,
                revision,
                currentVersionId: stored.id,
                uploadId: null,
              },
            });
            await tx.saveCurrentFile.deleteMany({ where: key });
            for (let start = 0; start < files.length; start += 100)
              await tx.saveCurrentFile.createMany({
                data: files
                  .slice(start, start + 100)
                  .map(({ size, ...file }) => ({ ...key, ...file })),
              });
            if (game && row.saveDirectory)
              await tx.saveRuntimeDirectory.upsert({
                where: { userId_gameId: key },
                create: { ...key, directory: row.saveDirectory },
                update: { directory: row.saveDirectory },
              });
          }
          await tx.saveGameIdentity.upsert({
            where: { userId_gameId: key },
            create: {
              ...key,
              directoryName: row.directoryName,
              gameTitle: row.title,
              saveDirectory: row.saveDirectory,
            },
            update: {
              directoryName: row.directoryName,
              gameTitle: row.title,
              saveDirectory: row.saveDirectory,
            },
          });
          return { replace, same, changed, added: stored.added };
        });
        if (outcome.added) result.historyImported++;
        if (outcome.replace) result.restored++;
        else result.kept++;
        if (outcome.changed && !outcome.same)
          result.conflicts.push({
            title: row.title,
            message:
              'Current progress changed after preview and was kept. Backup versions remain in history.',
          });
      }
      if (!entry.current)
        await prisma.saveGameIdentity.upsert({
          where: { userId_gameId: key },
          create: {
            ...key,
            directoryName: row.directoryName,
            gameTitle: row.title,
            saveDirectory: row.saveDirectory,
          },
          update: {
            directoryName: row.directoryName,
            gameTitle: row.title,
            saveDirectory: row.saveDirectory,
          },
        });
      result.games++;
      if (!row.installed) result.orphaned++;
      onProgress({
        stage: 'Importing saves',
        gamesDone: result.games,
        gamesTotal: plan.rows.length,
        result,
      });
    } catch (error) {
      result.conflicts.push({ title: row.title, message: error.message });
      onProgress({
        stage: 'Importing saves',
        gamesDone: result.games,
        gamesTotal: plan.rows.length,
        result,
      });
    }
  }
  return result;
}
