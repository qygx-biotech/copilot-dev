import crypto from 'node:crypto';
import Ajv from 'ajv';
import { validatePng } from './runtime-image.mjs';
import { readFile } from 'node:fs/promises';
import { ScratchRuntime } from './scratch-runtime.mjs';
import contracts from '../../shared/runtime-tools.js';
const fail = code => Object.assign(new Error(code), { code });
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)).digest('hex');
export class AdvancedRuntimeService {
  constructor({ filesystem, apps, scratch, imagePreview, config = {}, dynamicTools = [], fetchImpl = fetch, signal }) {
    this.fs = filesystem; this.apps = apps; this.scratch = scratch || new ScratchRuntime({ preview: imagePreview }); this.imagePreview = imagePreview; this.config = config; this.fetch = fetchImpl; this.signal = signal;
    this.owners = new Map(); this.pending = new Map(); this.dynamic = new Map(); this.closed = false;
    for (const tool of dynamicTools) {
      if (!/^host_[a-z0-9_]{1,55}$/.test(tool.definition?.function?.name || '') || typeof tool.execute !== 'function' || this.dynamic.has(tool.definition.function.name)) throw fail('INVALID_DYNAMIC_TOOL');
      this.dynamic.set(tool.definition.function.name, { ...tool, schemaValidator: new Ajv({ strict: false, allErrors: false }).compile(tool.definition.function.parameters) });
    }
  }
  async capabilities({ surface, permission }) {
    const enabled = surface === 'agent_command' && ['workspace_write', 'full_access'].includes(permission);
    const scratch = enabled && await this.scratch.available();
    let imageConfigured = false;
    try { const url = new URL(this.config.image?.endpoint); imageConfigured = url.protocol === 'https:' && !url.username && !url.password && Boolean(this.config.image?.model && this.config.image?.apiKey); } catch {}
    return { scratch, unavailableDependencies: [...(!scratch && enabled ? ['OS_SANDBOX_UNAVAILABLE'] : []), ...(this.config.unavailable ? [this.config.unavailable] : []), ...(!imageConfigured ? ['IMAGE_PROVIDER_NOT_CONFIGURED'] : []), ...(!this.config.plugins?.length ? ['PLUGIN_CATALOG_NOT_CONFIGURED'] : [])], image: Boolean(scratch && imageConfigured),
      plugins: enabled && Array.isArray(this.config.plugins) && this.config.plugins.length > 0,
      dynamicTools: enabled ? [...this.dynamic.values()].map(tool => clone(tool.definition)) : [] };
  }
  async open({ owner, surface, permission }) {
    if (this.closed || this.signal?.aborted) throw fail('OPERATION_ABORTED');
    if (typeof owner !== 'string' || !/^[a-f0-9-]{36}$/.test(owner)) throw fail('INVALID_RUNTIME_OWNER');
    const identity = { surface, permission };
    if (this.owners.has(owner)) { if (hash(this.owners.get(owner).identity) !== hash(identity)) throw fail('RUNTIME_OWNER_CONFLICT'); return this.owners.get(owner).capabilities; }
    const capabilities = await this.capabilities(identity);
    if (this.closed || this.signal?.aborted) throw fail('OPERATION_ABORTED');
    const record = { identity, capabilities, granted: false, controller: new AbortController(), closed: false };
    this.owners.set(owner, record); return capabilities;
  }
  owner(id) { const owner = this.owners.get(id); if (!owner || owner.closed || this.closed || this.signal?.aborted) throw fail('RUNTIME_OWNER_EXPIRED'); return owner; }
  async grant(owner) { const record = this.owner(owner); if (!record.capabilities.scratch) throw fail('SANDBOX_UNAVAILABLE'); await this.scratch.open(owner); if (record.closed || this.closed) { await this.scratch.closeOwner(owner); throw fail('RUNTIME_OWNER_EXPIRED'); } record.granted = true; return { granted: true, capability: 'scratch_execution', scope: 'turn', network: false, project_access: false }; }
  async call({ owner, call }) {
    const record = this.owner(owner);
    if (!call || typeof call.id !== 'string' || call.id.length > 200 || !call.id) throw fail('INVALID_RUNTIME_CALL');
    if (!this.dynamic.has(call.name)) contracts.validate(call.name, call.args);
    else { const tool = this.dynamic.get(call.name); if (!tool.schemaValidator(call.args)) throw fail('INVALID_DYNAMIC_TOOL_INPUT'); tool.validate?.(call.args); }
    // Leave room for bounded output inside the renderer's 80k receipt and the
    // FC's 180k two-receipt runtime handoff. Reject oversized inputs BEFORE effects.
    if (['exec_command', 'write_stdin', 'run_code', 'wait_code'].includes(call.name) && JSON.stringify(call).length > 32000) throw fail('RUNTIME_CALL_TOO_LARGE');
    const identity = hash({ owner, call }); const receipt = `.biodesign/runtime/tool-receipts/${hash({ owner, id: call.id })}.json`;
    if (this.pending.has(receipt)) { const old = this.pending.get(receipt); if (old.identity !== identity) throw fail('RUNTIME_RECEIPT_CONFLICT'); return clone(await old.promise); }
    const promise = (async () => {
      let saved; try { saved = JSON.parse(await this.fs.readText(receipt)); } catch (e) { if (e.code !== 'ENOENT') throw fail('RUNTIME_OUTCOME_UNKNOWN'); }
      if (saved) { if (saved.identity !== identity) throw fail('RUNTIME_RECEIPT_CONFLICT'); if (saved.status !== 'completed') throw fail('RUNTIME_OUTCOME_UNKNOWN'); return saved.result; }
      await this.fs.writeText(receipt, JSON.stringify({ identity, status: 'pending' }));
      try {
        const result = await this.execute(owner, record, call);
        this.owner(owner);
        if (JSON.stringify(result).length > 70000) throw fail('RUNTIME_RESULT_TOO_LARGE');
        await this.fs.writeText(receipt, JSON.stringify({ identity, status: 'completed', result })); return result;
      } catch (e) { await this.fs.writeText(receipt, JSON.stringify({ identity, status: 'uncertain', error: e.code || 'RUNTIME_FAILED' })).catch(() => {}); throw e; }
    })();
    this.pending.set(receipt, { identity, promise });
    try { return clone(await promise); } finally { this.pending.delete(receipt); }
  }
  async execute(owner, record, call) {
    const { name, args } = call;
    if (this.dynamic.has(name)) {
      if (!record.capabilities.dynamicTools.some(t => t.function.name === name)) throw fail('DYNAMIC_TOOL_DENIED');
      return this.dynamic.get(name).execute(args, { signal: AbortSignal.any([record.controller.signal, ...(this.signal ? [this.signal] : [])]), owner });
    }
    if (['list_available_plugins_to_install','request_plugin_install'].includes(name)) {
      if (!record.capabilities.plugins) throw fail('PLUGIN_CATALOG_UNAVAILABLE');
      const plugins = [];
      for (const entry of this.config.plugins) {
        const preview = await this.apps.preview(entry.path); plugins.push({ plugin_id: entry.id, ...preview });
      }
      if (name === 'list_available_plugins_to_install') return { plugins };
      const selected = plugins.find(p => p.plugin_id === args.plugin_id); if (!selected) throw fail('PLUGIN_NOT_AVAILABLE');
      if (record.pluginApprovals?.get(args.plugin_id) === selected.digest) {
        return this.apps.install({ path: selected.path, expectedDigest: selected.digest });
      }
      return { approval_required: true, preview: selected };
    }
    if (!record.granted) throw fail('SCRATCH_PERMISSION_REQUIRED');
    if (name === 'image_gen_imagegen') {
      if (!record.capabilities.image) throw fail('IMAGE_PROVIDER_UNAVAILABLE');
      // Reserve scratch before requesting provider work. File access uses the
      // sandboxed worker, never a privileged filesystem pointing into scratch.
      return this.scratch.withFiles(owner, async (files, scratchSignal) => {
      const config = this.config.image, url = new URL(config.endpoint);
      if (url.protocol !== 'https:' || url.username || url.password) throw fail('INVALID_IMAGE_PROVIDER');
      const response = await this.fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.any([record.controller.signal, scratchSignal, ...(this.signal ? [this.signal] : []), AbortSignal.timeout(60000)]),
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.model, prompt: args.prompt, n: 1, response_format: 'b64_json' }) });
      if (!response.ok) throw fail('IMAGE_PROVIDER_FAILED');
      const reader = response.body.getReader(); let bytes = 0; const chunks = [];
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 12 * 1024 * 1024) throw fail('IMAGE_PROVIDER_RESULT_TOO_LARGE'); chunks.push(Buffer.from(value)); } }
      finally { await reader.cancel().catch(() => {}); }
      const result = JSON.parse(Buffer.concat(chunks).toString()), encoded = result.data?.[0]?.b64_json;
      if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw fail('IMAGE_PROVIDER_INVALID_RESULT');
      const image = validatePng(Buffer.from(encoded, 'base64'));
      const preview = this.imagePreview?.(image);
      if (!image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw fail('IMAGE_PROVIDER_INVALID_RESULT');
      const file = `generated/${crypto.randomUUID()}.png`;
      await files.writeBinary(file, image);
      this.owner(owner);
      const artifact_path = `.biodesign/runtime/generated-images/${crypto.randomUUID()}.png`;
      await this.fs.writeBinary(artifact_path, image, { exclusive: true });
      return { path: file, artifact_path, bytes: image.length, provider_model: config.model, generated: true, evidence_status: 'generated_artifact', ...(preview ? { content: [preview] } : image.length <= 24000 ? { content: [{ type: 'image', mimeType: 'image/png', data: encoded }] } : { image_delivery: 'Use scratch processing to reduce to <=24000 bytes, then view_image.' }) };
      });
    }
    return this.scratch.call(owner, name, args);
  }
  async install({ owner, plugin_id, digest, call_id }) {
    const record = this.owner(owner); if (!record.capabilities.plugins) throw fail('PLUGIN_CATALOG_UNAVAILABLE');
    if (typeof call_id !== 'string' || !call_id) throw fail('INVALID_RUNTIME_CALL');
    const entry = this.config.plugins.find(p => p.id === plugin_id); if (!entry) throw fail('PLUGIN_NOT_AVAILABLE');
    const preview = await this.apps.preview(entry.path); if (preview.digest !== digest) throw fail('APP_BUNDLE_CHANGED');
    record.pluginApprovals ||= new Map(); record.pluginApprovals.set(plugin_id, digest);
    try { return await this.call({ owner, call: { id: call_id + ':install', name: 'request_plugin_install', args: { plugin_id } } }); }
    finally { record.pluginApprovals.delete(plugin_id); }
  }
  async reply({ owner, cell_id, results }) { this.owner(owner); return this.scratch.reply(owner, cell_id, results); }
  async closeOwner(owner) { const record = this.owners.get(owner); if (!record) return; record.closed = true; record.controller.abort(); await this.scratch.closeOwner(owner); this.owners.delete(owner); }
  async close() { this.closed = true; await Promise.all([...this.owners.keys()].map(owner => this.closeOwner(owner))); await this.scratch.close(); }
}
// Host configuration, never model arguments. No credentials or paths exposed to the model.
export async function loadAdvancedConfig(env = process.env) {
  if (!env.BIODESIGN_RUNTIME_PROVIDER_CONFIG) return {};
  const text = await readFile(env.BIODESIGN_RUNTIME_PROVIDER_CONFIG, 'utf8');
  if (text.length > 64000) throw fail('INVALID_RUNTIME_PROVIDER_CONFIG');
  const config = JSON.parse(text);
  return { ...(config.image ? { image: { endpoint: config.image.endpoint, model: config.image.model, apiKey: env[config.image.apiKeyEnv] } } : {}),
    plugins: Array.isArray(config.plugins) ? config.plugins.map(item => ({ id: item.id, path: item.path })) : [] };
}
