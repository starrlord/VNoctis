const MAX_BYTES = 128 * 1024 * 1024;
export const validPath = path => typeof path === 'string' && path.length > 0 && path.length <= 512 &&
  !/[\\:\x00-\x1f]/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..');
const table = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

// ZIP's stored method preserves already-compressed Ren'Py saves byte for byte.
// The UTF-8 flag makes folder names portable between native extraction tools.
export function snapshotZip(snapshot) {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.files) || snapshot.files.length > 4096) throw new Error('Invalid save snapshot');
  const seen = new Set(), chunks = [], directory = [];
  let offset = 0, total = 0;
  for (const file of snapshot.files) {
    if (!validPath(file.path) || seen.has(file.path)) throw new Error('Invalid save path');
    seen.add(file.path);
    const bytes = Uint8Array.from(atob(file.data), character => character.charCodeAt(0));
    total += bytes.length;
    if (total > MAX_BYTES) throw new Error('Save snapshot exceeds 128 MiB');
    const name = new TextEncoder().encode(file.path), crc = crc32(bytes);
    const date = new Date(file.mtime), year = Math.max(1980, Math.min(2107, date.getFullYear() || 1980));
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const header = new Uint8Array(30), local = new DataView(header.buffer);
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x800, true);
    local.setUint16(10, time, true); local.setUint16(12, day, true); local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true); local.setUint32(22, bytes.length, true); local.setUint16(26, name.length, true);
    chunks.push(header, name, bytes);
    const central = new Uint8Array(46), record = new DataView(central.buffer);
    record.setUint32(0, 0x02014b50, true); record.setUint16(4, 20, true); record.setUint16(6, 20, true);
    record.setUint16(8, 0x800, true); record.setUint16(12, time, true); record.setUint16(14, day, true);
    record.setUint32(16, crc, true); record.setUint32(20, bytes.length, true); record.setUint32(24, bytes.length, true);
    record.setUint16(28, name.length, true); record.setUint32(42, offset, true);
    directory.push(central, name); offset += header.length + name.length + bytes.length;
  }
  for (const path of seen) {
    const parts = path.split('/');
    while (parts.length > 1) { parts.pop(); if (seen.has(parts.join('/'))) throw new Error('Invalid save tree'); }
  }
  const directoryBytes = directory.reduce((size, part) => size + part.length, 0);
  const end = new Uint8Array(22), record = new DataView(end.buffer);
  record.setUint32(0, 0x06054b50, true); record.setUint16(8, snapshot.files.length, true);
  record.setUint16(10, snapshot.files.length, true); record.setUint32(12, directoryBytes, true); record.setUint32(16, offset, true);
  return new Blob([...chunks, ...directory, end], { type: 'application/zip' });
}

export async function readSaveFolder(selected, suggestedFolder = '') {
  const files = [...selected];
  const entries = files.map(file => {
    const original = file.webkitRelativePath || file.name;
    if (!validPath(original)) throw new Error('The selected folder contains an unsafe path.');
    return { file, path: file.webkitRelativePath ? original.split('/').slice(1).join('/') : original };
  });
  const saves = entries.filter(entry => entry.path.endsWith('.save'));
  if (!saves.length) throw new Error('Choose a folder containing Ren’Py .save files.');
  const parents = new Set(saves.map(entry => entry.path.split('/').slice(0, -1).join('/')));
  if (parents.size !== 1) throw new Error('Select one game’s save folder, rather than folders for several games.');
  const parent = [...parents][0];
  const included = entries.filter(entry => saves.includes(entry) || entry.path === (parent ? `${parent}/persistent` : 'persistent') ||
    /(^|\/)tokens\/security_keys\.txt$/.test(entry.path) || entry.path === 'security_keys.txt');
  if (included.length > 4096 || included.reduce((size, entry) => size + entry.file.size, 0) > MAX_BYTES) throw new Error('Save imports are limited to 4096 files and 128 MiB.');
  // A PC save folder may be renamed or simply called "saves". Its name tells
  // us nothing about the web runtime's configured destination.
  const folder = suggestedFolder;
  const imported = [];
  for (const { file, path } of included) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    imported.push({ name: path.split('/').at(-1), token: path.endsWith('security_keys.txt'),
      mtime: Math.max(0, Math.trunc(file.lastModified || Date.now())), data: btoa(binary) });
  }
  return { folder, files: imported, byteSize: included.reduce((size, entry) => size + entry.file.size, 0), ignored: files.length - included.length };
}

export function importSnapshot(plan, folder) {
  if (!validPath(folder)) throw new Error('Enter a valid save folder name.');
  const files = plan.files.map(file => ({ path: file.token ? `tokens/${file.name}` : `${folder}/${file.name}`, mtime: file.mtime, data: file.data }));
  const paths = new Set();
  for (const file of files) {
    if (!validPath(file.path) || paths.has(file.path)) throw new Error('The selected saves contain duplicate or invalid filenames.');
    paths.add(file.path);
  }
  return { version: 1, files };
}
