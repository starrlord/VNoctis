import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
const code=readFileSync(new URL('../public/app-offline-worker.js',import.meta.url),'utf8');
function fixture(){
  const origin='https://test.invalid',listeners={},buckets=new Map();
  const data=new Map([['/index.html','<head>public app</head>'],['/assets/app.js','app'],['/save-sync.js','bridge'],['/save-offline.js','saves'],['/game-cache-worker.js','worker']]);
  const manifest={version:'__VNM_SHELL_VERSION__',files:[...data].map(([path,body])=>({path,size:Buffer.byteLength(body),hash:createHash('sha256').update(body).digest('hex')}))};
  const state={offline:false};
  const caches={open:async name=>{if(!buckets.has(name))buckets.set(name,new Map());const cache=buckets.get(name),key=value=>new URL(typeof value==='string'?value:value.url,origin).href;
    return {match:async value=>cache.get(key(value))?.clone(),put:async(value,response)=>cache.set(key(value),new Response(await response.arrayBuffer(),{headers:response.headers})),delete:async value=>cache.delete(key(value))};}};
  const self={location:{origin},clients:{claim:async()=>{}},skipWaiting:async()=>{},addEventListener:(type,listener)=>listeners[type]=listener};
  vm.runInNewContext(code,{self,caches,crypto:webcrypto,URL,Response,AbortSignal,Uint8Array,fetch:async value=>{
    if(state.offline)throw Error('offline');const pathname=new URL(typeof value==='string'?value:value.url,origin).pathname;
    return pathname==='/offline-shell.json'?Response.json(manifest):new Response(data.get(pathname)||'network',{status:200});
  }});
  return {state,data,manifest,caches,install:()=>new Promise((resolve,reject)=>listeners.install({waitUntil:task=>task.then(resolve,reject)})),check:async()=>{let result;await new Promise(resolve=>listeners.message({data:{type:'vnm-shell-check'},ports:[{postMessage:value=>result=value}],waitUntil:task=>task.then(resolve)}));return result;},fetch:async(path,mode='cors')=>{let response;listeners.fetch({request:{url:origin+path,method:'GET',mode},respondWith:task=>response=task});return response;}};
}
test('verified public shell reopens offline without caching or intercepting API/auth traffic',async()=>{
  const f=fixture();await f.install();assert.equal((await f.check()).ok,true);f.state.offline=true;
  assert.equal(await(await f.fetch('/dashboard','navigate')).text(),'<head>public app</head>');
  assert.equal(await(await f.fetch('/save-sync.js?v=version')).text(),'bridge');
  assert.equal(await f.fetch('/api/v1/games/abc/saves'),undefined);assert.equal(await f.fetch('/api/v1/auth/me'),undefined);
  assert.equal(await f.fetch('/web-builds/.vnm-cache/game/build/index.html','navigate'),undefined);
  const cache=await f.caches.open('vnm-offline-shell-v1-__VNM_SHELL_VERSION__');await cache.put('/save-sync.js',new Response('bad'));
  assert.equal((await f.check()).ok,false);
});
test('changed app files and forbidden manifest entries cannot finish installation',async()=>{
  for(const mode of ['changed','private']){const f=fixture();if(mode==='changed')f.data.set('/assets/app.js','different');else f.manifest.files.push({path:'/api/v1/auth/me',size:0,hash:'0'.repeat(64)});await assert.rejects(f.install());}
});
