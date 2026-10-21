import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectFilesystem } from '../services/project-filesystem.mjs';
import { LiteratureWorkflows } from '../services/literature-workflows.mjs';
import { verifyPaper, parsePdf } from '../services/paper-verification.mjs';
import { PlaywrightMcpClient, redactBrowserText } from '../services/playwright-mcp-client.mjs';
import contract from '../../shared/literature-agent.js';
import academic from '../../shared/academic-tools.js';
import { referenceSchema, skippedReference } from '../services/browser-references.mjs';

const paper = { title: 'Multilingual enzyme engineering', authors: ['Alice Smith'], year: 2024, doi: '10.1234/enzyme', source_urls: ['https://example.org/paper.pdf'] };
const bytes = Buffer.from('%PDF-1.7\nfixture');
const parse = async () => ({ pages: 2, text: `${paper.title} Alice Smith 2024 DOI: 10.1234/enzyme Version of Record` });
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'literature-jobs-')); t.after(() => rm(root, { recursive: true, force: true }));
  const filesystem = await ProjectFilesystem.open(root);
  let login = options.login || false;
  const browser = { tools: [{ name: 'browser_snapshot', description: 'Observe', inputSchema: { type: 'object', properties: {} } }], owner: null, async exclusive(id, fn) { if (this.owner && this.owner !== id) throw Object.assign(new Error(), { code: 'BROWSER_BUSY' }); this.owner = id; return fn(); }, async start() {}, async call() { return login ? { status: 'needs_login' } : { status: 'observed', snapshot: paper.title }; }, release(id) { if (this.owner === id) this.owner = null; }, async close() {}, async captureArticle() { return { bytes, resolvedUrl: paper.source_urls[0], contentType: 'application/pdf' }; } };
  const active = { filesystem, sourceDownloads: new AbortController(), paperMcp: { async start() {}, tools: academic.tools.map(t => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters })), async call() { return { version: 1, status: 'completed', papers: [] }; } } };
  const service = new LiteratureWorkflows(active, browser, () => true, { parse, fetchSource: async url => ({ bytes, contentType: 'application/pdf', resolvedUrl: url }),
    lookup: async item => ({ doi: item.doi, ids: {}, candidates: [], diagnostics: [] }), wait: async () => {}, ...options.dependencies });
  const policy = { model: 'selected/model', permission: 'workspace_write', authorization: { download: true }, scopePaths: null, libraryAccess: { url: 'https://example.org/library' } };
  const begin = (kind = 'retrieve_papers', task = { papers: [paper], accepted_versions: ['published'] }, extra = {}) => service.run({ action: 'begin', kind, task, ...policy, ...extra });
  const step = (job_id, name, args = {}) => service.run({ action: 'step', job_id, name, args, ...policy });
  return { service, active, filesystem, browser, policy, begin, step, setLogin(value) { login = value; } };
}
test('host refuses unapproved downloads and discovery cannot call retrieval or arbitrary code', async t => {
  const f = await fixture(t);
  await assert.rejects(f.begin('retrieve_papers', { papers: [paper], accepted_versions: ['published'] }, { authorization: { download: false } }), { code: 'DOWNLOAD_NOT_AUTHORIZED' });
  const job = await f.begin('discover_papers', { objective: 'enzyme', queries: ['酶工程'] });
  assert.equal((await f.step(job.job_id, 'capture_article', { index: 0, target: 'e1' })).error, 'SPECIALIST_TOOL_NOT_ALLOWED');
  assert.equal((await f.step(job.job_id, 'browser_run_code_unsafe', { code: 'danger' })).error, 'SPECIALIST_TOOL_NOT_ALLOWED');
});
test('host verifies, saves, records hash and reuses exact papers without a duplicate transfer', async t => {
  const f = await fixture(t); const job = await f.begin();
  const result = (await f.step(job.job_id, 'retrieve_next', { index: 0 })).result;
  assert.equal(result.status, 'downloaded'); assert.equal(result.verification.identity, 'doi'); assert.equal(result.ingestion, 'pending'); assert.match(result.verification.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await f.step(job.job_id, 'retrieve_next', { index: 0 })).result.file, result.file);
  await f.step(job.job_id, 'finish_retrieval');
  const next = await f.begin(); assert.equal((await f.step(next.job_id, 'retrieve_next', { index: 0 })).result.status, 'already_present');
});
test('wrong identity/version goes into quarantine and is never presented as an ingested paper', async t => {
  const f = await fixture(t, { dependencies: { parse: async () => ({ pages: 1, text: 'Some other paper' }) } }); const job = await f.begin();
  const result = (await f.step(job.job_id, 'retrieve_next', { index: 0 })).result;
  assert.equal(result.status, 'downloaded_unverified'); assert.match(result.file, /^\.biodesign\/literature-unverified\//); assert.equal(result.ingestion, 'not_ingested');
});
test('login persists job position and scope; resume reobserves; cancellation survives restart', async t => {
  // Discovery opens the library page at once; retrieval opens it only when a paper needs it.
  const f = await fixture(t, { login: true }); const first = await f.begin('discover_papers', { objective: 'enzyme', queries: ['enzyme'] }); assert.equal(first.needs_login, true);
  const stored = JSON.parse(await f.filesystem.readText(`.biodesign/literature-jobs/${first.job_id}.json`)); assert.equal(stored.position, 0); assert.equal(stored.status, 'needs_login');
  f.setLogin(false); const resumed = await f.service.run({ ...f.policy, action: 'resume', job_id: first.job_id }); assert(resumed.observation.includes(paper.title));
  await assert.rejects(f.service.run({ ...f.policy, model: 'other', action: 'resume', job_id: first.job_id }), { code: 'JOB_BINDING_CHANGED' });
  await f.service.cancel(first.job_id); f.service.jobs.clear(); assert.equal((await f.service.load(first.job_id)).status, 'cancelled');
});
test('empty explicit local scope does not broaden to all workspace documents', async t => {
  const f = await fixture(t); await f.filesystem.writeBinary('literature/existing.pdf', bytes);
  const job = await f.begin('retrieve_papers', { papers: [paper], accepted_versions: ['published'] }, { scopePaths: [] });
  const result = await f.service.run({ ...f.policy, scopePaths: [], action: 'step', job_id: job.job_id, name: 'retrieve_next', args: { index: 0 } });
  assert.equal(result.result.status, 'downloaded');
});
test('HTML masquerading as a PDF and malformed PDF are rejected; cited DOI alone is insufficient', async () => {
  await assert.rejects(verifyPaper(Buffer.from('<html>login</html>'), paper, ['published'], { parse }), { code: 'INVALID_PDF' });
  await assert.rejects(verifyPaper(bytes, paper, ['published']), { code: 'PDF_PARSE_FAILED' });
  const receipt = await verifyPaper(bytes, paper, ['unknown'], { parse: async () => ({ pages: 1, text: 'Other title References 10.1234/enzyme' }) }); assert.equal(receipt.identity, 'unverified');
});
test('browser owner excludes competing workers and rejects stale refs', async () => {
  const browser = new PlaywrightMcpClient({ profileRoot: '/unused' });
  await browser.exclusive('first', async () => {}); await assert.rejects(browser.exclusive('second', async () => {}), { code: 'BROWSER_BUSY' });
  await assert.rejects(browser.locator('e1'), { code: 'STALE_REFERENCE' }); browser.release('first'); await browser.exclusive('second', async () => {});
  assert(!redactBrowserText('https://example.org/paper?access_token=secret password=secret').includes('secret'));
});
test('skipped browser typing preserves feedback without recording searches or successful navigation', async t => {
  const f = await fixture(t);
  f.browser.tools.push({ name: 'browser_type', inputSchema: { type: 'object', properties: { target: referenceSchema(), text: { type: 'string' } } } });
  const started = await f.begin('discover_papers', { objective: 'enzyme', queries: ['enzyme'] });
  assert.match(started.tools.find(tool => tool.function.name === 'browser_type').function.parameters.properties.target.description, /\[ref=e45\] means target: "e45"/);
  const job = f.service.jobs.get(started.job_id), navigations = job.navigations;
  for (const status of ['invalid_reference', 'stale_reference']) {
    f.browser.call = async () => skippedReference(status, status === 'stale_reference' ? { status: 'observed', snapshot: 'Refreshed evidence [ref=e2]' } : {});
    const response = await f.step(job.id, 'browser_type', { target: 'e999', text: 'unexecuted query' });
    assert.equal(response.result.status, status); assert.equal(response.result.action_skipped, true);
    assert.deepEqual(job.searches, []); assert.equal(job.navigations, navigations);
  }
  assert.match(job.observations, /Refreshed evidence/);
  const saved = JSON.parse(await f.filesystem.readText(`.biodesign/literature-jobs/${job.id}.json`));
  assert.deepEqual(saved.searches, []); assert.equal(saved.navigations, navigations);
  f.browser.call = async () => ({ status: 'observed', snapshot: 'Search completed' });
  await f.step(job.id, 'browser_type', { target: 'e2', text: 'executed query' });
  assert.equal(job.searches.length, 1); assert.equal(job.searches[0].query, 'executed query');
  assert.equal(job.navigations, navigations + 1);
  f.browser.call = async () => skippedReference('needs_login', { status: 'needs_login' });
  const login = await f.step(job.id, 'browser_type', { target: 'e2', text: 'not entered' });
  assert.equal(login.needs_login, true); assert.equal(login.action_skipped, true);
  assert.equal(job.searches.length, 1); assert.equal(job.navigations, navigations + 1);
});
test('retrieval offers browser capture only after library browsing starts', async t => {
  const f = await fixture(t), started = await f.begin();
  assert(!started.tools.some(tool => ['capture_article', 'record_access', 'browser_snapshot'].includes(tool.function.name)));
  assert.equal(started.access.deterministic, true); assert.equal(started.access.library_browsing, true);
  assert.equal((await f.step(started.job_id, 'capture_article', { index: 0, target: 'e1' })).error, 'SPECIALIST_TOOL_NOT_ALLOWED');
  const browsing = await f.step(started.job_id, 'start_browsing');
  assert(browsing.tools.some(tool => tool.function.name === 'capture_article')); assert.equal(browsing.access.browsing, true);
  const offline = await fixture(t), job = await offline.begin('retrieve_papers', { papers: [paper], accepted_versions: ['published'] }, { libraryAccess: { url: '' } });
  assert.deepEqual((await offline.step(job.job_id, 'start_browsing')).result, { browsing: false, reason: 'NO_LIBRARY_URL' });
});
test('capture normalizes before contract validation, preserves skipped feedback and only verifies executed transfers', async t => {
  const f = await fixture(t), begun = await f.begin(), job = f.service.jobs.get(begun.job_id);
  const started = await f.step(job.id, 'start_browsing');
  const definition = started.tools.find(tool => tool.function.name === 'capture_article').function.parameters;
  assert.match(definition.properties.target.description, /\[ref=e45\] means target: "e45"/);
  contract.validate(definition, { index: 0, target: ' [ref=f1e45] ' });
  const seen = [];
  f.browser.captureArticle = async (_id, target) => { seen.push(target); return skippedReference('stale_reference', { status: 'observed', snapshot: 'Updated article [ref=e2]' }); };
  const malformed = await f.step(job.id, 'capture_article', { index: 0, target: 'click [ref=e45]' });
  assert.equal(malformed.result.status, 'invalid_reference'); assert.deepEqual(seen, []);
  const stale = await f.step(job.id, 'capture_article', { index: 0, target: ' \n[ref=f1e45]\t' });
  assert.deepEqual(seen, ['f1e45']); assert.equal(stale.result.status, 'stale_reference');
  assert.equal(stale.result.action_skipped, true); assert.equal(job.downloads, 0);
  assert.equal(job.results[0], undefined); assert.match(job.observations, /Updated article/);
  f.browser.captureArticle = async (_id, target) => { seen.push(target); return { bytes, contentType: 'application/pdf', resolvedUrl: paper.source_urls[0] }; };
  const success = await f.step(job.id, 'capture_article', { index: 0, target: '[ref=e2]' });
  assert.deepEqual(seen, ['f1e45', 'e2']); assert.equal(job.downloads, 1);
  assert.equal(success.result.status, 'downloaded'); assert.equal(success.result.verification.identity, 'doi');
  assert.match(success.result.verification.sha256, /^[a-f0-9]{64}$/);
});
test('capture login feedback pauses retrieval without counting a download', async t => {
  const f = await fixture(t), started = await f.begin(), job = f.service.jobs.get(started.job_id);
  await f.step(job.id, 'start_browsing');
  f.browser.captureArticle = async () => skippedReference('stale_reference', { status: 'needs_login' });
  const result = await f.step(job.id, 'capture_article', { index: 0, target: '[ref=e45]' });
  assert.equal(result.needs_login, true); assert.equal(job.status, 'needs_login');
  assert.equal(result.action_skipped, true);
  assert.equal(job.downloads, 0); assert.equal(job.results[0].status, 'needs_login');
  assert.match(job.results[0].reason, /action was skipped/);
});
test('skipped-action receipts replay diagnostic evidence without re-executing or recording success', async t => {
  const f = await fixture(t);
  f.browser.tools.push({ name: 'browser_type', inputSchema: { type: 'object', properties: { target: referenceSchema(), text: { type: 'string' } } } });
  const started = await f.begin('discover_papers', { objective: 'enzyme', queries: ['enzyme'] });
  const job = f.service.jobs.get(started.job_id), navigations = job.navigations;
  let calls = 0;
  const diagnostics = { reason: 'target_document_navigated', snapshot_id: 3, page_id: 1, frame_id: 2, documents: [{ frame_id: 2, document_version: 1 }] };
  f.browser.call = async () => { calls++; return skippedReference('stale_reference', { status: 'observed', snapshot: 'Articles+ [ref=e45]', snapshot_metadata: { snapshot_id: 4 } }, diagnostics); };
  const input = { ...f.policy, action: 'step', job_id: job.id, name: 'browser_type', args: { target: '[ref=e45]', text: 'skipped query' }, execution_id: 'literature_' + 'c'.repeat(16) };
  const first = await f.service.run(input), replay = await f.service.run(input);
  assert.deepEqual(replay, first); assert.deepEqual(replay.result.diagnostics, diagnostics);
  assert.equal(calls, 1); assert.deepEqual(job.searches, []); assert.equal(job.navigations, navigations);
  assert.equal(job.downloads, 0); assert.match(job.observations, /Articles\+/);
});
test('dedup preserves original multilingual titles and normalizes DOI identities', () => {
  const a = { identity: { ...paper, title: '酶工程研究', doi: 'https://doi.org/10.1234/ENZYME' }, provenance: ['https://a.org/'] };
  const b = { identity: paper, provenance: ['https://b.org/'] };
  const found = contract.deduplicate([a, b]); assert.equal(found.length, 1); assert.equal(found[0].identity.title, '酶工程研究');
});

test('declining a required library choice disables browsing and marks, not omits, records without open-access evidence', async t => {
  const f = await fixture(t); const task = { objective: 'Enzymes', queries: ['enzyme'], library_url: 'https://model.example/library' };
  await assert.rejects(f.begin('discover_papers', task, { libraryAccess: undefined }), { code: 'LIBRARY_CHOICE_REQUIRED' });
  await assert.rejects(f.begin('discover_papers', task, { libraryAccess: { url: 'javascript:alert(1)' } }), { code: 'INVALID_LIBRARY_URL' });
  let starts = 0; f.browser.start = async () => { starts++; };
  f.active.paperMcp.call = async (_name, args) => {
    assert.equal(args.prefer_open_access, true);
    return { papers: [true, false].map((oa, i) => ({ ...paper, paper_ref: 'paper_' + String(i).repeat(24), access: [{ is_open_access: oa }] })) };
  };
  const job = await f.begin('discover_papers', task, { libraryAccess: { url: '' } });
  assert.equal(starts, 0); assert.equal(job.access.open_access_only, true);
  assert(!job.tools.some(tool => tool.function.name.startsWith('browser_')));
  const found = (await f.step(job.job_id, 'search_academic_papers', { query: 'enzyme' })).result.papers;
  assert.deepEqual(found.map(item => item.open_access_evidence), [true, false]);
  assert.equal((await f.step(job.job_id, 'browser_snapshot')).error, 'SPECIALIST_TOOL_NOT_ALLOWED');
  f.service.jobs.clear();
  const resumed = await f.service.run({ ...f.policy, action: 'resume', job_id: job.job_id });
  assert.equal(resumed.access.open_access_only, true); assert.equal(starts, 0);
});

test('the user library URL overrides a model-suggested URL and survives resume', async t => {
  const f = await fixture(t); const urls = [];
  f.browser.call = async (_id, _name, args) => { urls.push(args.url); return { status: 'observed', snapshot: '' }; };
  const job = await f.begin('discover_papers', { objective: 'Enzymes', queries: ['enzyme'], library_url: 'https://model.example/library' });
  assert.equal(urls[0], f.policy.libraryAccess.url);
  f.service.jobs.clear(); await f.service.run({ ...f.policy, action: 'resume', job_id: job.job_id });
  assert.equal(urls[1], urls[0]);
});

test('download authorization distinguishes requests from reports, mentions and explicit refusals', () => {
  for (const request of ['Download the selected papers.', 'Find enzyme studies and download relevant PDFs.', 'Please save these papers.', '请下载这些论文', '帮我把论文下载到本地']) assert.equal(contract.downloadAuthorized(request), true, request);
  for (const request of ['Write a report about enzyme engineering.', 'Explain how to download papers.', "Find papers but don't download them.", 'Do not save papers.', 'No downloads, please.', '请不要下载论文', '请把论文列出来，不要下载']) assert.equal(contract.downloadAuthorized(request), false, request);
});

test('replayed host handoffs reuse receipts and reject changed execution arguments', async t => {
  const f = await fixture(t);
  const input = { ...f.policy, action: 'begin', kind: 'retrieve_papers', task: { papers: [paper], accepted_versions: ['published'] }, execution_id: 'literature_0123456789abcdef' };
  const first = await f.service.run(input);
  const repeated = await f.service.run(input);
  assert.equal(repeated.job_id, first.job_id);
  assert.equal(f.service.jobs.size, 1);
  await assert.rejects(f.service.run({ ...input, model: 'changed/model' }), { code: 'EXECUTION_BINDING_CHANGED' });
  let transfers = 0;
  f.service.dependencies.fetchSource = async url => { transfers++; return { bytes, contentType: 'application/pdf', resolvedUrl: url }; };
  const step = { ...f.policy, action: 'step', job_id: first.job_id, name: 'retrieve_next', args: { index: 0 }, execution_id: 'literature_fedcba9876543210' };
  const saved = await f.service.run(step);
  assert.equal((await f.service.run(step)).result.file, saved.result.file);
  assert.equal(transfers, 1);
});

test('discovery handoff preserves all arguments without schema validation, filtering or candidate limits', async t => {
  const f = await fixture(t), first = await f.begin('discover_papers', { objective: 'enzyme', queries: ['enzyme'], limit: 1 });
  const job = f.service.jobs.get(first.job_id);
  Object.assign(job, { calls: 100, elapsed: 24 * 60 * 60000, navigations: 100, downloads: 100 });
  const args = { candidates: Array.from({ length: 75 }, (_, index) => ({ title: `文献 ${index}`, url: `https://example.org/paper?id=${index}` })),
    notes: 'Missing identity, provenance, availability and limitations intentionally.', extra: { original: true } };
  const input = { ...f.policy, action: 'step', job_id: job.id, name: 'finish_discovery', args, execution_id: 'literature_' + 'a'.repeat(16) };
  const result = await f.service.run(input);
  assert.deepEqual(result.final.discoveryArguments, args); assert.equal(job.status, 'completed');
  assert.equal(f.browser.owner, null);
  const checkpoint = JSON.parse(await f.filesystem.readText(`.biodesign/literature-jobs/${job.id}.json`));
  assert.deepEqual(checkpoint.discoveryArguments, args);
  assert.deepEqual(await f.service.run(input), result);
  f.service.jobs.clear(); assert.deepEqual(f.service.result(await f.service.load(job.id)).discoveryArguments, args);
});

test('discovery handoff ignores malformed upstream metadata and does not alter previous evidence', async t => {
  const f = await fixture(t), first = await f.begin('discover_papers', { objective: 'enzyme', queries: ['enzyme'] });
  const job = f.service.jobs.get(first.job_id);
  const candidate = { identity: paper, rationale: 'Relevant enzyme study', availability: 'unknown', evidence: 'metadata', provenance: paper.source_urls };
  job.candidates = [candidate];
  job.known.push({ ...paper, authors: null, paper_ref: 'paper_' + 'a'.repeat(24), locations: [] });
  const previous = JSON.stringify(job.candidates);
  const args = { candidates: [candidate], limitations: [] };
  const result = await f.step(job.id, 'finish_discovery', args);
  assert.deepEqual(result.final.discoveryArguments, args);
  assert.equal(job.status, 'completed'); assert.equal(JSON.stringify(job.candidates), previous);
});
