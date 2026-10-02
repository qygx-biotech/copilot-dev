(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BioDesignRuntimeTurns = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  class InjectionQueue {
    constructor({ onChange = () => {} } = {}) { this.entries = []; this.closed = false; this.onChange = onChange; }
    enqueue(content, { id = globalThis.crypto.randomUUID(), kind = 'user', taskId } = {}) {
      if (this.closed) throw Object.assign(new Error('This turn has finished.'), { code: 'TURN_CLOSED' });
      if (typeof content !== 'string' || !content.trim() || content.length > 64000 || this.entries.length >= 128 || (kind === 'user' && this.entries.filter(entry => entry.kind === 'user').length >= 104)) throw Object.assign(new Error('The current turn input queue is full or the message is too long.'), { code: 'INJECTION_LIMIT' });
      if (this.entries.some(entry => entry.id === id)) return id;
      this.entries.push({ id, content, kind, ...(taskId ? { taskId } : {}), status: 'queued' });
      this.onChange(this.snapshot()); return id;
    }
    batch() {
      const batch = []; let length = 0;
      for (const entry of this.entries.filter(entry => entry.status === 'queued')) {
        if (batch.length >= 16 || length + entry.content.length > 90000) break;
        const { status, ...message } = entry; batch.push(message); length += entry.content.length;
      }
      return batch;
    }
    acknowledge(ids = []) { const accepted = new Set(ids); for (const entry of this.entries) if (accepted.has(entry.id)) entry.status = 'received'; this.onChange(this.snapshot()); }
    hasPending() { return this.entries.some(entry => entry.status === 'queued'); }
    snapshot() { return this.entries.map(({ id, kind, status, taskId }) => ({ id, kind, status, taskId })); }
    finish() { if (this.hasPending()) return false; this.closed = true; return true; }
    cancel() { this.closed = true; for (const entry of this.entries) if (entry.status === 'queued') entry.status = 'not_received'; this.onChange(this.snapshot()); }
  }
  return { InjectionQueue };
});
