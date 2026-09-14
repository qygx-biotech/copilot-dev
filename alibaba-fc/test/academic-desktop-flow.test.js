'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readFile,mkdtemp,rm}=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const jwt=require('jsonwebtoken'),backend=require('../index.js'),semantic=require('../../shared/semantic-intent.js');
const academic=require('../../shared/academic-tools.js'),sourceDownload=require('../../shared/source-download.js'),webSearch=require('../../shared/web-search.js'),eventStream=require('../../shared/event-stream.js');
const ref='paper_'+'a'.repeat(24),sourceUrl='https://papers.example.org/ectd.pdf';
const paper={paper_ref:ref,title:'EctD engineering',authors:['A'],doi:'10.1000/ectd',abstract:'Relevant abstract',providers:[{source:'arxiv',paper_id:'fixture'}],locations:[{url:sourceUrl,kind:'pdf_candidate'}]};

test('production renderer and authenticated FC resume local academic search and PDF saving without hosted search',async t=>{
 const {ProjectFilesystem}=await import('../../desktop/services/project-filesystem.mjs');
 const {LocalExecutionService}=await import('../../desktop/services/local-execution-service.mjs');
 const {registerAcademicWorkflows}=await import('../../desktop/services/academic-workflows.mjs');
 const root=await mkdtemp(path.join(os.tmpdir(),'biodesign-academic-flow-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const filesystem=await ProjectFilesystem.open(root),pdf=Buffer.from('%PDF-1.7\nfixture');
 const active={execution:new LocalExecutionService(),sourceDownloads:new AbortController()};
 const executed=[];
 registerAcademicWorkflows(active,{call:async(name,args)=>{executed.push(name);return {version:1,status:'completed',papers:[paper]};}},()=>true,{fetchSource:async url=>({bytes:pdf,contentType:'application/pdf',resolvedUrl:url})});
 const model='google/gemini-3.1-flash-lite:flex';
 const env={JWT_SECRET:'academic-secret',ADMIN_ACCOUNT:'academic-user',REQUESTY_API_KEY:'fixture-api-key',REQUESTY_MODEL:model,REQUESTY_TOOL_MODE:'sequential',REQUESTY_MODEL_CAPABILITIES_JSON:JSON.stringify({[model]:{supportsWebSearch:true}})};
 const prior=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
 t.after(()=>{for(const[key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 const token=jwt.sign({account:env.ADMIN_ACCOUNT,role:'admin'},env.JWT_SECRET),requests=[],host=[];
 const tool=(name,args)=>({id:name,type:'function',function:{name,arguments:JSON.stringify(args)}});
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
  const body=JSON.parse(options.body);requests.push(body);
  assert.ok(body.tools.every(x=>x.type==='function'));
  assert.ok(body.tools.some(x=>x.function.name==='search_academic_papers'));
  const message=requests.length===1?{tool_calls:[tool('plan_literature_search',{request_kind:'topic',subtopics:['EctD engineering'],synonyms:['ectoine hydroxylase'],queries:['EctD engineering','ectoine hydroxylase']}),tool('search_academic_papers',{query:'EctD engineering',queries:['ectoine hydroxylase']})]}:requests.length===2?{tool_calls:[tool('select_literature_papers',{shortlist:[{paper_ref:ref,relevance:5,covers:['EctD engineering'],reason:'Studies EctD engineering.',evidence:'title_abstract'}],stop_reason:'sufficient_candidates',remaining_gaps:[]}),tool('download_papers',{paper_refs:[ref]})]}:{content:JSON.stringify({reply:'Saved selected paper.',project:{summary:'',organism:'',missingInformation:[],safetyLevel:'',safetyNotes:'',draftMemo:''}})};
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
 const query='Search EctD and download the relevant PDF';
 const result=await sandbox.sendWorkbenchRequest({mode:'agent_instruction',model,messages:[{role:'user',content:query}],originalRequest:query,
  localWorkspaceContext:{project:{workspaceId:'project-1'},semantic:{ir:{...semantic.interpretLocal({query}),objects:['literature'],operations:['search','store'],capabilityHints:['search_papers','download_sources'],matchedPattern:null,retrievalScope:'web'}}},
  desktopTools:{version:1,academicVersion:1,permission:'workspace_write',projectId:'project-1'},callContext:{turnId:'academic-turn',callRole:'answer',profile:'medium'}});
 assert.equal(requests.length,3);assert.equal(host.length,3);
 assert.deepEqual(executed,['search_academic_papers','resolve_paper_full_text']);
 assert.equal(result.taskOutcome.status,'completed');
 assert.equal(result.downloadResults[0].contentType,'application/pdf');
 assert.deepEqual(Buffer.from(await filesystem.readBinary(result.downloadResults[0].path)),pdf);
 assert.equal(result.academicSources[0].paper_ref,ref);
 assert.equal(result.webSearchStatus,undefined);
 assert.ok(!JSON.stringify(host).includes(pdf.toString('base64')));
 assert.ok(host[1].desktopContinuation);assert.ok(host[2].desktopToolResults[0].result.results[0].path);
});
