import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import offlineRoutes from '../src/routes/offline.js';

test('offline inventory and original asset downloads require auth and stay inside the current completed build', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'vnm-offline-api-')),directory=path.join(root,'game');await mkdir(directory);
  const builtAt=new Date('2026-10-18T12:00:00Z'),content={'index.html':'<head></head>','game data.bin':'original bytes'};
  const files=Object.entries(content).map(([name,bytes])=>({path:name,size:Buffer.byteLength(bytes),hash:createHash('sha256').update(bytes).digest('hex')}));
  const manifest={version:1,id:createHash('sha256').update(JSON.stringify(files)).digest('hex'),files};
  for(const [name,bytes]of Object.entries(content))await writeFile(path.join(directory,name),bytes);
  await writeFile(path.join(directory,'.vnm-offline-manifest.json'),JSON.stringify(manifest));
  const record={id:'X',directoryName:'game',builtAt,buildStatus:'built',webBuildPath:'/web-builds/game'};
  process.env.WEB_BUILDS_PATH=root;const app=Fastify();app.decorate('prisma',{game:{findUnique:async({where})=>where.id==='X'?record:null}});
  app.addHook('onRequest',async request=>{if(request.headers.authorization==='user')request.user={userId:'A'};});await app.register(offlineRoutes,{prefix:'/api/v1'});
  const get=(suffix,auth=true)=>app.inject({url:'/api/v1/games/X/'+suffix,headers:auth?{authorization:'user'}:{}});
  try{
    await t.test('manifest and file endpoints are private, build identity alone is public',async()=>{
      assert.equal((await get('offline-manifest',false)).statusCode,401);
      assert.equal((await get('offline-file?path=index.html',false)).statusCode,401);
      const current=await get('cache-build',false);assert.equal(current.statusCode,200);assert.equal(current.json().version,builtAt.toISOString());
      const reply=await get('offline-manifest');assert.equal(reply.statusCode,200);assert.equal(reply.headers['cache-control'],'no-store');assert.deepEqual(reply.json().files,files);
    });
    await t.test('original bytes are streamed with matching manifest/build identity',async()=>{
      const query=new URLSearchParams({path:'game data.bin',manifest:manifest.id,build:builtAt.toISOString()});
      const reply=await get('offline-file?'+query);assert.equal(reply.statusCode,200);assert.equal(reply.body,'original bytes');assert.equal(reply.headers['x-content-type-options'],'nosniff');
      assert.equal((await get('offline-file?'+new URLSearchParams({...Object.fromEntries(query),path:'../private'}))).statusCode,404);
      assert.equal((await get('offline-file?'+new URLSearchParams({...Object.fromEntries(query),manifest:'different'}))).statusCode,409);
    });
    await t.test('rebuilds, missing inventories and unsafe roots cannot serve a prepared build',async()=>{
      record.buildStatus='building';assert.equal((await get('offline-manifest')).statusCode,409);record.buildStatus='built';
      record.directoryName='..';assert.equal((await get('offline-manifest')).statusCode,400);
      record.directoryName='missing';await mkdir(path.join(root,'missing'));assert.equal((await get('offline-manifest')).statusCode,409);record.directoryName='game';
      await writeFile(path.join(directory,'game data.bin'),'changed bytes and a different length');
      assert.equal((await get('offline-file?'+new URLSearchParams({path:'game data.bin',manifest:manifest.id,build:builtAt.toISOString()}))).statusCode,409);
    });
    await t.test('a replaced asset symlink cannot expose a file outside its build',async context=>{
      const outside=path.join(root,'private.txt');await writeFile(outside,'original bytes');await rm(path.join(directory,'game data.bin'));
      try{await symlink(outside,path.join(directory,'game data.bin'));}catch(error){if(['EPERM','EACCES'].includes(error.code)){context.skip('Host cannot create file symlinks');return;}throw error;}
      assert.equal((await get('offline-file?'+new URLSearchParams({path:'game data.bin',manifest:manifest.id,build:builtAt.toISOString()}))).statusCode,409);
    });
  }finally{await app.close();assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep));await rm(root,{recursive:true,force:true});}
});
