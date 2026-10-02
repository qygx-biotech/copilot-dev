import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { GenericMcpService, createMcpFetch, validateMcpUrl } from '../services/generic-mcp-service.mjs';
import { ProjectFilesystem } from '../services/project-filesystem.mjs';

const config = extra => ({ transport: 'stdio', command: 'fixture-server', args: [], enabled: true, enabledTools: ['*'], ...extra });
const context = extra => ({ surface: 'agent_command', permission: 'full_access', isCurrent: () => true, ...extra });
const tool = (name = 'echo') => ({ name, description: 'Echo a value', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } });

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'biodesign-generic-mcp-'));
  const filesystem = await ProjectFilesystem.open(root);
  const calls = [], transports = [], clients = [];
  let invoke = options.invoke || (async args => ({ content: [{ type: 'text', text: args.arguments.value }], structuredContent: { value: args.arguments.value } }));
  const serviceOptions = {
    filesystem,
    transportFactory: (configuration, fs) => {
      const transport = { configuration, fs, closed: false, async close() { this.closed = true; } };
      transports.push(transport); return transport;
    },
    clientFactory: () => {
      const client = {
        async connect(transport) { this.transport = transport; },
        getServerCapabilities: () => options.capabilities || { tools: {} },
        async listTools() { return { tools: options.tools || [tool()] }; },
        async listResources() { return { resources: [{ uri: 'resource://workspace/readme', name: 'Readme' }] }; },
        async readResource(args) { return { contents: [{ uri: args.uri, text: 'resource' }] }; },
        async listPrompts() { return { prompts: [{ name: 'research', arguments: [{ name: 'topic', required: true }] }] }; },
        async getPrompt(args) { return { messages: [{ role: 'user', content: { type: 'text', text: args.arguments.topic } }] }; },
        async callTool(args, _schema, requestOptions) { calls.push({ args, requestOptions }); return invoke(args, requestOptions); },
        async close() { this.closed = true; this.onclose?.(); },
      };
      clients.push(client); return client;
    },
  };
  const service = new GenericMcpService(serviceOptions);
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { service, filesystem, calls, clients, transports, serviceOptions, setInvoke: value => { invoke = value; } };
}

test('explicit enable and connect are separate; namespaced schemas and private configuration survive reload', async t => {
  const { service, filesystem, transports, serviceOptions } = await fixture(t);
  await service.save({ name: 'example', config: config({ enabled: false, env: { TOKEN: 'fixture-secret' } }) });
  await assert.rejects(service.connect('example'), { code: 'MCP_DISABLED' });
  assert.deepEqual(await service.definitions(), []);
  await service.save({ name: 'example', config: config() });
  assert.equal(transports.length, 0);
  await service.connect('example');
  const definitions = await service.definitions();
  assert.equal(definitions[0].function.name, 'mcp_example_echo');
  assert.equal(definitions[0].function.parameters.required[0], 'value');
  const listed = await service.list();
  assert.equal(listed.servers[0].status, 'connected');
  assert.deepEqual(listed.servers[0].envKeys, ['TOKEN']);
  assert(!JSON.stringify(listed).includes('fixture-secret'));
  assert.equal(transports[0].configuration.env.TOKEN, 'fixture-secret');
  assert.equal(transports[0].fs, filesystem);
  await service.close();
  const restored = new GenericMcpService(serviceOptions);
  t.after(() => restored.close());
  assert.equal((await restored.list()).servers[0].config.enabled, true);
  assert.deepEqual(await restored.definitions(), []); // Opening a project never launches extensions.
  await restored.connect('example');
  assert.equal(transports[1].configuration.env.TOKEN, 'fixture-secret');
});

test('built-in service names and implicit OAuth configurations cannot be hijacked', async t => {
  const { service } = await fixture(t);
  for (const name of [undefined, null, 'paper', 'paper-mcp', 'paper_search', 'browser', 'browser-mcp', 'playwright', '../escape']) {
    await assert.rejects(service.save({ name, config: config() }), { code: 'MCP_INVALID_CONFIG' });
  }
  await assert.rejects(service.save({ name: 'remote', config: { transport: 'sse', url: 'https://mcp.example.com', auth: 'oauth' } }), { code: 'MCP_OAUTH_UNSUPPORTED' });
});

test('ambiguous names across servers cannot route a tool to a different plugin', async t => {
  const { service } = await fixture(t, { tools: [tool('echo'), tool('b_echo')] });
  await service.save({ name: 'a', config: config() }); await service.connect('a');
  await service.save({ name: 'a_b', config: config() });
  await assert.rejects(service.connect('a_b'), { code: 'MCP_INVALID_SCHEMA' });
  assert.deepEqual((await service.definitions()).map(def => def.function.name), ['mcp_a_echo', 'mcp_a_b_echo']);
});

test('scope, permission, current-project and schema checks precede any plugin execution', async t => {
  const { service, calls, filesystem } = await fixture(t);
  await service.save({ name: 'example', config: config() }); await service.connect('example');
  const request = { id: 'scope', name: 'mcp_example_echo', args: { value: 'hello' } };
  for (const denied of [{ surface: 'side_chat' }, { permission: 'workspace_write' }, { permission: 'read_only' }]) {
    await assert.rejects(service.call(request, context(denied)), { code: 'MCP_SCOPE_DENIED' });
  }
  for (const denied of [{ isCurrent: undefined }, { isCurrent: () => false }, { projectId: `${filesystem.id}-wrong` }]) {
    await assert.rejects(service.call(request, context(denied)), { code: 'MCP_PROJECT_CHANGED' });
  }
  await assert.rejects(service.call({ ...request, args: { value: 4 } }, context()), { code: 'MCP_INVALID_ARGUMENTS' });
  await assert.rejects(service.call({ ...request, name: 'read_file' }, context()), { code: 'MCP_TOOL_NOT_ALLOWED' });
  assert.equal(calls.length, 0);
  const result = await service.call(request, context({ projectId: filesystem.id }));
  assert.equal(result.result.structuredContent.value, 'hello');
  assert.equal(result.evidence.verified, false);
  assert.equal(result.receipt.projectId, filesystem.id);
});

test('receipts deduplicate in-flight and persisted calls; changed arguments fail closed', async t => {
  let release;
  const { service, calls, serviceOptions } = await fixture(t, { invoke: async args => {
    await new Promise(resolve => { release = resolve; });
    return { structuredContent: args.arguments };
  } });
  await service.save({ name: 'example', config: config() }); await service.connect('example');
  const request = { id: 'same-call', name: 'mcp_example_echo', args: { value: 'once' } };
  const first = service.call(request, context());
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const second = service.call(request, context());
  await assert.rejects(service.call({ ...request, args: { value: 'different' } }, context()), { code: 'MCP_RECEIPT_CONFLICT' });
  release();
  assert.deepEqual(await first, await second);
  assert.equal(calls.length, 1);
  assert.deepEqual(await service.call(request, context()), await first);
  assert.equal(calls.length, 1);
  await service.close();
  const restored = new GenericMcpService(serviceOptions); t.after(() => restored.close());
  assert.deepEqual(await restored.call(request, context()), await first);
  assert.equal(calls.length, 1);
  await assert.rejects(restored.call({ ...request, args: { value: 'different' } }, context()), { code: 'MCP_RECEIPT_CONFLICT' });
});

test('cancellation stops waiting and prevents unsafe retries when side-effect outcome is unknown', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { service, calls } = await fixture(t, { invoke: async (_args, options) => {
    started(options.signal);
    return new Promise(() => {}); // A plugin that ignores cancellation must not strand the UI.
  } });
  await service.save({ name: 'example', config: config() }); await service.connect('example');
  const controller = new AbortController();
  const request = { id: 'cancelled', name: 'mcp_example_echo', args: { value: 'side-effect' } };
  const result = service.call(request, context({ signal: controller.signal }));
  const pluginSignal = await ready;
  controller.abort();
  await assert.rejects(result, { code: 'OPERATION_ABORTED' });
  assert.equal(pluginSignal.aborted, true);
  await assert.rejects(service.call(request, context()), { code: 'MCP_OUTCOME_UNKNOWN' });
  assert.equal(calls.length, 1);
});

test('timeout is bounded, and reconfiguration cancels calls and removes old schemas', async t => {
  const { service, transports, calls } = await fixture(t, { invoke: async () => new Promise(() => {}) });
  await service.save({ name: 'example', config: config({ timeoutMs: 100 }) }); await service.connect('example');
  await assert.rejects(service.call({ id: 'timeout', name: 'mcp_example_echo', args: { value: 'x' } }, context()), { code: 'MCP_TIMEOUT' });
  const call = service.call({ id: 'disconnect', name: 'mcp_example_echo', args: { value: 'x' } }, context());
  while (calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  const assertion = assert.rejects(call, { code: 'OPERATION_ABORTED' });
  await service.save({ name: 'example', config: config({ enabled: false }) });
  await assertion;
  assert.equal(transports[0].closed, true);
  assert.deepEqual(await service.definitions(), []);
  await service.remove('example');
  assert.deepEqual((await service.list()).servers, []);
});

test('raw or namespaced allowlist restricts tools and excludes all resources and prompts', async t => {
  const { service } = await fixture(t, { tools: [tool('echo'), tool('hidden')], capabilities: { tools: {}, resources: {}, prompts: {} } });
  await service.save({ name: 'example', config: config({ enabledTools: ['mcp_example_echo'] }) });
  await service.connect('example');
  assert.deepEqual((await service.definitions()).map(def => def.function.name), ['mcp_example_echo']);
  await assert.rejects(service.call({ id: 'hidden', name: 'mcp_example_hidden', args: { value: 'x' } }, context()), { code: 'MCP_TOOL_NOT_ALLOWED' });
  await service.save({ name: 'example', config: config({ enabledTools: [] }) }); await service.connect('example');
  assert.deepEqual(await service.definitions(), []);
});

test('wildcard includes discovered resource and prompt wrappers with input validation', async t => {
  const { service } = await fixture(t, { capabilities: { tools: {}, resources: {}, prompts: {} } });
  await service.save({ name: 'example', config: config() }); await service.connect('example');
  const definitions = await service.definitions();
  const resource = definitions.find(def => def.function.name.startsWith('mcp_example_resource_'));
  const prompt = definitions.find(def => def.function.name.startsWith('mcp_example_prompt_'));
  const read = await service.call({ id: 'resource', name: resource.function.name, args: {} }, context());
  assert.equal(read.result.contents[0].text, 'resource');
  await assert.rejects(service.call({ id: 'prompt-missing', name: prompt.function.name, args: {} }, context()), { code: 'MCP_INVALID_ARGUMENTS' });
  const rendered = await service.call({ id: 'prompt', name: prompt.function.name, args: { topic: 'enzymes' } }, context());
  assert.equal(rendered.result.messages[0].content.text, 'enzymes');
});

test('admission fits FC capability limits without truncating schemas or hiding excess tools', async t => {
  const tools = Array.from({ length: 70 }, (_, index) => tool(`tool_${index}`));
  tools[0].description = 'long description '.repeat(600);
  const { service } = await fixture(t, { tools });
  await service.save({ name: 'many', config: config() });
  await assert.rejects(service.connect('many'), { code: 'MCP_CAPABILITY_LIMIT' });
  assert.deepEqual(await service.definitions(), []);
  assert.equal((await service.list()).servers[0].status, 'error');
  await service.save({ name: 'many', config: config({ enabledTools: tools.slice(0, 40).map(tool => tool.name) }) });
  await service.connect('many');
  assert.equal((await service.definitions()).length, 40);
  assert.equal((await service.definitions())[0].function.description.length, 8000);
  await service.save({ name: 'extra', config: config({ enabledTools: tools.slice(0, 25).map(tool => tool.name) }) });
  await assert.rejects(service.connect('extra'), { code: 'MCP_CAPABILITY_LIMIT' });
  assert.equal((await service.definitions()).length, 40, 'Existing connected extensions remain usable after an oversized addition fails');
  await service.save({ name: 'extra', config: config({ enabledTools: tools.slice(0, 24).map(tool => tool.name) }) });
  await service.connect('extra');
  assert.equal((await service.definitions()).length, 64);
});

test('oversized schemas fail connection explicitly rather than producing unusable or weakened definitions', async t => {
  const oversized = tool(); oversized.inputSchema.description = 'x'.repeat(32000);
  const { service } = await fixture(t, { tools: [oversized] });
  await service.save({ name: 'oversized', config: config() });
  await assert.rejects(service.connect('oversized'), { code: 'MCP_CAPABILITY_LIMIT' });
  assert.deepEqual(await service.definitions(), []);
});

test('plugin errors and stored outputs do not reveal configured secrets', async t => {
  const { service, setInvoke } = await fixture(t, { invoke: async () => { throw new Error('token fixture-secret was rejected'); } });
  await service.save({ name: 'example', config: config({ env: { TOKEN: 'fixture-secret' } }) }); await service.connect('example');
  await assert.rejects(service.call({ id: 'error', name: 'mcp_example_echo', args: { value: 'x' } }, context()), cause => {
    assert.equal(cause.code, 'MCP_FAILED'); assert(!cause.message.includes('fixture-secret')); return true;
  });
  setInvoke(async () => ({ content: [{ type: 'text', text: 'accidental fixture-secret output' }] }));
  const result = await service.call({ id: 'output', name: 'mcp_example_echo', args: { value: 'x' } }, context());
  assert(!JSON.stringify(result).includes('fixture-secret'));
  assert(result.result.content[0].text.includes('[redacted]'));
});

test('endpoint configuration rejects implicit local, private, credential and query-token URLs', () => {
  for (const url of ['http://localhost:8080/mcp', 'http://127.0.0.1/mcp', 'http://10.1.2.3/mcp', 'http://169.254.169.254/',
    'https://u:p@mcp.example.com/', 'https://mcp.example.com/?token=secret', 'https://mcp.example.com/#secret', 'file:///tmp/socket']) {
    assert.throws(() => validateMcpUrl(url), { code: 'MCP_UNSAFE_URL' });
  }
  assert.equal(validateMcpUrl('http://localhost:8080/mcp', { allowLocalhost: true }).port, '8080');
  assert.equal(validateMcpUrl('https://mcp.example.com:8443/mcp').port, '8443');
  assert.throws(() => validateMcpUrl('http://169.254.169.254/', { allowLocalhost: true }), { code: 'MCP_UNSAFE_URL' });
});

function fakeHttpRequest(status = 200, body = '{"ok":true}', headers = {}) {
  const calls = [];
  const request = (url, options, callback) => {
    calls.push({ url, options });
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = cause => { if (cause) queueMicrotask(() => req.emit('error', cause)); req.emit('close'); };
    req.end = () => queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = status; response.headers = headers; response.complete = true;
      callback(response); response.end(body);
    });
    return req;
  };
  return { request, calls };
}

test('HTTP transport pins public DNS, checks every requested origin, and forbids redirect forwarding', async () => {
  const fake = fakeHttpRequest();
  const fetch = createMcpFetch({ url: 'https://mcp.example.com:8443/mcp' }, { request: fake.request,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  assert.deepEqual(await (await fetch('https://mcp.example.com:8443/mcp', { method: 'POST', body: '{}' })).json(), { ok: true });
  let pinned;
  fake.calls[0].options.lookup('mcp.example.com', {}, (_error, address) => { pinned = address; });
  assert.equal(pinned, '93.184.216.34');
  await assert.rejects(fetch('https://other.example.com/mcp'), { code: 'MCP_UNSAFE_URL' });
  const poisoned = createMcpFetch({ url: 'https://mcp.example.com/mcp' }, { request: fake.request,
    lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  await assert.rejects(poisoned('https://mcp.example.com/mcp'), { code: 'MCP_UNSAFE_URL' });
  const redirected = fakeHttpRequest(302, '', { location: 'http://169.254.169.254/' });
  const redirectFetch = createMcpFetch({ url: 'https://mcp.example.com/mcp' }, { request: redirected.request,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  await assert.rejects(redirectFetch('https://mcp.example.com/mcp'), { code: 'MCP_REDIRECT_NOT_ALLOWED' });
  assert.equal(redirected.calls.length, 1);
});

test('explicit loopback exception pins loopback without trusting DNS or expanding to LAN', async () => {
  const fake = fakeHttpRequest();
  const fetch = createMcpFetch({ url: 'http://localhost:8080/mcp', allowLocalhost: true }, { request: fake.request,
    lookup: async () => { throw new Error('localhost must not query DNS'); } });
  await fetch('http://localhost:8080/messages?sessionId=opaque');
  let pinned;
  fake.calls[0].options.lookup('localhost', {}, (_error, address) => { pinned = address; });
  assert.equal(pinned, '127.0.0.1');
  await assert.rejects(fetch('http://192.168.1.1:8080/mcp'), { code: 'MCP_UNSAFE_URL' });
});

test('real MCP SDK handshake discovers paginated tools and preserves structured tool errors', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'biodesign-mcp-protocol-'));
  const filesystem = await ProjectFilesystem.open(root);
  const server = new Server({ name: 'extension-fixture', version: '1' }, { capabilities: { tools: {} } });
  const cursors = [];
  server.setRequestHandler(ListToolsRequestSchema, request => {
    cursors.push(request.params?.cursor);
    return request.params?.cursor === 'next' ? { tools: [tool('second')] } : { tools: [tool()], nextCursor: 'next' };
  });
  server.setRequestHandler(CallToolRequestSchema, request => ({ isError: true,
    content: [{ type: 'text', text: 'A domain-level rejection' }], structuredContent: { name: request.params.name, status: 'rejected' } }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const service = new GenericMcpService({ filesystem, transportFactory: () => clientTransport });
  t.after(async () => { await service.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  await service.save({ name: 'protocol', config: config() }); await service.connect('protocol');
  assert.deepEqual(cursors, [undefined, 'next']);
  assert.deepEqual((await service.definitions()).map(def => def.function.name), ['mcp_protocol_echo', 'mcp_protocol_second']);
  const request = { id: 'protocol-call', name: 'mcp_protocol_second', args: { value: 'x' } };
  const result = await service.call(request, context());
  assert.equal(result.result.isError, true);
  assert.equal(result.result.structuredContent.status, 'rejected');
  assert.deepEqual(await service.call(request, context()), result);
});
