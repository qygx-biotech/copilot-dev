import sourceFetch from '../../shared/source-fetch.js';

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
  const canonicalDoi = value => String(value || '').trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '').toLowerCase();
  const declaredDoi = tags.find(a => a.tag === 'meta' && a.name?.toLowerCase() === 'citation_doi')?.content;
  if (expectedDoi && declaredDoi && canonicalDoi(declaredDoi) !== canonicalDoi(expectedDoi)) throw failure('PAPER_IDENTITY_MISMATCH');
  const base = safeLink(tags.find(a => a.tag === 'base')?.href || pageUrl, pageUrl) || pageUrl;
  const pdfs = [];
  let redirect = '';
  for (const a of tags) {
    if (a.tag === 'meta' && a['http-equiv']?.toLowerCase() === 'refresh' && !redirect) {
      const match = a.content?.match(/^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.+?)\s*$/i);
      if (match) redirect = safeLink(match[1].replace(/^(['"])([\s\S]*)\1$/, '$2'), base);
    }
    const raw = a.tag === 'meta' && a.name?.toLowerCase() === 'citation_pdf_url' ? a.content
      : a.type?.toLowerCase() === 'application/pdf' || /(?:\.pdf(?:[?#]|$)|\/(?:pdf|pdfft|epdf)\/?(?:[?#]|$)|[?&]pdf=render(?:&|$))/i.test(a.href || '') ? a.href : '';
    const url = raw && safeLink(raw, base);
    if (url && !pdfs.includes(url) && pdfs.length < 6) pdfs.push(url);
  }
  const title = markup.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const challenge = /checking your browser|just a moment|verify (?:you are|you're) human|access denied|captcha/i.test(title);
  let publisherLanding = '';
  // Elsevier's public linking page declares its article destination inside a
  // preferences redirect. Preserve that destination if the temporary hop fails.
  if (redirect && new URL(pageUrl).hostname === 'linkinghub.elsevier.com') {
    const hop = new URL(redirect);
    const target = hop.hostname === 'linkinghub.elsevier.com' && hop.searchParams.get('Redirect');
    const safe = target && safeLink(target, redirect);
    if (safe && ['cell.com', 'www.cell.com', 'sciencedirect.com', 'www.sciencedirect.com'].includes(new URL(safe).hostname)) publisherLanding = safe;
  }
  return { pdfs, redirect, publisherLanding, challenge };
}

export const paperPdfLinks = (html, pageUrl, expectedDoi) => paperPageLinks(html, pageUrl, expectedDoi).pdfs;

export function paperCandidateUrls(paper) {
  const pmcids = new Set();
  if (/^PMC\d{1,12}$/.test(paper.identifiers?.pmcid || '')) pmcids.add(paper.identifiers.pmcid);
  for (const location of paper.locations || []) {
    try {
      const url = new URL(location.url);
      if (!['europepmc.org', 'www.europepmc.org', 'pmc.ncbi.nlm.nih.gov', 'www.ncbi.nlm.nih.gov'].includes(url.hostname)) continue;
      const id = url.pathname.match(/\/(?:pmc\/)?articles\/(?:PMC)?(\d{1,12})(?:\/|$)/i)?.[1];
      if (id) pmcids.add('PMC' + id);
    } catch { /* Ignore malformed candidate metadata. */ }
  }
  const priority = location => {
    const host = new URL(location.url).hostname;
    const repository = ['europepmc.org', 'arxiv.org', 'biorxiv.org', 'medrxiv.org', 'hal.science', 'zenodo.org', 'iacr.org', 'pmc.ncbi.nlm.nih.gov']
      .some(domain => host === domain || host.endsWith('.' + domain));
    return location.kind === 'pdf_candidate' ? repository ? 0 : 1 : 2;
  };
  const locations = (paper.locations || []).filter(item => safeLink(item.url, item.url)).sort((a, b) => priority(a) - priority(b));
  return [...new Set([
    ...[...pmcids].map(id => `https://europepmc.org/articles/${id}?pdf=render`),
    ...locations.map(item => item.url),
    ...[...pmcids].map(id => `https://pmc.ncbi.nlm.nih.gov/articles/${id}/pdf/`),
  ])].slice(0, 16);
}

export async function acquirePaperPdf(paper, { signal, ensureCurrent, fetchSource = sourceFetch.fetchSource }) {
  const queue = paperCandidateUrls(paper).map(url => ({ url, depth: 0 }));
  const attempted = new Set(), attempts = [];
  const recordAttempt = (url, code, httpStatus) => {
    // Keep five-paper continuation results bounded even with long publisher tokens.
    const truncated = url.length > 700;
    attempts.push({ url: truncated ? url.slice(0, 700) : url, code, ...(truncated ? { url_truncated: true } : {}),
      ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}) });
  };
  const deadline = Date.now() + 90000;
  while (queue.length && attempted.size < 16 && Date.now() < deadline) {
    ensureCurrent();
    const { url, depth } = queue.shift();
    if (attempted.has(url)) continue;
    attempted.add(url);
    try {
      const fetched = await fetchSource(url, { signal, totalMs: Math.min(25000, deadline - Date.now()) });
      ensureCurrent();
      // Validate bytes even for declared application/pdf and injected transports.
      fetched.contentType = sourceFetch.detectContentType(fetched.bytes, fetched.contentType);
      if (fetched.contentType === 'application/pdf') return { fetched, url, attempts };
      if (!['text/html', 'application/xhtml+xml'].includes(fetched.contentType)) {
        recordAttempt(url, 'NOT_PDF');
        continue;
      }
      const links = paperPageLinks(fetched.bytes.toString('utf8'), fetched.resolvedUrl, paper.doi);
      if (links.challenge) { recordAttempt(url, 'ACCESS_CHALLENGE'); continue; }
      const newPdfs = links.pdfs.filter(link => !attempted.has(link)).map(url => ({ url, depth: 0 }));
      queue.unshift(...newPdfs);
      let code = newPdfs.length ? 'PDF_LINKS_FOUND' : 'HTML_NO_PDF_LINK';
      if (links.redirect && !newPdfs.length) {
        code = depth >= 5 ? 'HTML_REDIRECT_LIMIT' : attempted.has(links.redirect) ? 'HTML_REDIRECT_LOOP' : 'HTML_REDIRECT';
        if (code === 'HTML_REDIRECT') {
          const targets = [links.redirect, links.publisherLanding].filter(link => link && !attempted.has(link));
          queue.unshift(...targets.map(url => ({ url, depth: depth + 1 })));
        }
      }
      recordAttempt(url, code);
    } catch (error) {
      if (signal.aborted || error.code === 'OPERATION_ABORTED') throw error;
      recordAttempt(url, /^[A-Z_]{1,80}$/.test(error.code || '') ? error.code : 'DOWNLOAD_FAILED', error.httpStatus);
    }
  }
  return { attempts, exhausted: queue.some(item => !attempted.has(item.url)) ? 'ACQUISITION_BUDGET_EXHAUSTED' : 'CANDIDATE_URLS_EXHAUSTED' };
}
