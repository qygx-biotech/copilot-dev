'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { capture, normalizeHistory } = require('../../shared/agent/agent-step.js');
const { runSideChatAgent } = require('../../shared/agent/side-chat-agent.js');
const call = (name, id = name) => ({ id, type: 'function', function: { name, arguments: '{}' } });
const run = (requestTurn, extra = {}) => runSideChatAgent({ loopBudget: { maxSteps: 8, maxToolCalls: 24 }, conversationMessages: [{ role: 'user', content: 'Inspect metadata.' }],
  originalRequest: 'Inspect metadata.', workspaceContext: {}, systemPrompt: 'Read only.', requestTurn,
  parseFinalAnswer: content => ({ reply: content }), ...extra });

test('step captures messages, tools and authority without retaining mutable references', () => {
  const messages = [{ role: 'user', content: 'Original' }], tools = [{ type: 'function', function: { name: 'read', parameters: {} } }];
  const authority = { model: 'model', selectedSources: ['paper'] };
  const signal = new AbortController().signal;
  const step = capture({ messages, tools, signal }, authority, 1);
  messages[0].content = 'Changed'; tools[0].function.name = 'write'; authority.selectedSources.push('other');
  assert.equal(step.request.messages[0].content, 'Original');
  assert(step.allows('read')); assert(!step.allows('write'));
  assert.deepEqual(step.authority.selectedSources, ['paper']);
  assert.equal(step.request.signal, signal);
  assert.throws(() => step.request.tools.push({}), TypeError);
});

test('model history repairs unknown outcomes, removes orphan results, and preserves signatures and original journal', () => {
  const history = [{ role: 'assistant', tool_calls: [call('read', 'a'), call('read', 'b')], extra_content: { signature: 'opaque' } },
    { role: 'tool', tool_call_id: 'b', content: 'real output' }, { role: 'user', content: 'Continue' },
    { role: 'tool', tool_call_id: 'orphan', content: 'not evidence' }];
  const before = structuredClone(history), normalized = normalizeHistory(history);
  assert.deepEqual(history, before);
  assert.equal(normalized[0].extra_content.signature, 'opaque');
  assert.equal(JSON.parse(normalized[2].content).outcome, 'unknown');
  assert.equal(normalized[2].tool_call_id, 'a');
  assert(!normalized.some(m => m.tool_call_id === 'orphan'));
});

test('nonterminal text continues within the existing eight-step budget', async () => {
  let requests = 0;
  const result = await run(async request => {
    requests++;
    if (requests < 8) return { ok: true, message: { content: 'Working.', end_turn: false } };
    assert.deepEqual(request.tools, []);
    return { ok: true, message: { content: 'Bounded final answer.' } };
  });
  assert.equal(requests, 8); assert.equal(result.data.reply, 'Bounded final answer.');
});

test('a non-advertised built-in cannot execute even if a handler exists', async () => {
  let requests = 0;
  const result = await run(async request => {
    if (++requests === 1) return { ok: true, message: { tool_calls: [call('skills_list')] } };
    assert.equal(JSON.parse(request.messages.findLast(m => m.role === 'tool').content).error, 'STEP_TOOL_NOT_ADVERTISED');
    return { ok: true, message: { content: 'Unavailable.' } };
  });
  assert.equal(result.ok, true); assert.equal(result.data.reply, 'Unavailable.'); assert.equal(requests, 2);
});

test('nonterminal runtime response yields a signed-state checkpoint for pending user input', async () => {
  const result = await run(async () => ({ ok: true, message: { content: 'Working.', end_turn: false } }), {
    model: 'fixture', runtimeExtensions: { version: 1, skills: { catalog: '', active: [] }, genericSubagents: false, mcpTools: [] },
  });
  assert.equal(result.data.agentCheckpoint.final, false);
  assert.equal(result.continuationState.step, 1);
  assert.equal(result.continuationState.requestStep.model, 'fixture');
});

test('canonical runtime images become model pixels without replacing stored receipts or dropping tool pairs', () => {
  const data = Buffer.from([137,80,78,71,13,10,26,10]).toString('base64');
  const original = [{role:'assistant',tool_calls:[{id:'image',type:'function',function:{name:'view_image',arguments:'{"path":"plot.png"}'}}]},
    {role:'tool',tool_call_id:'image',content:JSON.stringify({ok:true,runtimeCall:{name:'view_image'},value:{content:[{type:'image',mimeType:'image/png',data}]}})}];
  const projected = require('../../shared/agent/agent-step.js').projectImages(require('../../shared/agent/agent-step.js').normalizeHistory(original));
  assert.equal(projected[2].content[1].image_url.url, 'data:image/png;base64,'+data);
  assert.equal(JSON.parse(original[1].content).value.content[0].data,data);
  assert.equal(projected[1].tool_call_id,'image');
  assert.equal(JSON.parse(projected[1].content).value.content[0].delivered_as_pixels,true);
});

test('advanced execution schemas respect surfaces and image capabilities at actual model dispatch', async () => {
  const runtimeExtensions = {version:1,runtimeTools:['exec_command','run_code','view_image','request_permissions'],dynamicTools:[{type:'function',function:{name:'host_status',parameters:{type:'object',properties:{}}}}]};
  for (const [surface, supportsImages] of [['side_chat',false],['agent_command',false],['agent_command',true]]) {
    await run(async request => {
      const names=request.tools.map(tool=>tool.function?.name);
      assert.equal(names.includes('exec_command'),surface==='agent_command');
      assert.equal(names.includes('host_status'),surface==='agent_command');
      assert.equal(names.includes('view_image'),surface==='agent_command'&&supportsImages);
      return {ok:true,message:{content:'Completed inspection.'}};
    }, {surface,supportsImages,runtimeExtensions,downloadPermission:'workspace_write'});
  }
});

test('nested tool cost is charged to the existing signed continuation budget', () => {
  const { withResults } = require('../../shared/agent/receipt-admission.js');
  const state={runtimeVersion:1,totalToolCalls:3,pending:[{id:'code',name:'run_code',args:{code:'fixture'}}],agentMessages:[{role:'tool',tool_call_id:'code',content:'pending'}]};
  const result={id:'code',result:{ok:true,runtimeCall:{name:'run_code',args:{code:'fixture'}},nestedToolCalls:2,value:{status:'completed'}}};
  assert.equal(withResults(structuredClone(state),[result]).totalToolCalls,5);
  assert.throws(()=>withResults({...structuredClone(state),totalToolCalls:23},[result]),{code:'INVALID_TOOL_CONTINUATION'});
});

test('image delivery retains structured attachments, attributes calls and explicitly omits limits without mutating receipts', () => {
  const { projectImages } = require('../../shared/agent/agent-step.js');
  const images = Array.from({ length: 6 }, (_, i) => ({ type: 'image', mimeType: 'image/png', data: Buffer.from(`image${i}`).toString('base64') }));
  const history = [{ role: 'user', content: [{ type: 'text', text: 'Compare' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,cHJpb3I=' } }] },
    ...images.flatMap((image, i) => [{ role: 'assistant', tool_calls: [call('view_image', `image${i}`)] }, { role: 'tool', tool_call_id: `image${i}`, content: JSON.stringify({ ok: true, value: { content: [image] } }) }])];
  const before = structuredClone(history);
  const projected = projectImages(history, { attachments: [{ dataUrl: 'data:image/png;base64,dXNlcg==' }] });
  assert.deepEqual(history, before);
  assert.deepEqual(projected[0].content.slice(0, 2), history[0].content);
  assert.equal(projected[0].content[3].image_url.url, 'data:image/png;base64,dXNlcg==');
  const receipts = projected.filter(m => m.role === 'tool').map(m => JSON.parse(m.content).value.content[0]);
  assert.deepEqual(receipts.map(r => r.delivered_as_pixels), [false, false, true, true, true, true]);
  assert.equal(receipts[0].omission_reason, 'TOOL_IMAGE_COUNT_LIMIT');
  assert.deepEqual(receipts.map(r => r.originating_call_id), images.map((_, i) => `image${i}`));
  const pixels = projected.at(-1).content;
  assert.equal(pixels.length, 8);
  for (let i = 0; i < 4; i++) { assert.match(pixels[i * 2].text, new RegExp(`image${i + 2}`)); assert(pixels[i * 2 + 1].image_url.url.endsWith(images[i + 2].data)); }
  const noVision = projectImages(history, { supportsImages: false });
  assert(noVision.filter(m => m.role === 'tool').every(m => JSON.parse(m.content).value.content[0].omission_reason === 'MODEL_IMAGE_CAPABILITY_UNAVAILABLE'));
  const invalid = projectImages([{ role: 'tool', tool_call_id: 'invalid', content: JSON.stringify({ ok: true, value: { content: [{ type: 'image', mimeType: 'image/png', data: 'a'.repeat(32004) }, { type: 'image', mimeType: 'image/gif', data: 'AAAA' }] } }) }]);
  assert.deepEqual(JSON.parse(invalid[0].content).value.content.map(i => i.omission_reason), ['IMAGE_DELIVERY_SIZE_LIMIT', 'INVALID_IMAGE_CONTENT']);
});

test('two bounded runtime receipts are admitted without losing completed process handles', () => {
  const pending = ['a', 'b'].map(id => ({ id, name: 'write_stdin', args: { process_id: `process:${id}`, chars: 'x'.repeat(20000) } }));
  const state = { runtimeVersion: 1, pending, agentMessages: pending.map(call => ({ role: 'tool', tool_call_id: call.id, content: 'pending' })) };
  const results = pending.map(call => ({ id: call.id, result: { ok: true, runtimeCall: call, value: { process_id: call.args.process_id, status: 'completed', exit_code: 0, output: 'a'.repeat(15998), output_cursor: 15998, output_remaining: 20 } } }));
  assert(JSON.stringify(results).length > 60000);
  const accepted = require('../../shared/agent/receipt-admission.js').withResults(state, results);
  assert.deepEqual(accepted.agentMessages.map(m => JSON.parse(m.content).value.status), ['completed', 'completed']);
});
