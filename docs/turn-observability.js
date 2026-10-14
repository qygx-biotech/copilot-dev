(function expose(root, factory) {
  const api = factory(root?.BioDesignTurnObservability || (typeof require === 'function' ? require('../shared/turn-observability.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BioDesignTurnObserver = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (contract) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const text = (value, limit = 200) => typeof value === 'string' ? value.slice(0, limit) : '';
  const safePath = value => typeof value === 'string' && value.length > 0 && value.length <= 600 &&
    !/^(?:[a-z]:|[/\\])|[\x00-\x1f]/i.test(value) && !value.split(/[/\\]/).some(part => part === '..' || part === '.');

  function receiptSummary(receipt) {
    const result = receipt?.result ?? receipt;
    if (!result || typeof result !== 'object') return { status: 'unknown', summary: {} };
    const failed = result.ok === false || Boolean(result.error) || ['failed', 'error', 'cancelled'].includes(result.status);
    const code = typeof result.error === 'string' ? result.error : result.error?.code;
    const success = result.ok === true || ['completed', 'downloaded', 'already_present'].includes(result.status);
    const pending = result.pendingDesktopTool || ['pending', 'running', 'queued'].includes(result.status);
    const evidence = result.evidenceBundle;
    const sourceIds = [...new Set([
      ...(Array.isArray(result.sourceIds) ? result.sourceIds : []),
      ...(Array.isArray(result.analyzedPaperIds) ? result.analyzedPaperIds : []),
      ...(Array.isArray(evidence?.items) ? evidence.items.flatMap(item => item.sourceIds || [item.sourceId]) : []),
      ...(Array.isArray(result.results) ? result.results.flatMap(item => item.sourceIds || [item.sourceId]) : []),
    ].filter(value => typeof value === 'string'))].slice(0, 30);
    const references = Array.isArray(evidence?.items) ? evidence.items.flatMap(item => item.references || []) : [];
    const changes = result.value?.output_changes;
    return { status: failed ? code === 'OPERATION_ABORTED' || result.status === 'cancelled' ? 'cancelled' : 'failed'
      : pending ? 'pending' : success ? 'completed' : 'unknown', summary: {
      ...(code ? { code: text(code, 100) } : {}),
      ...(sourceIds.length ? { sourceIds, sourceCount: sourceIds.length } : {}),
      ...(references.length ? { referenceCount: references.length } : {}),
      ...(Array.isArray(result.results) ? { resultCount: result.results.length } : {}),
      ...(changes && typeof changes === 'object' ? Object.fromEntries(['created', 'changed', 'deleted'].filter(key => Array.isArray(changes[key]))
        .map(key => [`files${key[0].toUpperCase()}${key.slice(1)}`, changes[key].length])) : {}),
      ...(typeof evidence?.sufficiency === 'string' || typeof result.evidenceStatus === 'string'
        ? { evidenceStatus: text(evidence?.sufficiency || result.evidenceStatus, 100) } : {}) } };
  }

  class TurnObserver {
    constructor({ turnId, model = '', previous, onChange = () => {}, now = () => Date.now() } = {}) {
      if (!contract) throw new Error('Turn observability contract is unavailable.');
      this.turnId = text(turnId); this.model = text(model); this.onChange = onChange; this.now = now;
      this.activities = []; this.artifacts = []; this.turnUsage = null; this.children = new Map(); this.calls = new Map();
      this.startedAt = now(); this.finishedAt = null;
      previous = contract.normalizeDetails(previous);
      if (previous?.version === 1 && previous.turnId === this.turnId) {
        this.startedAt = Number.isFinite(previous.startedAt) ? previous.startedAt : this.startedAt;
        this.finishedAt = Number.isFinite(previous.finishedAt) ? previous.finishedAt : null;
        for (const event of (previous.activities || []).slice(-contract.LIMITS.activities)) contract.mergeActivity(this.activities, event);
        if (previous.turnUsage) this.usage(previous.turnUsage, false);
        // Persisted diffs were produced only by writeArtifact; sanitization is
        // repeated on render. Never infer edits from assistant/tool text.
        this.artifacts = Array.isArray(previous.artifacts) ? previous.artifacts.filter(item => item?.origin === 'host-write' && safePath(item.path)).slice(-20).map(copy) : [];
        for (const usage of previous.childUsage) this.children.set(usage.turnId, usage);
        if (previous.outputChanges) this.outputChanges = copy(previous.outputChanges);
      }
    }
    publish() { this.onChange(this.snapshot()); }
    event(event) {
      if (event?.turnUsage) this.usage(event.turnUsage, false);
      if (event?.stage && event.stage !== 'usage') contract.mergeActivity(this.activities, { ...event, timestamp: event.timestamp || this.now() });
      this.publish();
    }
    hostEvent(event) {
      const artifact = event?.artifact;
      if (event?.stage === 'artifact-written' && artifact?.origin === 'host-write' && safePath(artifact.path) &&
          artifact.path.startsWith('.biodesign/knowledge/') && artifact.path.endsWith('.md')) {
        const index = this.artifacts.findIndex(item => item.id === artifact.id);
        if (index < 0) this.artifacts.push(copy(artifact)); else this.artifacts[index] = copy(artifact);
        this.artifacts = this.artifacts.slice(-20);
        this.event({ ...event, id: artifact.id, capability: artifact.path, timestamp: artifact.timestamp, durationMs: artifact.durationMs });
      } else this.event(event);
    }
    usage(snapshot, notify = true) {
      if (snapshot?.version !== 1 || snapshot.turnId !== this.turnId || !Number.isSafeInteger(snapshot.sequence)) return false;
      if (this.turnUsage && (snapshot.sequence < this.turnUsage.sequence || snapshot.sequence === this.turnUsage.sequence && snapshot.updatedAt < this.turnUsage.updatedAt)) return false;
      this.turnUsage = contract.usageSnapshot(contract.createUsage(snapshot, { turnId: this.turnId, model: this.model, now: this.now() }));
      if (notify) this.publish();
      return true;
    }
    childUsage(snapshot) {
      if (snapshot?.version !== 1 || !snapshot.turnId || snapshot.turnId === this.turnId) return false;
      const previous = this.children.get(snapshot.turnId);
      if (previous && previous.sequence > snapshot.sequence || !previous && this.children.size >= 20) return false;
      this.children.set(snapshot.turnId, contract.usageSnapshot(contract.createUsage(snapshot, { now: this.now() })));
      this.publish(); return true;
    }
    receipt(call, receipt, { startedAt, endedAt = this.now() } = {}) {
      const result = receiptSummary(receipt);
      // Project-mode receipts carry the host's running totals for output/.
      const changes = (receipt?.result ?? receipt)?.value?.output_changes;
      if (changes?.turn && typeof changes.turn === 'object')
        this.outputChanges = { ...changes.turn, complete: changes.complete === true, undoAvailable: changes.undo_available === true };
      contract.mergeActivity(this.activities, { id: 'tool:' + text(call.id), callId: text(call.id), capability: call.name,
        stage: 'tool-' + result.status, status: result.status, summary: result.summary, timestamp: endedAt,
        ...(Number.isFinite(startedAt) ? { durationMs: Math.max(0, endedAt - startedAt) } : {}) });
      this.publish(); return receipt;
    }
    async runTool(call, execute) {
      if (!call?.id || !call?.name || typeof execute !== 'function') throw new TypeError('A host tool call and execution function are required.');
      const fingerprint = JSON.stringify([call.name, call.args]);
      const previous = this.calls.get(call.id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw Object.assign(new Error('Tool identity changed.'), { code: 'INVALID_TOOL_CONTINUATION' });
        return previous.promise;
      }
      const startedAt = this.now();
      this.event({ stage: 'tool-running', callId: call.id, capability: call.name, timestamp: startedAt });
      const promise = Promise.resolve().then(execute).then(receipt => this.receipt(call, receipt, { startedAt }), error => {
        this.receipt(call, { ok: false, error: { code: error?.code || 'TOOL_FAILED' } }, { startedAt });
        throw error;
      });
      this.calls.set(call.id, { fingerprint, promise });
      return promise;
    }
    async writeArtifact({ path, before, after, operationId, permission }, write) {
      if (!safePath(path) || typeof before !== 'string' || typeof after !== 'string' || !operationId ||
          !['workspace_write', 'full_access'].includes(permission) || typeof write !== 'function') {
        throw Object.assign(new Error('A permitted host artifact write is required.'), { code: 'ARTIFACT_DIFF_NOT_AUTHORIZED' });
      }
      const startedAt = this.now();
      const result = await this.runTool({ id: operationId, name: 'save_artifact', args: { path } }, async () => {
        const outcome = await write();
        if (outcome?.ok === false) return outcome;
        const diff = contract.diffLines(before, after);
        const artifact = { id: text(operationId), path, origin: 'host-write', timestamp: this.now(), durationMs: this.now() - startedAt, diff };
        const index = this.artifacts.findIndex(item => item.id === operationId);
        if (index < 0) this.artifacts.push(artifact); else this.artifacts[index] = artifact;
        this.artifacts = this.artifacts.slice(-20);
        this.publish();
        return { ok: true, outcome };
      });
      return result?.ok === true ? result.outcome : result;
    }
    finish() { this.finishedAt = this.now(); this.publish(); }
    snapshot() {
      return contract.normalizeDetails({ version: 1, turnId: this.turnId, model: this.model, startedAt: this.startedAt, finishedAt: this.finishedAt,
        activities: this.activities, artifacts: this.artifacts, turnUsage: this.turnUsage,
        childUsage: [...this.children.values()], ...(this.outputChanges ? { outputChanges: this.outputChanges } : {}) });
    }
  }
  return { TurnObserver, receiptSummary, safePath };
});
