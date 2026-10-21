import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Ajv from 'ajv/dist/2020.js';
import contract from '../../shared/literature-agent.js';
import sourceFetch from '../../shared/source-fetch.js';
import { EventEmitter } from 'node:events';
import { normalizeSnapshotReference, restrictBrowserTool, skippedReference } from './browser-references.mjs';
import { BrowserReferenceState } from './browser-reference-state.mjs';
import { captureArticle as captureInBrowser, attentionCleared } from './browser-article-capture.mjs';

const fail = code => Object.assign(new Error(code), { code });
const allowed = new Set(['browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_find', 'browser_click', 'browser_type', 'browser_select_option', 'browser_tabs', 'browser_wait_for']);
const authPattern = /(?:^|[\W_])(login|logon|signin|sign-in|authenticate|saml|oauth|mfa|登录|登入|认证)(?:[\W_]|$)/i;
// Shadow libraries distribute copyrighted articles without permission; the browser never visits them.
const SHADOW_LIBRARY = /(?:^|\.)(?:sci-hub|scihub|libgen|annas-archive|z-lib|zlibrary|library\.lol)(?:\.|$)/i;
// Snapshot lines a model can act on. Other lines are context only.
const INTERACTIVE = /^\s*- (?:link|button|textbox|searchbox|combobox|checkbox|radio|menuitem\w*|option|tab|switch|slider|spinbutton|listbox|treeitem)\b/;
const HEADING = /^\s*- heading\b/;
export const SNAPSHOT_LIMIT = 60000;
// Errors that mean the page changed underneath an operation, not that the browser is gone.
const TRANSIENT = /frame was detached|execution context was destroyed|navigation|timeout|interrupted|net::ERR_|target page, context or browser has been closed.*page|element is not attached/i;
export function redactBrowserText(text) {
  return String(text).replace(/https?:\/\/[^\s<>"')\]]+/g, value => contract.safeUrl(value) || '[redacted URL]')
    .replace(/^(.*(?:textbox|searchbox)[^\n]*\[ref=[^\]]+\])[^\n]*$/gm, '$1')
    .replace(/(?:Bearer\s+\S+|(?:cookie|authorization|password|access_token|id_token|session_token)\s*[:=]\s*\S+)/gi, '[redacted]');
}

// Bound what a model reads from one page. Actionable lines and headings are kept
// first; long text is shortened; omitted runs are marked so browser_find can reach them.
export function compactSnapshot(raw, limit = SNAPSHOT_LIMIT) {
  if (raw.length <= limit) return { text: raw, truncated: false };
  const lines = raw.split('\n');
  const shorten = (line, max) => line.length <= max ? line : line.slice(0, max).replace(/\s+\S*$/, '') + ' …';
  const keep = new Array(lines.length).fill(false);
  let used = 0;
  const take = (index, max) => { const size = shorten(lines[index], max).length + 1; if (used + size > limit) return false; keep[index] = shorten(lines[index], max); used += size; return true; };
  for (let index = 0; index < lines.length; index++) if (INTERACTIVE.test(lines[index]) || HEADING.test(lines[index])) take(index, 300);
  for (let index = 0; index < lines.length; index++) if (!keep[index]) take(index, 160);
  const output = [];
  let omitted = 0;
  for (let index = 0; index < lines.length; index++) {
    if (keep[index] === false) { omitted++; continue; }
    if (omitted) { output.push(`- … ${omitted} line(s) omitted; use browser_find to search this page`); omitted = 0; }
    output.push(keep[index]);
  }
  if (omitted) output.push(`- … ${omitted} line(s) omitted; use browser_find to search this page`);
  return { text: output.join('\n'), truncated: true };
}
// Only refs on actionable lines are registered; others are shown without a ref.
function actionableText(snapshot) {
  return snapshot.split('\n').map(line => INTERACTIVE.test(line) ? line : line.replace(/\s*\[ref=(?:f\d+)?e\d+\]/g, '')).join('\n');
}

// Chrome downloads PDFs instead of rendering them, so the host can verify the bytes.
export async function seedBrowserPreferences(profileDirectory) {
  const file = path.join(profileDirectory, 'Default', 'Preferences');
  let preferences = {};
  try { preferences = JSON.parse(await readFile(file, 'utf8')); } catch { /* First launch. */ }
  if (preferences?.plugins?.always_open_pdf_externally === true && preferences?.download?.prompt_for_download === false) return;
  preferences = { ...preferences, plugins: { ...preferences.plugins, always_open_pdf_externally: true }, download: { ...preferences.download, prompt_for_download: false } };
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(preferences), { mode: 0o600 });
}

// The visible browser may reach library proxies on non-standard ports, but
// never local, private or metadata addresses, credentials in URLs or shadow libraries.
export function validateBrowserUrl(value) {
  let url; try { url = new URL(value); } catch { throw fail('INVALID_URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw fail('UNSAFE_URL');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (SHADOW_LIBRARY.test(host)) throw fail('BLOCKED_SITE');
  const standard = new URL(url.href); standard.port = '';
  sourceFetch.validateSourceUrl(standard.href);
  return url;
}

// The local host owns a real MCP server/client pair and the browser context.
// No renderer or model receives Playwright objects, credentials or executable code.
export class PlaywrightMcpClient extends EventEmitter {
  constructor({ profileRoot, headless = false, launch, connect } = {}) {
    super();
    this.baseProfileRoot = profileRoot; this.profileRoot = profileRoot; this.profileKey = null;
    this.headless = headless; this.launch = launch; this.connect = connect;
    this.referenceState = new BrowserReferenceState();
    this.owner = null; this.queue = Promise.resolve(); this.refs = new Set(); this.lastDownloads = []; this.generation = 0; this.lifecycle = 0;
  }
  // One profile per application account keeps library sign-ins across projects.
  async useProfile(key) {
    const next = /^[a-f0-9]{24}$/.test(key || '') ? key : 'default';
    if (this.profileKey === next) return;
    if (this.owner) throw Object.assign(new Error(`Browser is owned by active job ${this.owner}.`), { code: 'BROWSER_BUSY', ownerId: this.owner });
    if (this.context || this.starting) await this.close();
    this.profileKey = next; this.profileRoot = path.join(this.baseProfileRoot, next);
  }
  async start() {
    await this.closing;
    if (this.client) return;
    if (this.starting) return this.starting;
    const startLifecycle = this.lifecycle, startOwner = this.owner;
    this.starting = (async () => {
      await mkdir(this.profileRoot, { recursive: true, mode: 0o700 });
      const profile = path.join(this.profileRoot, 'profile');
      await seedBrowserPreferences(profile).catch(() => {});
      const { chromium } = await import('playwright');
      // Downloads are accepted into Playwright's temporary artifacts directory;
      // only the host reads them, verifies the PDF and decides whether to save it.
      const launched = await (this.launch || chromium.launchPersistentContext.bind(chromium))(profile, {
        channel: 'chrome', headless: this.headless, acceptDownloads: true, serviceWorkers: 'block',
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
        try {
          const request = route.request(), url = validateBrowserUrl(request.url());
          // Documents (navigations, frames) must resolve publicly; subresources are checked by URL only.
          if (request.isNavigationRequest?.() !== false) await sourceFetch.resolvePublicTarget(url);
          await route.continue();
        } catch { await route.abort('blockedbyclient').catch(() => route.abort().catch(() => {})); }
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
      for (const [site, held] of this.attentionPages || []) if (held === page) this.attentionPages.delete(site);
      const remaining = context.pages().filter(page => !page.isClosed());
      if (!remaining.length) closed();
      else if (this.currentPage === page) this.currentPage = remaining[0];
    });
    page.on('download', download => { if (this.context === context) { this.lastDownloads.push(download); this.lastDownloads = this.lastDownloads.slice(-4); } });
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
  // A page event (detached frame, slow navigation) leaves the browser usable.
  // Only a closed or disconnected browser ends the session.
  async operationFailed(owner, error, signal) {
    if (['BROWSER_BUSY', 'BROWSER_TOOL_NOT_ALLOWED', 'STALE_REFERENCE', 'AMBIGUOUS_TAB_REFERENCE', 'OPERATION_ABORTED', 'BLOCKED_SITE', 'UNSAFE_URL', 'INVALID_URL', 'DNS_FAILED'].includes(error.code)) throw error;
    const gone = !this.context || this.owner !== owner || error.code === 'BROWSER_CLOSED' || error.code === 'BROWSER_UNAVAILABLE' || /browser has been closed|browser has disconnected|context closed|context has been closed/i.test(error.message || '');
    if (!gone && (error.code === 'BROWSER_MCP_ERROR' || TRANSIENT.test(error.message || ''))) {
      let observation = { status: 'observation_unavailable' };
      try { observation = await this.observe(signal); } catch { /* Report the failure itself. */ }
      return { ...observation, status: observation.status === 'needs_login' ? 'needs_login' : 'action_failed', action_outcome: 'unknown', reason: 'browser_operation_failed',
        message: `The browser action did not complete: ${redactBrowserText(error.message || '').slice(0, 300)}. The browser remains open; inspect the observation and choose the next call.` };
    }
    const wrapped = error.code?.startsWith('BROWSER_') ? error : Object.assign(new Error(error.message || 'Browser operation failed', { cause: error }), { code: 'BROWSER_OPERATION_FAILED' });
    await this.close(owner, wrapped); throw wrapped;
  }
  async loginState() {
    for (const page of this.currentPage && !this.currentPage.isClosed() ? [this.currentPage] : this.context.pages()) {
      if (authPattern.test(page.url())) return true;
      // Only a visible credential field means sign-in; hidden templates are common on article pages.
      for (const frame of page.frames()) {
        try {
          const fields = frame.locator('input[type=password],input[autocomplete=one-time-code]');
          if (await (typeof fields.filter === 'function' ? fields.filter({ visible: true }) : fields).count()) return true;
        } catch { /* A frame detached while checking is not a sign-in page. */ }
      }
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
        const redacted = redactBrowserText(raw);
        const compacted = compactSnapshot(redacted);
        const snapshot = actionableText(compacted.text);
        if (await this.referenceState.register(page, snapshot, before, revision, this.owner, signal)) {
          this.refs = new Set(this.referenceState.latest.entries.keys()); this.referencePage = page;
          this.lastSnapshot = { page, revision, raw: redacted };
          return { status: 'observed', snapshot, generation: ++this.generation, truncated: compacted.truncated, snapshot_metadata: this.referenceState.metadata() };
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
  // Search the latest full snapshot instead of returning the whole page again.
  async find(args, signal) {
    const latest = this.lastSnapshot;
    if (!latest || latest.page !== this.currentPage || this.referenceState.page(latest.page).revision !== latest.revision || !this.referenceState.latest) return this.observe(signal);
    let pattern;
    try {
      if (args.regex) { const match = /^\/(.*)\/([a-z]*)$/s.exec(args.regex); pattern = new RegExp(match ? match[1] : args.regex, match ? match[2].replace(/[gy]/g, '') : ''); }
      else pattern = { test: line => line.toLowerCase().includes(String(args.text || '').toLowerCase()) };
    } catch { return { status: 'invalid_query', message: 'The regular expression is invalid.' }; }
    const lines = latest.raw.split('\n'), hits = [];
    for (let index = 0; index < lines.length && hits.length < 40; index++) if (pattern.test(lines[index])) hits.push(index);
    const shown = new Set(hits.flatMap(index => [index - 2, index - 1, index, index + 1, index + 2]).filter(index => index >= 0 && index < lines.length));
    const excerpt = actionableText([...shown].sort((a, b) => a - b).map(index => lines[index].slice(0, 300)).join('\n')).slice(0, 20000);
    const added = await this.referenceState.extend(latest.page, [...excerpt.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)].map(match => match[1]), this.owner, signal);
    if (!added) return this.observe(signal);
    this.refs = new Set(this.referenceState.latest.entries.keys());
    return { status: 'observed', snapshot: excerpt || '(no matches)', matches: hits.length, find: true, generation: this.generation, snapshot_metadata: this.referenceState.metadata() };
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
      if (name === 'browser_navigate' || args.url) { const url = validateBrowserUrl(args.url); await sourceFetch.resolvePublicTarget(url); }
      if (name === 'browser_tabs' && args.action === 'close') throw fail('BROWSER_TOOL_NOT_ALLOWED');
      // Forbid snapshot files, arbitrary selectors and excessive waits.
      if (args.filename || (args.time && args.time > 5)) throw fail('BROWSER_TOOL_NOT_ALLOWED');
      const abort = () => { void this.close(owner); }; signal?.addEventListener('abort', abort, { once: true });
      try {
        if (name === 'browser_find') return await this.find(args, signal);
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
    }).catch(error => this.operationFailed(owner, error, signal));
  }
  async locator(target) {
    target = normalizeSnapshotReference(target);
    if (target === null) throw fail('INVALID_REFERENCE');
    const result = await this.resolveReference(target);
    if (result.reason) throw Object.assign(fail('STALE_REFERENCE'), { diagnostics: result.diagnostics });
    return result.handle;
  }
  // Model-directed capture: the observed link is opened in the browser, which
  // downloads the file with the user's session. Bytes go to the host verifier.
  async captureArticle(owner, target, signal) {
    return this.exclusive(owner, async () => {
      await this.start(); if (signal?.aborted) throw fail('OPERATION_ABORTED');
      target = normalizeSnapshotReference(target, { allowLatestDownload: true });
      if (target === null) return skippedReference('invalid_reference');
      if (await this.loginState()) return skippedReference('needs_login', await this.observe(signal));
      if (target === 'latest_download') {
        const download = this.lastDownloads.at(-1); if (!download) throw fail('NO_OBSERVED_DOWNLOAD');
        const result = await this.readDownload(download, signal);
        return { ...result, resolvedUrl: download.url() };
      }
      const resolved = await this.resolveReference(target, signal);
      if (resolved.reason) return this.rejectReference(resolved, signal);
      let href, baseURI;
      try { href = await resolved.handle.getAttribute('href'); baseURI = await resolved.handle.evaluate(element => element.ownerDocument.baseURI); }
      catch { return this.rejectTargetRead(target, signal); }
      if (!href) throw fail('ARTICLE_LINK_REQUIRED');
      const url = new URL(href, baseURI);
      if (await this.loginState()) return skippedReference('needs_login', { status: 'needs_login' });
      const finalCheck = await this.resolveReference(target, signal);
      if (finalCheck.reason) return this.rejectReference(finalCheck, signal);
      validateBrowserUrl(url.href);
      return this.capture({ url: url.href }, signal);
    });
  }
  async readDownload(download, signal) {
    const { readFile: read, stat } = await import('node:fs/promises');
    const file = await download.path();
    if (signal?.aborted) throw fail('OPERATION_ABORTED');
    if (!file || (await stat(file)).size > 32 * 1024 * 1024) throw fail('FILE_TOO_LARGE');
    try { return { bytes: await read(file), contentType: 'application/pdf' }; }
    finally { await download.delete().catch(() => {}); }
  }
  // Runs inside exclusive(): a dedicated tab, closed afterwards unless the
  // user must act on it (sign-in or a human check). One such tab is kept per
  // site, so every site the user must visit is open at once.
  async capture({ url, doi, proxyPrefix }, signal) {
    const page = await this.context.newPage();
    let keep = false;
    try {
      const result = await captureInBrowser(this.context, page, { url, doi, proxyPrefix, signal });
      if (result.status === 'downloaded') {
        const contentType = sourceFetch.detectContentType(result.bytes, 'application/pdf');
        return { bytes: result.bytes, contentType, resolvedUrl: result.resolvedUrl };
      }
      if (['needs_login', 'needs_attention'].includes(result.status)) {
        let site = '';
        try { site = new URL(page.url()).hostname.replace(/^www\./, ''); } catch { /* about:blank */ }
        this.attentionPages ||= new Map();
        if (!this.attentionPages.has(site) && this.attentionPages.size < 6) {
          keep = true; this.attentionPages.set(site, page);
          await page.bringToFront().catch(() => {});
        }
        return { ...result, site, action_skipped: true };
      }
      return { ...result, action_skipped: true };
    } finally { if (!keep) await page.close().catch(() => {}); }
  }
  // Deterministic retrieval: no snapshot or model involvement.
  async fetchArticle(owner, target, signal) {
    return this.exclusive(owner, async () => {
      await this.start(); if (signal?.aborted) throw fail('OPERATION_ABORTED');
      validateBrowserUrl(target.url);
      return this.capture(target, signal);
    }).catch(error => {
      if (error.code === 'OPERATION_ABORTED' || error.code === 'BROWSER_BUSY') throw error;
      if (['BLOCKED_SITE', 'UNSAFE_URL', 'INVALID_URL'].includes(error.code)) return { status: 'unresolved', reason: error.code };
      if (this.context && !/browser has been closed|browser has disconnected|context closed/i.test(error.message || '')) return { status: 'unresolved', reason: 'BROWSER_OPERATION_FAILED' };
      throw Object.assign(new Error(error.message || 'Browser unavailable', { cause: error }), { code: error.code?.startsWith('BROWSER_') ? error.code : 'BROWSER_UNAVAILABLE' });
    });
  }
  // Waits while the user signs in or completes checks in the visible window;
  // done when every waiting tab has cleared or been closed.
  async awaitAttention(owner, { timeoutMs = 10 * 60000, signal } = {}) {
    return this.exclusive(owner, async () => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw fail('OPERATION_ABORTED');
        for (const [site, page] of [...(this.attentionPages || [])]) {
          if (page.isClosed()) { this.attentionPages.delete(site); continue; }
          if (await attentionCleared(page)) { this.attentionPages.delete(site); await page.close().catch(() => {}); }
        }
        if (!this.attentionPages?.size) return { cleared: true };
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      return { cleared: false, reason: 'timeout' };
    });
  }
  async close(owner, error) {
    if (owner !== undefined && this.owner !== owner) return;
    const previousOwner = this.owner;
    this.owner = null;
    this.referenceState.newSession();
    this.refs.clear(); this.lastDownloads = []; this.generation++; this.lifecycle++; this.attentionPages = new Map(); this.lastSnapshot = null;
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
