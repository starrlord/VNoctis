import { useCallback, useEffect, useState } from 'react';
import useAuth from '../hooks/useAuth';
import { listGameDownloads, removeGameDownloads } from '../utils/gameCache';

const formatBytes = bytes => {
  if (!bytes) return '0 B';
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
};
export default function Dashboard() {
  const { user } = useAuth();
  const [downloads, setDownloads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const [persistent, setPersistent] = useState(false);
  const [retentionStatus, setRetentionStatus] = useState('');
  const [storage, setStorage] = useState(null);
  const refresh = useCallback(async () => {
    setError('');
    try {
      const items = await listGameDownloads();
      const groups = new Map();
      for (const item of items) {
        const group = groups.get(item.gameId) || { gameId: item.gameId, title: item.title || item.gameId, bytes: 0, files: 0, names: [] };
        group.bytes += item.bytes; group.files += item.files; group.names.push(item.name);
        groups.set(item.gameId, group);
      }
      setDownloads([...groups.values()]);
      setStorage(await navigator.storage?.estimate?.());
      setPersistent(await navigator.storage?.persisted?.() || false);
    } catch { setError('Could not read browser storage. Please try again.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const remove = async () => {
    setBusy(true); setError('');
    try { await removeGameDownloads(confirmation.names); setConfirmation(null); await refresh(); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  };
  const retain = async () => {
    setBusy(true); setRetentionStatus('requesting');
    try {
      const allowed = await navigator.storage?.persist?.(); setPersistent(!!allowed);
      setRetentionStatus(allowed ? 'granted' : 'denied');
    } catch { setRetentionStatus('unavailable'); }
    finally { setBusy(false); }
  };
  const total = downloads.reduce((bytes, item) => bytes + item.bytes, 0);
  return <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
    <div><h1 className="text-2xl font-bold">Your dashboard</h1><p className="text-gray-500 dark:text-gray-400 mt-1">{user?.username}</p></div>
    <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-semibold">Downloaded game data</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Files retained in this browser on this device, shared by accounts using this browser.</p></div>
        <button disabled={busy || loading} onClick={refresh} className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 text-sm">Refresh storage</button>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-300">Games keep files as you play so they can be reused next time. Removing downloads preserves your saves. Files will download again when needed.</p>
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <p className="font-medium">{formatBytes(total)} across {downloads.length} {downloads.length === 1 ? 'game' : 'games'}</p>
        <button disabled={!downloads.length || busy} onClick={() => setConfirmation({ title: 'all games', names: downloads.flatMap(item => item.names) })} className="px-3 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm disabled:opacity-50">Remove all downloads</button>
      </div>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {loading ? <p role="status">Reading browser storage…</p> : !downloads.length ? <p className="text-gray-500 dark:text-gray-400 py-4">No downloaded game data is retained in this browser yet.</p> :
        <ul className="divide-y divide-gray-200 dark:divide-gray-700">{downloads.map(item => <li key={item.gameId} className="py-4 flex flex-wrap gap-3 items-center justify-between">
          <div className="min-w-0 flex-1"><p className="font-medium break-words">{item.title}</p><p className="text-sm text-gray-500 dark:text-gray-400">{formatBytes(item.bytes)} · {item.files} files{item.names.length > 1 ? ` · ${item.names.length} builds` : ''}</p></div>
          <button disabled={busy} onClick={() => setConfirmation({ title: item.title, names: item.names })} aria-label={`Remove downloads for ${item.title}`} className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm disabled:opacity-50">Remove downloads</button>
        </li>)}</ul>}
      <div className="border-t border-gray-200 dark:border-gray-700 pt-4 space-y-2">
        <p className="text-sm text-gray-500 dark:text-gray-400">{persistent ? 'Persistent storage is enabled. You can still remove downloads here or clear browser data.' : 'Your browser may remove retained files when storage is needed.'}</p>
        {!persistent && navigator.storage?.persist && <>
          <p className="text-sm text-gray-500 dark:text-gray-400">Downloads are already kept automatically. You can ask your browser to protect them from automatic cleanup.</p>
          <button disabled={busy || retentionStatus === 'denied' || retentionStatus === 'unavailable'} onClick={retain} className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-50">{retentionStatus === 'requesting' ? 'Asking browser…' : retentionStatus === 'denied' ? 'Protection not granted' : retentionStatus === 'unavailable' ? 'Protection unavailable' : 'Protect downloaded files'}</button>
          {(retentionStatus === 'denied' || retentionStatus === 'unavailable') && <p role="status" className="text-sm text-gray-600 dark:text-gray-300">{retentionStatus === 'denied' ? 'This browser declined the request.' : 'This browser could not enable protection.'} Your downloads still work and will be reused. The browser may remove them when space is needed.</p>}
        </>}
        {storage?.quota && <p className="text-xs text-gray-500 dark:text-gray-400">This site uses approximately {formatBytes(storage.usage || 0)} of {formatBytes(storage.quota)} available browser storage, including saves and other site data.</p>}
      </div>
    </section>
    {confirmation && <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="remove-downloads-title">
      <div className="rounded-xl bg-white dark:bg-gray-800 p-6 max-w-md w-full space-y-4">
        <h2 id="remove-downloads-title" className="text-lg font-semibold">Remove downloaded game data?</h2>
        <p className="text-sm text-gray-600 dark:text-gray-300">Remove retained files for {confirmation.title} from this browser? Your saves will be kept.</p>
        <div className="flex justify-end gap-3"><button disabled={busy} onClick={() => setConfirmation(null)} className="px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-700">Cancel</button><button disabled={busy} onClick={remove} className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white disabled:opacity-50">{busy ? 'Removing…' : 'Remove downloads'}</button></div>
      </div>
    </div>}
  </div>;
}
