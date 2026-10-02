import crypto from 'node:crypto';
import contract from '../../shared/literature-agent.js';
import academic from '../../shared/academic-tools.js';
import { assertOnlyKeys, assertRelativePath } from '../ipc/validation.mjs';
import { acquirePaperPdf } from './paper-acquisition.mjs';
import { downloadSources } from './source-downloader.mjs';
import { verifyPaper } from './paper-verification.mjs';
import { redactBrowserText } from './playwright-mcp-client.mjs';

const fail = code => Object.assign(new Error(code), { code });
const code = error => /^[A-Z_]{1,80}$/.test(error?.code || '') ? error.code : 'LITERATURE_OPERATION_FAILED';
const jobPath = id => `.biodesign/literature-jobs/${id}.json`;
const field = contract.text;
const schema = contract.object;
const indexSchema = { type: 'integer', minimum: 0, maximum: 4 };
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
export class LiteratureWorkflows {
  constructor(active, browser, isCurrent, dependencies = {}) {
    this.active = active; this.browser = browser; this.isCurrent = isCurrent; this.dependencies = dependencies;
    this.jobs = new Map(); this.controllers = new Map(); this.queue = Promise.resolve();
    browser.on?.('ownership-lost', ({ ownerId, error }) => {
      const job = this.jobs.get(ownerId);
      if (!job || ['completed', 'cancelled', 'failed', 'partial'].includes(job.status)) return;
      this.block(job, error);
      void this.save(job).catch(error => console.error('literature.checkpoint.failure', { jobId: job.id, code: code(error) }));
    });
    active.sourceDownloads.signal.addEventListener('abort', () => {
      const owner = browser.owner;
      if (owner) void this.cancel(owner).catch(error => console.error('literature.cancel.failure', { jobId: owner, code: code(error) }));
    }, { once: true });
  }
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
    this.controllers.get(job.id)?.abort();
    await this.browser.close(job.id); this.browser.release(job.id);
    await this.save(job); return { job_id: job.id, status: job.status };
  }
  async save(job) { await this.active.filesystem.writeText(jobPath(job.id), JSON.stringify({ ...clean(job), ...(Object.hasOwn(job, 'discoveryArguments') ? { discoveryArguments: job.discoveryArguments } : {}) })); }
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
    const job = await this.load(id); job.status = 'cancelled'; this.controllers.get(id)?.abort();
    if (this.browser.owner === id) await this.browser.close(id); this.browser.release(id); await this.save(job); return this.result(job);
  }
  toolDefinitions(job) {
    const host = job.kind === 'discover_papers' ? [contract.tool('finish_discovery', 'Hand off discovery findings to the main agent, including candidates and search limitations. Arguments are forwarded as supplied. Does not download.', { type: 'object', properties: {}, additionalProperties: true })]
      : [contract.tool('retrieve_next', 'Check local documents then existing open-access routes for one requested paper. Host verifies all bytes.', schema({ index: indexSchema })),
        contract.tool('capture_article', 'Transfer the observed article hyperlink using the local authenticated session; verify PDF identity and version. Landing pages are not saved as articles.', schema({ index: indexSchema, target: field(40) })),
        contract.tool('record_access', 'Record a concrete observed institutional access restriction or unresolved route. This does not claim a download.', schema({ index: indexSchema, status: contract.enumeration(['access_unavailable', 'unresolved']), reason: field(1000) })),
        contract.tool('finish_retrieval', 'Return host-generated per-paper receipts. No model-supplied success claims.', schema({}))];
    return [...(job.paperTools || []).map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
      ...(job.browserTools || []).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })), ...host.filter(tool => !job.openAccessOnly || !['capture_article', 'record_access'].includes(tool.function.name))];
  }
  result(job) {
    const base = { version: 1, job_id: job.id, status: job.status === 'running' ? 'partial' : job.status, limitations: job.limitations || [] };
    if (job.kind === 'discover_papers' && Object.hasOwn(job, 'discoveryArguments')) return { ...base, discoveryArguments: job.discoveryArguments };
    if (job.kind === 'discover_papers') return contract.validate(contract.results[job.kind], { ...base, candidates: job.candidates || [], searches: job.searches || [] });
    return contract.validate(contract.results[job.kind], { ...base, results: job.task.papers.map((paper, index) => job.results[index] || { requested: paper, status: job.status === 'cancelled' ? 'cancelled' : job.status === 'needs_login' ? 'needs_login' : 'unresolved', document_version: 'unknown', attempts: [], reason: 'No verified full text established on attempted routes.', job_id: job.id }) });
  }
  async run(input) {
    assertOnlyKeys(input, ['action', 'job_id', 'kind', 'task', 'name', 'args', 'permission', 'authorization', 'model', 'scopePaths', 'execution_id', 'libraryAccess']);
    if (input.action === 'cancel') return this.cancel(input.job_id);
    if (input.action === 'suspend') return this.suspend(input);
    if (input.execution_id !== undefined && !/^literature_[a-f0-9]{16}$/.test(input.execution_id)) throw fail('INVALID_EXECUTION_ID');
    const operation = async () => {
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ ...input, execution_id: undefined })).digest('hex');
      if (input.execution_id) {
        const cachedPath = `.biodesign/literature-jobs/receipts/${input.execution_id}.json`;
        try {
          const previous = JSON.parse(await this.active.filesystem.readText(cachedPath));
          if (previous.fingerprint !== fingerprint) throw fail('EXECUTION_BINDING_CHANGED');
          return previous.result;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const result = await this.execute(input);
        await this.active.filesystem.writeText(cachedPath, JSON.stringify({ fingerprint, result: result?.final && Object.hasOwn(result.final, 'discoveryArguments') ? result : clean(result) }));
        return result;
      }
      return this.execute(input);
    };
    const pending = this.queue.then(operation, operation); this.queue = pending.catch(() => {}); return pending;
  }
  async execute(input) {
    if (!this.isCurrent()) throw fail('OPERATION_ABORTED');
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
      assertOnlyKeys(input.libraryAccess, ['url']);
      const libraryUrl = input.libraryAccess.url.trim();
      if (libraryUrl && (!contract.safeUrl(libraryUrl) || libraryUrl.length > 4096)) throw fail('INVALID_LIBRARY_URL');
      if (input.task.destination) assertRelativePath(input.task.destination);
      const scopePaths = input.scopePaths ?? null; if (scopePaths !== null && (!Array.isArray(scopePaths) || scopePaths.length > 500)) throw fail('INVALID_SCOPE');
      scopePaths?.forEach(value => assertRelativePath(value));
      job = { id: `lit_${crypto.randomBytes(12).toString('hex')}`, kind: input.kind, task: input.task, status: 'running', permission: input.permission,
        model: input.model, authorized: authorized(input), scopePaths, libraryUrl, openAccessOnly: !libraryUrl, created: Date.now(), elapsed: 0, calls: 0, navigations: 0, downloads: 0, results: {}, candidates: [], searches: [], limitations: [], observations: '', position: 0, known: [] };
      if (job.openAccessOnly) job.limitations.push('No library URL provided: discovery is limited to open-access papers; institutional browsing is disabled. Provider records without open-access evidence are omitted.');
      this.jobs.set(job.id, job); await this.save(job);
    } else job = await this.load(input.job_id);
    if (job.model !== input.model || job.permission !== input.permission || JSON.stringify(job.scopePaths) !== JSON.stringify(input.scopePaths ?? null)) throw fail('JOB_BINDING_CHANGED');
    if (job.status === 'cancelled' && input.action !== 'resume') return { final: this.result(job) };
    if (input.action === 'resume') this.controllers.delete(job.id);
    if (job.kind === 'retrieve_papers' && (!job.authorized || !authorized(input))) throw fail('DOWNLOAD_NOT_AUTHORIZED');
    const controller = this.controllers.get(job.id) || new AbortController(); this.controllers.set(job.id, controller);
    const signal = AbortSignal.any([controller.signal, this.active.sourceDownloads.signal]);
    const ensureCurrent = () => { if (signal.aborted || !this.isCurrent()) throw fail('OPERATION_ABORTED'); };
    const started = Date.now();
    try {
      ensureCurrent();
      if (['begin', 'resume'].includes(input.action)) {
        job.status = 'running';
        let refreshedObservation = '';
        try { await this.active.paperMcp.start(); job.paperTools = this.active.paperMcp.tools.filter(t => academic.isTool(t.name) && !academic.isWrite(t.name)); }
        catch { job.paperTools = []; job.limitations.push('Local paper MCP unavailable; use other supported sources.'); }
        if (!job.openAccessOnly) {
          await this.browser.exclusive(job.id, () => this.browser.start()); job.browserTools = this.browser.tools;
          // Runtime discovery is authoritative; only the host-filtered schemas reach the worker.
          const recheckUrl = job.libraryUrl || job.task.library_url || (input.action === 'resume' ? job.task.papers?.[job.position || 0]?.source_urls?.[0] : null);
          const observation = await this.browser.call(job.id, recheckUrl ? 'browser_navigate' : 'browser_snapshot', recheckUrl ? { url: recheckUrl } : {}, signal);
          if (observation.status === 'needs_login') { job.status = 'needs_login'; return { job_id: job.id, needs_login: true, final: this.result(job) }; }
          refreshedObservation = observation.snapshot || '';
          job.observations = [job.observations, refreshedObservation].filter(Boolean).join('\n').slice(-60000);
        }
        else job.browserTools = [];
        delete job.lastError;
        return { job_id: job.id, tools: this.toolDefinitions(job), checkpoint: this.result(job), observation: refreshedObservation,
          access: { open_access_only: Boolean(job.openAccessOnly), library_url: job.openAccessOnly ? '' : job.libraryUrl || job.task.library_url || '' } };
      }
      if (job.status === 'needs_login') return { job_id: job.id, needs_login: true, final: this.result(job) };
      if (job.status === 'blocked' || job.status === 'failed') return this.blockedResult(job);
      if (!job.openAccessOnly && this.browser.owner !== job.id) throw fail('BROWSER_OWNERSHIP_LOST');
      if (input.action === 'web_receipt') {
        contract.validate(contract.object({ query: field(2000), evidence: field(40000) }), input.args);
        job.observations = (job.observations + '\n' + clean(input.args.evidence)).slice(-60000);
        job.searches.push({ query: input.args.query.slice(0, 1000), source: 'selected-model web search' });
        return { result: { recorded: true } };
      }
      if (input.action !== 'step') throw fail('INVALID_JOB_ACTION');
      job.calls++;
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
      if (!input.name.startsWith('browser_') && !academic.isTool(input.name)) contract.validate(tool.function.parameters, input.args);
      if (academic.isTool(input.name)) {
        const args = job.openAccessOnly && input.name === 'search_academic_papers' ? { ...input.args, prefer_open_access: true } : input.args;
        let result = await this.active.paperMcp.call(input.name, academic.validateInput(input.name, args), signal);
        if (job.openAccessOnly && job.kind === 'discover_papers' && result.papers) result = { ...result, papers: result.papers.filter(openAccessPaper) };
        for (const paper of result.papers || []) if (!job.known.some(p => p.paper_ref === paper.paper_ref)) job.known.push(clean(paper));
        job.known = job.known.slice(-120);
        if (input.name === 'search_academic_papers') for (const query of [input.args.query, ...(input.args.queries || [])]) job.searches.push({ query, source: 'local paper MCP' });
        for (const [provider, status] of Object.entries(result.provider_status || {})) if (status.status !== 'completed' && status.status !== 'success') job.limitations.push(`Provider ${provider}: ${status.status || 'unresolved'}; coverage may be incomplete.`);
        return { result: result?.final && Object.hasOwn(result.final, 'discoveryArguments') ? result : clean(result) };
      }
      if (input.name.startsWith('browser_')) {
        const changesPage = ['browser_navigate', 'browser_navigate_back', 'browser_click', 'browser_type', 'browser_tabs'].includes(input.name);
        job.navigations += changesPage ? 1 : 0;
        const observation = await this.browser.call(job.id, input.name, input.args, signal);
        if (observation.status === 'needs_login') { job.status = 'needs_login'; return { job_id: job.id, needs_login: true, final: this.result(job) }; }
        job.observations = (job.observations + '\n' + (observation.snapshot || '')).slice(-60000);
        if (input.name === 'browser_type') job.searches.push({ query: input.args.text.slice(0, 1000), source: contract.safeUrl(job.libraryUrl || job.task.library_url) || 'institutional browser' });
        return { result: observation };
      }
      if (input.name === 'finish_retrieval') { job.status = job.task.papers.every((_, i) => ['downloaded', 'already_present'].includes(job.results[i]?.status)) ? 'completed' : 'partial'; this.browser.release(job.id); return { final: this.result(job) }; }
      const index = input.args.index, paper = job.task.papers[index]; if (!paper) throw fail('UNKNOWN_REQUESTED_PAPER');
      job.position = index;
      if (['downloaded', 'already_present'].includes(job.results[index]?.status)) return { result: job.results[index] };
      const attempts = job.results[index]?.attempts || [];
      const outcome = (status, reason, route, extra = {}) => job.results[index] = { requested: paper, status, route, document_version: 'unknown', attempts: attempts.slice(-24), reason, job_id: job.id, ...extra };
      if (input.name === 'record_access') {
        if (!job.observations.includes(input.args.reason)) throw fail('ACCESS_EVIDENCE_REQUIRED');
        if (input.args.status === 'access_unavailable' && !/access denied|subscription required|not entitled|do not have access|purchase (?:this|the) article|没有访问权限|无权访问|需要订阅|accès refusé|acceso denegado/i.test(input.args.reason)) throw fail('EXPLICIT_ACCESS_RESTRICTION_REQUIRED');
        attempts.push({ route: 'institutional', reason: input.args.reason }); return { result: outcome(input.args.status, input.args.reason, 'institutional') };
      }
      if (input.name === 'retrieve_next') {
        if (attempts.some(a => a.route === 'open_access')) return { result: job.results[index] };
        const local = await this.findLocal(job, paper, signal);
        if (local) return { result: outcome('already_present', 'Existing local PDF verified.', 'local', { file: local.file, verification: local.receipt, document_version: local.receipt.version, ingestion: 'existing' }) };
        attempts.push({ route: 'local', reason: 'No verified match within the permitted local scan (maximum 100 PDFs).' });
        let metadata = { ...paper, locations: paper.source_urls.map(url => ({ url, kind: 'landing' })) };
        if (paper.paper_ref) {
          try { const result = await this.active.paperMcp.call('resolve_paper_full_text', { paper_ref: paper.paper_ref }, signal); const resolved = result.papers?.find(p => p.paper_ref === paper.paper_ref); if (resolved && (!paper.doi || contract.doi(resolved.doi) === contract.doi(paper.doi)) && resolved.title === paper.title) metadata = resolved; }
          catch (error) { attempts.push({ route: 'open_access', reason: code(error) }); }
        }
        const acquired = await acquirePaperPdf(metadata, { signal, ensureCurrent, fetchSource: this.dependencies.fetchSource });
        attempts.push(...acquired.attempts.slice(0, 16).map(a => ({ route: 'open_access', reason: a.code, ...(contract.safeUrl(a.url) ? { source_url: contract.safeUrl(a.url) } : {}) })));
        if (!acquired.fetched) { attempts.push({ route: 'open_access', reason: acquired.exhausted }); return { result: outcome('unresolved', 'Public routes did not establish accessible full text; institutional routes may remain.', 'open_access') }; }
        job.downloads++; return { result: await this.saveFetched(job, index, acquired.fetched, 'open_access', attempts, signal) };
      }
      if (input.name === 'capture_article') {
        if (job.openAccessOnly) throw fail('INSTITUTIONAL_ACCESS_DISABLED');
        job.downloads++;
        try { const fetched = await this.browser.captureArticle(job.id, input.args.target, signal); return { result: await this.saveFetched(job, index, fetched, 'institutional', attempts, signal) }; }
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
      if (job.kind === 'retrieve_papers' && ['retrieve_next', 'capture_article'].includes(input.name) && job.task.papers[input.args?.index]) {
        const index = input.args.index;
        job.results[index] = { requested: job.task.papers[index], status: 'failed', document_version: 'unknown', attempts: (job.results[index]?.attempts || []).slice(-23), reason: code(error), job_id: job.id };
        return { result: job.results[index] };
      }
      const diagnostics = this.diagnose(job, error, input.name === 'finish_discovery' ? 'discovery-finalization' : 'literature-host');
      return { error: diagnostics.code, message: diagnostics.message, diagnostics, job_id: job.id };
    } finally {
      if (signal.aborted && this.browser.owner === job.id) { await this.browser.close(job.id); this.browser.release(job.id); }
      job.elapsed += Date.now() - started; job.searches = job.searches.slice(-30); job.limitations = [...new Set(job.limitations)].slice(-30);
      try { await this.save(job); }
      catch (error) { await this.browser.close(job.id); throw error; }
    }
  }
  async findLocal(job, paper, signal) {
    const tree = await this.active.filesystem.tree();
    const files = [];
    const visit = nodes => { for (const node of nodes) { if (node.children?.length) visit(node.children); else if (/\.pdf$/i.test(node.relativePath) && (!job.scopePaths || job.scopePaths.some(p => node.relativePath === p || node.relativePath.startsWith(p + '/')))) files.push(node.relativePath); } };
    visit(Array.isArray(tree) ? tree : tree.children || []);
    for (const file of files.slice(0, 100)) {
      if (signal.aborted) throw fail('OPERATION_ABORTED');
      try { const receipt = await verifyPaper(Buffer.from(await this.active.filesystem.readBinary(file)), paper, job.task.accepted_versions, { ...this.dependencies, signal }); if (receipt.identity !== 'unverified' && receipt.version_accepted) return { file, receipt }; } catch { /* invalid/unmatched document */ }
    }
    return null;
  }
  async saveFetched(job, index, fetched, route, attempts, signal) {
    const paper = job.task.papers[index];
    const receipt = await verifyPaper(fetched.bytes, paper, job.task.accepted_versions, { ...this.dependencies, signal });
    const verified = receipt.identity !== 'unverified' && receipt.version_accepted;
    const source = contract.safeUrl(fetched.resolvedUrl); if (!source) throw fail('INVALID_SOURCE_URL');
    attempts.push({ route, reason: verified ? 'PDF_VERIFIED' : 'IDENTITY_OR_VERSION_UNVERIFIED', source_url: source });
    const destination = verified ? job.task.destination || 'literature' : `.biodesign/literature-unverified/${job.id}`;
    let file;
    if (verified) {
      const saved = await downloadSources({ args: { sources: [{ url: source, title: paper.title, preferred_filename: `${receipt.sha256.slice(0, 16)}.pdf` }], destination }, surface: 'agent_command', permission: job.permission },
        { filesystem: this.active.filesystem, signal, isCurrent: this.isCurrent }, { localFetch: async () => ({ ...fetched, resolvedUrl: source }), requirePdf: true, paperMetadata: { ...paper, verification: receipt, ingestion: 'pending' } });
      if (saved[0].status !== 'downloaded') throw fail(saved[0].error.code); file = saved[0].path;
    } else { file = `${destination}/${receipt.sha256}.pdf`; await this.active.filesystem.writeBinary(file, fetched.bytes); }
    return job.results[index] = { requested: paper, status: verified ? 'downloaded' : 'downloaded_unverified', route, file, source_url: source, document_version: receipt.version,
      verification: receipt, attempts: attempts.slice(-24), reason: verified ? 'Host parsed PDF and verified identity and accepted version.' : 'File quarantined; paper identity or accepted version could not be established.', ingestion: verified ? 'pending' : 'not_ingested', job_id: job.id };
  }
}
