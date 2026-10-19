// Exercise the built React player and bridge together, with a filesystem fixture.
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { resolve, extname } = require('node:path');
const assert = require('node:assert/strict');
function zipFiles(bytes) {
  const files = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26);
    const start = offset + 30 + length + bytes.readUInt16LE(offset + 28);
    files.set(bytes.toString('utf8', offset + 30, offset + 30 + length), bytes.subarray(start, start + size));
    offset = start + size;
  }
  assert.ok([0x02014b50, 0x06054b50].includes(bytes.readUInt32LE(offset)));
  return files;
}
const { createHash } = require('node:crypto');

const dist = resolve(__dirname, '../dist');
let state = { revision: 0, snapshot: null };
let directoryKnown = true;
const versions = [], receipts = new Map();
const saveHash = copy => createHash('sha256').update(JSON.stringify((copy?.files || []).filter(file => file.path.endsWith('.save'))
  .map(file => [file.path, file.data]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');
const game = { id: 'X', extractedTitle: 'Fixture', buildStatus: 'built', webBuildPath: '/web-builds/test',
  tags: [], screenshots: [], updatedAt: new Date().toISOString(), directoryName: 'fixture' };
let role = 'viewer';
let orphans = [{ userId: 'B', username: 'player', gameId: 'missing-game', gameTitle: 'Missing Game', revision: 1,
  updatedAt: new Date().toISOString(), storedBytes: 2048 }];
const token = `header.${Buffer.from(JSON.stringify({ userId: 'A' })).toString('base64url')}.signature`;
const fixture = `<!DOCTYPE html><html><head><script src="/save-sync.js"></script></head><body><script>
  const files = new Map(), dirs = new Set(['/home/web_user/.renpy']);
  window.FS = {
    readdir: path => ['.', '..', ...new Set([...dirs, ...files.keys()].filter(p => p.startsWith(path + '/')).map(p => p.slice(path.length + 1).split('/')[0]))],
    stat: path => ({ mode: dirs.has(path) ? 0o40777 : 0o100666, mtime: new Date(1000) }),
    isDir: mode => (mode & 0o170000) === 0o40000,
    isFile: mode => (mode & 0o170000) === 0o100000,
    readFile: path => files.get(path), writeFile: (path, bytes) => { files.set(path, bytes); FS.close({ path, flags: 1 }); },
    close() {}, rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    mkdirTree: path => { const parts = path.split('/'); while(parts.length) { dirs.add(parts.join('/')); parts.pop(); } },
    utime() {}, unlink: path => files.delete(path), rmdir: path => dirs.delete(path),
    syncfs: (populate, callback) => queueMicrotask(() => callback(null))
  };
  window.IDBFS = { getDB: (name, callback) => callback(null, { transaction: () => {
    const tx = { objectStore: () => ({ openCursor: () => {
      const req = { result: null }; queueMicrotask(() => { req.onsuccess(); tx.oncomplete(); }); return req;
    } }) }; return tx;
  } }) };
  Module.FS = FS; Module.preInit.at(-1)();
  FS.syncfs(true, () => document.body.dataset.ready = 'true');
</script></body></html>`;

const backupJobs = new Map();
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  if (url.pathname === '/api/v1/save-backups/exports') {
    let body='';for await(const chunk of request)body+=chunk;const selection=JSON.parse(body);
    const id='backup-'+(backupJobs.size+1);backupJobs.set(id,{id,status:'ready',filename:'vnoctis-backup.zip',snapshot:versions.find(version=>version.id===selection.versionId)?.snapshot});
    return json({id,status:'ready'});
  }
  if(url.pathname.startsWith('/api/v1/save-backups/jobs/')){
    const id=url.pathname.split('/')[5],job=backupJobs.get(id);
    if(url.pathname.endsWith('/download'))return json({url:'/api/v1/save-backups/download/'+id,filename:job.filename});
    return json(job);
  }
  if(url.pathname.startsWith('/api/v1/save-backups/download/')){
    const job=backupJobs.get(url.pathname.split('/').at(-1));
    const {snapshotZip}=await import('../src/utils/saveFiles.js');
    response.setHeader('Content-Type','application/zip');response.setHeader('Content-Disposition','attachment; filename="vnoctis-backup.zip"');
    return response.end(Buffer.from(await snapshotZip(job.snapshot).arrayBuffer()));
  }
  if (url.pathname === '/api/v1/auth/me') return json({ userId: 'A', username: 'test', role });
  if (url.pathname === '/api/v1/users') return json([]);
  if (url.pathname === '/api/v1/admin/orphaned-saves') return json({ items: orphans, nextOffset: null });
  if (url.pathname === '/api/v1/admin/orphaned-saves/B/missing-game') {
    if (request.method === 'DELETE') { orphans = []; return json({ deleted: true }); }
    return json({ version: 1, userId: 'B', gameId: 'missing-game', snapshot: { version: 1, files: [] } });
  }
  if (url.pathname === '/api/v1/health') return json({ r2Mode: false });
  if (url.pathname === '/api/v1/library') return json([game]);
  if (url.pathname === '/api/v1/library/X') return json(game);
  if (url.pathname === '/api/v1/games/X/saves/history') return json({ currentRevision: state.revision,
    currentVersionId: state.currentVersionId, saveFolders: directoryKnown ? ['game'] : [],
    saveDirectory: directoryKnown ? 'game' : null, saveDirectorySource: directoryKnown ? 'build' : null,
    versions: versions.map(({ snapshot, ...metadata }) => metadata), nextOffset: null });
  if (url.pathname === '/api/v1/games/X/saves/history/import') {
    let body = ''; for await (const chunk of request) body += chunk;
    const imported = JSON.parse(body);
    if (imported.revision !== state.revision) { response.statusCode = 409; return json({ message: 'Refresh history' }); }
    state = { revision: state.revision + 1, snapshot: imported.snapshot, currentVersionId: `version-${state.revision + 1}` };
    versions.unshift({ id: state.currentVersionId, snapshot: state.snapshot, kind: 'imported', alternate: false,
      revision: state.revision, deviceLabel: 'Imported in launcher', createdAt: new Date().toISOString(), byteSize: 100 });
    return json({ revision: state.revision });
  }
  const historyMatch = url.pathname.match(/^\/api\/v1\/games\/X\/saves\/history\/([^/]+)(\/restore)?$/);
  if (historyMatch) {
    const version = versions.find(version => version.id === historyMatch[1]);
    if (!version) { response.statusCode = 404; return json({ message: 'Missing version' }); }
    if (historyMatch[2]) {
      let body = ''; for await (const chunk of request) body += chunk;
      const restore = JSON.parse(body);
      if (restore.revision !== state.revision) { response.statusCode = 409; return json({ message: 'Refresh history' }); }
      state = { revision: state.revision + 1, snapshot: version.snapshot, currentVersionId: `version-${state.revision + 1}` };
      versions.unshift({ ...version, id: state.currentVersionId, kind: 'restored', alternate: false, revision: state.revision, createdAt: new Date().toISOString() });
      return json({ revision: state.revision });
    }
    if (request.method === 'DELETE') { versions.splice(versions.indexOf(version), 1); return json({ deleted: true }); }
    return json({ version: 1, gameId: 'X', snapshot: version.snapshot });
  }
  if (url.pathname === '/api/v1/games/X/saves') {
    if (request.method === 'GET') return json({ ...state, deltaUploads: true, saveChecksum: saveHash(state.snapshot), acknowledgement: receipts.get(url.searchParams.get('uploadId')) || null });
    let body = ''; for await (const chunk of request) body += chunk;
    const upload = JSON.parse(body);
    if (upload.delta) {
      if (upload.revision !== state.revision) { response.statusCode = 409; return json({ code: 'SAVE_BASE_CHANGED' }); }
      const files = new Map((state.snapshot?.files || []).map(file => [file.path, file]));
      for (const path of upload.delta.deleted) files.delete(path);
      for (const file of upload.delta.files) files.set(file.path, file);
      upload.snapshot = { version: 1, files: [...files.values()] };
    }
    if (upload.revision !== state.revision) { response.statusCode = 409; return json({}); }
    const changedSlots = saveHash(state.snapshot) !== saveHash(upload.snapshot);
    state = { revision: state.revision + 1, snapshot: upload.snapshot, uploadId: upload.uploadId,
      currentVersionId: changedSlots ? `version-${state.revision + 1}` : state.currentVersionId };
    if (changedSlots) versions.unshift({ id: state.currentVersionId, snapshot: upload.snapshot, kind: 'manual', alternate: false,
      revision: state.revision, deviceLabel: 'Mobile browser', createdAt: new Date().toISOString(), byteSize: 100 });
    const accepted = { revision: state.revision, disposition: 'current', saveChecksum: saveHash(upload.snapshot) };
    receipts.set(upload.uploadId, accepted); return json(accepted);
  }
  if (url.pathname === '/web-builds/test/index.html') {
    response.setHeader('Content-Type', 'text/html'); return response.end(fixture);
  }
  const name = url.pathname.startsWith('/assets/') || url.pathname === '/save-sync.js' ? url.pathname.slice(1) : 'index.html';
  response.setHeader('Content-Type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(name)] || 'application/octet-stream');
  response.end(readFileSync(resolve(dist, name)));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true });
    const context = await browser.newContext({ viewport: { width: 812, height: 375 }, isMobile: true, hasTouch: true });
    await context.addInitScript(token => localStorage.setItem('vnm-token', token), token);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/play/X`);
    const toast = page.getByRole('status', { name: 'Save synchronization' });
    await toast.waitFor({ state: 'visible' });
    const downloadNotice = page.getByRole('status', { name: 'Game download notice' });
    await downloadNotice.waitFor({ state: 'visible' });
    const [saveBox, downloadBox] = await Promise.all([toast.boundingBox(), downloadNotice.boundingBox()]);
    assert.ok(downloadBox.y + downloadBox.height <= saveBox.y, 'download and save notices must not overlap');
    await toast.waitFor({ state: 'hidden', timeout: 10000 });
    const frame = page.frames().find(frame => frame.url().includes('/web-builds/'));
    const write = (name, value) => frame.evaluate(async ({ name, value }) => {
      FS.mkdirTree('/home/web_user/.renpy/game');
      FS.writeFile('/home/web_user/.renpy/game/' + name, new TextEncoder().encode(value));
      await new Promise(resolve => FS.syncfs(false, resolve));
    }, { name, value });
    const waitRevision = async revision => {
      const deadline = Date.now() + 15000;
      while (state.revision < revision && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(state.revision, revision);
    };
    await write('persistent', 'seen text'); await waitRevision(1);
    assert.equal(await toast.count(), 0, 'persistent-only upload must remain quiet');
    await downloadNotice.waitFor({ state: 'hidden', timeout: 10000 });
    await write('1-1-LT1.save', 'numbered save'); await waitRevision(2);
    await toast.waitFor({ state: 'visible', timeout: 2000 });
    assert.match(await toast.innerText(), /Save synced/);
    await toast.waitFor({ state: 'hidden', timeout: 6000 });
    await write('quick-1-LT1.save', 'quick save'); await waitRevision(3);
    await toast.waitFor({ state: 'visible', timeout: 2000 });
    assert.match(await toast.innerText(), /Save synced/);
    await page.getByRole('button', { name: 'Dismiss save sync notice' }).click();
    await toast.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    console.log('PASS: built mobile player shows consecutive save acknowledgements, hides them, and keeps persistent-only sync quiet');
    await page.goto(`http://127.0.0.1:${server.address().port}/admin/users`);
    await page.waitForURL('**/gallery');
    assert.equal(await page.getByRole('button', { name: 'Orphaned saves', exact: true }).count(), 0);
    role = 'admin';
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}/admin/users`);
    await page.getByRole('button', { name: 'Orphaned saves', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Orphaned saves', exact: true });
    await dialog.getByText('Missing Game', { exact: true }).waitFor();
    const downloadEvent = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download snapshot' }).click();
    const download = await downloadEvent;
    assert.ok(download.suggestedFilename().endsWith('.zip'));
    assert.equal(zipFiles(readFileSync(await download.path())).size, 0);
    await page.setViewportSize({ width: 375, height: 812 });
    const bounds = await dialog.locator('div').first().boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 375 && bounds.height <= 812);
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(orphans.length, 1);
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click();
    await dialog.getByText('No orphaned saves.', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    console.log('PASS: admin overlay downloads snapshots, confirms deletion, fits mobile, and is hidden from viewers');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByText('Fixture', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Save history', exact: true }).click();
    const history = page.getByRole('dialog', { name: 'Save history', exact: true });
    await history.getByText('Current', { exact: true }).waitFor();
    const archiveDownload = page.waitForEvent('download');
    await history.getByRole('button', { name: 'Download backup', exact: true }).last().click();
    const archiveFile = await archiveDownload;
    if (process.env.ZIP_PATH) await archiveFile.saveAs(process.env.ZIP_PATH);
    const archive = zipFiles(readFileSync(await archiveFile.path()));
    assert.equal([...archive.keys()].some(path => path.includes('quick-')), false);
    assert.equal(archive.get('game/1-1-LT1.save').toString(), 'numbered save');
    await history.getByRole('button', { name: 'Restore', exact: true }).first().click();
    await history.getByRole('button', { name: 'Restore this version', exact: true }).click();
    await history.getByText('Version restored. Launch the game to use these saves.', { exact: true }).waitFor();
    assert.equal(state.revision, 4);
    assert.equal(state.snapshot.files.some(file => file.path.includes('quick-')), false);
    await page.keyboard.press('Escape'); await history.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: 'Save history', exact: true }).count(), 1, 'closing history keeps its launcher open');
    role = 'viewer';
    await page.goto(`http://127.0.0.1:${server.address().port}/gallery`);
    await page.getByRole('button', { name: 'More Info', exact: true }).click();
    await page.getByRole('button', { name: 'Save history', exact: true }).click();
    await history.getByText('Current', { exact: true }).waitFor();
    await page.setViewportSize({ width: 375, height: 812 });
    const historyBounds = await history.locator('div').first().boundingBox();
    assert.ok(historyBounds.x >= 0 && historyBounds.x + historyBounds.width <= 375 && historyBounds.height <= 812);
    if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
    await history.getByRole('button', { name: 'Restore', exact: true }).first().click();
    await history.getByRole('button', { name: 'Restore this version', exact: true }).click();
    await history.getByText('Version restored. Launch the game to use these saves.', { exact: true }).waitFor();
    await page.setViewportSize({ width: 812, height: 375 });
    await history.getByRole('button', { name: 'Play with restored saves', exact: true }).click();
    await page.waitForURL('**/gallery/play/X');
    await page.waitForFunction(() => document.querySelector('iframe') !== null);
    const restoredFrame = page.frames().find(frame => frame.url().includes('/web-builds/'));
    await restoredFrame.waitForFunction(() => document.body.dataset.ready === 'true');
    assert.deepEqual(await page.evaluate(() => [document.body.style.overflow, document.body.style.position]), ['', '']);
    assert.equal(await restoredFrame.evaluate(() => new TextDecoder().decode(FS.readFile('/home/web_user/.renpy/game/quick-1-LT1.save'))), 'quick save');
    assert.equal(state.revision, 5, 'launching restored progress must not upload an empty browser tree');
    await page.goto(`http://127.0.0.1:${server.address().port}/gallery`);
    await page.getByRole('button', { name: 'More Info', exact: true }).click();
    await page.getByRole('button', { name: 'Save history', exact: true }).click();
    await history.getByText('Current', { exact: true }).waitFor();
    await page.setViewportSize({ width: 375, height: 812 });
    await history.getByLabel('Save files', { exact: true }).setInputFiles([
      { name: '1.save', mimeType: 'application/octet-stream', buffer: Buffer.from('imported desktop save') },
      { name: 'persistent', mimeType: 'application/octet-stream', buffer: Buffer.from('imported preferences') },
      { name: 'log.txt', mimeType: 'text/plain', buffer: Buffer.from('ignored') },
    ]);
    await history.getByRole('button', { name: 'Import and use saves', exact: true }).waitFor();
    assert.equal(await history.getByLabel('Game save directory', { exact: true }).inputValue(), 'game');
    assert.equal(await history.getByLabel('Game save directory', { exact: true }).isDisabled(), true);
    assert.equal(state.revision, 5, 'Selecting files must not change server saves before confirmation');
    if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
    await history.getByRole('button', { name: 'Import and use saves', exact: true }).click();
    await history.getByText('Saves imported. Launch the game to use them.', { exact: true }).waitFor();
    assert.equal(state.revision, 6);
    assert.equal(Buffer.from(state.snapshot.files.find(file => file.path === 'game/1.save').data, 'base64').toString(), 'imported desktop save');
    assert.equal(state.snapshot.files.some(file => file.path.endsWith('log.txt')), false);
    const importDownload = page.waitForEvent('download');
    await history.getByRole('button', { name: 'Download backup', exact: true }).first().click();
    const importedZip = zipFiles(readFileSync(await (await importDownload).path()));
    assert.equal(importedZip.get('game/1.save').toString(), 'imported desktop save');
    directoryKnown = false;
    await history.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-save-history-dialog] button')]
      .some(button => button.textContent === 'Import save folder' && !button.disabled));
    await history.getByLabel('Save files', { exact: true }).setInputFiles([
      { name: 'renamed.save', mimeType: 'application/octet-stream', buffer: Buffer.from('another save') },
    ]);
    const unknown = history.getByLabel('Advanced: enter a verified runtime save directory', { exact: true });
    await unknown.waitFor();
    assert.equal(await unknown.inputValue(), '');
    assert.equal(await history.getByRole('button', { name: 'Import and use saves', exact: true }).isDisabled(), true);
    await history.getByText(/The game’s save directory is not known yet/).waitFor();
    await unknown.fill('VerifiedGame');
    assert.equal(await history.getByRole('button', { name: 'Import and use saves', exact: true }).isEnabled(), true);
    await history.getByRole('button', { name: 'Cancel import', exact: true }).click();
    assert.equal(state.revision, 6, 'An unknown destination never silently imports to a guessed folder');
    assert.deepEqual(errors, []);
    console.log('PASS: both launchers export/restore saves, fit mobile, protect known destinations, and require a verified unknown destination');
  } finally { if (browser) await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
