import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  mkdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { PrismaClient } from '@prisma/client';
import backups from '../src/routes/saveBackups.js';
import saves from '../src/routes/saves.js';
import {
  archive,
  writeCurrent,
  writeTransaction,
  readCurrent,
  digest,
} from '../src/services/saveHistory.js';
import { inspectBackup } from '../src/services/saveBackupWorker.js';
import yazl from 'yazl';
const id = (name) => digest(name).slice(0, 32);
const copy = (value) => ({
  version: 1,
  files: [
    {
      path: 'Runtime/1-LT1.save',
      mtime: 1234,
      data: Buffer.from(value).toString('base64'),
    },
    {
      path: 'Runtime/persistent',
      mtime: 1234,
      data: Buffer.from('preferences').toString('base64'),
    },
    {
      path: 'tokens/security_keys.txt',
      mtime: 1234,
      data: Buffer.from('keys').toString('base64'),
    },
  ],
});
async function fixture(directory, label, users) {
  const prisma = new PrismaClient({
    datasourceUrl:
      'file:' + join(directory, label + '.db').replaceAll('\\', '/'),
  });
  const migrations = new URL('../prisma/migrations/', import.meta.url);
  for (const name of (await readdir(migrations))
    .filter((name) => name !== 'migration_lock.toml')
    .sort())
    for (const sql of (
      await readFile(new URL(name + '/migration.sql', migrations), 'utf8')
    )
      .split(';')
      .filter((sql) => sql.trim()))
      await prisma.$executeRawUnsafe(sql);
  for (const user of users)
    await prisma.user.create({ data: { ...user, passwordHash: 'test-only' } });
  const app = Fastify();
  app.decorate('prisma', prisma);
  await app.register(multipart);
  app.addHook('onRequest', async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.headers.authorization || 'anonymous' },
      select: { id: true, username: true, role: true },
    });
    if (user)
      request.user = {
        userId: user.id,
        username: user.username,
        role: user.role,
      };
  });
  await app.register(backups, {
    prefix: '/api/v1',
    backupPath: join(directory, label + '-tasks'),
  });
  await app.register(saves, { prefix: '/api/v1' });
  await app.ready();
  const call = (method, path, payload, user = users[0].id) =>
    app.inject({
      method,
      url: '/api/v1' + path,
      headers: { authorization: user },
      payload,
    });
  return { app, prisma, call };
}
async function game(prisma, name) {
  await prisma.$executeRawUnsafe(
    'INSERT INTO Game (id,directoryPath,directoryName,extractedTitle,webSaveDirectory,updatedAt) VALUES (?,?,?,?,?,?)',
    id(name),
    '/games/' + name,
    name,
    name,
    'Runtime',
    new Date()
  );
}
async function seed(prisma, userId, name, value) {
  const key = { userId, gameId: id(name) },
    snapshot = copy(value);
  await writeTransaction(prisma, async (tx) => {
    const currentVersionId = await archive(tx, snapshot, {
      ...key,
      gameTitle: name,
      kind: 'manual',
      alternate: false,
      baseRevision: 0,
      revision: 1,
      deviceLabel: 'Test native save',
    });
    await writeCurrent(tx, key, snapshot, {
      gameTitle: name,
      revision: 1,
      currentVersionId,
      checksum: digest(JSON.stringify(snapshot)),
    });
  });
}
async function wait(f, id, status, user) {
  for (let n = 0; n < 400; n++) {
    const reply = await f.call(
      'GET',
      '/save-backups/jobs/' + id,
      undefined,
      user
    );
    assert.equal(reply.statusCode, 200, reply.body);
    const job = reply.json();
    if (job.status === status) return job;
    if (['failed', 'interrupted'].includes(job.status)) assert.fail(job.error);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Backup task timed out');
}
async function upload(f, zip, allUsers = true) {
  const boundary = 'vnm-test-boundary';
  const payload = Buffer.concat([
    Buffer.from(
      '--' +
        boundary +
        '\r\nContent-Disposition: form-data; name="backup"; filename="test.zip"\r\nContent-Type: application/zip\r\n\r\n'
    ),
    zip,
    Buffer.from('\r\n--' + boundary + '--\r\n'),
  ]);
  const reply = await f.app.inject({
    method: 'POST',
    url: '/api/v1/save-backups/imports' + (allUsers ? '?allUsers=1' : ''),
    headers: {
      authorization: 'new-admin',
      'content-type': 'multipart/form-data; boundary=' + boundary,
    },
    payload,
  });
  assert.equal(reply.statusCode, 202, reply.body);
  await wait(f, reply.json().id, 'review');
  return reply.json().id;
}

test('portable backups restore all accounts before games, preserve missing games and round-trip exact save bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vnm-save-backup-'));
  let source, target;
  try {
    source = await fixture(directory, 'source', [
      { id: 'A', username: 'alice', role: 'admin' },
      { id: 'B', username: 'bob', role: 'viewer' },
    ]);
    target = await fixture(directory, 'target', [
      { id: 'new-admin', username: 'admin', role: 'admin' },
    ]);
    for (const name of ['One', 'Two', 'NeverInstalled'])
      await game(source.prisma, name);
    for (const name of ['One', 'Two', 'NeverInstalled'])
      await seed(source.prisma, 'A', name, 'alice-' + name);
    await seed(source.prisma, 'B', 'One', 'bob-private');
    const started = await source.call('POST', '/save-backups/exports', {
      allUsers: true,
    });
    assert.equal(started.statusCode, 202, started.body);
    const job = await wait(source, started.json().id, 'ready');
    assert.equal(job.summary.games, 4);
    assert.equal(
      job.summary.files,
      6,
      'shared persistent/keys are stored once'
    );
    let archiveBytes;
    await t.test(
      'owner/admin authorization and one-use native downloads',
      async () => {
        assert.equal(
          (
            await source.call(
              'POST',
              '/save-backups/exports',
              { allUsers: true },
              'B'
            )
          ).statusCode,
          403
        );
        assert.equal(
          (
            await source.call(
              'GET',
              '/save-backups/jobs/' + job.id,
              undefined,
              'B'
            )
          ).statusCode,
          404
        );
        const ticket = (
          await source.call(
            'POST',
            '/save-backups/jobs/' + job.id + '/download',
            {}
          )
        ).json();
        const download = await source.app.inject({
          method: 'GET',
          url: ticket.url,
        });
        assert.equal(download.statusCode, 200);
        archiveBytes = download.rawPayload;
        assert.equal(
          (await source.app.inject({ method: 'GET', url: ticket.url }))
            .statusCode,
          404
        );
      }
    );
    const imported = await upload(target, archiveBytes);
    let plan;
    await t.test(
      'preview changes nothing and maps missing accounts without importing passwords or roles',
      async () => {
        const reply = await target.call(
          'POST',
          '/save-backups/jobs/' + imported + '/preview',
          {}
        );
        assert.equal(reply.statusCode, 200, reply.body);
        plan = reply.json();
        assert.equal(plan.summary.orphaned, 4);
        assert.ok(plan.accounts.every((row) => row.create));
        assert.equal(await target.prisma.saveSyncState.count(), 0);
        assert.equal(await target.prisma.user.count(), 1);
      }
    );
    const applying = await Promise.all(
      [1, 2].map(() =>
        target.call('POST', '/save-backups/jobs/' + imported + '/apply', {
          planId: plan.id,
        })
      )
    );
    assert.ok(applying.every((reply) => [200, 202].includes(reply.statusCode)));
    const result = await wait(target, imported, 'done');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      (await target.call('GET', '/save-backups/jobs/' + imported)).json()
        .status,
      'done',
      'duplicate Apply requests never rerun the import'
    );
    assert.equal(result.result.restored, 4);
    const alice = await target.prisma.user.findUnique({
        where: { username: 'alice' },
      }),
      bob = await target.prisma.user.findUnique({ where: { username: 'bob' } });
    await t.test(
      'new user IDs own the correct private saves; all missing games retain identity',
      async () => {
        assert.notEqual(alice.id, 'A');
        assert.equal(alice.role, 'viewer');
        assert.equal(bob.role, 'viewer');
        for (const [user, value] of [
          [alice, 'alice-One'],
          [bob, 'bob-private'],
        ]) {
          const state = await target.prisma.saveSyncState.findUnique({
            where: { userId_gameId: { userId: user.id, gameId: id('One') } },
          });
          assert.equal(
            (await readCurrent(target.prisma, state)).files[0].data,
            copy(value).files[0].data
          );
        }
        assert.equal(await target.prisma.saveGameIdentity.count(), 4);
        assert.equal(await target.prisma.game.count(), 0);
      }
    );
    await t.test(
      'installing games later reconnects saves; never-installed saves survive another export',
      async () => {
        await game(target.prisma, 'One');
        let response = await target.call(
          'GET',
          `/games/${id('One')}/saves?manifest=1`,
          undefined,
          alice.id
        );
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().saveDirectory, 'Runtime');
        await game(target.prisma, 'Two');
        response = await target.call(
          'GET',
          `/games/${id('Two')}/saves`,
          undefined,
          alice.id
        );
        assert.equal(response.statusCode, 200);
        assert.equal(
          response.json().snapshot.files[0].data,
          copy('alice-Two').files[0].data
        );
        const state = await target.prisma.saveSyncState.findUnique({
          where: {
            userId_gameId: { userId: alice.id, gameId: id('NeverInstalled') },
          },
        });
        assert.ok(state);
        const exported = await target.call('POST', '/save-backups/exports', {
          allUsers: true,
        });
        const complete = await wait(target, exported.json().id, 'ready');
        assert.equal(complete.summary.games, 4);
      }
    );
    await t.test(
      'changed progress is protected and explicit replacement archives the previous current save',
      async () => {
        const imported = await upload(target, archiveBytes);
        const preview = (
          await target.call(
            'POST',
            '/save-backups/jobs/' + imported + '/preview',
            { replace: true }
          )
        ).json();
        const saved = await target.call(
          'PUT',
          `/games/${id('One')}/saves`,
          {
            revision: 1,
            uploadId: 'newer-progress',
            snapshot: copy('newer-alice'),
          },
          alice.id
        );
        assert.equal(saved.statusCode, 200, saved.body);
        await target.call('POST', '/save-backups/jobs/' + imported + '/apply', {
          planId: preview.id,
        });
        const finished = await wait(target, imported, 'done');
        assert.equal(finished.result.conflicts.length, 1);
        let state = await target.prisma.saveSyncState.findUnique({
          where: { userId_gameId: { userId: alice.id, gameId: id('One') } },
        });
        assert.equal(
          (await readCurrent(target.prisma, state)).files[0].data,
          copy('newer-alice').files[0].data
        );
        const again = await upload(target, archiveBytes);
        const reviewed = (
          await target.call(
            'POST',
            '/save-backups/jobs/' + again + '/preview',
            { replace: true }
          )
        ).json();
        await target.call('POST', '/save-backups/jobs/' + again + '/apply', {
          planId: reviewed.id,
        });
        await wait(target, again, 'done');
        state = await target.prisma.saveSyncState.findUnique({
          where: { userId_gameId: { userId: alice.id, gameId: id('One') } },
        });
        assert.equal(
          (await readCurrent(target.prisma, state)).files[0].data,
          copy('alice-One').files[0].data
        );
        assert.equal(state.revision, 3);
      }
    );
    await t.test(
      'reimport deduplicates history and preserves current progress unless replacement is chosen',
      async () => {
        const before = await target.prisma.saveVersion.count();
        const second = await upload(target, archiveBytes);
        const preview = (
          await target.call(
            'POST',
            '/save-backups/jobs/' + second + '/preview',
            {}
          )
        ).json();
        assert.ok(preview.rows.every((row) => row.action === 'keep'));
        await target.call('POST', '/save-backups/jobs/' + second + '/apply', {
          planId: preview.id,
        });
        await wait(target, second, 'done');
        assert.equal(await target.prisma.saveVersion.count(), before);
      }
    );
    await t.test(
      'personal exports isolate users and snapshot backups reimport into the signed-in account',
      async () => {
        const reply = await source.call(
          'POST',
          '/save-backups/exports',
          {},
          'B'
        );
        const personal = await wait(source, reply.json().id, 'ready', 'B');
        assert.equal(personal.summary.games, 1);
        const version = await source.prisma.saveVersion.findFirst({
          where: { userId: 'B', gameId: id('One') },
        });
        const started = await source.call(
          'POST',
          '/save-backups/exports',
          { gameId: id('One'), versionId: version.id },
          'B'
        );
        const complete = await wait(source, started.json().id, 'ready', 'B');
        const ticket = (
          await source.call(
            'POST',
            '/save-backups/jobs/' + complete.id + '/download',
            {},
            'B'
          )
        ).json();
        const download = await source.app.inject({
          method: 'GET',
          url: ticket.url,
        });
        const imported = await upload(target, download.rawPayload, false);
        const wrong = await target.call(
          'POST',
          '/save-backups/jobs/' + imported + '/preview',
          { onlyGameId: id('Two') }
        );
        assert.equal(wrong.statusCode, 400);
        assert.match(wrong.json().message, /different game/);
        const preview = (
          await target.call(
            'POST',
            '/save-backups/jobs/' + imported + '/preview',
            { onlyGameId: id('One'), accounts: { B: alice.id }, allUsers: true }
          )
        ).json();
        assert.equal(
          preview.accounts[0].target,
          'new-admin',
          'personal scope ignores arbitrary account mappings and privilege flags'
        );
        assert.deepEqual(
          preview.users.map((user) => user.id),
          ['new-admin']
        );
        await target.call('POST', '/save-backups/jobs/' + imported + '/apply', {
          planId: preview.id,
        });
        await wait(target, imported, 'done');
        const state = await target.prisma.saveSyncState.findUnique({
          where: { userId_gameId: { userId: 'new-admin', gameId: id('One') } },
        });
        assert.equal(
          (await readCurrent(target.prisma, state)).files[0].data,
          copy('bob-private').files[0].data
        );
        const forbidden = await source.call(
          'POST',
          '/save-backups/exports',
          { gameId: id('One'), versionId: version.id },
          'A'
        );
        const missing = forbidden.json().id;
        for (let n = 0; n < 100; n++) {
          const job = (
            await source.call('GET', '/save-backups/jobs/' + missing)
          ).json();
          if (job.status === 'failed') {
            assert.match(job.error, /not found/);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (n === 99) assert.fail('Cross-user snapshot export did not fail');
        }
      }
    );
    await t.test(
      'old raw snapshot ZIPs require a destination and preserve exact bytes',
      async () => {
        const zip = new yazl.ZipFile();
        zip.addBuffer(Buffer.from('legacy-native'), 'Runtime/1-LT1.save');
        zip.addBuffer(Buffer.from('signing-keys'), 'tokens/security_keys.txt');
        const chunks = [];
        const ready = (async () => {
          for await (const chunk of zip.outputStream) chunks.push(chunk);
          return Buffer.concat(chunks);
        })();
        zip.end();
        const imported = await upload(target, await ready, false);
        const unmapped = await target.call(
          'POST',
          '/save-backups/jobs/' + imported + '/preview',
          {}
        );
        assert.equal(
          unmapped.statusCode,
          400,
          'legacy ZIPs cannot become anonymous orphan records'
        );
        const preview = (
          await target.call(
            'POST',
            '/save-backups/jobs/' + imported + '/preview',
            { onlyGameId: id('Two') }
          )
        ).json();
        assert.equal(preview.rows[0].gameId, id('Two'));
        await target.call('POST', '/save-backups/jobs/' + imported + '/apply', {
          planId: preview.id,
        });
        await wait(target, imported, 'done');
        const state = await target.prisma.saveSyncState.findUnique({
          where: { userId_gameId: { userId: 'new-admin', gameId: id('Two') } },
        });
        assert.equal(
          Buffer.from(
            (await readCurrent(target.prisma, state)).files[0].data,
            'base64'
          ).toString(),
          'legacy-native'
        );
      }
    );
    await t.test(
      'history-only missing games retain identity across migrations',
      async () => {
        await game(source.prisma, 'HistoryOnly');
        await seed(source.prisma, 'A', 'HistoryOnly', 'historical-only');
        await source.prisma.saveSyncState.delete({
          where: { userId_gameId: { userId: 'A', gameId: id('HistoryOnly') } },
        });
        const started = await source.call('POST', '/save-backups/exports', {});
        const ready = await wait(source, started.json().id, 'ready');
        const ticket = (
          await source.call(
            'POST',
            '/save-backups/jobs/' + ready.id + '/download',
            {}
          )
        ).json();
        const download = await source.app.inject({
          method: 'GET',
          url: ticket.url,
        });
        const imported = await upload(target, download.rawPayload, false);
        const skip = Object.fromEntries(
          ['One', 'Two', 'NeverInstalled'].map((name) => [id(name), 'skip'])
        );
        const preview = (
          await target.call(
            'POST',
            '/save-backups/jobs/' + imported + '/preview',
            { games: skip }
          )
        ).json();
        assert.equal(preview.rows.length, 1);
        assert.equal(preview.rows[0].action, 'history');
        await target.call('POST', '/save-backups/jobs/' + imported + '/apply', {
          planId: preview.id,
        });
        const done = await wait(target, imported, 'done');
        assert.equal(done.result.orphaned, 1);
        const key = { userId: 'new-admin', gameId: id('HistoryOnly') };
        assert.equal(
          (
            await target.prisma.saveGameIdentity.findUnique({
              where: { userId_gameId: key },
            })
          ).directoryName,
          'HistoryOnly'
        );
        assert.equal(
          await target.prisma.saveSyncState.findUnique({
            where: { userId_gameId: key },
          }),
          null
        );
      }
    );
    await t.test(
      'completed tasks and import review survive restart; interrupted tasks stop safely',
      async () => {
        const exported = await target.call('POST', '/save-backups/exports', {});
        const ready = await wait(target, exported.json().id, 'ready');
        const imported = await upload(target, archiveBytes, false);
        const preview = (
          await target.call(
            'POST',
            '/save-backups/jobs/' + imported + '/preview',
            { sourceAccount: 'A' }
          )
        ).json();
        const interrupted = join(directory, 'target-tasks', 'interrupted-test');
        await mkdir(interrupted);
        await writeFile(
          join(interrupted, 'job.json'),
          JSON.stringify({
            id: 'interrupted-test',
            ownerId: 'new-admin',
            scope: 'account',
            kind: 'export',
            status: 'working',
            createdAt: new Date().toISOString(),
          })
        );
        await target.app.close();
        const app = Fastify();
        app.decorate('prisma', target.prisma);
        await app.register(multipart);
        app.addHook('onRequest', async (request) => {
          request.user = {
            userId: 'new-admin',
            username: 'admin',
            role: 'admin',
          };
        });
        await app.register(backups, {
          prefix: '/api/v1',
          backupPath: join(directory, 'target-tasks'),
        });
        await app.ready();
        target.app = app;
        target.call = (method, path, payload) =>
          app.inject({ method, url: '/api/v1' + path, payload });
        assert.equal(
          (await target.call('GET', '/save-backups/jobs/' + ready.id)).json()
            .status,
          'ready'
        );
        assert.equal(
          (
            await target.call('GET', '/save-backups/jobs/interrupted-test')
          ).json().status,
          'interrupted'
        );
        assert.equal(
          (
            await target.call(
              'POST',
              '/save-backups/jobs/' + imported + '/apply',
              { planId: preview.id }
            )
          ).statusCode,
          202
        );
        await wait(target, imported, 'done');
      }
    );
  } finally {
    await source?.app.close();
    await target?.app.close();
    await source?.prisma.$disconnect();
    await target?.prisma.$disconnect();
    assert.ok(directory.startsWith(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

async function zipBytes(entries) {
  const zip = new yazl.ZipFile(),
    chunks = [];
  const reading = (async () => {
    for await (const chunk of zip.outputStream) chunks.push(chunk);
    return Buffer.concat(chunks);
  })();
  for (const [name, bytes, options] of entries)
    zip.addBuffer(Buffer.from(bytes), name, options);
  zip.end();
  return reading;
}
test('backup verification rejects corruption and unsafe archives without touching a database', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vnm-backup-invalid-'));
  const data = Buffer.from('original-save'),
    hash = digest(data),
    time = new Date().toISOString();
  const manifest = {
    format: 'vnoctis-save-backup',
    version: 1,
    createdAt: time,
    scope: 'snapshot',
    accounts: [{ key: 'user', username: 'alice' }],
    games: [
      {
        account: 'user',
        game: { id: id('One'), title: 'One', directoryName: 'One' },
        saveDirectory: 'Runtime',
        current: {
          updatedAt: time,
          files: [
            { path: 'Runtime/1.save', mtime: 1, hash, size: data.length },
          ],
        },
        versions: [],
      },
    ],
    blobs: [{ hash, size: data.length }],
  };
  async function inspect(name, entries, mutate) {
    const directory = join(root, name);
    await mkdir(directory);
    let bytes = await zipBytes(entries);
    if (mutate) bytes = mutate(bytes);
    await writeFile(join(directory, 'upload.zip'), bytes);
    return inspectBackup({ directory });
  }
  const entries = [
    ['vnoctis-save-backup.json', JSON.stringify(manifest)],
    ['blobs/' + hash, data],
  ];
  try {
    await t.test('valid package passes byte verification', async () => {
      assert.equal((await inspect('valid', entries)).summary.files, 1);
    });
    await t.test('changed blob bytes are rejected', async () => {
      await assert.rejects(
        inspect('hash', [
          entries[0],
          ['blobs/' + hash, Buffer.alloc(data.length, 1)],
        ]),
        /verification/
      );
    });
    await t.test('missing blobs are rejected', async () => {
      await assert.rejects(inspect('missing', [entries[0]]), /missing/);
    });
    await t.test('duplicate ZIP entries are rejected', async () => {
      await assert.rejects(
        inspect('duplicate', [...entries, entries[0]]),
        /duplicate/
      );
    });
    await t.test('undeclared files are rejected', async () => {
      await assert.rejects(
        inspect('extra', [...entries, ['unexpected.txt', 'unexpected']]),
        /Unexpected/
      );
    });
    await t.test('symlinks are rejected', async () => {
      await assert.rejects(
        inspect('symlink', [
          [entries[0][0], entries[0][1], { mode: 0o120777 }],
          entries[1],
        ]),
        /unsafe/
      );
    });
    await t.test('parent path traversal is rejected', async () => {
      await assert.rejects(
        inspect('traversal', [['ab/c.save', data]], (bytes) =>
          Buffer.from(
            bytes.toString('latin1').replaceAll('ab/c.save', '../c.save'),
            'latin1'
          )
        ),
        /invalid|unsafe|relative/i
      );
    });
    await t.test(
      'snapshot limit is enforced before blobs are expanded',
      async () => {
        const bad = structuredClone(manifest);
        bad.blobs[0].size = bad.games[0].current.files[0].size =
          128 * 1024 * 1024 + 1;
        await assert.rejects(
          inspect('limit', [
            ['vnoctis-save-backup.json', JSON.stringify(bad)],
            entries[1],
          ]),
          /Invalid/
        );
      }
    );
    await t.test('unknown format versions are rejected', async () => {
      await assert.rejects(
        inspect('version', [
          [
            'vnoctis-save-backup.json',
            JSON.stringify({ ...manifest, version: 2 }),
          ],
          entries[1],
        ]),
        /unsupported/
      );
    });
  } finally {
    assert.ok(root.startsWith(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
