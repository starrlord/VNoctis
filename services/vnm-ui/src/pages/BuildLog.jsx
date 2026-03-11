import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import useBuildLog from '../hooks/useBuildLog';
import api from '../hooks/useApi';

/**
 * Standalone build log viewer page — opened in a new tab from the
 * GameDetailModal or BuildProgress badge.
 *
 * Route: /build-log/:jobId
 */
export default function BuildLog() {
  const { jobId } = useParams();
  const { lines, connected, error } = useBuildLog(jobId);
  const [job, setJob] = useState(null);
  const [jobError, setJobError] = useState(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState('');
  const logEndRef = useRef(null);
  const logContainerRef = useRef(null);

  // Fetch build job metadata
  useEffect(() => {
    if (!jobId) return;
    api.get(`/build/${jobId}`)
      .then(setJob)
      .catch((err) => setJobError(err.message || 'Failed to load build job'));
  }, [jobId]);

  // Auto-scroll when new lines arrive (if enabled)
  useEffect(() => {
    if (autoScroll) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines, autoScroll]);

  // Detect manual scroll to disable auto-scroll
  const handleScroll = useCallback(() => {
    const el = logContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  }, []);

  // Copy log to clipboard
  const handleCopy = useCallback(() => {
    const text = lines.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [lines]);

  // Filtered lines
  const filteredLines = filter
    ? lines.map((line, i) => ({ line, num: i + 1 })).filter(({ line }) =>
        line.toLowerCase().includes(filter.toLowerCase())
      )
    : lines.map((line, i) => ({ line, num: i + 1 }));

  // Status styling
  const statusConfig = {
    queued:    { label: 'Queued',    color: 'text-yellow-400', bg: 'bg-yellow-500/10', ring: 'ring-yellow-500/30' },
    building:  { label: 'Building',  color: 'text-blue-400',   bg: 'bg-blue-500/10',   ring: 'ring-blue-500/30' },
    done:      { label: 'Completed', color: 'text-green-400',  bg: 'bg-green-500/10',  ring: 'ring-green-500/30' },
    failed:    { label: 'Failed',    color: 'text-red-400',    bg: 'bg-red-500/10',    ring: 'ring-red-500/30' },
    cancelled: { label: 'Cancelled', color: 'text-gray-400',   bg: 'bg-gray-500/10',   ring: 'ring-gray-500/30' },
  };

  const status = statusConfig[job?.status] || statusConfig.queued;

  // Line coloring based on content
  const getLineClass = (line) => {
    if (line.includes('❌') || line.includes('FAILED') || line.includes('Error')) {
      return 'text-red-400';
    }
    if (line.includes('✅') || line.includes('successful')) {
      return 'text-green-400';
    }
    if (line.includes('⚠️') || line.includes('WARNING') || line.includes('warn')) {
      return 'text-yellow-400';
    }
    if (line.startsWith('[vnm-builder]')) {
      return 'text-blue-300';
    }
    if (line.startsWith('[compressor]')) {
      return 'text-purple-300';
    }
    return 'text-gray-300';
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      {/* Header bar */}
      <header className="bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/"
            className="text-gray-400 hover:text-white transition-colors shrink-0"
            title="Back to Library"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
            </svg>
          </Link>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-white truncate flex items-center gap-2">
              <svg className="w-5 h-5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
              Build Log
            </h1>
            <p className="text-xs text-gray-500 font-mono truncate">
              Job: {jobId}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Status badge */}
          {job && (
            <span className={`px-3 py-1 rounded-full text-xs font-semibold ring-1 ${status.color} ${status.bg} ${status.ring}`}>
              {job.status === 'building' && (
                <span className="inline-block w-2 h-2 bg-blue-400 rounded-full animate-pulse mr-1.5 align-middle" />
              )}
              {status.label}
            </span>
          )}

          {/* Connection indicator */}
          {connected && (
            <span className="flex items-center gap-1.5 text-xs text-green-400">
              <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
              Live
            </span>
          )}

          {/* Filter */}
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg>
            <input
              type="text"
              placeholder="Filter log…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pl-8 pr-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-300 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 w-40"
            />
          </div>

          {/* Copy button */}
          <button
            onClick={handleCopy}
            className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 rounded-lg transition-colors flex items-center gap-1.5"
            title="Copy log to clipboard"
          >
            {copied ? (
              <>
                <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
                Copied
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9.75a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
                </svg>
                Copy
              </>
            )}
          </button>

          {/* Line count */}
          <span className="text-xs text-gray-500">
            {filteredLines.length}{filter ? ` / ${lines.length}` : ''} lines
          </span>
        </div>
      </header>

      {/* Job metadata bar */}
      {job && (
        <div className="bg-gray-900/50 border-b border-gray-800/50 px-4 py-2 flex items-center gap-4 text-xs text-gray-500 flex-wrap">
          {job.gameId && (
            <span>Game: <span className="text-gray-400 font-mono">{job.gameId}</span></span>
          )}
          {job.createdAt && (
            <span>Started: <span className="text-gray-400">{new Date(job.createdAt).toLocaleString()}</span></span>
          )}
          {job.completedAt && (
            <span>Finished: <span className="text-gray-400">{new Date(job.completedAt).toLocaleString()}</span></span>
          )}
          {job.completedAt && job.createdAt && (
            <span>Duration: <span className="text-gray-400">
              {Math.round((new Date(job.completedAt) - new Date(job.createdAt)) / 1000)}s
            </span></span>
          )}
        </div>
      )}

      {/* Error state */}
      {jobError && (
        <div className="px-4 py-3 bg-red-500/10 border-b border-red-500/20 text-red-400 text-sm flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
          {jobError}
        </div>
      )}

      {/* Log content */}
      <div
        ref={logContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-sm leading-6 select-text"
      >
        {lines.length === 0 && !error && !jobError && (
          <div className="flex items-center justify-center h-full text-gray-600">
            <div className="text-center">
              {connected ? (
                <>
                  <div className="mx-auto mb-4 w-8 h-8 border-2 border-gray-700 border-t-blue-400 rounded-full animate-spin" />
                  <p>Waiting for build output…</p>
                </>
              ) : (
                <>
                  <svg className="w-12 h-12 mx-auto mb-3 text-gray-700" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                  </svg>
                  <p>Connecting to build log…</p>
                </>
              )}
            </div>
          </div>
        )}

        <table className="w-full border-collapse">
          <tbody>
            {filteredLines.map(({ line, num }) => (
              <tr key={num} className="hover:bg-gray-900/50 group">
                <td className="py-0 px-3 text-right text-gray-600 select-none text-xs w-12 align-top sticky left-0 bg-gray-950 group-hover:bg-gray-900/50 border-r border-gray-800/50">
                  {num}
                </td>
                <td className={`py-0 px-4 whitespace-pre-wrap break-all ${getLineClass(line)}`}>
                  {line}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {error && (
          <div className="px-4 py-2 text-red-400 text-sm">
            ⚠ {error}
          </div>
        )}

        <div ref={logEndRef} />
      </div>

      {/* Auto-scroll indicator */}
      {!autoScroll && lines.length > 0 && (
        <button
          onClick={() => {
            setAutoScroll(true);
            logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
          }}
          className="fixed bottom-6 right-6 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-full shadow-lg transition-colors flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5 12 21m0 0-7.5-7.5M12 21V3" />
          </svg>
          Scroll to bottom
        </button>
      )}
    </div>
  );
}
