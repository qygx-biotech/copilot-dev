'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readFile,mkdtemp,rm}=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const jwt=require('jsonwebtoken'),backend=require('../index.js'),semantic=require('../../shared/semantic-intent.js');
const {ProjectContextService}=require('../../docs/project-context-service.js'),{createFixture,SyncWorkspace}=require('./helpers/preflight-fixture.js');
const {LiteratureApiClient}=require('../../docs/literature-module.js');
const academic=require('../../shared/academic-tools.js'),sourceDownload=require('../../shared/source-download.js'),webSearch=require('../../shared/web-search.js'),eventStream=require('../../shared/event-stream.js');
const ref='paper_'+'a'.repeat(24),sourceUrl='https://papers.example.org/ectd.pdf';
const paper={paper_ref:ref,title:'EctD engineering',authors:['A'],doi:'10.1000/ectd',abstract:'Relevant abstract',providers:[{source:'arxiv',paper_id:'fixture'}],locations:[{url:sourceUrl,kind:'pdf_candidate'}]};

for (const mode of ['normal','corrected','exhausted','normalized','search_corrected','search_exhausted']) test(`production renderer/FC/local-MCP literature flow: ${mode}`,async t=>{
 const recover=['corrected','exhausted'].includes(mode),exhausted=mode.endsWith('exhausted'),searchRecovery=mode.startsWith('search_');
 const {ProjectFilesystem}=await import('../../desktop/services/project-filesystem.mjs');
 const {LocalExecutionService}=await import('../../desktop/services/local-execution-service.mjs');
 const {registerAcademicWorkflows}=await import('../../desktop/services/academic-workflows.mjs');
 const root=await mkdtemp(path.join(os.tmpdir(),'biodesign-academic-flow-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const filesystem=await ProjectFilesystem.open(root),pdf=Buffer.from('%PDF-1.7\nfixture');
 const active={execution:new LocalExecutionService(),sourceDownloads:new AbortController()};
 const executed=[],providerArgs=[];
 registerAcademicWorkflows(active,{call:async(name,args)=>{executed.push(name);providerArgs.push(args);return {version:1,status:'completed',papers:[paper]};}},()=>true,{fetchSource:async url=>({bytes:pdf,contentType:'application/pdf',resolvedUrl:url})});
 const model='google/gemini-3.1-flash-lite:flex';
 const env={JWT_SECRET:'academic-secret',ADMIN_ACCOUNT:'academic-user',REQUESTY_API_KEY:'fixture-api-key',REQUESTY_MODEL:model,REQUESTY_TOOL_MODE:'sequential',REQUESTY_MODEL_CAPABILITIES_JSON:JSON.stringify({[model]:{supportsWebSearch:true}})};
 const prior=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
 t.after(()=>{for(const[key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 const token=jwt.sign({account:env.ADMIN_ACCOUNT,role:'admin'},env.JWT_SECRET),requests=[],host=[],providerRoles=[];
 const workspace=new SyncWorkspace();workspace.workspace.workspaceId='project-1';
 const f=await createFixture({workspace,cardFailure:()=>true});
 f.workspace.set('literature/existing.pdf','An existing PDF with no Paper Card');
 let semanticCalls=0;
 const client=new LiteratureApiClient({baseUrl:'https://fc.example.org',getHeaders:()=>({authorization:`Bearer ${token}`}),fetch:async(endpoint,options)=>{
  assert.equal(new URL(endpoint).pathname,'/api/semantic/interpret');
  const result=await backend.handler({httpMethod:'POST',path:new URL(endpoint).pathname,headers:options.headers,body:options.body},{});
  return new Response(result.body,{status:result.statusCode,headers:result.headers});
 }});
 f.literature.api.interpretSemantics=client.interpretSemantics.bind(client);
 const contextService=new ProjectContextService({workspace:f.workspace,literature:f.literature,sourceSystem:f.system,requestPipeline:f.pipeline});
 const tool=(name,args)=>({id:name,type:'function',function:{name,arguments:JSON.stringify(args)}});
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
  const body=JSON.parse(options.body);
  assert.equal(f.calls.cards,0,'No Paper Card call may precede request understanding or external acquisition');
  if (body.response_format?.json_schema?.schema?.properties?.retrievalScope) {
   providerRoles.push('semantic');semanticCalls++;
   assert.equal(requests.length,0);
   const input=JSON.parse(body.messages[1].content);
   const ir={...semantic.interpretLocal(input),objects:['literature'],operations:['search','store'],capabilityHints:['search_papers','download_sources'],matchedPattern:null,retrievalScope:'web',unresolvedSlots:[]};
   return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(ir)},finish_reason:'stop'}]}));
  }
  providerRoles.push('acquisition');requests.push(body);
  assert.equal(semanticCalls,0, 'The first acquisition decision is the main model call');
  assert.equal(f.calls.cards,0,'Existing PDF card generation must not precede any acquisition LLM call');
  assert.ok(body.tools.every(x=>x.type==='function'));
  assert.ok(body.tools.some(x=>x.function.name===(recover&&(requests.length===3||(exhausted&&requests.length===4))?'select_literature_papers':'search_academic_papers')));
  const selection={shortlist:[{paper_ref:ref,relevance:5,covers:['subtopic_1'],reason:'Studies EctD engineering.',evidence:'title_abstract'}],stop_reason:'sufficient_candidates',remaining_gaps:[]};
  const search={query:'EctD engineering',queries:mode==='normalized'?['EctD engineering','ectoine hydroxylase','ectoine hydroxylase']:['ectoine hydroxylase'],...(searchRecovery?{limit:21}:{})};
  let message;
  if(requests.length===1) message={tool_calls:[tool('plan_literature_search',{request_kind:'topic',subtopics:['EctD engineering'],synonyms:['ectoine hydroxylase'],queries:['EctD engineering','ectoine hydroxylase']}),tool('search_academic_papers',search)]};
  else if(searchRecovery&&(requests.length===2||exhausted)) {
   assert.ok(requests.length<=3);
   const error=JSON.parse(body.messages.findLast(m=>m.role==='tool').content).error;
   assert.equal(error.code,'INVALID_ACADEMIC_INPUT');assert.equal(error.field,'limit');assert.equal(error.invalid_value,21);
   assert.equal(error.requires_user_confirmation,false);
   assert.ok(!body.tools.some(tool=>tool.function.name==='plan_literature_search'));
   message={tool_calls:[tool('search_academic_papers',{...search,limit:exhausted?21:error.maximum})]};
  }
  else if(recover&&(requests.length===2||exhausted)) {
   assert.ok(requests.length<=4);
   selection.shortlist[0].covers=['AI-driven synthetic biology applications'];
   message={tool_calls:[tool('select_literature_papers',selection),...(exhausted&&requests.length===4?[tool('download_papers',{paper_refs:[ref]})]:[])]};
  } else if(requests.length===(recover||searchRecovery?3:2)) {
   if(recover) {
    const error=JSON.parse(body.messages.findLast(m=>m.role==='tool').content).error;
    assert.equal(error.code,'UNKNOWN_SELECTION_SUBTOPIC');assert.equal(error.paper_ref,ref);
    assert.equal(error.requires_user_confirmation,false);
    assert.deepEqual(body.tools.find(x=>x.function.name==='select_literature_papers').function.parameters.properties.shortlist.items.properties.covers.items.enum,['subtopic_1']);
   }
   message={tool_calls:[tool('select_literature_papers',selection),tool('download_papers',{paper_refs:[ref]})]};
  } else message={content:JSON.stringify({reply:'Saved selected paper.',project:{summary:'',organism:'',missingInformation:[],safetyLevel:'',safetyNotes:'',draftMemo:''}})};
  return new Response(JSON.stringify({choices:[{message}]}));
 });
 const app=await readFile(path.resolve(__dirname,'../../docs/app.js'),'utf8');
 const functions=['sendWorkbenchRequest','sendWorkbenchRequestOnce'].map(name=>app.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^}$`,'m'))[0]).join('\n');
 const sandbox=vm.createContext({console,JSON,Math,Date,Error,AbortController,Response,TextDecoder,setTimeout,clearTimeout,
  projectContextService:null,MAX_BROWSER_REFERENCE_FILES:1,TOTAL_REFERENCE_TEXT_LIMIT:100,workspaceAbortController:new AbortController(),workspaceManager:{workspace:{workspaceId:'project-1'}},authToken:token,
  experimentModuleCards:[],referenceDocuments:[],activeSideChatDocumentKeys:[],runtimeLog:null,literatureModule:null,
  buildExperimentModulesForRequest:()=>({}),buildFlattenedExperimentDocumentsForRequest:()=>[],collectExperimentNotesForRequest:()=>[],collectSelectedStoredDocumentKeys:()=>[],collectStoredDocumentsForRequest:()=>[],
  buildDocumentsForRequest:()=>[],getProjectContext:()=>'',backendUrl:route=>route,getAuthHeaders:headers=>({...headers,authorization:`Bearer ${token}`}),requireLoginForUnauthorized:()=>{},t:key=>key,
  fetch:async(route,options)=>{host.push(JSON.parse(options.body));const result=await backend.handler({httpMethod:'POST',path:route,headers:options.headers,body:options.body},{});return new Response(result.body,{status:result.statusCode,headers:result.headers});},
  window:{BioDesignAcademicTools:academic,BioDesignSourceDownload:sourceDownload,BioDesignWebSearch:webSearch,BioDesignEventStream:eventStream,biodesignDesktop:{execution:{runWorkflow:({workflowId,input})=>active.execution.run(workflowId,input,{filesystem})}}}
 });
 vm.runInContext(functions,sandbox);
 const query='Search EctD and download 1 relevant PDF';
 const localWorkspaceContext=await contextService.buildContext({surface:'agent_command',turnId:'academic-turn',question:query,callContext:{model}});
 const result=await sandbox.sendWorkbenchRequest({mode:'agent_instruction',model,messages:[{role:'user',content:query}],originalRequest:query,
  localWorkspaceContext,
  desktopTools:{version:1,academicVersion:1,permission:'workspace_write',projectId:'project-1'},callContext:{turnId:'academic-turn',callRole:'answer',profile:'medium'}});
 const expectedCalls=recover||(searchRecovery&&!exhausted)?4:3;
 assert.equal(requests.length,expectedCalls);assert.equal(host.length,exhausted?searchRecovery?1:2:3);
 assert.deepEqual(providerRoles,Array(expectedCalls).fill('acquisition'));
 assert.equal(localWorkspaceContext.semantic,undefined);
 assert.equal(localWorkspaceContext.agentLoop.academicAcquisition,true);
 assert.equal(f.calls.parses,0);assert.equal(f.calls.indexing,0);assert.equal(f.workspace.rawReads,0);
 if(exhausted) {
  assert.deepEqual(executed,searchRecovery?[]:['search_academic_papers']);
  assert.equal(result.taskOutcome.status,'incomplete');
  assert.equal(result.taskOutcome.blocker.code,searchRecovery?'INVALID_ACADEMIC_INPUT':'UNKNOWN_SELECTION_SUBTOPIC');
  assert.equal(result.taskOutcome.downloadAttemptCount,0);
  assert.deepEqual(result.downloadResults,[]);
  assert.match(result.reply,new RegExp(`Search candidates: ${searchRecovery?0:1}; accepted selected papers: 0; successfully saved PDF files: 0`));
  assert.match(result.reply,searchRecovery?/field=limit; invalid_value=21/:/AI-driven synthetic biology applications/);
  assert.match(result.reply,/not a user-confirmation requirement/);
  return;
 }
 assert.deepEqual(executed,['search_academic_papers','resolve_paper_full_text']);
 assert.equal(result.reply,'Saved selected paper.','The renderer receives the final model reply without a replacement summary or appended reasons');
 assert.deepEqual(providerArgs[0].queries,['ectoine hydroxylase']);
 assert.equal(result.taskOutcome.status,'completed');
 assert.equal(result.downloadResults[0].contentType,'application/pdf');
 assert.deepEqual(Buffer.from(await filesystem.readBinary(result.downloadResults[0].path)),pdf);
 assert.equal(result.academicSources[0].paper_ref,ref);
 assert.equal(result.webSearchStatus,undefined);
 assert.ok(!JSON.stringify(host).includes(pdf.toString('base64')));
 assert.ok(host[1].desktopContinuation);assert.ok(host[2].desktopToolResults[0].result.results[0].path);
});
