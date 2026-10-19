import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSavePreview } from '../src/services/savePreview.js';
import { saveZip, thumbnail } from './helpers/saveZip.js';
import sharp from 'sharp';

test('native ZIP previews extract only JSON and PNG, preserving custom metadata and original bytes', async () => {
  for (const method of [0, 8]) {
    const metadata = { _save_name: 'My save', _game_runtime: 123, custom: { chapter: 2 } };
    const bytes = saveZip({ json: JSON.stringify(metadata), 'screenshot.png': thumbnail, log: Buffer.alloc(2 * 1024 * 1024, 255) }, method);
    const original = Buffer.from(bytes);
    const result = await extractSavePreview(bytes);
    assert.equal(result.supported, true); assert.deepEqual(result.metadata, metadata);
    assert.equal(result.screenshot.type, 'image/png'); assert.deepEqual(Buffer.from(result.screenshot.data, 'base64'), thumbnail);
    assert.deepEqual(bytes, original);
    assert.equal('log' in result, false);
  }
});

test('preview parsing safely falls back for invalid, encrypted, corrupt and oversized entries', async () => {
  const make = () => saveZip({ json: '{}', 'screenshot.png': thumbnail });
  const encrypted = make(); encrypted.writeUInt16LE(1, 6); const central = encrypted.indexOf(Buffer.from('504b0102', 'hex')); encrypted.writeUInt16LE(1, central + 8);
  const corrupt = make(); corrupt.writeUInt32LE(1234, corrupt.indexOf(Buffer.from('504b0102', 'hex')) + 16);
  const bomb = saveZip({ json: JSON.stringify({ text: 'x'.repeat(1000000) }) });
  // Lie about the inflated size; maxOutputLength still bounds decompression.
  bomb.writeUInt32LE(2, bomb.indexOf(Buffer.from('504b0102', 'hex')) + 24);
  const hugeDimensions = Buffer.from(thumbnail); hugeDimensions.writeUInt32BE(50000, 16);
  for (const bytes of [Buffer.from('not a ZIP'), make().subarray(0, 50), encrypted, corrupt, bomb,
    saveZip({ json: '[]' }), saveZip({ json: 'not JSON' }), saveZip({ log: 'state only' }),
    saveZip({ json: '{}', 'screenshot.png': Buffer.alloc(4 * 1024 * 1024 + 1) }),
    saveZip({ json: '{}', 'screenshot.png': hugeDimensions }),
    saveZip({ json: '{}', 'screenshot.tga': 'legacy' })]) {
    assert.deepEqual(await extractSavePreview(bytes), { version: 2, supported: false });
  }
});

test('large native web thumbnails normalize within preview bounds without changing save bytes', async () => {
  const screenshot = await sharp({ create: { width: 768, height: 432, channels: 4, background: '#405080' } })
    .png({ compressionLevel: 0 }).toBuffer();
  assert.ok(screenshot.length > 1024 * 1024);
  const bytes = saveZip({ json: '{"_save_name":"Native web"}', 'screenshot.png': screenshot, log: 'unread' });
  const original = Buffer.from(bytes), result = await extractSavePreview(bytes);
  assert.equal(result.supported, true);
  const output = Buffer.from(result.screenshot.data, 'base64'), metadata = await sharp(output).metadata();
  assert.equal(metadata.width, 384); assert.equal(metadata.height, 216);
  assert.ok(output.length < 128 * 1024); assert.deepEqual(bytes, original);
  assert.equal(result.metadata._save_name, 'Native web');
  // Header-only validity cannot make a malformed large PNG an accepted preview.
  const truncated = screenshot.subarray(0, screenshot.length - 20);
  assert.equal((await extractSavePreview(saveZip({ json: '{}', 'screenshot.png': truncated }))).supported, false);
});

test('metadata-only saves are supported without inventing a thumbnail', async () => {
  const result = await extractSavePreview(saveZip({ json: '{"_save_name":"No image"}', log: 'unread state' }));
  assert.equal(result.supported, true); assert.equal(result.screenshot, null);
});
