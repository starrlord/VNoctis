import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import useAuth from '../hooks/useAuth';
import api from '../hooks/useApi';
import SaveBackupModal from '../components/SaveBackupModal';
import { listOfflineGames } from '../utils/offlineStore';
import {
  checkOfflineGame,
  prepareOfflineGame,
  removeOfflineGame,
} from '../utils/offlineGames';
import { listGameDownloads } from '../utils/gameCache';

const secondary =
  'inline-flex items-center justify-center gap-2 min-h-[44px] px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed';
const primary = secondary.replace(
  'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600',
  'bg-blue-600 text-white hover:bg-blue-500'
);
const size = (value) => {
  if (!value) return '0 B';
  const unit = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
};
const title = (game) =>
  game.vndbTitle || game.extractedTitle || game.directoryName || game.id;
function DownloadIcon() {
  return (
    <svg
      className="w-5 h-5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5"
      />
    </svg>
  );
}
function Dialog({ title: heading, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement,
      overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector('button,select')?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);
  return (
    <div
      className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="offline-dialog-title"
        className="w-full max-w-lg max-h-[90dvh] overflow-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-2xl"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
          if (event.key === 'Tab') {
            const controls = [
              ...ref.current.querySelectorAll(
                'button:not(:disabled),select:not(:disabled),a[href]'
              ),
            ];
            if (!controls.length) return;
            const first = controls[0],
              last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 id="offline-dialog-title" className="text-lg font-semibold">
            {heading}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="min-w-[44px] min-h-[44px] rounded-lg text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            ×
          </button>
        </div>
        <div className="p-6 space-y-4">{children}</div>
      </div>
    </div>
  );
}
export default function Dashboard() {
  const { user, isOffline } = useAuth();
  const [backupOpen, setBackupOpen] = useState(false);
  const [games, setGames] = useState([]),
    [rows, setRows] = useState([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [modal, setModal] = useState(null),
    [selected, setSelected] = useState(''),
    [estimate, setEstimate] = useState(null),
    [estimateError, setEstimateError] = useState('');
  const [operation, setOperation] = useState(null),
    [retention, setRetention] = useState(''),
    [protectedStorage, setProtectedStorage] = useState(false);
  const controller = useRef(null),
    lastProgress = useRef(0),
    mounted = useRef(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const records = await listOfflineGames(user.userId),
        downloads = await listGameDownloads(
          records.map((record) => record.cacheName)
        ).catch(() => []);
      const next = [];
      for (const record of records) {
        const state = await checkOfflineGame(record).catch(() => ({
          ready: false,
          reason: 'Storage could not be checked',
        }));
        const downloaded = downloads.find(
          (item) => item.name === record.cacheName
        );
        next.push({
          ...record,
          state,
          bytes: downloaded?.bytes || record.assetBytes || 0,
          files: downloaded?.files || record.assetFiles || 0,
        });
      }
      if (mounted.current) {
        setRows(
          next.sort((a, b) => title(a.game).localeCompare(title(b.game)))
        );
        setProtectedStorage((await navigator.storage?.persisted?.()) || false);
      }
    } catch (error) {
      if (mounted.current) setError(error.message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [user.userId]);
  useEffect(() => {
    mounted.current = true;
    refresh();
    if (!isOffline)
      api
        .get('/library')
        .then((data) => {
          if (mounted.current)
            setGames(
              data.filter(
                (game) =>
                  ['built', 'stale'].includes(game.buildStatus) &&
                  game.webBuildPath?.startsWith('/web-builds/')
              )
            );
        })
        .catch(() => {});
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [refresh, isOffline]);
  useEffect(() => {
    setEstimate(null);
    setEstimateError('');
    if (!selected) return;
    let cancelled = false;
    api
      .get(`/games/${selected}/offline-manifest`)
      .then((data) => {
        if (!cancelled)
          setEstimate(data.files.reduce((sum, file) => sum + file.size, 0));
      })
      .catch((error) => {
        if (!cancelled) setEstimateError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);
  const prepare = async (game) => {
    setModal(null);
    setError('');
    const aborter = new AbortController();
    controller.current = aborter;
    setOperation({
      gameId: game.id,
      stage: 'Preparing app files',
      files: 0,
      totalFiles: 0,
    });
    try {
      await prepareOfflineGame(game, user.userId, {
        signal: aborter.signal,
        onProgress: (progress) => {
          const now = Date.now();
          if (
            now - lastProgress.current > 150 ||
            progress.files === progress.totalFiles ||
            progress.stage !== 'Preparing game files'
          ) {
            lastProgress.current = now;
            if (mounted.current) setOperation({ gameId: game.id, ...progress });
          }
        },
      });
    } catch (error) {
      if (mounted.current)
        setError(
          error.name === 'AbortError'
            ? 'Preparation cancelled. Files already downloaded can be reused.'
            : error.name === 'QuotaExceededError'
              ? 'Browser storage is full. Remove other downloads or free space, then try again. Completed files can be reused.'
              : error.message
        );
    } finally {
      controller.current = null;
      if (mounted.current) {
        setOperation(null);
        await refresh();
      }
    }
  };
  const verify = async (row) => {
    setError('');
    setOperation({ gameId: row.game.id, stage: 'Verifying downloaded files' });
    try {
      const state = await checkOfflineGame(row, { deep: true });
      if (!state.ready) setError(state.reason);
      await refresh();
    } catch (error) {
      setError(error.message);
    } finally {
      setOperation(null);
    }
  };
  const remove = async () => {
    const row = modal.record;
    setModal(null);
    setOperation({ gameId: row.game.id, stage: 'Removing game downloads' });
    try {
      await removeOfflineGame(row);
      await refresh();
    } catch (error) {
      setError(error.message);
    } finally {
      setOperation(null);
    }
  };
  const protect = async () => {
    setRetention('requesting');
    try {
      const accepted = await navigator.storage.persist();
      setProtectedStorage(accepted);
      setRetention(accepted ? 'granted' : 'denied');
    } catch {
      setRetention('unavailable');
    }
  };
  const busy = Boolean(operation),
    selectedGame = games.find((game) => game.id === selected);
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Your dashboard</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {user.username} · Downloads on this browser
          </p>
        </div>
        {isOffline && (
          <span className="rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 px-3 py-1 text-sm">
            Offline
          </span>
        )}
      </div>
      {isOffline && (
        <div
          role="status"
          className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4 flex flex-wrap items-center justify-between gap-3 text-sm"
        >
          <p>
            Showing this account’s retained games. Connect to the server to
            update games and saves.
          </p>
          <button
            className={secondary}
            onClick={() => window.location.reload()}
          >
            Reconnect
          </button>
        </div>
      )}
      <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 sm:p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <DownloadIcon />
              Offline games
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
              Prepare all game files and current saves to play without a
              connection while signed in. Regular play keeps downloads as you
              go.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className={secondary}
              onClick={refresh}
              disabled={busy || loading}
            >
              Refresh storage
            </button>
            <button
              className={primary}
              disabled={busy || isOffline}
              onClick={() => {
                setSelected('');
                setModal({ type: 'prepare' });
              }}
            >
              <DownloadIcon />
              Prepare a game
            </button>
          </div>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Offline progress stays in this browser and uploads when you reconnect.
          Another device’s newer progress remains on the server; both versions
          are preserved in save history.
        </p>
        {error && (
          <div
            role="alert"
            className="rounded-lg bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 p-3 text-sm"
          >
            {error}
          </div>
        )}
        {operation && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 p-4 space-y-2"
          >
            <div className="flex flex-wrap justify-between gap-3">
              <p className="font-medium text-sm">
                {operation.stage}
                {operation.totalFiles
                  ? ` · ${operation.files} / ${operation.totalFiles} files`
                  : ''}
              </p>
              {controller.current && (
                <button
                  onClick={() => controller.current.abort()}
                  className={secondary}
                >
                  Cancel preparation
                </button>
              )}
            </div>
            {operation.totalFiles > 0 && (
              <progress
                className="w-full h-2 accent-blue-600"
                max={operation.totalFiles}
                value={operation.files}
                aria-label={operation.stage}
              />
            )}
          </div>
        )}
        {loading ? (
          <p
            role="status"
            className="text-sm text-gray-500 dark:text-gray-400 py-4"
          >
            Checking browser storage…
          </p>
        ) : !rows.length ? (
          <div className="text-center py-10 text-gray-500 dark:text-gray-400">
            <p className="font-medium">
              No games retained for this account yet
            </p>
            <p className="text-sm mt-2">
              Play a game online or choose one to prepare for offline play.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-200 dark:divide-gray-700">
            {rows.map((row) => (
              <li
                key={row.game.id}
                className="py-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="font-medium break-words">{title(row.game)}</p>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    {size(row.bytes)} · {row.files} game files
                  </p>
                  <p
                    className={
                      'inline-block mt-2 rounded-full px-2.5 py-1 text-xs font-medium ' +
                      (row.state.ready
                        ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-200'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300')
                    }
                  >
                    {row.state.ready
                      ? row.state.localChanges
                        ? 'Available offline · sync pending'
                        : 'Ready offline'
                      : row.state.reason}
                  </p>
                  {row.preparedAt && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      Prepared {new Date(row.preparedAt).toLocaleString()}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 shrink-0">
                  {(!isOffline || row.state.ready) && (
                    <Link className={primary} to={`/play/${row.game.id}`}>
                      Play
                    </Link>
                  )}
                  {!isOffline && (
                    <button
                      className={secondary}
                      disabled={busy}
                      onClick={() =>
                        prepare(
                          games.find((game) => game.id === row.game.id) ||
                            row.game
                        )
                      }
                    >
                      {row.prepared
                        ? 'Update offline files'
                        : 'Prepare offline'}
                    </button>
                  )}
                  {row.prepared && (
                    <button
                      className={secondary}
                      disabled={busy}
                      onClick={() => verify(row)}
                    >
                      Verify
                    </button>
                  )}
                  <button
                    className={secondary}
                    disabled={busy}
                    onClick={() => setModal({ type: 'remove', record: row })}
                  >
                    Remove downloads
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t border-gray-200 dark:border-gray-700 pt-4 text-sm text-gray-500 dark:text-gray-400 space-y-2">
          <p>
            {protectedStorage
              ? 'Persistent storage is enabled. Browser data can still be cleared manually.'
              : 'Your browser may remove downloaded files when storage is needed. Readiness is checked when you open this dashboard.'}
          </p>
          {!protectedStorage && navigator.storage?.persist && (
            <button
              className={secondary}
              disabled={
                retention === 'requesting' ||
                retention === 'denied' ||
                retention === 'unavailable'
              }
              onClick={protect}
            >
              {retention === 'requesting'
                ? 'Asking browser…'
                : retention === 'denied'
                  ? 'Protection not granted'
                  : retention === 'unavailable'
                    ? 'Protection unavailable'
                    : 'Protect downloaded files'}
            </button>
          )}
          {['denied', 'unavailable'].includes(retention) && (
            <p role="status">
              Downloads still work. This browser could not protect them from
              automatic cleanup.
            </p>
          )}
        </div>
      </section>
      <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 sm:p-6 space-y-3">
        <h2 className="text-lg font-semibold">Save backups</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">Export or import synced saves and history across all games. Missing games retain their saves for later installation.</p>
        <button className={primary} disabled={isOffline} onClick={()=>setBackupOpen(true)}>Manage save backups</button>
      </section>
      {backupOpen&&<SaveBackupModal onClose={()=>setBackupOpen(false)}/>}
      {modal?.type === 'prepare' && (
        <Dialog
          title="Prepare a game for offline play"
          onClose={() => setModal(null)}
        >
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Downloads the complete game and its current saves on this device.
            You can cancel and reuse completed downloads later.
          </p>
          <label className="block text-sm font-medium" htmlFor="offline-game">
            Game
          </label>
          <select
            id="offline-game"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Choose a built game…</option>
            {games.map((game) => (
              <option key={game.id} value={game.id}>
                {title(game)}
              </option>
            ))}
          </select>
          {!games.length && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Build a local game before preparing it.
            </p>
          )}
          {estimate !== null && (
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {size(estimate)} of game files, plus saves. Existing verified
              files are reused.
            </p>
          )}
          {estimateError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {estimateError}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button className={secondary} onClick={() => setModal(null)}>
              Cancel
            </button>
            <button
              className={primary}
              disabled={
                !selectedGame || estimate === null || Boolean(estimateError)
              }
              onClick={() => prepare(selectedGame)}
            >
              <DownloadIcon />
              Prepare offline
            </button>
          </div>
        </Dialog>
      )}
      {modal?.type === 'remove' && (
        <Dialog
          title="Remove downloaded game files?"
          onClose={() => setModal(null)}
        >
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Remove retained game files for{' '}
            <strong>{title(modal.record.game)}</strong> from this account’s
            offline library? Browser saves and pending uploads will be kept.
            Files still used by another account are retained.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <button className={secondary} onClick={() => setModal(null)}>
              Cancel
            </button>
            <button
              className={primary.replace(
                'bg-blue-600 text-white hover:bg-blue-500',
                'bg-red-600 text-white hover:bg-red-500'
              )}
              onClick={remove}
            >
              Remove downloads
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
