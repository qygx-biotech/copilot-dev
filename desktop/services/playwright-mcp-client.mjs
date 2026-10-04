import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Ajv from 'ajv/dist/2020.js';
import contract from '../../shared/literature-agent.js';
import sourceFetch from '../../shared/source-fetch.js';
import { EventEmitter } from 'node:events';
import { normalizeSnapshotReference, restrictBrowserTool, skippedReference } from './browser-references.mjs';
import { BrowserReferenceState } from './browser-reference-state.mjs';

const fail = code => Object.assign(new Error(code), { code });
const allowed = new Set(['browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_find', 'browser_click', 'browser_type', 'browser_select_option', 'browser_tabs', 'browser_wait_for']);
const authPattern = /(?:^|[\W_])(login|logon|signin|sign-in|authenticate|saml|oauth|mfa|登录|登入|认证)(?:[\W_]|$)/i;
export function redactBrowserText(text) {
  return String(text).replace(/https?:\/\/[^\s<>"')\]]+/g, value => contract.safeUrl(value) || '[redacted URL]')
    .replace(/^(.*(?:textbox|searchbox)[^\n]*\[ref=[^\]]+\])[^\n]*$/gm, '$1')
    .replace(/(?:Bearer\s+\S+|(?:cookie|authorization|password|access_token|id_token|session_token)\s*[:=]\s*\S+)/gi, '[redacted]');
}

// The local host owns a real MCP server/client pair and the browser context.
// No renderer or model receives Playwright objects, credentials or executable code.
export class PlaywrightMcpClient extends EventEmitter {
  constructor({ profileRoot, headless = false, launch, connect } = {}) {
    super();
    this.profileRoot = profileRoot; this.headless = headless; this.launch = launch; this.connect = connect;
    this.referenceState = new BrowserReferenceState();
    this.owner = null; this.queue = Promise.resolve(); this.refs = new Set(); this.lastDownloads = []; this.generation = 0; this.lifecycle = 0;
  }
  async start() {
    await this.closing;
    if (this.client) return;
    if (this.starting) return this.starting;
    const startLifecycle = this.lifecycle, startOwner = this.owner;
    this.starting = (async () => {
      await mkdir(this.profileRoot, { recursive: true, mode: 0o700 });
      const { chromium } = await import('playwright');
      // Auto downloads are disabled even during retrieval. Only captureArticle
      // can transfer a file, with byte/time/redirect limits and host verification.
      const launched = await (this.launch || chromium.launchPersistentContext.bind(chromium))(path.join(this.profileRoot, 'profile'), {
        channel: 'chrome', headless: this.headless, acceptDownloads: false, serviceWorkers: 'block',
      });
      if (this.lifecycle !== startLifecycle) { await launched.close(); throw fail('BROWSER_CLOSED'); }
      this.context = launched;
      this.referenceState.newSession();
      const context = this.context;
      const closed = () => {
        // Events from a disposed context must never release a newer owner.
        if (this.context === context) void this.close(undefined, fail('BROWSER_CLOSED'));
      };
      context.on('close', closed);
      context.browser()?.on('disconnected', closed);
      await context.route('**/*', async route => {
        try { const url = sourceFetch.validateSourceUrl(route.request().url()); await sourceFetch.resolvePublicTarget(url); await route.continue(); }
        catch { await route.abort().catch(() => {}); }
      });
      this.currentPage = context.pages()[0];
      context.pages().forEach(page => this.trackPage(page, context, closed)); context.on('page', page => this.trackPage(page, context, closed));
      const { createConnection } = await import('@playwright/mcp');
      this.server = await (this.connect || createConnection)({ browser: {}, webmcp: false, snapshot: { mode: 'none' }, codegen: 'none', imageResponses: 'omit', saveSession: false,
        outputDir: path.join(this.profileRoot, 'transient'), timeouts: { action: 8000, navigation: 30000 } }, async () => context);
      if (this.context !== context) throw fail('BROWSER_CLOSED');
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      this.client = new Client({ name: 'biodesign-browser-host', version: '1' }, { capabilities: {} });
      await this.server.connect(serverTransport); await this.client.connect(clientTransport);
      const listed = await this.client.listTools();
      if (this.context !== context) throw fail('BROWSER_CLOSED');
      const ajv = new Ajv({ strict: false });
      this.tools = listed.tools.filter(tool => allowed.has(tool.name)).map(restrictBrowserTool);
      this.validators = new Map(this.tools.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
    })().catch(async error => {
      const wrapped = error.code === 'BROWSER_CLOSED' ? error : Object.assign(new Error(error.message || 'Browser unavailable', { cause: error }), { code: 'BROWSER_UNAVAILABLE' });
      if (this.lifecycle === startLifecycle) await this.close(startOwner ?? undefined, wrapped);
      throw wrapped;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }
  trackPage(page, context, closed) {
    this.referenceState.page(page);
    page.on('close', () => {
      if (this.context !== context) return;
      this.referenceState.closed(page);
      const remaining = context.pages().filter(page => !page.isClosed());
      if (!remaining.length) closed();
      else if (this.currentPage === page) this.currentPage = remaining[0];
    });
    page.on('download', download => { if (this.context === context) { this.lastDownloads.push(download.url()); this.lastDownloads = this.lastDownloads.slice(-4); } });
    page.on('framenavigated', frame => { if (this.context === context) this.referenceState.changed(page, frame); });
    page.on('frameattached', frame => { if (this.context === context) this.referenceState.changed(page, frame); });
    page.on('framedetached', frame => { if (this.context === context) this.referenceState.changed(page, frame, true); });
  }
  async exclusive(owner, fn) {
    if (this.owner && this.owner !== owner) throw Object.assign(new Error(`Browser is owned by active job ${this.owner}.`), { code: 'BROWSER_BUSY', ownerId: this.owner, jobId: owner });
    if (!this.owner) { this.referenceState.forget(); this.refs.clear(); this.lastDownloads = []; }
    this.owner = owner;
    const run = async () => { if (this.owner !== owner) throw fail('BROWSER_OWNERSHIP_LOST'); return fn(); };
    const result = this.queue.then(run, run); this.queue = result.catch(() => {}); return result;
  }
  release(owner) { if (this.owner === owner) { this.owner = null; this.referenceState.forget(); this.refs.clear(); } }
  async operationFailed(owner, error) {
    if (['BROWSER_BUSY', 'BROWSER_TOOL_NOT_ALLOWED', 'STALE_REFERENCE', 'AMBIGUOUS_TAB_REFERENCE'].includes(error.code)) throw error;
    const wrapped = error.code?.startsWith('BROWSER_') ? error : Object.assign(new Error(error.message || 'Browser operation failed', { cause: error }), { code: 'BROWSER_OPERATION_FAILED' });
    await this.close(owner, wrapped); throw wrapped;
  }
  async loginState() {
    for (const page of this.currentPage && !this.currentPage.isClosed() ? [this.currentPage] : this.context.pages()) {
      if (authPattern.test(page.url())) return true;
      for (const frame of page.frames()) if (await frame.locator('input[type=password],input[autocomplete=one-time-code]').count()) return true;
    }
    return false;
  }
  async observe(signal) {
    const page = this.currentPage, context = this.context, session = this.referenceState.session;
    let failureReason = 'snapshot_changed_during_capture';
    const cancelled = () => { if (signal?.aborted) throw fail('OPERATION_ABORTED'); };
    for (let attempt = 1; attempt <= 3; attempt++) {
      cancelled();
      if (!page || page.isClosed()) return { status: 'observation_unavailable', reason: 'page_closed', snapshot_metadata: this.referenceState.metadata() };
      if (await this.loginState()) { this.referenceState.forget(); this.refs.clear(); return { status: 'needs_login', instruction: 'Complete sign-in directly in the dedicated browser, then select Resume.' }; }
      const state = this.referenceState.page(page);
      const startingRevision = state.revision;
      try {
        const before = await this.referenceState.documents(page), revision = state.revision;
        // The installed MCP calls this same public Playwright API. Capturing on
        // the Page object avoids guessing MCP tab identity from a displayed URL.
        const raw = await page.ariaSnapshot({ mode: 'ai', timeout: 10000 });
        cancelled();
        if (context !== this.context || session !== this.referenceState.session) return { status: 'observation_unavailable', reason: 'reference_session_changed' };
        if (await this.loginState()) { this.referenceState.forget(); this.refs.clear(); return { status: 'needs_login' }; }
        const snapshot = redactBrowserText(raw).slice(0, 24000);
        if (await this.referenceState.register(page, snapshot, before, revision, this.owner, signal)) {
          this.refs = new Set(this.referenceState.latest.entries.keys()); this.referencePage = page;
          return { status: 'observed', snapshot, generation: ++this.generation, truncated: raw.length > 24000, snapshot_metadata: this.referenceState.metadata() };
        }
        failureReason = 'snapshot_changed_during_capture';
      } catch (error) {
        cancelled();
        if (error.code === 'OPERATION_ABORTED') throw error;
        // Read-only capture may race document/context destruction; never retry actions.
        if (context !== this.context) throw fail('BROWSER_CLOSED');
        failureReason = state.revision !== startingRevision ? 'snapshot_changed_during_capture' : 'snapshot_capture_failed';
      }
    }
    const metadata = this.referenceState.metadata();
    this.referenceState.forget(failureReason); this.refs.clear();
    return { status: 'observation_unavailable', reason: failureReason, attempts: 3, snapshot_metadata: metadata,
      capture_metadata: { session, page_id: this.referenceState.page(page).id, documents: this.referenceState.versions(this.referenceState.page(page)) },
      message: 'A consistent snapshot could not be registered after three read-only attempts. Request a new snapshot before choosing a target; no action was replayed.' };
  }
  async rejectReference(rejection, signal) {
    // Resolve captures diagnostics BEFORE this read-only refresh replaces the snapshot.
    const observation = await this.observe(signal);
    return skippedReference('stale_reference', observation, rejection.diagnostics);
  }
  async resolveReference(target, signal) {
    const resolved = await this.referenceState.resolve(this.currentPage, this.owner, target);
    if (signal?.aborted) throw fail('OPERATION_ABORTED');
    return resolved;
  }
  async rejectTargetRead(target, signal) {
    const resolved = await this.resolveReference(target, signal);
    return this.rejectReference(resolved.reason ? resolved : { diagnostics: this.referenceState.diagnostic(target, 'target_resolution_failed', resolved.entry) }, signal);
  }
  async performTargetAction(name, args, signal) {
    const resolved = await this.resolveReference(args.target, signal);
    if (resolved.reason) return this.rejectReference(resolved, signal);
    const handle = resolved.handle;
    if (name === 'browser_type') {
      let type, autocomplete;
      try { type = await handle.getAttribute('type'); autocomplete = await handle.getAttribute('autocomplete'); }
      catch { return this.rejectTargetRead(args.target, signal); }
      if (['password', 'email', 'tel'].includes(type) || /password|username|one-time-code/i.test(autocomplete || '')) return skippedReference('needs_login', { status: 'needs_login' });
    }
    if (await this.loginState()) return skippedReference('needs_login', { status: 'needs_login' });
    const finalCheck = await this.resolveReference(args.target, signal);
    if (finalCheck.reason) return this.rejectReference(finalCheck, signal);
    const options = { timeout: 8000 };
    try {
      // Exact retained ElementHandles never re-resolve a reused ID, semantic
      // selector or coordinate after navigation. Dispatch each action only once.
      if (name === 'browser_click') await handle[args.doubleClick ? 'dblclick' : 'click']({ ...options, button: args.button, modifiers: args.modifiers });
      else if (name === 'browser_select_option') await handle.selectOption(args.values, options);
      else if (name === 'browser_type') {
        await handle[args.slowly ? 'type' : 'fill'](args.text, options);
        if (args.submit) await handle.press('Enter', options);
      } else throw fail('BROWSER_TOOL_NOT_ALLOWED');
    } catch (error) {
      if (signal?.aborted) throw fail('OPERATION_ABORTED');
      // An input may have been delivered before a timeout. Do not claim it was
      // skipped or successful, and never retry an action with an uncertain outcome.
      const observation = await this.observe(signal);
      return { ...observation, status: observation.status === 'needs_login' ? 'needs_login' : 'action_failed', action_outcome: 'unknown', reason: 'action_outcome_unknown',
        message: 'The exact-target action did not complete reliably. It was not replayed; inspect the observation before choosing the next call.' };
    }
    return this.observe(signal);
  }
  async call(owner, name, args, signal) {
    return this.exclusive(owner, async () => {
      await this.start(); if (signal?.aborted) throw fail('OPERATION_ABORTED');
      if (!allowed.has(name)) throw fail('BROWSER_TOOL_NOT_ALLOWED');
      if (args && Object.hasOwn(args, 'target')) {
        const target = normalizeSnapshotReference(args.target);
        if (target === null) return skippedReference('invalid_reference');
        args = { ...args, target };
      }
      if (!this.validators.get(name)?.(args)) throw fail('BROWSER_TOOL_NOT_ALLOWED');
      if (name !== 'browser_navigate' && await this.loginState()) return skippedReference('needs_login', await this.observe(signal));
      if (name === 'browser_navigate' || args.url) { const url = sourceFetch.validateSourceUrl(args.url); await sourceFetch.resolvePublicTarget(url); }
      if (name === 'browser_tabs' && args.action === 'close') throw fail('BROWSER_TOOL_NOT_ALLOWED');
      // Forbid snapshot files, arbitrary selectors and excessive waits.
      if (args.filename || (args.time && args.time > 5)) throw fail('BROWSER_TOOL_NOT_ALLOWED');
      const abort = () => { void this.close(owner); }; signal?.addEventListener('abort', abort, { once: true });
      try {
        if (args.target) {
          if (name === 'browser_snapshot') {
            const resolved = await this.resolveReference(args.target, signal);
            return resolved.reason ? await this.rejectReference(resolved, signal) : await this.observe(signal);
          }
          return await this.performTargetAction(name, args, signal);
        }
        if (name !== 'browser_snapshot') {
          const result = await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 35000 });
          if (name === 'browser_tabs' && args.action === 'select') this.currentPage = this.context.pages()[args.index];
          if (name === 'browser_tabs' && args.action === 'new') this.currentPage = this.context.pages().at(-1);
          if (result.isError) throw Object.assign(new Error(redactBrowserText(result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Browser action failed').slice(0, 1000)), { code: 'BROWSER_MCP_ERROR' });
        }
        // Never forward raw MCP diagnostics, action code, network logs or URLs.
        return await this.observe(signal);
      } finally { signal?.removeEventListener('abort', abort); }
    }).catch(error => this.operationFailed(owner, error));
  }
  async locator(target) {
    target = normalizeSnapshotReference(target);
    if (target === null) throw fail('INVALID_REFERENCE');
    const result = await this.resolveReference(target);
    if (result.reason) throw Object.assign(fail('STALE_REFERENCE'), { diagnostics: result.diagnostics });
    return result.handle;
  }
  async captureArticle(owner, target, signal) {
    return this.exclusive(owner, async () => {
      await this.start(); if (signal?.aborted) throw fail('OPERATION_ABORTED');
      target = normalizeSnapshotReference(target, { allowLatestDownload: true });
      if (target === null) return skippedReference('invalid_reference');
      if (await this.loginState()) return skippedReference('needs_login', await this.observe(signal));
      let url;
      if (target === 'latest_download') {
        const observed = this.lastDownloads.at(-1); if (!observed) throw fail('NO_OBSERVED_DOWNLOAD'); url = new URL(observed);
      } else {
        const resolved = await this.resolveReference(target, signal);
        if (resolved.reason) return this.rejectReference(resolved, signal);
        const locator = resolved.handle;
        let href, baseURI;
        try { href = await locator.getAttribute('href'); baseURI = await locator.evaluate(element => element.ownerDocument.baseURI); }
        catch { return this.rejectTargetRead(target, signal); }
        if (!href) throw fail('ARTICLE_LINK_REQUIRED');
        url = new URL(href, baseURI);
        if (await this.loginState()) return skippedReference('needs_login', { status: 'needs_login' });
        const finalCheck = await this.resolveReference(target, signal);
        if (finalCheck.reason) return this.rejectReference(finalCheck, signal);
      }
      sourceFetch.validateSourceUrl(url.href);
      // Credentials stay in host memory. Recompute cookies per redirect origin;
      // the bounded source fetcher pins public DNS and never logs headers.
      return sourceFetch.fetchSource(url.href, { signal, totalMs: 45000, maxBytes: 32 * 1024 * 1024,
        request: async (next, address, options) => {
          const cookies = await this.context.cookies(next.href);
          const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          return sourceFetch.requestOnce(next, address, { ...options, hostHeaders: cookie ? { Cookie: cookie } : {} });
        } });
    });
  }
  async close(owner, error) {
    if (owner !== undefined && this.owner !== owner) return;
    const previousOwner = this.owner;
    this.owner = null;
    this.referenceState.newSession();
    this.refs.clear(); this.lastDownloads = []; this.generation++; this.lifecycle++;
    const client = this.client, server = this.server, context = this.context;
    this.client = null; this.server = null; this.context = null; this.currentPage = null;
    if (previousOwner && error) {
      console.error('literature.browser.closed', { jobId: previousOwner, ownerId: previousOwner, code: error.code, message: redactBrowserText(error.message).slice(0, 1000) });
      this.emit('ownership-lost', { ownerId: previousOwner, error: Object.assign(error, { ownerId: previousOwner }) });
    }
    const disposal = (async () => { await client?.close().catch(() => {}); await server?.close().catch(() => {}); await context?.close().catch(() => {}); })();
    this.closing = Promise.all([this.closing, disposal]);
    await this.closing;
  }
}
