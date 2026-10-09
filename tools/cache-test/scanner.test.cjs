// Run inside the isolated API container: real filesystem and ZIP extraction,
// with a small in-memory record adapter to inspect publication ordering.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

if (process.env.VNM_ADMIN_USER !== 'cache-test') throw new Error('Not the test API');
(async () => {
  const { scanGamesDirectory } = await import('/app/src/services/scanner.js');
  for (const mode of ['valid', 'no-index', 'broken']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnm-cache-scan-'));
    try {
      const directoryName = 'TestGame', games = path.join(root, 'games'), source = path.join(games, directoryName);
      const builds = path.join(root, 'builds'), output = path.join(builds, directoryName);
      fs.mkdirSync(path.join(source, 'game'), { recursive: true }); fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(source, 'game/options.rpy'), 'define config.name = "Test"\n');
      fs.writeFileSync(path.join(output, 'index.html'), 'previous-build');
      const zip = path.join(source, 'test.zip');
      if (mode === 'broken') fs.writeFileSync(zip, 'not a ZIP');
      else execFileSync('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z: z.writestr(sys.argv[2], "replacement-build")', zip, mode === 'valid' ? 'index.html' : 'other.txt']);
      process.env.WEB_BUILDS_PATH = builds;
      let record = { id: createHash('sha256').update(directoryName).digest('hex').slice(0, 32),
        directoryName, directoryPath: source, metadataSource: 'manual', buildStatus: 'stale', builtAt: new Date(0) };
      const statuses = [];
      const prisma = { game: {
        findUnique: async () => ({ ...record }), findMany: async () => [{ ...record }],
        update: async ({ data }) => {
          if (data.buildStatus === 'building') assert.equal(fs.readFileSync(path.join(output, 'index.html'), 'utf8'), 'previous-build', 'block readers before replacing any files');
          if (data.buildStatus) statuses.push(data.buildStatus);
          record = { ...record, ...data }; return record;
        },
      } };
      const result = await scanGamesDirectory(games, prisma, { info() {}, warn() {} });
      assert.deepEqual(statuses, ['building', mode === 'valid' ? 'built' : 'failed']);
      assert.equal(result.imported, mode === 'valid' ? 1 : 0);
      if (mode === 'valid') { assert.equal(fs.readFileSync(path.join(output, 'index.html'), 'utf8'), 'replacement-build'); assert.ok(record.builtAt.getTime() > 0); }
      else assert.equal(record.builtAt.getTime(), 0, 'failed imports do not publish a new build identity');
      console.log(`PASS: ZIP replacement ${mode}`);
    } finally {
      if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + '/vnm-cache-scan-')) throw new Error('Unexpected temporary directory');
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
