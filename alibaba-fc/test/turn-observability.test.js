'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runSideChatAgent } = require('../side-chat-agent.js');
const continuation = require('../agent-continuation.js');

const runtimeExtensions = { version: 1, skills: { catalog: '', active: [] }, genericSubagents: false, mcpTools: [] };
const run = extra => runSideChatAgent({ conversationMessages: [{ role: 'user', content: 'Inspect project metadata.' }],
  originalRequest: 'Inspect project metadata.', workspaceContext: { localWorkspaceContext: { project: { workspaceId: 'p' }, inventory: [] } },
  systemPrompt: 'Use available tools.', parseFinalAnswer: reply => ({ reply }), model: 'fixture/selected', turnId: 'usage-turn', runtimeExtensions, ...extra });

test('real model usage survives signed checkpoint resume without summing replayed stream events', async () => {
  const progress = [];
  const first = await run({ onProgress: event => progress.push(event), requestTurn: async () => ({ ok: true,
    usage: { prompt_tokens: 100, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 50 } },
    message: { tool_calls: [{ id: 'metadata', type: 'function', function: { name: 'list_workspace_items', arguments: '{}' } }] } }) });
  assert.equal(first.ok, true); assert.equal(first.data.turnUsage.totals.inputTokens, 100);
  const token = continuation.seal(first.continuationState, { turn: 'usage' }, 'test-key');
  const resume = continuation.withResults(continuation.open(token, { turn: 'usage' }, 'test-key'), []);
  const second = await run({ resume, onProgress: event => progress.push(event), requestTurn: async () => ({ ok: true,
    usage: { input_tokens: 120, output_tokens: 9, input_tokens_details: { cached_tokens: 70 } }, message: { content: 'No registered items.' } }) });
  assert.deepEqual(second.data.turnUsage.totals, { inputTokens: 220, outputTokens: 17, cachedTokens: 120, totalTokens: 237 });
  assert.equal(second.data.turnUsage.coverage.requests, 2);
  assert.deepEqual(progress.filter(event => event.stage === 'usage').map(event => event.turnUsage.sequence), [1, 2]);
  assert(progress.some(event => event.stage === 'tool-running' && event.callId === 'metadata'));
  assert(progress.some(event => event.stage === 'tool-completed' && event.callId === 'metadata'));
});

test('model-authored usage is discarded and missing provider metadata remains unknown', async () => {
  const result = await run({ parseFinalAnswer: reply => ({ reply, turnUsage: { totals: { inputTokens: 9999 } } }),
    requestTurn: async () => ({ ok: true, message: { content: 'A plain answer.' } }) });
  assert.equal(result.data.turnUsage.totals.inputTokens, null);
  assert.equal(result.data.turnUsage.coverage.requests, 1); assert.equal(result.data.turnUsage.complete, false);
});
