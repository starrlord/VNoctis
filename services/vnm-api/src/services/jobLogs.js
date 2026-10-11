import { mkdir, appendFile, open, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const validJobId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
export function jobLogPath(root, id) {
  if (!validJobId(id)) throw Object.assign(new Error('Invalid job ID'), { statusCode: 400 });
  return join(root, 'logs', `${id}.log`);
}
export async function appendJobLog(root, id, message) {
  await mkdir(join(root, 'logs'), { recursive: true });
  await appendFile(jobLogPath(root, id), `${message}\n`, 'utf8');
}
export async function readJobLog(root, id, offset = 0, limit = 65536) {
  const path = jobLogPath(root, id);
  if (!Number.isSafeInteger(offset) || offset < 0) throw Object.assign(new Error('Invalid log cursor'), { statusCode: 400 });
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const reset = offset > size;
    if (reset) offset = 0;
    const buffer = Buffer.alloc(Math.min(limit, size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    let end = bytesRead;
    // Keep a split UTF-8 character for the following request.
    if (offset + end < size) {
      let start = end - 1;
      while (start >= 0 && (buffer[start] & 0xc0) === 0x80) start--;
      if (start >= 0) {
        const first = buffer[start];
        const length = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
        if (start + length > end) end = start;
      }
    }
    return { text: buffer.subarray(0, end).toString('utf8'), offset: offset + end, size, reset };
  } catch (error) {
    if (error.code === 'ENOENT') return { text: '', offset: 0, size: 0, reset: offset !== 0 };
    throw error;
  } finally { await handle?.close(); }
}

export async function logExists(root, id) {
  try { return (await stat(jobLogPath(root, id))).isFile(); } catch { return false; }
}
