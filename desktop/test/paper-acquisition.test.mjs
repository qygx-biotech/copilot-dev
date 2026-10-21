import test from 'node:test';
import assert from 'node:assert/strict';
import { acquirePaperPdf, paperPageLinks, paperPdfLinks } from '../services/paper-acquisition.mjs';
import { openAccessCandidates, arxivId, requestedIsPreprint, clearOpenAccessCache, browserOnly } from '../services/open-access-sources.mjs';
import { titleEvidence, verifyParsed } from '../services/paper-verification.mjs';

const pdf = Buffer.from('%PDF-1.7\nfixture');
const html = markup => ({ bytes: Buffer.from(markup), contentType: 'text/html' });
const record = { title: 'Enzyme engineering with deep learning', authors: ['Alice Smith'], year: 2024, doi: '10.1000/test', source_urls: [] };
const noLookup = async paper => ({ doi: paper.doi, ids: {}, candidates: [], diagnostics: [] });
const acquire = (paper, fetchSource, extra = {}) => acquirePaperPdf(paper, { signal: new AbortController().signal, fetchSource, lookup: noLookup, wait: async () => {}, ...extra });

test('citation PDF declarations outrank page links and supplementary files are never candidates', () => {
  assert.deepEqual(paperPdfLinks('<meta content="/a.pdf?a=1&amp;b=2" name="citation_pdf_url">', 'https://example.org/p'), ['https://example.org/a.pdf?a=1&b=2']);
  const links = paperPageLinks(`<a href="/static-content/esm/art%3A10.1038%2Fnbt.3519/MediaObjects/41587_2016_BFnbt3519_MOESM482_ESM.pdf">Supplementary</a>
    <a href="/articles/nbt.3519.pdf">Download PDF</a><meta name="citation_pdf_url" content="https://www.nature.com/articles/nbt.3519.pdf">`, 'https://www.nature.com/articles/nbt.3519');
  assert.deepEqual(links.pdfs, ['https://www.nature.com/articles/nbt.3519.pdf']);
  assert.deepEqual(links.declared, ['https://www.nature.com/articles/nbt.3519.pdf']);
  for (const target of ['javascript:alert(1)', 'file:///etc/passwd', 'http://127.0.0.1/admin']) {
    assert.equal(paperPageLinks(`<meta http-equiv="refresh" content="0;url=${target}">`, 'https://example.org/article').redirect, '');
  }
  assert.deepEqual(paperPageLinks('<script>const x = \'<meta name="citation_pdf_url" content="/wrong.pdf">\';</script>', 'https://example.org/article').pdfs, []);
  assert.throws(() => paperPageLinks('<meta name="citation_doi" content="10.9999/other">', 'https://example.org/a', '10.1000/test'), { code: 'PAPER_IDENTITY_MISMATCH' });
});

test('HTML meta refresh reaches an article and its declared PDF without executing scripts', async () => {
  const calls = [];
  const result = await acquire({ ...record, source_urls: ['https://papers.example.org/article'] }, async url => {
    calls.push(url);
    if (url.endsWith('/article')) return { ...html('<META HTTP-EQUIV="REFRESH" content="2; url=\'/retrieve?article=1&amp;view=full\'"><script>throw new Error("never run")</script>'), resolvedUrl: url };
    if (url.includes('/retrieve?')) return { ...html('<meta name="citation_doi" content="https://doi.org/10.1000/test"><meta name="citation_pdf_url" content="/paper.pdf">'), resolvedUrl: url };
    if (url.endsWith('/paper.pdf')) return { bytes: pdf, contentType: 'application/pdf', resolvedUrl: url };
    throw Object.assign(new Error('not found'), { code: 'HTTP_ERROR', httpStatus: 404 });
  });
  assert.equal(result.fetched.resolvedUrl, 'https://papers.example.org/paper.pdf');
  assert.equal(calls[1], 'https://papers.example.org/retrieve?article=1&view=full');
  assert.deepEqual(result.attempts.map(item => item.code).slice(0, 2), ['HTML_REDIRECT', 'PDF_LINKS_FOUND']);
});

test('a redirect loop and a PDF-suffixed HTML page never yield a file; an independent candidate can succeed', async () => {
  const loop = await acquire({ ...record, doi: '', source_urls: ['https://papers.example.org/start'] }, async url => ({ ...html('<meta http-equiv="refresh" content="0;url=/start">'), resolvedUrl: url }));
  assert.equal(loop.fetched, undefined); assert.equal(loop.attempts.at(-1).code, 'HTML_REDIRECT_LOOP');
  const lookup = async () => ({ doi: '10.1000/test', ids: {}, diagnostics: [], candidates: [
    { url: 'https://papers.example.org/bad.pdf', route: 'open_access_location', version: 'published', kind: 'pdf' },
    { url: 'https://repository.example.org/good.pdf', route: 'open_access_location', version: 'published', kind: 'pdf' }] });
  const result = await acquire(record, async url => url.includes('/bad.') ? { bytes: Buffer.from('<html>Not a PDF</html>'), contentType: 'application/pdf', resolvedUrl: url }
    : { bytes: pdf, contentType: 'application/pdf', resolvedUrl: url }, { lookup });
  assert.equal(result.fetched.resolvedUrl, 'https://repository.example.org/good.pdf');
  assert.equal(result.attempts[0].code, 'INVALID_PDF');
});

test('Elsevier declared destination survives a failing temporary redirect; publisher hosts that refuse scripts become browser targets', async () => {
  const start = 'https://linkinghub.elsevier.com/retrieve/pii/S0167779924000283';
  const target = 'https://www.cell.com/trends/biotechnology/fulltext/S0167-7799(24)00028-3';
  const result = await acquire({ ...record, source_urls: [start] }, async url => {
    if (url === start) return { ...html(`<meta http-equiv="refresh" content="0;url=/retrieve/articleSelectPrefsTemp?Redirect=${encodeURIComponent(target)}&amp;key=fixture">`), resolvedUrl: url };
    if (url.includes('articleSelectPrefsTemp')) throw Object.assign(new Error('temporary'), { code: 'HTTP_ERROR', httpStatus: 503 });
    throw Object.assign(new Error('unexpected'), { code: 'HTTP_ERROR', httpStatus: 404 });
  });
  assert.equal(result.fetched, undefined);
  // cell.com refuses scripted clients; the article is handed to the library browser instead of being fetched.
  assert(result.browserTargets.some(item => item.url === target));
  assert(result.attempts.some(item => item.code === 'HTTP_ERROR' && item.httpStatus === 503));
  assert.equal(browserOnly('https://www.sciencedirect.com/science/article/pii/X'), true);
  assert.equal(browserOnly('https://www.biorxiv.org/content/10.1101/x.full.pdf'), false);
});

test('a PDF of another paper or version keeps the sequence going and is returned only as a quarantine candidate', async () => {
  const lookup = async () => ({ doi: '10.1000/test', ids: {}, diagnostics: [], candidates: [
    { url: 'https://a.example.org/wrong.pdf', route: 'open_access_location', version: 'published', kind: 'pdf' },
    { url: 'https://b.example.org/right.pdf', route: 'open_access_location', version: 'published', kind: 'pdf' }] });
  const seen = [];
  const verify = async (fetched, item) => { seen.push(item.url); return { accepted: item.url.includes('right'), receipt: { identity: item.url.includes('right') ? 'doi' : 'unverified' } }; };
  const good = await acquire(record, async url => ({ bytes: pdf, contentType: 'application/pdf', resolvedUrl: url }), { lookup, verify });
  assert.equal(good.fetched.resolvedUrl, 'https://b.example.org/right.pdf'); assert.equal(good.receipt.identity, 'doi');
  assert.deepEqual(seen, ['https://a.example.org/wrong.pdf', 'https://b.example.org/right.pdf']);
  const none = await acquire(record, async url => ({ bytes: pdf, contentType: 'application/pdf', resolvedUrl: url }), { lookup, verify: async () => ({ accepted: false, receipt: { identity: 'unverified' } }) });
  assert.equal(none.fetched, undefined); assert.equal(none.unverified.url, 'https://a.example.org/wrong.pdf');
});

test('the publisher landing is tried last and handed to the browser when it refuses the transfer', async () => {
  const lookup = async () => ({ doi: '10.1000/test', ids: {}, diagnostics: [], candidates: [], publisherUrl: 'https://publisher.example.org/article/1' });
  const result = await acquire(record, async () => { throw Object.assign(new Error('forbidden'), { code: 'HTTP_ERROR', httpStatus: 403 }); }, { lookup });
  assert.deepEqual(result.browserTargets.map(item => [item.url, item.route, item.version]), [['https://publisher.example.org/article/1', 'publisher', 'published']]);
  const preprint = await acquire({ ...record, doi: '10.48550/arXiv.1706.03762' }, async () => { throw Object.assign(new Error('x'), { code: 'HTTP_ERROR', httpStatus: 403 }); });
  assert(!preprint.browserTargets.some(item => item.route === 'publisher'));
});

test('open-access candidates come from official services, carry declared versions and prefer the version of record', async t => {
  clearOpenAccessCache(); t.after(clearOpenAccessCache);
  const json = value => ({ bytes: Buffer.from(JSON.stringify(value)), contentType: 'application/json' });
  const requested = [];
  const fetchSource = async url => {
    requested.push(new URL(url).hostname);
    if (url.startsWith('https://api.openalex.org/')) return json({ ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/27096365' }, open_access: { is_oa: true }, locations: [
      { is_oa: true, landing_page_url: 'https://doi.org/10.1038/nature17946', pdf_url: null, version: 'publishedVersion' },
      { is_oa: true, landing_page_url: 'https://www.biorxiv.org/content/10.1101/1', pdf_url: 'https://www.biorxiv.org/content/10.1101/1.full.pdf', version: 'acceptedVersion' },
      { is_oa: false, landing_page_url: 'https://closed.example.org/x', pdf_url: 'https://closed.example.org/x.pdf', version: 'publishedVersion' }] });
    if (url.startsWith('https://api.unpaywall.org/')) return json({ is_oa: true, oa_locations: [{ url_for_pdf: 'https://repo.example.org/supplement/MOESM1_ESM.pdf', version: 'publishedVersion' }] });
    if (url.includes('/idconv/')) return json({ records: [{ doi: '10.1038/nature17946', pmcid: 'PMC4873371', pmid: 27096365 }] });
    if (url.startsWith('https://doi.org/api/handles/')) return json({ values: [{ type: 'URL', data: { value: 'https://www.nature.com/articles/nature17946' } }] });
    if (url.includes('list-type=2')) return { bytes: Buffer.from('<Key>PMC4873371.1/PMC4873371.1.json</Key><Key>PMC4873371.1/PMC4873371.1.pdf</Key>'), contentType: 'application/xml' };
    if (url.endsWith('PMC4873371.1.json')) return { bytes: Buffer.from(JSON.stringify({ doi: '10.1038/nature17946', is_manuscript: true, license_code: 'TDM',
      pdf_url: 's3://pmc-oa-opendata/PMC4873371.1/PMC4873371.1.pdf?md5=x' })), contentType: 'binary/octet-stream' };
    throw Object.assign(new Error('unexpected ' + url), { code: 'HTTP_ERROR', httpStatus: 404 });
  };
  const found = await openAccessCandidates({ doi: '10.1038/nature17946', title: 'x', authors: [] }, { fetchSource, signal: new AbortController().signal });
  assert.equal(found.ids.pmcid, 'PMC4873371'); assert.equal(found.publisherUrl, 'https://www.nature.com/articles/nature17946');
  assert.deepEqual(found.candidates.map(item => [item.route, item.version, item.url]), [
    // A DOI link to this paper is rewritten to the registry's publisher URL.
    ['open_access_landing', 'published', 'https://www.nature.com/articles/nature17946'],
    ['pmc_open_data', 'accepted_manuscript', 'https://pmc-oa-opendata.s3.amazonaws.com/PMC4873371.1/PMC4873371.1.pdf'],
    // Preprint servers host preprints, whatever the index says.
    ['open_access_location', 'preprint', 'https://www.biorxiv.org/content/10.1101/1.full.pdf'],
    ['open_access_landing', 'preprint', 'https://www.biorxiv.org/content/10.1101/1']]);
  assert(!found.candidates.some(item => /closed|MOESM/.test(item.url)));
  const publishedOnly = await openAccessCandidates({ doi: '10.1038/nature17946', title: 'x', authors: [] }, { fetchSource, acceptedVersions: ['published'] });
  assert.deepEqual(publishedOnly.candidates.map(item => item.version), ['published']);
  assert.deepEqual(publishedOnly.skippedVersions.sort(), ['accepted_manuscript', 'preprint', 'preprint']);
  // Lookups are cached for the session: a second call sends no request.
  const count = requested.length; await openAccessCandidates({ doi: '10.1038/nature17946', title: 'x', authors: [] }, { fetchSource });
  assert.equal(requested.length, count);
});

test('arXiv identifiers and preprint requests are recognized from DOIs, identifiers and links', () => {
  assert.equal(arxivId({ doi: '10.48550/arXiv.1706.03762' }), '1706.03762');
  assert.equal(arxivId({ identifiers: { arxiv: '2101.00001v2' } }), '2101.00001');
  assert.equal(arxivId({ source_urls: ['https://arxiv.org/abs/2203.12345'] }), '2203.12345');
  assert.equal(arxivId({ doi: '10.1000/x', source_urls: ['https://example.org/p'] }), '');
  assert.equal(requestedIsPreprint({ doi: '10.1101/2022.07.20.500902' }), true);
  assert.equal(requestedIsPreprint({ doi: '10.1038/nature17946' }), false);
});

test('title evidence tolerates text-layer spacing and number words; a first-page DOI corroborates a mangled title', () => {
  assert.equal(titleEvidence('ff14SB: Improving the Accuracy of Protein Side Chain and Backbone Parameters from ff99SB',
    { text: 'ff 14SB: Improving the Accuracy of Protein Side Chain and Backbone Parameters from ff 99SB James Maier' }).basis, 'spacing');
  assert.equal(titleEvidence('Accurate prediction of protein structures and interactions using a three-track neural network',
    { text: 'Accurate prediction of protein structures and interactions using a 3-track neural network Minkyung Baek' }).match, true);
  const receipt = (parsed, extra = {}) => verifyParsed({ pages: 12, metadata: '', ...parsed }, { sha256: 'a'.repeat(64), bytes: 10 },
    { title: 'Near-optimal probabilistic RNA-seq quantification', authors: ['Nicolas L Bray'], year: 2016, doi: '10.1038/nbt.3519' }, ['published'], extra);
  const mangled = { text: 'nature biotechnology doi:10.1038/nbt.3519 We present kallisto ... Bray Pimentel 2016', firstPage: 'nature biotechnology doi:10.1038/nbt.3519 Bray Pimentel' };
  assert.equal(receipt(mangled).identity, 'doi');
  // A cited DOI in the references with no title is not identity.
  assert.equal(receipt({ text: 'Another paper References 10.1038/nbt.3519', firstPage: 'Another paper' }).identity, 'unverified');
  // A two-page correction notice carrying the full title is not the article.
  assert.equal(receipt({ pages: 1, text: 'Author Correction: Near-optimal probabilistic RNA-seq quantification Bray 2016 doi:10.1038/nbt.3519', firstPage: 'Author Correction: Near-optimal probabilistic RNA-seq quantification' }).identity, 'unverified');
  // The supplying route outranks first-page wording for the version.
  assert.deepEqual([receipt(mangled, { declaredVersion: 'accepted_manuscript' }).version, receipt(mangled, { declaredVersion: 'accepted_manuscript' }).version_basis], ['accepted_manuscript', 'source']);
  assert.deepEqual([receipt(mangled, { route: 'institutional' }).version, receipt(mangled, { route: 'institutional' }).version_basis], ['published', 'route']);
  assert.equal(receipt(mangled).version, 'unknown');
});
