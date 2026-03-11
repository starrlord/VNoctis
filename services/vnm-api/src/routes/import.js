import { createWriteStream } from 'node:fs';
import { rm, mkdir, stat, rename, cp } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scanGamesDirectory } from '../services/scanner.js';
import { runBatchEnrichment } from '../services/enrichment.js';
import { extractRpaArchives, pathExists } from '../services/rpaExtractor.js';

const execFileAsync = promisify(execFile);

// ── Supported archive formats ──────────────────────────
// Order matters — longest suffix first so `.tar.bz2` matches before `.bz2`.
const ARCHIVE_FORMATS = [
  { ext: '.tar.bz2', type: 'tar.bz2' },
  { ext: '.zip', type: 'zip' },
  { ext: '.rar', type: 'rar' },
];

const ACCEPTED_EXTENSIONS = ARCHIVE_FORMATS.map((f) => f.ext);
const ACCEPTED_LABEL = ACCEPTED_EXTENSIONS.join(', ');

/**
 * Detect the archive type from a filename.
 *
 * @param {string} filename
 * @returns {{ ext: string, type: string } | null}
 */
function detectArchiveType(filename) {
  const lower = filename.toLowerCase();
  for (const fmt of ARCHIVE_FORMATS) {
    if (lower.endsWith(fmt.ext)) return fmt;
  }
  return null;
}

/**
 * Strip the archive extension from a filename, handling compound
 * extensions like `.tar.bz2`.
 *
 * @param {string} filename
 * @returns {string}
 */
function stripArchiveExt(filename) {
  const fmt = detectArchiveType(filename);
  if (!fmt) return basename(filename, extname(filename));
  return filename.slice(0, filename.length - fmt.ext.length);
}

/**
 * Extract an archive into the games directory and trigger a scan.
 * Supports ZIP, tar.bz2, and RAR archives.
 *
 * @param {string} tmpPath - Path to the temp archive file.
 * @param {string} originalName - Original filename (used for folder inference).
 * @param {string} gamesPath - The games root directory.
 * @param {import('fastify').FastifyInstance} fastify
 * @param {import('pino').Logger} logger
 * @returns {Promise<{ folderName: string, path: string }>}
 */
async function extractAndScan(tmpPath, originalName, gamesPath, fastify, logger) {
  const archiveType = detectArchiveType(originalName);
  if (!archiveType) {
    throw Object.assign(new Error(`Unsupported archive format. Accepted: ${ACCEPTED_LABEL}`), {
      statusCode: 400,
      code: 'UNSUPPORTED_FORMAT',
    });
  }

  // Determine target folder name
  const singleFolder = await getSingleTopLevelFolder(tmpPath, archiveType.type);
  let folderName;

  if (singleFolder) {
    folderName = sanitiseFolderName(singleFolder);
    logger.info?.({ folderName }, 'Archive has single top-level folder');
  } else {
    folderName = sanitiseFolderName(stripArchiveExt(basename(originalName)));
    logger.info?.({ folderName }, 'Archive has multiple top-level entries, using filename');
  }

  if (!folderName) {
    throw Object.assign(new Error('Could not determine a valid folder name from the archive.'), {
      statusCode: 400,
      code: 'INVALID_FOLDER_NAME',
    });
  }

  const extractedPath = join(gamesPath, folderName);

  // Check for name collision
  if (await pathExists(extractedPath)) {
    throw Object.assign(
      new Error(`A game folder named "${folderName}" already exists. Rename the archive or remove the existing game first.`),
      { statusCode: 409, code: 'FOLDER_EXISTS' }
    );
  }

  // Extract the archive
  await extractArchive(tmpPath, archiveType.type, gamesPath, extractedPath, singleFolder, logger);

  // Verify extraction produced the expected directory
  if (!(await pathExists(extractedPath))) {
    throw Object.assign(new Error('Archive extraction did not produce the expected game folder.'), {
      statusCode: 500,
      code: 'EXTRACTION_FAILED',
    });
  }

  // Ensure all extracted entries are world-readable/writable — archives can
  // embed restrictive permission bits that prevent later access or deletion.
  try {
    await execFileAsync('chmod', ['-R', '777', extractedPath]);
  } catch (chmodErr) {
    logger.warn?.({ err: chmodErr.message, path: extractedPath }, 'Failed to fix permissions on extracted game folder');
  }

  // Extract .rpa archives so the builder doesn't choke on large monoliths
  await extractRpaArchives(extractedPath, logger);

  logger.info?.({ folderName, path: extractedPath }, 'Game archive extracted successfully');

  // Trigger a library scan in background
  scanGamesDirectory(gamesPath, fastify.prisma, fastify.log)
    .then(async (result) => {
      fastify.log.info(
        { found: result.found, new: result.new, removed: result.removed },
        'Post-import scan completed'
      );
      if (fastify.vndbClient && fastify.coversPath) {
        try {
          const enrichResult = await runBatchEnrichment(
            fastify.prisma, fastify.vndbClient, fastify.coversPath, fastify.log
          );
          fastify.log.info(
            { enriched: enrichResult.enriched, failed: enrichResult.failed, skipped: enrichResult.skipped },
            'Post-import enrichment completed'
          );
        } catch (enrichErr) {
          fastify.log.warn({ err: enrichErr.message }, 'Post-import enrichment failed');
        }
      }
    })
    .catch((scanErr) => {
      fastify.log.warn({ err: scanErr.message }, 'Post-import scan failed');
    });

  return { folderName, path: extractedPath };
}

/**
 * Run the correct extraction command for the archive type.
 *
 * @param {string} archivePath - Path to the archive.
 * @param {string} type - Archive type ('zip', 'tar.bz2', 'rar').
 * @param {string} gamesPath - The games root directory.
 * @param {string} extractedPath - Target extraction directory.
 * @param {string|null} singleFolder - The single top-level folder name, or null.
 * @param {import('pino').Logger} logger
 */
async function extractArchive(archivePath, type, gamesPath, extractedPath, singleFolder, logger) {
  logger.info?.({ type, archivePath, singleFolder: !!singleFolder }, 'Extracting archive');

  // Large archives can produce substantial stdout — increase maxBuffer to 50 MB
  const execOpts = { maxBuffer: 50 * 1024 * 1024 };

  if (type === 'zip') {
    if (singleFolder) {
      await execFileAsync('unzip', ['-o', archivePath, '-d', gamesPath], execOpts);
    } else {
      await mkdir(extractedPath, { recursive: true });
      await execFileAsync('unzip', ['-o', archivePath, '-d', extractedPath], execOpts);
    }
  } else if (type === 'tar.bz2') {
    if (singleFolder) {
      await execFileAsync('tar', ['xjf', archivePath, '-C', gamesPath], execOpts);
    } else {
      await mkdir(extractedPath, { recursive: true });
      await execFileAsync('tar', ['xjf', archivePath, '-C', extractedPath], execOpts);
    }
  } else if (type === 'rar') {
    if (singleFolder) {
      // 7z extracts into the target dir, preserving the internal folder structure
      // Note: -o flag must be directly followed by the path (no space)
      await execFileAsync('7z', ['x', archivePath, `-o${gamesPath}`, '-y'], execOpts);
    } else {
      await mkdir(extractedPath, { recursive: true });
      await execFileAsync('7z', ['x', archivePath, `-o${extractedPath}`, '-y'], execOpts);
    }
  }
}

/**
 * Sanitise a folder name — strip path traversal and dangerous characters.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitiseFolderName(name) {
  return name
    .replace(/\.\./g, '')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/^\s+|\s+$/g, '')
    .replace(/^\.+/, '');
}

/**
 * List all entry paths inside an archive (file paths only).
 *
 * @param {string} archivePath
 * @param {string} type - 'zip' | 'tar.bz2' | 'rar'
 * @returns {Promise<string[]>}
 */
async function listArchiveEntries(archivePath, type) {
  try {
    let stdout;

    // Large archives can produce substantial stdout — increase maxBuffer to 50 MB
    const execOpts = { maxBuffer: 50 * 1024 * 1024 };

    if (type === 'zip') {
      // Use unzip -l and parse output — same robust parsing as before
      ({ stdout } = await execFileAsync('unzip', ['-l', archivePath], execOpts));
      return parseUnzipListing(stdout);
    } else if (type === 'tar.bz2') {
      ({ stdout } = await execFileAsync('tar', ['tjf', archivePath], execOpts));
      return stdout.split('\n').filter((l) => l.trim());
    } else if (type === 'rar') {
      // 7z l -slt gives technical listing with "Path = <name>" lines
      ({ stdout } = await execFileAsync('7z', ['l', '-slt', archivePath], execOpts));
      const paths = [];
      for (const line of stdout.split('\n')) {
        const match = line.match(/^Path = (.+)$/);
        if (match) paths.push(match[1].trim());
      }
      // First Path entry is the archive itself — skip it
      return paths.slice(1);
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * Parse the output of `unzip -l` into a list of entry names.
 *
 * @param {string} stdout
 * @returns {string[]}
 */
function parseUnzipListing(stdout) {
  const lines = stdout.split('\n');
  const entryNames = [];
  let inEntries = false;

  for (const line of lines) {
    if (line.match(/^-{4,}/)) {
      if (inEntries) break; // second separator = end of entries
      inEntries = true;
      continue;
    }
    if (!inEntries) continue;

    // Extract the filename portion (last column, after the date/time)
    const match = line.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/);
    if (match) {
      entryNames.push(match[1]);
    }
  }

  return entryNames;
}

/**
 * Inspect an archive and determine if it has a single top-level directory.
 * Returns the name of that directory, or null if the archive has multiple
 * top-level entries.
 *
 * @param {string} archivePath
 * @param {string} type - 'zip' | 'tar.bz2' | 'rar'
 * @returns {Promise<string|null>} The single top-level folder name, or null.
 */
async function getSingleTopLevelFolder(archivePath, type) {
  try {
    const entryNames = await listArchiveEntries(archivePath, type);
    if (entryNames.length === 0) return null;

    // Collect unique top-level items (normalise backslashes for Windows-created archives)
    const topLevel = new Set();
    for (const name of entryNames) {
      const normalised = name.replace(/\\/g, '/');
      const parts = normalised.split('/');
      if (parts[0]) {
        topLevel.add(parts[0]);
      }
    }

    // If there's exactly one top-level entry and it appears as a directory
    if (topLevel.size === 1) {
      const folderName = [...topLevel][0];
      // Verify it's actually used as a folder (has children or is listed with trailing /)
      const hasChildren = entryNames.some((n) => {
        const norm = n.replace(/\\/g, '/');
        return norm.startsWith(folderName + '/') && norm !== folderName + '/';
      });
      const isFolder = entryNames.some((n) => n.replace(/\\/g, '/') === folderName + '/') || hasChildren;
      if (isFolder) return folderName;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Import route plugin — handles archive upload, extraction, and scan trigger.
 * Supports .zip, .tar.bz2, and .rar archives.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function importRoutes(fastify) {
  const gamesPath = process.env.GAMES_PATH || '/games';

  /**
   * POST /library/import
   *
   * Accepts a multipart archive upload (.zip, .tar.bz2, or .rar), extracts it
   * into /games/<folder>, then triggers a library scan so the new game is
   * detected.
   *
   * Archive structure handling:
   *   1. Single top-level folder → extract directly to /games/ (folder preserved)
   *   2. Multiple top-level entries → infer folder name from archive filename,
   *      create /games/<archiveName>/, extract into it
   */
  const maxBodySize =
    (parseInt(process.env.MAX_IMPORT_SIZE_MB, 10) || 24576) * 1024 * 1024;

  fastify.post('/library/import', { bodyLimit: maxBodySize }, async (request, reply) => {
    let tmpPath = null;

    try {
      // ── 1. Receive the uploaded file ──────────────────
      const data = await request.file();

      if (!data) {
        return reply.code(400).send({
          code: 'NO_FILE',
          message: 'No file was uploaded. Please select an archive file.',
        });
      }

      const originalName = data.filename || 'import.zip';
      const archiveType = detectArchiveType(originalName);

      if (!archiveType) {
        data.file.resume();
        return reply.code(400).send({
          code: 'INVALID_FILE_TYPE',
          message: `Only ${ACCEPTED_LABEL} files are accepted.`,
        });
      }

      // ── 2. Stream upload to temp file ─────────────────
      const safeName = sanitiseFolderName(stripArchiveExt(basename(originalName))) || 'import';
      tmpPath = join(tmpdir(), `vnm-${safeName}-${Date.now()}${archiveType.ext}`);
      await pipeline(data.file, createWriteStream(tmpPath));

      const tmpStat = await stat(tmpPath);
      if (tmpStat.size === 0) {
        return reply.code(400).send({ code: 'EMPTY_FILE', message: 'The uploaded file is empty.' });
      }

      request.log.info({ filename: originalName, size: tmpStat.size, type: archiveType.type }, 'Archive file uploaded to temp');

      // ── 3. Extract and scan ───────────────────────────
      const result = await extractAndScan(tmpPath, originalName, gamesPath, fastify, request.log);

      return {
        folderName: result.folderName,
        path: result.path,
        message: 'Game imported successfully. Library scan triggered.',
      };
    } catch (err) {
      request.log.error({ err: err.message }, 'Import failed');
      if (err.statusCode) throw err;
      return reply.code(500).send({
        code: 'IMPORT_FAILED',
        message: err.message || 'An unexpected error occurred during import.',
      });
    } finally {
      if (tmpPath) {
        await rm(tmpPath, { force: true }).catch(() => {});
      }
    }
  });

  /**
   * POST /library/import-url
   *
   * Downloads an archive from a remote URL (.zip, .tar.bz2, or .rar), extracts
   * it into /games/<folder>, then triggers a library scan. Streams NDJSON
   * progress events back to the client.
   *
   * Body: { "url": "https://example.com/game.zip" }
   *
   * Response: streamed NDJSON lines:
   *   { "phase": "downloading", "progress": 0, "totalBytes": 123456 }
   *   { "phase": "downloading", "progress": 50, "downloadedBytes": 61728 }
   *   { "phase": "extracting" }
   *   { "phase": "complete", "folderName": "GameName" }
   *   { "phase": "error", "message": "..." }
   */
  fastify.post('/library/import-url', async (request, reply) => {
    const { url } = request.body || {};

    if (!url || typeof url !== 'string') {
      return reply.code(400).send({
        code: 'MISSING_URL',
        message: 'A "url" field is required in the request body.',
      });
    }

    // Validate URL format
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Only http and https URLs are supported.');
      }
    } catch (urlErr) {
      return reply.code(400).send({
        code: 'INVALID_URL',
        message: urlErr.message || 'Invalid URL provided.',
      });
    }

    // Infer filename from URL path and detect archive type
    const urlPath = parsedUrl.pathname;
    let inferredName = basename(urlPath) || 'download.zip';
    let archiveType = detectArchiveType(inferredName);

    // If we can't detect the type from the URL, default to .zip
    if (!archiveType) {
      inferredName += '.zip';
      archiveType = detectArchiveType(inferredName);
    }

    // Set up NDJSON streaming response
    reply.raw.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'Transfer-Encoding': 'chunked',
    });

    const sendEvent = (data) => {
      reply.raw.write(JSON.stringify(data) + '\n');
    };

    let tmpPath = null;

    try {
      // ── 1. Download the file ──────────────────────────
      sendEvent({ phase: 'downloading', progress: 0, message: `Downloading ${inferredName}…` });

      const response = await fetch(url, {
        headers: { 'User-Agent': 'VN-Manager/1.0' },
        redirect: 'follow',
      });

      if (!response.ok) {
        sendEvent({ phase: 'error', message: `Download failed: HTTP ${response.status} ${response.statusText}` });
        reply.raw.end();
        return;
      }

      const contentLength = parseInt(response.headers.get('content-length'), 10) || 0;
      const safeName = sanitiseFolderName(stripArchiveExt(basename(inferredName))) || 'download';
      tmpPath = join(tmpdir(), `vnm-${safeName}-${Date.now()}${archiveType.ext}`);
      const writeStream = createWriteStream(tmpPath);

      if (contentLength > 0) {
        sendEvent({ phase: 'downloading', progress: 0, totalBytes: contentLength });
      }

      // Stream download with progress tracking
      let downloadedBytes = 0;
      let lastReportedPct = -1;

      const progressStream = new Readable({
        // PassThrough-like: we'll pipe from response body
        read() {},
      });

      // Use the web ReadableStream from fetch
      const reader = response.body.getReader();

      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            writeStream.end();
            break;
          }
          downloadedBytes += value.length;
          writeStream.write(value);

          // Report progress at each 1% increment (or every chunk if no content-length)
          if (contentLength > 0) {
            const pct = Math.round((downloadedBytes / contentLength) * 100);
            if (pct !== lastReportedPct) {
              lastReportedPct = pct;
              sendEvent({ phase: 'downloading', progress: pct, downloadedBytes, totalBytes: contentLength });
            }
          } else {
            // Unknown size — report bytes downloaded
            sendEvent({ phase: 'downloading', progress: -1, downloadedBytes });
          }
        }
      };

      await pump();

      // Wait for the write stream to finish flushing
      await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      const tmpStat = await stat(tmpPath);
      if (tmpStat.size === 0) {
        sendEvent({ phase: 'error', message: 'Downloaded file is empty.' });
        reply.raw.end();
        return;
      }

      request.log.info(
        { url, filename: inferredName, size: tmpStat.size, type: archiveType.type },
        'URL download complete'
      );

      sendEvent({ phase: 'downloading', progress: 100, downloadedBytes: tmpStat.size, totalBytes: tmpStat.size });

      // ── 2. Extract and scan ───────────────────────────
      sendEvent({ phase: 'extracting', message: 'Extracting & scanning…' });

      const result = await extractAndScan(tmpPath, inferredName, gamesPath, fastify, request.log);

      sendEvent({
        phase: 'complete',
        folderName: result.folderName,
        path: result.path,
        message: 'Game imported successfully.',
      });
    } catch (err) {
      request.log.error({ err: err.message, url }, 'URL import failed');
      sendEvent({
        phase: 'error',
        message: err.message || 'An unexpected error occurred during URL import.',
      });
    } finally {
      if (tmpPath) {
        await rm(tmpPath, { force: true }).catch(() => {});
      }
      reply.raw.end();
    }
  });
}
