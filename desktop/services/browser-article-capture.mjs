// Deterministic article capture in the user's library browser. No model is
// involved: the host opens the article, reads the publisher's own PDF
// declaration and lets Chrome download it with the session the user holds.
import { readFile, stat } from 'node:fs/promises';
import { SUPPLEMENT } from './open-access-sources.mjs';

const failure = code => Object.assign(new Error(code), { code });
const MAX_BYTES = 32 * 1024 * 1024;
// Sign-in, single sign-on and multi-factor hosts or paths.
const SIGN_IN = /(?:^|[./-])(?:login|logon|signin|sign-in|sso|idp|shibboleth|wayf|cas|auth|authenticate|saml|oauth|mfa|duosecurity|okta|microsoftonline|openathens|myopenathens)(?:[./?#-]|$)/i;
const CHALLENGE_TITLE = /just a moment|checking your browser|verify (?:you are|you're) (?:a )?human|attention required|are you a robot|security check|captcha|preparing to download|one more step/i;
const PAYWALL_TEXT = /purchase (?:this|the) article|buy (?:this )?article|rent (?:this )?article|get access|access through your institution|subscribe to (?:this )?journal|log ?in to (?:access|view)|you do not have access|no access|check access|access denied/i;

export function proxiedUrl(prefix, target) {
  if (!prefix) return target;
  // EZproxy "login?url=" takes the raw target; "qurl=" and OpenAthens redirectors take it encoded.
  return /qurl=$|openathens/i.test(prefix) ? prefix + encodeURIComponent(target) : prefix + target;
}

// Inspect the current document as data. Runs inside the page; returns no secrets.
// Client-side redirects can replace the document mid-read; read again once it settles.
async function inspect(page) {
  for (let attempt = 1; ; attempt++) {
    try { return await inspectOnce(page); }
    catch (error) {
      if (attempt >= 4 || !/execution context was destroyed|navigation|frame was detached|target closed/i.test(error.message || '')) throw error;
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500).catch(() => {});
    }
  }
}
async function inspectOnce(page) {
  const state = await page.evaluate(() => {
    const visible = element => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
    const meta = name => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || '';
    // Declarations may be relative to the page.
    const absolute = value => { try { return value ? new URL(value, document.baseURI).href : ''; } catch { return ''; } };
    const anchors = [...document.querySelectorAll('a[href]')].slice(0, 4000);
    const pdfLinks = anchors.filter(a => /\b(?:download )?pdf\b|view pdf|full text pdf|article pdf/i.test((a.textContent || '') + ' ' + (a.getAttribute('aria-label') || '') + ' ' + (a.getAttribute('title') || '')))
      .map(a => a.href).filter(href => /^https?:/i.test(href)).slice(0, 20);
    const frames = [...document.querySelectorAll('iframe')].map(frame => frame.src || '').filter(Boolean).slice(0, 20);
    return { url: location.href, title: document.title.slice(0, 300), contentType: document.contentType,
      citationPdf: absolute(meta('citation_pdf_url')), citationDoi: meta('citation_doi') || meta('dc.identifier') || meta('DC.Identifier'),
      alternatePdf: document.querySelector('link[type="application/pdf"]')?.href || '', pdfLinks,
      password: [...document.querySelectorAll('input[type=password],input[autocomplete=one-time-code]')].some(visible),
      captchaFrame: frames.some(src => /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|captcha/i.test(src)),
      text: (document.body?.innerText || '').slice(0, 6000) };
  });
  // Cross-origin frames (sign-in widgets) are checked through Playwright, never their contents.
  if (!state.password) {
    for (const frame of page.frames().slice(1, 12)) {
      try { if (await frame.locator('input[type=password],input[autocomplete=one-time-code]').filter({ visible: true }).count()) { state.password = true; break; } }
      catch { /* Detached frames are transient, not a failure. */ }
    }
  }
  let host = '';
  try { host = new URL(state.url).hostname + new URL(state.url).pathname; } catch { /* about:blank */ }
  return { ...state, signIn: state.password || (SIGN_IN.test(host) && !state.citationPdf),
    challenge: CHALLENGE_TITLE.test(state.title) || state.captchaFrame || /checking (?:if the site connection is secure|your browser)/i.test(state.text.slice(0, 600)),
    paywall: PAYWALL_TEXT.test(state.text) };
}

const doiOf = value => String(value || '').trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '').toLowerCase();

// Wait for the next download from any page in this context.
function nextDownload(context, timeoutMs, signal) {
  let cleanup = () => {};
  const promise = new Promise((resolve, reject) => {
    const pages = new Set();
    const onDownload = download => { cleanup(); resolve(download); };
    const watch = page => { if (!pages.has(page)) { pages.add(page); page.on('download', onDownload); } };
    context.pages().forEach(watch); context.on('page', watch);
    const timer = setTimeout(() => { cleanup(); reject(failure('DOWNLOAD_NOT_STARTED')); }, timeoutMs);
    const abort = () => { cleanup(); reject(failure('OPERATION_ABORTED')); };
    signal?.addEventListener('abort', abort, { once: true });
    cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); context.off('page', watch); for (const page of pages) page.off('download', onDownload); };
  });
  return { promise, cancel: () => cleanup() };
}

async function readDownload(download, signal) {
  const path = await Promise.race([download.path(), new Promise((_, reject) => setTimeout(() => reject(failure('DOWNLOAD_TIMEOUT')), 90000))]).catch(async error => {
    await download.cancel().catch(() => {}); throw error.code ? error : failure('DOWNLOAD_FAILED');
  });
  if (signal?.aborted) throw failure('OPERATION_ABORTED');
  try {
    if (!path || (await stat(path)).size > MAX_BYTES) throw failure('FILE_TOO_LARGE');
    return await readFile(path);
  } finally { await download.delete().catch(() => {}); }
}

async function settle(page, ms) {
  await page.waitForLoadState('domcontentloaded', { timeout: ms }).catch(() => {});
  await page.waitForTimeout(Math.min(ms, 1200)).catch(() => {});
}

// Navigate; a navigation that turns into a download yields its bytes.
async function open(context, page, url, { signal, timeoutMs }) {
  const download = nextDownload(context, timeoutMs, signal);
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 30000) });
    // Some servers answer with a PDF that Chrome then hands to the download manager.
    const type = response?.headers()['content-type'] || '';
    if (/application\/pdf|application\/octet-stream/i.test(type)) {
      const started = await Promise.race([download.promise, new Promise(resolve => setTimeout(() => resolve(null), 8000))]);
      if (started) return { download: started };
    }
    download.cancel();
    return { response };
  } catch (error) {
    if (/download is starting/i.test(error.message || '')) return { download: await download.promise };
    download.cancel();
    if (signal?.aborted) throw failure('OPERATION_ABORTED');
    if (/timeout/i.test(error.message || '')) return { timedOut: true };
    // A page script that navigates again (redirect chains, SSO hops) supersedes this navigation.
    if (/interrupted by another navigation/i.test(error.message || '')) { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}); return { response: null }; }
    if (/net::ERR_ABORTED/i.test(error.message || '')) {
      const started = await nextDownload(context, 5000, signal).promise.catch(() => null);
      if (started) return { download: started };
    }
    return { error: /net::(ERR_[A-Z_]+)/.exec(error.message || '')?.[1] || 'NAVIGATION_FAILED', detail: String(error.message || '').split('\n')[0].slice(0, 200) };
  }
}

// Atypon platforms (Science, PNAS, ACS, Wiley, T&F, SAGE) serve a viewer at
// /doi/pdf or /doi/epdf and the file itself with ?download=true or /pdfdirect/.
function atyponVariants(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^(.*?)\/doi\/(?:pdf|epdf|pdfdirect|full|abs)\/(10\.\d{4,9}\/.+)$/i);
    if (!match) return [];
    const base = `${parsed.origin}${match[1]}/doi`;
    return [`${base}/pdf/${match[2]}?download=true`, `${base}/pdfdirect/${match[2]}?download=true`];
  } catch { return []; }
}

export async function captureArticle(context, page, { url, doi = '', proxyPrefix = '', signal, timeoutMs = 60000, challengeWaitMs = 8000 }) {
  const start = proxiedUrl(proxyPrefix, url), visited = [];
  let opened = await open(context, page, start, { signal, timeoutMs });
  visited.push(start);
  if (opened.download) return { status: 'downloaded', bytes: await readDownload(opened.download, signal), resolvedUrl: opened.download.url() };
  if (opened.error) return { status: 'unresolved', reason: opened.error, detail: opened.detail };
  await settle(page, 5000);
  let state = await inspect(page);
  // Interstitial checks (proof-of-work, Cloudflare) usually finish by themselves in a real browser.
  for (const deadline = Date.now() + challengeWaitMs; state.challenge && Date.now() < deadline;) {
    const pending = nextDownload(context, 2500, signal);
    const started = await pending.promise.catch(() => null);
    if (started) return { status: 'downloaded', bytes: await readDownload(started, signal), resolvedUrl: started.url() };
    await settle(page, 2000);
    state = await inspect(page);
  }
  if (state.challenge) return { status: 'needs_attention', reason: 'challenge', page_title: state.title.slice(0, 120) };
  if (state.signIn) return { status: 'needs_login', reason: 'sign_in', page_title: state.title.slice(0, 120) };
  if (doi && state.citationDoi && doiOf(state.citationDoi) !== doiOf(doi)) return { status: 'unresolved', reason: 'PAPER_IDENTITY_MISMATCH' };
  const candidates = [state.citationPdf, state.alternatePdf, ...state.pdfLinks]
    .filter(link => link && /^https?:/i.test(link) && !SUPPLEMENT.test(link));
  const queue = [...new Set(candidates.flatMap(link => [link, ...atyponVariants(link)]))].slice(0, 6);
  if (!queue.length) return { status: state.paywall ? 'access_unavailable' : 'unresolved', reason: state.paywall ? 'paywall' : 'no_pdf_link' };
  for (const link of queue) {
    if (visited.includes(link)) continue;
    visited.push(link);
    opened = await open(context, page, link, { signal, timeoutMs });
    if (opened.download) return { status: 'downloaded', bytes: await readDownload(opened.download, signal), resolvedUrl: opened.download.url() };
    if (opened.error || opened.timedOut) continue;
    await settle(page, 4000);
    const after = await inspect(page);
    if (after.signIn) return { status: 'needs_login', reason: 'sign_in', page_title: after.title.slice(0, 120) };
    if (after.challenge) return { status: 'needs_attention', reason: 'challenge', page_title: after.title.slice(0, 120) };
  }
  return { status: state.paywall ? 'access_unavailable' : 'unresolved', reason: state.paywall ? 'paywall' : 'pdf_not_delivered' };
}

// Login or a human check is complete once the page no longer shows either.
export async function attentionCleared(page) {
  try { const state = await inspect(page); return !state.signIn && !state.challenge; }
  catch { return false; }
}
