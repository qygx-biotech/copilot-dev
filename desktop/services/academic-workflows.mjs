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
        assertOnlyKeys(input, ["args", "surface", "permission", "deadlineAt"]);
        if (!academic.allowed(name, input.surface, input.permission)) throw failure("PERMISSION_DENIED");
        const args = academic.validateInput(name, input.args);
        const now = dependencies.now || Date.now;
        if (input.deadlineAt !== undefined && !Number.isFinite(input.deadlineAt)) throw failure("INVALID_ACADEMIC_INPUT");
        const deadlineAt = Math.min(input.deadlineAt ?? Infinity, now() + academic.DOWNLOAD_LIMITS.totalMs);
        const timeout = new AbortController();
        const signal = AbortSignal.any([active.sourceDownloads.signal, timeout.signal, ...(context.signal ? [context.signal] : [])]);
        const stopCode = () => active.sourceDownloads.signal.aborted || context.signal?.aborted || !isCurrent() ? "OPERATION_ABORTED"
          : timeout.signal.aborted || now() >= deadlineAt ? "DOWNLOAD_TIME_BUDGET_EXHAUSTED" : null;
        const ensureCurrent = () => { const code = stopCode(); if (code) throw failure(code); };
        if (!academic.isWrite(name)) { ensureCurrent(); return mcp.call(name, args, signal); }
        // Reads can outlive an abort in a transport implementation. Stop waiting
        // without permitting any late result to advance into filesystem writes.
        const boundedRead = work => new Promise((resolve, reject) => {
          const finish = (callback, value) => { signal.removeEventListener("abort", abort); callback(value); };
          const abort = () => finish(reject, failure(stopCode() || "OPERATION_ABORTED"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) return abort();
          Promise.resolve().then(() => { ensureCurrent(); return work(); }).then(value => finish(resolve, value), error => finish(reject, error));
        });
        // One acquisition at a time. The selected target is not the concurrency
        // limit; the whole set shares the original move deadline.
        const timer = setTimeout(() => timeout.abort(), Math.max(1, deadlineAt - now()));
        timer.unref?.();
        const results = [];
        try {
          const { filesystem } = context;
          const indexPath = ".biodesign/academic/downloads.json";
          let index = {};
          try { const stored = JSON.parse(await filesystem.readText(indexPath)); if (stored && typeof stored === "object" && !Array.isArray(stored)) index = stored; } catch { /* First download. */ }
          for (const ref of args.paper_refs) {
            const stopped = stopCode();
            if (stopped) { results.push({ paper_ref: ref, status: "failed", attempted: false, error: { code: stopped } }); continue; }
            let paper;
            try {
              const resolved = await boundedRead(() => mcp.call("resolve_paper_full_text", { paper_ref: ref }, signal));
              ensureCurrent();
              paper = resolved.papers?.[0];
              if (!paper) throw failure(resolved.error?.code || "PAPER_RESOLUTION_FAILED");
              if (paper.paper_ref !== ref) throw failure("PAPER_IDENTITY_MISMATCH");
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
              const acquired = await boundedRead(() => acquirePaperPdf(paper, { signal, ensureCurrent, fetchSource: dependencies.fetchSource, deadlineAt }));
              ensureCurrent();
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
              // The PDF and provenance are durable now. Cancellation after this
              // point must not relabel a saved file as a failed acquisition.
              results.push(saved);
              index[ref] = { path: saved.path, destination: args.destination || "literature", sha256: crypto.createHash("sha256").update(fetched.bytes).digest("hex") };
              // Finish bookkeeping for an already committed file even when the
              // request was cancelled; never write into a switched workspace.
              try { if (!isCurrent()) throw failure("OPERATION_ABORTED"); await filesystem.writeText(indexPath, JSON.stringify(index)); }
              catch { saved.cacheWarning = "DOWNLOAD_INDEX_NOT_SAVED"; }
            } catch (error) {
              results.push({ paper_ref: ref, title: paper?.title || "", status: "failed", error: academic.failure(stopCode() || error.code).error });
            }
          }
          const result = { version: 1, status: results.every(item => item.status === "downloaded") ? "completed" : "partial", results, summary: academic.downloadSummary(results) };
          // Keep full diagnostics locally; large handoff receipts retain every
          // handle, saved path and failure code within the continuation envelope.
          if (isCurrent()) {
            const receiptPath = `.biodesign/academic/receipts/${crypto.randomUUID()}.json`;
            try { await filesystem.writeText(receiptPath, JSON.stringify(result)); result.receipt_path = receiptPath; }
            catch { result.receipt_warning = "DOWNLOAD_RECEIPT_NOT_SAVED"; }
          }
          return academic.validateResult(name, academic.compactDownloads(result));
        } finally { clearTimeout(timer); }
      };
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    });
  }
}
