import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyAsset, verifiedAsset } from '../src/utils/assetVerification.js';
const file=bytes=>({size:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')});
test('streamed archive verification accepts arbitrary chunk boundaries without reading an ArrayBuffer',async()=>{
  const bytes=Buffer.alloc(1024*1024+131,91),entry=file(bytes);
  const response=new Response(new ReadableStream({start(controller){for(let n=0;n<bytes.length;n+=113)controller.enqueue(bytes.subarray(n,n+113));controller.close();}}));
  response.arrayBuffer=()=>{throw Error('must stream')};
  assert.equal(await verifyAsset(response,entry),true);
});
test('corrupt, oversized and truncated streams fail; cancellation and account changes abort before commit',async()=>{
  const bytes=Buffer.from('whole file'),entry=file(bytes);
  for(const value of ['bad bytes!','whole file plus extras','short'])assert.equal(await verifyAsset(new Response(value),entry),false);
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(verifiedAsset(new Response(bytes),entry,{signal:cancelled.signal}).arrayBuffer(),{name:'AbortError'});
  await assert.rejects(verifyAsset(new Response(bytes),entry,{check(){throw Error('Account changed')}}),/Account changed/);
});
