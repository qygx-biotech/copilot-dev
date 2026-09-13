'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const semantic=require('../../shared/semantic-intent.js');
const contract=require('../../shared/academic-tools.js');
const {runSideChatAgent}=require('../side-chat-agent.js');
const continuation=require('../agent-continuation.js');
const academic=require('../academic-agent.js');
const query='Find papers about enzyme engineering and download two papers.';
const ir={...semantic.interpretLocal({query}),matchedPattern:null,retrievalScope:'web',objects:['literature'],operations:['search','store'],capabilityHints:['search_papers','download_sources'],requestedOutput:{type:'papers',limit:2}};
const ref='paper_'+'1'.repeat(24),ref2='paper_'+'2'.repeat(24);
const paper=(paper_ref=ref)=>({paper_ref,title:'Paper '+paper_ref,authors:['A'],doi:'10.1000/a',abstract:'Evidence metadata',providers:[{source:'arxiv',paper_id:'abc'}],locations:[{url:'https://example.org/a.pdf',kind:'pdf_candidate'}]});
const searchResult={version:1,status:'completed',papers:[paper(),paper(ref2)]};
const call=(name,args,id=name)=>({type:'function',id,function:{name,arguments:JSON.stringify(args)}});
function run(extra={}){return runSideChatAgent({originalRequest:query,conversationMessages:[{role:'user',content:query}],workspaceContext:{localWorkspaceContext:{project:{workspaceId:'p'},semantic:{ir}}},systemPrompt:'Complete the task',model:'fixture/model',surface:'agent_command',desktopDownloads:true,desktopAcademic:true,downloadPermission:'workspace_write',supportsWebSearch:true,parseFinalAnswer:reply=>({reply}),...extra});}

test('Agent paper tools skip hosted search and resume search → selected downloads → actual outcomes',async()=>{
 const first=await run({requestTurn:async request=>{
  assert.ok(request.tools.some(x=>x.function.name==='search_academic_papers'));
  assert.ok(request.tools.every(x=>x.type==='function'));
  assert.ok(!request.tools.some(x=>x.function.name==='download_sources'));
  return {ok:true,message:{tool_calls:[call('search_academic_papers',{query:'enzyme engineering'})]}};
 }});
 assert.equal(first.data.desktopToolCalls[0].name,'search_academic_papers');
 const binding={account:'a',project:'p'},secret='fixture';
 const resume=continuation.withResults(continuation.open(continuation.seal(first.continuationState,binding,secret),binding,secret),[{id:'search_academic_papers',result:searchResult}]);
 const second=await run({resume,requestTurn:async request=>{
  assert.ok(request.messages.some(x=>x.role==='tool'&&x.content.includes(ref)));
  return {ok:true,message:{tool_calls:[call('download_papers',{paper_refs:[ref,ref2]})]}};
 }});
 const downloaded={version:1,status:'partial',results:[{paper_ref:ref,status:'downloaded',path:'literature/a.pdf',contentType:'application/pdf'},{paper_ref:ref2,status:'failed',error:{code:'NO_ACCESSIBLE_PDF'}}]};
 const next=continuation.withResults(second.continuationState,[{id:'download_papers',result:downloaded}]);
 const third=await run({resume:next,requestTurn:async()=>({ok:true,message:{content:'Saved all papers.'}})});
 assert.equal(third.data.taskOutcome.status,'incomplete');
 assert.equal(third.data.taskOutcome.downloadSuccessCount,1);
 assert.match(third.data.reply,/1 \/ 2 PDFs saved/);
 assert.equal(third.data.academicSources.length,2);
 assert.equal(third.data.webSearchStatus,undefined);
});

test('read-only Agent search is allowed; downloads are unavailable; Side Chat retains native search',async()=>{
 const result=await run({downloadPermission:'read_only',requestTurn:async request=>{
  assert.ok(request.tools.some(x=>x.function.name==='search_academic_papers'));
  assert.ok(!request.tools.some(x=>x.function.name==='download_papers'));
  return {ok:true,message:{tool_calls:[call('search_academic_papers',{query:'topic'})]}};
 }});
 assert.equal(result.data.desktopToolCalls.length,1);
 let n=0;
 await run({surface:'side_chat',requestTurn:async request=>{
  if(!n++) assert.deepEqual(request.tools,[{type:'web_search'}]);
  else assert.ok(!request.tools.some(x=>contract.isTool(x.function?.name)));
  return {ok:true,message:{content:'Result'}};
 }});
 assert.equal(n,2);
});

test('search-only requests cannot execute downloads even when model invents a call',async()=>{
 let n=0;
 const localIr={...ir,operations:['search'],capabilityHints:['search_papers']};
 const result=await run({workspaceContext:{localWorkspaceContext:{semantic:{ir:localIr}}},requestTurn:async request=>{
  if(!n++) return {ok:true,message:{tool_calls:[call('download_papers',{paper_refs:[ref]})]}};
  if(n===2){assert.ok(request.messages.some(x=>x.role==='tool'&&x.content.includes('PERMISSION_DENIED')));return {ok:true,message:{tool_calls:[call('search_academic_papers',{query:'topic'})]}};}
  throw Error('unexpected');
 }});
 assert.equal(result.data.desktopToolCalls[0].name,'search_academic_papers');
 assert.deepEqual(result.continuationState.academicState.attemptedRefs,[]);
});

test('continuations reject mismatched paper handles, fake paths and altered bindings',()=>{
 const state={academicState:academic.initial(),pending:[{id:'d',name:'download_papers',args:{paper_refs:[ref]}}],agentMessages:[{role:'tool',tool_call_id:'d',content:'pending'}]};
 for(const result of [{version:1,status:'completed',results:[{paper_ref:ref2,status:'downloaded',path:'literature/a.pdf',contentType:'application/pdf'}]},{version:1,status:'completed',results:[{paper_ref:ref,status:'downloaded',path:'../outside.pdf',contentType:'application/pdf'}]}]){
  assert.throws(()=>continuation.withResults(structuredClone(state),[{id:'d',result}]),{code:'INVALID_TOOL_CONTINUATION'});
 }
 const token=continuation.seal(state,{permission:'workspace_write',academicVersion:1},'secret');
 assert.throws(()=>continuation.open(token,{permission:'read_only',academicVersion:1},'secret'),{code:'INVALID_TOOL_CONTINUATION'});
});

test('successful subset does not satisfy requested paper count',()=>{
 const state={...academic.initial(),searchCalls:1,attemptedRefs:[ref],downloads:[{paper_ref:ref,status:'downloaded'}]};
 assert.equal(academic.outcome(state,true,5,true).status,'incomplete');
 assert.equal(academic.outcome(state,true,1,true).status,'completed');
});

test('a failed first page triggers one recovery, pages the original query and counts replacement successes',async()=>{
 const ref3='paper_'+'3'.repeat(24),ref4='paper_'+'4'.repeat(24);
 const first=await run({requestTurn:async()=>({ok:true,message:{tool_calls:[call('search_academic_papers',{query:'enzyme engineering',limit:2})]}})});
 assert.equal(first.data.desktopToolCalls[0].args.prefer_open_access,true);
 const found=continuation.withResults(first.continuationState,[{id:'search_academic_papers',result:{...searchResult,next_cursor:'set:2',total_candidates:53}}]);
 const second=await run({resume:found,requestTurn:async()=>({ok:true,message:{tool_calls:[call('download_papers',{paper_refs:[ref,ref2]})]}})});
 const failed=continuation.withResults(second.continuationState,[{id:'download_papers',result:{version:1,status:'partial',results:[ref,ref2].map(paper_ref=>({paper_ref,status:'failed',error:{code:'NO_ACCESSIBLE_PDF'}}))}}]);
 let count=0;
 const third=await run({resume:failed,requestTurn:async request=>{
  if(!count++) return {ok:true,message:{content:'Cannot download any papers due to copyright.'}};
  assert.ok(request.messages.some(item=>item.role==='system'&&item.content.includes('one bounded recovery')));
  assert.ok(request.messages.some(item=>item.role==='system'&&item.content.includes('set:2')));
  return {ok:true,message:{tool_calls:[call('search_academic_papers',{query:'enzyme engineering',limit:2,cursor:'set:2'},'page2')]}};
 }});
 assert.equal(third.continuationState.academicState.downloadRecoveryUsed,true);
 const paged=continuation.withResults(third.continuationState,[{id:'page2',result:{version:1,status:'completed',papers:[paper(ref3),paper(ref4)],next_cursor:null,total_candidates:53}}]);
 const fourth=await run({resume:paged,requestTurn:async()=>({ok:true,message:{tool_calls:[call('download_papers',{paper_refs:[ref3,ref4]},'retry')]}})});
 const saved=continuation.withResults(fourth.continuationState,[{id:'retry',result:{version:1,status:'completed',results:[ref3,ref4].map(paper_ref=>({paper_ref,status:'downloaded',path:`literature/${paper_ref}.pdf`,contentType:'application/pdf'}))}}]);
 const final=await run({resume:saved,requestTurn:async()=>({ok:true,message:{content:'Saved two relevant papers.'}})});
 assert.equal(final.data.taskOutcome.status,'completed');assert.equal(final.data.taskOutcome.downloadSuccessCount,2);
 assert.equal(final.data.taskOutcome.downloadFailureCount,2);assert.equal(final.data.taskOutcome.downloadRecovery,true);
});

test('download recovery respects permissions, the existing step budget and its one-use bound',async()=>{
 const state={...academic.initial(),searchCalls:1,papers:[paper()],attemptedRefs:[ref],downloads:[{paper_ref:ref,status:'failed',error:{code:'NO_ACCESSIBLE_PDF'}}]};
 assert.equal(academic.recoveryMessage(state,true,false,2),'');
 assert.equal(academic.recoveryMessage(state,false,true,2),'');
 assert.equal(academic.recoveryMessage({...state,downloadRecoveryUsed:true},true,true,2),'');
 let count=0;
 const resume={academicState:state,agentMessages:[{role:'user',content:query}],originalRequest:query,step:6,totalToolCalls:2};
 const result=await run({resume,requestTurn:async()=>{count++;return {ok:true,message:{content:'No download succeeded.'}};}});
 assert.equal(count,1);assert.equal(result.data.taskOutcome.downloadRecovery,false);
});
