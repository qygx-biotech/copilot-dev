import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Ajv from 'ajv/dist/2020.js';
import contract from '../../shared/literature-agent.js';
import sourceFetch from '../../shared/source-fetch.js';
import { EventEmitter } from 'node:events';

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
      const observePage = page => {
        page.on('close', () => {
          if (this.context !== context) return;
          this.refs.clear(); this.generation++;
          const remaining = context.pages().filter(page => !page.isClosed());
          if (!remaining.length) closed();
          else if (this.currentPage === page) this.currentPage = remaining[0];
        });
        page.on('download', download => { if (this.context === context) { this.lastDownloads.push(download.url()); this.lastDownloads = this.lastDownloads.slice(-4); } });
        page.on('framenavigated', frame => { if (this.context === context && frame === page.mainFrame()) { this.refs.clear(); this.generation++; } });
      };
      this.currentPage = context.pages()[0];
      context.pages().forEach(observePage); context.on('page', observePage);
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
      this.tools = listed.tools.filter(tool => allowed.has(tool.name));
      this.validators = new Map(this.tools.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
    })().catch(async error => {
      const wrapped = error.code === 'BROWSER_CLOSED' ? error : Object.assign(new Error(error.message || 'Browser unavailable', { cause: error }), { code: 'BROWSER_UNAVAILABLE' });
      if (this.lifecycle === startLifecycle) await this.close(startOwner ?? undefined, wrapped);
      throw wrapped;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }
  async exclusive(owner, fn) {
    if (this.owner && this.owner !== owner) throw Object.assign(new Error(`Browser is owned by active job ${this.owner}.`), { code: 'BROWSER_BUSY', ownerId: this.owner, jobId: owner });
    if (!this.owner) { this.refs.clear(); this.lastDownloads = []; }
    this.owner = owner;
    const run = async () => { if (this.owner !== owner) throw fail('BROWSER_OWNERSHIP_LOST'); return fn(); };
    const result = this.queue.then(run, run); this.queue = result.catch(() => {}); return result;
  }
  release(owner) { if (this.owner === owner) { this.owner = null; this.refs.clear(); } }
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
    if (await this.loginState()) { this.refs.clear(); return { status: 'needs_login', instruction: 'Complete sign-in directly in the dedicated browser, then select Resume.' }; }
    const result = await this.client.callTool({ name: 'browser_snapshot', arguments: {} }, undefined, { signal, timeout: 30000 });
    const raw = result.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') || '';
    if (result.isError) throw Object.assign(new Error(redactBrowserText(raw).slice(0, 1000) || 'Browser snapshot failed'), { code: 'BROWSER_MCP_ERROR' });
    const pageUrl = raw.match(/^- Page URL: (.+)$/m)?.[1];
    const matchingPages = this.context.pages().filter(page => page.url() === pageUrl);
    if (matchingPages.length === 1) this.currentPage = matchingPages[0];
    if (await this.loginState()) { this.refs.clear(); return { status: 'needs_login' }; }
    const snapshot = redactBrowserText(raw).slice(0, 24000);
    this.refs = new Set([...snapshot.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)].map(x => x[1]));
    return { status: result.isError ? 'unresolved' : 'observed', snapshot, generation: this.generation, truncated: raw.length > 24000 };
  }
  async call(owner, name, args, signal) {
    return this.exclusive(owner, async () => {
      await this.start(); if (signal?.aborted) throw fail('OPERATION_ABORTED');
      if (!allowed.has(name) || !this.validators.get(name)?.(args)) throw fail('BROWSER_TOOL_NOT_ALLOWED');
      if (name !== 'browser_navigate' && await this.loginState()) return this.observe(signal);
      for (const key of ['target']) if (args[key] && !this.refs.has(args[key])) return { status: 'stale_reference', ...(await this.observe(signal)) };
      if (name === 'browser_navigate' || args.url) { const url = sourceFetch.validateSourceUrl(args.url); await sourceFetch.resolvePublicTarget(url); }
      if (name === 'browser_tabs' && args.action === 'close') throw fail('BROWSER_TOOL_NOT_ALLOWED');
      // Forbid snapshot files, arbitrary selectors and excessive waits.
      if (args.filename || (args.time && args.time > 5)) throw fail('BROWSER_TOOL_NOT_ALLOWED');
      if (name === 'browser_type') {
        const matching = await this.locator(args.target);
        const type = await matching.getAttribute('type'); const autocomplete = await matching.getAttribute('autocomplete');
        if (['password', 'email', 'tel'].includes(type) || /password|username|one-time-code/i.test(autocomplete || '')) return { status: 'needs_login' };
      }
      const abort = () => { void this.close(owner); }; signal?.addEventListener('abort', abort, { once: true });
      try {
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
    if (!this.refs.has(target)) throw fail('STALE_REFERENCE');
    const candidates = [];
    for (const page of this.currentPage && !this.currentPage.isClosed() ? [this.currentPage] : this.context.pages()) { const locator = page.locator(`aria-ref=${target}`); if (await locator.count().catch(() => 0)) candidates.push(locator); }
    if (candidates.length === 1) return candidates[0];
    throw fail(candidates.length ? 'AMBIGUOUS_TAB_REFERENCE' : 'STALE_REFERENCE');
  }
  async captureArticle(owner, target, signal) {
    return this.exclusive(owner, async () => {
      await this.start(); if (await this.loginState()) throw fail('NEEDS_LOGIN');
      let url;
      if (target === 'latest_download') {
        const observed = this.lastDownloads.at(-1); if (!observed) throw fail('NO_OBSERVED_DOWNLOAD'); url = new URL(observed);
      } else {
        const locator = await this.locator(target);
        const href = await locator.getAttribute('href');
        if (!href) throw fail('ARTICLE_LINK_REQUIRED');
        url = new URL(href, await locator.evaluate(element => element.ownerDocument.baseURI));
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
