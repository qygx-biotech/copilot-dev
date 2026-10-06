'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const lifecycle=require('../provider-lifecycle.js');
const tickets=require('../stream-call-ticket.js');
const transcript=require('../../shared/conversation-transcript.js');
const config=lifecycle.configuration({AGENT_PROVIDER_ADAPTERS_JSON:JSON.stringify({alias:{api:'responses',endpoint:'https://provider.example/v1/responses',model:'native-model',apiKeyEnv:'KEY',supportsTools:true,reasoning:{effort:'high'}}}),KEY:'secret'},'alias');
const chat={messages:[{role:'system',content:'Canonical authorization'},{role:'user',content:'Inspect.'}],tools:[],max_tokens:100};
const item={type:'function_call',id:'fc_1',call_id:'call_1',name:'host_project_status',arguments:'{}',status:'completed'};
const frame=value=>`data: ${JSON.stringify(value)}\n\n`;
const created={type:'response.created',response:{id:'resp_1'}};
const done={type:'response.output_item.done',output_index:0,item};
const complete={type:'response.completed',response:{id:'resp_1',status:'completed',output:[item],usage:{input_tokens:12,output_tokens:4}}};
const response=events=>new Response(events.map(frame).join(''),{headers:{'content-type':'text/event-stream'}});
test('protocol capabilities are configured, never inferred from model alias',()=>{
 assert.equal(lifecycle.configuration({},'gpt-anything').dispatch,'complete_response');
 assert.equal(config.dispatch,'completed_output_item');
 assert.throws(()=>lifecycle.configuration({AGENT_PROVIDER_ADAPTERS_JSON:'{"x":{"api":"responses","endpoint":"http://bad"}}'},'x'));
});
test('completed item starts a call before response completion; JSON argument deltas never do',async()=>{
 let controller, calls=0;const stream=new ReadableStream({start(c){controller=c;}});
 const send=event=>controller.enqueue(new TextEncoder().encode(frame(event)));
 const running=lifecycle.responses(config,chat,{fetchImpl:async(url,request)=>{
  const body=JSON.parse(request.body);assert.equal(body.model,'native-model');assert.equal(body.store,false);assert.deepEqual(body.reasoning,{effort:'high'});assert(!('temperature' in body));
  return new Response(stream,{headers:{'content-type':'text/event-stream'}});
 },onCompletedCall:async(call,identity)=>{calls++;assert.equal(call.id,'call_1');assert.equal(identity.responseId,'resp_1');}});
 send(created);send({type:'response.function_call_arguments.delta',delta:'{}'});
 await new Promise(r=>setImmediate(r));assert.equal(calls,0);
 send(done);await new Promise(r=>setImmediate(r));assert.equal(calls,1);
 send(complete);controller.close();const result=await running;assert(result.ok);assert.equal(result.message.tool_calls[0].id,'call_1');
});
test('interrupted, contradictory and incomplete streams do not retry or fabricate completion',async()=>{
 for(const events of [[created,done],[created,done,{...complete,response:{...complete.response,output:[{...item,arguments:'{"changed":true}'}]}}],[created,{type:'response.incomplete'}]]){
  let fetches=0,calls=0;const result=await lifecycle.responses(config,chat,{fetchImpl:async()=>{fetches++;return response(events);},onCompletedCall:async()=>{calls++;}});
  assert.equal(result.ok,false);assert.equal(fetches,1);if(calls)assert.equal(result.terminalProviderFailure,true);
 }
});
test('opaque reasoning and explicit continuation survive transcript and subsequent Responses request',()=>{
 const reasoning={type:'reasoning',id:'rs_1',encrypted_content:'opaque-signature',summary:[]};
 const result=lifecycle.normalize({id:'resp',status:'completed',end_turn:false,output:[reasoning,{type:'message',content:[{type:'output_text',text:'Working.'}]}]},config);
 const saved=transcript.messages([result.message]);assert.equal(saved[0].end_turn,false);
 const body=lifecycle.requestBody({...chat,messages:[...chat.messages,...saved]},config);
 assert.deepEqual(body.input[2],reasoning);assert.equal(body.input[0].role,'system');
 assert.throws(()=>lifecycle.requestBody({...chat,messages:saved},{...config,model:'different'}),{code:'PROVIDER_CONTEXT_MISMATCH'});
});
test('stream tickets authenticate account, turn, model and exact call identity',()=>{
 const scope={turnId:'t',projectId:'p',model:'alias'},call={id:'call_1',name:'host_project_status',args:{}};
 const identity={step:{toolNames:['host_project_status']},authority:{surface:'agent_command',permission:'workspace_write'}};
 const envelope=tickets.seal(call,identity,scope,'account','secret');
 assert.deepEqual(tickets.verify(envelope.ticket,scope,'account','secret').call,call);
 assert.throws(()=>tickets.verify(envelope.ticket,scope,'other','secret'));
 assert.throws(()=>tickets.verify(envelope.ticket,{...scope,turnId:'other'},'account','secret'));
 assert.throws(()=>tickets.verify(envelope.ticket+'changed',scope,'account','secret'));
});
test('cancellation propagates through the provider stream and never retries',async()=>{
 const abort=new AbortController();let sends=0;
 const result=lifecycle.responses(config,chat,{signal:abort.signal,fetchImpl:async()=>{sends++;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(frame(created)));}}),{headers:{'content-type':'text/event-stream'}});}});
 await new Promise(r=>setImmediate(r));abort.abort();await assert.rejects(result,{code:'OPERATION_ABORTED'});assert.equal(sends,1);
});
