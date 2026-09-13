import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { ProjectFilesystem } from "../services/project-filesystem.mjs";
import { downloadSources, fetchFromCurrentFc, sourceFilename } from "../services/source-downloader.mjs";
import fetcher from "../../shared/source-fetch.js";
import contract from "../../shared/source-download.js";
import backendConfig from "../../shared/backend-config.js";

const pdf = Buffer.from("%PDF-1.7\nsource fixture\n%%EOF");
const url = "https://papers.example.org/paper.pdf";
const source = { url, title: "EctD 工程" };
const fetched = () => ({ bytes: pdf, resolvedUrl: url, contentType: "application/pdf", contentDisposition: "" });
const publicDns = async () => [{ address: "8.8.8.8", family: 4 }];
const input = (sources = [source], extra = {}) => ({ args: { sources }, surface: "agent_command", permission: "workspace_write", ...extra });
async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biodesign-source-download-"));
  try { await run(await ProjectFilesystem.open(root)); } finally { await rm(root, { recursive: true, force: true }); }
}

test("local PDF download writes provenance and duplicate-safe files without calling FC", async () => fixture(async filesystem => {
  let fallbackCalls = 0;
  const run = () => downloadSources(input([source], { webSearchSources: [{ url, title: "Provider title" }] }), { filesystem }, {
    localFetch: async () => fetched(), fcFetch: async () => { fallbackCalls++; throw new Error(); },
  });
  const first = (await run())[0], second = (await run())[0];
  assert.equal(first.path, "literature/paper.pdf");
  assert.equal(second.path, "literature/paper (2).pdf");
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(Buffer.from(await filesystem.readBinary(first.path)), pdf);
  const provenance = JSON.parse(await filesystem.readText(first.metadataPath));
  assert.equal(provenance.source_url, url); assert.equal(provenance.resolved_url, url);
  assert.equal(provenance.title, source.title); assert.equal(provenance.content_type, "application/pdf");
  assert.equal(provenance.local_path, first.path); assert.ok(Date.parse(provenance.downloaded_at));
  assert.equal(provenance.web_search_sources[0].url, url);
}));

test("concurrent downloads never overwrite an existing source", async () => fixture(async filesystem => {
  const results = await Promise.all(Array.from({ length: 5 }, () => downloadSources(input(), { filesystem }, { localFetch: async () => fetched() })));
  assert.equal(new Set(results.map(result => result[0].path)).size, 5);
  assert.ok(results.every(result => result[0].status === "downloaded"));
}));

test("network failure invokes current FC only after local fetch; batch reports independent failures", async () => fixture(async filesystem => {
  const calls = [];
  const results = await downloadSources(input([source, { url: url + "?fail" }, { url: "http://127.0.0.1/no" }]), { filesystem }, {
    localFetch: async value => { calls.push(["local", value]); throw fetcher.failure("HTTP_ERROR", "Source returned HTTP 403."); },
    fcFetch: async value => { calls.push(["fc", value]); if (value.endsWith("fail")) throw fetcher.failure("HTTP_ERROR", "Source returned HTTP 403."); return fetched(); },
  });
  assert.deepEqual(calls.map(call => call[0]), ["local", "fc", "local", "fc"]);
  assert.equal(results[0].downloadMethod, "fc-fallback");
  assert.equal(results[1].localError.code, "HTTP_ERROR"); assert.equal(results[1].fallbackError.code, "HTTP_ERROR");
  assert.equal(results[2].error.code, "UNSAFE_URL");
}));

test("side chat and read-only moves cannot fetch or write; invalid paths fail closed", async () => fixture(async filesystem => {
  for (const extra of [{ surface: "side_chat", permission: "full_access" }, { permission: "read_only" }, { permission: "invented" }]) {
    await assert.rejects(downloadSources(input([source], extra), { filesystem }, { localFetch: () => assert.fail("No fetch allowed") }), { code: "PERMISSION_DENIED" });
  }
  for (const destination of ["../outside", "/tmp", ".biodesign", "a/../b", "a\\b", "C:/tmp", "a//b", "a/."]) {
    assert.throws(() => contract.validateInput({ sources: [source], destination }), { code: "INVALID_DOWNLOAD_INPUT" });
  }
  assert.equal(await filesystem.exists("literature"), false);
}));

test("closed projects and oversize/content-policy failures do not use the fallback", async () => fixture(async filesystem => {
  await assert.rejects(downloadSources(input(), { filesystem, isCurrent: () => false }), { code: "OPERATION_ABORTED" });
  for (const code of ["FILE_TOO_LARGE", "UNSUPPORTED_CONTENT_TYPE", "UNSAFE_URL", "REDIRECT_LIMIT"]) {
    const result = await downloadSources(input(), { filesystem }, {
      localFetch: async () => { throw fetcher.failure(code, "blocked"); }, fcFetch: () => assert.fail("Policy errors must not fall back"),
    });
    assert.equal(result[0].error.code, code);
  }
}));

test("filename selection supports RFC5987, Unicode, content types and unsafe filename cleanup", () => {
  assert.equal(sourceFilename({}, { ...fetched(), contentDisposition: "attachment; filename*=UTF-8''%E8%AE%BA%E6%96%87.pdf" }), "论文.pdf");
  assert.equal(sourceFilename({ preferred_filename: "../../CON.exe" }, fetched()), "source-CON.pdf");
  assert.equal(sourceFilename({ preferred_filename: "paper.pdf" }, { ...fetched(), contentType: "text/html" }), "paper.html");
  assert.equal(sourceFilename({}, { ...fetched(), contentDisposition: 'attachment; filename="named.pdf"' }), "named.pdf");
});

test("unsafe protocols, IP forms, private, metadata, mapped IPv6 and nonstandard ports are blocked", () => {
  for (const value of ["no url", "file:///tmp/file", "ftp://example.org/a", "https://u:p@example.org/", "http://localhost/", "http://localhost./", "http://0/", "http://2130706433/", "http://0x7f000001/",
    "http://127.1/", "http://10.0.0.2/", "http://172.16.1.2/", "http://192.168.1.2/", "http://169.254.169.254/", "http://100.100.100.200/",
    "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fc00::1]/", "http://[fe80::1]/", "http://[2002:7f00:1::]/", "https://example.org:8080/"]) {
    assert.throws(() => fetcher.validateSourceUrl(value), undefined, value);
  }
  assert.equal(fetcher.publicAddress("2606:4700::1111"), true);
  assert.equal(fetcher.validateSourceUrl(url).href, url);
});

test("redirects revalidate URL and all DNS addresses; a public redirect cannot enter a private network", async () => {
  const requests = [];
  const result = await fetcher.fetchSource(url, { lookup: publicDns, request: async (target, pinned) => {
    requests.push([target.href, pinned.address]);
    return requests.length === 1 ? { redirect: "/final" } : fetched();
  } });
  assert.equal(result.resolvedUrl, "https://papers.example.org/final");
  assert.deepEqual(requests.map(entry => entry[1]), ["8.8.8.8", "8.8.8.8"]);
  for (const destination of ["http://127.0.0.1/", "http://100.100.100.200/", "file:///etc/passwd"]) {
    await assert.rejects(fetcher.fetchSource(url, { lookup: publicDns, request: async () => ({ redirect: destination }) }), { code: "UNSAFE_URL" });
  }
  let lookups = 0, fetches = 0;
  await assert.rejects(fetcher.fetchSource(url, { lookup: async () => ++lookups === 1 ? publicDns() : [{ address: "10.0.0.1", family: 4 }],
    request: async () => { fetches++; return { redirect: "https://other.example.org/" }; } }), { code: "UNSAFE_URL" });
  assert.equal(fetches, 1);
  await assert.rejects(fetcher.fetchSource(url, { lookup: async () => [...await publicDns(), { address: "192.168.1.2", family: 4 }], request: () => assert.fail("Mixed DNS blocked") }), { code: "UNSAFE_URL" });
  await assert.rejects(fetcher.fetchSource(url, { lookup: publicDns, maxRedirects: 2, request: async () => ({ redirect: "/again" }) }), { code: "REDIRECT_LIMIT" });
});

test("HTTP reader caps declared and streamed bytes, pins DNS, and enforces read/overall deadlines", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/declared") { res.writeHead(200, { "content-length": "99999" }); res.end(); }
    else if (req.url === "/streamed") { res.writeHead(200); res.write(Buffer.alloc(60)); res.end(Buffer.alloc(60)); }
    else if (req.url === "/stall") { res.writeHead(200); res.flushHeaders(); }
    else { res.setHeader("Content-Type", "application/pdf"); res.end(pdf); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    // Exercise transport with an intentionally injected loopback fixture address.
    // The production URL/DNS validator above never admits this address.
    const request = route => fetcher.requestOnce(new URL(`http://public.example.org:${server.address().port}${route}`), { address: "127.0.0.1", family: 4 }, { maxBytes: 100, connectMs: 2000, readMs: 50 });
    assert.deepEqual((await request("/pdf")).bytes, pdf);
    for (const route of ["/declared", "/streamed"]) await assert.rejects(request(route), { code: "FILE_TOO_LARGE" });
    await assert.rejects(request("/stall"), { code: "READ_TIMEOUT" });
    await assert.rejects(fetcher.fetchSource(url, { totalMs: 30, lookup: () => new Promise(() => {}) }), { code: "DOWNLOAD_TIMEOUT" });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("FC fallback uses only the existing authenticated endpoint and validates returned bytes", async () => {
  const calls = [];
  const fakeFetch = async (address, options) => { calls.push([address, options]); return new Response(JSON.stringify({ contentBase64: pdf.toString("base64"), resolvedUrl: url, contentType: "application/pdf" })); };
  assert.deepEqual((await fetchFromCurrentFc(url, "fixture-session", null, fakeFetch)).bytes, pdf);
  assert.equal(calls[0][0], `${backendConfig.FC_BASE_URL}/api/sources/fetch`);
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(calls[0][1].headers.Authorization, "Bearer fixture-session");
  assert.deepEqual(JSON.parse(calls[0][1].body), { url });
  await assert.rejects(fetchFromCurrentFc(url, "fixture-session", null, async () => new Response(JSON.stringify({ error: "UNSAFE_URL" }), { status: 400 })), { code: "UNSAFE_URL" });
});
