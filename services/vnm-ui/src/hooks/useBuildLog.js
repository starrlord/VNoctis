import { useState, useEffect } from 'react';
import { appendLogChunk } from '../utils/jobLog';

/** Resume from the durable file cursor; a reconnect never clears existing output. */
export default function useBuildLog(jobId) {
  const [state, setState] = useState({ lines: [], connected: false, error: null });
  useEffect(() => {
    let active = true, timer, offset = 0, pending = '';
    const controller = new AbortController();
    setState({ lines: [], connected: false, error: null });
    if (!jobId) return () => controller.abort();
    async function poll() {
      let delay = 1000;
      try {
        const response = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}/log?offset=${offset}`, {
          cache: 'no-store', headers: { Authorization: `Bearer ${localStorage.getItem('vnm-token') || ''}` }, signal: controller.signal,
        });
        if (!response.ok) throw Object.assign(new Error(`Log unavailable (${response.status})`), { permanent: [401, 403, 404].includes(response.status) });
        const data = await response.json();
        if (!active) return;
        if (data.reset) { offset = 0; pending = ''; }
        const next = appendLogChunk(data.text, pending, data.done && data.offset >= data.size);
        pending = next.pending; offset = data.offset;
        setState(previous => {
          const lines = [...(data.reset ? [] : previous.lines), ...next.lines];
          const omitted = (data.reset ? 0 : previous.omitted || 0) + Math.max(0, lines.length - 5000);
          return { lines: lines.slice(-5000), connected: !data.done, error: null, stage: data.stage, status: data.status, omitted };
        });
        if (data.done && data.offset >= data.size) return;
        if (data.offset < data.size) delay = 100;
      } catch (error) {
        if (!active) return;
        setState(previous => ({ ...previous, connected: false, error: error.permanent ? error.message : 'Connection interrupted. Retained output will resume automatically.' }));
        if (error.permanent) return;
        delay = 2000;
      }
      if (active) timer = setTimeout(poll, delay);
    }
    poll();
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [jobId]);
  return state;
}
