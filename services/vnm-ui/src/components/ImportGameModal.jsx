import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Format bytes into a human-readable string (e.g., "1.23 GB").
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 1 ? 2 : 0)} ${units[i]}`;
}

/**
 * Import Game modal — supports two import methods:
 *   1. File Upload: drag-and-drop or file picker for a local .ZIP
 *   2. From URL: paste a remote URL and the server downloads + extracts it
 *
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   onImported: () => void,
 * }} props
 */
export default function ImportGameModal({ open, onClose, onImported }) {
  const [tab, setTab] = useState('file'); // 'file' | 'url'
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [phase, setPhase] = useState('idle'); // idle | uploading | downloading | extracting | success | error
  const [progress, setProgress] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [resultFolder, setResultFolder] = useState('');
  const xhrRef = useRef(null);
  const abortRef = useRef(null);
  const modalRef = useRef(null);
  const fileInputRef = useRef(null);
  const previousFocusRef = useRef(null);

  // Prevent body scroll while modal is open
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  // Focus trap & Escape key
  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement;
    modalRef.current?.focus();

    const handleKey = (e) => {
      if (e.key === 'Escape' && !isProcessing) {
        onClose();
        return;
      }
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
      previousFocusRef.current?.focus();
    };
  }, [open, onClose, phase]);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setFile(null);
      setUrl('');
      setPhase('idle');
      setProgress(0);
      setDownloadedBytes(0);
      setTotalBytes(0);
      setErrorMsg('');
      setResultFolder('');
      setTab('file');
    }
  }, [open]);

  const isProcessing = phase === 'uploading' || phase === 'downloading' || phase === 'extracting';
  const isSuccess = phase === 'success';
  const isError = phase === 'error';
  const isIdle = phase === 'idle';

  // ── File selection handlers ────────────────────────
  const handleFileSelect = useCallback((selectedFile) => {
    if (!selectedFile) return;
    const name = selectedFile.name.toLowerCase();
    const accepted = name.endsWith('.zip') || name.endsWith('.tar.bz2') || name.endsWith('.rar');
    if (!accepted) {
      setErrorMsg('Please select a .zip, .tar.bz2, or .rar file');
      return;
    }
    setFile(selectedFile);
    setErrorMsg('');
  }, []);

  const handleInputChange = useCallback((e) => {
    handleFileSelect(e.target.files?.[0]);
  }, [handleFileSelect]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    handleFileSelect(e.dataTransfer.files?.[0]);
  }, [handleFileSelect]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleRemoveFile = useCallback(() => {
    setFile(null);
    setErrorMsg('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  // ── File Upload handler ────────────────────────────
  const handleFileUpload = useCallback(() => {
    if (!file || isProcessing) return;

    setPhase('uploading');
    setProgress(0);
    setErrorMsg('');

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        setProgress(pct);
        if (pct >= 100) {
          setPhase('extracting');
        }
      }
    });

    xhr.upload.addEventListener('load', () => {
      setPhase('extracting');
      setProgress(100);
    });

    xhr.addEventListener('load', () => {
      xhrRef.current = null;

      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const response = JSON.parse(xhr.responseText);
          setPhase('success');
          setResultFolder(response.folderName || '');
          onImported();
        } catch {
          setPhase('success');
          onImported();
        }
      } else {
        let message = `Upload failed (HTTP ${xhr.status})`;
        try {
          const response = JSON.parse(xhr.responseText);
          if (response.message) message = response.message;
        } catch {
          if (xhr.statusText) message = `${xhr.status} ${xhr.statusText}`;
        }
        setPhase('error');
        setErrorMsg(message);
      }
    });

    xhr.addEventListener('error', () => {
      xhrRef.current = null;
      setPhase('error');
      setErrorMsg('Network error — check your connection and try again.');
    });

    xhr.addEventListener('abort', () => {
      xhrRef.current = null;
      setPhase('idle');
      setProgress(0);
    });

    const formData = new FormData();
    formData.append('file', file);

    xhr.open('POST', '/api/v1/library/import');
    // Attach auth token for protected endpoint
    const token = localStorage.getItem('vnm-token');
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }
    xhr.send(formData);
  }, [file, isProcessing, onImported]);

  // ── URL Download handler ───────────────────────────
  const handleUrlDownload = useCallback(async () => {
    if (!url.trim() || isProcessing) return;

    // Basic URL validation
    try {
      const parsed = new URL(url.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        setErrorMsg('Only http:// and https:// URLs are supported.');
        return;
      }
    } catch {
      setErrorMsg('Please enter a valid URL.');
      return;
    }

    setPhase('downloading');
    setProgress(0);
    setDownloadedBytes(0);
    setTotalBytes(0);
    setErrorMsg('');

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      // Attach auth token for protected endpoint
      const importHeaders = { 'Content-Type': 'application/json' };
      const importToken = localStorage.getItem('vnm-token');
      if (importToken) {
        importHeaders['Authorization'] = `Bearer ${importToken}`;
      }

      const response = await fetch('/api/v1/library/import-url', {
        method: 'POST',
        headers: importHeaders,
        body: JSON.stringify({ url: url.trim() }),
        signal: abortController.signal,
      });

      if (!response.ok && !response.body) {
        const text = await response.text();
        let msg = `Server error (HTTP ${response.status})`;
        try { msg = JSON.parse(text).message || msg; } catch {}
        setPhase('error');
        setErrorMsg(msg);
        return;
      }

      // Read NDJSON stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            if (event.phase === 'downloading') {
              setPhase('downloading');
              if (event.totalBytes) setTotalBytes(event.totalBytes);
              if (event.downloadedBytes) setDownloadedBytes(event.downloadedBytes);
              if (event.progress >= 0) setProgress(event.progress);
            } else if (event.phase === 'extracting') {
              setPhase('extracting');
              setProgress(100);
            } else if (event.phase === 'complete') {
              setPhase('success');
              setResultFolder(event.folderName || '');
              onImported();
            } else if (event.phase === 'error') {
              setPhase('error');
              setErrorMsg(event.message || 'An error occurred during URL import.');
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.phase === 'complete') {
            setPhase('success');
            setResultFolder(event.folderName || '');
            onImported();
          } else if (event.phase === 'error') {
            setPhase('error');
            setErrorMsg(event.message || 'An error occurred.');
          }
        } catch {}
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        setPhase('idle');
        setProgress(0);
      } else {
        setPhase('error');
        setErrorMsg(err.message || 'Network error during download.');
      }
    } finally {
      abortRef.current = null;
    }
  }, [url, isProcessing, onImported]);

  // ── Cancel handler ─────────────────────────────────
  const handleCancel = useCallback(() => {
    if (xhrRef.current) {
      xhrRef.current.abort();
      xhrRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setPhase('idle');
    setProgress(0);
  }, []);

  // ── Retry handler ──────────────────────────────────
  const handleRetry = useCallback(() => {
    setPhase('idle');
    setProgress(0);
    setErrorMsg('');
  }, []);

  if (!open) return null;

  // Determine which upload action to trigger
  const handleUploadAction = tab === 'file' ? handleFileUpload : handleUrlDownload;
  const canSubmit = tab === 'file' ? !!file : !!url.trim();

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/60 dark:bg-black/70 backdrop-blur-sm modal-safe-pad motion-safe:animate-fade-in"
      onClick={!isProcessing ? onClose : undefined}
      role="dialog"
      aria-modal="true"
      aria-label="Import Game"
    >
      {/* Modal card */}
      <div
        ref={modalRef}
        tabIndex={-1}
        className="relative w-full max-w-lg bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700/50 motion-safe:animate-scale-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 dark:bg-emerald-500/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-emerald-600 dark:text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">Import Game</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">Upload an archive or import from URL</p>
            </div>
          </div>
          {!isProcessing && (
            <button
              className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              onClick={onClose}
              aria-label="Close modal"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Tab switcher — only visible in idle state */}
        {isIdle && (
          <div className="flex border-b border-gray-200 dark:border-gray-800 mx-6">
            <button
              onClick={() => { setTab('file'); setErrorMsg(''); }}
              className={`flex-1 py-3 text-sm font-medium text-center transition-colors border-b-2 ${
                tab === 'file'
                  ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              <span className="flex items-center justify-center gap-2">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                </svg>
                Upload File
              </span>
            </button>
            <button
              onClick={() => { setTab('url'); setErrorMsg(''); }}
              className={`flex-1 py-3 text-sm font-medium text-center transition-colors border-b-2 ${
                tab === 'url'
                  ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              <span className="flex items-center justify-center gap-2">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m9.86-2.03a4.5 4.5 0 0 0-1.242-7.244l-4.5-4.5a4.5 4.5 0 0 0-6.364 6.364l1.757 1.757" />
                </svg>
                From URL
              </span>
            </button>
          </div>
        )}

        {/* Body */}
        <div className="px-6 py-5">
          {/* ── Idle: File Tab — file picker ── */}
          {isIdle && tab === 'file' && !file && (
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              className={`
                relative flex flex-col items-center justify-center gap-3 py-12 px-6
                border-2 border-dashed rounded-xl cursor-pointer transition-all duration-200
                ${dragOver
                  ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10'
                  : 'border-gray-300 dark:border-gray-600 hover:border-emerald-400 dark:hover:border-emerald-500 hover:bg-gray-50 dark:hover:bg-gray-800/50'
                }
              `}
            >
              <div className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors duration-200 ${
                dragOver ? 'bg-emerald-100 dark:bg-emerald-500/20' : 'bg-gray-100 dark:bg-gray-800'
              }`}>
                <svg className={`w-7 h-7 transition-colors duration-200 ${
                  dragOver ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500'
                }`} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3 3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
                </svg>
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {dragOver ? 'Drop your file here' : 'Drop archive here or click to browse'}
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  Supports .zip, .tar.bz2, and .rar — up to 24 GB
                </p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,.tar.bz2,.rar"
                onChange={handleInputChange}
                className="hidden"
                aria-label="Select archive file"
              />
            </div>
          )}

          {/* ── Idle: File Tab — file selected ── */}
          {isIdle && tab === 'file' && file && (
            <div className="flex items-center gap-3 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-xl border border-gray-200 dark:border-gray-700">
              <div className="w-10 h-10 rounded-lg bg-blue-500/10 dark:bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{file.name}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{formatFileSize(file.size)}</p>
              </div>
              <button
                onClick={handleRemoveFile}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                aria-label="Remove file"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {/* ── Idle: URL Tab ── */}
          {isIdle && tab === 'url' && (
            <div className="space-y-3">
              <div>
                <label htmlFor="import-url" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Remote Archive URL
                </label>
                <input
                  id="import-url"
                  type="url"
                  value={url}
                  onChange={(e) => { setUrl(e.target.value); setErrorMsg(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && url.trim()) handleUrlDownload(); }}
                  placeholder="https://example.com/game.zip"
                  className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none transition-colors"
                />
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                The server will download and extract the archive. Supports .zip, .tar.bz2, and .rar.
              </p>
            </div>
          )}

          {/* ── Uploading (file) ── */}
          {phase === 'uploading' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-xl border border-gray-200 dark:border-gray-700">
                <div className="w-10 h-10 rounded-lg bg-blue-500/10 dark:bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-blue-600 dark:text-blue-400 animate-pulse" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{file?.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Uploading… {progress}% of {formatFileSize(file?.size || 0)}
                  </p>
                </div>
              </div>
              <ProgressBar progress={progress} color="blue" label="Uploading" />
            </div>
          )}

          {/* ── Downloading (URL) ── */}
          {phase === 'downloading' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-xl border border-gray-200 dark:border-gray-700">
                <div className="w-10 h-10 rounded-lg bg-blue-500/10 dark:bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-blue-600 dark:text-blue-400 animate-pulse" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M7.5 14.25 12 18.75m0 0 4.5-4.5M12 18.75V3" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                    Downloading from URL…
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {totalBytes > 0
                      ? `${formatFileSize(downloadedBytes)} of ${formatFileSize(totalBytes)}`
                      : downloadedBytes > 0
                        ? `${formatFileSize(downloadedBytes)} downloaded`
                        : 'Starting download…'
                    }
                  </p>
                </div>
              </div>
              <ProgressBar
                progress={progress >= 0 ? progress : -1}
                color="blue"
                label="Downloading"
              />
            </div>
          )}

          {/* ── Extracting ── */}
          {phase === 'extracting' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-xl border border-gray-200 dark:border-gray-700">
                <div className="w-10 h-10 rounded-lg bg-amber-500/10 dark:bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-amber-600 dark:text-amber-400 animate-spin" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.992 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    Extracting & Scanning
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    This may take a moment for large games…
                  </p>
                </div>
              </div>
              <ProgressBar progress={-1} color="amber" label="Extracting" />
            </div>
          )}

          {/* ── Success ── */}
          {isSuccess && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-500/20 flex items-center justify-center mb-4">
                <svg className="w-8 h-8 text-emerald-600 dark:text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Game Imported!</h3>
              {resultFolder && (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Extracted to <code className="text-emerald-600 dark:text-emerald-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-xs">/games/{resultFolder}</code>
                </p>
              )}
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                Library scan has been triggered automatically.
              </p>
            </div>
          )}

          {/* ── Error ── */}
          {isError && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="w-16 h-16 rounded-full bg-red-100 dark:bg-red-500/20 flex items-center justify-center mb-4">
                <svg className="w-8 h-8 text-red-600 dark:text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Import Failed</h3>
              <p className="text-sm text-red-500 dark:text-red-400 max-w-sm">{errorMsg}</p>
            </div>
          )}

          {/* ── Inline error (validation) ── */}
          {isIdle && errorMsg && (
            <p className="mt-3 text-sm text-red-500 dark:text-red-400 text-center">{errorMsg}</p>
          )}
        </div>

        {/* Footer / Action Buttons */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-800">
          {isIdle && (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleUploadAction}
                disabled={!canSubmit}
                className="px-5 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:text-gray-500 dark:disabled:text-gray-500 disabled:cursor-not-allowed rounded-lg transition-colors duration-200 flex items-center gap-2"
              >
                {tab === 'file' ? (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                    </svg>
                    Upload & Import
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M7.5 14.25 12 18.75m0 0 4.5-4.5M12 18.75V3" />
                    </svg>
                    Download & Import
                  </>
                )}
              </button>
            </>
          )}

          {isProcessing && (
            <button
              onClick={handleCancel}
              className="px-4 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors"
            >
              Cancel
            </button>
          )}

          {isSuccess && (
            <button
              onClick={() => { onImported(); onClose(); }}
              className="px-5 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors duration-200"
            >
              Done
            </button>
          )}

          {isError && (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
              >
                Close
              </button>
              <button
                onClick={handleRetry}
                className="px-5 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors duration-200"
              >
                Try Again
              </button>
            </>
          )}
        </div>
      </div>

      {/* Shimmer animation for indeterminate progress bar */}
      <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  );
}

/**
 * Reusable progress bar component — determinate or indeterminate.
 *
 * @param {{ progress: number, color: 'blue'|'amber', label: string }} props
 *   progress: 0-100 for determinate, -1 for indeterminate shimmer
 */
function ProgressBar({ progress, color, label }) {
  const isDeterminate = progress >= 0;
  const gradientClass =
    color === 'amber'
      ? 'from-transparent via-amber-500 to-transparent'
      : 'from-transparent via-blue-500 to-transparent';
  const barClass =
    color === 'amber'
      ? 'bg-gradient-to-r from-amber-500 to-amber-600'
      : 'bg-gradient-to-r from-blue-500 to-blue-600';

  return (
    <div className="space-y-2">
      <div className="w-full h-2.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        {isDeterminate ? (
          <div
            className={`h-full ${barClass} rounded-full transition-all duration-300 ease-out`}
            style={{ width: `${progress}%` }}
          />
        ) : (
          <div className="h-full w-full rounded-full overflow-hidden relative">
            <div
              className={`absolute h-full w-1/3 bg-gradient-to-r ${gradientClass} rounded-full`}
              style={{ animation: 'shimmer 1.5s ease-in-out infinite' }}
            />
          </div>
        )}
      </div>
      <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500">
        <span>{label}</span>
        <span>{isDeterminate ? `${progress}%` : 'Please wait…'}</span>
      </div>
    </div>
  );
}
