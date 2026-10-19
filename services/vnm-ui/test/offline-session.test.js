import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rememberOfflineSession, offlineSession, forgetOfflineSession } from '../src/utils/offlineSession.js';

const values=new Map();
globalThis.localStorage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
const token=(userId,exp=Math.floor(Date.now()/1000)+1000)=>`header.${Buffer.from(JSON.stringify({userId,exp})).toString('base64url')}.signature`;
test('only the last verified, unexpired account can use an offline profile, without admin privileges',async()=>{
  const a=token('A');localStorage.setItem('vnm-token',a);
  await rememberOfflineSession({userId:'A',username:'alice',role:'admin'},a);
  assert.deepEqual(await offlineSession(a),{userId:'A',username:'alice',role:'viewer'});
  const b=token('B');localStorage.setItem('vnm-token',b);
  assert.equal(await offlineSession(b),null);assert.equal(await offlineSession(a),null);
  localStorage.setItem('vnm-token',a+'forged');assert.equal(await offlineSession(a+'forged'),null);
  const expired=token('A',1);localStorage.setItem('vnm-token',expired);
  await rememberOfflineSession({userId:'A',role:'admin'},expired);assert.equal(await offlineSession(expired),null);
  localStorage.setItem('vnm-token',a);await rememberOfflineSession({userId:'A',role:'admin'},a);
  forgetOfflineSession();assert.equal(await offlineSession(a),null);
});
