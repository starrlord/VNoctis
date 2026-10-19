import { crc32, deflateRawSync } from 'node:zlib';

export const thumbnail = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1cAAAAASUVORK5CYII=', 'base64');
export function saveZip(entries, method = 8) {
  const locals = [], directory = []; let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const data = Buffer.from(value), filename = Buffer.from(name);
    const packed = method === 8 ? deflateRawSync(data) : data;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(method, 8); header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    locals.push(header, filename, packed);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(method, 10); record.writeUInt32LE(crc32(data), 16); record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(data.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
    directory.push(record, filename); offset += header.length + filename.length + packed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
