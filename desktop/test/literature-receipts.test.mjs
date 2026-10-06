import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectFilesystem } from '../services/project-filesystem.mjs';
import { LiteratureWorkflows } from '../services/literature-workflows.mjs';

const execution_id = 'literature_0123456789abcdef';
const receiptPath = `.biodesign/literature-jobs/receipts/${execution_id}.json`;
const uncertainPath = `.biodesign/literature-jobs/receipts/${execution_id}.uncertain.json`;
const failure = () => Object.assign(new Error('Injected storage failure'), { code: 'EIO' });
const policy = { model: 'fixture/model', permission: 'workspace_write', authorization: { download: true }, scopePaths: null };
const paper = { title: 'Enzyme engineering', authors: ['Alice Smith'], year: 2024, doi: '10.1234/enzyme', source_urls: ['https://example.org/paper.pdf'] };
const bytes = Buffer.from('%PDF-1.7\nfixture');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, { retrieve = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'literature-receipts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fs = await ProjectFilesystem.open(root);
  let effects = 0, transfers = 0, current = true;
  const browser = {
    owner: null, tools: [{ name: 'browser_snapshot', inputSchema: { type: 'object', properties: {} } }],
    async exclusive(id, fn) { assert(!this.owner || this.owner === id); this.owner = id; return fn(); },
    async start() {}, async close(id) { this.release(id); }, release(id) { if (this.owner === id) this.owner = null; },
    async call(id) { assert.equal(this.owner, id); effects++; return { status: 'observed', snapshot: `Evidence ${effects}` }; },
  };
  const dependencies = {
    parse: async () => ({ pages: 2, text: `${paper.title} Alice Smith 2024 DOI: 10.1234/enzyme Version of Record` }),
    fetchSource: async url => { transfers++; return { bytes, contentType: 'application/pdf', resolvedUrl: url }; },
  };
  const active = { filesystem: fs, sourceDownloads: new AbortController(), paperMcp: { tools: [], async start() {} } };
  const construct = filesystem => new LiteratureWorkflows({ ...active, filesystem }, browser, () => current, dependencies);
  const host = construct(fs);
  const begin = { ...policy, action: 'begin', kind: retrieve ? 'retrieve_papers' : 'discover_papers',
    task: retrieve ? { papers: [paper], accepted_versions: ['published'] } : { objective: 'enzymes', queries: ['enzyme'] },
    libraryAccess: { url: retrieve ? '' : 'https://example.org/library' } };
  const started = await host.run(begin);
  effects = 0;
  return { host, fs, browser, active, begin, job_id: started.job_id, jobPath: `.biodesign/literature-jobs/${started.job_id}.json`,
    input: { ...structuredClone(policy), action: 'step', job_id: started.job_id, name: retrieve ? 'retrieve_next' : 'browser_snapshot', args: retrieve ? { index: 0 } : {}, execution_id },
    effects: () => effects, transfers: () => transfers, setCurrent: value => { current = value; },
    async restart() { return construct(await ProjectFilesystem.open(root)); },
    readReceipt: () => host.readReceipt(execution_id),
  };
}

test('failure before reservation persistence performs nothing; redelivery may execute once', async t => {
  const f = await fixture(t), write = f.fs.writeText.bind(f.fs);
  f.input = { ...policy, action: 'resume', job_id: f.job_id, execution_id };
  f.fs.writeText = async (p, ...args) => { if (p === receiptPath) throw failure(); return write(p, ...args); };
  await assert.rejects(f.host.run(f.input), { code: 'EIO' });
  assert.equal(f.effects(), 0);
  const restarted = await f.restart();
  const result = await restarted.run(f.input);
  assert.deepEqual(await restarted.run(f.input), result); assert.equal(f.effects(), 1);
});

test('lost pending-write acknowledgement prevents any automatic execution after reconstruction', async t => {
  const f = await fixture(t), write = f.fs.writeText.bind(f.fs);
  f.fs.writeText = async (p, ...args) => { const result = await write(p, ...args); if (p === receiptPath) throw failure(); return result; };
  await assert.rejects(f.host.run(f.input), { code: 'EIO' });
  assert.equal((await f.readReceipt()).status, 'pending'); assert.equal(f.effects(), 0);
  await assert.rejects((await f.restart()).run(f.input), { code: 'EXECUTION_OUTCOME_UNKNOWN' });
  assert.equal(f.effects(), 0);
});

for (const loseUncertainWrite of [false, true]) test(`effect followed by failed job save never repeats (uncertain write lost: ${loseUncertainWrite})`, async t => {
  const f = await fixture(t), write = f.fs.writeText.bind(f.fs);
  f.fs.writeText = async (p, text, options) => {
    if (p === f.jobPath || loseUncertainWrite && p === uncertainPath) throw failure();
    return write(p, text, options);
  };
  await assert.rejects(f.host.run(f.input), { code: 'EIO' });
  assert.equal(f.effects(), 1); assert.equal((await f.readReceipt()).status, loseUncertainWrite ? 'pending' : 'uncertain');
  const restarted = await f.restart();
  await assert.rejects(restarted.run(f.input), { code: 'EXECUTION_OUTCOME_UNKNOWN' });
  await assert.rejects(restarted.run({ ...f.input, args: { changed: true } }), { code: 'EXECUTION_BINDING_CHANGED' });
  assert.equal(f.effects(), 1);
});

for (const loseUncertainWrite of [false, true]) test(`saved domain result repairs failed completion receipt (uncertain write lost: ${loseUncertainWrite})`, async t => {
  const f = await fixture(t), write = f.fs.writeText.bind(f.fs);
  f.fs.writeText = async (p, text, options) => {
    if (p === receiptPath && JSON.parse(text).status === 'completed' || loseUncertainWrite && p === uncertainPath) throw failure();
    return write(p, text, options);
  };
  await assert.rejects(f.host.run(f.input), { code: 'EIO' });
  assert.equal(f.effects(), 1);
  const checkpoint = JSON.parse(await f.fs.readText(f.jobPath)).executionCheckpoint;
  const restarted = await f.restart();
  assert.deepEqual(await restarted.run(f.input), checkpoint.result);
  assert.deepEqual(await restarted.run(f.input), checkpoint.result);
  assert.equal((await f.readReceipt()).status, 'completed'); assert.equal((await f.readReceipt()).reconciled, true);
  assert.equal(f.effects(), 1);
});

test('lost completed-write acknowledgement returns committed result and preserves it', async t => {
  const f = await fixture(t), write = f.fs.writeText.bind(f.fs);
  f.fs.writeText = async (p, text, options) => {
    const result = await write(p, text, options);
    if (p === receiptPath && JSON.parse(text).status === 'completed') throw failure();
    return result;
  };
  const result = await f.host.run(f.input);
  assert.equal((await f.readReceipt()).status, 'completed');
  assert.deepEqual(await (await f.restart()).run(f.input), result); assert.equal(f.effects(), 1);
});

test('lost job-save acknowledgement can reconcile its exact persisted result after reconstruction', async t => {
  const f = await fixture(t), write = f.fs.writeText.bind(f.fs);
  f.fs.writeText = async (p, ...args) => {
    const result = await write(p, ...args); if (p === f.jobPath) throw failure(); return result;
  };
  await assert.rejects(f.host.run(f.input), { code: 'EIO' });
  assert.equal((await f.readReceipt()).status, 'uncertain');
  assert.equal((await (await f.restart()).run(f.input)).result.snapshot, 'Evidence 1');
  assert.equal(f.effects(), 1);
});

test('a late uncertainty marker cannot overwrite a concurrently reconciled completed receipt', async t => {
  const f = await fixture(t), write = f.fs.writeText.bind(f.fs), marking = deferred(), release = deferred();
  f.fs.writeText = async (p, text, options) => {
    if (p === receiptPath && JSON.parse(text).status === 'completed') throw failure();
    if (p === uncertainPath) { marking.resolve(); await release.promise; }
    return write(p, text, options);
  };
  const first = f.host.run(f.input), rejected = assert.rejects(first, { code: 'EIO' });
  await marking.promise;
  const second = await f.restart(), recovered = await second.run(f.input);
  release.resolve(); await rejected;
  assert.equal((await f.readReceipt()).status, 'completed');
  assert.deepEqual(await (await f.restart()).run(f.input), recovered); assert.equal(f.effects(), 1);
});

test('queued calls retain the arguments and authority captured at admission', async t => {
  const f = await fixture(t), gate = deferred();
  f.host.queue = gate.promise;
  const pending = f.host.run(f.input);
  f.input.authorization.download = false; f.input.args.changed = true;
  gate.resolve(); await pending;
  await assert.rejects((await f.restart()).run(f.input), { code: 'EXECUTION_BINDING_CHANGED' });
  assert.equal(f.effects(), 1);
});

test('completed replay binds arguments, project and authority; object key order is irrelevant', async t => {
  const f = await fixture(t), result = await f.host.run(f.input), restarted = await f.restart();
  assert.deepEqual(await restarted.run(Object.fromEntries(Object.entries(f.input).reverse())), result);
  for (const change of [{ args: { unexpected: true } }, { permission: 'read_only' }, { authorization: { download: false } }, { model: 'other' }, { scopePaths: [] }]) {
    await assert.rejects(restarted.run({ ...f.input, ...change }), { code: 'EXECUTION_BINDING_CHANGED' });
  }
  const other = await fixture(t);
  await other.fs.writeText(receiptPath, await f.fs.readText(receiptPath));
  await assert.rejects(other.host.run(f.input), { code: 'EXECUTION_BINDING_CHANGED' });
  f.setCurrent(false);
  await assert.rejects(restarted.run(f.input), { code: 'OPERATION_ABORTED' });
  assert.equal(f.effects(), 1); assert.equal(other.effects(), 0);
});

test('a receipt copied to a different execution ID cannot claim that call completed', async t => {
  const f = await fixture(t); await f.host.run(f.input);
  const otherId = 'literature_fedcba9876543210';
  await f.fs.writeText(`.biodesign/literature-jobs/receipts/${otherId}.json`, await f.fs.readText(receiptPath));
  await assert.rejects((await f.restart()).run({ ...f.input, execution_id: otherId }), { code: 'EXECUTION_BINDING_CHANGED' });
  assert.equal(f.effects(), 1);
});

test('simultaneous service instances reserve a call once; in-flight duplicate cannot execute', async t => {
  const f = await fixture(t), second = await f.restart(), started = deferred(), release = deferred();
  const call = f.browser.call.bind(f.browser);
  f.browser.call = async (...args) => {
    assert.equal((await f.readReceipt()).status, 'pending');
    const result = await call(...args); started.resolve(); await release.promise; return result;
  };
  const firstCall = f.host.run(f.input);
  await started.promise;
  await assert.rejects(second.run(f.input), { code: 'EXECUTION_OUTCOME_UNKNOWN' });
  release.resolve(); const result = await firstCall;
  assert.deepEqual(await second.run(f.input), result); assert.equal(f.effects(), 1);
});

test('exclusive reservation arbitrates two callers that both observe a missing receipt', async t => {
  const f = await fixture(t), second = await f.restart(), gate = deferred();
  f.input = { ...policy, action: 'resume', job_id: f.job_id, execution_id };
  let arrivals = 0;
  for (const host of [f.host, second]) {
    const read = host.readReceipt.bind(host);
    host.readReceipt = async id => {
      const record = await read(id);
      if (!record && ++arrivals <= 2) { if (arrivals === 2) gate.resolve(); await gate.promise; }
      return record;
    };
  }
  const results = await Promise.allSettled([f.host.run(f.input), second.run(f.input)]);
  assert(results.some(result => result.status === 'fulfilled'));
  assert.equal(f.effects(), 1);
  assert.equal((await (await f.restart()).run(f.input)).observation, 'Evidence 1');
});

test('cancellation bypasses the work queue; its ID is separate and replay never restarts the action', async t => {
  const f = await fixture(t), started = deferred();
  f.browser.call = async (_id, _name, _args, signal) => {
    started.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw Object.assign(new Error('cancelled'), { code: 'OPERATION_ABORTED' });
  };
  const pending = f.host.run(f.input); await started.promise;
  const cancel = { ...policy, action: 'cancel', job_id: f.job_id, execution_id: 'literature_fedcba9876543210' };
  const cancelled = await f.host.run(cancel), result = await pending;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(f.browser.owner, null);
  const restarted = await f.restart();
  assert.deepEqual(await restarted.run(f.input), result); assert.deepEqual(await restarted.run(cancel), cancelled);
});

for (const failJobSave of [false, true]) test(`download effect, metadata and evidence survive storage failure without retransferring (job save lost: ${failJobSave})`, async t => {
  const f = await fixture(t, { retrieve: true }), write = f.fs.writeText.bind(f.fs);
  f.fs.writeText = async (p, text, options) => {
    if (failJobSave ? p === f.jobPath : p === receiptPath && JSON.parse(text).status === 'completed') throw failure();
    return write(p, text, options);
  };
  await assert.rejects(f.host.run(f.input), { code: 'EIO' });
  assert.equal(f.transfers(), 1);
  const files = await f.fs.list('literature'); assert.equal(files.length, 1);
  const metadataFiles = await f.fs.list('.biodesign/sources'); assert.equal(metadataFiles.length, 1);
  const metadata = JSON.parse(await f.fs.readText(`.biodesign/sources/${metadataFiles[0].name}`));
  assert.equal(metadata.academic_paper.ingestion, 'pending'); assert.equal(metadata.academic_paper.verification.identity, 'doi');
  assert.equal(metadata.content_sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  const restarted = await f.restart();
  if (failJobSave) await assert.rejects(restarted.run(f.input), { code: 'EXECUTION_OUTCOME_UNKNOWN' });
  else {
    const replay = await restarted.run(f.input);
    assert.equal(replay.result.status, 'downloaded'); assert.equal(replay.result.file, metadata.local_path);
    assert.deepEqual(replay.result.verification, metadata.academic_paper.verification);
    assert.equal(replay.result.ingestion, 'pending');
  }
  assert.equal(f.transfers(), 1); assert.equal((await f.fs.list('literature')).length, 1);
});

test('begin reserves its job ID before browser effects and reconciles without reacquiring a browser', async t => {
  const f = await fixture(t), write = f.fs.writeText.bind(f.fs);
  f.browser.release(f.job_id);
  f.fs.writeText = async (p, text, options) => {
    if (p === receiptPath && JSON.parse(text).status === 'completed') throw failure();
    return write(p, text, options);
  };
  const input = { ...f.begin, job_id: f.job_id, execution_id };
  await assert.rejects(f.host.run(input), { code: 'EIO' });
  const receipt = await f.readReceipt(); assert.match(receipt.job_id, /^lit_[a-f0-9]{24}$/);
  assert.notEqual(receipt.job_id, f.job_id, 'A new begin cannot select or overwrite an existing job through the top-level job_id');
  const replay = await (await f.restart()).run(input);
  assert.equal(replay.job_id, receipt.job_id); assert.equal(f.effects(), 1);
});

test('legacy completed receipts replay; truncated reservations fail closed', async t => {
  const f = await fixture(t);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ ...f.input, execution_id: undefined })).digest('hex');
  await f.fs.writeText(receiptPath, JSON.stringify({ fingerprint, result: { original: true } }));
  assert.deepEqual(await (await f.restart()).run(f.input), { original: true });
  await f.fs.writeText(receiptPath, '{');
  await assert.rejects((await f.restart()).run(f.input), { code: 'EXECUTION_OUTCOME_UNKNOWN' }); assert.equal(f.effects(), 0);
});

test('discovery handoff reconciliation preserves raw arguments and does not rerun finalization', async t => {
  const f = await fixture(t), write = f.fs.writeText.bind(f.fs);
  const input = { ...f.input, name: 'finish_discovery', args: { title: '酶工程', authorization_notes: 'User-supplied findings', token_count: 12, candidates: Array.from({ length: 30 }, (_, i) => ({ title: `Study ${i}` })) } };
  f.fs.writeText = async (p, text, options) => {
    if (p === receiptPath && JSON.parse(text).status === 'completed') throw failure();
    return write(p, text, options);
  };
  await assert.rejects(f.host.run(input), { code: 'EIO' });
  const result = await (await f.restart()).run(input);
  assert.deepEqual(result.final.discoveryArguments, input.args);
  assert.equal(result.final.status, 'completed'); assert.equal(f.browser.owner, null); assert.equal(f.effects(), 0);
});
