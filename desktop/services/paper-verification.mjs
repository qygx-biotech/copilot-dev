import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import contract from '../../shared/literature-agent.js';
const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export async function parsePdf(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  let document;
  try {
    document = await loading.promise;
    if (!document.numPages || document.numPages > 1000) throw new Error('PDF_PAGE_LIMIT');
    let text = '';
    // Parse every page for validity; retain a bounded identity excerpt.
    for (let page = 1; page <= document.numPages; page++) {
      const content = await (await document.getPage(page)).getTextContent();
      if (page <= 3) text += content.items.map(item => item.str || '').join(' ') + '\n';
    }
    return { pages: document.numPages, text: text.slice(0, 100000) };
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
export async function verifyPaper(bytes, requested, acceptedVersions, { parse = parsePdfBounded, signal } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 32 * 1024 * 1024 || !bytes.subarray(0, 8).toString().startsWith('%PDF-')) throw Object.assign(new Error('INVALID_PDF'), { code: 'INVALID_PDF' });
  let parsed; try { parsed = await parse(bytes, signal); } catch { throw Object.assign(new Error('PDF_PARSE_FAILED'), { code: 'PDF_PARSE_FAILED' }); }
  const text = normalize(parsed.text), title = normalize(requested.title);
  const doi = contract.doi(requested.doi);
  const doiMatch = doi && [...parsed.text.matchAll(/10\.\d{4,9}\/[^\s<>"]+/gi)].some(match => contract.doi(match[0]).replace(/[.,;)]+$/, '') === doi);
  const metadataMatch = title.length >= 12 && text.includes(title) && requested.year && text.includes(String(requested.year)) && requested.authors.length && requested.authors.some(author => { const last = normalize(author).split(' ').at(-1); return last?.length >= 3 && text.includes(last); });
  // DOI anywhere can be a reference. Require title corroboration as well.
  const identity = doiMatch && title.length >= 12 && text.includes(title) ? 'doi' : metadataMatch ? 'title_authors_year' : 'unverified';
  const version = /accepted (?:author )?manuscript|author accepted manuscript/i.test(parsed.text) ? 'accepted_manuscript'
    : /preprint|arxiv:\s*\d|biorxiv|medrxiv/i.test(parsed.text.slice(0, 3000)) ? 'preprint'
      : /version of record|published version/i.test(parsed.text.slice(0, 5000)) ? 'published' : 'unknown';
  return contract.validate(contract.receipt, { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, pages: parsed.pages,
    identity, version, version_accepted: acceptedVersions.includes(version), verified_at: new Date().toISOString(), transfer_complete: true, parsed: true });
}
