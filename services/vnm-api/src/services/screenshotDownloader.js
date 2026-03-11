/**
 * Screenshot downloader.
 *
 * Fetches VNDB screenshot image URLs and saves them locally,
 * mirroring the coverDownloader pattern.
 * Uses Node.js 20 built-in `fetch` — no external dependencies.
 *
 * Storage layout: /screenshots/{gameId}/0.jpg, 1.jpg, …
 */

import { mkdir, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Download an array of screenshot images to the local screenshots directory.
 *
 * Existing files are skipped (idempotent). On individual download failure,
 * the original remote URL is preserved as a fallback so the UI can still
 * render something.
 *
 * @param {string[]}  urls             - Direct image URLs from VNDB.
 * @param {string}    gameId           - Game fingerprint ID (used as subdirectory name).
 * @param {string}    screenshotsPath  - Absolute path to the screenshots root directory (e.g. "/screenshots").
 * @returns {Promise<string[]>} Array of local paths ("/screenshots/{gameId}/0.jpg") or original URLs on failure.
 */
export async function downloadScreenshots(urls, gameId, screenshotsPath) {
  if (!urls?.length || !gameId || !screenshotsPath) return [];

  const gameDir = join(screenshotsPath, gameId);

  // Ensure the per-game screenshot directory exists
  await mkdir(gameDir, { recursive: true });

  const localPaths = [];

  for (let i = 0; i < urls.length; i++) {
    const filename = `${i}.jpg`;
    const outputPath = join(gameDir, filename);
    const localPath = `/screenshots/${gameId}/${filename}`;

    // If the file already exists, skip download
    try {
      await access(outputPath);
      localPaths.push(localPath);
      continue;
    } catch {
      // File does not exist — proceed with download
    }

    try {
      const res = await fetch(urls[i], {
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        console.error(
          `[ScreenshotDownloader] Failed to fetch screenshot ${i} for ${gameId}: ${res.status} ${res.statusText}`
        );
        // Fall back to remote URL so UI can still display something
        localPaths.push(urls[i]);
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      await writeFile(outputPath, buffer);
      localPaths.push(localPath);
    } catch (err) {
      console.error(
        `[ScreenshotDownloader] Error downloading screenshot ${i} for ${gameId}:`,
        err.message
      );
      // Fall back to remote URL
      localPaths.push(urls[i]);
    }
  }

  return localPaths;
}

/**
 * Remove all cached screenshots for a game.
 *
 * @param {string} gameId           - Game fingerprint ID.
 * @param {string} screenshotsPath  - Absolute path to the screenshots root directory.
 */
export async function removeScreenshots(gameId, screenshotsPath) {
  if (!gameId || !screenshotsPath) return;

  const gameDir = join(screenshotsPath, gameId);
  try {
    await rm(gameDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}
