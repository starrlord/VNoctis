/**
 * Build orchestration utilities: stale detection and periodic checks.
 */

import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Recursively find the newest file modification time in a directory tree.
 *
 * @param {string} dirPath - The directory to walk.
 * @param {number} [cutoff=0] - Stop early if we find anything newer than this (ms epoch).
 * @returns {Promise<number>} The newest mtime as milliseconds since epoch.
 */
async function newestMtime(dirPath, cutoff = 0) {
  let newest = 0;

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return newest;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    // Skip common non-source paths that Ren'Py generates
    if (
      entry.name === '__pycache__' ||
      entry.name === 'saves' ||
      entry.name === 'cache' ||
      entry.name === 'web-build' ||
      entry.name.endsWith('-dists') ||
      entry.name === 'tmp'
    ) {
      continue;
    }

    try {
      if (entry.isDirectory()) {
        const sub = await newestMtime(fullPath, cutoff);
        if (sub > newest) newest = sub;
      } else if (entry.isFile()) {
        const st = await stat(fullPath);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    } catch {
      // Permission errors, broken symlinks, etc.
      continue;
    }

    // Early exit if we already know sources are newer than the cutoff
    if (cutoff > 0 && newest > cutoff) {
      return newest;
    }
  }

  return newest;
}

/**
 * Scan all games with buildStatus === 'built' and mark any whose source
 * files have been modified since the last successful build.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} gamesPath - The container path where games are mounted (e.g. "/games").
 * @param {import('pino').Logger} [logger] - Optional logger.
 * @returns {Promise<{ staleCount: number, checkedCount: number }>}
 */
export async function checkStaleBuilds(prisma, gamesPath, logger) {
  const builtGames = await prisma.game.findMany({
    where: { buildStatus: 'built' },
    select: {
      id: true,
      directoryPath: true,
      builtAt: true,
    },
  });

  let staleCount = 0;
  let checkedCount = 0;

  for (const game of builtGames) {
    if (!game.builtAt) {
      // No builtAt timestamp — shouldn't happen, but treat as stale
      await prisma.game.update({
        where: { id: game.id },
        data: { buildStatus: 'stale' },
      });
      staleCount++;
      continue;
    }

    checkedCount++;
    const builtAtMs = game.builtAt.getTime();

    try {
      const newest = await newestMtime(game.directoryPath, builtAtMs);

      if (newest > builtAtMs) {
        await prisma.game.update({
          where: { id: game.id },
          data: { buildStatus: 'stale' },
        });
        staleCount++;

        if (logger) {
          logger.info(
            { gameId: game.id, directory: game.directoryPath },
            'Marked game as stale — source files modified after last build'
          );
        }
      }
    } catch (err) {
      if (logger) {
        logger.warn(
          { gameId: game.id, err: err.message },
          'Failed to check staleness for game'
        );
      }
    }
  }

  if (logger) {
    logger.info(
      { checked: checkedCount, stale: staleCount },
      'Stale build check completed'
    );
  }

  return { staleCount, checkedCount };
}
