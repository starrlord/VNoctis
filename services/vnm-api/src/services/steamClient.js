/**
 * Steam Store client with app list caching, fuzzy search, and rate-limited
 * appdetails fetching.
 *
 * The full Steam app list (~120K entries) is cached on disk and loaded into
 * an in-memory Map for fast fuzzy name search.  The cache is refreshed lazily
 * when a search is requested and the cache is older than `ttlHours`.
 *
 * No external dependencies — uses Node.js built-in `fetch` and `fs`.
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeTitle } from './matcher.js';

// ── Constants ──────────────────────────────────────────────

/** Steam app lists (community-maintained, updated regularly) */
const APP_LIST_URLS = [
  'https://raw.githubusercontent.com/jsnli/steamappidlist/refs/heads/master/data/games_appid.json',
  'https://raw.githubusercontent.com/jsnli/steamappidlist/refs/heads/master/data/dlc_appid.json',
];

/** Steam Storefront API: app details */
const APP_DETAILS_BASE = 'https://store.steampowered.com/api/appdetails';

/** Steam CDN base for constructable asset URLs */
const CDN_BASE = 'https://cdn.akamai.steamstatic.com/steam/apps';

/** Maximum retries on transient errors */
const MAX_RETRIES = 2;

/** Backoff base in ms */
const BACKOFF_BASE_MS = 2000;

// ── Helpers ────────────────────────────────────────────────

/**
 * Dice coefficient between two normalised strings (same algo as matcher.js).
 * Inlined here to avoid importing a non-exported function.
 */
function bigrams(str) {
  const map = new Map();
  for (let i = 0; i < str.length - 1; i++) {
    const pair = str.slice(i, i + 2);
    map.set(pair, (map.get(pair) || 0) + 1);
  }
  return map;
}

function diceCoefficient(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);

  let intersection = 0;
  for (const [pair, countA] of bigramsA) {
    const countB = bigramsB.get(pair) || 0;
    intersection += Math.min(countA, countB);
  }

  const totalA = a.length - 1;
  const totalB = b.length - 1;

  return (2 * intersection) / (totalA + totalB);
}

/**
 * Compute similarity between two strings (normalised internally).
 * Same algorithm as matcher.js: dice + substring bonus.
 */
function similarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);

  if (!na || !nb) return 0;
  if (na === nb) return 1;

  let score = diceCoefficient(na, nb);

  // Substring bonus
  if (na.includes(nb) || nb.includes(na)) {
    score = Math.min(1.0, score + 0.2);
  }

  return score;
}

// ── SteamClient class ──────────────────────────────────────

export class SteamClient {
  /**
   * @param {object} opts
   * @param {string}  opts.cachePath     - Absolute path to the cached app list JSON (default: /data/steam-applist.json)
   * @param {number}  opts.ttlHours      - Hours before the cached app list is considered stale (default: 24)
   * @param {number}  opts.rateDelayMs   - Minimum ms between appdetails requests (default: 1500)
   * @param {object}  [opts.logger]      - Optional pino-compatible logger
   */
  constructor({ cachePath, ttlHours, rateDelayMs, logger } = {}) {
    this.cachePath = cachePath || '/data/steam-applist.json';
    this.ttlHours = ttlHours ?? 24;
    this.rateDelayMs = rateDelayMs ?? 1500;
    this.logger = logger || console;

    /** @type {Map<string, Array<{appid: number, name: string}>>|null} */
    this._index = null;

    /** @type {number} Timestamp (ms) when the in-memory index was last built */
    this._indexBuiltAt = 0;

    /** @type {Promise<void>|null} Prevents concurrent app-list fetches */
    this._loadingPromise = null;

    /** @type {Promise<void>} Rate-limit gate for appdetails requests */
    this._gate = Promise.resolve();
  }

  // ── Rate-limiting gate (appdetails) ──────────────────────

  /**
   * Acquire a slot in the rate-limit queue for appdetails calls.
   */
  _acquireSlot() {
    const prev = this._gate;
    let unlock;
    this._gate = new Promise((resolve) => {
      unlock = resolve;
    });
    const delayMs = this.rateDelayMs;

    return prev.then(() => {
      setTimeout(unlock, delayMs);
    });
  }

  // ── App list management ──────────────────────────────────

  /**
   * Ensure the in-memory app list index is loaded and fresh.
   * Lazy-initialises from disk or network as needed.
   */
  async _ensureAppList() {
    // If already loaded and fresh, return immediately
    if (this._index && !this._isStale()) {
      return;
    }

    // Prevent concurrent fetches
    if (this._loadingPromise) {
      await this._loadingPromise;
      return;
    }

    this._loadingPromise = this._loadAppList();
    try {
      await this._loadingPromise;
    } finally {
      this._loadingPromise = null;
    }
  }

  /**
   * Check if the in-memory index is stale (older than ttlHours).
   */
  _isStale() {
    if (!this._indexBuiltAt) return true;
    const ageMs = Date.now() - this._indexBuiltAt;
    return ageMs > this.ttlHours * 60 * 60 * 1000;
  }

  /**
   * Load the app list: try disk cache first, fall back to network fetch.
   */
  async _loadAppList() {
    // Try loading from disk
    const diskData = await this._loadFromDisk();

    if (diskData && !this._isDiskStale(diskData.fetchedAt)) {
      this._buildIndex(diskData.apps);
      this._indexBuiltAt = diskData.fetchedAt;
      this.logger.info(
        { event: 'steam_applist_loaded_from_disk', count: diskData.apps.length },
        `Steam app list loaded from disk cache (${diskData.apps.length} apps)`
      );
      return;
    }

    // Fetch from network
    await this._fetchAndCacheAppList();
  }

  /**
   * Check if a disk cache timestamp is stale.
   * @param {number} fetchedAt - ms timestamp
   */
  _isDiskStale(fetchedAt) {
    if (!fetchedAt) return true;
    const ageMs = Date.now() - fetchedAt;
    return ageMs > this.ttlHours * 60 * 60 * 1000;
  }

  /**
   * Load cached app list from disk.
   * @returns {Promise<{apps: Array<{appid: number, name: string}>, fetchedAt: number}|null>}
   */
  async _loadFromDisk() {
    try {
      const raw = await readFile(this.cachePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.apps?.length && parsed.fetchedAt) {
        return parsed;
      }
    } catch {
      // File doesn't exist or is corrupt — will fetch from network
    }
    return null;
  }

  /**
   * Save the app list to disk with a timestamp.
   * @param {Array<{appid: number, name: string}>} apps
   * @param {number} fetchedAt
   */
  async _saveToDisk(apps, fetchedAt) {
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(
        this.cachePath,
        JSON.stringify({ apps, fetchedAt }),
        'utf-8'
      );
    } catch (err) {
      this.logger.warn(
        { event: 'steam_applist_save_failed', error: err.message },
        'Failed to save Steam app list to disk'
      );
    }
  }

  /**
   * Fetch the full app list (games + DLC) and cache it.
   * Fetches both lists in parallel and merges them.
   */
  async _fetchAndCacheAppList() {
    this.logger.info(
      { event: 'steam_applist_fetching' },
      `Fetching Steam app lists (${APP_LIST_URLS.length} sources)…`
    );

    try {
      // Fetch all lists in parallel
      const responses = await Promise.all(
        APP_LIST_URLS.map((url) =>
          fetch(url, { signal: AbortSignal.timeout(90_000) })
        )
      );

      let allApps = [];

      for (let i = 0; i < responses.length; i++) {
        const res = responses[i];
        if (!res.ok) {
          this.logger.warn(
            { event: 'steam_applist_source_failed', url: APP_LIST_URLS[i], status: res.status },
            `Steam app list source returned ${res.status} — skipping`
          );
          continue;
        }

        const rawApps = await res.json();

        if (!Array.isArray(rawApps)) {
          this.logger.warn(
            { event: 'steam_applist_source_invalid', url: APP_LIST_URLS[i] },
            'Unexpected response structure — expected a JSON array, skipping'
          );
          continue;
        }

        // Filter out entries with empty names — use concat (spread would overflow stack on 200K+ items)
        const filtered = rawApps.filter((a) => a.name && a.name.trim());
        allApps = allApps.concat(filtered);
      }

      if (allApps.length === 0) {
        throw new Error('No apps retrieved from any source');
      }

      const fetchedAt = Date.now();
      this._buildIndex(allApps);
      this._indexBuiltAt = fetchedAt;

      // Save combined list to disk in the background
      this._saveToDisk(allApps, fetchedAt);

      this.logger.info(
        { event: 'steam_applist_fetched', count: allApps.length },
        `Steam app list fetched and indexed (${allApps.length} apps + DLC)`
      );
    } catch (err) {
      this.logger.error(
        { event: 'steam_applist_fetch_failed', error: err.message },
        `Failed to fetch Steam app list: ${err.message}`
      );
      throw err;
    }
  }

  /**
   * Build the in-memory search index from a list of apps.
   * Groups apps by normalised name for O(1) lookup of exact matches,
   * with fuzzy search falling back to iteration over unique names.
   *
   * @param {Array<{appid: number, name: string}>} apps
   */
  _buildIndex(apps) {
    const index = new Map();

    for (const app of apps) {
      const norm = normalizeTitle(app.name);
      if (!norm) continue;

      if (!index.has(norm)) {
        index.set(norm, []);
      }
      index.get(norm).push({ appid: app.appid, name: app.name });
    }

    this._index = index;
  }

  // ── Public: Search ───────────────────────────────────────

  /**
   * Search the cached Steam app list by name (fuzzy).
   * Throws if the app list cannot be loaded (caller should handle).
   *
   * @param {string} query - The game name to search for.
   * @param {number} [limit=10] - Maximum results to return.
   * @returns {Promise<Array<{appid: number, name: string, score: number}>>}
   */
  async searchByName(query, limit = 10) {
    await this._ensureAppList();

    const normQuery = normalizeTitle(query);
    if (!normQuery) return [];

    // Check for exact match first
    const exact = this._index.get(normQuery);
    if (exact) {
      return exact.slice(0, limit).map((a) => ({
        appid: a.appid,
        name: a.name,
        score: 1.0,
      }));
    }

    // Fuzzy search: score every unique normalised name, keep top matches
    const scored = [];

    for (const [normName, apps] of this._index) {
      const score = diceCoefficient(normQuery, normName);

      // Substring bonus (matching matcher.js logic)
      let finalScore = score;
      if (normQuery.includes(normName) || normName.includes(normQuery)) {
        finalScore = Math.min(1.0, score + 0.2);
      }

      if (finalScore >= 0.4) {
        // Use the first app entry for this normalised name
        scored.push({ appid: apps[0].appid, name: apps[0].name, score: finalScore });

        // If there are multiple apps with the same normalised name, include them
        for (let i = 1; i < apps.length && scored.length < limit * 3; i++) {
          scored.push({ appid: apps[i].appid, name: apps[i].name, score: finalScore });
        }
      }
    }

    // Sort by score descending, then by name length ascending (prefer shorter/exact titles)
    scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length);

    return scored.slice(0, limit);
  }

  // ── Public: App Details ──────────────────────────────────

  /**
   * Fetch full app details from the Steam Storefront API.
   *
   * @param {string|number} appid - Steam application ID.
   * @returns {Promise<object|null>} The app details object, or null on failure.
   */
  async getAppDetails(appid) {
    await this._acquireSlot();

    const url = `${APP_DETAILS_BASE}?appids=${appid}&l=english`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(15_000),
        });

        if (res.status === 429) {
          if (attempt < MAX_RETRIES) {
            const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt);
            this.logger.warn(
              { event: 'steam_rate_limited', appid, attempt: attempt + 1, backoffMs },
              `Steam rate-limited — retrying in ${backoffMs / 1000}s`
            );
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          this.logger.error(
            { event: 'steam_rate_limit_exhausted', appid },
            'Steam rate limit retries exhausted'
          );
          return null;
        }

        if (!res.ok) {
          this.logger.error(
            { event: 'steam_api_error', appid, status: res.status },
            `Steam API error: ${res.status} ${res.statusText}`
          );
          return null;
        }

        const data = await res.json();
        const entry = data?.[String(appid)];

        if (!entry?.success || !entry?.data) {
          this.logger.warn(
            { event: 'steam_app_not_found', appid },
            `Steam app ${appid} not found or response unsuccessful`
          );
          return null;
        }

        return entry.data;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt);
          this.logger.warn(
            { event: 'steam_network_error', appid, attempt: attempt + 1, error: err.message },
            `Steam network error — retrying in ${backoffMs / 1000}s`
          );
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        this.logger.error(
          { event: 'steam_network_error_exhausted', appid, error: err.message },
          `Steam network error for app ${appid}: ${err.message}`
        );
        return null;
      }
    }

    return null;
  }

  // ── Public: Asset URL helpers ────────────────────────────

  /**
   * Get the library capsule image URL for a Steam app.
   * This is the preferred cover image — 600×900 (2:3 portrait ratio),
   * matching the GalleryCard's aspect-[2/3] perfectly.
   *
   * @param {string|number} appid
   * @returns {string}
   */
  static getLibraryCapsuleUrl(appid) {
    return `${CDN_BASE}/${appid}/library_600x900.jpg`;
  }

  /**
   * Get the hero capsule image URL for a Steam app (fallback cover).
   * ~374×448, slightly squarish portrait.
   *
   * @param {string|number} appid
   * @returns {string}
   */
  static getHeroCapsuleUrl(appid) {
    return `${CDN_BASE}/${appid}/hero_capsule.jpg`;
  }

  /**
   * Get the header image URL for a Steam app (fallback cover).
   *
   * @param {string|number} appid
   * @returns {string}
   */
  static getHeaderUrl(appid) {
    return `${CDN_BASE}/${appid}/header.jpg`;
  }

  /**
   * Get the wide capsule image URL for a Steam app.
   *
   * @param {string|number} appid
   * @returns {string}
   */
  static getCapsuleUrl(appid) {
    return `${CDN_BASE}/${appid}/capsule_616x353.jpg`;
  }
}
