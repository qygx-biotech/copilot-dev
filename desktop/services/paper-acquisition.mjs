import sourceFetch from '../../shared/source-fetch.js';
import cookies from '../../shared/cookie-jar.js';
import contract from '../../shared/literature-agent.js';
import { openAccessCandidates, browserOnly as defaultBrowserOnly, SUPPLEMENT, USER_AGENT, politeWait, requestedIsPreprint } from './open-access-sources.mjs';

const { CookieJar } = cookies;
const failure = code => Object.assign(new Error(code), { code });
const entities = value => value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, token => {
  const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
  if (named[token.toLowerCase()]) return named[token.toLowerCase()];
  const number = token[2].toLowerCase() === 'x' ? parseInt(token.slice(3, -1), 16) : Number(token.slice(2, -1));
  return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
});
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
  .map(match => [match[1].toLowerCase(), entities(match[2] ?? match[3] ?? match[4] ?? '')]));
const safeLink = (raw, base) => {
  try { return sourceFetch.validateSourceUrl(new URL(raw, base).href).href; } catch { return ''; }
};

export function paperPageLinks(html, pageUrl, expectedDoi = '') {
  // Treat HTML as data. Never execute scripts, forms or browser challenges.
  const markup = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const tags = [...markup.matchAll(/<(meta|link|a|base)\b[^>]*>/gi)].map(match => ({ tag: match[1].toLowerCase(), ...attributes(match[0]) }));
  const declaredDoi = tags.find(a => a.tag === 'meta' && a.name?.toLowerCase() === 'citation_doi')?.content;
  if (expectedDoi && declaredDoi && contract.doi(declaredDoi) !== contract.doi(expectedDoi)) throw failure('PAPER_IDENTITY_MISMATCH');
  const base = safeLink(tags.find(a => a.tag === 'base')?.href || pageUrl, pageUrl) || pageUrl;
  // The article's own PDF declaration outranks page links, which often point
  // at supplementary files, figures or other articles.
  const declared = [], linked = [];
  let redirect = '';
  for (const a of tags) {
    if (a.tag === 'meta' && a['http-equiv']?.toLowerCase() === 'refresh' && !redirect) {
      const match = a.content?.match(/^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.+?)\s*$/i);
      if (match) redirect = safeLink(match[1].replace(/^(['"])([\s\S]*)\1$/, '$2'), base);
    }
    if (a.tag === 'meta' && a.name?.toLowerCase() === 'citation_pdf_url') { const url = safeLink(a.content || '', base); if (url) declared.push(url); continue; }
    if (a.tag === 'link' && a.type?.toLowerCase() === 'application/pdf' && /alternate/i.test(a.rel || '')) { const url = safeLink(a.href || '', base); if (url) declared.push(url); continue; }
    const raw = a.type?.toLowerCase() === 'application/pdf' || /(?:\.pdf(?:[?#]|$)|\/(?:pdf|pdfft|pdfdirect)\/?(?:[?#]|$)|\/doi\/(?:pdf|pdfdirect)\/|[?&]pdf=render(?:&|$))/i.test(a.href || '') ? a.href : '';
    const url = raw && safeLink(raw, base);
    if (url) linked.push(url);
  }
  const pdfs = [...new Set([...declared, ...linked])].filter(url => !SUPPLEMENT.test(url)).slice(0, 6);
  const title = markup.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const challenge = /checking your browser|just a moment|verify (?:you are|you're) human|access denied|captcha|attention required/i.test(title);
  let publisherLanding = '';
  // Elsevier's public linking page declares its article destination inside a
  // preferences redirect. Preserve that destination if the temporary hop fails.
  if (redirect && new URL(pageUrl).hostname === 'linkinghub.elsevier.com') {
    const hop = new URL(redirect);
    const target = hop.hostname === 'linkinghub.elsevier.com' && hop.searchParams.get('Redirect');
    const safe = target && safeLink(target, redirect);
    if (safe && ['cell.com', 'www.cell.com', 'sciencedirect.com', 'www.sciencedirect.com'].includes(new URL(safe).hostname)) publisherLanding = safe;
  }
  return { pdfs, declared: declared.filter(url => !SUPPLEMENT.test(url)), redirect, publisherLanding, challenge };
}

export const paperPdfLinks = (html, pageUrl, expectedDoi) => paperPageLinks(html, pageUrl, expectedDoi).pdfs;

const VERSION_RANK = { published: 0, accepted_manuscript: 1, unknown: 2, preprint: 3 };
const challengeProne = url => /(?:^|\.)(?:europepmc\.org|ncbi\.nlm\.nih\.gov)$/i.test((() => { try { return new URL(url).hostname; } catch { return ''; } })());

// One paper, bounded: official open copies first, then the publisher's own
// declared PDF over plain HTTP. Routes that need an interactive browser are
// returned as browser targets instead of being retried here.
export async function acquirePaperPdf(paper, { signal, ensureCurrent = () => {}, fetchSource = sourceFetch.fetchSource, deadlineAt = Infinity,
  acceptedVersions = contract.versions, openAlexKey, browserOnly = defaultBrowserOnly, lookup = openAccessCandidates, wait = politeWait, verify } = {}) {
  const attempts = [], browserTargets = [], attempted = new Set(), jar = new CookieJar();
  let unverified = null;
  const deadline = Math.min(Date.now() + 75000, deadlineAt);
  const record = (url, code, extra = {}) => {
    const truncated = url.length > 700;
    attempts.push({ url: truncated ? url.slice(0, 700) : url, code, ...(truncated ? { url_truncated: true } : {}), ...extra });
  };
  let found;
  try { found = await lookup(paper, { signal, fetchSource, openAlexKey, acceptedVersions }); }
  catch (error) {
    if (signal?.aborted || error.code === 'OPERATION_ABORTED') throw failure('OPERATION_ABORTED');
    found = { doi: contract.doi(paper.doi), ids: {}, candidates: [], diagnostics: [{ route: 'open_access_lookup', code: /^[A-Z_]{1,80}$/.test(error.code || '') ? error.code : 'LOOKUP_FAILED' }] };
  }
  ensureCurrent();
  for (const item of found.diagnostics || []) record('', item.code, { route: item.route, ...(item.httpStatus ? { httpStatus: item.httpStatus } : {}) });
  const queue = (found.candidates || []).map(item => ({ ...item, depth: 0 }));
  for (const url of paper.source_urls || []) {
    if (!SUPPLEMENT.test(url)) queue.push({ url, route: 'source_url', version: 'unknown', kind: /\.pdf(?:[?#]|$)|\/pdf\//i.test(url) ? 'pdf' : 'landing', depth: 0 });
  }
  const doi = found.doi || contract.doi(paper.doi);
  // The registry-resolved landing page avoids a doomed transfer to hosts that refuse scripts.
  if (doi && /^10\.\d{4,9}\/\S+$/.test(doi) && !requestedIsPreprint(paper)) queue.push({ url: found.publisherUrl || `https://doi.org/${doi}`, route: 'publisher', version: 'published', kind: 'landing', depth: 0 });
  const toBrowser = item => { if (!browserTargets.some(target => target.url === item.url)) browserTargets.push({ url: item.url, route: item.route, version: item.version, kind: item.kind }); };
  while (queue.length && Date.now() < deadline) {
    ensureCurrent();
    const item = queue.shift();
    if (attempted.has(item.url)) continue;
    attempted.add(item.url);
    if (browserOnly(item.url)) { toBrowser(item); record(item.url, 'BROWSER_REQUIRED', { route: item.route }); continue; }
    try {
      await wait(item.url, signal);
      const fetched = await fetchSource(item.url, { signal, cookieJar: jar, decompress: true, userAgent: USER_AGENT, maxRedirects: 10,
        maxBytes: 32 * 1024 * 1024, accept: item.kind === 'pdf' ? 'application/pdf,*/*;q=0.5' : 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5',
        totalMs: Math.max(1000, Math.min(item.route === 'publisher' ? 15000 : 25000, deadline - Date.now())) });
      ensureCurrent();
      // Validate bytes even for declared application/pdf and injected transports.
      fetched.contentType = sourceFetch.detectContentType(fetched.bytes, fetched.contentType);
      if (fetched.contentType === 'application/pdf') {
        const found_ = { fetched, url: item.url, route: item.route, version: item.version, attempts, browserTargets, ids: found.ids || {} };
        // An optional verifier keeps searching past a PDF of another paper or an unaccepted version.
        const receipt = verify ? await verify(fetched, item) : null;
        if (!verify || receipt?.accepted) return { ...found_, receipt: receipt?.receipt };
        record(item.url, 'IDENTITY_OR_VERSION_UNVERIFIED', { route: item.route });
        unverified ||= { ...found_, receipt: receipt?.receipt };
        continue;
      }
      if (!['text/html', 'application/xhtml+xml'].includes(fetched.contentType)) { record(item.url, 'NOT_PDF', { route: item.route }); continue; }
      if (browserOnly(fetched.resolvedUrl)) { toBrowser({ ...item, url: fetched.resolvedUrl }); record(item.url, 'BROWSER_REQUIRED', { route: item.route }); continue; }
      const links = paperPageLinks(fetched.bytes.toString('utf8'), fetched.resolvedUrl, doi);
      if (links.challenge) { toBrowser({ ...item, url: fetched.resolvedUrl }); record(item.url, 'ACCESS_CHALLENGE', { route: item.route }); continue; }
      const newPdfs = links.pdfs.filter(link => !attempted.has(link)).map(url => ({ url, route: item.route, version: item.version, kind: 'pdf', depth: item.depth }));
      queue.unshift(...newPdfs);
      let code = newPdfs.length ? 'PDF_LINKS_FOUND' : 'HTML_NO_PDF_LINK';
      if (links.redirect && !newPdfs.length) {
        code = item.depth >= 5 ? 'HTML_REDIRECT_LIMIT' : attempted.has(links.redirect) ? 'HTML_REDIRECT_LOOP' : 'HTML_REDIRECT';
        if (code === 'HTML_REDIRECT') {
          const targets = [links.redirect, links.publisherLanding].filter(link => link && !attempted.has(link));
          queue.unshift(...targets.map(url => ({ url, route: item.route, version: item.version, kind: 'landing', depth: item.depth + 1 })));
        }
      }
      // A publisher landing without an open PDF still identifies the article for institutional access.
      if (!newPdfs.length && item.route === 'publisher') toBrowser({ ...item, url: item.url });
      record(item.url, code, { route: item.route });
    } catch (error) {
      if (signal?.aborted || error.code === 'OPERATION_ABORTED') throw failure('OPERATION_ABORTED');
      const code = /^[A-Z_]{1,80}$/.test(error.code || '') ? error.code : 'DOWNLOAD_FAILED';
      record(item.url, code, { route: item.route, ...(Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {}) });
      // Publishers often refuse scripted clients; the article may still open in a browser.
      if (code !== 'PAPER_IDENTITY_MISMATCH' && (item.route === 'publisher' || (code === 'HTTP_ERROR' && [401, 403, 429].includes(error.httpStatus)))) toBrowser(item);
    }
  }
  // Browser order: version of record first; bot-checked repositories last.
  browserTargets.sort((a, b) => (VERSION_RANK[a.version] ?? 2) - (VERSION_RANK[b.version] ?? 2) || Number(challengeProne(a.url)) - Number(challengeProne(b.url)));
  return { attempts, browserTargets, ids: found.ids || {}, ...(unverified ? { unverified } : {}),
    exhausted: queue.some(item => !attempted.has(item.url)) ? 'ACQUISITION_BUDGET_EXHAUSTED' : 'CANDIDATE_URLS_EXHAUSTED' };
}
