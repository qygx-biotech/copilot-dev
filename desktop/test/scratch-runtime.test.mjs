import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ScratchRuntime } from '../services/scratch-runtime.mjs';
import { applyPatch } from '../services/scratch-patch.mjs';
import { ProjectFilesystem } from '../services/project-filesystem.mjs';
const enabled = process.env.BIODESIGN_SANDBOX_TEST === '1';

test('missing sandbox executable is unavailable without throwing', async () => {
 const runtime = new ScratchRuntime({ platform:'darwin', executable:'/nonexistent/biodesign-node' });
 assert.equal(await runtime.available(),false); await runtime.close();
});

test('patch validates every hunk before writing and supports add/update/move/delete', async t => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'scratch-patch-')); t.after(() => rm(root,{recursive:true,force:true})); const fs = await ProjectFilesystem.open(root);
 await applyPatch(fs, '*** Begin Patch\n*** Add File: a.txt\n+hello\n+world\n*** End Patch');
 await assert.rejects(applyPatch(fs, '*** Begin Patch\n*** Update File: a.txt\n@@\n-missing\n+bad\n*** End Patch'), {code:'INVALID_PATCH'});
 assert.equal(await fs.readText('a.txt'),'hello\nworld\n');
 await applyPatch(fs,'*** Begin Patch\n*** Update File: a.txt\n*** Move to: sub/b.txt\n@@\n hello\n-world\n+earth\n*** End Patch');
 assert.equal(await fs.readText('sub/b.txt'),'hello\nearth\n'); assert.equal(await fs.exists('a.txt'),false);
 await assert.rejects(applyPatch(fs,'*** Begin Patch\n*** Add File: ../escape\n+bad\n*** End Patch'));
 await applyPatch(fs,'*** Begin Patch\n*** Delete File: sub/b.txt\n*** End Patch'); assert.equal(await fs.exists('sub/b.txt'),false);
});

test('real scratch sandbox executes, streams stdin, isolates resources and kills owned processes', {skip:!enabled}, async t => {
 const runtime = new ScratchRuntime(); t.after(() => runtime.close()); assert.equal(await runtime.available(),true); await runtime.open('owner'); await runtime.open('other');
 let r = await runtime.call('owner','exec_command',{cmd:'printf hello',yield_time_ms:1000}); assert.equal(r.output,'hello',JSON.stringify(r)); assert.equal(r.exit_code,0);
 r = await runtime.call('owner','exec_command',{cmd:'read line; printf "%s" "$line"',yield_time_ms:1}); assert.equal(r.status,'running');
 await assert.rejects(runtime.call('other','write_stdin',{process_id:r.process_id}), {code:'PROCESS_NOT_FOUND'});
 r = await runtime.call('owner','write_stdin',{process_id:r.process_id,chars:'world\n',yield_time_ms:1000}); assert.equal(r.output,'world');
 const secretRoot = await mkdtemp(path.join(os.tmpdir(),'protected-project-')); t.after(()=>rm(secretRoot,{recursive:true,force:true})); const secret = path.join(secretRoot,'secret.txt'); await writeFile(secret,'private-paper');
 r = await runtime.call('owner','exec_command',{cmd:`/bin/cat '${secret}'`,yield_time_ms:1000}); assert.notEqual(r.exit_code,0); assert(!r.output.includes('private-paper'));
 r = await runtime.call('owner','exec_command',{cmd:'/usr/bin/curl https://example.com',yield_time_ms:1000}); assert.notEqual(r.exit_code,0);
 r = await runtime.call('owner','exec_command',{cmd:'while :; do :; done',yield_time_ms:1,timeout_ms:50}); assert.equal(r.status,'running');
 r = await runtime.call('owner','write_stdin',{process_id:r.process_id,yield_time_ms:1000}); assert.equal(r.error,'EXECUTION_TIMEOUT');
 r = await runtime.call('owner','exec_command',{cmd:'printf child | /bin/cat',yield_time_ms:1000}); assert.notEqual(r.exit_code,0, 'child fork must be denied');
 const otherRoot = runtime.session('other').root;
 await runtime.session('other').fs.writeText('private.txt','other-owner-secret');
 r = await runtime.call('owner','exec_command',{cmd:`/bin/cat '${otherRoot}/private.txt'`,yield_time_ms:1000}); assert.notEqual(r.exit_code,0); assert(!r.output.includes('other-owner-secret'));
});

test('real code cells bridge structured tool calls and deny ambient host access', {skip:!enabled}, async t => {
 const runtime = new ScratchRuntime(); t.after(()=>runtime.close()); await runtime.open('owner');
 let r = await runtime.call('owner','run_code',{code:'text(await tools.clock_curr_time({})); return 42;',yield_time_ms:1000});
 assert.equal(r.status,'running',JSON.stringify(r)); assert.equal(r.tool_calls[0].name,'clock_curr_time');
 r = await runtime.reply('owner',r.cell_id,[{id:r.tool_calls[0].id,result:{ok:true,value:{current_time:'fixture'}}}]);
 if(r.status==='running') r = await runtime.call('owner','wait_code',{cell_id:r.cell_id,yield_time_ms:1000});
 assert.equal(r.status,'completed',JSON.stringify(r)); assert.equal(r.value,42); assert.match(r.output,/fixture/);
 r = await runtime.call('owner','run_code',{code:"const fs=await import('node:fs/promises'); await fs.readFile('/etc/passwd');",yield_time_ms:1000});
 assert.equal(r.status,'failed'); assert.match(r.error,/EPERM|EACCES/);
 await Promise.all([runtime.open('concurrent'),runtime.open('concurrent')]); assert.equal(runtime.sessions.size,2);
 // A timer keeps the process alive while the turn closes.
 r = await runtime.call('owner','run_code',{code:'await new Promise(resolve => setTimeout(resolve,60000));',yield_time_ms:1});
 const process = runtime.session('owner').cells.get(r.cell_id); const root = runtime.session('owner').root;
 await runtime.closeOwner('owner'); assert.equal(process.done,true); assert.equal(runtime.sessions.has('owner'),false);
 await assert.rejects((await import('node:fs/promises')).stat(root),{code:'ENOENT'});
 const starts = await Promise.allSettled(Array.from({length:5},()=>runtime.start('concurrent','/bin/sh',['-c','while :; do :; done'],{timeout_ms:5000})));
 assert.equal(starts.filter(p=>p.status==='fulfilled').length,4);
 assert.equal(starts.find(p=>p.status==='rejected').reason.code,'EXECUTION_LIMIT');
 await runtime.closeOwner('concurrent');
});
