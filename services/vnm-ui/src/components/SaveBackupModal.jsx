import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../hooks/useApi';
import useAuth from '../hooks/useAuth';
import { downloadSaveBackup, exportSaveBackup } from '../utils/saveBackups';
const secondary =
  'inline-flex items-center justify-center gap-2 min-h-[44px] px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed';
const primary = secondary.replace(
  'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600',
  'bg-blue-600 text-white hover:bg-blue-500'
);
const select =
  'w-full min-h-[44px] rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500';
const size = (bytes) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : `${Math.ceil(bytes / 1024)} KB`;
const tasksWorking = (job) =>
  ['queued', 'working', 'uploading'].includes(job.status);
export function SaveBackupControls({ gameId = null, title, onImported }) {
  const { user, isAdmin, isOffline } = useAuth();
  const [allUsers, setAllUsers] = useState(false),
    [jobs, setJobs] = useState([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [review, setReview] = useState(null),
    [contents, setContents] = useState(null),
    [plan, setPlan] = useState(null),
    [choices, setChoices] = useState({}),
    [closed, setClosed] = useState(false),
    [notice, setNotice] = useState('');
  const [preparing, setPreparing] = useState(false);
  const picker = useRef(null),
    mounted = useRef(true),
    controller = useRef(null),
    refreshing = useRef(false),
    importing = useRef(null);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const data = await api.get('/save-backups/jobs');
      if (mounted.current) {
        setJobs(
          data.items.filter((job) => !gameId || job.scope !== 'all-users')
        );
        if (
          importing.current &&
          data.items.some(
            (job) => job.id === importing.current && job.status === 'done'
          )
        ) {
          importing.current = null;
          onImported?.();
        }
      }
    } catch (error) {
      if (mounted.current && !isOffline) setError(error.message);
    } finally {
      refreshing.current = false;
    }
  }, [isOffline, gameId, onImported]);
  useEffect(() => {
    mounted.current = true;
    if (!isOffline) refresh();
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [refresh, isOffline]);
  useEffect(() => {
    if (!jobs.some(tasksWorking)) return;
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [jobs, refresh]);
  const openReview = async (job) => {
    setBusy(true);
    setError('');
    setPlan(null);
    setReview(job);
    setClosed(false);
    try {
      const info = await api.get('/save-backups/jobs/' + job.id + '/contents');
      setContents(info);
      setChoices({
        sourceAccount:
          info.accounts.find((account) => account.username === user.username)
            ?.key || info.accounts[0]?.key,
        replace: false,
        accounts: {},
        games: {},
        ...(gameId ? { onlyGameId: gameId } : {}),
      });
    } catch (error) {
      setError(error.message);
      setReview(null);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!review || !contents) return;
    let cancelled = false;
    setPreparing(true);
    setClosed(false);
    const timer = setTimeout(
      () =>
        api
          .post('/save-backups/jobs/' + review.id + '/preview', choices)
          .then((data) => {
            if (!cancelled) {
              setPlan(data);
              setError('');
            }
          })
          .catch((error) => {
            if (!cancelled) {
              setPlan(null);
              setError(error.message);
            }
          })
          .finally(() => {
            if (!cancelled) setPreparing(false);
          }),
      150
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [review, contents, choices]);
  const choose = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setError('Choose a VNoctis save backup ZIP.');
      return;
    }
    setError('');
    setNotice('');
    setBusy(true);
    setPlan(null);
    setReview(null);
    setContents(null);
    try {
      const form = new FormData();
      form.append('backup', file);
      await api.upload(
        '/save-backups/imports' + (allUsers && !gameId ? '?allUsers=1' : ''),
        form
      );
      await refresh();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  };
  const doExport = async () => {
    setError('');
    setNotice('Preparing your save backup…');
    setBusy(true);
    const aborter = new AbortController();
    controller.current = aborter;
    try {
      await exportSaveBackup(
        { allUsers },
        {
          signal: aborter.signal,
          onProgress: (job) => {
            if (mounted.current)
              setNotice(job.progress?.stage || 'Preparing backup…');
          },
        }
      );
      if (mounted.current)
        setNotice(
          'Backup download started. Keep the ZIP intact to import it into VNoctis.'
        );
    } catch (error) {
      if (mounted.current && error.name !== 'AbortError')
        setError(error.message);
    } finally {
      if (mounted.current) {
        setBusy(false);
        refresh();
      }
    }
  };
  const apply = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/save-backups/jobs/' + review.id + '/apply', {
        planId: plan.id,
      });
      setPlan(null);
      setReview(null);
      setContents(null);
      setNotice(
        'Import started. You can close this window and check its progress on your dashboard.'
      );
      importing.current = review.id;
      await refresh();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (job) => {
    setBusy(true);
    try {
      await api.delete('/save-backups/jobs/' + job.id);
      await refresh();
      if (review?.id === job.id) {
        setReview(null);
        setPlan(null);
        setContents(null);
      }
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {gameId
          ? `Import a VNoctis backup for ${title || 'this game'}.`
          : 'Back up synced saves and retained history across all games, including games no longer installed.'}{' '}
        These ZIPs are designed for restoring into VNoctis. Desktop-game
        compatibility is not guaranteed.
      </p>
      {!gameId && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Game files, passwords and account roles are not included. Missing
          games retain their saves and reconnect when installed under the same
          directory name. Offline browser progress must sync before it can be
          exported.
        </p>
      )}
      {isAdmin && !gameId && (
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 accent-blue-600"
            checked={allUsers}
            disabled={busy || isOffline}
            onChange={(event) => setAllUsers(event.target.checked)}
          />
          <span>All users (administrator backup and restore)</span>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        {!gameId && (
          <button
            className={primary}
            disabled={busy || isOffline}
            onClick={doExport}
          >
            Export {allUsers ? 'all users’ saves' : 'my saves'}
          </button>
        )}
        <button
          className={secondary}
          disabled={busy || isOffline}
          onClick={() => picker.current?.click()}
        >
          Import backup ZIP
        </button>
        <button
          className={secondary}
          disabled={busy || isOffline}
          onClick={refresh}
        >
          Refresh backups
        </button>
        <input
          ref={picker}
          type="file"
          accept=".zip,application/zip"
          hidden
          aria-label="VNoctis save backup"
          onChange={choose}
        />
      </div>
      {isOffline && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          Connect to the server to export or import saves.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-blue-700 dark:text-blue-300">
          {notice}
        </p>
      )}
      {review && contents && (
        <div className="rounded-lg border border-blue-300 dark:border-blue-800 p-4 space-y-4">
          <h3 className="font-semibold">Review save import</h3>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Existing progress is kept by default. Backup versions are added to
            history. Close affected games before importing; active devices may
            have newer, unsynced progress.
          </p>
          {review.scope !== 'all-users' && contents.accounts.length > 1 && (
            <label className="block text-sm">
              Source account
              <select
                aria-label="Backup source account"
                className={select}
                value={choices.sourceAccount || ''}
                onChange={(event) =>
                  setChoices((value) => ({
                    ...value,
                    sourceAccount: event.target.value,
                  }))
                }
              >
                {contents.accounts.map((account) => (
                  <option key={account.key} value={account.key}>
                    {account.username}
                  </option>
                ))}
              </select>
            </label>
          )}
          {review.scope === 'all-users' && (
            <div className="space-y-3">
              <h4 className="text-sm font-medium">Account mappings</h4>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Missing users are created as viewers with no known password. Set
                their passwords in Users after restoring. Existing roles and
                passwords stay intact.
              </p>
              {contents.accounts.map((account) => (
                <label key={account.key} className="block text-sm break-words">
                  {account.username}
                  <select
                    aria-label={`Account mapping for ${account.username}`}
                    className={select}
                    value={
                      choices.accounts?.[account.key] ||
                      plan?.accounts.find((row) => row.source === account.key)
                        ?.target ||
                      contents.users.find(
                        (user) => user.username === account.username
                      )?.id ||
                      'create'
                    }
                    onChange={(event) =>
                      setChoices((value) => ({
                        ...value,
                        accounts: {
                          ...value.accounts,
                          [account.key]: event.target.value,
                        },
                      }))
                    }
                  >
                    <option
                      value="create"
                      disabled={contents.users.some(
                        (user) => user.username === account.username
                      )}
                    >
                      Create {account.username}
                    </option>
                    {contents.users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.username}
                      </option>
                    ))}
                    <option value="skip">Skip this account</option>
                  </select>
                </label>
              ))}
            </div>
          )}
          {!gameId && (
            <details className="text-sm" open={contents.legacy || undefined}>
              <summary className="cursor-pointer min-h-[44px] flex items-center">
                Review game mappings
              </summary>
              <div className="space-y-3">
                {contents.games.map((game) => (
                  <label key={game.id} className="block break-words">
                    {game.title}
                    <select
                      aria-label={`Game mapping for ${game.title}`}
                      className={select}
                      value={
                        choices.games?.[game.id] ||
                        (plan?.rows.find((row) => row.sourceGameId === game.id)
                          ?.installed &&
                          plan?.rows.find((row) => row.sourceGameId === game.id)
                            ?.gameId) ||
                        'orphan'
                      }
                      onChange={(event) =>
                        setChoices((value) => ({
                          ...value,
                          games: {
                            ...value.games,
                            [game.id]: event.target.value,
                          },
                        }))
                      }
                    >
                      <option value="orphan">
                        {contents.legacy
                          ? 'Choose destination game'
                          : 'Keep original identity (not installed)'}
                      </option>
                      {contents.installedGames.map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.extractedTitle || target.directoryName}
                        </option>
                      ))}
                      <option value="skip">Skip this game</option>
                    </select>
                  </label>
                ))}
              </div>
            </details>
          )}
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={choices.replace || false}
              onChange={(event) => {
                setClosed(false);
                setChoices((value) => ({
                  ...value,
                  replace: event.target.checked,
                }));
              }}
              className="mt-1 accent-blue-600"
            />
            <span>
              Replace current synced progress with the backup. Current progress
              will remain in history.
            </span>
          </label>
          {preparing ? (
            <p
              role="status"
              className="text-sm text-gray-500 dark:text-gray-400"
            >
              Checking destinations…
            </p>
          ) : (
            plan && (
              <>
                <p className="text-sm">
                  {plan.summary.games} game/account records ·{' '}
                  {plan.summary.versions} historical versions ·{' '}
                  {plan.summary.orphaned} records for missing games ·{' '}
                  {plan.summary.replacements} current snapshots to replace
                </p>
                <ul className="space-y-2 max-h-48 overflow-auto text-sm">
                  {plan.rows.map((row) => (
                    <li
                      key={row.sourceAccount + ':' + row.sourceGameId}
                      className="break-words"
                    >
                      <strong>{row.title}</strong>
                      {review.scope === 'all-users' && (
                        <span>
                          {' '}
                          (
                          {
                            plan.accounts.find(
                              (account) => account.source === row.sourceAccount
                            )?.targetUsername
                          }
                          )
                        </span>
                      )}{' '}
                      —{' '}
                      {row.installed
                        ? 'Installed'
                        : 'Retained for later installation'}{' '}
                      ·{' '}
                      {row.action === 'keep'
                        ? 'Keep current progress'
                        : row.action === 'replace'
                          ? 'Replace current progress'
                          : row.action === 'restore'
                            ? 'Restore progress'
                            : 'History only'}
                      {row.remapDirectory && (
                        <span className="block text-xs text-amber-700 dark:text-amber-300">
                          Save directory will map from {row.originalDirectory}{' '}
                          to {row.saveDirectory}.
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )
          )}
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={closed}
              onChange={(event) => setClosed(event.target.checked)}
              className="mt-1 accent-blue-600"
            />
            <span>
              I have reviewed the destinations and closed the affected games.
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              className={primary}
              disabled={busy || preparing || !plan?.rows.length || !closed}
              onClick={apply}
            >
              Import reviewed saves
            </button>
            <button
              className={secondary}
              disabled={busy}
              onClick={() => {
                setReview(null);
                setContents(null);
                setPlan(null);
              }}
            >
              Cancel review
            </button>
          </div>
        </div>
      )}
      {!!jobs.length && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Recent backup tasks</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Temporary uploads and downloads expire after 24 hours. Completed
            imports remain saved.
          </p>
          {jobs.slice(0, 10).map((job) => (
            <div
              key={job.id}
              className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2"
            >
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <span className="font-medium">
                  {job.kind === 'export' ? 'Export' : 'Import'} ·{' '}
                  {job.scope === 'all-users'
                    ? 'All users'
                    : job.scope === 'snapshot'
                      ? 'One snapshot'
                      : 'Personal saves'}
                </span>
                <span className="text-gray-500 dark:text-gray-400">
                  {new Date(job.createdAt).toLocaleString()}
                </span>
              </div>
              <p
                role={tasksWorking(job) ? 'status' : undefined}
                className="text-sm text-gray-600 dark:text-gray-300"
              >
                {job.error || job.progress?.stage || job.status}
                {job.progress?.filesTotal
                  ? ` · ${job.progress.filesDone || 0}/${job.progress.filesTotal} files`
                  : ''}
                {job.progress?.gamesTotal
                  ? ` · ${job.progress.gamesDone || 0}/${job.progress.gamesTotal} records`
                  : ''}
                {job.progress?.bytesTotal
                  ? ` · ${size(job.progress.bytesDone || 0)} / ${size(job.progress.bytesTotal)}`
                  : ''}
              </p>
              {job.result && (
                <div className="text-sm space-y-1">
                  <p>
                    {job.result.restored} current snapshots restored ·{' '}
                    {job.result.historyImported} history versions added ·{' '}
                    {job.result.kept} current snapshots kept ·{' '}
                    {job.result.orphaned} missing-game records retained
                  </p>
                  {job.result.usersCreated?.length > 0 && (
                    <p className="text-amber-700 dark:text-amber-300">
                      Set passwords for new users:{' '}
                      {job.result.usersCreated.join(', ')}
                    </p>
                  )}
                  {job.result.conflicts?.map((conflict, index) => (
                    <p
                      key={index}
                      className="text-amber-700 dark:text-amber-300"
                    >
                      {conflict.title}: {conflict.message}
                    </p>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {job.kind === 'export' && job.status === 'ready' && (
                  <button
                    className={secondary}
                    disabled={busy}
                    onClick={() =>
                      downloadSaveBackup(job.id).catch((error) =>
                        setError(error.message)
                      )
                    }
                  >
                    Download backup
                  </button>
                )}
                {job.kind === 'import' && job.status === 'review' && (
                  <button
                    className={secondary}
                    disabled={busy}
                    onClick={() => openReview(job)}
                  >
                    Review import
                  </button>
                )}
                {!tasksWorking(job) && (
                  <button
                    className={secondary}
                    disabled={busy}
                    onClick={() => remove(job)}
                  >
                    Remove temporary backup
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
export default function SaveBackupModal({
  gameId,
  title,
  onClose,
  onImported,
}) {
  const card = useRef(null),
    close = useRef(null);
  useEffect(() => {
    const previous = document.activeElement,
      overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    close.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-backup-title"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
        if (event.key === 'Tab') {
          const controls = [
            ...card.current.querySelectorAll(
              'button:not(:disabled),input:not(:disabled):not([type=file]),select:not(:disabled),summary'
            ),
          ];
          const first = controls[0],
            last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div
        ref={card}
        className="w-full max-w-2xl max-h-[90dvh] flex flex-col rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl text-gray-900 dark:text-white"
      >
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          <div className="min-w-0">
            <h2 id="save-backup-title" className="text-lg font-bold">
              {gameId ? 'Import save backup' : 'Save backups'}
            </h2>
            {title && (
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {title}
              </p>
            )}
          </div>
          <button
            ref={close}
            aria-label="Close save backups"
            className="min-h-[44px] min-w-[44px] rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="overflow-y-auto p-6">
          <SaveBackupControls
            gameId={gameId}
            title={title}
            onImported={onImported}
          />
        </div>
      </div>
    </div>
  );
}
