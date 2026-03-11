/**
 * VNDB API v2 client with rate limiting, exponential backoff, and circuit breaker.
 *
 * All queries use POST requests with JSON body to the /kana endpoint.
 * Optional API token support for higher rate limits.
 */

/** Fields requested from the VNDB API for VN queries */
const VN_FIELDS =
  'id, title, alttitle, description, image.url, released, length_minutes, rating, developers.name, tags.name, tags.spoiler, screenshots.url';

/** Maximum retries on 429 responses with exponential backoff */
const MAX_429_RETRIES = 3;

/** Base delay in ms for exponential backoff on 429 */
const BACKOFF_BASE_MS = 2000;

/** Circuit breaker: number of consecutive failures to trip */
const CIRCUIT_BREAKER_THRESHOLD = 5;

/** Circuit breaker: cooldown period in ms after tripping */
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

export class VNDBClient {
  /**
   * @param {object} opts
   * @param {string}  opts.apiBase         - Base URL (default: https://api.vndb.org/kana)
   * @param {number}  opts.rateDelayMs     - Minimum ms between requests (default: 200)
   * @param {number}  opts.matchThreshold  - Not used here but carried for convenience
   * @param {string}  [opts.apiToken]      - Optional VNDB API token for higher rate limits
   * @param {object}  [opts.logger]        - Optional pino-compatible logger
   */
  constructor({ apiBase, rateDelayMs, matchThreshold, apiToken, logger } = {}) {
    this.apiBase = apiBase || 'https://api.vndb.org/kana';
    this.matchThreshold = matchThreshold ?? 0.7;
    this.apiToken = apiToken || null;

    // If an API token is provided, allow shorter rate delays
    this.rateDelayMs = rateDelayMs ?? (this.apiToken ? 100 : 200);

    this.logger = logger || console;

    /** @type {Promise<void>} Resolves when the next request is allowed */
    this._gate = Promise.resolve();

    // ── Circuit breaker state ─────────────────────────────
    this._consecutiveFailures = 0;
    this._circuitOpenUntil = 0;
  }

  // ── Rate-limiting gate ──────────────────────────────────

  /**
   * Acquire a slot in the rate-limit queue.
   * Each caller awaits its turn, then the next caller is delayed by rateDelayMs.
   */
  _acquireSlot() {
    const prev = this._gate;
    let unlock;
    this._gate = new Promise((resolve) => {
      unlock = resolve;
    });
    const delayMs = this.rateDelayMs;

    return prev.then(() => {
      // After this request completes, release the gate after the delay
      setTimeout(unlock, delayMs);
    });
  }

  // ── Circuit breaker ─────────────────────────────────────

  /**
   * Check if the circuit breaker is open (requests should be blocked).
   * @returns {boolean}
   */
  _isCircuitOpen() {
    if (this._consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) {
      return false;
    }
    if (Date.now() < this._circuitOpenUntil) {
      return true;
    }
    // Cooldown expired — reset and allow a probe request
    this._consecutiveFailures = 0;
    this._circuitOpenUntil = 0;
    this.logger.info(
      { event: 'vndb_circuit_reset' },
      'VNDB circuit breaker reset after cooldown'
    );
    return false;
  }

  /**
   * Record a successful request (resets the failure counter).
   */
  _recordSuccess() {
    if (this._consecutiveFailures > 0) {
      this._consecutiveFailures = 0;
      this._circuitOpenUntil = 0;
    }
  }

  /**
   * Record a failed request and potentially trip the circuit breaker.
   */
  _recordFailure() {
    this._consecutiveFailures++;
    if (this._consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      this._circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
      this.logger.warn(
        {
          event: 'vndb_circuit_open',
          consecutiveFailures: this._consecutiveFailures,
          cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
        },
        `VNDB circuit breaker tripped after ${this._consecutiveFailures} consecutive failures — blocking requests for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s`
      );
    }
  }

  // ── Low-level POST ──────────────────────────────────────

  /**
   * Send a POST request to the VNDB API with automatic rate limiting,
   * exponential backoff on 429 responses, and circuit breaker protection.
   *
   * @param {string} path     - e.g. "/vn"
   * @param {object} body     - JSON body
   * @param {number} attempt  - current retry attempt (0-based, internal)
   * @returns {Promise<object|null>} parsed response body, or null on failure
   */
  async _post(path, body, attempt = 0) {
    // Check circuit breaker
    if (this._isCircuitOpen()) {
      this.logger.warn(
        { event: 'vndb_circuit_open_reject', path },
        'VNDB request rejected — circuit breaker is open'
      );
      return null;
    }

    await this._acquireSlot();

    try {
      const url = `${this.apiBase}${path}`;
      const headers = { 'Content-Type': 'application/json' };

      // Add authorization header if token is configured
      if (this.apiToken) {
        headers['Authorization'] = `Token ${this.apiToken}`;
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      // Rate-limited: exponential backoff with retries
      if (res.status === 429) {
        if (attempt < MAX_429_RETRIES) {
          const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt);
          this.logger.warn(
            {
              event: 'vndb_rate_limited',
              path,
              attempt: attempt + 1,
              maxRetries: MAX_429_RETRIES,
              backoffMs,
            },
            `VNDB 429 rate-limited — retrying in ${backoffMs / 1000}s (attempt ${attempt + 1}/${MAX_429_RETRIES})`
          );
          await new Promise((r) => setTimeout(r, backoffMs));
          return this._post(path, body, attempt + 1);
        }

        // Exhausted all retries
        this.logger.error(
          { event: 'vndb_rate_limit_exhausted', path, attempts: attempt + 1 },
          'VNDB rate limit retries exhausted'
        );
        this._recordFailure();
        return null;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logger.error(
          {
            event: 'vndb_api_error',
            path,
            status: res.status,
            statusText: res.statusText,
            responseBody: text.slice(0, 500),
          },
          `VNDB API error: ${res.status} ${res.statusText} for ${path}`
        );
        this._recordFailure();
        return null;
      }

      this._recordSuccess();
      return await res.json();
    } catch (err) {
      this.logger.error(
        { event: 'vndb_network_error', path, error: err.message },
        `VNDB network error for ${path}: ${err.message}`
      );
      this._recordFailure();
      return null;
    }
  }

  // ── Public methods ──────────────────────────────────────

  /**
   * Search VNDB for visual novels matching a title string.
   *
   * @param {string} title - The title to search for.
   * @returns {Promise<object[]>} Array of VN result objects (may be empty).
   */
  async searchByTitle(title) {
    const data = await this._post('/vn', {
      filters: ['search', '=', title],
      fields: VN_FIELDS,
      results: 5,
      sort: 'searchrank',
    });

    return data?.results ?? [];
  }

  /**
   * Fetch a specific VN by its VNDB ID (e.g. "v17").
   *
   * @param {string} vndbId - The VNDB identifier.
   * @returns {Promise<object|null>} A single VN object, or null if not found.
   */
  async getById(vndbId) {
    const data = await this._post('/vn', {
      filters: ['id', '=', vndbId],
      fields: VN_FIELDS,
      results: 1,
    });

    return data?.results?.[0] ?? null;
  }
}
