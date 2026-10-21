import crypto from 'node:crypto';
import contract from '../../shared/literature-agent.js';
import academic from '../../shared/academic-tools.js';
import { assertOnlyKeys, assertRelativePath } from '../ipc/validation.mjs';
import { acquirePaperPdf } from './paper-acquisition.mjs';
import { downloadSources } from './source-downloader.mjs';
import { verifyPaper, verifyParsed, parsePdfBounded } from './paper-verification.mjs';
import { redactBrowserText } from './playwright-mcp-client.mjs';
import { normalizeSnapshotReference, referenceSchema, restrictBrowserTool, skippedReference } from './browser-references.mjs';
import { politeWait, requestedIsPreprint } from './open-access-sources.mjs';

const fail = code => Object.assign(new Error(code), { code });
const code = error => /^[A-Z_]{1,80}$/.test(error?.code || '') ? error.code : 'LITERATURE_OPERATION_FAILED';
const jobPath = id => `.biodesign/literature-jobs/${id}.json`;
const receiptPath = id => `.biodesign/literature-jobs/receipts/${id}.json`;
const uncertainPath = id => `.biodesign/literature-jobs/receipts/${id}.uncertain.json`;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const storedResult = result => JSON.parse(JSON.stringify(result?.final && Object.hasOwn(result.final, 'discoveryArguments') ? result : clean(result)));
const field = contract.text;
const schema = contract.object;
const indexSchema = { type: 'integer', minimum: 0, maximum: contract.MAX_PAPERS - 1 };
const hostOf = value => { try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; } };
// Host steps the retrieval driver issues itself; never advertised to a model.
const DRIVER_STEPS = new Set(['request_access', 'start_browsing']);
const MAX_ATTENTION_ROUNDS = 3, BROWSER_TARGETS_PER_PAPER = 4, BROWSER_CAPTURES_PER_JOB = 60;
const authorized = input => ['workspace_write', 'full_access'].includes(input.permission) && input.authorization?.download === true;
const openAccessPaper = paper => paper.access?.some(item => item.is_open_access === true) || paper.locations?.some(item => {
  try { return ['arxiv.org', 'biorxiv.org', 'medrxiv.org', 'pmc.ncbi.nlm.nih.gov', 'europepmc.org', 'doaj.org', 'zenodo.org', 'hal.science', 'eprint.iacr.org'].some(host => new URL(item.url).hostname === host || new URL(item.url).hostname.endsWith('.' + host)); } catch { return false; }
});
function clean(value) {
  if (typeof value === 'string') return value.replace(/https?:\/\/[^\s<>"']+/g, url => contract.safeUrl(url) || '[redacted URL]');
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/cookie|authorization|password|token|header/i.test(key)).map(([key, item]) => [key, clean(item)]));
  return value;
}
const normalizeTitle = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export class LiteratureWorkflows {
  constructor(active, browser, isCurrent, dependencies = {}) {
    this.active = active; this.browser = browser; this.isCurrent = isCurrent; this.dependencies = dependencies;
    this.jobs = new Map(); this.controllers = new Map(); this.attentionControllers = new Map(); this.localIndex = new Map(); this.queue = Promise.resolve();
    this.onOwnershipLost = ({ ownerId, error }) => {
      const job = this.jobs.get(ownerId);
      if (!job || ['completed', 'cancelled', 'failed', 'partial'].includes(job.status)) return;
      this.block(job, error);
      void this.save(job).catch(error => console.error('literature.checkpoint.failure', { jobId: job.id, code: code(error) }));
    };
    browser.on?.('ownership-lost', this.onOwnershipLost);
    active.sourceDownloads.signal.addEventListener('abort', () => {
      const owner = browser.owner;
      if (owner && this.jobs.has(owner)) void this.cancel(owner).catch(error => console.error('literature.cancel.failure', { jobId: owner, code: code(error) }));
    }, { once: true });
  }
  // The library browser outlives a project; detach this project's listeners.
  dispose() { this.browser.off?.('ownership-lost', this.onOwnershipLost); for (const controller of this.attentionControllers.values()) controller.abort(); }
  diagnose(job, error, stage = 'literature-host') {
    const diagnostics = { code: code(error), message: redactBrowserText(error?.message || code(error)).slice(0, 1000),
      failureStage: stage, jobId: job.id, ownerId: error?.ownerId || this.browser.owner || null,
      ...(error?.cause ? { causeCode: code(error.cause), causeMessage: redactBrowserText(error.cause.message).slice(0, 1000) } : {}) };
    job.lastError = diagnostics; console.error('literature.host.failure', diagnostics); return diagnostics;
  }
  block(job, error) {
    job.status = 'blocked'; this.diagnose(job, error, 'literature-browser');
    this.browser.release(job.id);
    return this.blockedResult(job);
  }
  blockedResult(job) {
    return { blocked: true, job_id: job.id, error: job.lastError?.code || 'BROWSER_UNAVAILABLE',
      message: job.lastError?.message || 'Resume the saved job to reacquire its browser.', diagnostics: job.lastError };
  }
  async suspend(input) {
    const job = await this.load(input.job_id);
    if (job.model !== input.model || job.permission !== input.permission || JSON.stringify(job.scopePaths) !== JSON.stringify(input.scopePaths ?? null)) throw fail('JOB_BINDING_CHANGED');
    if (!['completed', 'partial', 'cancelled', 'blocked'].includes(job.status)) job.status = 'failed';
    this.controllers.get(job.id)?.abort(); this.abortAttention(job.id);
    if (this.browser.owner === job.id) await this.browser.close(job.id);
    this.browser.release(job.id);
    await this.save(job); return { job_id: job.id, status: job.status };
  }
  // Saved jobs drop URL queries and credential-like fields. The library proxy
  // prefix ("login?url=") and browser targets are public addresses whose query
  // is part of the address, so they are kept exactly.
  async save(job) { await this.active.filesystem.writeText(jobPath(job.id), JSON.stringify({ ...clean(job), ...(Object.hasOwn(job, 'discoveryArguments') ? { discoveryArguments: job.discoveryArguments } : {}),
    ...(job.executionCheckpoint ? { executionCheckpoint: job.executionCheckpoint } : {}),
    ...(job.proxyPrefix ? { proxyPrefix: job.proxyPrefix } : {}), ...(job.targets ? { targets: job.targets } : {}) })); }
  async load(id) {
    if (!/^lit_[a-f0-9]{24}$/.test(id || '')) throw fail('INVALID_JOB_ID');
    if (this.jobs.has(id)) return this.jobs.get(id);
    const job = JSON.parse(await this.active.filesystem.readText(jobPath(id)));
    if (job.id !== id || !contract.tasks[job.kind]) throw fail('INVALID_JOB');
    contract.validate(contract.tasks[job.kind], job.task);
    job.status = ['completed', 'cancelled', 'blocked', 'failed'].includes(job.status) ? job.status : 'needs_login';
    this.jobs.set(id, job); return job;
  }
  async list() {
    let files; try { files = await this.active.filesystem.list('.biodesign/literature-jobs'); } catch { return []; }
    const jobs = [];
    for (const file of files.slice(-100)) {
      try { const job = await this.load(file.name.replace(/\.json$/, '')); jobs.push({ job_id: job.id, kind: job.kind, status: job.status, task: job.task, position: job.position || 0, model: job.model, permission: job.permission, scopePaths: job.scopePaths }); } catch { /* invalid checkpoint */ }
    }
    return jobs;
  }
  async cancel(id) {
    const job = await this.load(id); job.status = 'cancelled'; this.controllers.get(id)?.abort(); this.abortAttention(id);
    if (this.browser.owner === id) await this.browser.close(id); this.browser.release(id); await this.save(job); return this.result(job);
  }
  abortAttention(id) { this.attentionControllers.get(id)?.abort(); this.attentionControllers.delete(id); }
  // Waits, out of band, while the user signs in or completes a check in the browser window.
  async awaitAttention(input) {
    const job = await this.load(input.job_id);
    if (job.model !== input.model || job.permission !== input.permission || JSON.stringify(job.scopePaths) !== JSON.stringify(input.scopePaths ?? null)) throw fail('JOB_BINDING_CHANGED');
    if (job.status !== 'needs_login' || this.browser.owner !== job.id || typeof this.browser.awaitAttention !== 'function') return { cleared: false, reason: 'not_waiting' };
    this.abortAttention(job.id);
    const controller = new AbortController(); this.attentionControllers.set(job.id, controller);
    try { return await this.browser.awaitAttention(job.id, { signal: AbortSignal.any([controller.signal, this.active.sourceDownloads.signal]) }); }
    catch (error) { if (error.code === 'OPERATION_ABORTED' || error.code === 'BROWSER_BUSY') return { cleared: false, reason: 'cancelled' }; throw error; }
    finally { if (this.attentionControllers.get(job.id) === controller) this.attentionControllers.delete(job.id); }
  }
  toolDefinitions(job) {
    const host = job.kind === 'discover_papers' ? [contract.tool('finish_discovery', 'Hand off discovery findings to the main agent, including candidates and search limitations. Arguments are forwarded as supplied. Does not download.', { type: 'object', properties: {}, additionalProperties: true })]
      : [contract.tool('retrieve_next', 'Run the host retrieval sequence for one requested paper: local files, open-access repositories, then the publisher in the library browser. Host verifies all bytes. Each paper runs once; later calls return its saved outcome.', schema({ index: indexSchema })),
        contract.tool('capture_article', 'Download the observed article link inside the library browser session; the host verifies PDF identity and version. Landing pages are not saved as articles.', schema({ index: indexSchema, target: referenceSchema({ allowLatestDownload: true }) })),
        contract.tool('record_access', 'Record a concrete observed institutional access restriction or unresolved route. This does not claim a download.', schema({ index: indexSchema, status: contract.enumeration(['access_unavailable', 'unresolved']), reason: field(1000) })),
        contract.tool('finish_retrieval', 'Return host-generated per-paper receipts. No model-supplied success claims.', schema({}))];
    return [...(job.paperTools || []).map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
      ...(job.browserTools || []).map(restrictBrowserTool).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
      ...host.filter(tool => !(job.kind === 'retrieve_papers' && !job.browsing && ['capture_article', 'record_access'].includes(tool.function.name)))];
  }
  access(job) {
    return { open_access_only: Boolean(job.openAccessOnly), library_url: job.openAccessOnly ? '' : job.libraryUrl || job.task.library_url || '',
      ...(job.kind === 'retrieve_papers' ? { deterministic: true, browsing: Boolean(job.browsing), library_browsing: Boolean(job.libraryUrl) } : {}) };
  }
  result(job) {
    const base = { version: 1, job_id: job.id, status: job.status === 'running' ? 'partial' : job.status, limitations: job.limitations || [] };
    if (job.kind === 'discover_papers' && Object.hasOwn(job, 'discoveryArguments')) return { ...base, discoveryArguments: job.discoveryArguments };
    if (job.kind === 'discover_papers') return contract.validate(contract.results[job.kind], { ...base, candidates: job.candidates || [], searches: job.searches || [] });
    return contract.validate(contract.results[job.kind], { ...base, results: job.task.papers.map((paper, index) => job.results[index] || { requested: paper, status: job.status === 'cancelled' ? 'cancelled' : job.status === 'needs_login' ? 'needs_login' : 'unresolved', document_version: 'unknown', attempts: [], reason: 'No verified full text established on attempted routes.', job_id: job.id }) });
  }
  async run(input) {
    assertOnlyKeys(input, ['action', 'job_id', 'kind', 'task', 'name', 'args', 'permission', 'authorization', 'model', 'scopePaths', 'execution_id', 'libraryAccess', 'browserProfile']);
    // Bind the queued action to an immutable snapshot, including its captured authority.
    input = structuredClone(input);
    if (input.execution_id !== undefined && !/^literature_[a-f0-9]{16}$/.test(input.execution_id)) throw fail('INVALID_EXECUTION_ID');
    const operation = async () => {
      if (!this.isCurrent()) throw fail('OPERATION_ABORTED');
      return input.execution_id ? this.runRecorded(input) : this.execute(input);
    };
    // Out-of-band interruption must not wait for the action it is cancelling;
    // a sign-in wait must not hold the queue that its own resume will need.
    if (input.action === 'await_attention') { if (!this.isCurrent()) throw fail('OPERATION_ABORTED'); return this.awaitAttention(input); }
    if (['cancel', 'suspend'].includes(input.action)) return operation();
    if (input.action === 'resume' && input.job_id) this.abortAttention(input.job_id);
    const pending = this.queue.then(operation, operation); this.queue = pending.catch(() => {}); return pending;
  }
  async readReceipt(id) {
    let receipt;
    try { receipt = JSON.parse(await this.active.filesystem.readText(receiptPath(id))); }
    catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof SyntaxError) throw fail('EXECUTION_OUTCOME_UNKNOWN'); throw error; }
    if (receipt?.version === 2 && receipt.status === 'pending') {
      try {
        const uncertain = JSON.parse(await this.active.filesystem.readText(uncertainPath(id)));
        if (uncertain.status !== 'uncertain' || uncertain.execution_id !== receipt.execution_id || uncertain.fingerprint !== receipt.fingerprint) throw fail('EXECUTION_OUTCOME_UNKNOWN');
        return { ...receipt, status: 'uncertain', error: uncertain.error, failed_at: uncertain.failed_at };
      } catch (error) { if (error instanceof SyntaxError) throw fail('EXECUTION_OUTCOME_UNKNOWN'); if (error.code !== 'ENOENT') throw error; }
    }
    return receipt;
  }
  async recoverReceipt(previous, input, fingerprint) {
    // Legacy receipts were completed records. Keep their original binding algorithm.
    if (!previous || typeof previous !== 'object') throw fail('EXECUTION_OUTCOME_UNKNOWN');
    if (previous.version === 2 && previous.execution_id !== input.execution_id) throw fail('EXECUTION_BINDING_CHANGED');
    if (previous.fingerprint !== (previous.version === undefined ? digest({ ...input, execution_id: undefined }) : fingerprint)) throw fail('EXECUTION_BINDING_CHANGED');
    if ((previous.version === undefined || previous.version === 2 && previous.status === 'completed') && Object.hasOwn(previous, 'result')) return previous.result;
    if (previous.version !== 2 || previous.execution_id !== input.execution_id || !['pending', 'uncertain'].includes(previous.status)) throw fail('EXECUTION_OUTCOME_UNKNOWN');
    // Read persisted domain state, never the in-memory job or load()'s restart projection.
    // Only an exact result saved with this admission proves completion; files/counters alone do not.
    let checkpoint;
    if (/^lit_[a-f0-9]{24}$/.test(previous.job_id || '')) {
      try { checkpoint = JSON.parse(await this.active.filesystem.readText(jobPath(previous.job_id))).executionCheckpoint; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (checkpoint?.execution_id !== input.execution_id || checkpoint?.fingerprint !== fingerprint || !Object.hasOwn(checkpoint, 'result')) throw fail('EXECUTION_OUTCOME_UNKNOWN');
    await this.active.filesystem.writeText(receiptPath(input.execution_id), JSON.stringify({ ...previous, status: 'completed', result: checkpoint.result, completed_at: Date.now(), reconciled: true }));
    return checkpoint.result;
  }
  async runRecorded(input) {
    const fingerprint = digest(canonical({ project: this.active.filesystem.root, input: { ...input, execution_id: undefined } }));
    const previous = await this.readReceipt(input.execution_id);
    if (previous) return this.recoverReceipt(previous, input, fingerprint);
    const record = { version: 2, execution_id: input.execution_id, fingerprint, status: 'pending', started_at: Date.now(),
      job_id: input.action === 'begin' ? input.task?.job_id || `lit_${crypto.randomBytes(12).toString('hex')}` : input.job_id };
    // Exclusive creation arbitrates duplicate delivery across service instances. A partial or
    // unreadable reservation fails closed. No effect starts until persistence acknowledges it.
    try { await this.active.filesystem.writeText(receiptPath(input.execution_id), JSON.stringify(record), { exclusive: true }); }
    catch (error) {
      if (error.code === 'EEXIST') return this.recoverReceipt(await this.readReceipt(input.execution_id) || {}, input, fingerprint);
      throw error;
    }
    try {
      const result = await this.execute(input, record);
      const saved = storedResult(result);
      await this.active.filesystem.writeText(receiptPath(input.execution_id), JSON.stringify({ ...record, status: 'completed', result: saved, completed_at: Date.now() }));
      return saved;
    } catch (error) {
      // A write can commit before its acknowledgement fails. Never erase a completed receipt.
      try {
        const persisted = await this.readReceipt(input.execution_id);
        if (persisted?.status === 'completed') return await this.recoverReceipt(persisted, input, fingerprint);
        // Separate failure marker: a racing recovery may already be publishing completion.
        // Completed receipts always win; uncertainty can never overwrite their saved result.
        await this.active.filesystem.writeText(uncertainPath(input.execution_id), JSON.stringify({ ...record, status: 'uncertain', error: code(error), failed_at: Date.now() }), { exclusive: true });
      } catch { /* The durable pending reservation still prevents replay if storage is unavailable. */ }
      throw error;
    }
  }
  async execute(input, execution) {
    if (!this.isCurrent()) throw fail('OPERATION_ABORTED');
    if (input.action === 'cancel') return this.cancel(input.job_id);
    if (input.action === 'suspend') return this.suspend(input);
    let job;
    if (input.action === 'begin' && input.task?.job_id) {
      const saved = await this.load(input.task.job_id);
      const task = { ...input.task }; delete task.job_id;
      if (saved.kind !== input.kind || JSON.stringify(clean(task)) !== JSON.stringify(saved.task)) throw fail('JOB_TASK_CHANGED');
      input = { ...input, action: 'resume', job_id: saved.id };
    }
    if (input.action === 'begin') {
      if (!contract.isTool(input.kind)) throw fail('INVALID_LITERATURE_TASK');
      contract.validate(contract.tasks[input.kind], input.task);
      if (input.kind === 'retrieve_papers' && !authorized(input)) throw fail('DOWNLOAD_NOT_AUTHORIZED');
      if (!input.libraryAccess || typeof input.libraryAccess.url !== 'string') throw fail('LIBRARY_CHOICE_REQUIRED');
      assertOnlyKeys(input.libraryAccess, ['url', 'proxy']);
      const libraryUrl = input.libraryAccess.url.trim();
      if (libraryUrl && (!contract.safeUrl(libraryUrl) || libraryUrl.length > 4096)) throw fail('INVALID_LIBRARY_URL');
      // A library proxy prefix (EZproxy, OpenAthens) opens publisher pages with university access.
      const proxyPrefix = typeof input.libraryAccess.proxy === 'string' ? input.libraryAccess.proxy.trim() : '';
      if (proxyPrefix && (!/^https?:\/\//i.test(proxyPrefix) || !contract.safeUrl(proxyPrefix) || proxyPrefix.length > 2000)) throw fail('INVALID_LIBRARY_PROXY');
      if (input.browserProfile !== undefined && !/^[a-f0-9]{24}$/.test(input.browserProfile)) throw fail('INVALID_BROWSER_PROFILE');
      if (input.task.destination) assertRelativePath(input.task.destination);
      const scopePaths = input.scopePaths ?? null; if (scopePaths !== null && (!Array.isArray(scopePaths) || scopePaths.length > 500)) throw fail('INVALID_SCOPE');
      scopePaths?.forEach(value => assertRelativePath(value));
      job = { id: execution?.job_id || `lit_${crypto.randomBytes(12).toString('hex')}`, kind: input.kind, task: input.task, status: 'running', permission: input.permission,
        model: input.model, authorized: authorized(input), scopePaths, libraryUrl, proxyPrefix, browserProfile: input.browserProfile || null, openAccessOnly: !libraryUrl && !proxyPrefix,
        created: Date.now(), elapsed: 0, calls: 0, navigations: 0, downloads: 0, results: {}, candidates: [], searches: [], limitations: [], observations: '', position: 0, known: [],
        targets: {}, deferred: {}, attentionRounds: 0, browserCaptures: 0 };
      if (job.openAccessOnly) job.limitations.push(job.kind === 'discover_papers'
        ? 'No library access was provided: institutional catalogue browsing is disabled. Candidates without open-access evidence are marked, not omitted.'
        : 'No library access was provided: retrieval uses open-access copies and publisher pages without university sign-in.');
      this.jobs.set(job.id, job); await this.save(job);
    } else job = await this.load(input.job_id);
    if (job.model !== input.model || job.permission !== input.permission || JSON.stringify(job.scopePaths) !== JSON.stringify(input.scopePaths ?? null)) throw fail('JOB_BINDING_CHANGED');
    if (job.status === 'cancelled' && input.action !== 'resume') return { final: this.result(job) };
    if (input.action === 'resume') this.controllers.delete(job.id);
    if (job.kind === 'retrieve_papers' && (!job.authorized || !authorized(input))) throw fail('DOWNLOAD_NOT_AUTHORIZED');
    const controller = this.controllers.get(job.id) || new AbortController(); this.controllers.set(job.id, controller);
    const signal = AbortSignal.any([controller.signal, this.active.sourceDownloads.signal]);
    const started = Date.now();
    try {
      const result = await this.executeAction(job, input, signal);
      // One bounded checkpoint in the existing job store permits receipt repair after a
      // completed domain save. It does not infer success or resume browser/download effects.
      if (execution) job.executionCheckpoint = { execution_id: execution.execution_id, fingerprint: execution.fingerprint, result: storedResult(result) };
      return result;
    } finally {
      if (signal.aborted && this.browser.owner === job.id) { await this.browser.close(job.id); this.browser.release(job.id); }
      job.elapsed += Date.now() - started; job.searches = job.searches.slice(-30); job.limitations = [...new Set(job.limitations)].slice(-30);
      try { await this.save(job); }
      catch (error) { if (this.browser.owner === job.id) await this.browser.close(job.id); throw error; }
    }
  }
  // Starts the library browser at the user's library page for model-directed browsing.
  async openLibrary(job, input, signal) {
    if (job.browserProfile && this.browser.owner !== job.id) await this.browser.useProfile?.(job.browserProfile);
    await this.browser.exclusive(job.id, () => this.browser.start()); job.browserTools = this.browser.tools;
    // Runtime discovery is authoritative; only the host-filtered schemas reach the worker.
    const recheckUrl = job.libraryUrl || job.task.library_url || (input.action === 'resume' ? job.task.papers?.[job.position || 0]?.source_urls?.[0] : null);
    const observation = await this.browser.call(job.id, recheckUrl ? 'browser_navigate' : 'browser_snapshot', recheckUrl ? { url: recheckUrl } : {}, signal);
    if (observation.status === 'needs_login') { job.status = 'needs_login'; return { needs_login: true }; }
    job.observations = [job.observations, observation.snapshot || ''].filter(Boolean).join('\n').slice(-60000);
    return { observation: observation.snapshot || '' };
  }
  async executeAction(job, input, signal) {
    const ensureCurrent = () => { if (signal.aborted || !this.isCurrent()) throw fail('OPERATION_ABORTED'); };
    try {
      ensureCurrent();
      if (['begin', 'resume'].includes(input.action)) {
        job.status = 'running';
        let refreshedObservation = '';
        try { await this.active.paperMcp.start(); job.paperTools = this.active.paperMcp.tools.filter(t => academic.isTool(t.name)); }
        catch { job.paperTools = []; job.limitations.push('Local paper MCP unavailable; use other supported sources.'); }
        // Retrieval starts the browser only when a paper needs it; discovery browses the library catalogue.
        const browse = job.kind === 'discover_papers' ? !job.openAccessOnly : job.browsing === true;
        if (browse) {
          const opened = await this.openLibrary(job, input, signal);
          if (opened.needs_login) return { job_id: job.id, needs_login: true, final: this.result(job) };
          refreshedObservation = opened.observation;
        } else if (job.kind === 'discover_papers' || !job.browsing) job.browserTools = [];
        delete job.lastError;
        return { job_id: job.id, tools: this.toolDefinitions(job), checkpoint: this.result(job), observation: refreshedObservation, access: this.access(job),
          ...(input.action === 'resume' ? { resumed: true } : {}) };
      }
      if (job.status === 'needs_login') return { job_id: job.id, needs_login: true, final: this.result(job) };
      if (job.status === 'blocked' || job.status === 'failed') return this.blockedResult(job);
      if (input.action === 'web_receipt') {
        contract.validate(contract.object({ query: field(2000), evidence: field(40000) }), input.args);
        job.observations = (job.observations + '\n' + clean(input.args.evidence)).slice(-60000);
        job.searches.push({ query: input.args.query.slice(0, 1000), source: 'selected-model web search' });
        return { result: { recorded: true } };
      }
      if (input.action !== 'step') throw fail('INVALID_JOB_ACTION');
      job.calls++;
      if (job.kind === 'retrieve_papers' && DRIVER_STEPS.has(input.name)) return await this.driverStep(job, input, signal);
      const usesBrowser = input.name.startsWith('browser_') || input.name === 'capture_article';
      if (usesBrowser && (job.kind === 'discover_papers' ? job.openAccessOnly : !job.browsing)) throw fail('SPECIALIST_TOOL_NOT_ALLOWED');
      if (usesBrowser && this.browser.owner !== job.id) throw fail('BROWSER_OWNERSHIP_LOST');
      const tool = this.toolDefinitions(job).find(t => t.function.name === input.name);
      if (!tool) throw fail('SPECIALIST_TOOL_NOT_ALLOWED');
      if (input.name === 'finish_discovery') {
        // The main agent receives the specialist's arguments as authored.
        // Completion here records a handoff, not verified candidate evidence.
        job.discoveryArguments = input.args; job.status = 'completed'; delete job.lastError;
        this.browser.release(job.id);
        console.info('literature.discovery.handoff', { jobId: job.id });
        return { final: this.result(job) };
      }
      // Academic validation covers the provider schema; browser uses AJV over runtime schemas.
      if (input.name === 'capture_article') {
        const target = normalizeSnapshotReference(input.args?.target, { allowLatestDownload: true });
        if (target === null) return { result: skippedReference('invalid_reference') };
        input = { ...input, args: { ...input.args, target } };
      }
      if (!input.name.startsWith('browser_') && !academic.isTool(input.name)) contract.validate(tool.function.parameters, input.args);
      if (academic.isTool(input.name)) {
        const args = job.openAccessOnly && input.name === 'search_academic_papers' ? { ...input.args, prefer_open_access: true } : input.args;
        let result = await this.active.paperMcp.call(input.name, academic.validateInput(input.name, args), signal);
        // Availability is evidence for the model to weigh, never a reason to hide a relevant paper.
        if (job.kind === 'discover_papers' && result.papers) result = { ...result, papers: result.papers.map(paper => ({ ...paper, open_access_evidence: Boolean(openAccessPaper(paper)) })) };
        for (const paper of result.papers || []) if (!job.known.some(p => p.paper_ref === paper.paper_ref)) job.known.push(clean(paper));
        job.known = job.known.slice(-120);
        if (input.name === 'search_academic_papers') for (const query of [input.args.query, ...(input.args.queries || [])]) job.searches.push({ query, source: 'local paper MCP' });
        for (const [provider, status] of Object.entries(result.provider_status || {})) if (status.status !== 'completed' && status.status !== 'success') job.limitations.push(`Provider ${provider}: ${status.status || 'unresolved'}; coverage may be incomplete.`);
        return { result: result?.final && Object.hasOwn(result.final, 'discoveryArguments') ? result : clean(result) };
      }
      if (input.name.startsWith('browser_')) {
        const changesPage = ['browser_navigate', 'browser_navigate_back', 'browser_click', 'browser_type', 'browser_tabs'].includes(input.name);
        const observation = await this.browser.call(job.id, input.name, input.args, signal);
        if (observation.status === 'needs_login') {
          job.status = 'needs_login';
          return { job_id: job.id, needs_login: true, ...(observation.action_skipped ? { action_skipped: true, message: observation.message } : {}), final: this.result(job) };
        }
        job.observations = (job.observations + '\n' + (observation.snapshot || '')).slice(-60000);
        if (observation.status === 'observed' && !observation.action_skipped) {
          job.navigations += changesPage ? 1 : 0;
          if (input.name === 'browser_type') job.searches.push({ query: input.args.text.slice(0, 1000), source: contract.safeUrl(job.libraryUrl || job.task.library_url) || 'institutional browser' });
        }
        return { result: observation };
      }
      if (input.name === 'finish_retrieval') {
        for (const index of Object.keys(job.deferred || {})) delete job.deferred[index];
        job.status = job.task.papers.every((_, i) => ['downloaded', 'already_present'].includes(job.results[i]?.status)) ? 'completed' : 'partial';
        this.browser.release(job.id); return { final: this.result(job) };
      }
      const index = input.args.index, paper = job.task.papers[index]; if (!paper) throw fail('UNKNOWN_REQUESTED_PAPER');
      job.position = index;
      if (['downloaded', 'already_present'].includes(job.results[index]?.status)) return { result: job.results[index] };
      const attempts = job.results[index]?.attempts || [];
      const outcome = (status, reason, route, extra = {}) => job.results[index] = { requested: paper, status, route, document_version: 'unknown', attempts: attempts.slice(-24), reason: reason.slice(0, 1000), job_id: job.id, ...extra };
      if (input.name === 'record_access') {
        if (!job.observations.includes(input.args.reason)) throw fail('ACCESS_EVIDENCE_REQUIRED');
        if (input.args.status === 'access_unavailable' && !/access denied|subscription required|not entitled|do not have access|purchase (?:this|the) article|没有访问权限|无权访问|需要订阅|accès refusé|acceso denegado/i.test(input.args.reason)) throw fail('EXPLICIT_ACCESS_RESTRICTION_REQUIRED');
        attempts.push({ route: 'institutional', reason: input.args.reason }); return { result: outcome(input.args.status, input.args.reason, 'institutional') };
      }
      if (input.name === 'retrieve_next') return { result: await this.retrieve(job, index, paper, attempts, outcome, signal, ensureCurrent) };
      if (input.name === 'capture_article') {
        try {
          const fetched = await this.browser.captureArticle(job.id, input.args.target, signal);
          if (fetched.action_skipped) {
            job.observations = (job.observations + '\n' + (fetched.snapshot || '')).slice(-60000);
            if (['needs_login', 'needs_attention'].includes(fetched.status)) {
              job.status = 'needs_login';
              outcome('needs_login', fetched.message || (fetched.status === 'needs_attention' ? 'Complete the check shown in the library browser window.' : 'Complete university sign-in in the library browser window.'), 'institutional');
              return { job_id: job.id, needs_login: true, action_skipped: true, message: fetched.message, ...(fetched.status === 'needs_attention' ? { attention: { kind: 'challenge' } } : {}), final: this.result(job) };
            }
            return { result: fetched };
          }
          job.downloads++;
          const receipt = await this.verify(job, paper, fetched.bytes, signal, { route: 'institutional' });
          return { result: await this.store(job, index, paper, fetched, receipt, 'institutional', attempts, signal) };
        }
        catch (error) {
          if (/^BROWSER_/.test(error.code || '')) throw error;
          if (job.status === 'blocked') return this.blockedResult(job);
          attempts.push({ route: 'institutional', reason: code(error) });
          if (error.code === 'NEEDS_LOGIN') { job.status = 'needs_login'; outcome('needs_login', 'Complete university login in the visible browser.', 'institutional'); return { job_id: job.id, needs_login: true, final: this.result(job) }; }
          return { result: outcome('unresolved', code(error), 'institutional') };
        }
      }
      throw fail('SPECIALIST_TOOL_NOT_ALLOWED');
    } catch (error) {
      if (signal.aborted) { if (job.status !== 'failed') job.status = 'cancelled'; job.limitations.push('Execution interrupted.'); return { final: this.result(job) }; }
      if (/^BROWSER_/.test(error.code || '') || ['begin', 'resume'].includes(input.action)) return this.block(job, error);
      // A refused or malformed call is the model's error, not an outcome for the paper.
      if (job.kind === 'retrieve_papers' && ['retrieve_next', 'capture_article'].includes(input.name) && job.task.papers[input.args?.index]
        && !['SPECIALIST_TOOL_NOT_ALLOWED', 'INVALID_LITERATURE_CONTRACT'].includes(error.code)) {
        const index = input.args.index;
        job.results[index] = { requested: job.task.papers[index], status: 'failed', document_version: 'unknown', attempts: (job.results[index]?.attempts || []).slice(-23), reason: code(error), job_id: job.id };
        return { result: job.results[index] };
      }
      const diagnostics = this.diagnose(job, error, input.name === 'finish_discovery' ? 'discovery-finalization' : 'literature-host');
      return { error: diagnostics.code, message: diagnostics.message, diagnostics, job_id: job.id };
    }
  }
  // Steps only the deterministic retrieval driver issues.
  async driverStep(job, input, signal) {
    if (input.name === 'request_access') {
      const deferred = Object.keys(job.deferred || {}).map(Number).filter(index => job.results[index]?.status === 'needs_login');
      if (!deferred.length || job.attentionRounds >= MAX_ATTENTION_ROUNDS) {
        job.deferred = {};
        return { result: { requested: 0, remaining: deferred.length } };
      }
      job.attentionRounds++;
      job.status = 'needs_login';
      // One tab per site waits in the library browser; the dialog names each site.
      const entries = deferred.map(index => job.deferred[index]);
      const kinds = new Set(entries.map(item => item.kind)), sites = [...new Set(entries.map(item => item.site))].slice(0, 6);
      const attention = { kind: kinds.size === 1 ? entries[0].kind : 'mixed', site: sites[0], sites, papers: deferred.length, round: job.attentionRounds };
      return { job_id: job.id, needs_login: true, attention, final: this.result(job) };
    }
    if (input.name === 'start_browsing') {
      if (!job.libraryUrl) return { result: { browsing: false, reason: 'NO_LIBRARY_URL' } };
      job.browsing = true;
      const opened = await this.openLibrary(job, input, signal);
      if (opened.needs_login) return { job_id: job.id, needs_login: true, final: this.result(job) };
      return { job_id: job.id, tools: this.toolDefinitions(job), checkpoint: this.result(job), observation: opened.observation, access: this.access(job) };
    }
    throw fail('SPECIALIST_TOOL_NOT_ALLOWED');
  }
  accepted(job, paper) {
    return [...new Set([...job.task.accepted_versions, ...(requestedIsPreprint(paper) ? ['preprint'] : [])])];
  }
  async verify(job, paper, bytes, signal, { declaredVersion, route } = {}) {
    return verifyPaper(bytes, paper, this.accepted(job, paper), { ...this.dependencies, signal, declaredVersion, route });
  }
  // A paper without a DOI is identified through the paper MCP's metadata lookup.
  async identify(job, paper, signal, attempts) {
    if (contract.doi(paper.doi) || !paper.title) return paper;
    try {
      const found = await this.active.paperMcp.call('get_academic_paper', { query: paper.title.slice(0, 1000) }, signal);
      const wanted = normalizeTitle(paper.title);
      const match = (found.papers || []).find(item => normalizeTitle(item.title) === wanted && item.doi
        && (!paper.authors.length || item.authors?.some(author => paper.authors.some(name => normalizeTitle(name).split(' ').at(-1) === normalizeTitle(author).split(' ').at(-1)))));
      if (match) return { ...paper, doi: match.doi, identifiers: { ...match.identifiers, ...paper.identifiers } };
    } catch (error) { if (signal.aborted) throw error; attempts.push({ route: 'open_access', reason: code(error) }); }
    return paper;
  }
  // The deterministic per-paper sequence. Each paper runs it once; after a
  // sign-in or check the deferred browser routes run again.
  async retrieve(job, index, paper, attempts, outcome, signal, ensureCurrent) {
    const prior = job.results[index];
    // A deferred paper runs its browser routes again only after the user had an access round.
    const retry = prior?.status === 'needs_login' && job.deferred?.[index] && job.attentionRounds >= job.deferred[index].retryAfterRound;
    if (prior && !retry) return prior;
    let unverified = null;
    if (!retry) {
      const local = await this.findLocal(job, paper, signal);
      if (local) return outcome('already_present', 'Existing local PDF verified.', 'local', { file: local.file, verification: local.receipt, document_version: local.receipt.version, ingestion: 'existing' });
      attempts.push({ route: 'local', reason: 'No verified match within the permitted local scan (maximum 100 PDFs).' });
      const identified = await this.identify(job, paper, signal, attempts);
      const acquired = await acquirePaperPdf(identified, { signal, ensureCurrent, fetchSource: this.dependencies.fetchSource, lookup: this.dependencies.lookup,
        wait: this.dependencies.wait, acceptedVersions: this.accepted(job, paper), openAlexKey: this.dependencies.openAlexKey,
        verify: async (fetched, item) => {
          const receipt = await this.verify(job, paper, fetched.bytes, signal, { declaredVersion: item.version, route: item.route });
          return { accepted: receipt.identity !== 'unverified' && receipt.version_accepted, receipt };
        } });
      attempts.push(...acquired.attempts.filter(a => a.code !== 'BROWSER_REQUIRED').slice(0, 12).map(a => ({ route: 'open_access', reason: [a.route, a.code, a.httpStatus].filter(Boolean).join(':').slice(0, 200), ...(contract.safeUrl(a.url) ? { source_url: contract.safeUrl(a.url) } : {}) })));
      if (acquired.fetched) { job.downloads++; return this.store(job, index, paper, acquired.fetched, acquired.receipt, 'open_access', attempts, signal); }
      unverified = acquired.unverified || null;
      job.targets[index] = acquired.browserTargets.slice(0, 6);
    }
    const browser = await this.browserStage(job, index, paper, job.targets[index] || [], attempts, signal, ensureCurrent);
    if (browser.saved) return browser.saved;
    unverified ||= browser.unverified;
    if (browser.deferred && !(browser.deferred.kind === 'sign_in' && job.openAccessOnly)) {
      job.deferred[index] = { ...browser.deferred, retryAfterRound: job.attentionRounds + 1 };
      return outcome('needs_login', browser.deferred.kind === 'challenge' ? `A human check on ${browser.deferred.site} blocked the download; it will be retried after you complete it in the library browser.`
        : `Sign-in on ${browser.deferred.site} is needed; it will be retried after you sign in in the library browser.`, 'institutional');
    }
    delete job.deferred[index];
    if (unverified) return this.store(job, index, paper, unverified.fetched, unverified.receipt, 'open_access', attempts, signal);
    if (browser.deferred) return outcome('unresolved', 'The publisher requires a university sign-in, and no library access is configured.', 'institutional');
    if (browser.paywall) return outcome('access_unavailable', 'The publisher page showed a purchase or access restriction in the library browser.', 'institutional');
    return outcome('unresolved', 'Public routes did not establish accessible full text; institutional routes may remain.', 'open_access');
  }
  async browserStage(job, index, paper, targets, attempts, signal, ensureCurrent) {
    if (!targets.length || job.browserUnavailable || typeof this.browser.fetchArticle !== 'function') return {};
    let deferred = null, paywall = false, unverified = null;
    // A site that asked for sign-in or a human check this round asks again for every
    // page; later papers on it wait for the same access round instead of retrying.
    job.waitingSites ||= {};
    for (const target of targets.slice(0, BROWSER_TARGETS_PER_PAPER)) {
      ensureCurrent();
      // Publisher pages open through the library proxy; repositories open directly.
      const proxied = Boolean(job.proxyPrefix) && target.route === 'publisher';
      // Every proxied page leads to the same university sign-in, so the proxy waits as one site.
      const site = hostOf(target.url), proxySite = proxied ? `proxy:${hostOf(job.proxyPrefix)}` : '';
      const waiting = [site, proxySite].map(key => job.waitingSites[key]).find(entry => entry && entry.round > job.attentionRounds);
      if (waiting) {
        deferred ||= { kind: waiting.kind, site: waiting.site || site };
        attempts.push({ route: target.route === 'publisher' ? 'institutional' : 'open_access', reason: `browser:waiting_for_${waiting.kind}`, ...(contract.safeUrl(target.url) ? { source_url: contract.safeUrl(target.url) } : {}) });
        continue;
      }
      if (job.browserCaptures >= BROWSER_CAPTURES_PER_JOB) { job.limitations.push(`Browser downloads were capped at ${BROWSER_CAPTURES_PER_JOB} for this job.`); break; }
      const route = proxied || target.route === 'publisher' ? 'institutional' : 'open_access';
      await (this.dependencies.wait || politeWait)(target.url, signal, 4000);
      let result;
      try {
        if (job.browserProfile && this.browser.owner !== job.id) await this.browser.useProfile?.(job.browserProfile);
        result = await this.browser.fetchArticle(job.id, { url: target.url, doi: paper.doi, proxyPrefix: proxied ? job.proxyPrefix : '' }, signal);
      } catch (error) {
        if (error.code === 'OPERATION_ABORTED' || signal.aborted) throw fail('OPERATION_ABORTED');
        if (error.code === 'BROWSER_BUSY') { attempts.push({ route, reason: 'BROWSER_BUSY' }); break; }
        job.browserUnavailable = true;
        job.limitations.push('The library browser (Google Chrome) could not start; publisher pages were not tried.');
        attempts.push({ route, reason: code(error) }); break;
      }
      job.browserCaptures++;
      const source = contract.safeUrl(target.url) ? { source_url: contract.safeUrl(target.url) } : {};
      if (result.bytes) {
        job.downloads++;
        let receipt;
        try { receipt = await this.verify(job, paper, result.bytes, signal, { declaredVersion: target.version, route: route === 'institutional' ? 'institutional' : target.route }); }
        catch (error) { attempts.push({ route, reason: code(error), ...source }); continue; }
        if (receipt.identity !== 'unverified' && receipt.version_accepted) return { saved: await this.store(job, index, paper, result, receipt, route, attempts, signal) };
        attempts.push({ route, reason: 'IDENTITY_OR_VERSION_UNVERIFIED', ...source });
        unverified ||= { fetched: result, receipt };
        continue;
      }
      attempts.push({ route, reason: `browser:${result.status}${result.reason ? ':' + result.reason : ''}`.slice(0, 200), ...source });
      if (['needs_login', 'needs_attention'].includes(result.status)) {
        const kind = result.status === 'needs_login' ? 'sign_in' : 'challenge', shown = result.site || site || 'the publisher';
        deferred ||= { kind, site: shown };
        // A proxied page that ends on another host's sign-in is the university login, shared by every proxied page.
        const universitySignIn = kind === 'sign_in' && proxySite && result.site && result.site !== site;
        for (const key of new Set([site, result.site, universitySignIn ? proxySite : ''].filter(Boolean))) job.waitingSites[key] = { kind, site: shown, round: job.attentionRounds + 1 };
      }
      if (result.status === 'access_unavailable') paywall = true;
    }
    return { deferred, paywall, unverified };
  }
  async findLocal(job, paper, signal) {
    const tree = await this.active.filesystem.tree();
    const files = [];
    const visit = nodes => { for (const node of nodes) { if (node.children?.length) visit(node.children); else if (/\.pdf$/i.test(node.relativePath) && (!job.scopePaths || job.scopePaths.some(p => node.relativePath === p || node.relativePath.startsWith(p + '/')))) files.push(node.relativePath); } };
    visit(Array.isArray(tree) ? tree : tree.children || []);
    // Each local PDF is parsed once per job and checked against every requested paper.
    const index = this.localIndex.get(job.id) || new Map(); this.localIndex.set(job.id, index);
    if (this.localIndex.size > 8) this.localIndex.delete(this.localIndex.keys().next().value);
    for (const file of files.slice(0, 100)) {
      if (signal.aborted) throw fail('OPERATION_ABORTED');
      try {
        let entry = index.get(file);
        if (!entry) {
          const bytes = Buffer.from(await this.active.filesystem.readBinary(file));
          if (bytes.length > 32 * 1024 * 1024 || !bytes.subarray(0, 8).toString().startsWith('%PDF-')) { index.set(file, { invalid: true }); continue; }
          entry = { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, parsed: await (this.dependencies.parse || parsePdfBounded)(bytes, signal) };
          index.set(file, entry);
        }
        if (entry.invalid) continue;
        const receipt = verifyParsed(entry.parsed, entry, paper, this.accepted(job, paper), { route: 'local' });
        if (receipt.identity !== 'unverified' && (receipt.version_accepted || receipt.version === 'unknown')) return { file, receipt };
      } catch { index.set(file, { invalid: true }); /* invalid/unmatched document */ }
    }
    return null;
  }
  // Save a verified PDF into the project, or quarantine an unverified one.
  async store(job, index, paper, fetched, receipt, route, attempts, signal) {
    const verified = receipt.identity !== 'unverified' && receipt.version_accepted;
    const source = contract.safeUrl(fetched.resolvedUrl); if (!source) throw fail('INVALID_SOURCE_URL');
    attempts.push({ route, reason: verified ? 'PDF_VERIFIED' : 'IDENTITY_OR_VERSION_UNVERIFIED', source_url: source });
    const destination = verified ? job.task.destination || 'literature' : `.biodesign/literature-unverified/${job.id}`;
    let file;
    if (verified) {
      const saved = await downloadSources({ args: { sources: [{ url: source, title: paper.title, preferred_filename: `${receipt.sha256.slice(0, 16)}.pdf` }], destination }, surface: 'agent_command', permission: job.permission },
        { filesystem: this.active.filesystem, signal, isCurrent: this.isCurrent }, { localFetch: async () => ({ ...fetched, contentType: 'application/pdf', resolvedUrl: source }), requirePdf: true, paperMetadata: { ...paper, verification: receipt, ingestion: 'pending' } });
      if (saved[0].status !== 'downloaded') throw fail(saved[0].error.code); file = saved[0].path;
    } else { file = `${destination}/${receipt.sha256}.pdf`; await this.active.filesystem.writeBinary(file, fetched.bytes); }
    return job.results[index] = { requested: paper, status: verified ? 'downloaded' : 'downloaded_unverified', route, file, source_url: source, document_version: receipt.version,
      verification: receipt, attempts: attempts.slice(-24), reason: verified ? 'Host parsed PDF and verified identity and accepted version.' : 'File quarantined; paper identity or accepted version could not be established.', ingestion: verified ? 'pending' : 'not_ingested', job_id: job.id };
  }
}
