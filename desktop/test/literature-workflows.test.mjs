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

const paper = { title: 'Multilingual enzyme engineering', authors: ['Alice Smith'], year: 2024, doi: '10.1234/enzyme', source_urls: ['https://example.org/paper.pdf'] };
const bytes = Buffer.from('%PDF-1.7\nfixture');
const parse = async () => ({ pages: 2, text: `${paper.title} Alice Smith 2024 DOI: 10.1234/enzyme Version of Record` });
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'literature-jobs-')); t.after(() => rm(root, { recursive: true, force: true }));
  const filesystem = await ProjectFilesystem.open(root);
  let login = options.login || false;
  const browser = { tools: [{ name: 'browser_snapshot', description: 'Observe', inputSchema: { type: 'object', properties: {} } }], owner: null, async exclusive(id, fn) { if (this.owner && this.owner !== id) throw Object.assign(new Error(), { code: 'BROWSER_BUSY' }); this.owner = id; return fn(); }, async start() {}, async call() { return login ? { status: 'needs_login' } : { status: 'observed', snapshot: paper.title }; }, release(id) { if (this.owner === id) this.owner = null; }, async close() {}, async captureArticle() { return { bytes, resolvedUrl: paper.source_urls[0], contentType: 'application/pdf' }; } };
  const active = { filesystem, sourceDownloads: new AbortController(), paperMcp: { async start() {}, tools: academic.tools.filter(t => !academic.isWrite(t.function.name)).map(t => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters })), async call() { return { version: 1, status: 'completed', papers: [] }; } } };
  const service = new LiteratureWorkflows(active, browser, () => true, { parse, fetchSource: async url => ({ bytes, contentType: 'application/pdf', resolvedUrl: url }), ...options.dependencies });
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
  const f = await fixture(t, { login: true }); const first = await f.begin(); assert.equal(first.needs_login, true);
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
test('dedup preserves original multilingual titles and normalizes DOI identities', () => {
  const a = { identity: { ...paper, title: '酶工程研究', doi: 'https://doi.org/10.1234/ENZYME' }, provenance: ['https://a.org/'] };
  const b = { identity: paper, provenance: ['https://b.org/'] };
  const found = contract.deduplicate([a, b]); assert.equal(found.length, 1); assert.equal(found[0].identity.title, '酶工程研究');
});

test('declining a required library choice disables browsing and limits discovery to open-access records', async t => {
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
  assert.equal((await f.step(job.job_id, 'search_academic_papers', { query: 'enzyme' })).result.papers.length, 1);
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
