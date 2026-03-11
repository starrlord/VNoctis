/**
 * RPA archive extraction utility.
 *
 * Detects and extracts all .rpa archives in a Ren'Py game's `game/`
 * subdirectory, then removes the originals so the builder doesn't have
 * to repack them.
 *
 * Shared between the import and build flows — any game that reaches the
 * builder should have its .rpa files pre-extracted.
 */

import { readdir, rm, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Check whether a path exists on disk.
 *
 * @param {string} p
 * @returns {Promise<boolean>}
 */
export async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect and extract all .rpa archives in the game/ subdirectory,
 * then remove the originals so the builder doesn't have to repack them.
 *
 * Ren'Py games can ship with multiple .rpa files (archive.rpa, images.rpa,
 * fonts.rpa, etc.) — extracting them avoids web-build failures caused by
 * oversized packed archives.
 *
 * @param {string} gamePath - Path to the game root (e.g. /games/MyGame).
 * @param {import('pino').Logger} logger
 */
export async function extractRpaArchives(gamePath, logger) {
  const gameSubdir = join(gamePath, 'game');

  // If there's no game/ subdirectory this isn't a standard Ren'Py layout
  if (!(await pathExists(gameSubdir))) return;

  const entries = await readdir(gameSubdir);
  const rpaFiles = entries.filter((f) => f.toLowerCase().endsWith('.rpa'));

  if (rpaFiles.length === 0) return;

  logger.info?.({ count: rpaFiles.length, files: rpaFiles }, 'Found .rpa archives — extracting');

  for (const rpaFile of rpaFiles) {
    const rpaPath = join(gameSubdir, rpaFile);
    const rpaStats = await stat(rpaPath);
    const sizeMB = Math.round(rpaStats.size / (1024 * 1024));

    logger.info?.({ file: rpaFile, sizeMB }, 'Extracting .rpa archive');

    try {
      await execFileAsync('unrpa', ['-p', gameSubdir, rpaPath]);
      await rm(rpaPath, { force: true });
      logger.info?.({ file: rpaFile }, '.rpa archive extracted and removed');
    } catch (err) {
      logger.warn?.(
        { err: err.message, file: rpaFile },
        'Failed to extract .rpa archive — leaving it in place'
      );
    }
  }
}
