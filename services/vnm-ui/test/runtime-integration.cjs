const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
// Use the unpacked official Ren'Py 8.5.2 web SDK; no third-party game is needed.
if (!process.env.RENPY_WEB_RUNTIME) {
  console.error('Set RENPY_WEB_RUNTIME to the unpacked RenPy web directory.');
  process.exit(1);
}
const root = path.resolve(process.env.RENPY_WEB_RUNTIME);
const bridge = path.resolve(__dirname, '../public/save-sync.js');
const states = new Map();
const token = user => `header.${Buffer.from(JSON.stringify({userId:user})).toString('base64url')}.signature`;
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const user = JSON.parse(Buffer.from(req.headers.authorization.split('.')[1], 'base64url')).userId;
    const key = `${user}:${url.pathname.split('/')[4]}`;
    if (req.method === 'GET') return res.end(JSON.stringify(states.get(key) || {revision:0,snapshot:null}));
    let body=''; for await (const chunk of req) body += chunk;
    const data=JSON.parse(body), prev=states.get(key)?.revision || 0;
    if (data.revision !== prev) {res.statusCode=409; return res.end('{}');}
    const state={revision:prev+1,snapshot:data.snapshot}; states.set(key,state); return res.end(JSON.stringify(state));
  }
  if (url.pathname === '/parent') {
    res.setHeader('Content-Type','text/html'); return res.end(`<script>localStorage.setItem('vnm-token',${JSON.stringify(token(url.searchParams.get('user')||'A'))});window.messages=[];addEventListener('message',e=>messages.push(e.data));</script><iframe src="/fixture?vnmGame=${url.searchParams.get('game')||'X'}&vnmUser=${url.searchParams.get('user')||'A'}"></iframe>`);
  }
  if (url.pathname === '/fixture') {
    res.setHeader('Content-Type','text/html');
    const html=fs.readFileSync(path.join(root,'index.html'),'utf8')
      .replace('<head>','<head><script src="/save-sync.js"></script>')
      .replace('if (navigator.serviceWorker)', 'if (false)')
      .replace('<script async type="text/javascript" src="renpy.js">', '<script>Module.noInitialRun=true;Module.preRun=Module.preRun.filter(f=>f.name!=="runLoadGameZip");</script><script async type="text/javascript" src="renpy.js">');
    return res.end(html);
  }
  const filename = url.pathname === '/save-sync.js' ? bridge : path.join(root, path.basename(url.pathname));
  if (!fs.existsSync(filename)) {res.statusCode=404; return res.end();}
  res.setHeader('Content-Type',url.pathname.endsWith('.js')?'application/javascript':'application/octet-stream'); res.end(fs.readFileSync(filename));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),headless:true});
  const pageErrors=[];
  try {
    const ctx=await browser.newContext(); const page=await ctx.newPage();
    page.on('pageerror',e=>pageErrors.push(e.message));
    await page.goto(`${base}/parent`);
    await page.waitForFunction(()=>messages.some(m=>m.message==='Saves synced'));
    const frame=page.frames()[1];
    await frame.evaluate(async()=>{FS.mkdirTree('/home/web_user/.renpy/game');FS.writeFile('/home/web_user/.renpy/game/1.save',new Uint8Array([1,2,3]));await new Promise((r,j)=>FS.syncfs(false,e=>e?j(e):r()));});
    // Fast uploads deliberately keep the synced status steady.
    const deadline=Date.now()+15000;
    while (!states.get('A:X') && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(states.get('A:X'),'save must upload within fifteen seconds');
    assert.equal(states.get('A:X').snapshot.files[0].data,'AQID');
    const ctx2=await browser.newContext(); const page2=await ctx2.newPage(); page2.on('pageerror',e=>pageErrors.push(e.message)); await page2.goto(`${base}/parent`);
    await page2.waitForFunction(()=>messages.some(m=>m.message==='Saves synced'));
    assert.deepEqual(await page2.frames()[1].evaluate(()=>Array.from(FS.readFile('/home/web_user/.renpy/game/1.save'))),[1,2,3]);
    const ctx3=await browser.newContext(); const page3=await ctx3.newPage(); page3.on('pageerror',e=>pageErrors.push(e.message)); await page3.goto(`${base}/parent?user=B`);
    await page3.waitForFunction(()=>messages.some(m=>m.message==='Saves synced'));
    assert.equal(await page3.frames()[1].evaluate(()=>FS.analyzePath('/home/web_user/.renpy/game/1.save').exists),false);
    const ctx4=await browser.newContext(); const page4=await ctx4.newPage(); await page4.goto(`${base}/parent?game=Y`);
    await page4.waitForFunction(()=>messages.some(m=>m.message==='Saves synced'));
    assert.equal(await page4.frames()[1].evaluate(()=>FS.analyzePath('/home/web_user/.renpy/game/1.save').exists),false);
    assert.deepEqual(pageErrors,[]);
    console.log('PASS: actual RenPy 8.5.2 FS/IDBFS startup, upload, new-browser restore, user isolation');
  } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
