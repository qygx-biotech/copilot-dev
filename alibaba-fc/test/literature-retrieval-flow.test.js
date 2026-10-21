'use strict';
// Production renderer → agent loop → deterministic retrieval → local host. The
// main model proposes retrieve_papers; the confirmation card is the consent;
// the specialist issues every host step itself with no specialist model call.
const test = require('node:test'), assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const jwt = require('jsonwebtoken');
const { demandFixture } = require('./helpers/demand-context-fixture.js');
const literature = require('../../shared/literature-agent.js');
const call = (name, args) => ({ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const papers = [
  { title: 'Machine learning guided enzyme engineering', authors: ['Alice Smith'], year: 2024, doi: '10.1000/enzyme-ml', source_urls: [] },
  { title: 'Generative protein design for synthetic biology', authors: ['Bob Jones'], year: 2023, doi: '10.1000/protein-gen', source_urls: [] },
];

for (const scenario of ['approve-read-only', 'decline']) test(`production renderer retrieves papers deterministically after one-click consent: ${scenario}`, async t => {
  const { ProjectFilesystem } = await import('../../desktop/services/project-filesystem.mjs');
  const { LiteratureWorkflows } = await import('../../desktop/services/literature-workflows.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'literature-retrieval-e2e-')); t.after(() => rm(root, { recursive: true, force: true }));
  const filesystem = await ProjectFilesystem.open(root);
  const model = 'fixture/literature-selected';
  const env = { JWT_SECRET: 'fixture-secret', ADMIN_ACCOUNT: 'literature-fixture', REQUESTY_API_KEY: 'fixture-key', REQUESTY_MODEL: model, REQUESTY_TOOL_MODE: 'sequential',
    REQUESTY_MODEL_CAPABILITIES_JSON: JSON.stringify({ [model]: { supportsTools: true, supportsWebSearch: false, supportsImages: false } }) };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const token = jwt.sign({ account: env.ADMIN_ACCOUNT, role: 'admin' }, env.JWT_SECRET);
  // The host is real; only the network and the browser are fixtures.
  const captures = [];
  const browser = { owner: null, tools: [], async exclusive(id, fn) { this.owner = id; return fn(); }, async start() {}, release(id) { if (this.owner === id) this.owner = null; }, async close() {},
    async fetchArticle(owner, target) { this.owner = owner; captures.push(target.url); return { bytes: Buffer.from(`%PDF-1.7\n${papers[1].title}`), contentType: 'application/pdf', resolvedUrl: `${target.url}.pdf` }; } };
  const active = { filesystem, sourceDownloads: new AbortController(), paperMcp: { async start() { throw new Error('Unavailable fixture provider'); } } };
  const parse = async bytes => { const paper = papers.find(item => bytes.toString().includes(item.title)); return { pages: 9, text: `${paper.title} ${paper.authors[0]} ${paper.year} doi:${paper.doi}`, firstPage: paper.title, metadata: '' }; };
  const host = new LiteratureWorkflows(active, browser, () => true, { parse, wait: async () => {},
    lookup: async paper => paper.doi === papers[0].doi
      ? { doi: paper.doi, ids: {}, diagnostics: [], candidates: [{ url: 'https://repository.example.org/oa/enzyme.pdf', route: 'open_access_location', version: 'published', kind: 'pdf' }] }
      : { doi: paper.doi, ids: {}, diagnostics: [], candidates: [], publisherUrl: 'https://publisher.example.org/article/protein' },
    fetchSource: async url => {
      if (url.includes('/oa/')) return { bytes: Buffer.from(`%PDF-1.7\n${papers[0].title}`), contentType: 'application/pdf', resolvedUrl: url };
      throw Object.assign(new Error('Forbidden'), { code: 'HTTP_ERROR', httpStatus: 403 });
    } });
  const hostInputs = [];
  const f = await demandFixture();
  const query = 'Find two papers on machine learning for enzyme and protein design and download them.';
  const context = await f.service.buildContext({ ...f.options, question: query, turnId: 'retrieval-e2e', callContext: { model } });
  const stages = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body); assert.equal(request.model, model);
    // Only the main agent reaches the model: retrieval is deterministic.
    assert(request.tools.some(tool => tool.function?.name === 'retrieve_papers'), 'Only main-agent turns are expected');
    stages.push('main');
    if (stages.length === 1) return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [call('retrieve_papers', { papers, accepted_versions: ['published', 'accepted_manuscript'] })] } }] }));
    const receipt = JSON.parse(request.messages.find(message => message.role === 'tool' && message.tool_call_id === 'retrieve_papers').content);
    if (scenario === 'decline') {
      assert.equal(receipt.user_declined, true); assert.deepEqual(receipt.results.map(item => item.status), ['cancelled', 'cancelled']);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'No papers were downloaded because you declined the download.' } }] }));
    }
    assert.deepEqual(receipt.results.map(item => [item.status, item.route]), [['downloaded', 'open_access'], ['downloaded', 'institutional']]);
    assert(receipt.results.every(item => item.attempts.length <= 4));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Saved both papers to literature/.' } }] }));
  });
  const cards = [], granted = [];
  const { sandbox } = await require('./helpers/desktop-renderer.js').desktopRenderer(t, { token, service: f.service,
    workflow: (workflowId, input) => { if (workflowId !== 'literature_worker') return undefined; hostInputs.push(input); return host.run(input); },
    globals: { currentAccount: 'fixture', currentLanguage: 'en', workspaceAbortController: new AbortController() },
    window: { BioDesignLiteratureAgent: literature,
      // The saved library choice is reused; no setup dialog appears.
      BioDesignLibrarySettings: { saved: () => ({ url: '', proxy: 'https://ezproxy.example.edu/login?url=' }), edit: () => assert.fail('The saved library choice must be reused') },
      BioDesignLiteratureLogin: { confirmDownload: async options => { cards.push(options); return scenario === 'decline' ? { approved: false, permission: options.permission } : { approved: true, permission: 'workspace_write' }; },
        wait: () => assert.fail('No sign-in is needed in this fixture') } } });
  const result = await sandbox.sendWorkbenchRequest({ mode: 'agent_instruction', model, messages: [{ role: 'user', content: query }], originalRequest: query, localWorkspaceContext: context,
    grantPermission: value => granted.push(value),
    desktopTools: { version: 1, literatureVersion: 1, permission: 'read_only', projectId: context.project.workspaceId }, callContext: { turnId: 'retrieval-e2e', callRole: 'answer', profile: 'medium' } });
  assert.equal(cards.length, 1); assert.equal(cards[0].permission, 'read_only');
  assert.deepEqual(cards[0].papers.map(paper => paper.doi), papers.map(paper => paper.doi));
  assert.deepEqual(stages, ['main', 'main']);
  if (scenario === 'decline') {
    assert.deepEqual(hostInputs, []); assert.deepEqual(granted, []);
    assert.equal(result.reply, 'No papers were downloaded because you declined the download.');
    assert.notEqual(result.taskOutcome?.status, 'incomplete');
    return;
  }
  assert.deepEqual(granted, ['workspace_write']);
  // Every host step runs with the permission and consent the card granted.
  assert(hostInputs.length >= 4);
  assert(hostInputs.every(input => input.permission === 'workspace_write' && input.authorization.download === true));
  assert.deepEqual({ ...hostInputs[0].libraryAccess }, { url: '', proxy: 'https://ezproxy.example.edu/login?url=' });
  assert.deepEqual(hostInputs.map(input => input.action === 'begin' ? 'begin' : input.name), ['begin', 'retrieve_next', 'retrieve_next', 'finish_retrieval']);
  assert.deepEqual(captures, ['https://publisher.example.org/article/protein']);
  assert.equal(result.reply, 'Saved both papers to literature/.');
  assert.equal(result.taskOutcome.status, 'completed'); assert.equal(result.taskOutcome.downloadSuccessCount, 2);
  assert.equal((await filesystem.list('literature')).length, 2);
});
