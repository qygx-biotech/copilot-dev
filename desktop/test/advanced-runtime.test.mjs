import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ProjectFilesystem } from '../services/project-filesystem.mjs';
import { AdvancedRuntimeService } from '../services/advanced-runtime-service.mjs';
import { ProjectSessionManager } from '../services/project-session.mjs';
import sessionApi from '../../docs/runtime-session.js';
import queueApi from '../../docs/runtime-turns.js';
import runtimeApi from '../../shared/runtime-extensions.js';
const native = process.env.BIODESIGN_SANDBOX_TEST === '1';
async function fixture(t, options = {}) {
 const root = await mkdtemp(path.join(os.tmpdir(),'advanced-runtime-'));
 const filesystem = await ProjectFilesystem.open(root); const service = new AdvancedRuntimeService({filesystem,...options});
 // Close turns (and their final records) before the project folder is removed.
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});return {service,filesystem,root};
}
test('unavailable dependencies stay unavailable and dynamic schemas enforce host admission',async t=>{
 let runs=0;const {service}=await fixture(t,{scratch:{available:async()=>false,close:async()=>{},closeOwner:async()=>{}},dynamicTools:[{definition:{type:'function',function:{name:'host_status',parameters:{type:'object',properties:{},additionalProperties:false}}},execute:async()=>({runs:++runs})}]});
 const owner=crypto.randomUUID(), cap=await service.open({owner,surface:'side_chat',permission:'full_access'});assert.equal(cap.scratch,false);assert.deepEqual(cap.dynamicTools,[]);
 await assert.rejects(service.call({owner,call:{id:'denied',name:'host_status',args:{}}}),{code:'DYNAMIC_TOOL_DENIED'});
 const writable=crypto.randomUUID();await service.open({owner:writable,surface:'agent_command',permission:'workspace_write'});
 await assert.rejects(service.call({owner:writable,call:{id:'invalid',name:'host_status',args:{bad:1}}}),{code:'INVALID_DYNAMIC_TOOL_INPUT'});
 const call={id:'once',name:'host_status',args:{}};await Promise.all([service.call({owner:writable,call}),service.call({owner:writable,call})]);assert.equal(runs,1);
 await assert.rejects(service.call({owner:writable,call:{...call,name:'clock_curr_time'}}),{code:'RUNTIME_RECEIPT_CONFLICT'});
});
test('project execution is its own turn-scoped grant, only for writable Agent Work, and excludes scratch',async t=>{
 const opened=[];
 const fake=(scratchAvailable)=>({available:async()=>scratchAvailable,projectAvailable:async()=>true,open:async owner=>{opened.push(['scratch',owner]);},
  openProject:async(owner,{root})=>{opened.push(['project',owner,root]);},call:async(_owner,name)=>({ran:name}),closeOwner:async()=>{},close:async()=>{}});
 const {service,filesystem}=await fixture(t,{scratch:fake(false)});
 const side=crypto.randomUUID(),sideCaps=await service.open({owner:side,surface:'side_chat',permission:'full_access'});
 assert.deepEqual([sideCaps.scratch,sideCaps.project],[false,false]);
 await assert.rejects(service.grant(side,'project_execution'),{code:'PROJECT_SANDBOX_UNAVAILABLE'});
 const readOnly=crypto.randomUUID();assert.equal((await service.open({owner:readOnly,surface:'agent_command',permission:'read_only'})).project,false);
 const owner=crypto.randomUUID(),caps=await service.open({owner,surface:'agent_command',permission:'workspace_write'});
 assert.deepEqual([caps.scratch,caps.project],[false,true]);assert.ok(caps.unavailableDependencies.includes('CODE_RUNTIME_UNAVAILABLE'));
 assert.ok(!caps.unavailableDependencies.includes('OS_SANDBOX_UNAVAILABLE'));
 await assert.rejects(service.call({owner,call:{id:'early',name:'exec_command',args:{cmd:'true'}}}),{code:'SCRATCH_PERMISSION_REQUIRED'});
 await assert.rejects(service.grant(owner,'network_access'),{code:'INVALID_RUNTIME_CAPABILITY'});
 await assert.rejects(service.grant(owner,'scratch_execution'),{code:'SANDBOX_UNAVAILABLE'});
 assert.deepEqual(await service.grant(owner,'project_execution'),{granted:true,capability:'project_execution',scope:'turn',network:false,project_access:'read',writable:['output/'],not_writable:['output/agent-tasks/'],hidden:['.biodesign/']});
 assert.deepEqual(opened,[['project',owner,filesystem.root]]);
 const ran=await service.call({owner,call:{id:'run',name:'exec_command',args:{cmd:'true'}}});
 assert.equal(ran.ran,'exec_command');assert.deepEqual(ran.output_changes.turn,{created:0,changed:0,deleted:0},'Project calls report output/ changes');
 const both=await fixture(t,{scratch:fake(true)}),scratchOwner=crypto.randomUUID();
 await both.service.open({owner:scratchOwner,surface:'agent_command',permission:'full_access'});
 assert.equal((await both.service.grant(scratchOwner)).capability,'scratch_execution');
 await assert.rejects(both.service.grant(scratchOwner,'project_execution'),{code:'EXECUTION_MODE_CONFLICT'});
});
test('plan mode opens the project read-only, records nothing and refuses tools that write', async t=>{
 const opened=[];let begun=0;
 const scratch={available:async()=>true,projectAvailable:async()=>true,openProject:async(owner,options)=>{opened.push(options.readOnly);},open:async()=>{},
  call:async(_owner,name)=>({ran:name}),closeOwner:async()=>{},close:async()=>{}};
 const provenance={begin:async()=>{begun++;},observe:async()=>{throw new Error('Nothing is observed in plan mode');},finish:async()=>{throw new Error('Nothing is recorded in plan mode');}};
 const {service}=await fixture(t,{scratch,provenance});
 await assert.rejects(service.open({owner:crypto.randomUUID(),surface:'agent_command',permission:'workspace_write',collaborationMode:'review'}),{code:'INVALID_COLLABORATION_MODE'});
 const owner=crypto.randomUUID();
 await service.open({owner,surface:'agent_command',permission:'workspace_write',collaborationMode:'plan'});
 await assert.rejects(service.open({owner,surface:'agent_command',permission:'workspace_write'}),{code:'RUNTIME_OWNER_CONFLICT'},'A turn keeps its mode');
 const grant=await service.grant(owner,'project_execution');
 assert.deepEqual([grant.read_only,grant.writable],[true,[]]);assert.deepEqual(opened,[true]);assert.equal(begun,0);
 assert.deepEqual(await service.call({owner,call:{id:'look',name:'exec_command',args:{cmd:'ls'}}}),{ran:'exec_command'},'Read-only commands run, without output records');
 for(const [id,name,args] of [['patch','apply_patch',{patch:'*** Begin Patch\n*** Add File: output/x.md\n+x\n*** End Patch'}],['image','image_gen_imagegen',{prompt:'x'}],['plugins','list_available_plugins_to_install',{}]])
  await assert.rejects(service.call({owner,call:{id,name,args}}),{code:'PLAN_MODE_READ_ONLY'},name);
 await service.closeOwner(owner);
});
test('the project-session grant workflow opens a project sandbox rooted at the open project', {skip:!native},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'advanced-project-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const host=new ProjectSessionManager({appPath:process.cwd()});await host.open(root);t.after(()=>host.close());
 const run=(id,input)=>host.active.execution.run(id,input),owner=crypto.randomUUID();
 assert.equal((await run('runtime_advanced_open',{owner,surface:'agent_command',permission:'workspace_write',turnId:'native-turn'})).project,true);
 assert.equal((await run('runtime_advanced_grant',{owner,capability:'project_execution'})).capability,'project_execution');
 const result=await run('runtime_advanced_call',{owner,call:{id:'where',name:'exec_command',args:{cmd:'pwd; echo made > output/made.txt',yield_time_ms:5000}}});
 assert.equal(result.output,`${host.active.filesystem.root}\n`,JSON.stringify(result));
 assert.deepEqual(result.output_changes.created,['output/made.txt']);
 assert.equal(await host.active.filesystem.readText('output/made.txt'),'made\n');
 await assert.rejects(run('runtime_advanced_undo',{turnId:'native-turn'}),{code:'TURN_ACTIVE'});
 await run('runtime_advanced_close',{owner});
 assert.deepEqual((await run('runtime_advanced_undo',{turnId:'native-turn'})).removed,['output/made.txt']);
 assert.equal(await host.active.filesystem.exists('output/made.txt'),false);
});
test('in project mode generated images are written under output/generated/', {skip:!native},async t=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64');
 const {service,filesystem}=await fixture(t,{config:{image:{endpoint:'https://images.example/v1/images/generations',model:'configured-image-model',apiKey:'fixture-key'}},
  fetchImpl:async()=>new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}))});
 const owner=crypto.randomUUID();await service.open({owner,surface:'agent_command',permission:'workspace_write'});await service.grant(owner,'project_execution');
 const result=await service.call({owner,call:{id:'image',name:'image_gen_imagegen',args:{prompt:'A controlled fixture'}}});
 assert.match(result.path,/^output\/generated\/[0-9a-f-]{36}\.png$/);
 assert.deepEqual(Buffer.from(await filesystem.readBinary(result.path)),png);
});
test('uncertain effects are journaled and never replayed across service reconstruction',async t=>{
 const options={scratch:{available:async()=>false,close:async()=>{},closeOwner:async()=>{}},dynamicTools:[{definition:{type:'function',function:{name:'host_uncertain',parameters:{type:'object',properties:{},additionalProperties:false}}},execute:async()=>{throw Object.assign(new Error('interrupted'),{code:'FIXTURE_ERROR'});}}]};
 const {service,filesystem}=await fixture(t,options),owner=crypto.randomUUID(),input={owner,surface:'agent_command',permission:'workspace_write'},call={id:'uncertain',name:'host_uncertain',args:{}};
 await service.open(input);await assert.rejects(service.call({owner,call}),{code:'FIXTURE_ERROR'});
 const reopened=new AdvancedRuntimeService({filesystem,...options});t.after(()=>reopened.close());await reopened.open(input);await assert.rejects(reopened.call({owner,call}),{code:'RUNTIME_OUTCOME_UNKNOWN'});
});
test('configured image adapter sends real provider protocol and rejects failures instead of fabricating artifacts', {skip:!native},async t=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64');let calls=0;
 const {service}=await fixture(t,{config:{image:{endpoint:'https://images.example/v1/images/generations',model:'configured-image-model',apiKey:'fixture-key'}},fetchImpl:async(url,request)=>{
  calls++;assert.equal(request.headers.Authorization,'Bearer fixture-key');const input=JSON.parse(request.body);assert.equal(input.model,'configured-image-model');assert.equal(request.redirect,'error');
  if(input.prompt==='provider failure') return new Response('failed',{status:503});
  const bytes=Buffer.from(png); if(input.prompt==='invalid png') bytes[bytes.length-1]^=1;
  return new Response(JSON.stringify({data:[{b64_json:bytes.toString('base64')}]}));
 }});
 const owner=crypto.randomUUID();assert.equal((await service.open({owner,surface:'agent_command',permission:'workspace_write'})).image,true);await service.grant(owner);
 const call={id:'image',name:'image_gen_imagegen',args:{prompt:'A controlled fixture'}};const result=await service.call({owner,call});assert.equal(result.generated,true);assert.equal(result.content[0].type,'image');await service.call({owner,call});assert.equal(calls,1);
 const bytes=Buffer.from(await service.scratch.session(owner).fs.readBinary(result.path));assert.deepEqual(bytes,png);
 await assert.rejects(service.call({owner,call:{id:'failed-image',name:'image_gen_imagegen',args:{prompt:'provider failure'}}}),{code:'IMAGE_PROVIDER_FAILED'});
 await assert.rejects(service.call({owner,call:{id:'invalid-image',name:'image_gen_imagegen',args:{prompt:'invalid png'}}}),{code:'IMAGE_PROVIDER_INVALID_RESULT'});
 await service.closeOwner(owner); assert.deepEqual(Buffer.from(await service.fs.readBinary(result.artifact_path)),png,'Generated originals survive turn cleanup');
});
test('production runtime session admits Code Mode subcalls, preserves receipts, scope and completion', {skip:!native},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'advanced-session-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const host=new ProjectSessionManager({appPath:process.cwd()});await host.open(root);t.after(()=>host.close());
 const project={workspaceId:'workspace'},controller=new AbortController(),context={project,sourceMap:{paperSources:[]},agentLoop:{version:1,paperIds:[]}};
 const scope={project,options:{question:'Compute in scratch',surface:'agent_command',signal:controller.signal},context,hardSelection:true,selected:[],paths:[],sourceVersions:{}};
 const service={workspace:{workspace:project,state:{memory:{records:[]}}},agentTurns:new Map([['turn',scope]]),runtimeStateContext:async()=>context};
 let approvals=0;const session=await sessionApi.create({options:{mode:'agent_instruction',model:'fixture',originalRequest:'Compute',callContext:{turnId:'turn'},localWorkspaceContext:context,desktopTools:{permission:'workspace_write'},signal:controller.signal},queue:new queueApi.InjectionQueue(),service,isCurrent:()=>true,
  workflow:(id,input)=>host.active.execution.run(id,input),requestChild:async()=>{},interaction:{confirm:async()=>{approvals++;return true;},close:()=>{}}});t.after(()=>session.close());session.bindModel('fixture');
 session.observeTools(runtimeApi.definitions(session.extensions,'agent_command','workspace_write'));
 let seq=0;const run=(name,args={})=>session.execute({id:`call-${++seq}`,name,args});
 assert.equal((await run('exec_command',{cmd:'printf blocked'})).result.error.code,'SCRATCH_PERMISSION_REQUIRED');
 assert.equal((await run('request_permissions',{reason:'Compute',capability:'scratch_execution'})).result.value.granted,true);assert.equal(approvals,1);
 let result=await run('run_code',{code:'await tools.notes_write_file({path:"plan",text:"calculated"}); return await tools.notes_read_file({path:"plan"});',yield_time_ms:1000});
 for(let i=0;result.result.value?.status==='running'&&i<5;i++)result=await run('wait_code',{cell_id:result.result.value.cell_id,yield_time_ms:1000});
 assert.equal(result.result.value.status,'completed',JSON.stringify(result));assert.equal(result.result.value.value.text,'calculated');
 result=await run('run_code',{code:'await tools.request_permissions({capability:"scratch_execution",reason:"bypass"});',yield_time_ms:1000});
 for(let i=0;result.result.value?.status==='running'&&i<5;i++)result=await run('wait_code',{cell_id:result.result.value.cell_id,yield_time_ms:1000});
 assert.equal(result.result.value.status,'failed');assert.match(result.result.value.error,/not available/);assert.equal(approvals,1);
 result=await run('run_code',{code:'const errors=[]; for (const name of ["apply_patch","view_image","image_gen_imagegen"]) { try { await tools[name]({}); } catch (e) { errors.push(e.code); } } return errors;',yield_time_ms:1000});
 for(let i=0;result.result.value?.status==='running'&&i<5;i++)result=await run('wait_code',{cell_id:result.result.value.cell_id,yield_time_ms:1000});
 assert.equal(result.result.value.status,'completed');assert.deepEqual(result.result.value.value,Array(3).fill('NESTED_TOOL_DENIED'));
 result=await run('apply_patch',{patch:'*** Begin Patch\n*** Add File: direct.txt\n+direct after cell completion\n*** End Patch'});
 assert.equal(result.result.ok,true);assert.equal(result.result.value.applied[0].path,'direct.txt');
 const direct=await run('host_project_status',{});assert.equal(direct.result.value.projectOpen,true);
 await session.close();assert.equal(host.active.advancedRuntime.scratch.sessions.size,0);
});

test('catalogued plugins import through the existing digest-pinned disabled Apps workflow with durable replay', async t => {
 const root=await mkdtemp(path.join(os.tmpdir(),'advanced-plugin-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const host=new ProjectSessionManager({appPath:process.cwd(),advancedRuntime:{config:{plugins:[{id:'fixture',path:'bundles/fixture.json'}]}}});await host.open(root);t.after(()=>host.close());
 const fs=host.active.filesystem;
 await fs.writeText('bundles/fixture/SKILL.md','---\nname: fixture\ndescription: Controlled instructions\n---\nUse authorized evidence only.');
 await fs.writeText('bundles/fixture.json',JSON.stringify({version:1,id:'fixture',name:'Fixture',skills:[{name:'fixture',path:'fixture/SKILL.md'}]}));
 const service=host.active.advancedRuntime,owner=crypto.randomUUID();assert.equal((await service.open({owner,surface:'agent_command',permission:'workspace_write'})).plugins,true);
 const catalog=await service.call({owner,call:{id:'list',name:'list_available_plugins_to_install',args:{}}});assert.equal(catalog.plugins[0].plugin_id,'fixture');
 const preview=await service.call({owner,call:{id:'request',name:'request_plugin_install',args:{plugin_id:'fixture'}}});assert.equal(preview.approval_required,true);
 await assert.rejects(service.install({owner,plugin_id:'fixture',digest:'changed',call_id:'install'}),{code:'APP_BUNDLE_CHANGED'});
 const input={owner,plugin_id:'fixture',digest:preview.preview.digest,call_id:'install'};await service.install(input);await service.install(input);
 const skills=await host.active.skills.list();assert.equal(skills.skills.find(skill=>skill.name==='fixture').enabled,false);
 assert.equal((await host.active.apps.state()).bundles.length,1);
});
