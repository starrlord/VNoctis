import { useState, useEffect, useRef } from 'react';

/**
 * Custom hook for SSE build-log streaming.
 *
 * Connects to `/api/v1/build/{jobId}/log` via EventSource and accumulates
 * log lines as they arrive. Automatically cleans up on unmount or when
 * jobId changes, and auto-reconnects once on error after a 2-second delay.
 *
 * @param {string|null} jobId  The active build-job ID (null = no connection)
 * @returns {{ lines: string[], connected: boolean, error: string|null }}
 */
export default function useBuildLog(jobId) {
  const [lines, setLines] = useState([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);

  // Track whether we've already retried so we only auto-reconnect once
  const retriedRef = useRef(false);
  const esRef = useRef(null);
  // Track whether the stream ended intentionally (done event received)
  const doneRef = useRef(false);

  useEffect(() => {
    if (!jobId) {
      setConnected(false);
      return;
    }

    // Reset state for a new connection
    setLines([]);
    setError(null);
    setConnected(false);
    retriedRef.current = false;
    doneRef.current = false;

    function connect() {
      const url = `/api/v1/build/${jobId}/log`;
      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        setConnected(true);
        setError(null);
      };

      es.onmessage = (event) => {
        const data = event.data;
        // SSE "done" sentinel — server sends this when the build finishes
        if (data === '[DONE]') {
          doneRef.current = true;
          es.close();
          setConnected(false);
          return;
        }
        setLines((prev) => [...prev, data]);
      };

      // Handle named 'done' event from server (event: done)
      es.addEventListener('done', (event) => {
        doneRef.current = true;
        const finalStatus = event.data?.trim() || 'unknown';
        setConnected(false);
        setError(
          finalStatus === 'success'
            ? null
            : finalStatus === 'failed'
              ? 'Build failed.'
              : null
        );
        es.close();
      });

      es.onerror = () => {
        es.close();
        setConnected(false);

        // Don't reconnect if the stream ended intentionally
        if (doneRef.current) return;

        if (!retriedRef.current) {
          // Auto-reconnect once after 2 seconds
          retriedRef.current = true;
          setTimeout(() => {
            connect();
          }, 2000);
        } else {
          setError('Lost connection to build log stream.');
        }
      };
    }

    connect();

    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [jobId]);

  return { lines, connected, error };
}
