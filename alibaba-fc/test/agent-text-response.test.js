'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const jwt = require('jsonwebtoken'), backend = require('../index.js');
const model = 'fixture/freeform-agent';
function setup(t, respond) {
  const env = { JWT_SECRET: 'freeform-fixture', ADMIN_ACCOUNT: 'freeform', REQUESTY_API_KEY: 'freeform-key', REQUESTY_MODEL: model,
    REQUESTY_MODEL_CAPABILITIES_JSON: JSON.stringify({ [model]: { supportsTools: true, supportsImages: false, supportsWebSearch: false } }) };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [] }));
    const request = JSON.parse(options.body); requests.push(request);
    assert.equal(request.model, model); assert.equal(request.response_format, undefined);
    assert.doesNotMatch(request.messages[0].content, /final answer must be valid JSON|reply\/project JSON shape/);
    return respond(request);
  });
  const token = jwt.sign({ account: 'freeform', role: 'admin' }, env.JWT_SECRET);
  const send = async () => {
    const result = await backend.handler({ httpMethod: 'POST', path: '/chat', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({
      mode: 'agent_instruction', model, originalRequest: 'Reply in the requested format.', messages: [{ role: 'user', content: 'Reply in the requested format.' }],
      desktopTools: { version: 1, academicVersion: 1, literatureVersion: 1, permission: 'read_only', projectId: 'fixture' },
    }) });
    assert.equal(result.statusCode, 200); return JSON.parse(result.body);
  };
  return { requests, send };
}
for (const content of ['Hello. 你好。', '## Result\n\n**Measured** activity.\n\n- First\n- Second', '```python\nprint("hello")\n```', '{"reply":"Keep this JSON literal","project":{"summary":"not a host update"},"desktopToolCalls":["untrusted"]}', '[1, 2, 3]', 'not { valid JSON']) {
  test(`Agent Work accepts the model content without JSON parsing: ${content.slice(0, 40)}`, async t => {
    const f = setup(t, () => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] })));
    const result = await f.send();
    assert.equal(result.reply, content); assert.equal(result.project, undefined); assert.equal(result.desktopToolCalls, undefined);
    assert.equal(result.fallback, false); assert.equal(f.requests.length, 1);
  });
}
test('provider failure returns its error without a fabricated project or fallback assessment', async t => {
  const f = setup(t, () => new Response(JSON.stringify({ error: { message: 'Provider rejected this request.' } }), { status: 400 }));
  const result = await f.send();
  assert.equal(result.fallback, true); assert.equal(result.error, 'LlmHttpError'); assert.match(result.reply, /LlmHttpError/);
  assert.equal(result.project, undefined); assert.doesNotMatch(result.reply, /safe fallback|biological design review|draft memo/i);
});
for (const mode of ['plain', 'returned-error', 'thrown-error', 'legacy-error']) {
  test(`production Agent Work renderer shows ${mode} directly and preserves existing recommendation`, async () => {
    const source = fs.readFileSync(require.resolve('../../docs/app.js'), 'utf8').match(/^async function runAgentInstruction\([\s\S]*?^}/m)[0];
    const panel = { id: 'panel', instruction: 'Hello', selectedModel: model, messages: [] }, recommendation = { summary: 'Existing' };
    const records = [], noop = () => {};
    const sandbox = vm.createContext({ console, AbortController, panel, currentRecommendation: recommendation, activeAgentRequest: false,
      findAnalysisPanel: () => panel, agentWorkApi: { beginTurn: () => { panel.taskStatus = 'running'; return { requestedModel: model }; }, finishTurn: (p, turn, result) => { records.push(result); p.taskStatus = result.status || 'completed'; } },
      makeId: () => 'freeform-turn', getAgentModelOptions: () => [], setAgentBusy: noop, getSelectedPaperIds: () => [], getProjectContext: () => '',
      projectContextService: null, workspaceManager: { workspace: {} }, workspaceTree: null, workspaceAbortController: null, selectedWorkspacePaths: new Set(),
      saveAnalysisPanels: noop, renderAnalysisPanels: noop, renderBackendStatus: noop, normalizeSemanticTelemetry: noop, literatureModule: null,
      agentWorkArea: null, analysisPanelStack: { querySelectorAll: () => [] }, USE_BACKEND: true, authToken: 'fixture',
      t: x => x, buildAgentMessages: () => [], sourceCitationApi: { bindToWorkspace: () => [] }, getSideChatCitationContext: noop,
      window: mode === 'legacy-error' ? {} : { BioDesignFrontend: { beginTurn: () => ({ signal: new AbortController().signal, finish: noop }) } },
      sendWorkbenchRequest: async () => {
        if (mode.endsWith('error') && mode !== 'returned-error') throw Object.assign(new Error('Connection closed.'), { code: 'STREAM_INTERRUPTED' });
        return mode === 'returned-error' ? { fallback: true, error: 'LlmHttpError', reply: 'LlmHttpError: HTTP 400' } : { reply: '```json\n{"answer": 42}\n```' };
      },
    });
    vm.runInContext(source, sandbox); await sandbox.runAgentInstruction(panel.id);
    assert.equal(records.length, 1); assert.equal(sandbox.currentRecommendation, recommendation); assert.equal(panel.recommendation, undefined);
    assert.equal(records[0].content, mode === 'plain' ? '```json\n{"answer": 42}\n```' : mode === 'returned-error' ? 'LlmHttpError: HTTP 400' : 'STREAM_INTERRUPTED: Connection closed.');
    assert.equal(panel.taskStatus, mode === 'plain' ? 'completed' : 'failed');
  });
}
