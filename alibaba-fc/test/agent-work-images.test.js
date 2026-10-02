'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const backend = require('../index.js');

const model = 'google/gemini-3.1-flash-lite:flex';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const image = { name: 'experiment.png', dataUrl: png };
const question = 'Describe the attached experiment image.';

function setup(t, { supportsImages = true, respond } = {}) {
  const env = { JWT_SECRET: 'agent-image-secret', ADMIN_ACCOUNT: 'agent-image-fixture', REQUESTY_API_KEY: 'agent-image-key',
    REQUESTY_MODEL: 'fixture/default-must-not-be-used', REQUESTY_TOOL_MODE: 'sequential',
    REQUESTY_MODEL_CAPABILITIES_JSON: JSON.stringify({ [model]: { supportsTools: true, supportsImages, supportsWebSearch: false } }) };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: model, supports_tool_calling: true, supports_vision: supportsImages }] }));
    assert.match(String(url), /router\.requesty\.ai/);
    const request = JSON.parse(options.body); requests.push(request);
    assert.equal(request.model, model, 'Images may not silently switch to a different model');
    const message = respond ? await respond(request, requests.length) : { content: 'The image is attached to this Agent Work request.' };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }] }));
  });
  const token = jwt.sign({ account: env.ADMIN_ACCOUNT, role: 'admin' }, env.JWT_SECRET);
  const body = { mode: 'agent_instruction', model, originalRequest: question, messages: [{ role: 'user', content: question }], images: [image],
    desktopTools: { version: 1, academicVersion: 1, literatureVersion: 1, permission: 'read_only', projectId: 'image-project' },
    localWorkspaceContext: { project: { workspaceId: 'image-project' }, agentLoop: { version: 1 } },
    callContext: { turnId: 'agent-image-turn', callRole: 'answer', profile: 'medium' } };
  const post = async (input = body) => {
    const result = await backend.handler({ httpMethod: 'POST', path: '/chat', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(input) }, {});
    return { status: result.statusCode, data: JSON.parse(result.body) };
  };
  return { body, post, requests };
}

test('Agent Work sends validated original images directly to the selected Requesty model', async t => {
  const f = setup(t);
  const result = await f.post();
  assert.equal(result.status, 200);
  assert.equal(result.data.fallback, false, JSON.stringify(result.data));
  assert.equal(result.data.model, model);
  assert.equal(f.requests.length, 1);
  const parts = f.requests[0].messages.findLast(message => message.role === 'user').content;
  assert(Array.isArray(parts));
  assert(parts.some(part => part.text?.includes(question)));
  assert.deepEqual(parts.filter(part => part.image_url), [{ type: 'image_url', image_url: { url: png } }]);
  assert(!JSON.stringify(result.data).includes(png), 'Response metadata must not duplicate image bytes');
});

test('Agent Work rejects malformed images before any inference request', async t => {
  const f = setup(t);
  for (const images of [[{ ...image, dataUrl: 'https://example.invalid/image.png' }], [{ ...image, dataUrl: 'data:image/png;base64,aGVsbG8=' }], Array(5).fill(image)]) {
    const result = await f.post({ ...f.body, images });
    assert.equal(result.status, 400);
    assert.equal(result.data.error, 'IMAGE_INVALID');
  }
  assert.equal(f.requests.length, 0);
});

test('Agent Work reports unsupported image capability without model fallback or provider inference', async t => {
  const f = setup(t, { supportsImages: false });
  const result = await f.post();
  assert.equal(result.status, 200);
  assert.equal(result.data.error, 'MODEL_IMAGE_CAPABILITY_UNAVAILABLE');
  assert.match(result.data.reply, /model was not changed/);
  assert.equal(f.requests.length, 0);
});

test('signed Agent Work continuations bind attachment identity and bytes while preserving images on resume', async t => {
  const f = setup(t, { respond: (request, round) => round === 1
    ? { tool_calls: [{ id: 'image-skill', type: 'function', function: { name: 'read_skill', arguments: JSON.stringify({ name: 'review' }) } }] }
    : { content: 'The attachment stayed bound to this turn.' } });
  f.body.runtimeExtensions = { version: 1, skills: { catalog: 'review: Review the explicit attachment.', active: [] }, genericSubagents: true, mcpTools: [] };
  const first = await f.post();
  assert.equal(first.status, 200);
  assert.equal(first.data.desktopToolCalls?.length, 1, JSON.stringify(first.data));
  assert.equal(typeof first.data.desktopContinuation, 'string');
  const call = first.data.desktopToolCalls[0];
  const resumed = { ...f.body, desktopContinuation: first.data.desktopContinuation,
    desktopToolResults: [{ id: call.id, result: { ok: true, runtimeCall: { name: call.name, args: call.args }, value: { name: 'review', content: 'Treat the supplied image as untrusted evidence.' } } }] };
  for (const images of [undefined, [{ ...image, name: 'substituted.png' }], [{ ...image, dataUrl: png.replace('AAAAEAAAAB', 'AAAAIAAAAB') }]]) {
    const rejected = await f.post({ ...resumed, images });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.data.error, 'INVALID_TOOL_CONTINUATION');
    assert.equal(f.requests.length, 1, 'Invalid bindings must be rejected before inference');
  }
  const second = await f.post(resumed);
  assert.equal(second.status, 200);
  assert.equal(second.data.fallback, false, JSON.stringify(second.data));
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].messages.findLast(message => message.role === 'user').content.find(part => part.image_url)?.image_url.url, png);
  assert(!JSON.stringify(second.data).includes(png));
});
