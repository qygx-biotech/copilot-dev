import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { Readable, Transform } from 'node:stream';
import Ajv from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import sourceFetch from '../../shared/source-fetch.js';

const CONFIG_PATH = '.biodesign/runtime/mcp.json';
const RECEIPT_ROOT = '.biodesign/runtime/mcp-receipts';
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_CAPABILITIES = 200;
// These admission limits match the signed FC runtime-extension envelope.
// Discovery can inspect more capabilities so a restrictive allowlist can fit.
const MAX_ACTIVE_CAPABILITIES = 64;
const MAX_SCHEMA_CHARACTERS = 32000;
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED = /^(?:paper|papers|paper[-_]?(?:mcp|search)|browser|browser[-_]?mcp|playwright|playwright[-_]?mcp|biodesign)$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const KNOWN_ERRORS = new Set(['MCP_DISABLED', 'MCP_NOT_FOUND', 'MCP_NOT_CONNECTED', 'MCP_INVALID_CONFIG', 'MCP_INVALID_SCHEMA',
  'MCP_INVALID_ARGUMENTS', 'MCP_INVALID_CALL', 'MCP_TOOL_NOT_ALLOWED', 'MCP_SCOPE_DENIED', 'MCP_PROJECT_CHANGED',
  'MCP_RECEIPT_CONFLICT', 'MCP_OUTCOME_UNKNOWN', 'MCP_TIMEOUT', 'MCP_RESULT_TOO_LARGE', 'MCP_CAPABILITY_LIMIT',
  'MCP_AUTH_REQUIRED', 'MCP_OAUTH_UNSUPPORTED', 'MCP_UNSAFE_URL', 'MCP_REDIRECT_NOT_ALLOWED', 'OPERATION_ABORTED']);
const fail = code => Object.assign(new Error(code), { code });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const safeFailure = cause => fail(KNOWN_ERRORS.has(cause?.code) ? cause.code
  : cause?.code === 401 || cause?.code === 403 || cause?.name === 'UnauthorizedError' ? 'MCP_AUTH_REQUIRED' : 'MCP_FAILED');

function canonical(value, depth = 0) {
  if (depth > 64) throw fail('MCP_INVALID_ARGUMENTS');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
  }
  throw fail('MCP_INVALID_ARGUMENTS');
}

function secretMap(value, kind) {
  if (value === undefined) return {};
  if (!object(value) || Object.keys(value).length > 64) throw fail('MCP_INVALID_CONFIG');
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!(kind === 'env' ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[A-Za-z0-9-]+$/).test(key)
      || typeof entry !== 'string' || entry.length > 16384 || /[\0\r\n]/.test(entry)) throw fail('MCP_INVALID_CONFIG');
    if (kind === 'headers' && /^(host|connection|content-length|transfer-encoding|cookie|mcp-session-id)$/i.test(key)) throw fail('MCP_INVALID_CONFIG');
    Object.defineProperty(result, key, { value: entry, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

/** Explicitly configured public endpoints may use nonstandard ports. Loopback needs separate opt-in. */
export function validateMcpUrl(value, { allowLocalhost = false, allowQuery = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw fail('MCP_UNSAFE_URL'); }
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)
    || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || (!allowQuery && url.search)) throw fail('MCP_UNSAFE_URL');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allowLocalhost && LOOPBACK.has(host)) return url;
  const withoutPort = new URL(url);
  withoutPort.port = '';
  try { sourceFetch.validateSourceUrl(withoutPort.href); } catch { throw fail('MCP_UNSAFE_URL'); }
  return url;
}

export function normalizeMcpConfig(name, input, previous = {}) {
  if (typeof name !== 'string' || !NAME.test(name) || RESERVED.test(name) || !object(input)) throw fail('MCP_INVALID_CONFIG');
  if (input.auth || input.oauth || input.authProvider) throw fail('MCP_OAUTH_UNSUPPORTED');
  const transport = input.transport || (input.command ? 'stdio' : 'streamableHttp');
  if (!['stdio', 'sse', 'streamableHttp'].includes(transport)) throw fail('MCP_INVALID_CONFIG');
  const enabledTools = input.enabledTools ?? [];
  if (!Array.isArray(enabledTools) || enabledTools.length > MAX_CAPABILITIES
    || enabledTools.some(value => typeof value !== 'string' || !value.length || value.length > 256)
    || (enabledTools.includes('*') && enabledTools.length !== 1)) throw fail('MCP_INVALID_CONFIG');
  const timeoutMs = input.timeoutMs ?? 45000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw fail('MCP_INVALID_CONFIG');
  const config = { transport, enabled: input.enabled === true, enabledTools: [...new Set(enabledTools)], timeoutMs,
    env: secretMap(input.env === undefined ? previous.env : input.env, 'env'),
    headers: secretMap(input.headers === undefined ? previous.headers : input.headers, 'headers'),
    allowLocalhost: input.allowLocalhost === true };
  if (transport === 'stdio') {
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 4096 || /[\0\r\n]/.test(input.command)
      || !Array.isArray(input.args ?? []) || (input.args || []).length > 128
      || (input.args || []).some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) throw fail('MCP_INVALID_CONFIG');
    config.command = input.command;
    config.args = [...(input.args || [])];
  } else config.url = validateMcpUrl(input.url, config).href;
  return config;
}
const normalizeConfig = normalizeMcpConfig;

function redact(value, config) {
  const secrets = [...Object.values(config.env || {}), ...Object.values(config.headers || {}),
    ...Object.entries(config.headers || {}).filter(([key]) => /^authorization$/i.test(key)).map(([, entry]) => entry.replace(/^(?:Bearer|Basic)\s+/i, ''))]
    .filter(secret => secret.length >= 4).sort((a, b) => b.length - a.length);
  const visit = item => {
    if (typeof item === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), item);
    if (Array.isArray(item)) return item.map(visit);
    if (object(item)) return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
    return item;
  };
  return visit(value);
}

/** SDK-compatible fetch with validated, pinned DNS and no cross-origin redirects or credential forwarding. */
export function createMcpFetch(config, { lookup = dns.lookup, request = (url, options, callback) =>
  (url.protocol === 'https:' ? https : http).request(url, options, callback) } = {}) {
  const origin = validateMcpUrl(config.url, config).origin;
  return async (input, init = {}) => {
    const url = validateMcpUrl(String(input), { ...config, allowQuery: true });
    if (url.origin !== origin) throw fail('MCP_UNSAFE_URL');
    if (init.signal?.aborted) throw fail('OPERATION_ABORTED');
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    let address;
    const resolving = async () => {
      if (config.allowLocalhost && LOOPBACK.has(host)) {
        // Do not trust host-file overrides for the localhost exception.
        return { address: host === '::1' ? '::1' : '127.0.0.1', family: host === '::1' ? 6 : 4 };
      }
      try { return await sourceFetch.resolvePublicTarget(url, lookup); } catch { throw fail('MCP_UNSAFE_URL'); }
    };
    address = await bounded(resolving, { signal: init.signal, timeoutMs: 10000 });
    const method = String(init.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'DELETE', 'HEAD'].includes(method)) throw fail('MCP_INVALID_CALL');
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    headers['accept-encoding'] = 'identity';
    return new Promise((resolve, reject) => {
      let timer;
      const req = request(url, { method, headers, agent: false, signal: init.signal,
        lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
      }, response => {
        clearTimeout(timer);
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.destroy(); reject(fail('MCP_REDIRECT_NOT_ALLOWED')); return;
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.destroy(); reject(fail('MCP_FAILED')); return;
        }
        const resultHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined) resultHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        if ([204, 205, 304].includes(response.statusCode) || method === 'HEAD') {
          response.resume(); resolve(new Response(null, { status: response.statusCode, headers: resultHeaders })); return;
        }
        let bytes = 0;
        const limit = new Transform({ transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > MAX_RESULT_BYTES ? fail('MCP_RESULT_TOO_LARGE') : null, bytes <= MAX_RESULT_BYTES ? chunk : undefined);
        } });
        response.once('error', cause => limit.destroy(cause));
        limit.once('error', () => response.destroy());
        limit.once('close', () => { if (!response.complete) response.destroy(); });
        response.pipe(limit);
        resolve(new Response(Readable.toWeb(limit), { status: response.statusCode, headers: resultHeaders }));
      });
      timer = setTimeout(() => req.destroy(fail('MCP_TIMEOUT')), 15000);
      req.once('error', cause => { clearTimeout(timer); reject(safeFailure(cause)); });
      req.once('close', () => clearTimeout(timer));
      if (init.body !== undefined && init.body !== null) {
        if (typeof init.body !== 'string' && !Buffer.isBuffer(init.body) && !(init.body instanceof Uint8Array)) {
          req.destroy(); reject(fail('MCP_INVALID_CALL')); return;
        }
        req.write(init.body);
      }
      req.end();
    });
  };
}

async function bounded(operation, { signal, timeoutMs = 45000 } = {}) {
  if (signal?.aborted) throw fail('OPERATION_ABORTED');
  const controller = new AbortController();
  let timer;
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => { controller.abort(); reject(fail('OPERATION_ABORTED')); };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(fail('MCP_TIMEOUT')); }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), stopped]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

function defaultTransport(config, filesystem) {
  if (config.transport === 'stdio') {
    // The SDK invokes an executable with an argument vector and shell:false.
    const transport = new StdioClientTransport({ command: config.command, args: config.args, env: config.env,
      cwd: filesystem.root, stderr: 'pipe' });
    transport.stderr?.resume();
    return transport;
  }
  const fetch = createMcpFetch(config);
  const options = { fetch, requestInit: { headers: config.headers }, eventSourceInit: { fetch } };
  return config.transport === 'sse' ? new SSEClientTransport(new URL(config.url), options)
    : new StreamableHTTPClientTransport(new URL(config.url), options);
}

function wrappedName(server, kind, name) {
  const prefix = `mcp_${server}_${kind === 'tool' ? '' : `${kind}_`}`;
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const raw = `${prefix}${safe}`;
  return raw.length <= 64 && safe === name ? raw : `${raw.slice(0, 51)}_${digest(`${kind}:${name}`).slice(0, 12)}`;
}

export class GenericMcpService {
  constructor({ filesystem, clientFactory = () => new Client({ name: 'biodesign-runtime-extensions', version: '1.0.0' }, { capabilities: {} }),
    transportFactory = defaultTransport } = {}) {
    if (!filesystem?.readText || !filesystem?.writeText) throw fail('MCP_INVALID_CONFIG');
    this.filesystem = filesystem;
    this.clientFactory = clientFactory;
    this.transportFactory = transportFactory;
    this.configs = new Map();
    this.connections = new Map();
    this.receipts = new Map();
    this.configQueue = Promise.resolve();
    this.loaded = null;
    this.closed = false;
  }

  async load() {
    if (this.closed) throw fail('OPERATION_ABORTED');
    if (!this.loaded) this.loaded = (async () => {
      let stored;
      try { stored = JSON.parse(await this.filesystem.readText(CONFIG_PATH)); }
      catch (cause) { if (cause.code === 'ENOENT') return; throw fail('MCP_INVALID_CONFIG'); }
      if (stored?.version !== 1 || !Array.isArray(stored.servers) || stored.servers.length > 32) throw fail('MCP_INVALID_CONFIG');
      for (const { name, config } of stored.servers) {
        if (this.configs.has(name)) throw fail('MCP_INVALID_CONFIG');
        this.configs.set(name, normalizeConfig(name, config));
      }
    })();
    return this.loaded;
  }

  async list() {
    await this.load();
    return { servers: [...this.configs].map(([name, config]) => {
      const { env, headers, ...publicConfig } = config;
      const connection = this.connections.get(name);
      return redact({ name, config: publicConfig, envKeys: Object.keys(env), headerKeys: Object.keys(headers),
        status: connection?.status || 'disconnected', error: connection?.error || null,
        tools: [...(connection?.tools?.values() || [])].map(tool => ({ name: tool.definition.function.name, rawName: tool.rawName,
          description: tool.definition.function.description, inputSchema: tool.definition.function.parameters, kind: tool.kind })),
      }, config);
    }) };
  }

  mutate(operation) {
    const pending = this.configQueue.then(async () => { await this.load(); return operation(); });
    this.configQueue = pending.catch(() => {});
    return pending;
  }

  async persist() {
    await this.filesystem.writeText(CONFIG_PATH, JSON.stringify({ version: 1, servers: [...this.configs].map(([name, config]) => ({ name, config })) }, null, 2));
  }

  save({ name, config, exclusive = false } = {}) {
    return this.mutate(async () => {
      if (exclusive && this.configs.has(name)) throw fail('MCP_CONFIG_EXISTS');
      if (!this.configs.has(name) && this.configs.size >= 32) throw fail('MCP_INVALID_CONFIG');
      const normalized = normalizeConfig(name, config, this.configs.get(name));
      await this.disconnect(name);
      this.configs.set(name, normalized);
      await this.persist();
      return this.list();
    });
  }

  remove(name) {
    return this.mutate(async () => {
      if (!this.configs.has(name)) throw fail('MCP_NOT_FOUND');
      await this.disconnect(name);
      this.configs.delete(name);
      await this.persist();
      return this.list();
    });
  }

  async connect(name) {
    await this.load();
    const config = this.configs.get(name);
    if (!config) throw fail('MCP_NOT_FOUND');
    if (!config.enabled) throw fail('MCP_DISABLED');
    const existing = this.connections.get(name);
    if (existing?.status === 'connected') return this.list();
    if (existing?.starting) { await existing.starting; return this.list(); }
    const state = { status: 'connecting', tools: new Map(), controller: new AbortController(), queue: Promise.resolve() };
    this.connections.set(name, state);
    state.starting = (async () => {
      try {
        const client = this.clientFactory(config, name);
        const transport = this.transportFactory(config, this.filesystem, name);
        state.client = client;
        state.transport = transport;
        client.onclose = () => {
          if (this.connections.get(name) === state) { state.status = 'disconnected'; state.tools.clear(); state.controller.abort(); }
        };
        await bounded(async signal => {
          await client.connect(transport, { timeout: config.timeoutMs, signal });
          await this.discover(name, config, state, signal);
        }, { signal: state.controller.signal, timeoutMs: config.timeoutMs });
        if (this.closed || this.connections.get(name) !== state || this.configs.get(name) !== config || state.controller.signal.aborted) throw fail('OPERATION_ABORTED');
        state.status = 'connected';
      } catch (cause) {
        state.controller.abort();
        await Promise.allSettled([state.client?.close(), state.transport?.close()]);
        state.status = 'error'; state.error = safeFailure(cause).code; state.tools.clear();
        throw safeFailure(cause);
      } finally { state.starting = null; }
    })();
    await state.starting;
    return this.list();
  }

  async discover(name, config, state, signal) {
    const client = state.client;
    const capabilities = client.getServerCapabilities?.();
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const all = config.enabledTools.length === 1 && config.enabledTools[0] === '*';
    // Host-only adapter: no additional model names, connection-time requests,
    // or implicit resource access for restrictive tool allowlists.
    if (all && capabilities?.resources && typeof client.listResourceTemplates === 'function') {
      state.resourceTemplateTool = { kind: 'resource_templates', rawName: 'resources/templates/list',
        validate: ajv.compile({ type: 'object', properties: { cursor: { type: 'string', minLength: 1, maxLength: 4096 } }, additionalProperties: false }),
        invoke: (args, options) => client.listResourceTemplates(args, options) };
    }
    const listAll = async (method, key) => {
      const items = [], cursors = new Set();
      let cursor;
      do {
        const page = await client[method](cursor ? { cursor } : {}, { timeout: config.timeoutMs, signal });
        items.push(...(page[key] || []));
        if (items.length > MAX_CAPABILITIES || (page.nextCursor && cursors.has(page.nextCursor))) throw fail('MCP_CAPABILITY_LIMIT');
        cursor = page.nextCursor;
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return items;
    };
    const register = (kind, rawName, description, schema, invoke) => {
      let toolName = wrappedName(name, kind, rawName);
      if (state.tools.has(toolName)) toolName = `${toolName.slice(0, 51)}_${digest(`${kind}:${rawName}`).slice(0, 12)}`;
      if (state.tools.has(toolName)) throw fail('MCP_INVALID_SCHEMA');
      // Separators in names can otherwise alias another server's namespace.
      if ([...this.connections].some(([other, connection]) => other !== name && connection.tools.has(toolName))) throw fail('MCP_INVALID_SCHEMA');
      if ([...this.connections.values()].reduce((count, connection) => count + connection.tools.size, 0) >= MAX_ACTIVE_CAPABILITIES
        || JSON.stringify(schema).length > MAX_SCHEMA_CHARACTERS) throw fail('MCP_CAPABILITY_LIMIT');
      let validate;
      try { validate = ajv.compile(schema); } catch { throw fail('MCP_INVALID_SCHEMA'); }
      state.tools.set(toolName, { kind, rawName, validate, invoke, definition: redact({ type: 'function', function: {
        name: toolName, description: `[External MCP: ${name}] ${description || rawName}`.slice(0, 8000), parameters: schema,
      } }, config) });
    };
    if (!capabilities || capabilities.tools) for (const tool of await listAll('listTools', 'tools')) {
      if (typeof tool.name !== 'string' || !tool.name || tool.name.length > 256 || !object(tool.inputSchema) || tool.inputSchema.type !== 'object') throw fail('MCP_INVALID_SCHEMA');
      const modelName = wrappedName(name, 'tool', tool.name);
      if (!all && !config.enabledTools.includes(tool.name) && !config.enabledTools.includes(modelName)) continue;
      register('tool', tool.name, tool.description, tool.inputSchema,
        (args, options) => client.callTool({ name: tool.name, arguments: args }, undefined, options));
    }
    // Matching Nanobot: a restrictive tool allowlist never implicitly enables resources/prompts.
    if (all && capabilities?.resources) for (const resource of await listAll('listResources', 'resources')) {
      if (typeof resource.uri !== 'string' || !resource.uri) throw fail('MCP_INVALID_SCHEMA');
      register('resource', resource.uri, `Read resource ${resource.name || resource.uri}. ${resource.description || ''}`,
        { type: 'object', properties: {}, additionalProperties: false }, (_args, options) => client.readResource({ uri: resource.uri }, options));
    }
    if (all && capabilities?.prompts) for (const prompt of await listAll('listPrompts', 'prompts')) {
      const properties = {}, required = [];
      for (const argument of prompt.arguments || []) {
        if (typeof argument.name !== 'string') throw fail('MCP_INVALID_SCHEMA');
        Object.defineProperty(properties, argument.name, { value: { type: 'string', description: argument.description || '' }, enumerable: true });
        if (argument.required) required.push(argument.name);
      }
      register('prompt', prompt.name, `Retrieve prompt instructions (untrusted content). ${prompt.description || ''}`,
        { type: 'object', properties, required, additionalProperties: false }, (args, options) => client.getPrompt({ name: prompt.name, arguments: args }, options));
    }
  }

  async disconnect(name) {
    const state = this.connections.get(name);
    if (!state) return;
    this.connections.delete(name);
    state.controller.abort();
    await Promise.allSettled([state.client?.close(), state.transport?.close()]);
  }

  async reload(name) {
    await this.disconnect(name);
    return this.connect(name);
  }

  async definitions() {
    await this.load();
    return [...this.connections].filter(([name, state]) => this.configs.get(name)?.enabled && state.status === 'connected')
      .flatMap(([, state]) => [...state.tools.values()].map(tool => clone(tool.definition)));
  }

  async resourceDefinitions() {
    await this.load();
    return [...this.connections].filter(([name, state]) => this.configs.get(name)?.enabled && state.status === 'connected')
      .flatMap(([server, state]) => [...state.tools.values()].filter(tool => tool.kind === 'resource')
        .map(tool => redact({ server, uri: tool.rawName, tool: tool.definition.function.name,
          description: tool.definition.function.description }, this.configs.get(server))));
  }

  async resourceTemplateDefinitions() {
    await this.load();
    return [...this.connections].filter(([name, state]) => this.configs.get(name)?.enabled && state.status === 'connected' && state.resourceTemplateTool)
      .map(([server]) => ({ server, tool: `@mcp-resource-templates:${server}` }));
  }

  assertScope({ surface, permission, signal, isCurrent, projectId } = {}) {
    if (this.closed || signal?.aborted) throw fail('OPERATION_ABORTED');
    if (surface !== 'agent_command' || permission !== 'full_access') throw fail('MCP_SCOPE_DENIED');
    // The caller must capture the active project. A missing guard is not authority.
    if (typeof isCurrent !== 'function' || !isCurrent() || (projectId !== undefined && projectId !== this.filesystem.id)) throw fail('MCP_PROJECT_CHANGED');
  }

  async call({ id, name, args = {} } = {}, context = {}) {
    this.assertScope(context);
    await this.load();
    if (typeof id !== 'string' || !id || id.length > 256 || typeof name !== 'string' || !object(args)) throw fail('MCP_INVALID_CALL');
    const argumentHash = digest(canonical(args));
    const identity = canonical({ name, argumentHash });
    const pending = this.receipts.get(id);
    if (pending) {
      if (pending.identity !== identity) throw fail('MCP_RECEIPT_CONFLICT');
      const result = await pending.promise;
      this.assertScope(context);
      return clone(result);
    }
    const receiptPath = `${RECEIPT_ROOT}/${digest(id)}.json`;
    const execution = (async () => {
      this.assertScope(context);
      let saved;
      try { saved = JSON.parse(await this.filesystem.readText(receiptPath)); }
      catch (cause) { if (cause.code !== 'ENOENT') throw fail('MCP_OUTCOME_UNKNOWN'); }
      if (saved) {
        if (saved.identity !== identity) throw fail('MCP_RECEIPT_CONFLICT');
        this.assertScope(context);
        if (saved.status === 'completed') return saved.result;
        throw fail('MCP_OUTCOME_UNKNOWN');
      }
      const entry = [...this.connections].find(([server, state]) => this.configs.get(server)?.enabled && state.status === 'connected' &&
        (state.tools.has(name) || (state.resourceTemplateTool && name === `@mcp-resource-templates:${server}`)));
      if (!entry) throw fail('MCP_TOOL_NOT_ALLOWED');
      const [server, state] = entry;
      const config = this.configs.get(server);
      const tool = state.tools.get(name) || state.resourceTemplateTool;
      if (!tool.validate(args)) throw fail('MCP_INVALID_ARGUMENTS');
      const run = async () => {
        this.assertScope(context);
        if (state.controller.signal.aborted || this.connections.get(server) !== state || this.configs.get(server) !== config) throw fail('MCP_NOT_CONNECTED');
        const receipt = { id, name, server, projectId: this.filesystem.id, argumentHash, startedAt: new Date().toISOString() };
        // Journal before executing. Interrupted or uncertain side effects are never automatically replayed.
        await this.filesystem.writeText(receiptPath, JSON.stringify({ version: 1, identity, status: 'pending', receipt }));
        try {
          this.assertScope(context);
          const signal = context.signal ? AbortSignal.any([context.signal, state.controller.signal]) : state.controller.signal;
          const value = await bounded(innerSignal => tool.invoke(args, { signal: innerSignal, timeout: config.timeoutMs }), { signal, timeoutMs: config.timeoutMs });
          this.assertScope(context);
          const encoded = JSON.stringify(value);
          if (encoded === undefined || Buffer.byteLength(encoded) > MAX_RESULT_BYTES) throw fail('MCP_RESULT_TOO_LARGE');
          const result = redact({ server, tool: tool.rawName, kind: tool.kind, result: JSON.parse(encoded),
            receipt: { ...receipt, completedAt: new Date().toISOString() },
            evidence: { kind: 'external_mcp', verified: false, projectId: this.filesystem.id },
          }, config);
          await this.filesystem.writeText(receiptPath, JSON.stringify({ version: 1, identity, status: 'completed', result }));
          this.assertScope(context);
          return result;
        } catch (cause) {
          await this.filesystem.writeText(receiptPath, JSON.stringify({ version: 1, identity, status: 'uncertain', receipt, error: safeFailure(cause).code })).catch(() => {});
          throw safeFailure(cause);
        }
      };
      const promise = state.queue.then(run, run);
      state.queue = promise.catch(() => {});
      return promise;
    })();
    this.receipts.set(id, { identity, promise: execution });
    try { return clone(await execution); }
    finally { this.receipts.delete(id); }
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.connections.keys()].map(name => this.disconnect(name)));
  }
}
