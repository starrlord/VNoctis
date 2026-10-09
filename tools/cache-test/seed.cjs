// Seed only the disposable test database, using the API's real schema.
const { execFileSync } = require('node:child_process');
const { mkdirSync, existsSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { PrismaClient } = require('/app/node_modules/@prisma/client');

if (process.env.DATABASE_URL !== 'file:/data/vnm.db') throw new Error('Unexpected test database');
execFileSync('/app/node_modules/.bin/prisma', ['migrate', 'deploy'], { cwd: '/app', stdio: 'inherit' });
const directoryName = 'CacheTestGame';
const directoryPath = `/data/games/${directoryName}`;
mkdirSync(`${directoryPath}/game`, { recursive: true });
const options = `${directoryPath}/game/options.rpy`;
if (!existsSync(options)) writeFileSync(options, 'define config.name = "Abnormal (cache test)"\n');
const prisma = new PrismaClient();
(async () => {
  // Upstream's Prisma Game model includes publish fields, but its normal-mode
  // migrations omit them. Add just those nullable/default fields in this test
  // database so the unmodified API can query the model without enabling R2.
  const columns = new Set((await prisma.$queryRawUnsafe('PRAGMA table_info("Game")')).map(column => column.name));
  for (const [name, type] of [['publishStatus', "TEXT NOT NULL DEFAULT 'not_published'"],
    ['publishedAt', 'DATETIME'], ['publishedVersion', 'TEXT']]) {
    if (!columns.has(name)) await prisma.$executeRawUnsafe(`ALTER TABLE "Game" ADD COLUMN "${name}" ${type}`);
  }
  const id = createHash('sha256').update(directoryName).digest('hex').slice(0, 32);
  const data = { directoryName, directoryPath, extractedTitle: 'Abnormal (cache test)',
    buildStatus: 'built', webBuildPath: '/web-builds/cache-test', metadataSource: 'manual',
    metadataFetchedAt: new Date(), builtAt: new Date(Date.now() + 3600000) };
  await prisma.game.upsert({ where: { id }, create: { id, ...data }, update: data });
  console.log(`Cache test game: ${id}`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
