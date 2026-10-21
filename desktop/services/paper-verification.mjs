import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import contract from '../../shared/literature-agent.js';
const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// PDF text layers split and respell titles ("ff 14sb", "3-track" for "three-track").
const NUMBER_WORDS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
const canonical = text => normalize(text).replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, word => NUMBER_WORDS[word]);
const compact = text => canonical(text).replace(/ /g, '');
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'via', 'using', 'its', 'their', 'that', 'this', 'are', 'was', 'were', 'between', 'over', 'under', 'within', 'without', 'during', 'after', 'before', 'through', 'based']);
const tokens = text => [...new Set(canonical(text).split(' ').filter(word => word.length >= 3 && !STOPWORDS.has(word)))];

export async function parsePdf(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  let document;
  try {
    document = await loading.promise;
    if (!document.numPages || document.numPages > 1000) throw new Error('PDF_PAGE_LIMIT');
    let text = '', firstPage = '';
    // Parse every page for validity; retain a bounded identity excerpt.
    for (let page = 1; page <= document.numPages; page++) {
      const content = await (await document.getPage(page)).getTextContent();
      if (page <= 3) {
        const pageText = content.items.map(item => item.str || '').join(' ');
        if (page === 1) firstPage = pageText.slice(0, 20000);
        text += pageText + '\n';
      }
    }
    // Publisher PDFs often declare their own title and DOI in document metadata.
    let metadata = '';
    try {
      const { info, metadata: xmp } = await document.getMetadata();
      metadata = [info?.Title, info?.Subject, info?.Keywords, xmp?.get?.('dc:title'), xmp?.get?.('prism:doi'), xmp?.get?.('dc:identifier')]
        .flat().filter(value => typeof value === 'string').join('\n').slice(0, 4000);
    } catch { /* Metadata is optional corroboration. */ }
    return { pages: document.numPages, text: text.slice(0, 100000), firstPage, metadata };
  } finally { await loading.destroy(); }
}
export function parsePdfBounded(bytes, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/pdf-verification-worker.mjs', import.meta.url), { workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const stop = () => finish(new Error('PDF_PARSE_ABORTED'));
    const timer = setTimeout(stop, 20000);
    const finish = (error, result) => { clearTimeout(timer); signal?.removeEventListener('abort', stop); void worker.terminate(); error ? reject(error) : resolve(result); };
    worker.once('message', result => finish(result.error ? new Error(result.error) : null, result.parsed));
    worker.once('error', error => finish(error));
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
  });
}

// How strongly the extracted text carries the requested title.
export function titleEvidence(title, parsed) {
  const wanted = canonical(title), head = canonical(String(parsed.text).slice(0, 12000)), meta = canonical(parsed.metadata || '');
  if (wanted.length < 12) return { match: false, coverage: 0 };
  if (head.includes(wanted) || meta.includes(wanted)) return { match: true, basis: 'exact', coverage: 1 };
  const squeezed = compact(title);
  if (squeezed.length >= 12 && (compact(String(parsed.text).slice(0, 12000)).includes(squeezed) || compact(parsed.metadata || '').includes(squeezed))) return { match: true, basis: 'spacing', coverage: 1 };
  const significant = tokens(title);
  const pool = new Set(`${canonical(parsed.firstPage || String(parsed.text).slice(0, 6000))} ${meta}`.split(' '));
  const coverage = significant.length ? significant.filter(word => pool.has(word)).length / significant.length : 0;
  return { match: significant.length >= 5 && coverage >= 0.85, basis: 'tokens', coverage };
}

const correctionNotice = parsed => parsed.pages <= 2 && /\b(?:author correction|publisher correction|erratum|corrigendum|retraction note|correction to|notice of retraction)\b/i.test(String(parsed.firstPage || parsed.text).slice(0, 2000));
const DOI_PATTERN = /10\.\d{4,9}\/[^\s<>"]+/gi;
const containsDoi = (text, doi) => [...String(text || '').matchAll(DOI_PATTERN)].some(match => contract.doi(match[0]).replace(/[.,;)\]]+$/, '') === doi);

export async function verifyPaper(bytes, requested, acceptedVersions, { parse = parsePdfBounded, signal, declaredVersion, route } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 32 * 1024 * 1024 || !bytes.subarray(0, 8).toString().startsWith('%PDF-')) throw Object.assign(new Error('INVALID_PDF'), { code: 'INVALID_PDF' });
  let parsed; try { parsed = await parse(bytes, signal); } catch { throw Object.assign(new Error('PDF_PARSE_FAILED'), { code: 'PDF_PARSE_FAILED' }); }
  return verifyParsed(parsed, { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, requested, acceptedVersions, { declaredVersion, route });
}

// Identity and version checks over an already parsed document, so one parse
// can serve every requested paper (for example a scan of existing local PDFs).
export function verifyParsed(parsed, { sha256, bytes }, requested, acceptedVersions, { declaredVersion, route } = {}) {
  parsed = { firstPage: '', metadata: '', ...parsed };
  const text = normalize(parsed.text);
  const doi = contract.doi(requested.doi);
  const title = titleEvidence(requested.title, parsed);
  const authorMatch = (requested.authors || []).some(author => { const last = normalize(author).split(' ').at(-1); return last?.length >= 3 && text.includes(last); });
  const yearMatch = Boolean(requested.year && text.includes(String(requested.year)));
  // A DOI anywhere can be a citation. On the first page or in the document
  // metadata it is the article's own identifier, which with an author or
  // most title words suffices when the text layer mangled the title.
  const doiAnywhere = Boolean(doi) && containsDoi(parsed.text, doi);
  const doiDeclared = Boolean(doi) && (containsDoi(parsed.firstPage, doi) || containsDoi(parsed.metadata, doi));
  let identity = doiAnywhere && title.match ? 'doi'
    : doiDeclared && (authorMatch || title.coverage >= 0.6) ? 'doi'
      : title.match && authorMatch && (yearMatch || title.basis !== 'tokens') ? 'title_authors_year' : 'unverified';
  if (correctionNotice(parsed)) identity = 'unverified';
  const detected = /accepted (?:author )?manuscript|author accepted manuscript|author manuscript/i.test(String(parsed.text).slice(0, 5000)) ? 'accepted_manuscript'
    : /preprint|arxiv:\s*\d|biorxiv|medrxiv/i.test(String(parsed.text).slice(0, 3000)) ? 'preprint'
      : /version of record|published version/i.test(String(parsed.text).slice(0, 5000)) ? 'published' : 'unknown';
  // The route that supplied the bytes is better evidence than first-page wording:
  // repositories declare versions, and a publisher's own article PDF is the version of record.
  const fromSource = contract.versions.includes(declaredVersion) && declaredVersion !== 'unknown' ? declaredVersion : '';
  const fromRoute = ['publisher', 'institutional'].includes(route) && detected === 'unknown' ? 'published' : '';
  const version = fromSource || (detected !== 'unknown' ? detected : fromRoute || 'unknown');
  const versionBasis = fromSource ? 'source' : detected !== 'unknown' ? 'document' : fromRoute ? 'route' : 'none';
  return contract.validate(contract.receipt, { sha256, bytes, pages: parsed.pages,
    identity, version, version_accepted: acceptedVersions.includes(version), verified_at: new Date().toISOString(), transfer_complete: true, parsed: true,
    version_basis: versionBasis, ...(identity !== 'unverified' ? { title_match: title.match ? title.basis : 'doi_only' } : {}) });
}
