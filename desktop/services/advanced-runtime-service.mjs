import crypto from 'node:crypto';
import Ajv from 'ajv';
import { validatePng } from './runtime-image.mjs';
import { readFile } from 'node:fs/promises';
import { ScratchRuntime } from './scratch-runtime.mjs';
import { OutputProvenance } from './output-provenance.mjs';
import { TASK_FOLDER, PROJECT_TASKS } from './sandbox-policy.mjs';
const TASKS = `output/${PROJECT_TASKS}`;
import contracts from '../../shared/runtime-tools.js';
const fail = code => Object.assign(new Error(code), { code });
const clone = value => JSON.parse(JSON.stringify(value));
// Calls that can change files in a project-mode turn's output/.
const EXECUTION = new Set(['exec_command', 'write_stdin', 'run_code', 'wait_code', 'apply_patch', 'image_gen_imagegen']);
const TURN_ID = /^[A-Za-z0-9._:-]{1,200}$/;
// How long one wait_for_environment call waits for the execution runtime.
const ENVIRONMENT_WAIT_MS = 25000;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)).digest('hex');
export class AdvancedRuntimeService {
  // runtime: the shared execution runtime (Python and Node), downloaded on first project use.
  constructor({ filesystem, apps, scratch, provenance, runtime = null, imagePreview, config = {}, dynamicTools = [], fetchImpl = fetch, signal }) {
    this.fs = filesystem; this.apps = apps; this.runtime = runtime; this.scratch = scratch || new ScratchRuntime({ preview: imagePreview, runtime }); this.imagePreview = imagePreview; this.config = config; this.fetch = fetchImpl; this.signal = signal;
    this.provenance = provenance || (filesystem?.root ? new OutputProvenance({ filesystem }) : null);
    this.owners = new Map(); this.pending = new Map(); this.dynamic = new Map(); this.closed = false; this.projectGrants = Promise.resolve();
    for (const tool of dynamicTools) {
      if (!/^host_[a-z0-9_]{1,55}$/.test(tool.definition?.function?.name || '') || typeof tool.execute !== 'function' || this.dynamic.has(tool.definition.function.name)) throw fail('INVALID_DYNAMIC_TOOL');
      this.dynamic.set(tool.definition.function.name, { ...tool, schemaValidator: new Ajv({ strict: false, allErrors: false }).compile(tool.definition.function.parameters) });
    }
  }
  async capabilities({ surface, permission }) {
    const enabled = surface === 'agent_command' && ['workspace_write', 'full_access'].includes(permission);
    // Project commands need only the OS sandbox; scratch, code cells and file
    // tools also need the sandbox's Node executable.
    const scratch = enabled && await this.scratch.available();
    const project = enabled && Boolean(this.fs?.root) && await (this.scratch.projectAvailable?.() ?? false);
    // The runtime can still be installed unless no archive is published for this platform.
    const runtime = this.runtime ? await this.runtime.status() : { state: 'unsupported' };
    const runtimeInstallable = ['not_installed', 'installing', 'ready'].includes(runtime.state);
    let imageConfigured = false;
    try { const url = new URL(this.config.image?.endpoint); imageConfigured = url.protocol === 'https:' && !url.username && !url.password && Boolean(this.config.image?.model && this.config.image?.apiKey); } catch {}
    return { scratch, project, ...(this.runtime ? { runtime: { state: runtime.state, ...(runtime.downloadBytes ? { downloadBytes: runtime.downloadBytes } : {}) } } : {}),
      unavailableDependencies: [...(!scratch && !project && enabled ? ['OS_SANDBOX_UNAVAILABLE'] : []), ...(!scratch && project && !runtimeInstallable ? ['CODE_RUNTIME_UNAVAILABLE'] : []), ...(this.config.unavailable ? [this.config.unavailable] : []), ...(!imageConfigured ? ['IMAGE_PROVIDER_NOT_CONFIGURED'] : []), ...(!this.config.plugins?.length ? ['PLUGIN_CATALOG_NOT_CONFIGURED'] : [])], image: Boolean(scratch && imageConfigured),
      plugins: enabled && Array.isArray(this.config.plugins) && this.config.plugins.length > 0,
      dynamicTools: enabled ? [...this.dynamic.values()].map(tool => clone(tool.definition)) : [] };
  }
  // collaborationMode 'plan': the turn may run read-only project commands and
  // nothing else that writes (see docs/codex-parity-features.md).
  // taskFolder: the Agent Work conversation's folder name in output/agent-tasks/.
  // The turn writes only there when it runs alongside another one with project
  // write access; otherwise it writes output/ and keeps that folder writable.
  async open({ owner, surface, permission, turnId, collaborationMode, taskFolder }) {
    if (this.closed || this.signal?.aborted) throw fail('OPERATION_ABORTED');
    if (typeof owner !== 'string' || !/^[a-f0-9-]{36}$/.test(owner)) throw fail('INVALID_RUNTIME_OWNER');
    if (turnId !== undefined && !TURN_ID.test(turnId)) throw fail('INVALID_TURN_ID');
    if (collaborationMode !== undefined && !['default', 'plan'].includes(collaborationMode)) throw fail('INVALID_COLLABORATION_MODE');
    if (taskFolder !== undefined && (typeof taskFolder !== 'string' || !TASK_FOLDER.test(taskFolder))) throw fail('INVALID_TASK_FOLDER');
    const readOnly = collaborationMode === 'plan';
    const identity = { surface, permission, readOnly, taskFolder: taskFolder ?? null };
    if (this.owners.has(owner)) { if (hash(this.owners.get(owner).identity) !== hash(identity)) throw fail('RUNTIME_OWNER_CONFLICT'); return this.owners.get(owner).capabilities; }
    const capabilities = await this.capabilities(identity);
    if (this.closed || this.signal?.aborted) throw fail('OPERATION_ABORTED');
    const record = { identity, capabilities, turnId, readOnly, taskFolder: taskFolder ?? null, task: null, granted: false, controller: new AbortController(), closed: false };
    this.owners.set(owner, record); return capabilities;
  }
  owner(id) { const owner = this.owners.get(id); if (!owner || owner.closed || this.closed || this.signal?.aborted) throw fail('RUNTIME_OWNER_EXPIRED'); return owner; }
  // Other open turns that can write in the project.
  writers(owner) { return [...this.owners].filter(([id, other]) => id !== owner && !other.closed && other.granted === 'project_execution' && !other.readOnly); }
  // One execution environment per turn, after the user's approval in the
  // renderer: an isolated scratch folder, or the project (read the project
  // except .biodesign/, write only output/). Neither has network access.
  // Project grants are decided one at a time, because a turn that starts while
  // another can write in the project writes only its own folder,
  // output/agent-tasks/<task>/. A turn writing output/ can never write the
  // other conversations' folders there, from its first process on.
  async grant(owner, capability = 'scratch_execution') {
    const record = this.owner(owner);
    if (capability !== 'project_execution' || record.readOnly) return this.grantLocked(owner, record, capability);
    const next = this.projectGrants.then(() => this.grantLocked(owner, this.owner(owner), capability));
    this.projectGrants = next.catch(() => {});
    return next;
  }
  async grantLocked(owner, record, capability) {
    if (!['scratch_execution', 'project_execution'].includes(capability)) throw fail('INVALID_RUNTIME_CAPABILITY');
    if (record.granted && record.granted !== capability) throw fail('EXECUTION_MODE_CONFLICT');
    const project = capability === 'project_execution';
    if (!(project ? record.capabilities.project : record.capabilities.scratch)) throw fail(project ? 'PROJECT_SANDBOX_UNAVAILABLE' : 'SANDBOX_UNAVAILABLE');
    let task = record.task;
    if (project && !record.readOnly && !record.granted && this.writers(owner).length) {
      if (!record.taskFolder) throw fail('TASK_FOLDER_REQUIRED');
      if (this.writers(owner).some(([, other]) => other.task === record.taskFolder)) throw fail('TASK_FOLDER_IN_USE');
      task = record.taskFolder;
    }
    const ownTask = project && !record.readOnly && !task ? record.taskFolder : null;
    await (project ? this.scratch.openProject(owner, { root: this.fs.root, readOnly: record.readOnly, task, ownTask }) : this.scratch.open(owner));
    if (record.closed || this.closed) { await this.scratch.closeOwner(owner); throw fail('RUNTIME_OWNER_EXPIRED'); }
    // Project mode starts only with its output/ snapshot and backup recorded; a
    // read-only (plan) session cannot change anything, so it records nothing.
    if (project && !record.readOnly) {
      const scope = task ? { scope: `${TASKS}/${task}` } : { scope: 'output', exclude: [TASKS], keep: ownTask ? [`${TASKS}/${ownTask}`] : [] };
      try { if (!this.provenance) throw fail('PROVENANCE_UNAVAILABLE'); await this.provenance.begin(owner, { turnId: record.turnId, ...scope }); }
      catch (error) { await this.scratch.closeOwner(owner); throw error.code === 'PROVENANCE_UNAVAILABLE' ? error : Object.assign(fail('PROVENANCE_UNAVAILABLE'), { cause: error }); }
    }
    record.granted = capability; record.task = task;
    if (!project) return { granted: true, capability, scope: 'turn', network: false, project_access: false };
    // The first project turn starts the one-time runtime download in the background.
    if (this.runtime && !this.runtime.current()) this.runtime.ensure().catch(() => {});
    const granted = { granted: true, capability, scope: 'turn', network: false, project_access: 'read',
      writable: record.readOnly ? [] : task ? [`${TASKS}/${task}/`] : ['output/', ...(ownTask ? [`${TASKS}/${ownTask}/`] : [])],
      ...(!record.readOnly && !task ? { not_writable: [`${TASKS}/`] } : {}), hidden: ['.biodesign/'],
      ...(record.readOnly ? { read_only: true } : {}),
      ...(task ? { parallel_task: true, note: `Other Agent Work tasks are running in this project, so this task writes only inside ${TASKS}/${task}/. The rest of the project, including the rest of output/, is read-only to it.` } : {}) };
    if (!this.runtime) return granted;
    const runtime = await this.runtime.status();
    return { ...granted, runtime: { state: runtime.state, ...(runtime.state === 'ready' ? { python: runtime.python } : {}),
      ...(['not_installed', 'installing'].includes(runtime.state) ? { note: 'python3 is being installed; call wait_for_environment before using it.' } : {}) } };
  }
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
        const tracked = this.tracks(record, call.name);
        let result;
        try { result = await this.execute(owner, record, call); }
        catch (error) { if (tracked) await this.provenance.observe(owner, call.id).catch(() => {}); throw error; }
        const changes = tracked ? await this.provenance.observe(owner, call.id) : null;
        this.owner(owner);
        if (changes && result && typeof result === 'object' && !Array.isArray(result)) result = { ...result, output_changes: changes };
        if (JSON.stringify(result).length > 70000) throw fail('RUNTIME_RESULT_TOO_LARGE');
        await this.fs.writeText(receipt, JSON.stringify({ identity, status: 'completed', result })); return result;
      } catch (e) { await this.fs.writeText(receipt, JSON.stringify({ identity, status: 'uncertain', error: e.code || 'RUNTIME_FAILED' })).catch(() => {}); throw e; }
    })();
    this.pending.set(receipt, { identity, promise });
    try { return clone(await promise); } finally { this.pending.delete(receipt); }
  }
  async execute(owner, record, call) {
    const { name, args } = call;
    // Plan mode: nothing that writes files or installs anything runs.
    if (record.readOnly && ['apply_patch', 'image_gen_imagegen', 'request_plugin_install', 'list_available_plugins_to_install'].includes(name)) throw fail('PLAN_MODE_READ_ONLY');
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
    if (name === 'wait_for_environment' && record.granted === 'project_execution' && this.runtime) return this.environment(owner, record);
    if (name === 'image_gen_imagegen') {
      if (!record.capabilities.image) throw fail('IMAGE_PROVIDER_UNAVAILABLE');
      // Reserve scratch before requesting provider work. File access uses the
      // sandboxed worker, never a privileged filesystem pointing into scratch.
      return this.scratch.withFiles(owner, async (files, scratchSignal, session) => {
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
      // Project mode writes only inside output/, or the task's folder in it.
      const file = `${session.mode === 'project' ? `${session.writable}/` : ''}generated/${crypto.randomUUID()}.png`;
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
  async reply({ owner, cell_id, results }) {
    const record = this.owner(owner), result = await this.scratch.reply(owner, cell_id, results);
    if (!this.tracks(record, 'wait_code')) return result;
    const changes = await this.provenance.observe(owner, `${cell_id}:reply`);
    return changes ? { ...result, output_changes: changes } : result;
  }
  // Project mode: the sandbox is ready at once; python3 needs the execution
  // runtime, which this call waits for (bounded) while it downloads.
  async environment(owner, record) {
    const sandbox = await this.scratch.call(owner, 'wait_for_environment', {});
    let runtime = await this.runtime.status();
    if (['not_installed', 'installing'].includes(runtime.state)) {
      let timer;
      await Promise.race([this.runtime.ensure({ signal: record.controller.signal }).catch(() => {}),
        new Promise(resolve => { timer = setTimeout(resolve, ENVIRONMENT_WAIT_MS); })]).finally(() => clearTimeout(timer));
      this.owner(owner);
      runtime = await this.runtime.status();
    }
    return { ...sandbox, runtime };
  }
  // Project-mode execution is observed after every call, including failed ones,
  // so the turn manifest covers everything the turn wrote.
  tracks(record, name) { return record.granted === 'project_execution' && !record.readOnly && EXECUTION.has(name) && Boolean(this.provenance); }
  // Restores output/ for a finished project-mode turn; see OutputProvenance.undo.
  async undo({ turnId }) {
    if (!this.provenance) throw fail('UNDO_UNAVAILABLE');
    if ([...this.owners.values()].some(record => record.turnId === turnId && !record.closed)) throw fail('TURN_ACTIVE');
    return this.provenance.undo(turnId);
  }
  async closeOwner(owner) {
    const record = this.owners.get(owner); if (!record) return;
    record.closed = true; record.controller.abort(); await this.scratch.closeOwner(owner);
    // Turn cleanup completes even if the final output/ record cannot be written.
    if (record.granted === 'project_execution' && !record.readOnly) {
      try { await this.provenance?.finish(owner); }
      catch (error) { console.warn('project_output_record_failed', { code: error?.code || 'PROVENANCE_WRITE_FAILED' }); }
    }
    this.owners.delete(owner);
  }
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
