/**
 * Cover art downloader.
 *
 * Fetches a VNDB cover image URL and saves it locally.
 * Uses Node.js 20 built-in `fetch` — no external dependencies.
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';

/**
 * Download a cover image to the local covers directory.
 *
 * @param {string}  imageUrl   - Direct image URL from VNDB.
 * @param {string}  gameId     - Game fingerprint ID (used as filename).
 * @param {string}  coversPath - Absolute path to the covers directory (e.g. "/covers").
 * @returns {Promise<string|null>} The relative path "/covers/{gameId}.jpg" on success, null on failure.
 */
export async function downloadCover(imageUrl, gameId, coversPath) {
  if (!imageUrl || !gameId || !coversPath) return null;

  const filename = `${gameId}.jpg`;
  const outputPath = join(coversPath, filename);

  // If the file already exists, skip download
  try {
    await access(outputPath);
    return `/covers/${filename}`;
  } catch {
    // File does not exist — proceed with download
  }

  try {
    // Ensure covers directory exists
    await mkdir(coversPath, { recursive: true });

    const res = await fetch(imageUrl, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error(
        `[CoverDownloader] Failed to fetch cover for ${gameId}: ${res.status} ${res.statusText}`
      );
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(outputPath, buffer);

    return `/covers/${filename}`;
  } catch (err) {
    console.error(
      `[CoverDownloader] Error downloading cover for ${gameId}:`,
      err.message
    );
    return null;
  }
}
