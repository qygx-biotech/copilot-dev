'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {ContextRecovery}=require('../context-recovery.js');
const {ossStore}=require('../context-archive-store.js');
test('OSS archives survive cold local roots while remaining account and hash bound',async t=>{
 const objects=new Map(),client={put:async(key,bytes,opts)=>{assert.equal(opts.headers['x-oss-object-acl'],'private');objects.set(key,Buffer.from(bytes));},get:async key=>{if(!objects.has(key))throw new Error('missing');return {content:objects.get(key)};}};
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'durable-context-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const options={config:{root},archiveStorage:ossStore(client),archiveAccount:'account/project',model:'fixture'};
 const first=new ContextRecovery(options),ref=await first.store('Complete original evidence, not a summary.');const state=first.snapshot();
 await fs.rm(root,{recursive:true,force:true});
 const cold=new ContextRecovery({...options,state});assert.equal((await cold.readArchive(ref)).content,'Complete original evidence, not a summary.');
 const other=new ContextRecovery({...options,state,archiveAccount:'other/project'});assert.equal((await other.readArchive(ref)).error,'ARCHIVE_UNAVAILABLE');
 objects.set([...objects.keys()][0],Buffer.from('corrupt'));assert.equal((await cold.readArchive(ref)).error,'ARCHIVE_UNAVAILABLE');
});
test('remote archive write failure prevents references being published or offloaded',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'failed-context-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const recovery=new ContextRecovery({config:{root},archiveStorage:{put:async()=>{throw new Error('storage down');}},archiveAccount:'account'});
 await assert.rejects(recovery.store('never lose the original'),/storage down/);assert.deepEqual(recovery.state.references,[]);
});

test('OSS journal claims are exclusive, durable across cold roots and fail closed on unavailable storage',async t=>{
 const objects=new Map(),client={put:async(key,bytes,opts)=>{
  assert.equal(opts.headers['x-oss-forbid-overwrite'],'true');
  if(objects.has(key))throw Object.assign(new Error('exists'),{code:'FileAlreadyExists'});
  objects.set(key,Buffer.from(bytes));
 },get:async key=>{if(!objects.has(key))throw Object.assign(new Error('missing'),{code:'NoSuchKey'});return{content:objects.get(key)};}};
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'corpus-journal-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const first=new ContextRecovery({config:{root},archiveStorage:ossStore(client),archiveAccount:'account'});
 assert.equal(await first.archive.record('pending'),null);
 assert.deepEqual(await Promise.all([first.archive.record('pending',{status:'pending',args:'bound'}),first.archive.record('pending',{status:'changed'})]),[true,false]);
 const cold=new ContextRecovery({config:{root:path.join(root,'cold')},archiveStorage:ossStore(client),archiveAccount:'account',state:first.snapshot()});
 assert.deepEqual(await cold.archive.record('pending'),{status:'pending',args:'bound'});
 client.get=async()=>{throw new Error('storage unavailable');};
 await assert.rejects(cold.archive.record('pending'),/storage unavailable/);
});
