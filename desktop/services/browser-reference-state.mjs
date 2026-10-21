// All identities here come from Playwright objects/handles, never URL equality
// or the spelling of an MCP reference. Version numbers are host-local epochs.
export class BrowserReferenceState {
  constructor() { this.session = 0; this.sequence = 0; this.pages = new Map(); this.latest = null; }
  dispose(handle) { void handle?.dispose().catch(() => {}); }
  forget(reason) {
    for (const entry of this.latest?.entries.values() || []) this.dispose(entry.handle);
    this.latest = null;
    this.unavailableReason = reason;
  }
  newSession() {
    this.forget(this.latest ? 'reference_session_changed' : undefined);
    for (const page of this.pages.values()) for (const frame of page.frames.values()) this.dispose(frame.document);
    this.pages.clear(); this.session++;
  }
  page(page) {
    if (!this.pages.has(page)) this.pages.set(page, { id: ++this.sequence, page, revision: 0, closed: false, frames: new Map() });
    return this.pages.get(page);
  }
  frame(state, frame) {
    if (!state.frames.has(frame)) state.frames.set(frame, { id: ++this.sequence, frame, parent: frame.parentFrame(), version: 0, document: null, detached: false });
    return state.frames.get(frame);
  }
  belongs(state, frame, ancestor) {
    for (let current = frame; current; current = state.frames.get(current)?.parent) if (current === ancestor) return true;
    return false;
  }
  invalidate(state, frame, reason) {
    if (this.latest?.page !== state.page) return;
    for (const entry of this.latest.entries.values()) {
      if (!frame || !entry.frame || this.belongs(state, entry.frame, frame)) entry.reason ||= reason;
    }
  }
  changed(page, frame, detached = false) {
    const state = this.page(page); state.revision++;
    if (detached) {
      this.frame(state, frame).detached = true;
      this.invalidate(state, frame, 'frame_detached');
    }
    // framenavigated also fires for same-document navigation. Compare actual
    // Document handles before invalidating; a hash/history change isn't a new document.
  }
  closed(page) {
    const state = this.page(page); state.closed = true; state.revision++;
    this.invalidate(state, null, 'page_closed');
  }
  async documents(page, frames = page.frames()) {
    const state = this.page(page);
    for (const frame of frames) {
      const record = this.frame(state, frame);
      if (frame.isDetached()) { record.detached = true; this.invalidate(state, frame, 'frame_detached'); continue; }
      let same = false;
      try { same = record.document && await record.document.evaluate(documentAtCapture => documentAtCapture === document); } catch { /* destroyed execution context */ }
      if (!same) {
        const documentHandle = await frame.evaluateHandle(() => document);
        if (record.document) this.invalidate(state, frame, 'target_document_navigated');
        this.dispose(record.document); record.document = documentHandle; record.version++; record.detached = false;
      }
    }
    return this.versions(state);
  }
  versions(state) {
    return [...state.frames.values()].map(frame => ({ frame_id: frame.id, document_version: frame.version, detached: frame.detached }));
  }
  metadata(snapshot = this.latest) {
    if (!snapshot) return { session: this.session };
    return { session: snapshot.session, snapshot_id: snapshot.id, page_id: this.page(snapshot.page).id, documents: snapshot.versions };
  }
  diagnostic(target, reason, entry) {
    const state = this.latest && this.page(this.latest.page);
    return { reason, reference: target, ...this.metadata(), ...(entry ? { frame_id: entry.frame ? state.frames.get(entry.frame)?.id : null, frame_mapping: entry.frame ? 'element_owner_frame' : 'page_fallback' } : {}),
      ...(state ? { current_documents: this.versions(state) } : {}) };
  }
  // Resolve the exact element behind one reference of the latest capture.
  async entry(page, state, target) {
    let handles = [];
    try { handles = await page.locator(`aria-ref=${target}`).elementHandles(); } catch { /* snapshot raced element removal */ }
    const handle = handles.length === 1 ? handles[0] : null;
    if (!handle) handles.forEach(value => this.dispose(value));
    let frame = null;
    try { frame = await handle?.ownerFrame(); } catch { /* conservative page fallback */ }
    if (frame && !state.frames.has(frame)) frame = null;
    return { handle, frame, reason: handle ? null : 'target_not_found' };
  }
  async resolveAll(page, state, targets, entries, signal) {
    const pending = [...targets];
    // Bounded parallel lookups; each is an independent read of the same capture.
    while (pending.length) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'OPERATION_ABORTED' });
      const batch = pending.splice(0, 16);
      const resolved = await Promise.all(batch.map(target => this.entry(page, state, target)));
      batch.forEach((target, index) => entries.set(target, resolved[index]));
    }
  }
  async register(page, snapshot, before, revision, owner, signal) {
    const state = this.page(page), session = this.session, entries = new Map();
    try {
      await this.resolveAll(page, state, new Set([...snapshot.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)].map(match => match[1])), entries, signal);
      const after = await this.documents(page);
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'OPERATION_ABORTED' });
      if (session !== this.session || this.pages.get(page) !== state || state.closed || page.isClosed() || revision !== state.revision || JSON.stringify(before) !== JSON.stringify(after)) return false;
      this.forget();
      this.latest = { id: ++this.sequence, session: this.session, owner, page, entries, versions: after };
      return true;
    } finally {
      if (this.latest?.entries !== entries) for (const entry of entries.values()) this.dispose(entry.handle);
    }
  }
  // Add references from the same capture (found by a text search) to the
  // latest snapshot, only while its documents are unchanged.
  async extend(page, targets, owner, signal) {
    const snapshot = this.latest;
    if (!snapshot || snapshot.page !== page || snapshot.owner !== owner || snapshot.session !== this.session || page.isClosed()) return false;
    const state = this.page(page), revision = state.revision, entries = new Map();
    try {
      await this.resolveAll(page, state, [...new Set(targets)].filter(target => !snapshot.entries.has(target)), entries, signal);
      const after = await this.documents(page);
      if (this.latest !== snapshot || revision !== state.revision || JSON.stringify(after) !== JSON.stringify(snapshot.versions)) return false;
      for (const [target, value] of entries) snapshot.entries.set(target, value);
      return true;
    } finally {
      for (const [target, value] of entries) if (snapshot.entries.get(target) !== value) this.dispose(value.handle);
    }
  }
  async resolve(page, owner, target) {
    const snapshot = this.latest, entry = snapshot?.entries.get(target);
    let reason;
    if (!snapshot || !entry) reason = this.unavailableReason || 'reference_not_in_snapshot';
    else if (snapshot.session !== this.session || snapshot.owner !== owner) reason = 'reference_session_changed';
    else if (snapshot.page.isClosed() || this.page(snapshot.page).closed) reason = 'page_closed';
    else if (snapshot.page !== page) reason = 'reference_page_changed';
    else {
      const relevantFrames = [];
      for (let frame = entry.frame; frame; frame = this.page(page).frames.get(frame)?.parent) relevantFrames.unshift(frame);
      try { await this.documents(page, entry.frame ? relevantFrames : page.frames()); } catch { reason = 'document_identity_unavailable'; }
      reason = entry.reason || reason;
      if (!reason) {
        try { if (!await entry.handle.evaluate(element => element.isConnected && element.ownerDocument === document)) reason = 'target_not_found'; }
        catch { reason = 'document_identity_unavailable'; }
      }
    }
    return reason ? { reason, diagnostics: this.diagnostic(target, reason, entry) } : { handle: entry.handle, entry };
  }
}
