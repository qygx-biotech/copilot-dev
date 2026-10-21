import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sourceFetch from '../../shared/source-fetch.js';
import cookies from '../../shared/cookie-jar.js';
import { compactSnapshot, validateBrowserUrl, seedBrowserPreferences } from '../services/playwright-mcp-client.mjs';
import { proxiedUrl } from '../services/browser-article-capture.mjs';
import { referenceBrowserFixture } from './helpers/reference-browser-fixture.mjs';

const { CookieJar } = cookies;

test('the cookie jar scopes cookies by domain, path, security and expiry and refuses foreign domains', () => {
  let now = 1000;
  const jar = new CookieJar({ now: () => now });
  jar.store('https://www.nature.com/articles/x', ['session=abc; Path=/; Domain=.nature.com; Secure', 'local=1; Path=/articles', 'evil=1; Domain=example.org', 'tld=1; Domain=com', 'short=1; Max-Age=5']);
  assert.equal(jar.header('https://link.nature.com/'), 'session=abc');
  assert.equal(jar.header('http://www.nature.com/'), '');
  assert.equal(jar.header('https://www.nature.com/articles/y'), 'local=1; short=1; session=abc');
  assert.equal(jar.header('https://example.org/'), '');
  now += 6000;
  assert.equal(jar.header('https://www.nature.com/articles/y'), 'local=1; session=abc');
  jar.store('https://www.nature.com/', ['session=gone; Domain=nature.com; Path=/; Max-Age=0']);
  assert.equal(jar.header('https://www.nature.com/articles/y'), 'local=1');
});

test('a session jar carries cookies across redirects; the redirect limit is per call', async () => {
  const seen = [];
  const request = async (url, _address, options) => {
    seen.push([url.pathname, options.hostHeaders?.Cookie || '']);
    if (url.pathname === '/start') return { redirect: '/check', setCookie: ['idp_session=1; Path=/'] };
    if (url.pathname === '/check') return { redirect: '/article.pdf', setCookie: [] };
    return { bytes: Buffer.from('%PDF-1.7\nfixture'), contentType: 'application/pdf', setCookie: [] };
  };
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const jar = new CookieJar();
  const fetched = await sourceFetch.fetchSource('https://publisher.example.org/start', { request, lookup, cookieJar: jar, maxRedirects: 10 });
  assert.equal(fetched.contentType, 'application/pdf');
  assert.deepEqual(seen, [['/start', ''], ['/check', 'idp_session=1'], ['/article.pdf', 'idp_session=1']]);
  await assert.rejects(sourceFetch.fetchSource('https://publisher.example.org/start', { request, lookup, maxRedirects: 1 }), { code: 'REDIRECT_LIMIT' });
  // Callers that parse API bodies may accept any declared type.
  const apiRequest = async () => ({ bytes: Buffer.from('{"ok":true}'), contentType: 'binary/octet-stream' });
  await assert.rejects(sourceFetch.fetchSource('https://api.example.org/x', { request: apiRequest, lookup }), { code: 'UNSUPPORTED_CONTENT_TYPE' });
  assert.equal((await sourceFetch.fetchSource('https://api.example.org/x', { request: apiRequest, lookup, anyContentType: true })).bytes.toString(), '{"ok":true}');
});

test('compressed responses decode within the byte limit only when requested', async t => {
  const body = Buffer.from('%PDF-1.7\n' + 'x'.repeat(5000));
  const server = http.createServer((req, res) => {
    const encoding = req.url === '/br' ? 'br' : 'gzip';
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-encoding': encoding, 'set-cookie': ['a=1'] });
    res.end(encoding === 'br' ? zlib.brotliCompressSync(body) : zlib.gzipSync(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = { address: '127.0.0.1', family: 4 }, port = server.address().port;
  const options = { maxBytes: 1024 * 1024, connectMs: 5000, readMs: 5000 };
  for (const route of ['gzip', 'br']) {
    const result = await sourceFetch.requestOnce(new URL(`http://127.0.0.1:${port}/${route}`), address, { ...options, decompress: true });
    assert.deepEqual(result.bytes, body); assert.deepEqual(result.setCookie, ['a=1']);
  }
  await assert.rejects(sourceFetch.requestOnce(new URL(`http://127.0.0.1:${port}/gzip`), address, options), { code: 'UNSUPPORTED_ENCODING' });
  await assert.rejects(sourceFetch.requestOnce(new URL(`http://127.0.0.1:${port}/gzip`), address, { ...options, decompress: true, maxBytes: 100 }), { code: 'FILE_TOO_LARGE' });
});

test('large snapshots keep actionable lines and mark omissions; small ones are unchanged', () => {
  const small = '- link "Final paper" [ref=e45]';
  assert.deepEqual(compactSnapshot(small, 1000), { text: small, truncated: false });
  const raw = ['- heading "Results" [level=1]', ...Array.from({ length: 400 }, (_, i) => `- paragraph: ${'long reference text '.repeat(10)}${i}`), '- link "Download PDF" [ref=e9]'].join('\n');
  const compacted = compactSnapshot(raw, 4000);
  assert.equal(compacted.truncated, true); assert(compacted.text.length <= 4600);
  assert.match(compacted.text, /heading "Results"/); assert.match(compacted.text, /link "Download PDF" \[ref=e9\]/);
  assert.match(compacted.text, /line\(s\) omitted; use browser_find/);
});

test('browser_find searches the latest capture and registers only the references it returns', async () => {
  const f = await referenceBrowserFixture();
  f.page.addElement('e77');
  f.page.ariaSnapshot = async () => '- link "Articles+" [ref=e45]\n- paragraph "Holdings"\n- link "View PDF online" [ref=e77]';
  await f.browser.observe();
  const lookups = f.lookups.length;
  const found = await f.browser.find({ text: 'pdf online' });
  assert.equal(found.status, 'observed'); assert.equal(found.find, true); assert.equal(found.matches, 1);
  assert.match(found.snapshot, /View PDF online/);
  assert(f.browser.referenceState.latest.entries.has('e77'));
  assert.equal(f.lookups.length, lookups);
  const none = await f.browser.find({ regex: '/no such text/i' });
  assert.equal(none.matches, 0); assert.equal(none.snapshot, '(no matches)');
  assert.equal((await f.browser.find({ regex: '(' })).status, 'invalid_query');
});

test('the library browser may use proxy ports but never local, private, credentialed or shadow-library targets', () => {
  assert.equal(validateBrowserUrl('https://ezproxy.example.edu:2443/login?url=https://doi.org/10.1/x').port, '2443');
  for (const value of ['http://127.0.0.1/', 'http://localhost:8080/', 'https://user:pass@example.org/', 'http://10.0.0.5/', 'file:///etc/passwd'])
    assert.throws(() => validateBrowserUrl(value), value);
  assert.throws(() => validateBrowserUrl('https://sci-hub.se/10.1038/nature17946'), { code: 'BLOCKED_SITE' });
  assert.throws(() => validateBrowserUrl('https://libgen.rs/scimag'), { code: 'BLOCKED_SITE' });
  assert.equal(proxiedUrl('https://ezproxy.example.edu/login?url=', 'https://doi.org/10.1/x'), 'https://ezproxy.example.edu/login?url=https://doi.org/10.1/x');
  assert.equal(proxiedUrl('https://ezproxy.example.edu/login?qurl=', 'https://a.org/b?c=1'), 'https://ezproxy.example.edu/login?qurl=https%3A%2F%2Fa.org%2Fb%3Fc%3D1');
  assert.equal(proxiedUrl('', 'https://a.org/b'), 'https://a.org/b');
});

test('Chrome preferences make PDFs download instead of opening the viewer, keeping existing settings', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-preferences-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'Default'), { recursive: true });
  await writeFile(path.join(root, 'Default', 'Preferences'), JSON.stringify({ profile: { name: 'Library' }, plugins: { other: 1 } }));
  await seedBrowserPreferences(root);
  const saved = JSON.parse(await readFile(path.join(root, 'Default', 'Preferences'), 'utf8'));
  assert.deepEqual(saved, { profile: { name: 'Library' }, plugins: { other: 1, always_open_pdf_externally: true }, download: { prompt_for_download: false } });
});
