const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const code = fs.readFileSync(path.resolve(__dirname, '../../services/vnm-ui/public/game-cache-worker.js'), 'utf8');
const game = 'a'.repeat(32), build = 'b'.repeat(24);
const origin = 'https://test.invalid', scope = `${origin}/web-builds/.vnm-cache/${game}/${build}/`;
function fixture() {
  const listeners = {}, buckets = new Map(), notices = [], calls = [];
  const state = { version: 'one', status: 'built', quota: false, quotaInfo: false, clients: [], network: () => new Response('abcdef', { headers: { 'Content-Type': 'application/octet-stream' } }) };
  const caches = { open: async name => {
    if (!buckets.has(name)) buckets.set(name, new Map());
    const bucket = buckets.get(name), key = value => typeof value === 'string' ? value : value.url;
    return { match: async request => bucket.get(key(request))?.clone(), keys: async () => [...bucket.keys()].map(key => new Request(key)), delete: async request => bucket.delete(key(request)),
      put: async (request, response) => {
        if (state.quota && name.includes('assets')) throw new Error('Quota exceeded');
        if (state.quotaInfo && name.includes('info') && [...buckets.entries()].some(([name, bucket]) => name.includes('assets') && bucket.size)) throw new Error('Full quota');
        const body = await response.arrayBuffer();
        bucket.set(key(request), new Response(body, { status: response.status, headers: response.headers }));
      } };
  }, delete: async name => buckets.delete(name), keys: async () => [...buckets.keys()] };
  const self = { location: { origin, href: `${origin}/game-cache-worker.js?${new URLSearchParams({ game, build, version: 'one', source: `${origin}/web-builds/source/` })}` },
    registration: { scope }, clients: { claim() {}, matchAll: async () => [{ postMessage: message => notices.push(message) }, ...state.clients] },
    skipWaiting() {}, addEventListener: (name, callback) => listeners[name] = callback };
  vm.runInNewContext(code, { self, URL, Response, Headers, TransformStream, AbortController, Map, fetch: async (url, options) => {
    if (String(url).includes('cache-build')) return Response.json({ version: state.version, path: '/web-builds/source', status: state.status });
    calls.push({ url: String(url), options }); return state.network(url, options);
  }, caches });
  const fetchAsset = async (file, options = {}) => {
    const tasks = []; let result;
    const event = { request: new Request(scope + file, options), waitUntil: task => tasks.push(task), respondWith: task => result = task };
    listeners.fetch(event); const response = await result;
    return { response, done: async () => { await Promise.allSettled(tasks); } };
  };
  const message = async type => {
    let result, task;
    listeners.message({ data: Array.isArray(type) ? type : { type, title: 'Test' }, ports: [{ postMessage: value => result = value }], waitUntil: value => task = value });
    await task; return result;
  };
  return { fetchAsset, message, state, calls, notices, buckets, listeners };
}
test('complete files are kept byte-for-byte; later reads do not fetch the network', async () => {
  const f = fixture(); const first = await f.fetchAsset('game.zip'); assert.equal(await first.response.text(), 'abcdef'); await first.done();
  const next = await f.fetchAsset('game.zip'); assert.equal(await next.response.text(), 'abcdef'); await next.done();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.cache, 'no-store');
});
test('an old build can read its cached files but cannot mix in replacement assets', async () => {
  const f = fixture(); const first = await f.fetchAsset('old.webp'); await first.done(); f.state.version = 'two';
  assert.equal((await f.fetchAsset('old.webp')).response.status, 200);
  assert.equal((await f.fetchAsset('new.webp')).response.status, 503);
  assert.equal(f.calls.length, 1); assert.ok(f.notices.some(item => item.message.includes('rebuilt')));
});
test('a build changed during a fetch is rejected and not retained', async () => {
  const f = fixture(); f.state.network = () => { f.state.version = 'two'; return new Response('replacement'); };
  const result = await f.fetchAsset('game.zip'); assert.equal(result.response.status, 503); await result.done();
  assert.equal([...f.buckets.values()].reduce((n, bucket) => n + bucket.size, 0), 0);
});
test('an in-progress replacement cannot supply files under the old build identity', async () => {
  const f = fixture(); f.state.status = 'building';
  assert.equal((await f.fetchAsset('game.zip')).response.status, 503); assert.equal(f.calls.length, 0);
});
test('quota failure still returns the downloaded file and reports the problem', async () => {
  const f = fixture(); f.state.quota = true; const result = await f.fetchAsset('game.zip');
  assert.equal(await result.response.text(), 'abcdef'); await result.done();
  assert.ok(f.notices.some(item => item.message.includes('storage is full')));
  assert.equal((await f.fetchAsset('game.zip')).response.status, 200); assert.equal(f.calls.length, 2);
});
test('interrupted streams are not retained and can be downloaded again', async () => {
  const f = fixture(); f.state.network = () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('interrupted')); } }));
  const first = await f.fetchAsset('game.zip'); await assert.rejects(first.response.text()); await first.done();
  f.state.network = () => new Response('complete'); const next = await f.fetchAsset('game.zip');
  assert.equal(await next.response.text(), 'complete'); await next.done(); assert.equal(f.calls.length, 2);
});
test('cached files serve byte ranges without a network download', async () => {
  const f = fixture(); const first = await f.fetchAsset('audio.ogg'); await first.done();
  const next = await f.fetchAsset('audio.ogg', { headers: { Range: 'bytes=1-3' } });
  assert.equal(next.response.status, 206); assert.equal(await next.response.text(), 'bcd'); assert.equal(f.calls.length, 1);
});
test('partial and failed responses are never retained as full files', async () => {
  const f = fixture(); f.state.network = () => new Response('partial', { status: 206 });
  const first = await f.fetchAsset('audio.ogg', { headers: { Range: 'bytes=1-3' } }); await first.done();
  f.state.network = () => new Response('missing', { status: 404 }); const next = await f.fetchAsset('missing'); await next.done();
  assert.equal([...f.buckets.entries()].filter(([name]) => name.includes('assets')).reduce((n, [, bucket]) => n + bucket.size, 0), 0);
});
test('a range response containing the entire file can be reused for later ranges', async () => {
  const f = fixture(); f.state.network = () => new Response('abcdef', { status: 206, headers: { 'Content-Range': 'bytes 0-5/6' } });
  const first = await f.fetchAsset('video.webm', { headers: { Range: 'bytes=0-' } }); await first.done();
  const next = await f.fetchAsset('video.webm', { headers: { Range: 'bytes=2-4' } });
  assert.equal(next.response.status, 206); assert.equal(await next.response.text(), 'cde'); assert.equal(f.calls.length, 1);
});
test('pausing prevents an existing game tab from retaining more downloads', async () => {
  const f = fixture(); assert.equal((await f.message('vnm-cache-pause')).ok, true);
  const result = await f.fetchAsset('image.webp'); assert.equal(await result.response.text(), 'abcdef'); await result.done();
  assert.equal([...f.buckets.entries()].filter(([name]) => name.includes('assets')).reduce((n, [, bucket]) => n + bucket.size, 0), 0);
  assert.equal((await f.message('vnm-cache-enable')).ok, true);
  const next = await f.fetchAsset('image.webp'); await next.done();
  assert.ok([...f.buckets.entries()].some(([name, bucket]) => name.includes('assets') && bucket.size === 1));
});
test('ordinary catalog caching does not claim that the full offline download finished', async () => {
  const f = fixture(); const catalog = await f.fetchAsset('pwa_catalog.json'); await catalog.done();
  assert.equal((await f.fetchAsset('pwa_catalog.json?cached')).response.status, 404);
  const receipt = await f.fetchAsset('pwa_catalog.json?uncached'); await receipt.done();
  assert.equal((await f.fetchAsset('pwa_catalog.json?cached')).response.status, 200);
});
test('the existing RenPy clear-downloads control preserves the pause marker', async () => {
  const f = fixture(); const first = await f.fetchAsset('game.zip'); await first.done();
  assert.equal((await f.message(['clearCache'])).ok, true);
  assert.ok(![...f.buckets.keys()].some(name => name.includes('assets')));
  const next = await f.fetchAsset('game.zip'); await next.done();
  assert.ok([...f.buckets.entries()].filter(([name]) => name.includes('assets')).every(([, bucket]) => bucket.size === 0));
});
test('unused older builds are removed, while a build still running in another tab is kept', async () => {
  const f = fixture();
  const oldName = `vnm-game-assets-v1-${game}-${'c'.repeat(24)}`;
  const oldScope = `${origin}/web-builds/.vnm-cache/${game}/${'c'.repeat(24)}/`;
  f.buckets.set(oldName, new Map([[oldScope + 'game.zip', new Response('old')]]));
  f.buckets.set(oldName.replace('assets', 'info'), new Map([[oldScope + '__descriptor__', Response.json({ scope: oldScope })]]));
  f.state.clients = [{ url: oldScope + 'index.html', postMessage() {} }];
  await f.message('vnm-cache-enable'); assert.ok(f.buckets.has(oldName), 'open old game remains cached');
  f.state.clients = []; const result = await f.message('vnm-cache-enable');
  assert.ok(!f.buckets.has(oldName)); assert.deepEqual(Array.from(result.removedScopes), [oldScope]);
});
test('removal frees a full quota before saving the surviving-tab pause marker', async () => {
  const f = fixture(); const first = await f.fetchAsset('game.zip'); await first.done(); f.state.quotaInfo = true;
  assert.equal((await f.message('vnm-cache-pause')).ok, true);
  assert.ok(![...f.buckets.keys()].some(name => name.includes('assets')));
});
test('removal cancels an unfinished cache write without cancelling the game download', async () => {
  const f = fixture(); let source;
  f.state.network = () => new Response(new ReadableStream({ start(controller) { source = controller; } }));
  const result = await f.fetchAsset('game.zip');
  // Let the storage branch attach its reader without finishing the network body.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.message('vnm-cache-pause')).ok, true);
  source.enqueue(new TextEncoder().encode('game-data')); source.close();
  assert.equal(await result.response.text(), 'game-data'); await result.done();
  assert.ok(![...f.buckets.keys()].some(name => name.includes('assets')));
  assert.equal(f.notices.length, 0, 'intentional removal is not a storage-error notice');
});
