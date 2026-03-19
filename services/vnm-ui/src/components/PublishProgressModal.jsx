import { useState, useEffect, useRef } from 'react';

/**
 * Modal that shows real-time upload progress for a publish job via SSE.
 *
 * @param {{
 *   jobId: string,
 *   gameTitle: string,
 *   coverUrl?: string,
 *   onClose: () => void,
 *   onDone?: (gameUrl: string) => void,
 * }} props
 */
export default function PublishProgressModal({ jobId, gameTitle, coverUrl, onClose, onDone }) {
  const [progress, setProgress] = useState(0);
  const [filesUploaded, setFilesUploaded] = useState(0);
  const [filesTotal, setFilesTotal] = useState(0);
  const [status, setStatus] = useState('uploading'); // uploading | done | failed
  const [error, setError] = useState(null);
  const [gameUrl, setGameUrl] = useState(null);
  const [publicUrl, setPublicUrl] = useState(null);
  const esRef = useRef(null);

  useEffect(() => {
    if (!jobId) return;

    const es = new EventSource(`/api/v1/publish/${jobId}/progress`);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'progress' || data.type === 'snapshot') {
          setProgress(data.progress ?? 0);
          setFilesUploaded(data.filesUploaded ?? 0);
          setFilesTotal(data.filesTotal ?? 0);
          if (data.status === 'done') { setStatus('done'); es.close(); }
          if (data.status === 'failed') { setStatus('failed'); setError(data.error); es.close(); }
        } else if (data.type === 'done') {
          setProgress(100);
          setStatus('done');
          setGameUrl(data.gameUrl);
          setPublicUrl(data.publicUrl || null);
          es.close();
          onDone?.(data.gameUrl);
        } else if (data.type === 'error') {
          setStatus('failed');
          setError(data.message);
          es.close();
        }
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      if (status !== 'done') {
        setStatus('failed');
        setError('Lost connection to server.');
      }
      es.close();
    };

    return () => es.close();
  }, [jobId]);

  const isDone = status === 'done';
  const isFailed = status === 'failed';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget && (isDone || isFailed)) onClose(); }}
    >
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-2xl w-full max-w-sm p-6">
        {/* Header */}
        <div className="flex items-start gap-4 mb-5">
          {coverUrl ? (
            <img src={coverUrl} alt="" className="w-14 h-14 rounded object-cover flex-shrink-0" />
          ) : (
            <div className="w-14 h-14 rounded bg-gray-200 dark:bg-gray-700 flex-shrink-0 flex items-center justify-center">
              <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
              </svg>
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900 dark:text-white text-sm leading-tight line-clamp-2">{gameTitle}</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {isDone ? 'Published successfully' : isFailed ? 'Publish failed' : 'Publishing to Cloudflare R2…'}
            </p>
          </div>
        </div>

        {/* Progress bar */}
        {!isFailed && (
          <div className="mb-3">
            <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${isDone ? 'bg-green-500' : 'bg-blue-500'}`}
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="flex justify-between mt-1.5 text-xs text-gray-500 dark:text-gray-400">
              <span>{filesTotal > 0 ? `${filesUploaded} / ${filesTotal} files` : 'Preparing…'}</span>
              <span>{progress}%</span>
            </div>
          </div>
        )}

        {/* Error */}
        {isFailed && error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 mt-4">
          {isDone && (publicUrl || gameUrl) && (
            <a
              href={publicUrl || gameUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
              View Published
            </a>
          )}
          {(isDone || isFailed) && (
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
