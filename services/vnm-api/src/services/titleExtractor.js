import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Attempt to extract the game title from game/options.rpy.
 * Looks for:  config.name = "Some Title"  or  config.name = 'Some Title'
 *
 * @param {string} gamePath - Absolute path to the game root directory.
 * @returns {Promise<string|null>} The extracted title, or null if not found.
 */
export async function extractTitleFromOptions(gamePath) {
  const optionsPath = join(gamePath, 'game', 'options.rpy');

  try {
    const content = await readFile(optionsPath, 'utf-8');
    // Match config.name = "Title" or config.name = 'Title'
    // Also handles define config.name = "Title"
    const match = content.match(/config\.name\s*=\s*["'](.+?)["']/);
    return match ? match[1].trim() : null;
  } catch {
    // File doesn't exist or can't be read
    return null;
  }
}

/**
 * Clean a directory name into a presentable game title.
 *
 * - Strips common platform/version suffixes (-pc, -win, -mac, -linux, -all, -v1.0, -0.5, etc.)
 * - Replaces underscores and hyphens with spaces
 * - Title-cases the result
 *
 * @param {string} dirName - Raw directory name.
 * @returns {string} Cleaned, title-cased name.
 */
export function cleanDirectoryName(dirName) {
  let cleaned = dirName;

  // Remove common platform and version suffixes
  // Order matters: try the most specific patterns first
  cleaned = cleaned.replace(
    /[-_ ]+(v?\d+\.\d+(\.\d+)?[-_ ]*)?(pc|win|mac|linux|all|android|ios)$/i,
    ''
  );
  // Remove standalone version patterns at the end (e.g., "-1.0", "-v0.5.2")
  cleaned = cleaned.replace(/[-_ ]+v?\d+\.\d+(\.\d+)?$/i, '');

  // Replace underscores and hyphens with spaces
  cleaned = cleaned.replace(/[_-]+/g, ' ');

  // Collapse multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Title-case: capitalize the first letter of each word
  cleaned = cleaned.replace(/\b\w/g, (c) => c.toUpperCase());

  return cleaned || dirName;
}
