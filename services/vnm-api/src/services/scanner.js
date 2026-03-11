import { readdir, stat, access, rm, mkdir, rename, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractTitleFromOptions, cleanDirectoryName } from './titleExtractor.js';

const execFileAsync = promisify(execFile);

/**
 * Generate a stable fingerprint ID from a directory name.
 * Uses the first 32 hex characters of a SHA-256 hash.
 *
 * @param {string} dirName - The directory name to fingerprint.
 * @returns {string} A 32-character hex string.
 */
function generateFingerprint(dirName) {
  return createHash('sha256').update(dirName).digest('hex').slice(0, 32);
}

/**
 * Check whether a directory is a valid Ren'Py project.
 *
 * A directory is considered a Ren'Py project if:
 *   - It has a `game/` subdirectory containing any `.rpy` or `.rpyc` files, OR
 *   - It has a `renpy/` subdirectory (Ren'Py SDK/runtime indicator)
 *
 * @param {string} dirPath - Absolute path to the candidate directory.
 * @returns {Promise<boolean>}
 */
async function isRenpyProject(dirPath) {
  // Check for renpy/ directory
  try {
    const renpyDir = join(dirPath, 'renpy');
    const renpyStat = await stat(renpyDir);
    if (renpyStat.isDirectory()) return true;
  } catch {
    // renpy/ doesn't exist, continue checking
  }

  // Check for game/ directory with .rpy or .rpyc files
  try {
    const gameDir = join(dirPath, 'game');
    const gameStat = await stat(gameDir);
    if (!gameStat.isDirectory()) return false;

    const entries = await readdir(gameDir);
    return entries.some(
      (f) => f.endsWith('.rpy') || f.endsWith('.rpyc')
    );
  } catch {
    return false;
  }
}

/**
 * Check whether a directory contains any .zip file (potential pre-built web build).
 *
 * @param {string} dirPath - Absolute path to the candidate directory.
 * @returns {Promise<boolean>}
 */
async function hasWebBuildZip(dirPath) {
  try {
    const entries = await readdir(dirPath);
    return entries.some((f) => f.endsWith('.zip'));
  } catch {
    return false;
  }
}

/**
 * Scan a games directory for Ren'Py visual novel projects.
 *
 * 1. Reads all entries in gamesPath.
 * 2. For each subdirectory, checks if it's a valid Ren'Py project.
 * 3. Generates a stable ID from the directory name.
 * 4. Extracts the game title from options.rpy (fallback: cleaned dir name).
 * 5. Upserts into DB: new games are created, existing games get path updated.
 * 6. Games in DB but no longer on disk are removed.
 *
 * @param {string} gamesPath - The root directory to scan (e.g. "/games").
 * @param {import('@prisma/client').PrismaClient} prisma - Prisma client instance.
 * @param {import('pino').Logger} [logger] - Optional logger.
 * @returns {Promise<{ found: number, new: number, removed: number, imported: number }>}
 */
export async function scanGamesDirectory(gamesPath, prisma, logger) {
  const log = logger || console;

  // Verify the games directory exists
  try {
    await access(gamesPath);
  } catch {
    throw new Error(`Games directory not accessible: ${gamesPath}`);
  }

  const entries = await readdir(gamesPath, { withFileTypes: true });
  const subdirs = entries.filter((e) => e.isDirectory());

  const webBuildsPath = process.env.WEB_BUILDS_PATH || '/web-builds';
  const discoveredIds = [];
  let newCount = 0;
  let importedCount = 0;

  for (const entry of subdirs) {
    const dirPath = join(gamesPath, entry.name);

    const isRenpy = await isRenpyProject(dirPath);
    const hasZip = !isRenpy ? await hasWebBuildZip(dirPath) : false;

    if (!isRenpy && !hasZip) {
      log.info?.({ dir: entry.name }, 'Skipping non-Ren\'Py directory');
      continue;
    }

    const id = generateFingerprint(entry.name);
    discoveredIds.push(id);

    // Extract title
    const optionsTitle = await extractTitleFromOptions(dirPath);
    const extractedTitle = optionsTitle || cleanDirectoryName(entry.name);

    // Check if game already exists
    const existing = await prisma.game.findUnique({ where: { id } });

    if (existing) {
      // Update path in case mount changed
      await prisma.game.update({
        where: { id },
        data: {
          directoryPath: dirPath,
          // Only update extractedTitle if it was originally derived (not manually set)
          ...(existing.metadataSource !== 'manual'
            ? { extractedTitle }
            : {}),
        },
      });
      log.info?.({ id, title: extractedTitle }, 'Updated existing game');
    } else {
      await prisma.game.create({
        data: {
          id,
          directoryPath: dirPath,
          directoryName: entry.name,
          extractedTitle,
        },
      });
      newCount++;
      log.info?.({ id, title: extractedTitle }, 'Discovered new game');
    }

    // --- ZIP detection and import ---
    try {
      // List directory entries and find .zip files
      const dirEntries = await readdir(dirPath, { withFileTypes: true });
      const zipFiles = dirEntries
        .filter((e) => e.isFile() && e.name.endsWith('.zip'))
        .map((e) => e.name);

      if (zipFiles.length > 0) {
        // Re-fetch the game record to check current buildStatus
        const gameRecord = await prisma.game.findUnique({ where: { id } });

        if (gameRecord && gameRecord.buildStatus !== 'built') {
          // Pick the most recently modified .zip if multiple exist
          let zipFile;
          if (zipFiles.length === 1) {
            zipFile = zipFiles[0];
          } else {
            const zipStats = await Promise.all(
              zipFiles.map(async (name) => {
                const s = await stat(join(dirPath, name));
                return { name, mtime: s.mtimeMs };
              })
            );
            zipStats.sort((a, b) => b.mtime - a.mtime);
            zipFile = zipStats[0].name;
          }

          const zipPath = join(dirPath, zipFile);
          const outputDir = join(webBuildsPath, entry.name);

          log.info?.({ id, zip: zipFile }, 'Found pre-built ZIP, attempting import');

          // Clean existing output directory if present
          try {
            await rm(outputDir, { recursive: true, force: true });
          } catch {
            // Ignore if it doesn't exist
          }

          // Create output directory
          await mkdir(outputDir, { recursive: true });

          // Extract using unzip (increase maxBuffer for large ZIPs with many files)
          await execFileAsync('unzip', ['-o', zipPath, '-d', outputDir], {
            maxBuffer: 50 * 1024 * 1024,
          });

          // Check for index.html — directly or one level deep
          let indexFound = false;

          try {
            await access(join(outputDir, 'index.html'));
            indexFound = true;
          } catch {
            // Check one level deep for index.html inside a subdirectory
            const extractedEntries = await readdir(outputDir, { withFileTypes: true });
            for (const sub of extractedEntries) {
              if (sub.isDirectory()) {
                const nestedIndex = join(outputDir, sub.name, 'index.html');
                try {
                  await access(nestedIndex);
                  // Found in subdirectory — move contents up to outputDir root
                  const subDirPath = join(outputDir, sub.name);
                  const subContents = await readdir(subDirPath, { withFileTypes: true });
                  for (const item of subContents) {
                    const src = join(subDirPath, item.name);
                    const dest = join(outputDir, item.name);
                    try {
                      await rename(src, dest);
                    } catch {
                      // rename may fail across devices; fall back to copy + remove
                      await cp(src, dest, { recursive: true });
                      await rm(src, { recursive: true, force: true });
                    }
                  }
                  // Remove the now-empty subdirectory
                  await rm(subDirPath, { recursive: true, force: true });
                  indexFound = true;
                  break;
                } catch {
                  // No index.html in this subdirectory
                }
              }
            }
          }

          if (indexFound) {
            await prisma.game.update({
              where: { id },
              data: {
                buildStatus: 'built',
                webBuildPath: `/web-builds/${entry.name}`,
                builtAt: new Date(),
              },
            });
            importedCount++;
            log.info?.({ id, zip: zipFile }, 'Imported pre-built web build from ZIP');
          } else {
            // Not a valid web build — clean up
            await rm(outputDir, { recursive: true, force: true });
            log.warn?.({ id, zip: zipFile }, 'ZIP does not contain index.html — not a valid web build');
          }
        }
      }
    } catch (zipErr) {
      log.warn?.({ id, err: zipErr?.message || zipErr }, 'Failed to import ZIP for game — continuing scan');
    }
  }

  // Remove games that are no longer on disk
  const allGames = await prisma.game.findMany({ select: { id: true } });
  const removedIds = allGames
    .map((g) => g.id)
    .filter((id) => !discoveredIds.includes(id));

  if (removedIds.length > 0) {
    // Clean up BuildJob records and build logs for removed games
    for (const gameId of removedIds) {
      try {
        const buildJobs = await prisma.buildJob.findMany({
          where: { gameId },
          select: { id: true },
        });
        for (const job of buildJobs) {
          try {
            await rm(join(webBuildsPath, 'logs', `${job.id}.log`), { force: true });
          } catch {
            // Best-effort log cleanup
          }
        }
        await prisma.buildJob.deleteMany({ where: { gameId } });
      } catch (err) {
        log.warn?.({ gameId, err: err?.message }, 'Failed to clean up BuildJobs for removed game');
      }
    }

    await prisma.game.deleteMany({
      where: { id: { in: removedIds } },
    });
    log.info?.({ count: removedIds.length }, 'Removed games no longer on disk');
  }

  // Build a set of active game IDs for orphan detection
  const activeGames = await prisma.game.findMany({
    select: { id: true, directoryName: true },
  });
  const activeGameIds = new Set(activeGames.map((g) => g.id));
  const validDirNames = new Set(activeGames.map((g) => g.directoryName));
  // 'logs' is the build-log directory — always keep it
  validDirNames.add('logs');

  // Clean up orphaned web-build directories (e.g. old hash-named folders)
  let orphansRemoved = 0;
  try {
    const webBuildEntries = await readdir(webBuildsPath, { withFileTypes: true });
    for (const wbEntry of webBuildEntries) {
      if (!validDirNames.has(wbEntry.name)) {
        const orphanPath = join(webBuildsPath, wbEntry.name);
        try {
          await rm(orphanPath, { recursive: true, force: true });
          orphansRemoved++;
          log.info?.({ path: wbEntry.name }, 'Removed orphaned web-build entry');
        } catch (rmErr) {
          log.warn?.({ path: wbEntry.name, err: rmErr?.message }, 'Failed to remove orphaned web-build entry');
        }
      }
    }
    if (orphansRemoved > 0) {
      log.info?.({ count: orphansRemoved }, 'Orphaned web-build entries cleaned up');
    }
  } catch (cleanupErr) {
    log.warn?.({ err: cleanupErr?.message }, 'Failed to scan web-builds for orphans');
  }

  // Clean up orphaned cover images
  const coversPath = process.env.COVERS_PATH || '/covers';
  try {
    const coverEntries = await readdir(coversPath);
    for (const file of coverEntries) {
      // Cover files are named {gameId}.jpg — extract the ID portion
      const coverId = file.replace(/\.[^.]+$/, '');
      if (coverId.length === 32 && !activeGameIds.has(coverId)) {
        try {
          await rm(join(coversPath, file), { force: true });
          log.info?.({ file }, 'Removed orphaned cover image');
        } catch (rmErr) {
          log.warn?.({ file, err: rmErr?.message }, 'Failed to remove orphaned cover');
        }
      }
    }
  } catch (cleanupErr) {
    log.warn?.({ err: cleanupErr?.message }, 'Failed to scan covers for orphans');
  }

  // Clean up orphaned screenshot directories
  const screenshotsPath = process.env.SCREENSHOTS_PATH || '/screenshots';
  try {
    const screenshotEntries = await readdir(screenshotsPath, { withFileTypes: true });
    for (const entry of screenshotEntries) {
      if (entry.isDirectory() && entry.name.length === 32 && !activeGameIds.has(entry.name)) {
        try {
          await rm(join(screenshotsPath, entry.name), { recursive: true, force: true });
          log.info?.({ gameId: entry.name }, 'Removed orphaned screenshot directory');
        } catch (rmErr) {
          log.warn?.({ gameId: entry.name, err: rmErr?.message }, 'Failed to remove orphaned screenshots');
        }
      }
    }
  } catch (cleanupErr) {
    log.warn?.({ err: cleanupErr?.message }, 'Failed to scan screenshots for orphans');
  }

  return {
    found: discoveredIds.length,
    new: newCount,
    removed: removedIds.length,
    imported: importedCount,
    orphansRemoved,
  };
}
