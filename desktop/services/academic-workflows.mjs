import crypto from "node:crypto";
import academic from "../../shared/academic-tools.js";
import sourceFetch from "../../shared/source-fetch.js";
import { downloadSources } from "./source-downloader.mjs";
import { assertOnlyKeys } from "../ipc/validation.mjs";

const failure = code => Object.assign(new Error(code), { code });
const entities = value => value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
export function paperPdfLinks(html, pageUrl, expectedDoi = "") {
  const links = [];
  const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(m => [m[1].toLowerCase(), entities(m[2] ?? m[3] ?? m[4] ?? "")]));
  const tags = [...html.matchAll(/<(?:meta|link|a)\b[^>]*>/gi)].map(match => attrs(match[0]));
  const citationDoi = tags.find(a => a.name?.toLowerCase() === "citation_doi")?.content?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase();
  if (expectedDoi && citationDoi && citationDoi !== expectedDoi.toLowerCase()) throw failure("PAPER_IDENTITY_MISMATCH");
  for (const a of tags) {
    const raw = a.name?.toLowerCase() === "citation_pdf_url" ? a.content : a.type?.toLowerCase() === "application/pdf" || /(?:\.pdf(?:[?#]|$)|\/pdf\/?(?:[?#]|$))/i.test(a.href || "") ? a.href : null;
    if (!raw) continue;
    try {
      const url = sourceFetch.validateSourceUrl(new URL(raw, pageUrl).href).href;
      if (!links.includes(url)) links.push(url);
    } catch { /* Ignore invalid metadata links. Fetch still validates DNS and redirects. */ }
    if (links.length === 5) break;
  }
  return links;
}

export function registerAcademicWorkflows(active, mcp, isCurrent, dependencies = {}) {
  let queue = Promise.resolve();
  for (const tool of academic.tools) {
    const name = tool.function.name;
    active.execution.register({ id: name, effect: academic.isWrite(name) ? "source_write" : "informational" }, (input, context) => {
      const run = async () => {
        assertOnlyKeys(input, ["args", "surface", "permission"]);
        if (!academic.allowed(name, input.surface, input.permission)) throw failure("PERMISSION_DENIED");
        const args = academic.validateInput(name, input.args);
        const signal = active.sourceDownloads.signal;
        const ensureCurrent = () => { if (signal.aborted || !isCurrent()) throw failure("OPERATION_ABORTED"); };
        ensureCurrent();
        if (!academic.isWrite(name)) return mcp.call(name, args, signal);
        const results = [];
        const { filesystem } = context;
        const indexPath = ".biodesign/academic/downloads.json";
        let index = {};
        try { index = JSON.parse(await filesystem.readText(indexPath)); } catch { /* First download. */ }
        for (const ref of args.paper_refs) {
          ensureCurrent();
          let paper;
          try {
            paper = (await mcp.call("resolve_paper_full_text", { paper_ref: ref }, signal)).papers[0];
            const existing = index[ref];
            if (existing?.path && existing.destination === (args.destination || "literature")) {
              try {
                const bytes = Buffer.from(await filesystem.readBinary(existing.path));
                if (crypto.createHash("sha256").update(bytes).digest("hex") === existing.sha256) {
                  results.push({ paper_ref: ref, status: "downloaded", path: existing.path, contentType: "application/pdf", reused: true, title: paper.title });
                  continue;
                }
              } catch { /* Missing or edited file: acquire a fresh copy. */ }
            }
            const locations = [...paper.locations].sort((a, b) => Number(b.kind === "pdf_candidate") - Number(a.kind === "pdf_candidate"));
            const urls = [...new Set(locations.map(item => item.url))].slice(0, 8), attempted = new Set();
            const attempts = [];
            let saved;
            const deadline = Date.now() + 90000;
            while (urls.length && attempted.size < 8 && Date.now() < deadline) {
              ensureCurrent();
              const url = urls.shift();
              if (attempted.has(url)) continue;
              attempted.add(url);
              try {
                const fetched = await (dependencies.fetchSource || sourceFetch.fetchSource)(url, { signal, totalMs: Math.min(25000, deadline - Date.now()) });
                if (fetched.contentType !== "application/pdf") {
                  if (["text/html", "application/xhtml+xml"].includes(fetched.contentType)) {
                    const found = paperPdfLinks(fetched.bytes.toString("utf8"), fetched.resolvedUrl, paper.doi);
                    urls.unshift(...found.filter(link => !attempted.has(link)));
                  }
                  attempts.push({ url, code: "NOT_PDF" });
                  continue;
                }
                ensureCurrent();
                const output = await downloadSources({ args: { sources: [{ url, title: paper.title, preferred_filename: paper.title.slice(0, 150) + ".pdf" }], destination: args.destination || "literature" }, surface: input.surface, permission: input.permission }, { ...context, signal, isCurrent }, {
                  localFetch: async () => fetched, fcFetch: async () => { throw failure("LOCAL_FETCH_ONLY"); }, requirePdf: true, paperMetadata: paper,
                });
                if (output[0].status !== "downloaded") throw failure(output[0].error.code);
                saved = { paper_ref: ref, title: paper.title, ...output[0], attempts };
                index[ref] = { path: saved.path, destination: args.destination || "literature", sha256: crypto.createHash("sha256").update(fetched.bytes).digest("hex") };
                ensureCurrent();
                try { await filesystem.writeText(indexPath, JSON.stringify(index)); }
                catch { saved.cacheWarning = "DOWNLOAD_INDEX_NOT_SAVED"; }
                break;
              } catch (error) {
                if (signal.aborted || error.code === "OPERATION_ABORTED") throw error;
                attempts.push({ url, code: /^[A-Z_]{1,80}$/.test(error.code || "") ? error.code : "DOWNLOAD_FAILED" });
              }
            }
            results.push(saved || { paper_ref: ref, title: paper.title, status: "failed", error: { code: "NO_ACCESSIBLE_PDF" }, attempts });
          } catch (error) {
            if (signal.aborted || error.code === "OPERATION_ABORTED") throw error;
            results.push({ paper_ref: ref, title: paper?.title || "", status: "failed", error: academic.failure(error.code).error });
          }
        }
        return academic.validateResult(name, { version: 1, status: results.every(item => item.status === "downloaded") ? "completed" : "partial", results });
      };
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    });
  }
}
