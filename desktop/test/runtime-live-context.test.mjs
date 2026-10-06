import test from 'node:test';
import assert from 'node:assert/strict';
import api from '../../docs/runtime-session.js';
import turns from '../../docs/runtime-turns.js';
import concurrency from '../../shared/runtime-concurrency.js';
const tool={type:'function',function:{name:'host_project_status',parameters:{type:'object',properties:{},additionalProperties:false}}};
async function fixture(t){
 let permission='full_access',mcp=true,source=true,skill=true,runs=0;
 const controller=new AbortController(),project={workspaceId:'project'},context={project,sourceMap:{paperSources:[{sourceId:'paper',contentHash:'hash'}]}};
 const scope={project,context,options:{question:'Read',signal:controller.signal},hardSelection:true,selected:['paper'],sourceVersions:{paper:'hash'},paths:[]};
 const service={workspace:{workspace:project,state:{memory:{records:[]}}},agentTurns:new Map([['turn',scope]]),runtimeStateContext:async()=>source?context:{...context,sourceMap:{paperSources:[]}}};
 const workflow=async(name,input)=>{
  if(name==='runtime_skills_context')return {advancedRuntimeVersion:1,catalog:[{name:'inspect',enabled:skill,available:true}],active:[]};
  if(name==='runtime_mcp_definitions')return {tools:mcp?[{type:'function',function:{name:'mcp_fixture_read',parameters:{type:'object',properties:{}}}}]:[]};
  if(name==='runtime_advanced_open')return {dynamicTools:[tool]};
  if(name==='runtime_advanced_close')return {closed:true};
  if(name==='runtime_advanced_call'){runs++;return {projectOpen:true};}
  throw new Error(name);
 };
 const session=await api.create({options:{mode:'agent_instruction',model:'model',originalRequest:'Read',localWorkspaceContext:context,callContext:{turnId:'turn'},desktopTools:{permission:'full_access'},signal:controller.signal,livePermission:()=>permission},queue:new turns.InjectionQueue(),service,workflow,isCurrent:()=>true,requestChild:async()=>({reply:'done'})});
 t.after(()=>session.close());session.bindModel('model');
 return {session,service,get runs(){return runs;},setPermission:p=>permission=p,revokeMcp:()=>mcp=false,invalidate:()=>source=false,disableSkill:()=>skill=false};
}
test('checkpoint refresh revokes MCP and disabled skills without widening the captured catalog',async t=>{
 const f=await fixture(t);f.revokeMcp();f.disableSkill();const checkpoint=await f.session.atCheckpoint();assert.deepEqual(checkpoint.revokedTools,['mcp_fixture_read']);
 await assert.rejects(f.session.execute({id:'mcp',name:'mcp_fixture_read',args:{}}),{code:'TOOL_CAPABILITY_REVOKED'});
 const skill=await f.session.execute({id:'skill',name:'skills_read',args:{name:'inspect'}});assert.equal(skill.result.ok,false);
});
test('source invalidation cancels the turn before stale context can be reused',async t=>{
 const f=await fixture(t);f.invalidate();await assert.rejects(f.session.atCheckpoint(),{code:'SOURCE_SCOPE_INVALIDATED'});
 await assert.rejects(f.session.execute({id:'later',name:'host_project_status',args:{}}),{code:'OPERATION_ABORTED'});assert.equal(f.runs,0);
});
test('live permission revocation blocks queued execution; messages cannot restore permission',async t=>{
 const f=await fixture(t);f.setPermission('read_only');await assert.rejects(f.session.execute({id:'revoked',name:'host_project_status',args:{}}),{code:'PERMISSION_REVOKED'});assert.equal(f.runs,0);
 f.setPermission('full_access');await assert.rejects(f.session.execute({id:'again',name:'host_project_status',args:{}}),{code:'OPERATION_ABORTED'});
});
test('verified early and complete handoff share one admission and receipt',async t=>{
 const f=await fixture(t),call={id:'call_1',name:'host_project_status',args:{}},scope={turnId:'turn',projectId:'project',model:'model'};
 let verified=0;const value={call,scope,identity:{step:{toolNames:[call.name]},authority:{surface:'agent_command',permission:'full_access'}}};
 f.session.executeEarly({ticket:'signed',scope},async()=>{verified++;return value;});
 await new Promise(r=>setImmediate(r));
 const result=await f.session.execute(call);assert.equal(result.result.ok,true);assert.equal(f.runs,1);
 f.session.executeEarly({ticket:'signed',scope},async()=>{throw new Error('must not reverify');});assert.equal(verified,1);
 await assert.rejects(f.session.execute({...call,args:{changed:true}}),{code:'RUNTIME_RECEIPT_CONFLICT'});
});
test('audited concurrency excludes browsers, acquisition, source preparation and untrusted MCP hints',()=>{
 for(const name of ['notes_read_file','read_post','host_project_status'])assert(concurrency.parallelSafe(name));
 for(const name of ['notes_write_file','post','read_paper_evidence','download_papers','literature_worker','mcp_readonly_hint'])assert(!concurrency.parallelSafe(name));
});
