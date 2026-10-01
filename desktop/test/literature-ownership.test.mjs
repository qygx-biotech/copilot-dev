import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProjectFilesystem } from '../services/project-filesystem.mjs';
import { LiteratureWorkflows } from '../services/literature-workflows.mjs';
import { browserFixture } from './helpers/literature-browser-fixture.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ownership-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filesystem = await ProjectFilesystem.open(root), browser = browserFixture(t, root);
  let paperCalls = 0;
  const active = { filesystem, sourceDownloads: new AbortController(), paperMcp: { tools: [], async start() {}, async call() { paperCalls++; } } };
  const host = new LiteratureWorkflows(active, browser.browser, () => true);
  const policy = { model: 'selected/model', permission: 'workspace_write', scopePaths: null, authorization: { download: false } };
  const begin = () => host.run({ ...policy, action: 'begin', kind: 'discover_papers', task: { objective: 'Search only the university library', queries: ['enzyme'] }, libraryAccess: { url: 'https://example.org/library' } });
  const act = (id, action, extra = {}) => host.run({ ...policy, action, job_id: id, ...extra });
  return { ...browser, host, filesystem, active, begin, act, paperCalls: () => paperCalls };
}
test('closing the last window releases ownership; a new job can start; saved job resumes with fresh observations', async t => {
  const f = await fixture(t), first = await f.begin(), job = f.host.jobs.get(first.job_id);
  job.searches.push({ query: 'enzyme', source: 'library' });
  const oldContext = f.contexts[0]; await oldContext.pages()[0].close(); await f.browser.closing;
  assert.equal(f.browser.owner, null); assert.equal(job.status, 'blocked');
  assert.equal(job.lastError.code, 'BROWSER_CLOSED'); assert.equal(job.searches.length, 1);
  const second = await f.begin(); assert.equal(f.browser.owner, second.job_id);
  // A delayed old context/disconnect event must not steal the new lock.
  oldContext.emit('close'); oldContext.browser().emit('disconnected');
  assert.equal(f.browser.owner, second.job_id);
  await f.act(second.job_id, 'suspend'); assert.equal(f.browser.owner, null);
  const resumed = await f.act(first.job_id, 'resume');
  assert.equal(f.browser.owner, first.job_id); assert.match(resumed.observation, /Observed enzyme 3/);
  assert.equal(job.searches.length, 1); assert.equal(job.status, 'running');
});
test('competing active jobs are explicitly blocked without academic fallback or clearing the owner', async t => {
  const f = await fixture(t), first = await f.begin();
  const second = await f.begin();
  assert.equal(second.blocked, true); assert.equal(second.error, 'BROWSER_BUSY');
  assert.equal(second.diagnostics.ownerId, first.job_id); assert.equal(second.tools, undefined);
  assert.equal(f.browser.owner, first.job_id); assert.equal(f.paperCalls(), 0);
  const blocked = f.host.jobs.get(second.job_id);
  assert.equal(blocked.status, 'blocked'); assert(!blocked.limitations.some(text => /paper MCP remains/.test(text)));
  await f.act(second.job_id, 'suspend'); assert.equal(f.browser.owner, first.job_id);
  const step = await f.act(first.job_id, 'step', { name: 'browser_snapshot', args: {} }); assert.equal(step.result.status, 'observed');
  await f.act(first.job_id, 'cancel'); assert.equal(f.browser.owner, null);
  const resumed = await f.act(second.job_id, 'resume'); assert(resumed.tools.some(tool => tool.function.name === 'browser_snapshot'));
});
test('provider/transport failure cleanup between handoffs releases the browser and preserves the journal', async t => {
  const f = await fixture(t), first = await f.begin(), job = f.host.jobs.get(first.job_id);
  job.known.push({ title: 'Retained evidence' });
  await f.act(first.job_id, 'suspend');
  assert.equal(f.browser.owner, null); assert.equal(job.status, 'failed');
  const saved = JSON.parse(await f.filesystem.readText(`.biodesign/literature-jobs/${job.id}.json`));
  assert.equal(saved.known[0].title, 'Retained evidence');
  const second = await f.begin(); assert.equal(f.browser.owner, second.job_id);
  await f.act(second.job_id, 'cancel');
  await f.act(first.job_id, 'resume'); assert.equal(f.browser.owner, first.job_id);
});
test('workspace cancellation between handoffs releases idle browser ownership', async t => {
  const f = await fixture(t), first = await f.begin();
  f.active.sourceDownloads.abort();
  // cancel loads the journal asynchronously before releasing the owner.
  await new Promise(resolve => setImmediate(resolve)); await f.browser.closing;
  assert.equal(f.browser.owner, null); assert.equal(f.host.jobs.get(first.job_id).status, 'cancelled');
});
test('a terminal MCP exception retains its original diagnostic and releases only its own browser', async t => {
  const f = await fixture(t), first = await f.begin();
  t.mock.method(f.browser.client, 'callTool', async () => { throw new Error('Chrome transport disconnected unexpectedly'); });
  const result = await f.act(first.job_id, 'step', { name: 'browser_snapshot', args: {} });
  assert.equal(result.blocked, true); assert.equal(result.error, 'BROWSER_OPERATION_FAILED');
  assert.match(result.diagnostics.message, /Chrome transport disconnected unexpectedly/);
  assert.equal(f.browser.owner, null);
  assert((await f.begin()).tools);
});
test('browser launch failure preserves the original cause and blocks library execution', async t => {
  const f = await fixture(t), launch = f.browser.launch;
  f.browser.launch = async () => { throw Object.assign(new Error('Chrome profile directory is not writable'), { code: 'EACCES' }); };
  const failed = await f.begin();
  assert.equal(failed.blocked, true); assert.equal(failed.error, 'BROWSER_UNAVAILABLE');
  assert.match(failed.diagnostics.message, /profile directory is not writable/); assert.equal(failed.diagnostics.causeCode, 'EACCES');
  assert.equal(f.browser.owner, null); assert.equal(failed.tools, undefined); assert.equal(f.paperCalls(), 0);
  f.browser.launch = launch;
  const resumed = await f.act(failed.job_id, 'resume'); assert(resumed.tools); assert.equal(f.browser.owner, failed.job_id);
});
test('cancellation during Chrome launch disposes the late context without leaving an owner', async t => {
  const f = await fixture(t), launch = f.browser.launch;
  let launched, allowLaunch;
  const started = new Promise(resolve => { launched = resolve; });
  const gate = new Promise(resolve => { allowLaunch = resolve; });
  f.browser.launch = async (...args) => { launched(); await gate; return launch(...args); };
  const pending = f.begin(); await started;
  const oldOwner = f.browser.owner; await f.act(oldOwner, 'cancel');
  allowLaunch(); await pending;
  assert.equal(f.browser.owner, null); assert.equal(f.browser.context, null);
  f.browser.launch = launch;
  const next = await f.begin(); assert(next.tools); assert.equal(f.browser.owner, next.job_id);
});
