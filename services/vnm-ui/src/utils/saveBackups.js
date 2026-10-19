import api from '../hooks/useApi';
export const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timer);
      reject(new DOMException('Cancelled', 'AbortError'));
    }
    signal?.addEventListener('abort', cancel, { once: true });
  });
export async function waitSaveBackup(
  id,
  { signal, onProgress = () => {} } = {}
) {
  while (true) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const job = await api.get('/save-backups/jobs/' + id, { signal });
    onProgress(job);
    if (['ready', 'review', 'done'].includes(job.status)) return job;
    if (['failed', 'interrupted'].includes(job.status))
      throw new Error(job.error || 'Save backup failed.');
    await pause(500, signal);
  }
}
export async function downloadSaveBackup(id) {
  const result = await api.post('/save-backups/jobs/' + id + '/download', {});
  const link = document.createElement('a');
  link.href = result.url;
  link.download = result.filename;
  document.body.append(link);
  link.click();
  link.remove();
}
export async function exportSaveBackup(selection, options) {
  const job = await api.post('/save-backups/exports', selection);
  await waitSaveBackup(job.id, options);
  await downloadSaveBackup(job.id);
  return job;
}
