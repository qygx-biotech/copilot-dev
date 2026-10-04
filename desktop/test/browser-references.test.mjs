import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceBrowserFixture } from './helpers/reference-browser-fixture.mjs';
import { PlaywrightMcpClient } from '../services/playwright-mcp-client.mjs';
import { normalizeSnapshotReference, referenceSchema } from '../services/browser-references.mjs';
import sourceFetch from '../../shared/source-fetch.js';

const equivalents = ['e45', '[ref=e45]', ' \te45\n', ' \n[ref=e45]\t', 'f1e45', '[ref=f1e45]', ' \tf1e45\n', ' \n[ref=f1e45]\t'];
const malformed = ['', ' ', '#e45', 'aria-ref=e45', '//button', 'button[ref=e45]', 'click e45', 'e45 please', '[ref=e45] extra', '[ref= e45]', '[ref=e45][ref=e46]', '[ref=latest_download]', 'E45', 'e45\ne46', null, 45, {}];

test('reference parser matches the whole input and limits the download sentinel to capture', () => {
  for (const value of equivalents) assert.equal(normalizeSnapshotReference(value), value.includes('f1') ? 'f1e45' : 'e45');
  for (const value of malformed) assert.equal(normalizeSnapshotReference(value), null);
  assert.equal(normalizeSnapshotReference('latest_download'), null);
  assert.equal(normalizeSnapshotReference(' latest_download ', { allowLatestDownload: true }), 'latest_download');
  assert.equal(normalizeSnapshotReference('[ref=latest_download]', { allowLatestDownload: true }), null);
});

test('bare, bracketed, whitespace and frame references normalize before validation and execute exactly once', async () => {
  for (const name of ['browser_click', 'browser_type', 'browser_select_option']) for (const target of equivalents) {
    const f = await referenceBrowserFixture(), args = { target, text: 'enzyme', values: ['paper'] };
    const result = await f.browser.call('job', name, args);
    const bare = target.includes('f1') ? 'f1e45' : 'e45';
    assert.equal(result.status, 'observed');
    assert.deepEqual(f.validated, [bare]);
    assert.deepEqual(f.actions.map(action => action.name), [({ browser_click: 'click', browser_type: 'fill', browser_select_option: 'selectOption' })[name]]);
    assert.equal(f.actions[0].ref, bare);
    assert.equal(f.page.snapshots, 1);
    assert.equal(args.target, target, 'caller input is not mutated');
    assert(f.lookups.every(selector => /^aria-ref=(?:f[0-9]+)?e[0-9]+$/.test(selector)));
  }
});

test('malformed and unknown references never execute or replay a browser action', async () => {
  for (const name of ['browser_click', 'browser_type', 'browser_select_option']) for (const target of [...malformed, 'latest_download', 'e999', '[ref=f2e999]']) {
    const f = await referenceBrowserFixture(), stale = ['e999', '[ref=f2e999]'].includes(target);
    const result = await f.browser.call('job', name, { target });
    assert.equal(result.status, stale ? 'stale_reference' : 'invalid_reference');
    assert.equal(result.action_skipped, true); assert.match(result.message, /action was skipped/);
    assert.deepEqual(f.actions, []);
    assert.equal(f.page.snapshots, stale ? 1 : 0);
    if (stale) assert.match(result.snapshot, /ref=e45/);
  }
});

test('references cannot cross owners, pages, or released sessions', async () => {
  const f = await referenceBrowserFixture();
  await assert.rejects(f.browser.call('other-job', 'browser_click', { target: '[ref=e45]' }), { code: 'BROWSER_BUSY' });
  assert.deepEqual(f.actions, []);
  f.browser.currentPage = f.addPage().page;
  assert.equal((await f.browser.call('job', 'browser_click', { target: 'e45' })).status, 'stale_reference');
  assert.deepEqual(f.actions, []);
  f.actions.length = 0;
  f.browser.release('job');
  assert.equal((await f.browser.call('new-job', 'browser_click', { target: 'e45' })).status, 'stale_reference');
  assert.deepEqual(f.actions, []);
});

test('normalized targets still honor login and sensitive-field safeguards', async () => {
  for (const type of ['password', 'email', 'tel']) {
    const f = await referenceBrowserFixture();
    f.elements.get('e45').type = type;
    const result = await f.browser.call('job', 'browser_type', { target: ' [ref=e45] ', text: 'must not type' });
    assert.equal(result.status, 'needs_login'); assert.equal(result.action_skipped, true);
    assert.deepEqual(f.actions, []);
  }
  const f = await referenceBrowserFixture();
  f.page.url = () => 'https://example.org/login';
  for (const action of [() => f.browser.call('job', 'browser_click', { target: '[ref=e45]' }), () => f.browser.captureArticle('job', '[ref=e45]')]) {
    const result = await action();
    assert.equal(result.status, 'needs_login'); assert.equal(result.action_skipped, true);
  }
  assert.deepEqual(f.actions, []); assert.deepEqual(f.lookups, []);
});

test('article capture shares normalization, captures once and retains hyperlink and URL restrictions', async t => {
  const transfers = [];
  const fetched = { bytes: Buffer.from('fixture'), contentType: 'application/pdf', resolvedUrl: 'https://example.org/paper.pdf' };
  t.mock.method(sourceFetch, 'fetchSource', async url => { transfers.push(url); return fetched; });
  for (const target of equivalents) {
    const f = await referenceBrowserFixture(), count = transfers.length;
    assert.equal(await f.browser.captureArticle('job', target), fetched);
    assert.equal(transfers.length, count + 1);
    assert.deepEqual(f.lookups, []);
    assert.deepEqual(f.actions, []);
  }
  const f = await referenceBrowserFixture(), count = transfers.length;
  f.elements.get('e45').href = null;
  await assert.rejects(f.browser.captureArticle('job', '[ref=e45]'), { code: 'ARTICLE_LINK_REQUIRED' });
  f.elements.get('e45').href = 'file:///private/article.pdf';
  await assert.rejects(f.browser.captureArticle('job', '[ref=e45]'));
  assert.equal(transfers.length, count);
  await assert.rejects(f.browser.captureArticle('job', 'latest_download'), { code: 'NO_OBSERVED_DOWNLOAD' });
  f.browser.lastDownloads = ['https://example.org/paper.pdf'];
  assert.equal(await f.browser.captureArticle('job', ' latest_download '), fetched);
  assert.equal(transfers.length, count + 1);
});

test('article capture skips malformed/stale targets, refreshes safely and preserves login interlocks', async t => {
  t.mock.method(sourceFetch, 'fetchSource', async () => assert.fail('Skipped captures must not fetch'));
  for (const target of [...malformed, 'e999', ' [ref=f2e999] ']) {
    const f = await referenceBrowserFixture(), stale = normalizeSnapshotReference(target) !== null;
    const result = await f.browser.captureArticle('job', target);
    assert.equal(result.status, stale ? 'stale_reference' : 'invalid_reference');
    assert.equal(result.action_skipped, true);
    assert.deepEqual(f.actions, []);
    assert.equal(f.page.snapshots, stale ? 1 : 0);
  }
  const f = await referenceBrowserFixture(); let checks = 0;
  f.browser.loginState = async () => ++checks > 1;
  const result = await f.browser.captureArticle('job', '[ref=e999]');
  assert.equal(result.status, 'needs_login'); assert.equal(result.action_skipped, true);
  assert.deepEqual(f.actions, []);
});
