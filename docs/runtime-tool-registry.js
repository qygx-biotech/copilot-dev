(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BioDesignRuntimeToolRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const fail = code => Object.assign(new Error(code), { code });
  const clone = value => JSON.parse(JSON.stringify(value));
  // A registry belongs to exactly one captured RuntimeSession. Receipts,
  // authority, cancellation and checkpoints remain owned by that session.
  class Registry {
    #entries = new Map();
    #check;
    #barrier = Promise.resolve();
    #readers = new Set();
    constructor(check) { this.#check = check; }
    register(definition, execute, { parallelSafe = false, coordinator = false } = {}) {
      const name = definition?.function?.name;
      if (!name || this.#entries.has(name) || typeof execute !== 'function') throw fail('RUNTIME_TOOL_COLLISION');
      this.#entries.set(name, { definition: clone(definition), execute, parallelSafe, coordinator });
    }
    has(name) { return this.#entries.has(name); }
    definitions() { return [...this.#entries.values()].map(entry => clone(entry.definition)); }
    async execute(call) {
      this.#check();
      const entry = this.#entries.get(call.name);
      if (!entry) throw fail('RUNTIME_TOOL_NOT_ALLOWED');
      const run = async () => {
        this.#check();
        const result = await entry.execute(call);
        this.#check();
        return result;
      };
      // Codex's shared/exclusive admission pattern. Unknown tools are always
      // exclusive; MCP readOnly hints do not establish safe host concurrency.
      // Wait for earlier exclusive work, but do not hold the barrier while a
      // coordinator awaits subcalls through this registry. Native owner locks
      // protect scratch across the entire lifetime of processes/file workers.
      if (entry.coordinator) return this.#barrier.then(run);
      if (entry.parallelSafe) {
        const pending = this.#barrier.then(run);
        this.#readers.add(pending);
        try { return await pending; } finally { this.#readers.delete(pending); }
      }
      const pending = Promise.allSettled([this.#barrier, ...this.#readers]).then(run);
      this.#barrier = pending.catch(() => {});
      return pending;
    }
    clear() { this.#entries.clear(); }
  }
  return { Registry };
});
