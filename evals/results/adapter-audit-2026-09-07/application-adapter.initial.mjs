/** Evaluation boundary only. Never imports cases, expected answers, or scoring data.
 * Executes the production ProjectContextService and its real local dependencies.
 * Controlled provider substitution is explicit; it is not a live quality result.
 */
import { mkdtemp, readFile, rm, utimes, mkdir, cp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { webcrypto, randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProjectFilesystem } from '../../desktop/services/project-filesystem.mjs';
import { ProjectQmdManager } from '../../local-backend/src/project-qmd-manager.js';
const require = createRequire(import.meta.url);
const sourceApi = require('../../docs/source-system.js');
const { LiteratureModule, extractLocalPdf } = require('../../docs/literature-module.js');
const { ElectronQmdKnowledgeService } = require('../../docs/knowledge-service.js');
const { ProjectContextService } = require('../../docs/project-context-service.js');
const { AgentRequestPipeline } = require('../../docs/request-pipeline.js');
const XLSX = require('xlsx');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const list = value => Array.isArray(value) ? value : [];
const unique = values => [...new Set(values.filter(Boolean))];
const errorValue = error => ({ code: error?.code || error?.name || 'ERROR', message: String(error?.message || error).slice(0, 1500) });
const blocked = (code, message) => Object.assign(new Error(message), { code, evaluationBlocked: true });

export const ADAPTER_CONTRACT_VERSION = 1;
export const CAPABILITY_MAPPING = Object.freeze({
  'source.search': 'ProjectContextService.matchPapers / LiteratureTools.searchPapers / ProjectQmdManager.search',
  'source.read': 'LiteratureTools.readPaperEvidence / ProjectContextService.buildFileEvidence',
  'experiment.query': 'ExperimentTools.executeSemanticQuery / queryExperimentResults',
  'memory.search': 'ElectronQmdKnowledgeService.searchProjectMemory',
  'memory.read': 'ProjectContextService.buildMemoryDescriptions / baseContext',
  'sync.run': 'AgentRequestPipeline.preflight / KnowledgeSyncAgent.run / SourceRegistry.reconcile',
  'sync.status': 'AgentRequestPipeline.preflight.report / SourceRegistry.knowledgeSync',
  'corpus.run': 'CorpusWorkflowService.run',
});

class DiskWorkspace {
  constructor(filesystem, project) {
    this.filesystem = filesystem;
    this.workspace = { workspaceId: project.id || project.projectId || project.project_id || 'synthetic-evaluation', name: project.name || 'Synthetic evaluation workspace' };
    this.state = { schemaVersion: 1, project: { goal: project.goal || project.objective || '', ...(project.state?.project || {}) },
      ui: {}, agent: { currentRecommendation: project.currentRecommendation || null, sideChat: {} }, memory: { records: [] }, ...(project.state || {}) };
    this.reads = []; this.writes = []; this.scans = 0;
  }
  createId() { return randomUUID(); }
  async fileExists(p) { return this.filesystem.exists(p); }
  async readFile(p) {
    await this.beforeRead?.(p);
    this.reads.push(p);
    const metadata = await this.filesystem.stat(p);
    const bytes = await this.filesystem.readBinary(p);
    const file = new Blob([bytes]);
    Object.defineProperties(file, { name: { value: path.basename(p) }, lastModified: { value: metadata.lastModified },
      mtimeNs: { value: metadata.mtimeNs }, filesystemFileId: { value: metadata.filesystemFileId } });
    return file;
  }
  async readJson(p) { return JSON.parse(await (await this.readFile(p)).text()); }
  async writeFile(p, value) {
    await this.beforeWrite?.(p);
    this.writes.push(p);
    if (typeof value === 'string') return this.filesystem.writeText(p, value);
    return this.filesystem.writeBinary(p, value instanceof Blob ? await value.arrayBuffer() : value);
  }
  async writeJson(p, value) { return this.writeFile(p, JSON.stringify(value, null, 2)); }
  async removeFile(p) { this.writes.push(p); if (await this.fileExists(p)) return this.filesystem.remove(p); }
  async ensureDirectory(p) { return this.filesystem.ensureDirectory(p); }
  async saveState(state) { this.state = clone(state); await this.writeJson('.biodesign/state.json', this.state); }
  async scanDirectoryTree() { this.scans++; return this.filesystem.tree(); }
}

// The PDF container preserves Unicode with an embedded font. PDF.js read-back
// validates every source page before any production candidate query executes.
const pdfByteCache = new Map();
async function fixturePdf(pages, title, pythonPath) {
  const input = JSON.stringify({ pages, title });
  if (pdfByteCache.has(input)) return pdfByteCache.get(input);
  const promise = new Promise((resolve, reject) => {
    const child = spawn(pythonPath || process.env.BIODESIGN_EVAL_PYTHON || '/Users/wei/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',
      [fileURLToPath(new URL('./fixture-pdf.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [], errors = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(blocked('PDF_FIXTURE_GENERATION_FAILED', Buffer.concat(errors).toString())));
    child.stdin.end(input);
  });
  pdfByteCache.set(input, promise);
  try { return await promise; } catch (error) { pdfByteCache.delete(input); throw error; }
}

async function readOptional(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }

export async function createAdapter(options = {}) {
  const fixtureRoot = path.resolve(options.fixtureRoot || 'evals/biodesign-eval-v1/fixtures');
  const fixtureDirectory = path.basename(fixtureRoot) === 'fixtures' ? fixtureRoot : path.join(fixtureRoot, 'fixtures');
  const project = await readOptional(path.join(fixtureDirectory, 'project.json'), null);
  if (!project) throw blocked('FIXTURE_PROJECT_MISSING', 'The frozen original-source fixture project.json is required.');
  const experimentFixture = await readOptional(path.join(fixtureDirectory, 'experiments.json'), {});
  const memories = await readOptional(path.join(fixtureDirectory, 'memories.json'), []);
  const syncFixture = await readOptional(path.join(fixtureDirectory, 'sync.json'), {});
  const liveConfig = options.liveConfig || {};
  const providerMode = liveConfig.api ? 'live-fc' : options.controlledProviders === false ? 'unavailable' : 'controlled-provider';
  const sessions = new Map();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const rawSources = list(project.sources);

  async function newSession(testCase) {
    const root = await mkdtemp(path.join(options.scratchRoot || os.tmpdir(), 'biodesign-eval-'));
    const workspace = new DiskWorkspace(await ProjectFilesystem.open(root), project);
    const session = { root, workspace, trace: [], measurements: [], sources: new Map(), evidenceAlias: new Map(), rowAliases: new Map(),
      counters: { qmdSearches: 0, qmdUpdates: 0, cards: 0, maps: 0, nativePdf: 0 }, faultsTriggered: 0, testCase, limitations: [] };
    session.sourceStateFaults = Object.entries(testCase.setup?.sourceStates || {}).filter(([, state]) => state === 'failed').map(([resourceId]) =>
      ({ capability: 'source.read', resourceId, kind: 'io_error', occurrence: 1, persistForCase: true, origin: 'declared-sourceState-failed' }));
    try {
      await workspace.writeJson('.biodesign/workspace.json', workspace.workspace);
      await workspace.writeJson('.biodesign/literature/index.json', { schemaVersion: 1, documents: [] });
      const initialVersions = testCase.setup?.initialSourceVersions || {};
      const archive = list(syncFixture.archivedSources);
      const originals = [...rawSources, ...archive.filter(s => initialVersions[s.id] != null && !rawSources.some(current => current.id === s.id))];
      for (const raw of originals) {
        let source = clone(raw);
        if ((source.projectId || source.project_id) && (source.projectId || source.project_id) !== workspace.workspace.workspaceId) continue;
        const version = initialVersions[source.id];
        if (version === null || version === 0 || version === false) continue;
        if (version != null && source.version !== version) {
          const candidate = source.versions?.[version] || syncFixture.sourceVersions?.[source.id]?.[version] || archive.find(s => s.id === source.id && s.version === version);
          if (candidate) source = { ...source, ...candidate, version };
          else session.limitations.push(`Initial source version ${source.id}@${version} is unavailable; setup cannot be represented exactly.`);
        }
        await materializeSource(session, source);
      }
      const datasets = Array.isArray(experimentFixture) ? experimentFixture : list(experimentFixture.sources).length ? experimentFixture.sources : [experimentFixture];
      for (const dataset of datasets) {
        if (!list(dataset.rows).length) continue;
        if ((dataset.projectId || dataset.project_id) && (dataset.projectId || dataset.project_id) !== workspace.workspace.workspaceId) continue;
        const id = dataset.sourceId || 'X01'; const sheet = dataset.sheet || 'Runs';
        const headers = list(dataset.columns).map(c => typeof c === 'string' ? c : c.rawHeader || c.name || c.header).filter(Boolean);
        const selectedHeaders = headers.length ? headers : Object.keys(dataset.rows[0].raw || {});
        const wb = XLSX.utils.book_new();
        const rows = dataset.rows;
        const table = [selectedHeaders];
        rows.forEach((row, i) => { table[(Number(row.rowNumber) || i + 2) - 1] = selectedHeaders.map(h => row.raw?.[h] ?? ''); });
        for (let i = 0; i < table.length; i++) table[i] ||= [];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(table), sheet);
        const relativePath = `experiments/${id}.xlsx`;
        const workbookBytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        await workspace.writeFile(relativePath, workbookBytes);
        await settleFixture(session, relativePath);
        session.sources.set(id, { id, kind: 'experiment', title: id, runtimePath: relativePath, version: dataset.version || 1,
          materializedHash: `sha256:${createHash('sha256').update(workbookBytes).digest('hex')}` });
        rows.forEach((row, i) => session.rowAliases.set(`${id}:${sheet}:${Number(row.rowNumber) || i + 2}`, { rowId: row.id, evidenceId: row.evidenceId }));
      }
      const records = Array.isArray(memories) ? memories : list(memories.records || memories.memories);
      workspace.state.memory.records = records.filter(m => !m.projectId || m.projectId === workspace.workspace.workspaceId).map(m => ({ ...m, memoryId: m.memoryId || m.id, kind: m.kind || 'decision',
        text: m.text || m.content || '', status: m.status || 'active', sourceIds: m.sourceIds || [] }));
      await workspace.saveState(workspace.state);
      const manager = new ProjectQmdManager({ projectRoot: root }); session.manager = manager;
      const bridge = { knowledge: {
        initialize: args => manager.initialize(args),
        update: async args => { session.counters.qmdUpdates++; injectFault(session, 'sync.index'); return manager.update(args); },
        search: async args => { session.counters.qmdSearches++; injectFault(session, 'source.search', args.paperIds?.[0]);
          const started = performance.now(); const value = await manager.search(args);
          session.trace.push({ stage: 'retrieval', entrypoint: 'ProjectQmdManager.search', mode: 'actual-qmd-lexical', query: args.query,
            paperIds: args.paperIds || null, collections: args.collections, resultIds: value.results.map(r => r.paperId || r.sourceId), latencyMs: performance.now() - started }); return value; },
        status: args => manager.status(args), getDocument: args => manager.getDocument(args), onProgress: () => () => {},
      } };
      const knowledge = new ElectronQmdKnowledgeService({ desktop: bridge, workspace, cloudApi: liveConfig.cloudApi || liveConfig.api || null, cryptoProvider: webcrypto });
      session.knowledge = knowledge;
      session.qmdStatus = await knowledge.initialize(workspace.workspace);
      if (!session.qmdStatus.available) session.limitations.push('Actual QMD initialization failed; production legacy retrieval may be observed separately.');
      let literature;
      const api = liveConfig.api || {};
      const system = sourceApi.createSourceSystem({ workspace, knowledgeService: knowledge, cryptoProvider: webcrypto, spreadsheetProvider: XLSX,
        parsePaper: async ({ file, bytes, signal, source }) => { injectFault(session, 'source.read', source?.sourceId); return extractLocalPdf(file, pdfjs, { preloadedBytes: bytes, signal }); },
        generatePaperCard: async payload => {
          session.counters.cards++; injectFault(session, 'paper.card', payload.source.sourceId);
          if (session.testCase.setup?.paperCardProviderUnavailable === true) {
            session.trace.push({ stage: 'paper-card-provider', sourceId: payload.source.sourceId, mode: 'controlled-declared-provider-unavailable' });
            throw Object.assign(new Error('Declared evaluation Paper Card provider is unavailable.'), { code: 'PAPER_CARD_PROVIDER_UNAVAILABLE' });
          }
          if (providerMode === 'live-fc') return literature.generatePaperCardFromPrepared(payload);
          if (providerMode === 'unavailable') throw blocked('FC_PROVIDER_UNAVAILABLE', 'Paper Card generation requires the authenticated FC provider.');
          return controlledCard(session, payload);
        },
        getPaperCardConfiguration: typeof api.getPaperCardConfiguration === 'function' ? signal => api.getPaperCardConfiguration(signal) : undefined,
        schemaMapper: typeof api.mapExperimentSchema === 'function' ? (input, requestOptions) => api.mapExperimentSchema(input, requestOptions?.signal) : undefined,
        mapWorker: async (input, requestOptions) => { session.counters.maps++;
          const fault = takeFault(session, 'corpus.map', input.paperId);
          if (fault && /invalid|malformed/.test(fault.kind)) return { relevance: 'not-a-valid-relevance', majorFindings: 'not-an-array' };
          if (fault) throw faultError(fault, 'corpus.map');
          if (typeof api.mapCorpusPaper === 'function') return api.mapCorpusPaper(input, requestOptions?.signal);
          if (providerMode === 'unavailable') throw blocked('FC_PROVIDER_UNAVAILABLE', 'Corpus mapping requires the authenticated FC provider.');
          session.trace.push({ stage: 'corpus-map', mode: 'controlled-extractive-provider', paperId: input.paperId });
          return { relevance: input.evidence?.length ? 'medium' : 'none', majorFindings: list(input.evidence).slice(0, 6).map(e => ({ claim: e.claimCandidate, evidenceRefs: [e.evidenceRef] })), themes: [], limitations: ['Controlled extractive provider; no scientific synthesis quality is claimed.'] };
        },
        nativePdfWorker: typeof api.analyzePdfNative === 'function' ? async (input, requestOptions) => { session.counters.nativePdf++; return api.analyzePdfNative(input, requestOptions?.signal); } : undefined,
      });
      session.system = system;
      workspace.beforeWrite = async p => {
        const target = session.testCase.setup?.fault?.resourceId;
        if (p.startsWith('.biodesign/') && target && p.includes(`/${target}`)) injectFault(session, 'sync.run', target);
      };
      workspace.beforeRead = async p => {
        if (p.startsWith('.biodesign/')) return;
        const target = [...session.sources.values()].find(source => source.runtimePath === p)?.id;
        const fault = session.testCase.setup?.fault;
        if (fault && /delete|disappear/.test(fault.kind)) {
          const active = takeFault(session, 'source.read', target);
          if (active) await workspace.filesystem.remove(p);
        }
      };
      literature = new LiteratureModule({ workspace, sourceSystem: system, knowledgeService: knowledge, api, pdfjsLib: pdfjs, spreadsheetProvider: XLSX, cryptoProvider: webcrypto });
      session.literature = literature;
      // Assign stable fixture source identities at initial metadata discovery. The
      // registry still derives all hashes/readiness/artifacts from real L0 bytes.
      await system.registry.reconcile(await workspace.scanDirectoryTree());
      for (const source of system.registry.records) {
        const fixture = [...session.sources.values()].find(s => s.runtimePath === source.path);
        if (fixture) { source.sourceId = fixture.id; source.legacy = { discovery: { title: fixture.title, authors: [], topics: [], keywords: [] } }; }
      }
      await system.registry.persist();
      await literature.scan();
      session.pipeline = new AgentRequestPipeline({ workspace, literature, sourceSystem: system });
      observe(session, session.pipeline, 'preflight', 'AgentRequestPipeline.preflight');
      session.contextService = new ProjectContextService({ workspace, literature, sourceSystem: system, requestPipeline: session.pipeline });
      observe(session, system.experimentTools, 'executeSemanticQuery', 'ExperimentTools.executeSemanticQuery');
      observe(session, system.experimentTools, 'searchExperiments', 'ExperimentTools.searchExperiments');
      observe(session, system.experimentTools, 'queryExperimentResults', 'ExperimentTools.queryExperimentResults');
      observe(session, system.literatureTools, 'readPaperEvidence', 'LiteratureTools.readPaperEvidence');
      observe(session, system.literatureTools, 'searchPapers', 'LiteratureTools.searchPapers');
      observe(session, system.corpusWorkflows, 'run', 'CorpusWorkflowService.run');
      return session;
    } catch (error) { await session.manager?.close().catch(() => {}); await rm(root, { recursive: true, force: true }); throw error; }
  }

  async function materializeSource(session, source) {
    const { workspace } = session;
    if (!source.id) throw blocked('SOURCE_ID_MISSING', 'Every original-source fixture needs a stable id.');
    let pages = list(source.pages);
    if (!pages.length && source.path) {
      const text = await readFile(path.resolve(source.path.startsWith('fixtures/') ? path.dirname(fixtureDirectory) : fixtureDirectory, source.path), 'utf8');
      pages = [{ page: 1, text }];
    }
    const runtimePath = source.kind === 'paper' ? `literature/${source.id}.pdf` : `notes/${source.id}.md`;
    if (source.kind === 'paper') {
      const bytes = await fixturePdf(pages, source.title, options.pythonPath);
      const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) });
      const pdf = await loadingTask.promise;
      try {
        for (const page of pages) {
          const content = await (await pdf.getPage(Number(page.page))).getTextContent();
          const extracted = content.items.map(item => item.str || '').join('');
          const compact = text => String(text).normalize('NFKC').replace(/\s+/g, '');
          if (compact(extracted) !== compact(page.text)) throw blocked('PDF_FIXTURE_ROUNDTRIP_MISMATCH', `Original fixture ${source.id} page ${page.page} failed Unicode PDF extraction identity.`);
        }
      } finally { await loadingTask.destroy(); }
      await workspace.writeFile(runtimePath, bytes);
    } else await workspace.writeFile(runtimePath, `# ${source.title || source.id}\n\n${pages.map(p => p.text).join('\n\n')}`);
    await settleFixture(session, runtimePath);
    const originalBytes = Buffer.from(await workspace.filesystem.readBinary(runtimePath));
    const materializedHash = `sha256:${createHash('sha256').update(originalBytes).digest('hex')}`;
    session.sources.set(source.id, { ...source, pages, runtimePath, materializedHash });
    for (const page of pages) if (page.evidenceId) session.evidenceAlias.set(`${source.id}:${page.page}`, page.evidenceId);
  }

  async function settleFixture(session, relativePath) {
    // Fixture files represent files already finished by the user, not an active
    // copy operation. Timestamp settling belongs to setup, never measured work.
    const time = new Date(Date.now() - 5000);
    await utimes(session.workspace.filesystem.candidate(relativePath), time, time);
  }

  function takeFault(session, capability, resourceId) {
    if (session.disableFaults) return null;
    const fault = [session.testCase.setup?.fault, ...session.sourceStateFaults].filter(Boolean).find(fault =>
      [capability, capability.split('.')[0], '*'].includes(fault.capability) && (!fault.resourceId || fault.resourceId === resourceId));
    if (!fault) return null;
    const occurrences = session.faultOccurrences ||= {};
    const key = `${capability}:${resourceId || ''}`;
    occurrences[key] = (occurrences[key] || 0) + 1;
    if (fault.persistForCase ? occurrences[key] < (fault.occurrence || 1) : occurrences[key] !== (fault.occurrence || 1)) return null;
    session.faultsTriggered++;
    session.trace.push({ stage: 'fault-injection', mode: 'controlled-protocol-fault', capability, resourceId, kind: fault.kind });
    return fault;
  }
  function faultError(fault, capability) {
    return Object.assign(new Error(`Controlled ${fault.kind || 'failure'} at ${capability}`), {
      code: fault.kind === 'timeout' ? 'ETIMEDOUT' : /io_error|write_error/.test(fault.kind) ? 'EIO' : /unavailable/.test(fault.kind) ? 'PROVIDER_UNAVAILABLE' : 'EVAL_CONTROLLED_FAILURE' });
  }
  function injectFault(session, capability, resourceId) {
    const fault = takeFault(session, capability, resourceId);
    if (fault) throw faultError(fault, capability);
  }

  async function controlledCard(session, { source, contentHash, paperArtifact }) {
    const descriptor = { sourceId: source.sourceId, contentHash, schemaVersion: 2, modelSignature: 'eval-extractive-card-v1', promptVersion: 'eval-extractive-card-v1', sourceArtifactSchemaVersion: 1, extractorVersion: 'local-source-v1' };
    const artifact = paperArtifact || await session.system.preparation.readPaperArtifact(source.sourceId);
    const chunks = list(artifact.chunks).slice(0, 8);
    const findings = chunks.map(c => c.text.slice(0, 1000));
    const title = artifact.metadataTitle || source.displayName;
    const card = { schemaVersion: 2, paperCardVersion: 2, paperId: source.sourceId, documentId: source.sourceId, fileName: source.displayName,
      generatedAt: new Date().toISOString(), source: { filename: source.displayName, relativePath: source.path, hash: contentHash, artifactSchemaVersion: 1, extractorVersion: 'local-source-v1' },
      model: descriptor.modelSignature, modelSignature: descriptor.modelSignature, promptVersion: descriptor.promptVersion, cacheKey: sourceApi.paperCardCacheKey(descriptor),
      title, authors: [], year: null, abstractSummary: '', researchQuestion: '', mainFindings: findings, methods: [], methodsSummary: '', organisms: [], proteins: [], genes: [], pathways: [], metabolites: [], experimentalConditions: [], measurements: [], importantResults: [],
      limitations: ['Controlled original-text excerpt card; not a measured LLM answer.'], keywords: [], topics: [], shortSummary: findings[0] || title, summary: findings[0] || title,
      keyResults: [], mainConclusion: '', evidenceFindings: chunks.map((c, i) => ({ claim: findings[i], evidenceRefs: [`${source.sourceId}:p${c.page}:${c.chunkId}`] })) };
    const relativePath = `.biodesign/literature/summaries/${source.sourceId}.json`;
    await session.workspace.writeJson(relativePath, card);
    session.trace.push({ stage: 'paper-card', mode: 'controlled-extractive-provider', sourceId: source.sourceId });
    return { ...descriptor, path: relativePath, card };
  }

  function observe(session, target, method, entrypoint) {
    const original = target[method].bind(target);
    target[method] = async (...args) => {
      const start = performance.now();
      try {
        if (entrypoint.startsWith('ExperimentTools.')) {
          const targetId = session.testCase.setup?.fault?.resourceId;
          const explicitIds = args[1]?.experimentSourceIds || args[0]?.experimentSourceIds || (Array.isArray(args[0]?.scope?.experiments) ? args[0].scope.experiments : null);
          if (!targetId || ((!explicitIds || explicitIds.includes(targetId)) && session.system.registry.get(targetId)?.sourceKind === 'experiment'))
            injectFault(session, 'experiment.query', targetId);
        }
        const result = await original(...args);
        const value = result?.resultHandle ? await session.system.results.read(result.resultHandle) : result;
        session.measurements.push({ entrypoint, input: clone(args[0]), result: clone(value) });
        session.trace.push({ stage: 'application-tool', entrypoint, mode: 'production-entrypoint', latencyMs: performance.now() - start,
          ...(method === 'readPaperEvidence' ? { paperId: args[0] } : {}) });
        return result;
      } catch (error) { session.trace.push({ stage: 'application-tool', entrypoint, mode: 'production-entrypoint', error: errorValue(error), latencyMs: performance.now() - start }); throw error; }
    };
  }

  async function applyMutations(session, mutations) {
    for (const mutation of mutations) {
      const id = mutation.sourceId || mutation.source?.id;
      const current = session.sources.get(id);
      if (mutation.operation === 'delete') {
        if (!current) throw blocked('MUTATION_SOURCE_MISSING', `Cannot delete unknown fixture ${id}.`);
        await session.workspace.removeFile(current.runtimePath);
      } else if (['replace', 'add'].includes(mutation.operation)) {
        const source = mutation.source || { ...current, pages: mutation.pages, version: mutation.toVersion };
        if (!source.id || !list(source.pages).length) throw blocked('MUTATION_CONTENT_MISSING', `Mutation ${id} requires original source pages.`);
        await materializeSource(session, source);
      } else throw blocked('MUTATION_UNSUPPORTED', `Unsupported fixture mutation ${mutation.operation}.`);
      session.trace.push({ stage: 'fixture-mutation', mode: 'original-source-fixture-setup', operation: mutation.operation, sourceId: id });
    }
  }

  async function runCase(testCase, runOptions = {}) {
    // Discard gold even when a caller supplies a complete record.
    const { gold, expected, scoring, ...inputCase } = testCase;
    const cacheState = runOptions.cacheState || 'cold';
    const sessionKey = `${testCase.id}:${runOptions.repeat || 0}`;
    const start = performance.now(); let executionStart = null;
    const observation = { caseId: testCase.id, repeat: runOptions.repeat || 0, status: 'completed', executionMode: providerMode === 'live-fc' ? 'application-local-with-live-fc' : 'application-local-controlled-provider',
      actual: { answer: null, retrieval: { paperIds: [], evidenceIds: [], results: [] }, experiments: [] }, trace: [], provenance: {}, errors: [], limitations: [],
      timing: { latencyMs: null, cacheState }, cost: { retrievalUsd: null, generationUsd: null, judgeUsd: null } };
    let session;
    try {
      if (cacheState === 'warm') session = sessions.get(sessionKey);
      if (!session) {
        const previous = sessions.get(sessionKey);
        if (previous) { await previous.manager.close(); if (options.keepScratch !== true) await rm(previous.root, { recursive: true, force: true }); }
        session = await newSession(inputCase); sessions.set(sessionKey, session);
      }
      else { session.testCase = inputCase; session.trace = []; session.measurements = []; }
      if (cacheState === 'cold' && list(inputCase.setup?.mutations).length) {
        session.disableFaults = true;
        await session.pipeline.preflight({ turnId: `seed-${inputCase.id}` });
        session.disableFaults = false;
        await applyMutations(session, inputCase.setup.mutations);
      }
      const before = { reads: session.workspace.reads.length, writes: session.workspace.writes.length, counters: clone(session.counters), scans: session.workspace.scans, state: clone(session.workspace.state) };
      executionStart = performance.now();
      observation.timing.setupMs = executionStart - start;
      const turnQueries = list(inputCase.setup?.turns).length ? inputCase.setup.turns : [inputCase.query];
      const turnContexts = []; let context;
      for (const [turnIndex, turnQuery] of turnQueries.entries()) {
        context = await session.contextService.buildContext({ question: turnQuery,
          turnId: `${inputCase.id}-${cacheState}-${turnIndex}-${randomUUID()}`, surface: inputCase.setup?.surface || inputCase.setup?.interactionMode || 'side_chat', retrievalProfile: 'medium',
          conversation: inputCase.setup?.conversation || { messages: [] },
          selectedPaperIds: inputCase.setup?.selectedPaperIds || [], selectedPaths: inputCase.setup?.selectedPaths || [],
          onProgress: event => session.trace.push({ stage: event.stage || event.phase || 'progress', mode: 'production-progress', turnIndex, ...clone(event) }) });
        turnContexts.push({ turnIndex, question: turnQuery, knowledgeSync: context.knowledgeSync, preflightTelemetry: context.preflightTelemetry,
          corpusWorkflowStatus: context.corpusWorkflowStatus || null, semanticTelemetry: context.semantic?.telemetry });
      }
      if (turnContexts.length > 1) {
        observation.actual.turnContexts = turnContexts;
        observation.limitations.push('Declared repeated context-building turns executed; intermediate conversational answer generation is not part of this controlled workflow-reuse measurement.');
      }
      observation.actual.context = context;
      observation.actual.semantic = context.semantic;
      const resultHandles = [];
      const visit = value => { if (!value || typeof value !== 'object') return; if (typeof value.resultHandle === 'string') resultHandles.push(value.resultHandle); for (const child of Object.values(value)) visit(child); };
      visit(context);
      observation.actual.contextDiscipline = { mainContextCharacters: JSON.stringify(context).length,
        syncReportCharacters: JSON.stringify(context.knowledgeSync || {}).length,
        structuredResultHandles: unique(resultHandles).length, rawMaintenanceTranscriptPresent: null };
      observation.timing.preflightMs = context.preflightTelemetry?.knowledgeSyncMs == null ? null : context.preflightTelemetry.reconciliationMs + context.preflightTelemetry.knowledgeSyncMs;
      observation.timing.mainGateMs = context.preflightTelemetry?.mainAgentStartMs ?? null;
      const reads = session.measurements.filter(m => m.entrypoint === 'LiteratureTools.readPaperEvidence').flatMap(m => list(m.result));
      const searches = session.measurements.filter(m => m.entrypoint === 'LiteratureTools.searchPapers').flatMap(m => list(m.result?.results));
      const citations = list(context.citationEvidence);
      const actualPages = [...reads.map(r => ({ sourceId: r.paperId, page: r.page, reference: r.evidenceHandle, text: r.text })), ...citations];
      const aliases = actualPages.map(e => session.evidenceAlias.get(`${e.sourceId}:${e.page}`)).filter(Boolean);
      const memoryFixtureRecords = Array.isArray(memories) ? memories : list(memories.records || memories.memories);
      aliases.push(...list(context.project?.memoryRecords).map(record => memoryFixtureRecords.find(m => (m.memoryId || m.id) === record.memoryId)?.evidenceId).filter(Boolean));
      for (const hit of list(context.knowledge?.hits)) {
        const source = session.sources.get(hit.sourceId);
        if (source?.kind !== 'paper' && source?.pages?.length === 1) aliases.push(source.pages[0].evidenceId);
      }
      observation.actual.retrieval = { paperIds: unique(context.literature?.relevantPaperIds || searches.map(r => r.paperId)), evidenceIds: unique(aliases),
        candidatePaperIds: unique(searches.map(r => r.paperId)),
        results: searches, evidence: actualPages, nativeEvidenceIds: unique(actualPages.map(e => e.reference)) };
      const structured = context.semanticExperimentResult || session.measurements.filter(m => m.entrypoint === 'ExperimentTools.executeSemanticQuery').at(-1)?.result || null;
      observation.actual.structuredQuery = structured;
      if (structured) {
        const sourceRows = list(structured.records).map(record => {
          const p = record.provenance || {};
          const raw = record.rawCells?.[0] || {};
          const key = `${record.sourceId}:${p.sourceSheet || p.sheet || raw.sheet}:${p.rowNumber || p.row || raw.rowNumber || raw.row}`;
          return { ...clone(p), sourceId: record.sourceId, experimentId: record.experimentId, ...session.rowAliases.get(key), rawCells: record.rawCells, contentHash: record.sourceContentHash };
        });
        observation.actual.sourceRowIds = unique(sourceRows.map(r => r.rowId));
      observation.actual.experiments = (structured.groups?.length ? structured.groups : structured.aggregation ? [structured.aggregation] : []).map(group => {
          const members = sourceRows.filter(row => !group.experimentIds || group.experimentIds.includes(row.experimentId));
          return { name: group.groupValue || group.canonicalField, field: group.canonicalField, groupValue: group.groupValue || null,
            value: group.value, unit: group.unit, aggregation: group.operation,
            filters: context.semantic?.ir?.filters || [], groupBy: group.groupBy ? [group.groupBy] : [], sourceRows: members.map(row => row.rowId || row.experimentId), sourceRowProvenance: members,
            count: group.count, min: group.min, max: group.max, sampleVariance: group.sampleVariance, populationVariance: group.populationVariance };
        });
      }
      observation.actual.sync = { report: context.knowledgeSync || context.knowledgeSyncReport || context.preflight?.report || null,
        sourceAuditComplete: true,
        sources: session.system.registry.records.map(s => ({ sourceId: s.sourceId, sourceKind: s.sourceKind, contentHash: s.contentHash, contentVersion: s.contentVersion,
          verifiedFixtureVersion: s.contentHash && s.contentHash === session.sources.get(s.sourceId)?.materializedHash ? session.sources.get(s.sourceId).version : null,
          catalogStatus: s.catalogStatus, hashStatus: s.hashStatus, parseStatus: s.parseStatus, indexStatus: s.indexStatus,
          qmdLexStatus: s.qmdLexStatus, structuredDataStatus: s.structuredDataStatus, knowledgeSync: s.knowledgeSync, artifacts: s.artifacts })),
        runs: session.measurements.filter(m => m.entrypoint === 'AgentRequestPipeline.preflight').map(m => ({
          report: m.result.report, diff: m.result.diff, changedSourceIds: unique([...list(m.result.diff?.added), ...list(m.result.diff?.removed), ...list(m.result.diff?.modified), ...list(m.result.diff?.possiblyModified)]),
          telemetry: m.result.telemetry })) };
      observation.actual.corpus = context.corpusWorkflowStatus || null;
      const workflow = session.measurements.filter(m => m.entrypoint === 'CorpusWorkflowService.run').at(-1)?.result;
      if (workflow) {
        observation.actual.corpusWorkflow = workflow;
        observation.actual.corpusArtifactText = JSON.stringify({ question: workflow.question, coverage: workflow.coverage,
          reduction: workflow.reduction, verification: workflow.verification }, null, 2);
      }
      const rawReads = session.workspace.reads.slice(before.reads).filter(p => !p.startsWith('.biodesign/'));
      const accessedResourceIds = unique(rawReads.map(p => [...session.sources.values()].find(s => s.runtimePath === p)?.id));
      observation.actual.safety = { accessAuditComplete: false, accessedResourceIds, sideEffectAuditComplete: false,
        sideEffects: list(context.internalStateUpdates).map(type => ({ type, effect: 'internal_state' })),
        reason: 'Actual local filesystem reads and internal updates observed; no enterprise principal ACL or external transport audit is implemented by this local adapter.' };
      observation.actual.localAudit = { filesystemReads: session.workspace.reads.slice(before.reads), filesystemWrites: session.workspace.writes.slice(before.writes),
        beforeState: before.state, afterState: clone(session.workspace.state),
        retrievedResourceIds: unique([...observation.actual.retrieval.paperIds, ...actualPages.map(e => e.sourceId)]),
        activeProjectId: session.workspace.workspace.workspaceId, scope: context.scope,
        note: 'Preflight raw-source maintenance reads cover the active project. Retrieval scope and source-maintenance scope are recorded separately.' };
      if (typeof liveConfig.generateAnswer === 'function') {
        const answer = await liveConfig.generateAnswer({ query: inputCase.query, context, case: inputCase, testCase: inputCase, system: session.system, workspace: session.workspace });
        observation.actual.answer = typeof answer === 'string' ? { text: answer, claims: [] } : answer;
        observation.answerText = observation.actual.answer?.text || '';
      } else observation.limitations.push('Final answer provider unavailable: raw production context/tool outputs are recorded; answer quality is not scored as a generated answer.');
      if (inputCase.setup?.fault && !session.faultsTriggered) observation.limitations.push('Requested controlled fault was not reached or is unsupported; failure-injection coverage is blocked.');
      if (list(inputCase.categories).some(c => /access|permission|acl/i.test(c)) && inputCase.setup?.principal)
        observation.limitations.push('Principal-scoped enterprise ACL is not an exposed production local capability; this case cannot establish the requested access boundary.');
      observation.provenance = { adapterContractVersion: ADAPTER_CONTRACT_VERSION, runtime: process.version,
        sourceFixtureMode: 'synthetic-original-text-to-valid-PDF-and-XLSX', providerMode, qmdAvailable: session.qmdStatus.available,
        qmdVersion: session.qmdStatus.qmdPackageVersion || null, entrypoint: 'ProjectContextService.buildContext',
        counters: Object.fromEntries(Object.entries(session.counters).map(([key, value]) => [key, value - before.counters[key]])),
        scans: session.workspace.scans - before.scans, rawReadCount: rawReads.length,
        capabilityMapping: CAPABILITY_MAPPING, artifactRoot: session.root };
      observation.limitations.push(...session.limitations);
    } catch (error) { observation.status = error.evaluationBlocked ? 'blocked' : 'error'; observation.errors.push(errorValue(error)); }
    finally { observation.trace = clone(session?.trace || []); observation.actual.rawToolObservations = clone(session?.measurements || []);
      observation.timing.latencyMs = executionStart == null ? null : performance.now() - executionStart;
      observation.timing.totalHarnessMs = performance.now() - start; }
    if (observation.limitations.some(l => /cannot be represented|coverage is blocked|cannot establish/.test(l)) && observation.status === 'completed') observation.status = 'blocked';
    return observation;
  }

  async function close() {
    for (const session of sessions.values()) {
      await session.knowledge?.close().catch(() => {});
      await session.manager?.close().catch(() => {});
      if (options.keepScratch !== true) await rm(session.root, { recursive: true, force: true });
    }
    sessions.clear();
  }

  async function createLiveWorkspace({ destination, setup = {} } = {}) {
    const session = await newSession({ id: 'live-workspace-materialization', setup });
    await session.manager.close();
    await session.knowledge.close().catch(() => {});
    if (session.counters.cards || session.counters.maps || session.counters.qmdUpdates)
      throw blocked('LIVE_WORKSPACE_SEED_NOT_EMPTY', 'A live workspace cannot be seeded with provider-derived artifacts.');
    let root = session.root;
    if (destination) {
      root = path.resolve(destination);
      await mkdir(path.dirname(root), { recursive: true });
      await mkdir(root); // Refuse to overwrite any existing project.
      await cp(session.root, root, { recursive: true, force: false, errorOnExist: true });
      await rm(session.root, { recursive: true, force: true });
    }
    return { root, workspaceId: session.workspace.workspace.workspaceId, sourceIds: [...session.sources.keys()],
      sourceVersions: Object.fromEntries([...session.sources].map(([id, source]) => [id, source.version])),
      providerSeedCalls: 0, derivedSourceSeedCount: 0,
      note: 'Isolated original-source PDFs/XLSX and memory state, discovered registry identities, empty QMD index. No Paper Cards, normalized experiment caches, source evidence mirrors, or syntheses were seeded.' };
  }
  return { runCase, close, createLiveWorkspace, contractVersion: ADAPTER_CONTRACT_VERSION, providerMode, capabilityMapping: CAPABILITY_MAPPING };
}
