import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const source = readFileSync(new URL('../public/save-sync.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  function createSaveCatalog('), source.indexOf('\n  // Content transfers never install files.'));
const create = vm.runInNewContext(`(${code.trim()})`);
const native = (path, text, mtime = 1) => ({ path, mtime, hash: createHash('sha256').update(text).digest('hex'),
  size: Buffer.byteLength(text), data: Buffer.from(text).toString('base64') });
const reference = ({ data, ...file }) => file;
const initial = () => ({ version: 1, baseVersionId: 'version-one', revision: 1,
  files: ['1-1', 'auto-1', 'auto-2', 'auto-3'].map(slot => reference(native(`Game/${slot}.save`, slot))) });
const plain = value => JSON.parse(JSON.stringify(value));

test('a partial resident snapshot never deletes remote-only saves and unchanged hydration stays a reference', () => {
  const catalog = create(initial());
  catalog.mergeResident([native('Game/1-1.save', 'new manual', 2)]);
  const request = plain(catalog.request()); assert.equal(request.files.length, 4);
  assert.equal(request.files.filter(file => 'data' in file).length, 1);
  assert.ok(request.files.some(file => file.path === 'Game/auto-3.save' && file.hash));
  const generation = catalog.export().generation;
  catalog.mergeResident([native('Game/auto-1.save', 'auto-1')]);
  assert.equal(catalog.export().generation, generation, 'merely caching a slot is not a save mutation');
});

test('remote-only autosave rotation/copy/deletion updates aliases without downloading bytes', () => {
  const catalog = create(initial());
  catalog.remove('Game/auto-3.save');
  catalog.rename('Game/auto-2.save', 'Game/auto-3.save');
  catalog.rename('Game/auto-1.save', 'Game/auto-2.save');
  catalog.mergeResident([native('Game/auto-1.save', 'new auto', 2)]);
  catalog.duplicate('Game/1-1.save', 'Game/copied.save'); catalog.remove('Game/1-1.save');
  const rows = new Map(catalog.request().files.map(file => [file.path, file]));
  assert.equal(rows.get('Game/auto-2.save').hash, native('', 'auto-1').hash);
  assert.equal(rows.get('Game/auto-3.save').hash, native('', 'auto-2').hash);
  assert.equal(rows.get('Game/auto-1.save').data, native('', 'new auto').data);
  assert.equal(rows.get('Game/copied.save').hash, native('', '1-1').hash);
  assert.equal(rows.has('Game/1-1.save'), false);
});

test('logical catalog and captured requests survive serialization without sharing mutable entries', () => {
  const catalog = create(initial()); catalog.mergeResident([native('Game/1-1.save', 'offline')]);
  const captured = plain(catalog.request()), saved = plain(catalog.export());
  catalog.remove('Game/auto-1.save');
  const reopened = create(saved);
  assert.deepEqual(plain(reopened.request()), captured);
  saved.files[0].path = 'tampered';
  assert.deepEqual(plain(reopened.request()), captured);
});

test('acknowledgement keeps writes, deletes and aliases made while the upload was pending', () => {
  const catalog = create(initial()); catalog.mergeResident([native('Game/1-1.save', 'first write', 2)]);
  const accepted = plain(catalog.export());
  catalog.mergeResident([native('Game/1-1.save', 'second write', 3)]);
  catalog.rename('Game/auto-1.save', 'Game/new-name.save'); catalog.remove('Game/auto-3.save');
  catalog.acknowledge(accepted, 'version-two', 2);
  const request = plain(catalog.request()); assert.equal(request.baseVersionId, 'version-two');
  const rows = new Map(request.files.map(file => [file.path, file]));
  assert.equal(rows.get('Game/1-1.save').data, native('', 'second write').data);
  assert.equal(rows.get('Game/new-name.save').hash, native('', 'auto-1').hash);
  assert.equal(rows.has('Game/auto-3.save'), false); assert.equal(rows.has('Game/auto-1.save'), false);
});

test('acknowledged bytes become references while changed support files always keep their bytes', () => {
  const catalog = create(initial());
  catalog.mergeResident([native('Game/1-1.save', 'new manual'), native('tokens/security_keys.txt', 'key bytes'), native('Game/persistent', 'preferences')]);
  catalog.acknowledge(plain(catalog.export()), 'version-two', 2);
  const rows = new Map(catalog.request().files.map(file => [file.path, file]));
  assert.equal('data' in rows.get('Game/1-1.save'), false);
  assert.equal(rows.get('tokens/security_keys.txt').data, native('', 'key bytes').data);
  assert.equal(rows.get('Game/persistent').data, native('', 'preferences').data);
});

test('stale asynchronous preparation cannot resurrect a deleted or renamed remote alias', () => {
  const catalog = create(initial()), captured = catalog.export().generation;
  catalog.remove('Game/auto-1.save');
  assert.throws(() => catalog.mergeResident([native('Game/auto-1.save', 'auto-1')], captured), /changed during preparation/);
  assert.equal(catalog.request().files.some(file => file.path === 'Game/auto-1.save'), false);
});

test('an invalid acknowledgement cannot replace the catalog baseline or discard local progress', () => {
  const catalog = create(initial()); catalog.mergeResident([native('Game/1-1.save', 'offline')]);
  const before = plain(catalog.export());
  assert.throws(() => catalog.acknowledge({ files: [] }, 'wrong-baseline', 10), /required file/);
  assert.deepEqual(plain(catalog.export()), before);
});
