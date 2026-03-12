/**
 * Enrichment orchestrator.
 *
 * Ties together VNDB/Steam search, fuzzy matching, synopsis cleaning, and
 * cover downloading to populate game metadata automatically.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { matchTitle } from './matcher.js';
import { downloadCover } from './coverDownloader.js';
import { downloadScreenshots, removeScreenshots } from './screenshotDownloader.js';
import { cleanSynopsis } from './synopsisCleaner.js';
import { SteamClient } from './steamClient.js';

/** Default metadata TTL in days */
const DEFAULT_TTL_DAYS = 30;

// ── Helpers ─────────────────────────────────────────────────

/**
 * Parse a VNDB "released" string into a Date (or null).
 * Handles: "YYYY-MM-DD", "YYYY-MM", "YYYY", "tba", null.
 *
 * @param {string|null} released
 * @returns {Date|null}
 */
function parseReleasedDate(released) {
  if (!released || released === 'tba') return null;

  // "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(released)) {
    const d = new Date(released + 'T00:00:00Z');
    return isNaN(d.getTime()) ? null : d;
  }

  // "YYYY-MM"
  if (/^\d{4}-\d{2}$/.test(released)) {
    const d = new Date(released + '-01T00:00:00Z');
    return isNaN(d.getTime()) ? null : d;
  }

  // "YYYY"
  if (/^\d{4}$/.test(released)) {
    const d = new Date(released + '-01-01T00:00:00Z');
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/**
 * Map a VNDB VN result object to Prisma-compatible game update data.
 *
 * @param {object} vn - VNDB VN result.
 * @returns {object} Fields ready for prisma.game.update({ data }).
 */
function mapVnToGameData(vn) {
  return {
    vndbId: vn.id || null,
    vndbTitle: vn.title || null,
    vndbTitleOriginal: vn.alttitle || null,
    synopsis: cleanSynopsis(vn.description),
    developer: vn.developers?.[0]?.name || null,
    releaseDate: parseReleasedDate(vn.released),
    lengthMinutes: vn.length_minutes || null,
    vndbRating: vn.rating != null ? vn.rating / 10 : null,
    tags: JSON.stringify(
      vn.tags
        ?.filter((t) => t.spoiler === 0)
        ?.slice(0, 20)
        ?.map((t) => ({ name: t.name, spoiler: t.spoiler })) || []
    ),
    screenshots: JSON.stringify(
      vn.screenshots?.slice(0, 8)?.map((s) => s.url) || []
    ),
  };
}

// ── Public API ──────────────────────────────────────────────

/**
 * Enrich a single game by searching VNDB for its extracted title.
 *
 * @param {object} game             - Prisma Game record.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {import('./vndbClient.js').VNDBClient} vndbClient
 * @param {string} coversPath       - Absolute path to covers directory.
 * @param {string} screenshotsPath  - Absolute path to screenshots directory.
 * @returns {Promise<object>}  Updated game record.
 */
export async function enrichGame(game, prisma, vndbClient, coversPath, screenshotsPath, logger) {
  const log = logger || console;

  console.log(`[Enrichment] enrichGame called: gameId=${game.id}, metadataSource=${game.metadataSource}, screenshotsPath=${screenshotsPath || 'UNDEFINED'}`);

  // Never overwrite manual overrides
  if (game.metadataSource === 'manual') {
    console.log(`[Enrichment] SKIPPED — metadataSource is 'manual'`);
    return game;
  }

  try {
    const results = await vndbClient.searchByTitle(game.extractedTitle);

    if (!results.length) {
      return prisma.game.update({
        where: { id: game.id },
        data: {
          metadataSource: 'unmatched',
          metadataFetchedAt: new Date(),
        },
      });
    }

    const matched = matchTitle(
      game.extractedTitle,
      results,
      vndbClient.matchThreshold
    );

    if (!matched) {
      return prisma.game.update({
        where: { id: game.id },
        data: {
          metadataSource: 'unmatched',
          metadataFetchedAt: new Date(),
        },
      });
    }

    return applyMatch(matched.match, game, prisma, coversPath, screenshotsPath);
  } catch (err) {
    (log.error || log.log).call(log,
      { event: 'enrichment_failed', gameId: game.id, title: game.extractedTitle, error: err.message },
      `Failed to enrich game ${game.id} (${game.extractedTitle})`
    );
    return game;
  }
}

/**
 * Enrich a game by fetching a specific VNDB ID (force-link).
 *
 * @param {string} vndbId           - e.g. "v17"
 * @param {object} game             - Prisma Game record.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {import('./vndbClient.js').VNDBClient} vndbClient
 * @param {string} coversPath
 * @param {string} screenshotsPath
 * @returns {Promise<object>}  Updated game record.
 */
export async function enrichGameById(vndbId, game, prisma, vndbClient, coversPath, screenshotsPath, logger) {
  const log = logger || console;

  try {
    const vn = await vndbClient.getById(vndbId);

    if (!vn) {
      return prisma.game.update({
        where: { id: game.id },
        data: {
          metadataSource: 'unmatched',
          metadataFetchedAt: new Date(),
        },
      });
    }

    return applyMatch(vn, game, prisma, coversPath, screenshotsPath);
  } catch (err) {
    (log.error || log.log).call(log,
      { event: 'enrichment_by_id_failed', gameId: game.id, vndbId, error: err.message },
      `Failed to enrich game ${game.id} by VNDB ID ${vndbId}`
    );
    return game;
  }
}

/**
 * Apply a matched VNDB result to a game record (shared logic).
 *
 * @param {object} vn               - VNDB VN result object.
 * @param {object} game             - Prisma Game record.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} coversPath
 * @param {string} screenshotsPath
 * @returns {Promise<object>}  Updated game record.
 */
async function applyMatch(vn, game, prisma, coversPath, screenshotsPath) {
  const data = mapVnToGameData(vn);

  // Clear existing cover so downloadCover fetches a fresh image
  if (coversPath) {
    try { await rm(join(coversPath, `${game.id}.jpg`), { force: true }); } catch { /* ignore */ }
  }

  // Clear existing screenshots so fresh ones are downloaded
  if (screenshotsPath) {
    await removeScreenshots(game.id, screenshotsPath);
  }

  // Download cover art
  if (vn.image?.url) {
    const localCover = await downloadCover(vn.image.url, game.id, coversPath);
    if (localCover) {
      data.coverPath = localCover;
    }
  }

  // Download screenshots locally
  const remoteUrls = vn.screenshots?.slice(0, 8)?.map((s) => s.url) || [];
  console.log(`[Enrichment] Screenshot download: gameId=${game.id}, remoteUrls=${remoteUrls.length}, screenshotsPath=${screenshotsPath || 'UNDEFINED'}`);
  if (remoteUrls.length > 0 && screenshotsPath) {
    const localPaths = await downloadScreenshots(remoteUrls, game.id, screenshotsPath);
    console.log(`[Enrichment] Screenshot download complete: localPaths=${JSON.stringify(localPaths)}`);
    data.screenshots = JSON.stringify(localPaths);
  } else {
    console.log(`[Enrichment] Screenshot download SKIPPED: urls=${remoteUrls.length}, path=${screenshotsPath}`);
  }

  data.metadataSource = 'auto';
  data.metadataFetchedAt = new Date();

  return prisma.game.update({
    where: { id: game.id },
    data,
  });
}

/**
 * Run batch enrichment across all games that need metadata.
 *
 * Finds games where:
 *   - metadataSource = 'unmatched', OR
 *   - metadataFetchedAt is null, OR
 *   - metadataFetchedAt is older than METADATA_TTL_DAYS
 * But skips games where metadataSource = 'manual'.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {import('./vndbClient.js').VNDBClient} vndbClient
 * @param {string} coversPath
 * @param {string} screenshotsPath
 * @returns {Promise<{ enriched: number, failed: number, skipped: number }>}
 */
export async function runBatchEnrichment(prisma, vndbClient, coversPath, screenshotsPath, logger) {
  const log = logger || console;

  const ttlDays = parseInt(process.env.METADATA_TTL_DAYS, 10) || DEFAULT_TTL_DAYS;
  const cutoffDate = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);

  const games = await prisma.game.findMany({
    where: {
      metadataSource: { not: 'manual' },
      OR: [
        { metadataFetchedAt: null },
        { metadataSource: 'unmatched' },
        { metadataFetchedAt: { lt: cutoffDate } },
      ],
    },
  });

  let enriched = 0;
  let failed = 0;
  let skipped = 0;

  for (const game of games) {
    if (game.metadataSource === 'manual') {
      skipped++;
      continue;
    }

    try {
      const updated = await enrichGame(game, prisma, vndbClient, coversPath, screenshotsPath, log);
      if (updated.metadataSource === 'auto') {
        enriched++;
      } else {
        skipped++;
      }
    } catch (err) {
      (log.error || log.log).call(log,
        { event: 'enrichment_batch_error', gameId: game.id, error: err.message },
        `Batch enrichment error for ${game.id}`
      );
      failed++;
    }
  }

  return { enriched, failed, skipped };
}

// ── Steam Enrichment ────────────────────────────────────────

/**
 * Parse a Steam release date string into a Date (or null).
 * Steam formats vary: "Mar 12, 2020", "Coming Soon", "2020", etc.
 *
 * @param {object|null} releaseInfo - { coming_soon: boolean, date: string }
 * @returns {Date|null}
 */
function parseSteamReleaseDate(releaseInfo) {
  if (!releaseInfo || releaseInfo.coming_soon || !releaseInfo.date) return null;

  const dateStr = releaseInfo.date;

  // Try direct Date parse (handles "Mar 12, 2020" etc.)
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d;

  // Try year-only: "2020"
  if (/^\d{4}$/.test(dateStr)) {
    const yearDate = new Date(dateStr + '-01-01T00:00:00Z');
    return isNaN(yearDate.getTime()) ? null : yearDate;
  }

  return null;
}

/**
 * Map a Steam appdetails response to Prisma-compatible game update data.
 *
 * @param {object} details - Steam appdetails data object.
 * @param {string|number} appid - Steam app ID.
 * @returns {object} Fields ready for prisma.game.update({ data }).
 */
function mapSteamToGameData(details, appid) {
  // Map genres to the same tag format as VNDB
  const tags = details.genres
    ?.slice(0, 20)
    ?.map((g) => ({ name: g.description, spoiler: 0 })) || [];

  // Map screenshots to URL array
  const screenshots = details.screenshots
    ?.slice(0, 8)
    ?.map((s) => s.path_full) || [];

  return {
    steamAppId: String(appid),
    vndbTitle: details.name || null,
    vndbTitleOriginal: null, // Steam doesn't provide original-language titles
    synopsis: details.short_description || details.about_the_game || null,
    developer: details.developers?.[0] || null,
    releaseDate: parseSteamReleaseDate(details.release_date),
    lengthMinutes: null, // Steam doesn't provide play-time estimates
    vndbRating: details.metacritic?.score != null
      ? details.metacritic.score / 10
      : null,
    tags: JSON.stringify(tags),
    screenshots: JSON.stringify(screenshots),
  };
}

/**
 * Enrich a game by fetching a specific Steam app ID.
 *
 * @param {string|number} steamAppId   - Steam application ID.
 * @param {object} game                - Prisma Game record.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {import('./steamClient.js').SteamClient} steamClient
 * @param {string} coversPath
 * @param {string} screenshotsPath
 * @param {object} [logger]
 * @returns {Promise<object>} Updated game record.
 */
export async function enrichGameBySteamId(steamAppId, game, prisma, steamClient, coversPath, screenshotsPath, logger) {
  const log = logger || console;

  try {
    const details = await steamClient.getAppDetails(steamAppId);

    if (!details) {
      return prisma.game.update({
        where: { id: game.id },
        data: {
          metadataSource: 'unmatched',
          metadataFetchedAt: new Date(),
        },
      });
    }

    return applySteamMatch(details, steamAppId, game, prisma, coversPath, screenshotsPath);
  } catch (err) {
    (log.error || log.log).call(log,
      { event: 'steam_enrichment_failed', gameId: game.id, steamAppId, error: err.message },
      `Failed to enrich game ${game.id} from Steam app ${steamAppId}`
    );
    return game;
  }
}

/**
 * Apply a matched Steam app to a game record.
 *
 * @param {object} details       - Steam appdetails data object.
 * @param {string|number} appid  - Steam app ID.
 * @param {object} game          - Prisma Game record.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} coversPath
 * @param {string} screenshotsPath
 * @returns {Promise<object>} Updated game record.
 */
async function applySteamMatch(details, appid, game, prisma, coversPath, screenshotsPath) {
  const data = mapSteamToGameData(details, appid);

  // Clear existing cover so downloadCover fetches a fresh image
  if (coversPath) {
    try { await rm(join(coversPath, `${game.id}.jpg`), { force: true }); } catch { /* ignore */ }
  }

  // Clear existing screenshots so fresh ones are downloaded
  if (screenshotsPath) {
    await removeScreenshots(game.id, screenshotsPath);
  }

  // Download cover art: library_600x900 → hero_capsule → header_image
  const libraryCapsuleUrl = SteamClient.getLibraryCapsuleUrl(appid);
  let localCover = await downloadCover(libraryCapsuleUrl, game.id, coversPath);

  if (!localCover) {
    const heroCapsuleUrl = SteamClient.getHeroCapsuleUrl(appid);
    localCover = await downloadCover(heroCapsuleUrl, game.id, coversPath);
  }

  if (!localCover && details.header_image) {
    localCover = await downloadCover(details.header_image, game.id, coversPath);
  }

  if (localCover) {
    data.coverPath = localCover;
  }

  // Download screenshots locally
  const remoteUrls = details.screenshots?.slice(0, 8)?.map((s) => s.path_full) || [];
  if (remoteUrls.length > 0 && screenshotsPath) {
    const localPaths = await downloadScreenshots(remoteUrls, game.id, screenshotsPath);
    data.screenshots = JSON.stringify(localPaths);
  }

  data.metadataSource = 'auto';
  data.metadataFetchedAt = new Date();

  return prisma.game.update({
    where: { id: game.id },
    data,
  });
}
