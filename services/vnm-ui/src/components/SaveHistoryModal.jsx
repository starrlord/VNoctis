import { useEffect, useRef, useState } from 'react';
import api from '../hooks/useApi';
import SaveBackupModal from './SaveBackupModal';
import { exportSaveBackup } from '../utils/saveBackups';
import { importSnapshot, readSaveFolder, validPath } from '../utils/saveFiles';

const kinds = { auto: 'Autosave', manual: 'Manual / quick save', checkpoint: 'Synced checkpoint', restored: 'Restored version', imported: 'Imported saves' };
const requestId = () => window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const sizeText = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MB`;

export default function SaveHistoryModal({ gameId, title, onClose, onPlay }) {
  const base = `/games/${encodeURIComponent(gameId)}/saves/history`;
  const [history, setHistory] = useState({ versions: [], currentRevision: 0, currentVersionId: null, nextOffset: null });
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [importPlan, setImportPlan] = useState(null), [folder, setFolder] = useState('');
  const folderPicker = useRef(null), filePicker = useRef(null), importRequest = useRef(null);
  const card = useRef(null), closeButton = useRef(null), restoreRequest = useRef(null), busyRef = useRef(false);
  busyRef.current = busy;

  async function load(offset = 0) {
    setLoading(true); setError('');
    try {
      const data = await api.get(`${base}?offset=${offset}`);
      setFolder(data.saveDirectory || ''); importRequest.current = null;
      setHistory(previous => ({ ...data, versions: offset ? [...previous.versions, ...data.versions] : data.versions }));
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [gameId]);
  useEffect(() => {
    const previousFocus = document.activeElement, previousOverflow = document.body.style.overflow;
    const ownsScrollLock = previousOverflow !== 'hidden';
    if (ownsScrollLock) document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const handleKey = event => {
      if (event.key === 'Escape' && !busyRef.current) { event.stopImmediatePropagation(); onClose(); }
      if (event.key !== 'Tab') return;
      const buttons = card.current?.querySelectorAll('button:not(:disabled), input:not(:disabled):not([type=file]), summary');
      if (!buttons?.length) return;
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      if (ownsScrollLock) document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKey); previousFocus?.focus();
    };
  }, [onClose]);

  async function download(version) {
    setBusy(true); setError('');
    try {
      setNotice('Preparing a VNoctis save backup…');
      await exportSaveBackup({gameId,versionId:version.id},{onProgress:job=>setNotice(job.progress?.stage||'Preparing backup…')});
      setNotice('Backup download started. Keep the ZIP intact and use Import backup ZIP to restore it into VNoctis.');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function selectImport(event) {
    const files = [...event.target.files]; event.target.value = '';
    if (!files.length) return;
    setBusy(true); setError(''); setNotice(''); setImportPlan(null); importRequest.current = null;
    try {
      const plan = await readSaveFolder(files, history.saveDirectory || '');
      setImportPlan(plan); setFolder(plan.folder);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function applyImport() {
    setBusy(true); setError(''); setNotice('');
    try {
      if (!importRequest.current) importRequest.current = { revision: history.currentRevision,
        uploadId: requestId(), snapshot: importSnapshot(importPlan, folder) };
      await api.post(`${base}/import`, importRequest.current);
      importRequest.current = null; setImportPlan(null);
      setNotice('Saves imported. Launch the game to use them.'); await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function act(version, action) {
    setBusy(true); setError(''); setNotice('');
    try {
      if (action === 'restore') {
        // Reuse the request ID when a response is lost and the user retries.
        if (restoreRequest.current?.versionId !== version.id) restoreRequest.current = {
          versionId: version.id, revision: history.currentRevision, uploadId: requestId(),
        };
        await api.post(`${base}/${version.id}/restore`, restoreRequest.current);
        setNotice('Version restored. Launch the game to use these saves.');
      } else {
        await api.delete(`${base}/${version.id}`);
        setNotice('Save version deleted.');
      }
      restoreRequest.current = null; setConfirm(null); await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return <><div data-save-history-dialog role="dialog" aria-modal="true" aria-labelledby="save-history-title"
    className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 dark:bg-black/70 backdrop-blur-sm modal-safe-pad motion-safe:animate-fade-in"
    onClick={() => { if (!busy) onClose(); }}>
    <div ref={card} onClick={event => event.stopPropagation()} className="relative w-full max-w-lg max-h-[85dvh] flex flex-col bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700/50 motion-safe:animate-scale-in">
      <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-200 dark:border-gray-800">
        <div className="min-w-0"><h2 id="save-history-title" className="text-lg font-bold text-gray-900 dark:text-white">Save history</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{title}</p></div>
        <button ref={closeButton} onClick={onClose} disabled={busy} aria-label="Close save history" className="w-11 h-11 shrink-0 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 disabled:opacity-50">✕</button>
      </div>
      <div className="px-6 py-4 overflow-y-auto space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">Your saves for this game. Older versions stay here, outside the game’s save slots.</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">Downloaded backups are designed to be imported back into VNoctis. Keep the ZIP intact and use Import backup ZIP to restore it. Desktop-game compatibility is not guaranteed.</p>
        <div className="flex flex-wrap items-center gap-2">
          <button disabled={busy || loading} onClick={() => setBackupOpen(true)} className="px-3 py-2 min-h-11 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50">Import backup ZIP</button>
          <button disabled={busy || loading} onClick={() => folderPicker.current?.click()} className="px-3 py-2 min-h-11 rounded-lg bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-white text-sm font-medium transition-colors disabled:opacity-50">Import save folder</button>
          <button disabled={busy || loading} onClick={() => filePicker.current?.click()} className="px-3 py-2 min-h-11 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 text-sm disabled:opacity-50">Choose files instead</button>
          <input ref={folderPicker} type="file" multiple webkitdirectory="" directory="" hidden aria-label="Save folder" onChange={selectImport} />
          <input ref={filePicker} type="file" multiple hidden aria-label="Save files" onChange={selectImport} />
        </div>
        {importPlan && <div className="p-4 rounded-lg border border-emerald-500/40 space-y-3">
          <p className="font-medium text-gray-900 dark:text-white">Import {importPlan.files.filter(file => !file.token).length} save files · {sizeText(importPlan.byteSize)}</p>
          {importPlan.ignored > 0 && <p className="text-xs text-gray-500 dark:text-gray-400">{importPlan.ignored} unrelated files skipped.</p>}
          <details className="text-xs text-gray-500 dark:text-gray-400"><summary className="cursor-pointer py-2">View selected files</summary>
            <ul className="max-h-32 overflow-y-auto break-all">{importPlan.files.slice(0, 20).map((file, index) => <li key={index}>{file.token ? 'tokens/' : ''}{file.name}</li>)}</ul>
            {importPlan.files.length > 20 && <p>And {importPlan.files.length - 20} more files.</p>}
          </details>
          {!history.saveDirectory && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">{history.saveFolders?.length > 1 ? 'Several save directories were found.' : 'The game’s save directory is not known yet.'} Launch this game once, then reopen save history before importing. The selected desktop folder’s name is not used as the destination.</p>}
          <label className="block text-sm text-gray-600 dark:text-gray-300">{history.saveDirectory ? 'Game save directory' : 'Advanced: enter a verified runtime save directory'}
            <input value={folder} disabled={busy || Boolean(history.saveDirectory)} onChange={event => { setFolder(event.target.value); importRequest.current = null; }} className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-gray-900 dark:text-white" />
          </label>
          <p className="text-sm text-gray-600 dark:text-gray-300">Use saves from a compatible release of this game; matching game versions alone does not guarantee Ren’Py engine compatibility. Import replaces your synced slots and keeps the current version in history. Close the game first.</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">Include persistent and security_keys.txt when available.</p>
        </div>}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {error && importPlan && <button disabled={busy || loading} onClick={() => { importRequest.current = null; load(); }} className="px-3 py-2 min-h-11 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm">Refresh history</button>}
        {notice && <div role="status" className="text-sm text-emerald-600 dark:text-emerald-400 space-y-2">
          <p>{notice}</p>{(notice.startsWith('Version restored') || notice.startsWith('Saves imported')) && onPlay && <button disabled={busy} onClick={onPlay} className="px-3 py-2 min-h-11 rounded-lg bg-emerald-600 text-white">{notice.startsWith('Saves imported') ? 'Play with imported saves' : 'Play with restored saves'}</button>}
        </div>}
        {!loading && !error && !history.versions.length && <p className="text-sm text-gray-500 dark:text-gray-400">No save history yet. Versions appear when you save in the game.</p>}
        {history.versions.map(version => {
          const current = version.id === history.currentVersionId;
          return <div key={version.id} className="p-4 rounded-lg border border-gray-200 dark:border-gray-800 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-gray-900 dark:text-white">{version.alternate ? 'Alternate version' : kinds[version.kind] || 'Save version'}</p>
              {current && <span className="px-2 py-1 rounded-full text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">Current</span>}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">{new Date(version.createdAt).toLocaleString()} · {version.deviceLabel} · {sizeText(version.byteSize)}</p>
            {version.alternate && <p className="text-xs text-gray-500 dark:text-gray-400">Preserved from a device with separate progress. Kept until you restore or delete it.</p>}
            {confirm?.id === version.id ? <div className="space-y-2">
              <p className="text-sm text-gray-600 dark:text-gray-300">{confirm.action === 'restore'
                ? 'Use this version on your next launch? Your current synced saves will remain in history.' : 'Permanently delete this version from history?'}</p>
              <div className="flex gap-2">
                <button disabled={busy} onClick={() => act(version, confirm.action)} className={`px-3 py-2 min-h-11 rounded-lg text-sm text-white disabled:opacity-50 ${confirm.action === 'restore' ? 'bg-emerald-600' : 'bg-red-600'}`}>{confirm.action === 'restore' ? 'Restore this version' : 'Delete permanently'}</button>
                <button disabled={busy} onClick={() => setConfirm(null)} className="px-3 py-2 min-h-11 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm">Cancel</button>
              </div>
            </div> : <div className="flex flex-wrap gap-2">
              {!current && <button disabled={busy} onClick={() => { restoreRequest.current = null; setConfirm({ id: version.id, action: 'restore' }); }} className="px-3 py-2 min-h-11 rounded-lg bg-emerald-600 text-white text-sm disabled:opacity-50">Restore</button>}
              <button disabled={busy} onClick={() => download(version)} className="px-3 py-2 min-h-11 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm disabled:opacity-50" title="Download a backup for restoring into VNoctis">Download backup</button>
              {!current && <button disabled={busy} onClick={() => setConfirm({ id: version.id, action: 'delete' })} className="px-3 py-2 min-h-11 rounded-lg text-red-600 dark:text-red-400 text-sm disabled:opacity-50">Delete</button>}
            </div>}
          </div>;
        })}
        {loading && <p role="status" className="text-sm text-gray-500 dark:text-gray-400">Loading save history…</p>}
      </div>
      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex flex-wrap gap-2 justify-between">
        {importPlan ? <>
          <button disabled={busy || loading || !validPath(folder)} onClick={applyImport} className="px-3 py-2 min-h-11 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm disabled:opacity-50">Import and use saves</button>
          <button disabled={busy} onClick={() => { setImportPlan(null); importRequest.current = null; }} className="px-3 py-2 min-h-11 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm">Cancel import</button>
        </> : <>
        <button disabled={busy || loading} onClick={() => { restoreRequest.current = null; importRequest.current = null; setConfirm(null); load(); }} className="px-3 py-2 min-h-11 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm disabled:opacity-50">Refresh</button>
        {history.nextOffset !== null && <button disabled={busy || loading} onClick={() => load(history.nextOffset)} className="px-3 py-2 min-h-11 rounded-lg bg-emerald-600 text-white text-sm disabled:opacity-50">Load more</button>}
        </>}
      </div>
    </div>
  </div>{backupOpen && <SaveBackupModal gameId={gameId} title={title} onImported={()=>load()} onClose={()=>{setBackupOpen(false);load();}}/>}</>;
}
