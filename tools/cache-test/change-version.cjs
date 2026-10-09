// Test-only build-version mutation, restricted to the seeded local game/database.
const { PrismaClient } = require('/app/node_modules/@prisma/client');
if (process.env.VNM_ADMIN_USER !== 'cache-test' || process.env.DATABASE_URL !== 'file:/data/vnm.db') throw new Error('Not the isolated test API');
const id = process.argv[2];
if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid test game');
const prisma = new PrismaClient();
(async () => {
  const game = await prisma.game.findUnique({ where: { id } });
  if (game.webBuildPath !== '/web-builds/cache-test') throw new Error('Not the seeded test game');
  const before = game.builtAt.toISOString();
  const builtAt = process.argv[3] ? new Date(process.argv[3]) : new Date(game.builtAt.getTime() + 1000);
  await prisma.game.update({ where: { id }, data: { builtAt } });
  console.log(JSON.stringify({ before, after: builtAt.toISOString() }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
