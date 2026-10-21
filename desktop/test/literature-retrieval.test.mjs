import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectFilesystem } from '../services/project-filesystem.mjs';
import { LiteratureWorkflows } from '../services/literature-workflows.mjs';

const pdf = title => Buffer.from(`%PDF-1.7\n${title}`);
const papers = [
  { title: 'Open enzyme engineering atlas', authors: ['Alice Smith'], year: 2024, doi: '10.1000/open', source_urls: [] },
  { title: 'Closed protein design benchmark', authors: ['Bob Jones'], year: 2023, doi: '10.1000/closed', source_urls: [] },
];
// The fixture PDF text is its title; identity checks use the requested metadata.
const parse = async bytes => {
  const title = bytes.toString().split('\n')[1];
  const paper = papers.find(item => item.title === title) || { title, authors: [], year: 0, doi: '' };
  return { pages: 8, text: `${paper.title} ${paper.authors.join(' ')} ${paper.year} doi:${paper.doi}`, firstPage: `${paper.title} doi:${paper.doi}`, metadata: '' };
};

async function fixture(t, { library = { url: 'https://library.example.edu', proxy: 'https://ezproxy.example.edu/login?url=' }, browserScript = {}, lookups = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'literature-retrieval-')); t.after(() => rm(root, { recursive: true, force: true }));
  const filesystem = await ProjectFilesystem.open(root);
  const captures = [], waits = [];
  const browser = {
    tools: [{ name: 'browser_snapshot', description: 'Observe', inputSchema: { type: 'object', properties: {} } }], owner: null,
    async exclusive(id, fn) { if (this.owner && this.owner !== id) throw Object.assign(new Error(), { code: 'BROWSER_BUSY' }); this.owner = id; return fn(); },
    async start() {}, release(id) { if (this.owner === id) this.owner = null; }, async close() {}, async useProfile() {},
    async call() { return { status: 'observed', snapshot: 'Library home [ref=e1]' }; },
    async fetchArticle(owner, target) {
      this.owner = owner; captures.push(target);
      const step = browserScript[target.url]; const outcome = typeof step === 'function' ? step(captures.filter(item => item.url === target.url).length) : step;
      return outcome || { status: 'unresolved', reason: 'no_pdf_link', action_skipped: true };
    },
    async awaitAttention(owner, { signal }) { waits.push(owner); return signal.aborted ? { cleared: false } : { cleared: true }; },
  };
  const active = { filesystem, sourceDownloads: new AbortController(), paperMcp: { async start() { throw new Error('No provider in this fixture'); } } };
  const service = new LiteratureWorkflows(active, browser, () => true, { parse, wait: async () => {},
    lookup: async paper => ({ doi: paper.doi, ids: {}, diagnostics: [], candidates: lookups[paper.doi]?.candidates || [], publisherUrl: lookups[paper.doi]?.publisherUrl || '' }),
    fetchSource: async url => {
      if (url.includes('/oa/')) return { bytes: pdf(papers.find(item => url.includes(item.doi.split('/')[1])).title), contentType: 'application/pdf', resolvedUrl: url };
      throw Object.assign(new Error('Forbidden'), { code: 'HTTP_ERROR', httpStatus: 403 });
    } });
  const policy = { model: 'selected/model', permission: 'workspace_write', authorization: { download: true }, scopePaths: null };
  const begin = (task = { papers, accepted_versions: ['published'] }) => service.run({ ...policy, action: 'begin', kind: 'retrieve_papers', task, libraryAccess: library, browserProfile: 'a'.repeat(24) });
  const step = (job_id, name, args = {}) => service.run({ ...policy, action: 'step', job_id, name, args });
  const run = (job_id, action) => service.run({ ...policy, action, job_id });
  return { service, browser, captures, waits, begin, step, run, filesystem };
}
const lookups = {
  '10.1000/open': { candidates: [{ url: 'https://repository.example.org/oa/open.pdf', route: 'open_access_location', version: 'published', kind: 'pdf' }] },
  '10.1000/closed': { publisherUrl: 'https://publisher.example.org/article/closed' },
};

test('an open copy downloads without the browser; a publisher-only paper downloads in the library browser through the proxy', async t => {
  const f = await fixture(t, { lookups, browserScript: { 'https://publisher.example.org/article/closed': { bytes: pdf(papers[1].title), contentType: 'application/pdf', resolvedUrl: 'https://publisher.example.org/article/closed.pdf' } } });
  const job = await f.begin();
  assert.equal(job.access.deterministic, true); assert.equal(job.access.library_browsing, true);
  const open = (await f.step(job.job_id, 'retrieve_next', { index: 0 })).result;
  assert.deepEqual([open.status, open.route, open.document_version], ['downloaded', 'open_access', 'published']);
  assert.equal(f.captures.length, 0);
  const closed = (await f.step(job.job_id, 'retrieve_next', { index: 1 })).result;
  assert.deepEqual([closed.status, closed.route, closed.document_version], ['downloaded', 'institutional', 'published']);
  assert.equal(closed.verification.version_basis, 'source');
  assert.deepEqual(f.captures.map(item => [item.url, item.proxyPrefix, item.doi]), [['https://publisher.example.org/article/closed', 'https://ezproxy.example.edu/login?url=', '10.1000/closed']]);
  const final = (await f.step(job.job_id, 'finish_retrieval')).final;
  assert.equal(final.status, 'completed'); assert.equal((await f.filesystem.list('literature')).length, 2);
});

test('sign-ins and human checks are deferred, requested once for all papers, and retried after the user acts', async t => {
  const f = await fixture(t, { lookups: { '10.1000/open': { publisherUrl: 'https://sso-publisher.example.org/article/open' }, '10.1000/closed': lookups['10.1000/closed'] }, browserScript: {
    'https://sso-publisher.example.org/article/open': attempt => attempt === 1 ? { status: 'needs_login', reason: 'sign_in', site: 'sso-publisher.example.org', action_skipped: true } : { bytes: pdf(papers[0].title), contentType: 'application/pdf', resolvedUrl: 'https://sso-publisher.example.org/open.pdf' },
    'https://publisher.example.org/article/closed': attempt => attempt === 1 ? { status: 'needs_attention', reason: 'challenge', site: 'publisher.example.org', action_skipped: true } : { bytes: pdf(papers[1].title), contentType: 'application/pdf', resolvedUrl: 'https://publisher.example.org/closed.pdf' },
  } });
  const job = await f.begin();
  const first = (await f.step(job.job_id, 'retrieve_next', { index: 0 })).result;
  const second = (await f.step(job.job_id, 'retrieve_next', { index: 1 })).result;
  assert.deepEqual([first.status, second.status], ['needs_login', 'needs_login']);
  assert.match(first.reason, /Sign-in on sso-publisher\.example\.org/); assert.match(second.reason, /human check on publisher\.example\.org/);
  // Further calls before the user acts return the saved outcome without new browser work.
  assert.equal((await f.step(job.job_id, 'retrieve_next', { index: 0 })).result.status, 'needs_login'); assert.equal(f.captures.length, 2);
  const access = await f.step(job.job_id, 'request_access');
  // Both sites are named; each has its own waiting tab in the library browser.
  assert.equal(access.needs_login, true); assert.deepEqual(access.attention, { kind: 'mixed', site: 'sso-publisher.example.org', sites: ['sso-publisher.example.org', 'publisher.example.org'], papers: 2, round: 1 });
  assert.equal(access.final.status, 'needs_login');
  assert.deepEqual(await f.run(job.job_id, 'await_attention'), { cleared: true }); assert.deepEqual(f.waits, [job.job_id]);
  const resumed = await f.run(job.job_id, 'resume');
  assert.equal(resumed.resumed, true); assert(resumed.tools.some(tool => tool.function.name === 'retrieve_next'));
  assert.equal((await f.step(job.job_id, 'retrieve_next', { index: 0 })).result.status, 'downloaded');
  assert.equal((await f.step(job.job_id, 'retrieve_next', { index: 1 })).result.status, 'downloaded');
  assert.deepEqual((await f.step(job.job_id, 'request_access')).result, { requested: 0, remaining: 0 });
  assert.equal((await f.step(job.job_id, 'finish_retrieval')).final.status, 'completed');
});

test('without library access a sign-in page leaves the paper unresolved, but a human check is still offered', async t => {
  const f = await fixture(t, { library: { url: '' }, lookups: { '10.1000/open': { publisherUrl: 'https://sso-publisher.example.org/article/open' }, '10.1000/closed': lookups['10.1000/closed'] }, browserScript: {
    'https://sso-publisher.example.org/article/open': { status: 'needs_login', reason: 'sign_in', action_skipped: true },
    'https://publisher.example.org/article/closed': { status: 'needs_attention', reason: 'challenge', action_skipped: true },
  } });
  const job = await f.begin();
  assert.equal(job.access.open_access_only, true); assert.equal(job.access.library_browsing, false);
  const signIn = (await f.step(job.job_id, 'retrieve_next', { index: 0 })).result;
  assert.equal(signIn.status, 'unresolved'); assert.match(signIn.reason, /no library access is configured/);
  assert.equal(f.captures[0].proxyPrefix, '');
  assert.equal((await f.step(job.job_id, 'retrieve_next', { index: 1 })).result.status, 'needs_login');
  assert.equal((await f.step(job.job_id, 'request_access')).attention.kind, 'challenge');
  await f.run(job.job_id, 'resume');
  assert.deepEqual((await f.step(job.job_id, 'start_browsing')).result, { browsing: false, reason: 'NO_LIBRARY_URL' });
});

test('access requests are bounded; remaining papers keep an honest needs_login outcome', async t => {
  const f = await fixture(t, { lookups: { '10.1000/closed': lookups['10.1000/closed'] }, browserScript: {
    'https://publisher.example.org/article/closed': { status: 'needs_login', reason: 'sign_in', action_skipped: true } } });
  const job = await f.begin({ papers: [papers[1]], accepted_versions: ['published'] });
  assert.equal((await f.step(job.job_id, 'retrieve_next', { index: 0 })).result.status, 'needs_login');
  for (let round = 1; round <= 3; round++) {
    assert.equal((await f.step(job.job_id, 'request_access')).attention.round, round);
    await f.run(job.job_id, 'resume');
    assert.equal((await f.step(job.job_id, 'retrieve_next', { index: 0 })).result.status, 'needs_login');
  }
  assert.deepEqual((await f.step(job.job_id, 'request_access')).result, { requested: 0, remaining: 1 });
  const final = (await f.step(job.job_id, 'finish_retrieval')).final;
  assert.equal(final.status, 'partial'); assert.equal(final.results[0].status, 'needs_login');
  assert.equal(f.captures.length, 4);
});

test('existing local PDFs are parsed once per job and matched against every requested paper', async t => {
  let parses = 0;
  const f = await fixture(t);
  f.service.dependencies.parse = async bytes => { parses++; return parse(bytes); };
  await f.filesystem.writeBinary('literature/a.pdf', pdf(papers[0].title));
  await f.filesystem.writeBinary('literature/b.pdf', pdf(papers[1].title));
  const job = await f.begin();
  assert.equal((await f.step(job.job_id, 'retrieve_next', { index: 0 })).result.status, 'already_present');
  assert.equal((await f.step(job.job_id, 'retrieve_next', { index: 1 })).result.status, 'already_present');
  assert.equal(parses, 2); assert.equal(f.captures.length, 0);
});

test('a site already waiting for the user is not visited again for later papers in the same round', async t => {
  const f = await fixture(t, { lookups: { '10.1000/open': { publisherUrl: 'https://publisher.example.org/article/open' }, '10.1000/closed': lookups['10.1000/closed'] }, browserScript: {
    'https://publisher.example.org/article/open': { status: 'needs_attention', reason: 'challenge', site: 'publisher.example.org', action_skipped: true },
    'https://publisher.example.org/article/closed': attempt => ({ bytes: pdf(papers[1].title), contentType: 'application/pdf', resolvedUrl: `https://publisher.example.org/closed-${attempt}.pdf` }),
  } });
  const job = await f.begin();
  assert.equal((await f.step(job.job_id, 'retrieve_next', { index: 0 })).result.status, 'needs_login');
  const second = (await f.step(job.job_id, 'retrieve_next', { index: 1 })).result;
  assert.equal(second.status, 'needs_login'); assert.match(second.attempts.at(-1).reason, /waiting_for_challenge/);
  assert.equal(f.captures.length, 1);
  // After the user's access round both papers are tried again.
  assert.equal((await f.step(job.job_id, 'request_access')).attention.papers, 2);
  await f.run(job.job_id, 'resume');
  assert.equal((await f.step(job.job_id, 'retrieve_next', { index: 1 })).result.status, 'downloaded');
  assert.equal(f.captures.length, 2);
});

test('a resumed job keeps its exact library proxy prefix and browser targets', async t => {
  const target = 'https://publisher.example.org/article/closed?version=vor';
  const f = await fixture(t, { lookups: { '10.1000/closed': { publisherUrl: target } }, browserScript: {
    [target]: attempt => attempt === 1 ? { status: 'needs_login', reason: 'sign_in', site: 'publisher.example.org', action_skipped: true }
      : { bytes: pdf(papers[1].title), contentType: 'application/pdf', resolvedUrl: 'https://publisher.example.org/closed.pdf' } } });
  const job = await f.begin({ papers: [papers[1]], accepted_versions: ['published'] });
  assert.equal((await f.step(job.job_id, 'retrieve_next', { index: 0 })).result.status, 'needs_login');
  await f.step(job.job_id, 'request_access');
  // An application restart: the job is read back from the project file.
  f.service.jobs.clear();
  await f.run(job.job_id, 'resume');
  assert.equal((await f.step(job.job_id, 'retrieve_next', { index: 0 })).result.status, 'downloaded');
  assert.deepEqual(f.captures.map(item => [item.url, item.proxyPrefix]), [[target, 'https://ezproxy.example.edu/login?url='], [target, 'https://ezproxy.example.edu/login?url=']]);
});

test('with a proxy, one university sign-in holds every proxied paper until the user signs in', async t => {
  const second = { ...papers[0], doi: '10.1000/second', title: 'Second closed paper on enzyme kinetics' };
  const f = await fixture(t, { lookups: { '10.1000/closed': lookups['10.1000/closed'], '10.1000/second': { publisherUrl: 'https://other-publisher.example.org/article/second' } }, browserScript: {
    'https://publisher.example.org/article/closed': { status: 'needs_login', reason: 'sign_in', site: 'login.university.example.edu', action_skipped: true },
    'https://other-publisher.example.org/article/second': { status: 'needs_login', reason: 'sign_in', site: 'login.university.example.edu', action_skipped: true } } });
  const job = await f.begin({ papers: [papers[1], second], accepted_versions: ['published'] });
  assert.equal((await f.step(job.job_id, 'retrieve_next', { index: 0 })).result.status, 'needs_login');
  const waiting = (await f.step(job.job_id, 'retrieve_next', { index: 1 })).result;
  assert.equal(waiting.status, 'needs_login'); assert.match(waiting.reason, /login\.university\.example\.edu/);
  assert.equal(f.captures.length, 1, 'the second publisher is not opened while the proxy waits for sign-in');
  assert.deepEqual((await f.step(job.job_id, 'request_access')).attention.sites, ['login.university.example.edu']);
});
