'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const backend = require('../index.js');
const agentChat = require("./helpers/agent-chat.js");
const { withResults } = require('../../shared/agent/receipt-admission.js');
const runtime = require('../../shared/runtime-extensions.js');
const children = require('../../shared/generic-subagent.js');
const { InjectionQueue } = require('../../docs/runtime-turns.js');
const { createFixture } = require('./helpers/preflight-fixture.js');
const { ProjectContextService } = require('../../docs/project-context-service.js');

const model = 'fixture/runtime-selected';
const question = 'Inspect the selected project metadata.';
const fn = (name, parameters = { type: 'object', properties: {}, additionalProperties: false }) => ({ type: 'function', function: { name, description: 'Fixture extension', parameters } });
const extensions = extra => ({ version: 1, skills: { catalog: 'review: Use selected evidence only.', active: [] }, genericSubagents: true, mcpTools: [], ...extra });
const toolCall = (name, args = {}, id = 'call-1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const receipt = (call, value, ok = true) => ({ id: call.id, result: { ok, runtimeCall: { name: call.name, args: call.args }, ...(ok ? { value } : { error: { code: 'FIXTURE_FAILED' } }) } });

async function setup(t, { surface = 'side_chat', permission = 'read_only', runtimeExtensions = extensions(), stableSource = false, provider } = {}) {
  const env = { JWT_SECRET: 'runtime-fixture-secret', ADMIN_ACCOUNT: 'runtime-fixture', REQUESTY_API_KEY: 'runtime-fixture-key',
    REQUESTY_MODEL: model, REQUESTY_TOOL_MODE: 'sequential',
    REQUESTY_MODEL_CAPABILITIES_JSON: JSON.stringify({ [model]: { supportsTools: true, supportsWebSearch: false, supportsImages: false } }) };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const token = jwt.sign({ account: env.ADMIN_ACCOUNT, role: 'admin' }, env.JWT_SECRET);
  const fixture = await createFixture();
  fixture.workspace.set('literature/Selected.pdf', 'Selected enzyme experiment activity 42.');
  await fixture.system.registry.reconcile(await fixture.workspace.scanDirectoryTree());
  const selected = fixture.system.registry.list({ sourceKind: 'paper' })[0].sourceId;
  if (stableSource) await fixture.system.preparation.ensureSourceReady([selected], 'stable_snapshot', { surface });
  const service = new ProjectContextService({ workspace: fixture.workspace, literature: fixture.literature,
    sourceSystem: fixture.system, requestPipeline: fixture.pipeline });
  const localWorkspaceContext = await service.buildContext({ question, surface, generalPurpose: true,
    forceHardSelection: true, selectedPaperIds: [selected], turnId: 'runtime-turn', callContext: { model } });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }));
    const request = JSON.parse(options.body); requests.push(request);
    assert.equal(request.model, model);
    let message;
    try { message = await provider(request, requests.length); }
    catch (error) { t.diagnostic(error.stack || String(error)); throw error; }
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }] }));
  });
  const body = { mode: surface === 'side_chat' ? 'side_chat' : 'agent_instruction', model, originalRequest: question,
    messages: [{ role: 'user', content: question }], localWorkspaceContext, runtimeExtensions,
    ...(surface === 'side_chat' ? { conversationTranscript: { version: 1, turns: [] } } : {}),
    desktopTools: { version: 1, academicVersion: 1, literatureVersion: 1, permission, projectId: localWorkspaceContext.project.workspaceId },
    callContext: { turnId: 'runtime-turn', callRole: 'answer', profile: 'medium' } };
  const post = async (input = body, authToken = token) => {
    const response = await agentChat.handler({ httpMethod: 'POST', path: '/chat', headers: { authorization: `Bearer ${authToken}` }, body: JSON.stringify(input) }, {});
    return { status: response.statusCode, data: JSON.parse(response.body) };
  };
  return { body, post, requests, service, selected, env, token };
}

test('extension contract exposes MCP only in full-access Agent Work and never in children', () => {
  const value = runtime.normalize(extensions({ mcpTools: [fn('mcp_fixture_echo')] }));
  assert.equal(Object.hasOwn(value, 'runtimeTools'), false, 'Envelopes without runtime tools keep their original shape');
  for (const [surface, permission] of [['side_chat', 'full_access'], ['agent_command', 'read_only'], ['agent_command', 'workspace_write']]) {
    assert(!runtime.definitions(value, surface, permission, children.spawnTool).some(tool => tool.function.name.startsWith('mcp_')));
    assert.equal(runtime.isTool('mcp_fixture_echo', value, surface, permission), false);
  }
  assert(runtime.definitions(value, 'agent_command', 'full_access', children.spawnTool).some(tool => tool.function.name === 'mcp_fixture_echo'));
  assert.deepEqual(runtime.definitions({ ...value, child: {} }, 'agent_command', 'full_access', children.spawnTool), []);
  for (const malformed of [extensions({ mcpTools: [fn('read_file')] }), extensions({ mcpTools: [fn('mcp_duplicate'), fn('mcp_duplicate')] }), extensions({ skills: { active: [{ name: 'bad', content: 42 }] } })]) {
    assert.throws(() => runtime.normalize(malformed), { code: 'INVALID_RUNTIME_EXTENSIONS' });
  }
  assert.throws(() => runtime.injections([{ id: 'same', kind: 'user', content: 'a' }, { id: 'same', kind: 'user', content: 'b' }]), { code: 'INVALID_RUNTIME_EXTENSIONS' });
});

test('new runtime tools cross host-tool boundaries with validated schemas and measured context; an altered receipt ends the turn', async t => {
  const runtimeExtensions = extensions({ runtimeTools: ['clock_curr_time', 'update_plan', 'get_context_remaining'] });
  const f = await setup(t, { runtimeExtensions, provider: async request => {
    assert(request.tools.some(tool => tool.function?.name === 'get_context_remaining'));
    assert(!request.tools.some(tool => tool.function?.name === 'exec_command'));
    const tool = request.messages.findLast(message => message.role === 'tool');
    if (!tool) return { tool_calls: [toolCall('clock_curr_time', {}, 'time')] };
    assert.equal(JSON.parse(tool.content).value.current_time, '2026-10-03 12:00:00 UTC');
    return { content: 'Clock received.' };
  } });
  const rejected = await f.post();
  const altered = receipt(rejected.data.desktopToolCalls[0], {});
  altered.result.runtimeCall.args = { unexpected: true };
  const invalid = await f.post({ ...f.body, boundary: rejected.data.boundary, desktopToolResults: [altered] });
  assert.deepEqual([invalid.status, invalid.data.error], [400, 'INVALID_TOOL_CONTINUATION']);
  const first = await f.post();
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.desktopToolCalls[0].name, 'clock_curr_time');
  assert.equal(first.data.runtimeContext.estimated, true); assert(first.data.runtimeContext.estimated_input_tokens > 0);
  const second = await f.post({ ...f.body, boundary: first.data.boundary,
    desktopToolResults: [receipt(first.data.desktopToolCalls[0], { current_time: '2026-10-03 12:00:00 UTC' })] });
  assert.equal(second.status, 200, JSON.stringify(second.data)); assert.equal(second.data.agentCheckpoint.final, true);
  assert(second.data.conversationTurn.messages.some(message => message.role === 'tool' && /2026-10-03/.test(message.content)));
});

test('host boundaries accept queued input exactly once and preserve user versus delegated roles', async t => {
  const steering = 'Focus on experimental limitations; keep the selected sources.';
  const delegated = JSON.stringify({ task_id: 'child-result', reply: 'A tentative finding.', evidenceStatus: 'delegated_analysis' });
  const f = await setup(t, { provider: async (request, round) => {
    if (round === 1) return { tool_calls: [toolCall('read_skill', { name: 'review' }, 'skill')] };
    const steeringMessages = request.messages.filter(message => message.content === steering);
    assert.equal(steeringMessages.length, 1);
    assert.equal(steeringMessages[0].role, 'user');
    const childResult = request.messages.find(message => String(message.content).includes('A tentative finding.'));
    assert.equal(childResult.role, 'assistant');
    assert.match(childResult.content, /untrusted delegated analysis/);
    assert(request.messages.some(message => message.role === 'system' && message.content.includes('Original user request:\n' + question)));
    assert(!request.tools.some(tool => /^(mcp_|download_|exec$|write_file$)/.test(tool.function?.name || '')));
    if (round === 2) return { tool_calls: [toolCall('list_workspace_items', {}, 'list')] };
    return { content: 'Selected-scope analysis complete.' };
  } });
  const first = await f.post(); assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.desktopToolCalls[0].name, 'read_skill');
  const injections = [{ id: 'steer-1', kind: 'user', content: steering }, { id: 'completion:child-result', kind: 'subagent', taskId: 'child-result', content: delegated }];
  const second = await f.post({ ...f.body, boundary: first.data.boundary,
    desktopToolResults: [receipt(first.data.desktopToolCalls[0], { name: 'review', body: 'Keep evidence provenance.' })], runtimeInjections: injections });
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.deepEqual(second.data.runtimeAccepted, injections.map(item => item.id));
  assert.equal(second.data.agentCheckpoint.final, false);
  assert.equal(second.data.desktopToolCalls, undefined); // The metadata list ran in the loop; the host still receives a safe checkpoint.
  const third = await f.post({ ...f.body, boundary: second.data.boundary, desktopToolResults: [], runtimeInjections: injections });
  assert.equal(third.status, 200, JSON.stringify(third.data));
  assert.equal(third.data.agentCheckpoint.final, true);
  assert.deepEqual(third.data.runtimeAccepted, injections.map(item => item.id));
  assert.equal(third.data.conversationTurn.messages.filter(message => message.content === steering).length, 1);
  assert.equal(f.requests.length, 3);
});

test('a final checkpoint can receive a late user message without discarding its original authorization', async t => {
  const f = await setup(t, { provider: async (_request, round) => ({ content: round === 1 ? 'Initial answer.' : 'Answer incorporating late steering.' }) });
  const first = await f.post(); assert.equal(first.data.agentCheckpoint.final, true); assert(first.data.boundary);
  const next = await f.post({ ...f.body, boundary: first.data.boundary, desktopToolResults: [],
    runtimeInjections: [{ id: 'late-1', kind: 'user', content: 'Also explain the limitations.' }] });
  assert.equal(next.status, 200, JSON.stringify(next.data));
  assert.deepEqual(next.data.runtimeAccepted, ['late-1']);
  assert.equal(f.requests[1].messages.filter(message => message.role === 'user' && message.content === 'Also explain the limitations.').length, 1);
  assert.equal(f.requests.length, 2);
});

test('actual Agent Work MCP boundary and resume preserve the host receipt and unverified evidence', async t => {
  const parameters = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
  let expected;
  const f = await setup(t, { surface: 'agent_command', permission: 'full_access', runtimeExtensions: extensions({ mcpTools: [fn('mcp_fixture_echo', parameters)] }),
    provider: async (request, round) => {
      assert(request.tools.some(tool => tool.function?.name === 'mcp_fixture_echo'));
      if (round === 1) return { tool_calls: [toolCall('mcp_fixture_echo', { value: 'sample' }, 'mcp-call')] };
      const message = request.messages.findLast(message => message.role === 'tool');
      assert.deepEqual(JSON.parse(message.content), expected);
      assert.match(request.messages[0].content, /never verified scientific evidence/);
      return { content: 'External plugin returned unverified data.' };
    } });
  const first = await f.post(); assert.equal(first.status, 200, JSON.stringify(first.data));
  const pending = first.data.desktopToolCalls[0]; assert.equal(pending.name, 'mcp_fixture_echo');
  const raw = { server: 'fixture', tool: 'echo', kind: 'tool', result: { content: [{ type: 'text', text: 'sample' }], structuredContent: { value: 'sample' } },
    receipt: { id: `runtime-turn:${pending.id}`, name: pending.name, projectId: f.body.desktopTools.projectId,
      argumentHash: crypto.createHash('sha256').update(JSON.stringify(pending.args)).digest('hex'), startedAt: '2026-10-02T00:00:00Z', completedAt: '2026-10-02T00:00:01Z' },
    evidence: { kind: 'external_mcp', verified: false, projectId: f.body.desktopTools.projectId } };
  const result = receipt(pending, raw); expected = result.result;
  const resumed = await f.post({ ...f.body, boundary: first.data.boundary, desktopToolResults: [result] });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
  assert.equal(resumed.data.agentCheckpoint.final, true); assert.equal(f.requests.length, 2);
});

test('runtime receipt headers must match the pending name and arguments, including failed receipts', () => {
  const call = { id: 'signed-id', name: 'mcp_fixture_echo', args: { value: 'expected' } };
  const state = { runtimeVersion: 1, pending: [call], agentMessages: [{ role: 'tool', tool_call_id: call.id, content: 'pending' }] };
  const valid = receipt(call, { result: { content: [] }, evidence: { kind: 'external_mcp', verified: false } });
  assert.equal(JSON.parse(withResults(structuredClone(state), [valid]).agentMessages[0].content).ok, true);
  for (const change of [
    result => { delete result.result.runtimeCall; },
    result => { result.result.runtimeCall.name = 'mcp_other_tool'; },
    result => { result.result.runtimeCall.args.value = 'different'; },
    result => { result.id = 'other-id'; },
    result => { result.result.ok = 'yes'; },
    result => { result.result.ok = false; result.result.runtimeCall.name = 'spawn'; },
  ]) {
    const altered = structuredClone(valid); change(altered);
    assert.throws(() => withResults(structuredClone(state), [altered]), { code: 'INVALID_TOOL_CONTINUATION' });
  }
});

test('oversized runtime arguments fail before host handoff and leave a legal tool receipt for continuation', async t => {
  const parameters = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
  const f = await setup(t, { surface: 'agent_command', permission: 'full_access',
    runtimeExtensions: extensions({ mcpTools: [fn('mcp_fixture_large', parameters)] }), provider: async (request, round) => {
      if (round === 1) return { tool_calls: [toolCall('mcp_fixture_large', { text: 'x'.repeat(33000) }, 'too-large')] };
      const result = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
      assert.equal(result.ok, false); assert.equal(result.error.code, 'RUNTIME_CALL_TOO_LARGE');
      return { content: 'The plugin arguments were too large; a narrower operation is required.' };
    } });
  const first = await f.post(); assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.desktopToolCalls, undefined); assert.equal(first.data.agentCheckpoint.final, false);
  const second = await f.post({ ...f.body, boundary: first.data.boundary, desktopToolResults: [] });
  assert.equal(second.status, 200, JSON.stringify(second.data)); assert.equal(second.data.agentCheckpoint.final, true);
  assert.equal(f.requests.length, 2);
});

test('child request filters even malicious model calls and rejects parent capabilities in its envelope', async t => {
  let child;
  const f = await setup(t, { provider: async (request, round) => {
    assert(request.tools.every(tool => child.allowedTools.includes(tool.function.name)));
    if (round === 1) return { tool_calls: [toolCall('spawn', { task: 'Run nested task' }), toolCall('mcp_fixture_echo', {})] };
    assert(request.messages.filter(message => message.role === 'tool').every(message => JSON.parse(message.content).error === 'SUBAGENT_TOOL_DENIED'));
    return { content: 'Restricted child completed.' };
  } });
  child = { version: 1, taskId: 'child-1', parentSessionId: 'parent-session', parentRequestId: 'parent-turn',
    projectId: f.body.localWorkspaceContext.project.workspaceId, model, allowedTools: ['list_workspace_items', 'read_paper_evidence'] };
  const body = { ...f.body, runtimeExtensions: extensions({ genericSubagents: false, child }) }; delete body.conversationTranscript;
  const first = await f.post(body); assert.equal(first.status, 200, JSON.stringify(first.data));
  assert(!first.data.desktopToolCalls); assert.equal(first.data.agentCheckpoint.final, false);
  const resumed = await f.post({ ...body, boundary: first.data.boundary, desktopToolResults: [] });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data)); assert.equal(resumed.data.agentCheckpoint.final, true);
  for (const extra of [{ genericSubagents: true }, { mcpTools: [fn('mcp_fixture_echo')] }]) {
    const denied = await f.post({ ...body, runtimeExtensions: { ...body.runtimeExtensions, ...extra } });
    assert.equal(denied.status, 400); assert.equal(denied.data.error, 'INVALID_RUNTIME_EXTENSIONS');
  }
  assert.equal(f.requests.length, 2);
});

test('UI injection queue retains unsent input until acknowledgement and closes only when drained', () => {
  const queue = new InjectionQueue();
  queue.enqueue('First message', { id: 'one' }); queue.enqueue('Second message', { id: 'two' });
  assert.deepEqual(queue.batch().map(item => item.id), ['one', 'two']);
  assert.deepEqual(queue.batch().map(item => item.id), ['one', 'two']); // Transport retry does not consume.
  assert.equal(queue.finish(), false);
  queue.acknowledge(['one']); assert.deepEqual(queue.batch().map(item => item.id), ['two']);
  queue.acknowledge(['one', 'two']); assert.equal(queue.finish(), true);
  assert.throws(() => queue.enqueue('Too late', { id: 'three' }), { code: 'TURN_CLOSED' });
});

test('configured Responses adapter replays reasoning and native call output across a host-tool boundary', async t => {
 const f=await setup(t,{surface:'agent_command',permission:'workspace_write',runtimeExtensions:extensions({dynamicTools:[fn('host_project_status')]}),provider:async()=>{throw new Error('Chat adapter must not run');}});
 const previous=process.env.AGENT_PROVIDER_ADAPTERS_JSON;
 process.env.AGENT_PROVIDER_ADAPTERS_JSON=JSON.stringify({[model]:{api:'responses',endpoint:'https://fixture.example/v1/responses',model,apiKeyEnv:'REQUESTY_API_KEY',supportsTools:true,supportsImages:false}});
 t.after(()=>previous===undefined?delete process.env.AGENT_PROVIDER_ADAPTERS_JSON:process.env.AGENT_PROVIDER_ADAPTERS_JSON=previous);
 let requests=0;const reasoning={type:'reasoning',id:'rs_1',summary:[],encrypted_content:'opaque'},item={type:'function_call',id:'fc_1',call_id:'call_early',name:'host_project_status',arguments:'{}',status:'completed'};
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(String(url),'https://fixture.example/v1/responses');requests++;const body=JSON.parse(options.body);assert.equal(body.store,false);
  const output=requests===1?[reasoning,item]:[{type:'message',id:'msg_2',content:[{type:'output_text',text:'Host status received.'}]}];
  if(requests>1){assert(body.input.some(i=>i.encrypted_content==='opaque'));assert(body.input.some(i=>i.type==='function_call_output'&&JSON.parse(i.output).value.projectOpen));}
  const events=[{type:'response.created',response:{id:`resp_${requests}`}},...output.map((item,output_index)=>({type:'response.output_item.done',output_index,item})),{type:'response.completed',response:{id:`resp_${requests}`,status:'completed',output}}];
  return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 });
 const events=[];
 const result=await agentChat.handler({httpMethod:'POST',path:'/chat',headers:{authorization:`Bearer ${f.token}`},body:JSON.stringify({...f.body,stream:true})},{},{start:async()=>{},emit:async(type,data)=>events.push({type,data})});
 const first=JSON.parse(result.body);assert.equal(result.statusCode,200,JSON.stringify(first));assert.equal(first.providerCapabilities.dispatch,'completed_output_item');
 assert.deepEqual(first.desktopToolCalls.map(call=>call.name),['host_project_status']);
 const resumed=await f.post({...f.body,boundary:first.boundary,desktopToolResults:[receipt(first.desktopToolCalls[0],{projectOpen:true})]});
 assert.equal(resumed.status,200,JSON.stringify(resumed.data));assert.equal(resumed.data.agentCheckpoint.final,true);assert.equal(requests,2);
});

test('checkpoint tool revocation persists in the turn state even when later input omits it',async t=>{
 const f=await setup(t,{runtimeExtensions:extensions({runtimeTools:['clock_curr_time']}),provider:async(request,round)=>{
  if(round===1)return {tool_calls:[toolCall('clock_curr_time',{},'clock')]};
  assert(!request.tools.some(t=>t.function?.name==='clock_curr_time'));
  return round===2?{content:'Working.',end_turn:false}:{content:'Complete.'};
 }});
 const first=await f.post();
 const second=await f.post({...f.body,runtimeRevokedTools:['clock_curr_time'],boundary:first.data.boundary,desktopToolResults:[receipt(first.data.desktopToolCalls[0],{current_time:'fixture'})]});
 assert.equal(second.data.agentCheckpoint.final,false,JSON.stringify(second.data));
 const third=await f.post({...f.body,boundary:second.data.boundary,desktopToolResults:[]});assert.equal(third.data.agentCheckpoint.final,true);
});

test('child runs use the same Responses metadata and checkpoints while rejecting recursive delegation',async t=>{
 const f=await setup(t,{provider:async()=>{throw new Error('Chat adapter must not run');}});
 const previous=process.env.AGENT_PROVIDER_ADAPTERS_JSON;
 process.env.AGENT_PROVIDER_ADAPTERS_JSON=JSON.stringify({[model]:{api:'responses',endpoint:'https://fixture.example/v1/responses',model,apiKeyEnv:'REQUESTY_API_KEY',supportsTools:true}});
 t.after(()=>previous===undefined?delete process.env.AGENT_PROVIDER_ADAPTERS_JSON:process.env.AGENT_PROVIDER_ADAPTERS_JSON=previous);
 const child={version:1,taskId:'child-1',parentSessionId:'parent-session',parentRequestId:'parent-turn',projectId:f.body.localWorkspaceContext.project.workspaceId,model,allowedTools:['list_workspace_items','read_paper_evidence']};
 let requests=0;t.mock.method(globalThis,'fetch',async(_url,options)=>{
  const request=JSON.parse(options.body);requests++;assert((request.tools||[]).every(tool=>child.allowedTools.includes(tool.name)));
  if(requests===1)return new Response(JSON.stringify({id:'resp-child',status:'completed',output:[{type:'reasoning',id:'rs_child',encrypted_content:'child-opaque',summary:[]},{type:'function_call',id:'fc_child',call_id:'bad_child',name:'spawn_agent',arguments:'{"task_name":"nested","message":"Delegate"}',status:'completed'}]}));
  assert(request.input.some(item=>item.encrypted_content==='child-opaque'));
  assert.equal(JSON.parse(request.input.find(item=>item.type==='function_call_output').output).error,'SUBAGENT_TOOL_DENIED');
  return new Response(JSON.stringify({id:'resp-child-2',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Restricted child completed.'}]}]}));
 });
 const body={...f.body,runtimeExtensions:extensions({genericSubagents:false,child})};delete body.conversationTranscript;
 const first=await f.post(body);assert.equal(first.data.agentCheckpoint.final,false,JSON.stringify(first.data));assert(!first.data.desktopToolCalls);
 assert.equal(first.data.providerCapabilities.dispatch,'complete_response');
 const final=await f.post({...body,boundary:first.data.boundary,desktopToolResults:[]});assert.equal(final.data.agentCheckpoint.final,true);assert.equal(requests,2);
});
