(function exposeRuntimeLog(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignRuntimeLog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  // Only operational metadata belongs here. Never collect prompts, paper text,
  // response bodies, headers, tokens, arbitrary errors, or absolute file paths.
  const fields = new Set([
    "operationId", "turnId", "runId", "workspaceId", "sourceId", "paperId", "jobId", "workflowId",
    "agent", "surface", "stage", "layer", "status", "code", "endpoint", "method", "role", "route",
    "capability", "jobType", "cached", "retryable", "attempt", "attempts", "providerAttempts",
    "durationMs", "completed", "total", "added", "modified", "removed", "unchanged", "failureCount",
    "sourceCount", "queueDepth", "papersCompleted", "papersTotal", "chunksCompleted", "chunksTotal",
    "workerId", "activeWorkers", "activeRequests", "concurrency",
    "imageCount",
    "syncAgentSpawned", "l1UpdateCount", "l2LlmCallCount", "l2LlmMs", "l3UpdateMs", "hashCalls",
    "combinedTextSupported", "nativePdfSupported", "structuredOutputMode", "promptVersion", "model",
    "state", "phase", "callRole", "profile", "mode", "sourceKind", "finishReason", "outputLength",
    "statCalls", "fullHashCalls", "llmCalls", "discovered", "dirty", "missing", "cacheHit",
    "hashPerformed", "hashBytes", "hashDurationMs", "parseDurationMs", "indexDurationMs", "paperCardDurationMs", "contentChanged",
    "reconciliationMs", "knowledgeSyncMs", "changedSourceCount", "l1UpdateMs", "l3LlmCallCount", "l3LlmMs",
    "experimentNormalizationCount", "experimentNormalizationMs", "paperCardGenerationCount", "schemaMapperCalls", "mainAgentStartMs",
    "providerStatus", "retryAfterMs", "quotaMetric", "inputTokenLimit", "verifiedInputTokenRateLimit", "rateLimitRetryable", "mapReduceReason", "fallbackReason",
  ]);
  const token = (value) => String(value || "").replace(/[^A-Za-z0-9._:/-]/g, "_").slice(0, 160);
  function sanitize(details) {
    const result = {};
    for (const [key, value] of Object.entries(details || {})) {
      if (!fields.has(key)) continue;
      if (typeof value === "boolean") result[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) result[key] = Math.round(value * 100) / 100;
      else if (typeof value === "string" && value) result[key] = token(value);
    }
    return result;
  }

  function createRuntimeLogger({ limit = 1000, sink = root.console, now = () => Date.now(), heartbeatMs = 15000 } = {}) {
    const entries = [], listeners = new Set();
    const capacity = Math.max(1, Math.min(5000, Number(limit) || 1000));
    let sequence = 0;
    function notify() { for (const listener of listeners) { try { listener(); } catch {} } }
    function record(event, details = {}, level = "info") {
      const entry = Object.freeze({ timestamp: new Date(now()).toISOString(),
        level: ["info", "warn", "error"].includes(level) ? level : "info",
        event: token(event), details: Object.freeze(sanitize(details)) });
      entries.push(entry);
      if (entries.length > capacity) entries.splice(0, entries.length - capacity);
      try { sink?.[entry.level]?.(`[BioDesign] ${entry.timestamp} ${entry.event} ${JSON.stringify(entry.details)}`); } catch {}
      notify();
      return entry;
    }
    function begin(event, details = {}) {
      const started = now();
      const context = { ...sanitize(details), operationId: `op-${started}-${++sequence}` };
      record(`${event}.started`, context);
      let finished = false;
      const timer = heartbeatMs > 0 ? root.setInterval(() => {
        record(`${event}.waiting`, { ...context, durationMs: now() - started });
      }, heartbeatMs) : null;
      timer?.unref?.();
      return (status = "completed", result = {}) => {
        if (finished) return;
        finished = true;
        if (timer !== null) root.clearInterval(timer);
        record(`${event}.${status}`, { ...context, ...result, durationMs: now() - started },
          status === "failed" ? "error" : ["partial", "cancelled"].includes(status) ? "warn" : "info");
      };
    }
    return { record, begin, entries: () => entries.slice(),
      clear() { entries.length = 0; notify(); },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      format(entry) { return `${entry.timestamp} ${entry.level.toUpperCase()} ${entry.event} ${JSON.stringify(entry.details)}`; },
      exportText() { return entries.map(this.format).join("\n"); },
    };
  }

  const logger = createRuntimeLogger();
  const labels = {
    en: { open: "Debug Console", title: "Debug Console", note: "Live stages and backend requests · session only · latest 1,000 events", copy: "Copy logs", copied: "Copied", copyFailed: "Select and copy the log text", clear: "Clear", close: "Close", empty: "Waiting for activity…" },
    zh: { open: "调试控制台", title: "调试控制台", note: "实时阶段与后端请求 · 仅当前会话 · 最近 1,000 条记录", copy: "复制日志", copied: "已复制", copyFailed: "请选中日志文本并复制", clear: "清空", close: "关闭", empty: "等待活动…" },
  };
  let language = "en", installed = false;
  function setLanguage(value) {
    language = String(value).startsWith("zh") ? "zh" : "en";
    root.document?.querySelectorAll("[data-debug-label]").forEach((element) => {
      element.textContent = labels[language][element.dataset.debugLabel];
    });
  }
  function installPanel() {
    const doc = root.document, panel = doc?.getElementById("debugConsole");
    if (!panel || installed) return;
    installed = true;
    const output = doc.getElementById("debugConsoleOutput");
    let scheduled = false, opener = null;
    function render() {
      scheduled = false;
      if (panel.hidden) return;
      const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
      output.textContent = logger.exportText() || labels[language].empty;
      if (atBottom) output.scrollTop = output.scrollHeight;
    }
    logger.subscribe(() => {
      if (!panel.hidden && !scheduled) { scheduled = true; root.requestAnimationFrame(render); }
    });
    const triggers = doc.querySelectorAll("[data-debug-open]");
    function close() {
      panel.hidden = true;
      triggers.forEach((button) => button.setAttribute("aria-expanded", "false"));
      opener?.focus();
    }
    triggers.forEach((button) => button.addEventListener("click", () => {
      if (!panel.hidden) { close(); return; }
      opener = button;
      panel.hidden = false;
      triggers.forEach((trigger) => trigger.setAttribute("aria-expanded", "true"));
      render();
      output.scrollTop = output.scrollHeight;
      doc.getElementById("debugConsoleClose").focus();
    }));
    doc.getElementById("debugConsoleClose").addEventListener("click", close);
    panel.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } });
    doc.getElementById("debugConsoleClear").addEventListener("click", () => logger.clear());
    doc.getElementById("debugConsoleCopy").addEventListener("click", async () => {
      const status = doc.getElementById("debugConsoleCopyStatus");
      try { await root.navigator.clipboard.writeText(logger.exportText()); status.textContent = labels[language].copied; }
      catch { status.textContent = labels[language].copyFailed; }
    });
    setLanguage(doc.documentElement.lang);
    logger.record("app.ready", { stage: "awaiting-request" });
  }
  return Object.assign(logger, { createRuntimeLogger, installPanel, setLanguage });
});
