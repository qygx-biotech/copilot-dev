(function expose(root, factory) {
  const contract = root?.BioDesignGenericSubagent || (typeof require === 'function' ? require('../shared/generic-subagent.js') : null);
  const api = factory(contract);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BioDesignGenericSubagents = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (contract) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = (code, message = code) => Object.assign(new Error(message), { code });
  const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);
  const newId = () => `subagent_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
  class SubagentManager {
    constructor({ runChild, prepareChild = () => {}, onCompletion = () => {}, onStatus = () => {}, concurrency = 4, makeId = newId } = {}) {
      if (!contract || typeof runChild !== 'function') throw fail('SUBAGENT_RUNTIME_UNAVAILABLE');
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw fail('INVALID_SUBAGENT_CONCURRENCY');
      this.runChild = runChild; this.prepareChild = prepareChild; this.onCompletion = onCompletion; this.onStatus = onStatus;
      this.concurrency = concurrency; this.makeId = makeId; this.running = 0; this.closed = false;
      this.tasks = new Map(); this.parents = new Map(); this.queue = [];
    }
    _parent(value, create = false) {
      const key = contract.parentKey(value);
      if (!this.parents.has(key) && create) this.parents.set(key, { identity: contract.parentIdentity(value), calls: new Map(), completions: [], results: new Map(), statuses: new Map(), waiters: [] });
      return this.parents.get(key);
    }
    _emit(callback, value) {
      // A UI renderer failure must never turn a successful child into failure
      // or prevent cleanup. The completion remains available through drain().
      try { Promise.resolve(callback(clone(value))).catch(() => {}); } catch {}
    }
    _snapshot(task) {
      return { version: 1, task_id: task.id, label: task.args.label, status: task.status,
        parent: contract.parentIdentity(task.parent), model: task.parent.model,
        createdAt: task.createdAt, ...(task.startedAt ? { startedAt: task.startedAt } : {}),
        ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}) };
    }
    _status(task) {
      const parent = this._parent(task.parent), snapshot = this._snapshot(task);
      if (parent) {
        parent.statuses.set(task.id, snapshot);
        // Keep recent completed status for UI only, never unbounded transcripts.
        const completed = [...parent.statuses].filter(([, value]) => terminal(value.status));
        for (const [id] of completed.slice(0, Math.max(0, completed.length - 100))) { parent.statuses.delete(id); parent.results.delete(id); }
      }
      this._emit(this.onStatus, snapshot);
    }
    async spawn(value, parentValue, { signal, callId } = {}) {
      if (this.closed) throw fail('SUBAGENT_MANAGER_CLOSED');
      const args = contract.validateSpawn(value), parent = contract.captureParent(parentValue), owner = this._parent(parent, true);
      if (callId !== undefined && (typeof callId !== 'string' || !callId || callId.length > 300)) throw fail('INVALID_SUBAGENT_CALL_ID');
      const fingerprint = JSON.stringify({ args, parent });
      if (callId && owner.calls.has(callId)) {
        const prior = owner.calls.get(callId);
        if (prior.fingerprint !== fingerprint) throw fail('SUBAGENT_RECEIPT_CONFLICT');
        return args.wait ? clone(await prior.done) : clone(prior.receipt);
      }
      const id = this.makeId();
      if (this.tasks.has(id) || [...this.parents.values()].some(p => p.statuses.has(id))) throw fail('SUBAGENT_ID_COLLISION');
      const child = contract.createChildRequest(parent, args, { taskId: id });
      // Capture host authority when spawned, before waiting for a concurrency
      // slot. A later parent mutation must not widen a queued child's scope.
      this.prepareChild(child);
      let resolve;
      const done = new Promise(finish => { resolve = finish; });
      const task = { id, args, parent, child, status: 'queued', createdAt: new Date().toISOString(), controller: new AbortController(), done, resolve, signal, settled: false };
      task.receipt = { ...this._snapshot(task), delivery: args.wait ? 'inline' : 'parent_queue' };
      this.tasks.set(id, task);
      if (callId) owner.calls.set(callId, { fingerprint, done, receipt: task.receipt });
      this.queue.push(task); this._status(task);
      if (signal) {
        task.abortListener = () => this.cancel(id, parent);
        signal.addEventListener('abort', task.abortListener, { once: true });
        if (signal.aborted) task.abortListener();
      }
      this._pump();
      return args.wait ? clone(await done) : clone(task.receipt);
    }
    _pump() {
      while (!this.closed && this.running < this.concurrency && this.queue.length) {
        const task = this.queue.shift();
        if (task.settled) continue;
        task.status = 'running'; task.startedAt = new Date().toISOString(); this.running++; this._status(task);
        Promise.resolve().then(() => {
          if (task.controller.signal.aborted) throw fail('OPERATION_ABORTED');
          return this.runChild(task.child, { signal: task.controller.signal, parent: task.parent, taskId: task.id });
        }).then(result => {
          if (result?.fallback || result?.failure || result?.ok === false) this._finish(task, 'failed', { error: result.error || 'SUBAGENT_FAILED', message: result.reply || result.reason || 'The delegated request failed.', result });
          else this._finish(task, 'completed', { result: result ?? null });
        }, error => this._finish(task, task.controller.signal.aborted || error?.code === 'OPERATION_ABORTED' ? 'cancelled' : 'failed', {
          error: error?.code || 'SUBAGENT_FAILED', message: error?.message || 'The delegated request failed.',
        })).finally(() => {
          this.running--; this.tasks.delete(task.id); this._pump(); this._notifyIdle(task.parent);
        });
      }
    }
    _finish(task, status, payload = {}) {
      if (task.settled) return;
      task.settled = true; task.status = status; task.finishedAt = new Date().toISOString();
      task.signal?.removeEventListener('abort', task.abortListener);
      let safePayload;
      try { safePayload = clone(payload); }
      catch { task.status = 'failed'; safePayload = { error: 'INVALID_SUBAGENT_RESULT', message: 'The delegated result could not be serialized.' }; }
      const completion = { ...this._snapshot(task), ...safePayload,
        evidenceStatus: 'delegated_analysis',
        guidance: 'Child analysis is not independent source verification. Preserve the result’s original citations, evidence metadata and coverage limitations.' };
      this._status(task);
      const parent = this._parent(task.parent);
      parent?.results.set(task.id, completion);
      if (!task.args.wait && parent) {
        parent.completions.push(completion);
        this._emit(this.onCompletion, completion);
      }
      task.resolve(completion);
    }
    cancel(taskId, parentValue) {
      const key = contract.parentKey(parentValue), task = this.tasks.get(taskId);
      if (!task || contract.parentKey(task.parent) !== key || task.settled) return false;
      const queued = task.status === 'queued';
      task.controller.abort();
      this._finish(task, 'cancelled', { error: 'OPERATION_ABORTED', message: 'The parent stopped the delegated task.' });
      if (queued) { this.queue = this.queue.filter(item => item !== task); this.tasks.delete(task.id); this._notifyIdle(task.parent); }
      return true;
    }
    cancelParent(parentValue) {
      const key = contract.parentKey(parentValue); let count = 0;
      for (const task of this.tasks.values()) if (contract.parentKey(task.parent) === key && this.cancel(task.id, parentValue)) count++;
      return count;
    }
    list(parentValue) { return clone([...(this._parent(parentValue)?.statuses.values() || [])]); }
    drain(parentValue) {
      const parent = this._parent(parentValue);
      return parent ? clone(parent.completions.splice(0)) : [];
    }
    async wait(taskId, parentValue) {
      const task = this.tasks.get(taskId), key = contract.parentKey(parentValue);
      if (!task || contract.parentKey(task.parent) !== key) {
        const completed = this._parent(parentValue)?.results.get(taskId);
        if (completed) return clone(completed);
        throw fail('SUBAGENT_NOT_FOUND');
      }
      return clone(await task.done);
    }
    _hasRunning(parentValue) {
      const key = contract.parentKey(parentValue);
      return [...this.tasks.values()].some(task => contract.parentKey(task.parent) === key);
    }
    _notifyIdle(parentValue) {
      const parent = this._parent(parentValue);
      if (parent && !this._hasRunning(parentValue)) for (const resolve of parent.waiters.splice(0)) resolve();
    }
    waitForIdle(parentValue) {
      const parent = this._parent(parentValue);
      if (!parent || !this._hasRunning(parentValue)) return Promise.resolve();
      return new Promise(resolve => parent.waiters.push(resolve));
    }
    forgetParent(parentValue) {
      if (this._hasRunning(parentValue)) throw fail('SUBAGENT_PARENT_BUSY');
      // Called after results are delivered or the parent conversation closes.
      // Drops receipts and completion data without leaving an orphan task.
      return this.parents.delete(contract.parentKey(parentValue));
    }
    async close() {
      this.closed = true;
      const identities = [...this.parents.values()].map(parent => parent.identity);
      identities.forEach(parent => this.cancelParent(parent));
      await Promise.all(identities.map(parent => this.waitForIdle(parent)));
      this.parents.clear(); this.queue = [];
    }
  }
  return { SubagentManager };
});
