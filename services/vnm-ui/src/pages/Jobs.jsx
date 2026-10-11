import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../hooks/useApi';
import { stageLabels } from '../utils/jobLog';

let jobsCache = null;

export default function Jobs() {
  const [data, setData] = useState(() => jobsCache?.token === localStorage.getItem('vnm-token') ? jobsCache.data : { items: [] });
  const [offset, setOffset] = useState(0);
  const [activeOnly, setActiveOnly] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const navigate = useNavigate();
  useEffect(() => {
    let active = true, timer;
    const controller = new AbortController();
    const token = localStorage.getItem('vnm-token');
    async function refresh() {
      try {
        if (!document.hidden) {
          const result = await api.get(`/jobs?offset=${offset}&active=${activeOnly ? 1 : 0}`, { signal: controller.signal });
          if (active && token === localStorage.getItem('vnm-token')) {
            if (!offset && !activeOnly) jobsCache = { token, data: result };
            setData(result); setError('');
          }
        }
      }
      catch (error) { if (active) setError(error.message); }
      if (active) timer = setTimeout(refresh, 2000);
    }
    refresh(); return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [offset, activeOnly]);
  async function action(job, type) {
    if (type === 'cancel' && !window.confirm(`Cancel ${job.title}?`)) return;
    if (type === 'remove' && !window.confirm(`Remove the job record, log and staged upload for ${job.title}? The game and its playable build stay in the library.`)) return;
    setBusy(job.id); setError('');
    try {
      const result = type === 'remove' ? await api.delete(`/jobs/${job.id}`) : await api.post(`/jobs/${job.id}/${type}`);
      if (type === 'retry') navigate(`/build-log/${result.jobId}`);
      else setData(await api.get(`/jobs?offset=${offset}&active=${activeOnly ? 1 : 0}`));
    } catch (error) { setError(error.message); }
    finally { setBusy(null); }
  }
  return <section className="max-w-6xl mx-auto p-4 sm:p-6">
    <h1 className="text-2xl font-bold mb-2">Jobs</h1>
    <p className="text-gray-500 dark:text-gray-400 mb-6">Imports and builds continue here after you close their windows. Open a log to follow progress.</p>
    <div className="flex gap-2 mb-4">{[false, true].map(value => <button key={String(value)} aria-pressed={activeOnly === value} onClick={() => { setActiveOnly(value); setOffset(0); }} className={`px-4 py-2 rounded-lg ${activeOnly === value ? 'bg-blue-600 text-white' : 'bg-gray-200 dark:bg-gray-700'}`}>{value ? 'In progress' : 'All jobs'}</button>)}</div>
    {error && <p role="alert" className="text-red-400 mb-4">{error}</p>}
    {!data.items.length && <p className="text-gray-500">No jobs yet.</p>}
    <div className="space-y-3">{data.items.map(job => {
      const running = ['queued', 'running'].includes(job.status);
      return <article key={job.id} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 flex flex-col sm:flex-row gap-4 sm:items-center">
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold break-words">{job.title}</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">{job.kind === 'build' ? 'Build' : 'Import'} · {stageLabels[job.stage] || job.stage} · {new Date(job.createdAt).toLocaleString()}</p>
          {job.startedAt && running && <p className="text-xs text-gray-500 mt-1">Elapsed: {Math.max(0, Math.floor((Date.now() - new Date(job.startedAt)) / 1000))} seconds</p>}
          {job.bytesDone > 0 && <p className="text-sm mt-1">{(job.bytesDone / 1048576).toFixed(1)} MB{job.bytesTotal > 0 ? ` of ${(job.bytesTotal / 1048576).toFixed(1)} MB` : ''}</p>}
          {job.error && <p className="text-sm text-red-400 mt-2 break-words">{job.error}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to={`/build-log/${job.id}`} className="px-4 py-2 min-h-11 rounded-lg bg-blue-600 hover:bg-blue-500 text-white">View log</Link>
          {running && !['publishing', 'scanning'].includes(job.stage) && <button disabled={busy === job.id} onClick={() => action(job, 'cancel')} className="px-4 py-2 min-h-11 rounded-lg bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600">Cancel</button>}
          {['failed', 'cancelled'].includes(job.status) && <button disabled={busy === job.id} onClick={() => action(job, 'retry')} className="px-4 py-2 min-h-11 rounded-lg bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600">Retry</button>}
          {!running && <button disabled={busy === job.id} onClick={() => action(job, 'remove')} className="px-4 py-2 min-h-11 rounded-lg text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-950">Remove job</button>}
        </div>
      </article>;
    })}</div>
    <div className="flex gap-3 mt-5">
      {offset > 0 && <button onClick={() => setOffset(Math.max(0, offset - 50))}>Newer jobs</button>}
      {data.nextOffset !== null && data.nextOffset !== undefined && <button onClick={() => setOffset(data.nextOffset)}>Older jobs</button>}
    </div>
  </section>;
}
