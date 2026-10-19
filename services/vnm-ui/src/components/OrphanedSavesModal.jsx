import { useEffect, useRef, useState } from 'react';
import { snapshotZip } from '../utils/saveFiles';

async function api(path, options = {}) {
  const response = await fetch(`/api/v1/admin/orphaned-saves${path}`, {
    ...options, headers: { Authorization: `Bearer ${localStorage.getItem('vnm-token')}`,
      'Content-Type': 'application/json' }, cache: 'no-store',
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || 'Unable to manage saves');
  return body;
}

export default function OrphanedSavesModal({ onClose }) {
  const [items, setItems] = useState([]);
  const [nextOffset, setNextOffset] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(null);
  const card = useRef(null);
  const closeButton = useRef(null);
  const busyRef = useRef(false);
  busyRef.current = busy;

  async function load(offset = 0) {
    setLoading(true); setError(''); setConfirm(null);
    try {
      const result = await api(`?offset=${offset}`);
      setItems(previous => offset ? [...previous, ...result.items] : result.items);
      setNextOffset(result.nextOffset);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; closeButton.current?.focus();
    const handleKey = event => {
      if (event.key === 'Escape' && !busyRef.current) onClose();
      if (event.key !== 'Tab') return;
      const buttons = card.current?.querySelectorAll('button:not(:disabled)');
      if (!buttons?.length) return;
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKey); previousFocus?.focus();
    };
  }, [onClose]);

  async function act(item, remove) {
    setBusy(true); setError('');
    try {
      const path = `/${encodeURIComponent(item.userId)}/${encodeURIComponent(item.gameId)}`;
      if (remove) {
        await api(path, { method: 'DELETE', body: JSON.stringify({ revision: item.revision }) });
        await load();
      } else {
        const snapshot = await api(path);
        const url = URL.createObjectURL(snapshotZip(snapshot.snapshot));
        const link = document.createElement('a'); link.href = url;
        link.download = `vnoctis-saves-${item.gameId.replace(/[^A-Za-z0-9_-]/g, '_')}.zip`;
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/60 dark:bg-black/70 backdrop-blur-sm modal-safe-pad motion-safe:animate-fade-in"
      onClick={() => { if (!busy) onClose(); }} role="dialog" aria-modal="true" aria-labelledby="orphaned-saves-title">
      <div ref={card} onClick={event => event.stopPropagation()}
        className="relative w-full max-w-lg max-h-[85dvh] flex flex-col bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700/50 motion-safe:animate-scale-in">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 shrink-0 rounded-lg bg-emerald-500/10 dark:bg-emerald-500/20 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M4 8h16v12H4zM3 4h18v4H3zm6 8h6" /></svg>
            </div>
            <div><h2 id="orphaned-saves-title" className="text-lg font-bold text-gray-900 dark:text-white">Orphaned saves</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">Saved progress for games outside the library</p></div>
          </div>
          <button ref={closeButton} onClick={onClose} disabled={busy} aria-label="Close orphaned saves"
            className="w-11 h-11 shrink-0 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 disabled:opacity-50">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="px-6 py-4 overflow-y-auto space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">These saves are kept until deleted. They become available again if the same game returns.</p>
          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          {!loading && !error && !items.length && <p className="text-sm text-gray-500 dark:text-gray-400">No orphaned saves.</p>}
          {items.map(item => {
            const key = `${item.userId}:${item.gameId}`;
            return <div key={key} className="p-4 rounded-lg border border-gray-200 dark:border-gray-800 space-y-3">
              <div><p className="font-medium break-words text-gray-900 dark:text-white">{item.gameTitle || item.gameId}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 break-words">{item.username} · {new Date(item.updatedAt).toLocaleString()} · {(item.storedBytes / 1024).toFixed(1)} KB stored</p></div>
              {confirm === key ? <div className="space-y-2">
                <p className="text-sm text-red-600 dark:text-red-400">Permanently delete {item.username}’s server saves and save history for this game?</p>
                <div className="flex gap-2">
                  <button disabled={busy} onClick={() => act(item, true)} className="px-3 py-2 min-h-11 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm disabled:opacity-50">Delete permanently</button>
                  <button disabled={busy} onClick={() => setConfirm(null)} className="px-3 py-2 min-h-11 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm">Cancel</button>
                </div>
              </div> : <div className="flex gap-2">
                <button disabled={busy} onClick={() => act(item, false)} className="px-3 py-2 min-h-11 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm disabled:opacity-50">Download snapshot</button>
                <button disabled={busy} onClick={() => setConfirm(key)} className="px-3 py-2 min-h-11 rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 text-sm disabled:opacity-50">Delete</button>
              </div>}
            </div>;
          })}
          {loading && <p role="status" className="text-sm text-gray-500 dark:text-gray-400">Loading saves…</p>}
        </div>
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex justify-between">
          <button disabled={busy || loading} onClick={() => load()} className="px-3 py-2 min-h-11 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 disabled:opacity-50">Refresh</button>
          {nextOffset !== null && <button disabled={busy || loading} onClick={() => load(nextOffset)} className="px-3 py-2 min-h-11 text-sm rounded-lg bg-emerald-600 text-white disabled:opacity-50">Load more</button>}
        </div>
      </div>
    </div>
  );
}
