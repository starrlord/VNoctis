import { crc32, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import sharp from 'sharp';

const inflate = promisify(inflateRaw);
const LIMITS = { json: 64 * 1024, 'screenshot.png': 4 * 1024 * 1024 };
export const SAVE_PREVIEW_VERSION = 2;
const unsupported = () => ({ version: SAVE_PREVIEW_VERSION, supported: false });

// Read only bounded presentation entries, never Ren'Py's pickled state/log.
// ZIP64, encryption, duplicate names and unknown layouts use full-file fallback.
export async function extractSavePreview(bytes) {
  try {
    if (bytes.length < 22) return unsupported();
    let end = bytes.length - 22;
    const minimum = Math.max(0, end - 65535);
    while (end >= minimum && (bytes.readUInt32LE(end) !== 0x06054b50 ||
      end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)) end--;
    if (end < minimum || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) return unsupported();
    const count = bytes.readUInt16LE(end + 10), length = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
    if (count > 4096 || bytes.readUInt16LE(end + 8) !== count || start + length !== end) return unsupported();
    let offset = start; const entries = new Map();
    for (let i = 0; i < count; i++) {
      if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) return unsupported();
      const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
      const checksum = bytes.readUInt32LE(offset + 16), packed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
      const nameSize = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
      const local = bytes.readUInt32LE(offset + 42), next = offset + 46 + nameSize + extra + comment;
      if (next > end || bytes.readUInt16LE(offset + 34) || local >= start) return unsupported();
      const name = bytes.toString('utf8', offset + 46, offset + 46 + nameSize);
      if (entries.has(name)) return unsupported();
      entries.set(name, { flags, method, checksum, packed, size, local, nameSize }); offset = next;
    }
    if (offset !== end || !entries.has('json') || entries.has('screenshot.tga') && !entries.has('screenshot.png')) return unsupported();
    const read = async name => {
      const row = entries.get(name); if (!row) return null;
      const { flags, method, checksum, packed, size, local, nameSize } = row;
      if ((flags & ~0x808) || ![0, 8].includes(method) || size > LIMITS[name] || packed > LIMITS[name] + 1024 ||
          local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 ||
          bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method ||
          bytes.readUInt16LE(local + 26) !== nameSize ||
          bytes.toString('utf8', local + 30, local + 30 + nameSize) !== name) throw new Error('Unsupported preview entry');
      const dataStart = local + 30 + nameSize + bytes.readUInt16LE(local + 28);
      if (dataStart + packed > start) throw new Error('Truncated preview');
      const input = bytes.subarray(dataStart, dataStart + packed);
      const output = method === 0 ? input : await inflate(input, { maxOutputLength: LIMITS[name] });
      if (output.length !== size || crc32(output) !== checksum) throw new Error('Corrupt preview');
      return output;
    };
    const metadata = JSON.parse((await read('json')).toString('utf8'));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return unsupported();
    let screenshot = await read('screenshot.png');
    if (screenshot) {
      if (screenshot.length < 33 || screenshot.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
          screenshot.readUInt32BE(8) !== 13 || screenshot.toString('ascii', 12, 16) !== 'IHDR') return unsupported();
      const width = screenshot.readUInt32BE(16), height = screenshot.readUInt32BE(20);
      if (!width || !height || width > 4096 || height > 4096 || width * height > 4 * 1024 * 1024) return unsupported();
      // Web saves can store a full uncompressed PNG inside the deflated ZIP.
      // Normalize oversized previews only; original save bytes remain untouched.
      if (screenshot.length > 128 * 1024 || width > 384 || height > 216) {
        screenshot = await sharp(screenshot, { limitInputPixels: 4 * 1024 * 1024, failOn: 'warning' })
          .resize({ width: 384, height: 216, fit: 'inside', withoutEnlargement: true })
          .png({ compressionLevel: 9 }).toBuffer();
        if (screenshot.length > 256 * 1024) return unsupported();
      }
    }
    return { version: SAVE_PREVIEW_VERSION, supported: true, metadata,
      screenshot: screenshot ? { type: 'image/png', data: screenshot.toString('base64') } : null };
  } catch { return unsupported(); }
}
