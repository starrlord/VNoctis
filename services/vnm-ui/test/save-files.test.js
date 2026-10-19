import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importSnapshot, readSaveFolder, snapshotZip } from '../src/utils/saveFiles.js';

const file = (path, bytes) => ({ name: path.split('/').at(-1), webkitRelativePath: path, size: bytes.length,
  lastModified: 1234, arrayBuffer: async () => Uint8Array.from(bytes).buffer });

test('ZIP contains actual file bytes, UTF-8 names, standard CRC, and central directory', async () => {
  const zip = snapshotZip({ version: 1, files: [
    { path: '游戏/1.save', mtime: 1234, data: btoa('123456789') },
    { path: 'tokens/security_keys.txt', mtime: 1234, data: btoa('\x00\xff') },
  ] });
  assert.equal(zip.type, 'application/zip');
  const bytes = new Uint8Array(await zip.arrayBuffer()), view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true), 0x800);
  assert.equal(view.getUint16(8, true), 0);
  assert.equal(view.getUint32(14, true), 0xcbf43926, 'Known ZIP CRC for 123456789');
  const nameLength = view.getUint16(26, true);
  assert.equal(new TextDecoder().decode(bytes.slice(30, 30 + nameLength)), '游戏/1.save');
  assert.equal(new TextDecoder().decode(bytes.slice(30 + nameLength, 39 + nameLength)), '123456789');
  const second = 39 + nameLength, secondName = view.getUint16(second + 26, true);
  assert.deepEqual([...bytes.slice(second + 30 + secondName, second + 32 + secondName)], [0, 255]);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 2);
  const central = view.getUint32(end + 16, true);
  assert.equal(view.getUint32(central, true), 0x02014b50);
  assert.equal(view.getUint32(central + 42, true), 0);
});

test('ZIP refuses unsafe paths and ambiguous file trees', () => {
  for (const paths of [['../1.save'], ['C:/1.save'], ['x', 'x/1.save'], ['1.save', '1.save']]) {
    assert.throws(() => snapshotZip({ version: 1, files: paths.map(path => ({ path, mtime: 0, data: '' })) }));
  }
});

test('folder import maps one game to the existing save folder and includes persistent and keys', async () => {
  const plan = await readSaveFolder([
    file('Desktop/Game/1.save', [0, 255, 2]), file('Desktop/Game/persistent', [3]),
    file('Desktop/tokens/security_keys.txt', [4]), file('Desktop/Game/log.txt', [5]),
  ], 'WebGame');
  assert.equal(plan.folder, 'WebGame'); assert.equal(plan.ignored, 1);
  const copy = importSnapshot(plan, plan.folder);
  assert.deepEqual(copy.files.map(f => f.path), ['WebGame/1.save', 'WebGame/persistent', 'tokens/security_keys.txt']);
  assert.deepEqual([...Uint8Array.from(atob(copy.files[0].data), c => c.charCodeAt(0))], [0, 255, 2]);
  assert.equal(copy.files[0].mtime, 1234);
});

test('folder import rejects unrelated, multi-game, oversize, duplicate, and unsafe input', async () => {
  await assert.rejects(readSaveFolder([file('Folder/log.txt', [1])]), /\.save/);
  await assert.rejects(readSaveFolder([file('Root/A/1.save', [1]), file('Root/B/1.save', [1])]), /one game/);
  await assert.rejects(readSaveFolder([file('../1.save', [1])]), /unsafe/);
  await assert.rejects(readSaveFolder([{ ...file('Folder/1.save', [1]), size: 129 * 1024 * 1024 }]), /128 MiB/);
  const duplicate = await readSaveFolder([file('Folder/1.save', [1]), file('Folder/1.save', [2])]);
  assert.throws(() => importSnapshot(duplicate, 'Game'), /duplicate/);
  assert.throws(() => importSnapshot(duplicate, '../Game'), /valid/);
});

test('renamed desktop folders never determine the web save destination', async () => {
  for (const path of ['saves/1.save', 'Renamed/Game/1.save']) {
    const plan = await readSaveFolder([file(path, [1])]);
    assert.equal(plan.folder, '');
    assert.throws(() => importSnapshot(plan, plan.folder), /valid/);
    const known = await readSaveFolder([file(path, [1])], 'Lewd Town Adventures');
    assert.equal(importSnapshot(known, known.folder).files[0].path, 'Lewd Town Adventures/1.save');
  }
});
