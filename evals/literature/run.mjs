// Literature benchmarks without a model. `retrieval` runs the production host
// retrieval sequence (local → open access → library browser) on frozen DOIs;
// `collect` runs the predeclared search plans through the local paper MCP.
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import os from 'node:os';
import { cases, retrievalDois } from './cases.mjs';
import { scoreRetrieval } from './score.mjs';
const args = Object.fromEntries(process.argv.slice(2).map(item => { const [key, ...rest] = item.replace(/^--/, '').split('='); return [key, rest.join('=') || true]; }));
const mode = args.mode || 'retrieval';
if (!['retrieval', 'collect'].includes(mode)) throw new Error('Use --mode=retrieval|collect');
const out = path.resolve(args.out || `evals/results/literature-${mode}-${Date.now()}`);
await mkdir(out, { recursive: true });
console.info = () => {};
const { PaperMcpClient } = await import('../../desktop/services/paper-mcp-client.mjs');
const mcp = new PaperMcpClient({ appPath: path.resolve('.') });
let report;
try {
  if (mode === 'collect') {
    const observations = [];
    for (const c of cases.filter(c => !args.case || c.id === args.case)) {
      const started = performance.now();
      const search = { query: c.queries[0], ...(c.queries.length > 1 ? { queries: c.queries.slice(1, 4) } : {}), ...(c.year_from ? { year_from: c.year_from, year_to: c.year_to } : {}) };
      const first = await mcp.call('search_academic_papers', search);
      const second = first.next_cursor ? await mcp.call('search_academic_papers', { ...search, cursor: first.next_cursor }) : null;
      observations.push({ id: c.id, request: c.request, pages: [first, ...(second ? [second] : [])], latency_ms: performance.now() - started });
    }
    report = { version: 2, mode, generated_at: new Date().toISOString(), observations,
      limitations: ['Anonymous provider collection only: no model selection, downloads or relevance judgments.'] };
  } else {
    const { ProjectFilesystem } = await import('../../desktop/services/project-filesystem.mjs');
    const { LiteratureWorkflows } = await import('../../desktop/services/literature-workflows.mjs');
    const { PlaywrightMcpClient } = await import('../../desktop/services/playwright-mcp-client.mjs');
    const { CONTACT_EMAIL } = await import('../../desktop/services/open-access-sources.mjs');
    const dois = args.dois ? String(args.dois).split(',') : retrievalDois.map(item => item.doi);
    const project = await mkdtemp(path.join(os.tmpdir(), 'literature-retrieval-eval-'));
    const profiles = await mkdtemp(path.join(os.tmpdir(), 'literature-retrieval-profiles-'));
    const browser = new PlaywrightMcpClient({ profileRoot: profiles, headless: args.headed !== true });
    const host = new LiteratureWorkflows({ filesystem: await ProjectFilesystem.open(project), sourceDownloads: new AbortController(), paperMcp: mcp }, browser, () => true);
    const policy = { model: 'eval/no-model', permission: 'workspace_write', authorization: { download: true }, scopePaths: null };
    const rows = [];
    try {
      const papers = [];
      for (const doi of dois) {
        // Metadata from OpenAlex, as discovery would hand over.
        const response = await fetch(`https://api.openalex.org/works/doi:${doi}?mailto=${CONTACT_EMAIL}&select=title,publication_year,authorships`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
        const meta = response?.ok ? await response.json() : null;
        const known = retrievalDois.find(item => item.doi === doi);
        papers.push({ title: meta?.title || known?.title || doi, authors: (meta?.authorships || []).slice(0, 8).map(a => a.author?.display_name).filter(Boolean).concat(meta ? [] : known?.authors || []).slice(0, 8),
          year: meta?.publication_year || known?.year || 2000, doi, source_urls: [] });
      }
      for (let offset = 0; offset < papers.length; offset += 20) {
        const batch = papers.slice(offset, offset + 20);
        const job = await host.run({ ...policy, action: 'begin', kind: 'retrieve_papers', task: { papers: batch, accepted_versions: ['published', 'accepted_manuscript', 'preprint'] },
          libraryAccess: { url: typeof args['library-url'] === 'string' ? args['library-url'] : '', ...(typeof args.proxy === 'string' ? { proxy: args.proxy } : {}) } });
        for (let index = 0; index < batch.length; index++) {
          const started = performance.now();
          const result = (await host.run({ ...policy, action: 'step', job_id: job.job_id, name: 'retrieve_next', args: { index } })).result || {};
          rows.push({ doi: batch[index].doi, status: result.status, route: result.route, version: result.document_version, version_basis: result.verification?.version_basis,
            title_match: result.verification?.title_match, source_url: result.source_url, reason: result.reason, ms: Math.round(performance.now() - started) });
        }
        const access = await host.run({ ...policy, action: 'step', job_id: job.job_id, name: 'request_access', args: {} });
        if (access.attention) rows.push({ access_request: access.attention });
        await host.run({ ...policy, action: 'cancel', job_id: job.job_id });
      }
    } finally { await browser.close(); await rm(project, { recursive: true, force: true }); await rm(profiles, { recursive: true, force: true }); }
    const papersOnly = rows.filter(row => row.doi);
    report = { version: 2, mode, generated_at: new Date().toISOString(), headless: args.headed !== true, rows, summary: scoreRetrieval(papersOnly),
      limitations: ['Results depend on the network: an institutional network can reach subscription PDFs without sign-in.', 'Headless Chrome is flagged by some bot checks that a visible window passes; checks never completed by a person stay waiting_for_user.'] };
  }
} finally { await mcp.close(); }
await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ out, mode, ...(report.summary ? { summary: report.summary } : { cases: report.observations.map(o => ({ id: o.id, candidates: o.pages[0]?.total_candidates, latency_ms: Math.round(o.latency_ms) })) }) }, null, 2));
