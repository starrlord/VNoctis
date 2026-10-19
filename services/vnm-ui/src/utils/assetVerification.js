import { sha256 } from '@noble/hashes/sha2.js';

class InvalidAsset extends Error {}
const hex = (bytes) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');

// Cache.put commits only after this stream finishes. A truncated, oversized or
// corrupt response therefore cannot replace a complete cached file. Chunked
// hashing also avoids allocating one ArrayBuffer the size of a game archive.
export function verifiedAsset(
  response,
  file,
  { signal, check = () => {}, headers = response.headers } = {}
) {
  const hash = sha256.create();
  let size = 0;
  const validate = new TransformStream({
    async transform(chunk, controller) {
      check();
      size += chunk.byteLength;
      if (Number.isSafeInteger(file.size) && size > file.size)
        throw new InvalidAsset('A game file is larger than its inventory');
      let yielded = performance.now();
      for (let offset = 0; offset < chunk.length; offset += 65536) {
        check();
        hash.update(chunk.subarray(offset, offset + 65536));
        if (performance.now() - yielded > 8) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          yielded = performance.now();
        }
      }
      controller.enqueue(chunk);
    },
    flush() {
      check();
      if (
        (Number.isSafeInteger(file.size) && size !== file.size) ||
        hex(hash.digest()) !== file.hash
      )
        throw new InvalidAsset('A game file failed verification');
    },
  });
  return new Response(response.body.pipeThrough(validate, { signal }), {
    headers,
  });
}
export async function verifyAsset(response, file, options) {
  try {
    if (!response || !/^[a-f0-9]{64}$/.test(file.hash || '')) return false;
    await verifiedAsset(response, file, options).body.pipeTo(
      new WritableStream({ write() {} })
    );
    return true;
  } catch (error) {
    if (error instanceof InvalidAsset) return false;
    throw error;
  }
}
