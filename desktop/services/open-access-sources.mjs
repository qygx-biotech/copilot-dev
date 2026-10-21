// Deterministic open-access discovery for one requested paper. Every route here
// is an official, documented service; nothing imitates a browser. Results are
// ordered candidates with the document version each source declares.
import sourceFetch from '../../shared/source-fetch.js';
import contract from '../../shared/literature-agent.js';

// The app's contact address for polite API use (OpenAlex, Unpaywall, NCBI).
// It identifies the application, never the user. Override with BIODESIGN_CONTACT_EMAIL.
export const CONTACT_EMAIL = process.env.BIODESIGN_CONTACT_EMAIL || 'biodesign-copilot@example.org';
// The app's established downloader name. Some publishers answer agents named
// after AI assistants with HTTP 406, so the name stays descriptive of the task.
export const USER_AGENT = `BioDesign-Source-Downloader/1.1 (+mailto:${CONTACT_EMAIL})`;

// Hosts that answer scripted clients with a bot check, a 403 or a stalled
// connection while serving the same PDF to an interactive browser. Skipping
// them over HTTP saves the time limit; the browser stage tries them instead.
export const BROWSER_ONLY_HOSTS = ['europepmc.org', 'pmc.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov', 'sciencedirect.com', 'cell.com', 'onlinelibrary.wiley.com', 'academic.oup.com', 'science.org', 'pnas.org', 'tandfonline.com',
  'journals.sagepub.com', 'researchgate.net'];
export const SUPPLEMENT = /MediaObjects|_ESM\.pdf|[/_-]moesm|supplement|[/_.-]suppl(?:[/_.-]|ementary)|\/si\/|[_-]s\d{1,3}\.pdf(?:[?#]|$)|\/sup-\d+|appendix/i;

const VERSION_NAMES = { publishedVersion: 'published', acceptedVersion: 'accepted_manuscript', submittedVersion: 'preprint' };
const VERSION_RANK = { published: 0, accepted_manuscript: 1, unknown: 2, preprint: 3 };
const failure = code => Object.assign(new Error(code), { code });
const hostOf = value => { try { return new URL(value).hostname.toLowerCase(); } catch { return ''; } };
const onHost = (value, hosts) => { const host = hostOf(value); return hosts.some(item => host === item || host.endsWith('.' + item)); };
export const browserOnly = url => onHost(url, BROWSER_ONLY_HOSTS);

// Shared, process-wide politeness: per-host spacing and a small response cache.
const throttle = new Map();
const HOST_INTERVAL_MS = { 'arxiv.org': 3000, 'export.arxiv.org': 3000, 'api.openalex.org': 150, 'api.unpaywall.org': 150, 'pmc.ncbi.nlm.nih.gov': 400,
  'pmc-oa-opendata.s3.amazonaws.com': 100, 'doi.org': 300, 'api.biorxiv.org': 500 };
export async function politeWait(url, signal, intervalMs) {
  const host = hostOf(url);
  const spacing = intervalMs ?? HOST_INTERVAL_MS[host] ?? 1500;
  const ready = (throttle.get(host) || 0);
  throttle.set(host, Math.max(Date.now(), ready) + spacing);
  const delay = ready - Date.now();
  if (delay > 0) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, delay);
    const stop = () => { clearTimeout(timer); reject(failure('OPERATION_ABORTED')); };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
}
const cache = new Map();
const CACHE_MS = 30 * 60000;
async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}
export function clearOpenAccessCache() { cache.clear(); throttle.clear(); }

async function getJson(url, { signal, fetchSource = sourceFetch.fetchSource, totalMs = 15000 }) {
  await politeWait(url, signal);
  const fetched = await fetchSource(url, { signal, totalMs, maxBytes: 4 * 1024 * 1024, decompress: true, userAgent: USER_AGENT, accept: 'application/json', anyContentType: true });
  try { return JSON.parse(fetched.bytes.toString('utf8')); } catch { throw failure('INVALID_PROVIDER_RESPONSE'); }
}
async function getText(url, { signal, fetchSource = sourceFetch.fetchSource, totalMs = 15000, accept = 'application/xml,text/*;q=0.8' }) {
  await politeWait(url, signal);
  const fetched = await fetchSource(url, { signal, totalMs, maxBytes: 4 * 1024 * 1024, decompress: true, userAgent: USER_AGENT, accept, anyContentType: true });
  return fetched.bytes.toString('utf8');
}
const doiPath = doi => encodeURIComponent(doi).replace(/%2F/gi, '/');
const notFound = error => error?.code === 'HTTP_ERROR' && [404, 410, 422].includes(error.httpStatus);

export function arxivId(paper) {
  const values = [paper.identifiers?.arxiv, paper.doi, ...(paper.source_urls || []), ...(paper.locations || []).map(item => item.url)];
  for (const value of values) {
    const match = String(value || '').match(/(?:arxiv[.:/]|arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5})(?:v\d+)?/i)
      || (value === paper.identifiers?.arxiv ? String(value).match(/^(\d{4}\.\d{4,5})(?:v\d+)?$/) : null);
    if (match) return match[1];
  }
  return '';
}
export const preprintServer = doi => /^10\.1101\//.test(doi || '') ? 'biorxiv' : '';
// The requested identity itself is a preprint; its preprint copy is the record.
export const requestedIsPreprint = paper => /^10\.48550\/arxiv\./i.test(contract.doi(paper.doi)) || Boolean(preprintServer(contract.doi(paper.doi)))
  || (!paper.doi && Boolean(arxivId(paper)));

export async function openAlexWork(doi, { signal, fetchSource, apiKey } = {}) {
  return cached(`openalex:${doi}`, async () => {
    const params = new URLSearchParams({ mailto: CONTACT_EMAIL, select: 'id,doi,title,publication_year,ids,open_access,best_oa_location,locations' });
    if (apiKey) params.set('api_key', apiKey);
    try { return await getJson(`https://api.openalex.org/works/doi:${doiPath(doi)}?${params}`, { signal, fetchSource }); }
    catch (error) { if (notFound(error)) return null; throw error; }
  });
}
export async function unpaywallRecord(doi, { signal, fetchSource } = {}) {
  return cached(`unpaywall:${doi}`, async () => {
    try { return await getJson(`https://api.unpaywall.org/v2/${doiPath(doi)}?email=${encodeURIComponent(CONTACT_EMAIL)}`, { signal, fetchSource }); }
    catch (error) { if (notFound(error)) return null; throw error; }
  });
}
export async function pubmedIds(doi, { signal, fetchSource } = {}) {
  return cached(`idconv:${doi}`, async () => {
    const params = new URLSearchParams({ ids: doi, format: 'json', tool: 'biodesign-copilot', email: CONTACT_EMAIL });
    const value = await getJson(`https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?${params}`, { signal, fetchSource });
    const record = value?.records?.find(item => contract.doi(item.doi) === doi) || null;
    return record ? { pmcid: /^PMC\d+$/.test(record.pmcid || '') ? record.pmcid : '', pmid: /^\d+$/.test(String(record.pmid || '')) ? String(record.pmid) : '' } : null;
  });
}
// PMC's official open-data bucket. Its JSON declares whether the copy is an
// author manuscript and links the PDF when one exists.
export async function pmcOpenData(pmcid, { signal, fetchSource } = {}) {
  return cached(`pmc-s3:${pmcid}`, async () => {
    const listing = await getText(`https://pmc-oa-opendata.s3.amazonaws.com/?list-type=2&prefix=${pmcid}.&max-keys=200`, { signal, fetchSource });
    const versions = [...listing.matchAll(new RegExp(`<Key>${pmcid}\\.(\\d+)/${pmcid}\\.\\1\\.json</Key>`, 'g'))].map(match => Number(match[1]));
    if (!versions.length) return null;
    const latest = Math.max(...versions);
    const record = await getJson(`https://pmc-oa-opendata.s3.amazonaws.com/${pmcid}.${latest}/${pmcid}.${latest}.json`, { signal, fetchSource });
    const pdf = String(record?.pdf_url || '').match(/^s3:\/\/pmc-oa-opendata\/([^?]+\.pdf)/)?.[1];
    return { pmcid, doi: contract.doi(record?.doi), pdf_url: pdf ? `https://pmc-oa-opendata.s3.amazonaws.com/${pdf}` : '',
      version: record?.is_manuscript ? 'accepted_manuscript' : 'published', license: String(record?.license_code || '').slice(0, 100) };
  });
}
export async function biorxivLatest(doi, { signal, fetchSource } = {}) {
  return cached(`biorxiv:${doi}`, async () => {
    for (const server of ['biorxiv', 'medrxiv']) {
      const value = await getJson(`https://api.biorxiv.org/details/${server}/${doiPath(doi)}/na/json`, { signal, fetchSource }).catch(() => null);
      const latest = (value?.collection || []).filter(item => contract.doi(item.doi) === doi).sort((a, b) => Number(b.version) - Number(a.version))[0];
      if (latest) return { server, version: Number(latest.version), published_doi: contract.doi(latest.published) || '' };
    }
    return null;
  });
}

// The DOI registry's own resolution (no publisher contact) tells which host
// serves the article before any transfer is attempted.
export async function doiTarget(doi, { signal, fetchSource } = {}) {
  return cached(`doi:${doi}`, async () => {
    try {
      const value = await getJson(`https://doi.org/api/handles/${doiPath(doi)}?type=URL`, { signal, fetchSource });
      const url = value?.values?.find(item => item.type === 'URL')?.data?.value;
      return url && contract.safeUrl(url) ? url : '';
    } catch (error) { if (notFound(error)) return ''; throw error; }
  });
}

// Preprint servers host preprints whatever an index labels the location.
const PREPRINT_HOSTS = ['arxiv.org', 'biorxiv.org', 'medrxiv.org', 'researchsquare.com', 'preprints.org', 'ssrn.com', 'chemrxiv.org', 'osf.io'];
function addLocation(list, location) {
  const url = location.url && contract.safeUrl(location.url) ? location.url : '';
  if (!url || list.some(item => item.url === url) || SUPPLEMENT.test(url)) return;
  list.push({ ...location, url, ...(onHost(url, PREPRINT_HOSTS) ? { version: 'preprint' } : {}) });
}

// Collect candidates without transferring any article. Lookup failures become
// diagnostics, never a claim that no open copy exists.
export async function openAccessCandidates(paper, { signal, fetchSource, openAlexKey, acceptedVersions = contract.versions } = {}) {
  const doi = contract.doi(paper.doi), diagnostics = [], candidates = [];
  const accepted = version => acceptedVersions.includes(version) || version === 'unknown'
    || (version === 'preprint' && requestedIsPreprint(paper));
  const note = (route, error) => diagnostics.push({ route, code: /^[A-Z_]{1,80}$/.test(error?.code || '') ? error.code : 'LOOKUP_FAILED',
    ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}) });
  const ids = { pmcid: /^PMC\d+$/i.test(paper.identifiers?.pmcid || '') ? paper.identifiers.pmcid.toUpperCase() : '', pmid: paper.identifiers?.pmid || '', arxiv: arxivId(paper) };
  let openAlex = null, unpaywall = null, publisherUrl = '';
  if (doi && !/^10\.48550\//.test(doi)) {
    const [alex, upw, ncbi, target] = await Promise.allSettled([
      openAlexWork(doi, { signal, fetchSource, apiKey: openAlexKey }),
      unpaywallRecord(doi, { signal, fetchSource }),
      ids.pmcid ? Promise.resolve(null) : pubmedIds(doi, { signal, fetchSource }),
      doiTarget(doi, { signal, fetchSource }),
    ]);
    if (signal?.aborted) throw failure('OPERATION_ABORTED');
    if (alex.status === 'fulfilled') openAlex = alex.value; else note('openalex', alex.reason);
    if (upw.status === 'fulfilled') unpaywall = upw.value; else note('unpaywall', upw.reason);
    if (ncbi.status === 'fulfilled' && ncbi.value) { ids.pmcid ||= ncbi.value.pmcid; ids.pmid ||= ncbi.value.pmid; } else if (ncbi.status === 'rejected') note('ncbi_idconv', ncbi.reason);
    if (target.status === 'fulfilled') publisherUrl = target.value; else note('doi_resolution', target.reason);
    const alexPmcid = String(openAlex?.ids?.pmcid || '').match(/PMC\d+|(?<=pmc\/articles\/)\d+/i)?.[0];
    if (!ids.pmcid && alexPmcid) ids.pmcid = alexPmcid.toUpperCase().startsWith('PMC') ? alexPmcid.toUpperCase() : `PMC${alexPmcid}`;
  }
  if (ids.pmcid) {
    try {
      const pmc = await pmcOpenData(ids.pmcid, { signal, fetchSource });
      if (pmc?.pdf_url && (!doi || !pmc.doi || pmc.doi === doi)) addLocation(candidates, { url: pmc.pdf_url, route: 'pmc_open_data', version: pmc.version, license: pmc.license, kind: 'pdf' });
    } catch (error) { note('pmc_open_data', error); }
  }
  const locations = [];
  // A DOI link to this paper is its publisher landing; use the registry's answer directly.
  const ownDoiLink = url => { try { const parsed = new URL(url); return /^(?:dx\.)?doi\.org$/i.test(parsed.hostname) && contract.doi(decodeURIComponent(parsed.pathname.slice(1))) === doi; } catch { return false; } };
  const add = (list, location) => addLocation(list, publisherUrl && ownDoiLink(location.url) ? { ...location, url: publisherUrl } : location);
  for (const item of openAlex?.locations || []) {
    if (!item?.is_oa) continue;
    const version = VERSION_NAMES[item.version] || 'unknown';
    add(locations, { url: item.pdf_url, route: 'open_access_location', version, license: item.license || '', kind: 'pdf' });
    add(locations, { url: item.landing_page_url, route: 'open_access_landing', version, license: item.license || '', kind: 'landing' });
  }
  for (const item of unpaywall?.oa_locations || []) {
    const version = VERSION_NAMES[item.version] || 'unknown';
    add(locations, { url: item.url_for_pdf, route: 'open_access_location', version, license: item.license || '', kind: 'pdf' });
    add(locations, { url: item.url_for_landing_page, route: 'open_access_landing', version, license: item.license || '', kind: 'landing' });
  }
  for (const item of paper.locations || []) add(locations, { url: item.url, route: item.kind === 'pdf_candidate' ? 'open_access_location' : 'open_access_landing',
    version: VERSION_NAMES[item.version] || item.version || 'unknown', kind: item.kind === 'pdf_candidate' ? 'pdf' : 'landing' });
  if (ids.arxiv) addLocation(candidates, { url: `https://arxiv.org/pdf/${ids.arxiv}`, route: 'arxiv', version: 'preprint', kind: 'pdf' });
  const server = preprintServer(doi);
  if (server) {
    try {
      const latest = await biorxivLatest(doi, { signal, fetchSource });
      if (latest) addLocation(candidates, { url: `https://www.${latest.server}.org/content/${doi}v${latest.version}.full.pdf`, route: latest.server, version: 'preprint', kind: 'pdf' });
    } catch (error) { note('biorxiv', error); }
  }
  for (const item of locations) addLocation(candidates, item);
  // Prefer the version of record, then repositories that serve scripts, then landing pages.
  const routeRank = { pmc_open_data: 0, arxiv: 1, biorxiv: 1, medrxiv: 1, open_access_location: 2, open_access_landing: 3 };
  const ordered = candidates.filter(item => accepted(item.version))
    .sort((a, b) => (VERSION_RANK[a.version] - VERSION_RANK[b.version]) || (routeRank[a.route] - routeRank[b.route]) || ((a.kind === 'pdf' ? 0 : 1) - (b.kind === 'pdf' ? 0 : 1)));
  return { doi, ids, candidates: ordered, publisherUrl, skippedVersions: candidates.filter(item => !accepted(item.version)).map(item => item.version),
    isOpenAccess: Boolean(openAlex?.open_access?.is_oa || unpaywall?.is_oa || ordered.length), diagnostics };
}
