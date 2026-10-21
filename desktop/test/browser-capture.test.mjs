import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { captureArticle, attentionCleared } from '../services/browser-article-capture.mjs';
import { seedBrowserPreferences } from '../services/playwright-mcp-client.mjs';

const pdf = Buffer.from('%PDF-1.7\nFixture article\n%%EOF');
const page = body => `<!doctype html><html><head>${body.head || ''}<title>${body.title || 'Article'}</title></head><body>${body.body || ''}</body></html>`;
const routes = {
  '/article': page({ head: '<meta name="citation_doi" content="10.1000/fixture"><meta name="citation_pdf_url" content="/files/article.pdf">', body: '<a href="/files/MediaObjects/s1_ESM.pdf">Supplementary</a><h1>Fixture article</h1>' }),
  '/viewer-article': page({ head: '<meta name="citation_pdf_url" content="/doi/pdf/10.1000/fixture">' }),
  '/doi/pdf/10.1000/fixture': page({ body: '<iframe src="/viewer"></iframe>Reader' }),
  '/login': page({ title: 'Institution sign in', body: '<form><input name="user"><input type="password" name="pass"></form>' }),
  '/hidden-login': page({ head: '<meta name="citation_pdf_url" content="/files/article.pdf">', body: '<template><input type="password"></template><div style="display:none"><input type="password"></div>' }),
  '/challenge': page({ title: 'Just a moment...', body: 'Checking your browser before accessing the site.' }),
  '/paywall': page({ head: '<meta name="citation_doi" content="10.1000/fixture">', body: 'Access through your institution. Purchase this article for $39.' }),
};
async function server(t) {
  const instance = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/files/article.pdf' || (url.pathname === '/doi/pdf/10.1000/fixture' && url.searchParams.get('download') === 'true')) {
      res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(pdf); return;
    }
    const body = routes[url.pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' }); res.end(body || 'missing');
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve)); t.after(() => instance.close());
  return `http://127.0.0.1:${instance.address().port}`;
}

test('real Chrome captures declared article PDFs and classifies sign-in, checks and paywalls', { skip: process.env.PLAYWRIGHT_MCP_SMOKE !== '1' }, async t => {
  const base = await server(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-capture-')); t.after(() => rm(root, { recursive: true, force: true }));
  await seedBrowserPreferences(root);
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(root, { channel: 'chrome', headless: true, acceptDownloads: true });
  t.after(() => context.close());
  const run = async (url, extra = {}) => { const tab = await context.newPage(); try { return await captureArticle(context, tab, { url, doi: '10.1000/fixture', challengeWaitMs: 1500, ...extra }); } finally { await tab.close(); } };
  const article = await run(`${base}/article`);
  assert.equal(article.status, 'downloaded'); assert.deepEqual(article.bytes, pdf); assert.match(article.resolvedUrl, /\/files\/article\.pdf$/);
  const viewer = await run(`${base}/viewer-article`);
  assert.equal(viewer.status, 'downloaded'); assert.match(viewer.resolvedUrl, /download=true/);
  assert.equal((await run(`${base}/login`)).status, 'needs_login');
  assert.equal((await run(`${base}/hidden-login`)).status, 'downloaded', 'hidden password templates are not a sign-in page');
  assert.equal((await run(`${base}/challenge`)).status, 'needs_attention');
  assert.deepEqual(await run(`${base}/paywall`), { status: 'access_unavailable', reason: 'paywall' });
  assert.equal((await run(`${base}/article`, { doi: '10.9999/other' })).reason, 'PAPER_IDENTITY_MISMATCH');
  const tab = await context.newPage();
  await tab.goto(`${base}/login`); assert.equal(await attentionCleared(tab), false);
  await tab.goto(`${base}/article`); assert.equal(await attentionCleared(tab), true);
});
