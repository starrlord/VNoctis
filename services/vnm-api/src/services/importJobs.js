import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, statfs, rename, rmdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scanGamesDirectory, isRenpyProject, hasWebBuildZip } from './scanner.js';
import { extractRpaArchives } from './rpaExtractor.js';
import { runBatchEnrichment } from './enrichment.js';

const execute = promisify(execFile);
export const archiveType = name => ['.tar.bz2', '.zip', '.rar'].find(ext => name.toLowerCase().endsWith(ext));
export const folderName = name => name.replace(/\.\./g, '').replace(/[/\\:*?"<>|\x00-\x1f]/g, '').trim().replace(/^\.+/, '');
export function registerImportJobs(app, gamesPath, maxBytes) {
  async function register(result, context) {
    await context.progress({ stage: 'scanning', result: JSON.stringify(result) });
    await context.log('[scanning] Registering the completed game in the library.');
    await scanGamesDirectory(gamesPath, app.prisma, app.log);
    if (app.vndbClient) {
      await context.log('[scanning] Game registered; metadata refresh scheduled.');
      runBatchEnrichment(app.prisma, app.vndbClient, process.env.COVERS_PATH || '/covers', process.env.SCREENSHOTS_PATH || '/screenshots', app.log)
        .catch(error => app.log.warn({ err: error.message }, 'Post-import metadata refresh failed'));
    }
    await rm(context.directory, { recursive: true, force: true });
    await context.log(`[done] Imported ${result.folderName}. Staged upload removed.`);
    await context.progress({ status: 'done', stage: 'done', completedAt: new Date(), result: JSON.stringify(result) });
  }
  app.jobRunner.register('import', async (job, input, context) => {
    if (input.publishedResult) {
      const result = input.publishedResult;
      if (!result.folderName || result.folderName !== folderName(result.folderName) || result.path !== join(gamesPath, result.folderName)) throw new Error('Invalid published game path.');
      if (!(await stat(result.path)).isDirectory()) throw new Error('The published game folder is missing.');
      await register(result, context); return;
    }
    await mkdir(context.directory, { recursive: true });
    let archive = input.archive;
    const suffix = archiveType(input.name);
    if (!suffix) throw new Error('Unsupported archive format.');
    if (input.url) {
      await context.progress({ stage: 'downloading' });
      await context.log(`[downloading] ${input.name}`);
      const response = await fetch(input.url, { signal: context.signal, redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
      const bytesTotal = Number(response.headers.get('content-length')) || 0;
      if (bytesTotal > maxBytes) { await response.body.cancel(); throw new Error('Download exceeds the import size limit.'); }
      archive = join(context.directory, `archive${suffix}`);
      let bytesDone = 0, lastUpdate = 0;
      const progress = new Transform({ transform(chunk, encoding, callback) {
        bytesDone += chunk.length;
        if (bytesDone > maxBytes) return callback(new Error('Download exceeds the import size limit.'));
        const update = Date.now() - lastUpdate >= 1000;
        if (update) lastUpdate = Date.now();
        if (update) context.progress({ bytesDone: BigInt(bytesDone), bytesTotal: BigInt(bytesTotal) }).then(() => callback(null, chunk), callback);
        else callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(archive), { signal: context.signal });
      await context.progress({ bytesDone: BigInt(bytesDone), bytesTotal: BigInt(bytesTotal || bytesDone) });
    }
    if (!archive || !(await stat(archive)).size) throw new Error('Archive is empty.');
    // Extraction and publication must share a filesystem for an atomic rename.
    const unpack = join(gamesPath, '.vnm-staging', job.id);
    await rm(unpack, { recursive: true, force: true });
    await mkdir(unpack, { recursive: true });
    try {
      await context.progress({ stage: 'inspecting' });
      await context.log('[inspecting] Checking archive paths and file sizes.');
      const inspection = await execute('python3', [fileURLToPath(new URL('./archive_inspect.py', import.meta.url)), archive, suffix.slice(1)], { signal: context.signal, maxBuffer: 1024 * 1024 });
      const info = JSON.parse(inspection.stdout);
      const space = await statfs(gamesPath);
      if (info.bytes > space.bavail * space.bsize) throw new Error('Not enough free space to extract this archive.');
      const folder = folderName(info.singleFolder || basename(input.name).slice(0, -suffix.length));
      if (!folder) throw new Error('Archive has no valid game folder name.');
      await context.progress({ stage: 'extracting' });
      await context.log(`[extracting] ${info.files} entries, ${info.bytes} bytes`);
      const commands = { '.zip': ['unzip', ['-o', archive, '-d', unpack]], '.tar.bz2': ['tar', ['xjf', archive, '-C', unpack]], '.rar': ['7z', ['x', archive, `-o${unpack}`, '-y', '-p-']] };
      const [command, args] = commands[suffix];
      await execute(command, args, { signal: context.signal, maxBuffer: 50 * 1024 * 1024 });
      const extracted = info.singleFolder ? join(unpack, info.singleFolder) : unpack;
      await execute('chmod', ['-R', 'a+rwX', extracted], { signal: context.signal });
      await context.progress({ stage: 'unpacking-rpa' });
      const logger = { info: (data, message) => context.log(`${message} ${data.file || ''}`),
        warn: (data, message) => context.log(`${message}: ${data.err || ''}`) };
      await extractRpaArchives(extracted, logger, { signal: context.signal });
      if (!await isRenpyProject(extracted) && !await hasWebBuildZip(extracted)) throw new Error('The archive does not contain a recognizable Ren’Py game folder.');
      await context.progress({ stage: 'publishing' });
      await execute('chmod', ['-R', 'a+rwX', extracted], { signal: context.signal });
      context.signal.throwIfAborted();
      const target = join(gamesPath, folder);
      // Reserve exclusively; never replace an existing game, including an empty folder.
      await mkdir(target);
      try { await rename(extracted, target); }
      catch (error) { await rmdir(target).catch(() => {}); throw error; }
      const result = { folderName: folder, path: target };
      await register(result, context);
    } finally {
      await rm(unpack, { recursive: true, force: true });
    }
  });
}
