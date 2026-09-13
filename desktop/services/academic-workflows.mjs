import crypto from "node:crypto";
import academic from "../../shared/academic-tools.js";
import { downloadSources } from "./source-downloader.mjs";
import { assertOnlyKeys } from "../ipc/validation.mjs";

const failure = code => Object.assign(new Error(code), { code });
export { paperPdfLinks } from './paper-acquisition.mjs';
import { acquirePaperPdf } from './paper-acquisition.mjs';

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
        try { const stored = JSON.parse(await filesystem.readText(indexPath)); if (stored && typeof stored === "object" && !Array.isArray(stored)) index = stored; } catch { /* First download. */ }
        for (const ref of args.paper_refs) {
          ensureCurrent();
          let paper;
          try {
            const resolved = await mcp.call("resolve_paper_full_text", { paper_ref: ref }, signal);
            paper = resolved.papers?.[0];
            if (!paper) throw failure(resolved.error?.code || "PAPER_RESOLUTION_FAILED");
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
            const acquired = await acquirePaperPdf(paper, { signal, ensureCurrent, fetchSource: dependencies.fetchSource });
            if (!acquired.fetched) {
              results.push({ paper_ref: ref, title: paper.title, status: "failed", error: { code: "NO_ACCESSIBLE_PDF" },
                attempts: acquired.attempts, resolution_status: resolved.provider_status || {}, access: paper.access || [],
                exhaustion: acquired.exhausted });
              continue;
            }
            const { fetched, url, attempts } = acquired;
            ensureCurrent();
            const output = await downloadSources({ args: { sources: [{ url, title: paper.title, preferred_filename: paper.title.slice(0, 150) + ".pdf" }], destination: args.destination || "literature" }, surface: input.surface, permission: input.permission }, { ...context, signal, isCurrent }, {
              localFetch: async () => fetched, fcFetch: async () => { throw failure("LOCAL_FETCH_ONLY"); }, requirePdf: true, paperMetadata: paper,
            });
            if (output[0].status !== "downloaded") throw failure(output[0].error.code);
            const saved = { paper_ref: ref, title: paper.title, ...output[0], attempts };
            index[ref] = { path: saved.path, destination: args.destination || "literature", sha256: crypto.createHash("sha256").update(fetched.bytes).digest("hex") };
            ensureCurrent();
            try { await filesystem.writeText(indexPath, JSON.stringify(index)); }
            catch { saved.cacheWarning = "DOWNLOAD_INDEX_NOT_SAVED"; }
            results.push(saved);
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
