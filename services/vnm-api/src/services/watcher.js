import { watch } from 'node:fs';
import { readdir } from 'node:fs/promises';

/**
 * File system watcher that monitors a games directory for changes.
 * Debounces rapid events and falls back to polling when fs.watch
 * is unreliable (e.g., Docker volumes, network mounts).
 */
export class DirectoryWatcher {
  /**
   * @param {string} gamesPath - The /games directory to watch
   * @param {() => Promise<void>} onChangeCallback - Async function invoked on detected changes
   * @param {{ debounceMs?: number, pollIntervalMs?: number }} options
   */
  constructor(gamesPath, onChangeCallback, options = {}) {
    this.gamesPath = gamesPath;
    this.onChangeCallback = onChangeCallback;
    this.debounceMs = options.debounceMs ?? 5000;
    this.pollIntervalMs = options.pollIntervalMs ?? 60000;
    this.logger = options.logger || console;

    /** @type {import('node:fs').FSWatcher | null} */
    this._fsWatcher = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._pollTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._debounceTimer = null;
    /** @type {Set<string>} */
    this._lastSnapshot = new Set();
    this._running = false;
    this._callbackInProgress = false;
  }

  /**
   * Start watching the games directory.
   * Tries fs.watch first; falls back to polling if it fails.
   */
  async start() {
    if (this._running) return;
    this._running = true;

    // Take initial snapshot for polling comparison
    this._lastSnapshot = await this._getDirectorySnapshot();

    // Try native fs.watch
    try {
      this._fsWatcher = watch(this.gamesPath, { recursive: true }, (eventType, filename) => {
        // Only trigger on 'rename' events (file/dir added/removed)
        if (eventType === 'rename') {
          this._scheduleCallback();
        }
      });

      this._fsWatcher.on('error', (err) => {
        this.logger.warn?.({ err: err.message }, 'fs.watch error, falling back to polling');
        this._stopFsWatch();
        this._startPolling();
      });

      this.logger.info?.('Directory watcher started (fs.watch mode)');
    } catch (err) {
      this.logger.warn?.(
        { err: err.message },
        'fs.watch not available, using polling fallback'
      );
      this._startPolling();
    }
  }

  /**
   * Stop all watching — close fs.watch handle and clear polling interval.
   */
  stop() {
    this._running = false;
    this._stopFsWatch();
    this._stopPolling();
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this.logger.info?.('Directory watcher stopped');
  }

  /**
   * Schedule the change callback with debouncing.
   * Multiple rapid events will be collapsed into a single callback invocation.
   */
  _scheduleCallback() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(async () => {
      this._debounceTimer = null;
      await this._invokeCallback();
    }, this.debounceMs);
  }

  /**
   * Invoke the onChange callback, preventing concurrent executions.
   */
  async _invokeCallback() {
    if (this._callbackInProgress) return;
    this._callbackInProgress = true;
    try {
      this.logger.info?.('Directory change detected, running rescan…');
      await this.onChangeCallback();
      this.logger.info?.('Rescan completed');
    } catch (err) {
      this.logger.warn?.({ err: err.message }, 'Rescan callback failed');
    } finally {
      this._callbackInProgress = false;
      // Update snapshot after callback
      this._lastSnapshot = await this._getDirectorySnapshot();
    }
  }

  /**
   * Start polling fallback — checks directory listing at regular intervals.
   */
  _startPolling() {
    if (this._pollTimer) return;

    this._pollTimer = setInterval(async () => {
      try {
        const current = await this._getDirectorySnapshot();
        if (this._hasSnapshotChanged(current)) {
          this._lastSnapshot = current;
          await this._invokeCallback();
        }
      } catch (err) {
        this.logger.warn?.({ err: err.message }, 'Polling check failed');
      }
    }, this.pollIntervalMs);

    // Don't prevent process exit
    if (this._pollTimer.unref) this._pollTimer.unref();

    this.logger.info?.(
      { intervalMs: this.pollIntervalMs },
      'Directory watcher started (polling mode)'
    );
  }

  /**
   * Stop polling.
   */
  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Stop fs.watch.
   */
  _stopFsWatch() {
    if (this._fsWatcher) {
      this._fsWatcher.close();
      this._fsWatcher = null;
    }
  }

  /**
   * Get a snapshot of top-level directory names in the games path.
   * @returns {Promise<Set<string>>}
   */
  async _getDirectorySnapshot() {
    try {
      const entries = await readdir(this.gamesPath, { withFileTypes: true });
      return new Set(
        entries.filter((e) => e.isDirectory()).map((e) => e.name)
      );
    } catch {
      return new Set();
    }
  }

  /**
   * Compare current snapshot against the last known snapshot.
   * @param {Set<string>} current
   * @returns {boolean} true if directories were added or removed
   */
  _hasSnapshotChanged(current) {
    if (current.size !== this._lastSnapshot.size) return true;
    for (const name of current) {
      if (!this._lastSnapshot.has(name)) return true;
    }
    return false;
  }
}
