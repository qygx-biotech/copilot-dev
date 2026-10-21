import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceBrowserFixture } from './helpers/reference-browser-fixture.mjs';
import sourceFetch from '../../shared/source-fetch.js';

const click = f => f.browser.call('job', 'browser_click', { target: ' [ref=e45] ' });

test('CLIO Articles+ stays actionable while results and an unrelated frame update', async () => {
  const f = await referenceBrowserFixture(), results = f.page.addFrame(f.main);
  f.page.addElement('e90', results);
  await f.browser.observe();
  // Results render asynchronously; the unchanged Articles+ element is retained.
  f.page.addElement('e91', results);
  f.page.navigate(results);
  const response = await click(f);
  assert.equal(response.status, 'observed');
  assert.deepEqual(f.actions.map(action => [action.name, action.ref]), [['click', 'e45']]);
});

test('another tab navigation and closure do not invalidate the active page', async () => {
  const f = await referenceBrowserFixture(), other = f.addPage();
  other.page.navigate(); await other.page.close();
  assert.equal((await click(f)).status, 'observed');
  assert.equal(f.actions.length, 1);
});

test('an unresolved background frame does not prevent an unchanged main-frame action', async () => {
  const f = await referenceBrowserFixture(), loading = f.page.addFrame(f.main);
  loading.evaluateHandle = async () => { throw new Error('Background frame is still navigating'); };
  // Post-action observations may be unavailable; the action itself is still valid.
  await click(f);
  assert.equal(f.actions.length, 1); assert.equal(f.actions[0].ref, 'e45');
});

test('session replacement cannot authorize an ID retained by a model', async () => {
  const f = await referenceBrowserFixture();
  f.browser.referenceState.newSession();
  const result = await click(f);
  assert.equal(result.reason, 'reference_session_changed'); assert.equal(result.action_skipped, true);
  assert.deepEqual(f.actions, []);
});

test('same-document navigation does not invalidate the exact element', async () => {
  const f = await referenceBrowserFixture();
  f.page.emit('framenavigated', f.main); // history/hash change, same Document handle
  assert.equal((await click(f)).status, 'observed'); assert.equal(f.actions.length, 1);
});

test('new documents reusing an ID cannot authorize an old action; diagnostics precede refresh', async () => {
  const f = await referenceBrowserFixture(), old = f.browser.referenceState.metadata();
  f.page.navigate(); f.page.addElement('e45');
  const response = await click(f);
  assert.equal(response.status, 'stale_reference'); assert.equal(response.action_skipped, true);
  assert.equal(response.reason, 'target_document_navigated'); assert.deepEqual(f.actions, []);
  assert.equal(response.diagnostics.snapshot_id, old.snapshot_id);
  assert.notEqual(response.snapshot_metadata.snapshot_id, old.snapshot_id);
  assert.match(response.snapshot, /ref=e45/);
  assert.match(response.message, /may appear in the refreshed snapshot/);
  assert.equal(response.diagnostics.documents[0].document_version, 1);
  assert.equal(response.diagnostics.current_documents[0].document_version, 2);
  // Only a subsequent explicit model call may use the new snapshot.
  assert.equal((await click(f)).status, 'observed'); assert.equal(f.actions.length, 1);
});

test('own frame navigation and ancestor detachment invalidate descendants without parsing ID prefixes', async () => {
  for (const event of ['navigate', 'detach']) {
    const f = await referenceBrowserFixture(), parent = f.page.addFrame(f.main), frame = f.page.addFrame(parent);
    // The plain ID is actually inside a frame; the f1 ID is actually in main.
    f.page.addElement('e45', frame); await f.browser.observe();
    f.page[event](parent);
    const response = await click(f);
    assert.equal(response.reason, event === 'navigate' ? 'target_document_navigated' : 'frame_detached');
    assert.equal(response.action_skipped, true); assert.deepEqual(f.actions, []);
    const remaining = await f.browser.call('job', 'browser_click', { target: '[ref=f1e45]' });
    assert.equal(remaining.status, 'observed'); assert.equal(f.actions.length, 1);
  }
});

test('a closed snapshot page never falls back to another tab with the same reference', async () => {
  const f = await referenceBrowserFixture(), other = f.addPage(); other.page.addElement('e45');
  await f.page.close();
  const result = await click(f);
  assert.equal(result.reason, 'page_closed'); assert.equal(result.action_skipped, true);
  assert.deepEqual(other.actions, []); assert.deepEqual(f.actions, []);
});

test('snapshot capture retries document changes but never registers a mixed-document result', async () => {
  const f = await referenceBrowserFixture(), capture = f.page.ariaSnapshot;
  let attempts = 0;
  f.page.ariaSnapshot = async () => {
    const raw = await capture();
    if (++attempts === 1) { f.page.navigate(); f.page.addElement('e77'); }
    return raw;
  };
  const result = await f.browser.observe();
  assert.equal(result.status, 'observed'); assert.equal(attempts, 2);
  assert.match(result.snapshot, /ref=e77/); assert.doesNotMatch(result.snapshot, /ref=e45/);
  assert.equal(f.browser.referenceState.latest.entries.has('e45'), false);
  assert.deepEqual(f.actions, []);
});

test('continuous capture races stop after three observations with explicit feedback', async () => {
  const f = await referenceBrowserFixture(), capture = f.page.ariaSnapshot;
  f.page.ariaSnapshot = async () => { const raw = await capture(); f.page.navigate(); f.page.addElement('e45'); return raw; };
  const result = await f.browser.observe();
  assert.equal(result.status, 'observation_unavailable'); assert.equal(result.reason, 'snapshot_changed_during_capture');
  assert.equal(result.attempts, 3); assert.equal(f.page.snapshots, 3);
  assert.equal(f.browser.referenceState.latest, null); assert.deepEqual(f.actions, []);
});

test('refresh races and login never overwrite the rejection captured before refresh', async () => {
  for (const refresh of ['race', 'login']) {
    const f = await referenceBrowserFixture(), capture = f.page.ariaSnapshot;
    f.page.navigate(); f.page.addElement('e45');
    f.page.ariaSnapshot = async () => {
      const raw = await capture();
      if (refresh === 'race') { f.page.navigate(); f.page.addElement('e45'); }
      else f.page.url = () => 'https://example.org/login';
      return raw;
    };
    const response = await click(f);
    assert.equal(response.status, refresh === 'login' ? 'needs_login' : 'stale_reference');
    assert.equal(response.reason, 'target_document_navigated'); assert.equal(response.action_skipped, true);
    assert.equal(response.diagnostics.current_documents[0].document_version, 2);
    if (refresh === 'race') assert.equal(response.observation_reason, 'snapshot_changed_during_capture');
    assert.deepEqual(f.actions, []);
  }
});

test('capture retries are cancellable and preserve login appearing during capture', async () => {
  for (const change of ['abort', 'login']) {
    const f = await referenceBrowserFixture(), capture = f.page.ariaSnapshot, controller = new AbortController();
    f.page.ariaSnapshot = async () => { const raw = await capture(); if (change === 'abort') controller.abort(); else f.page.url = () => 'https://example.org/login'; return raw; };
    if (change === 'abort') await assert.rejects(f.browser.observe(controller.signal), { code: 'OPERATION_ABORTED' });
    else assert.equal((await f.browser.observe(controller.signal)).status, 'needs_login');
    assert.equal(f.page.snapshots, 1); assert.deepEqual(f.actions, []);
  }
});

test('disappeared targets and same-ID replacement elements are never substituted', async () => {
  for (const replace of [false, true]) {
    const f = await referenceBrowserFixture();
    f.elements.get('e45').connected = false;
    if (replace) f.page.addElement('e45');
    const response = await click(f);
    assert.equal(response.action_skipped, true); assert.equal(response.reason, 'target_not_found');
    assert.deepEqual(f.actions, []);
  }
});

test('missing authoritative owner-frame mapping uses conservative page-document validation', async () => {
  const f = await referenceBrowserFixture(), otherFrame = f.page.addFrame(f.main);
  f.elements.get('e45').handle.ownerFrame = async () => null;
  await f.browser.observe(); f.page.navigate(otherFrame);
  const response = await click(f);
  assert.equal(response.reason, 'target_document_navigated');
  assert.equal(response.diagnostics.frame_mapping, 'page_fallback'); assert.deepEqual(f.actions, []);
});

test('article capture uses identical document checks and never transfers a stale replacement', async () => {
  let transfers = 0;
  const f = await referenceBrowserFixture();
  // The transfer itself is an in-browser download of the exact observed link.
  f.browser.capture = async () => { transfers++; return {}; };
  f.page.navigate(); f.page.addElement('e45');
  const response = await f.browser.captureArticle('job', '[ref=e45]');
  assert.equal(response.reason, 'target_document_navigated'); assert.equal(response.action_skipped, true);
  assert.equal(transfers, 0);
  await f.browser.captureArticle('job', '[ref=e45]'); assert.equal(transfers, 1);
});

test('navigation during exact-target attribute reads returns skipped feedback, not a transfer or input', async t => {
  t.mock.method(sourceFetch, 'fetchSource', async () => assert.fail('No transfer may run'));
  for (const action of ['type', 'capture']) {
    const f = await referenceBrowserFixture();
    f.elements.get('e45').handle.getAttribute = async () => { f.page.navigate(); throw new Error('Execution context destroyed'); };
    const result = await (action === 'type' ? f.browser.call('job', 'browser_type', { target: 'e45', text: 'query' }) : f.browser.captureArticle('job', 'e45'));
    assert.equal(result.reason, 'target_document_navigated'); assert.equal(result.action_skipped, true);
    assert.deepEqual(f.actions, []);
  }
});

test('unknown action outcomes are not replayed or presented as successful observations', async () => {
  const f = await referenceBrowserFixture(); let calls = 0;
  f.elements.get('e45').handle.click = async () => { calls++; throw new Error('timeout after possible input'); };
  const response = await click(f);
  assert.equal(response.status, 'action_failed'); assert.equal(response.action_outcome, 'unknown');
  assert.equal(response.action_skipped, undefined); assert.equal(calls, 1);
});

test('rejection metadata contains identities and versions, never page URLs or credentials', async () => {
  const f = await referenceBrowserFixture();
  f.page.url = () => 'https://example.org/private?token=credential';
  f.page.navigate();
  const result = await click(f);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /https:|credential|token|cookie/i);
  assert.equal(result.reason, 'target_document_navigated');
});
