import { useEffect, useRef, useState } from 'react';
import useBuildLog from '../hooks/useBuildLog';
import StarBackground from './StarBackground';

/**
 * Renders the appropriate build-state UI for a game that is not yet
 * playable (not_built | queued | building | failed | stale).
 *
 * @param {{
 *   buildState: 'not_built'|'queued'|'building'|'failed'|'stale',
 *   gameTitle: string,
 *   jobId: string|null,
 *   onBuild: (opts: { compressAssets: boolean }) => void,
 *   onCancel: () => void,
 *   onRetry: () => void,
 *   onPlayAnyway: () => void,
 *   onMarkPlayable?: () => Promise<void>,
 * }} props
 */
export default function BuildProgress({
  buildState,
  gameTitle,
  jobId,
  onBuild,
  onCancel,
  onRetry,
  onPlayAnyway,
  onMarkPlayable,
}) {
  return (
    <div className="relative flex items-center justify-center min-h-full p-4">
      <StarBackground />
      <div className="relative z-10">
        {buildState === 'not_built' && (
          <NotBuiltCard title={gameTitle} onBuild={onBuild} onMarkPlayable={onMarkPlayable} />
        )}
        {buildState === 'queued' && (
          <QueuedCard onCancel={onCancel} />
        )}
        {buildState === 'building' && (
          <BuildingCard title={gameTitle} jobId={jobId} onCancel={onCancel} />
        )}
        {buildState === 'failed' && (
          <FailedCard jobId={jobId} onRetry={onRetry} />
        )}
        {buildState === 'stale' && (
          <StaleCard title={gameTitle} onBuild={onBuild} onPlayAnyway={onPlayAnyway} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Not Built                                                         */
/* ------------------------------------------------------------------ */

function NotBuiltCard({ title, onBuild, onMarkPlayable }) {
  const [compressAssets, setCompressAssets] = useState(true);
  const [markError, setMarkError] = useState(null);
  const [marking, setMarking] = useState(false);

  const handleMarkPlayable = async () => {
    if (!onMarkPlayable) return;
    setMarkError(null);
    setMarking(true);
    try {
      await onMarkPlayable();
    } catch (err) {
      setMarkError(err.message || 'No valid web build found on disk.');
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="bg-gray-800/80 backdrop-blur-md border border-white/10 rounded-xl p-8 shadow-lg max-w-md w-full text-center">
      {/* Play icon */}
      <svg
        className="w-16 h-16 text-blue-400 mx-auto mb-5"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M21 7.5V18M15 7.5V18M3 16.811V8.69c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 0 1 0 1.954l-7.108 4.061A1.125 1.125 0 0 1 3 16.811Z"
        />
      </svg>

      <h2 className="text-xl font-bold text-white mb-2">{title}</h2>
      <p className="text-gray-400 mb-6">
        This game hasn&rsquo;t been built for web play yet.
      </p>

      <label className="flex items-start gap-3 mb-5 mx-auto max-w-xs cursor-pointer select-none text-left">
        <input
          type="checkbox"
          checked={compressAssets}
          onChange={(e) => setCompressAssets(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded border-gray-600 text-blue-600 focus:ring-blue-500 bg-gray-700"
        />
        <div>
          <span className="text-sm font-medium text-white">
            Compress assets
          </span>
          <p className="text-xs text-gray-400 mt-0.5">
            Extracts .rpa archives and compresses images for a smaller, faster-loading web build.
          </p>
        </div>
      </label>

      <div className="flex flex-col items-center gap-3">
        <button
          onClick={() => onBuild({ compressAssets })}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 text-white font-semibold rounded-lg transition-colors duration-200"
        >
          Build Now
        </button>

        {onMarkPlayable && (
          <button
            onClick={handleMarkPlayable}
            disabled={marking}
            className="px-5 py-2 bg-gray-700 hover:bg-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 text-gray-200 text-sm font-medium rounded-lg transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {marking ? 'Checking…' : 'Mark as Playable'}
          </button>
        )}

        {markError && (
          <p className="text-red-400 text-xs mt-1 max-w-xs">{markError}</p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Queued                                                            */
/* ------------------------------------------------------------------ */

function QueuedCard({ onCancel }) {
  return (
    <div className="bg-gray-800/80 backdrop-blur-md border border-white/10 rounded-xl p-8 shadow-lg max-w-md w-full text-center">
      {/* Spinner */}
      <div className="mx-auto mb-5 w-12 h-12 border-4 border-gray-600 border-t-blue-400 rounded-full animate-spin" />

      <h2 className="text-lg font-bold text-white mb-1">Build Queued</h2>
      <p className="text-gray-400 mb-6">Waiting to start…</p>

      <button
        onClick={onCancel}
        className="px-5 py-2 bg-gray-700 hover:bg-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 text-gray-200 font-medium rounded-lg transition-colors duration-200"
      >
        Cancel
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Building                                                          */
/* ------------------------------------------------------------------ */

function BuildingCard({ title, jobId, onCancel }) {
  const { lines, connected, error } = useBuildLog(jobId);
  const logEndRef = useRef(null);

  // Auto-scroll the log window
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  return (
    <div className="bg-gray-800/80 backdrop-blur-md border border-white/10 rounded-xl p-6 shadow-lg max-w-2xl w-full">
      {/* Header with pulsing bar */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 bg-blue-400 rounded-full animate-pulse" />
          <h2 className="text-lg font-bold text-white">
            Building {title}…
          </h2>
        </div>
        {jobId && (
          <a
            href={`/build-log/${jobId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-gray-400 hover:text-blue-400 transition-colors flex items-center gap-1"
            title="Open full log in new tab"
          >
            Open in new tab
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
          </a>
        )}
      </div>

      {/* Animated progress bar */}
      <div className="w-full h-1.5 bg-gray-700 rounded-full mb-4 overflow-hidden">
        <div className="h-full bg-blue-500 rounded-full animate-[indeterminate_1.5s_ease-in-out_infinite]"
          style={{
            width: '40%',
            animation: 'indeterminate 1.5s ease-in-out infinite',
          }}
        />
      </div>

      {/* Console log */}
      <div className="bg-gray-950 rounded-lg p-3 font-mono text-xs text-gray-300 max-h-80 overflow-y-auto mb-4">
        {lines.length === 0 && !error && (
          <p className="text-gray-500 italic">
            {connected ? 'Waiting for output…' : 'Connecting to build log…'}
          </p>
        )}
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all leading-5">
            {line}
          </div>
        ))}
        {error && (
          <div className="text-red-400 mt-2">⚠ {error}</div>
        )}
        <div ref={logEndRef} />
      </div>

      <button
        onClick={onCancel}
        className="px-5 py-2 bg-gray-700 hover:bg-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 text-gray-200 font-medium rounded-lg transition-colors duration-200"
      >
        Cancel Build
      </button>

      {/* Inline keyframes for the indeterminate bar animation */}
      <style>{`
        @keyframes indeterminate {
          0%   { transform: translateX(-100%); }
          50%  { transform: translateX(150%); }
          100% { transform: translateX(-100%); }
        }
      `}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Failed                                                            */
/* ------------------------------------------------------------------ */

function FailedCard({ jobId, onRetry }) {
  const { lines } = useBuildLog(jobId);
  const [expanded, setExpanded] = useState(false);

  const lastLines = lines.slice(-20);
  const hasMore = lines.length > 20;

  return (
    <div className="bg-gray-800/80 backdrop-blur-md border border-white/10 rounded-xl p-8 shadow-lg max-w-2xl w-full">
      {/* Error icon */}
      <div className="flex items-center gap-3 mb-4">
        <svg
          className="w-7 h-7 text-red-400"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
          />
        </svg>
        <h2 className="text-xl font-bold text-red-400">Build Failed</h2>
      </div>

      {/* Log tail */}
      {lastLines.length > 0 && (
        <div className="bg-gray-950 rounded-lg p-3 font-mono text-xs text-gray-300 max-h-64 overflow-y-auto mb-2">
          {(expanded ? lines : lastLines).map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all leading-5">
              {line}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-4 mb-4">
        {hasMore && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-sm text-blue-400 hover:text-blue-300 focus:outline-none focus-visible:underline"
          >
            {expanded ? 'Show less' : 'View Full Log'}
          </button>
        )}
        {jobId && (
          <a
            href={`/build-log/${jobId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-gray-400 hover:text-blue-400 transition-colors flex items-center gap-1"
          >
            Open in new tab
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
          </a>
        )}
      </div>

      <div className="mt-4">
        <button
          onClick={onRetry}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 text-white font-semibold rounded-lg transition-colors duration-200"
        >
          Retry Build
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stale                                                             */
/* ------------------------------------------------------------------ */

function StaleCard({ title, onBuild, onPlayAnyway }) {
  const [compressAssets, setCompressAssets] = useState(true);

  return (
    <div className="bg-gray-800/80 backdrop-blur-md border border-white/10 rounded-xl p-8 shadow-lg max-w-md w-full text-center">
      {/* Warning icon */}
      <svg
        className="w-14 h-14 text-yellow-400 mx-auto mb-4"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
        />
      </svg>

      <h2 className="text-xl font-bold text-white mb-2">{title}</h2>
      <p className="text-yellow-300 text-sm mb-6">
        Source files have changed since the last build.
      </p>

      <label className="flex items-start gap-3 mb-5 mx-auto max-w-xs cursor-pointer select-none text-left">
        <input
          type="checkbox"
          checked={compressAssets}
          onChange={(e) => setCompressAssets(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded border-gray-600 text-blue-600 focus:ring-blue-500 bg-gray-700"
        />
        <div>
          <span className="text-sm font-medium text-white">
            Compress assets
          </span>
          <p className="text-xs text-gray-400 mt-0.5">
            Extracts .rpa archives and compresses images for a smaller, faster-loading web build.
          </p>
        </div>
      </label>

      <div className="flex items-center justify-center gap-3">
        <button
          onClick={() => onBuild({ compressAssets })}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 text-white font-semibold rounded-lg transition-colors duration-200"
        >
          Rebuild
        </button>
        <button
          onClick={onPlayAnyway}
          className="px-5 py-2.5 bg-gray-700 hover:bg-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 text-gray-200 font-medium rounded-lg transition-colors duration-200"
        >
          Play Anyway
        </button>
      </div>
    </div>
  );
}
