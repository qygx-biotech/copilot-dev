(function exposeRuntimeLog(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignRuntimeLog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  // Only operational metadata belongs here. Never collect prompts, paper text,
  // response bodies, headers, tokens, arbitrary errors, or absolute file paths.
  const fields = new Set([
    "transportPhase", "exceptionName", "transportCode", "transportCauseCode",
    "pageId", "admissionMs", "eligibilityOutcome", "remainingMaintenanceMs", "providerAttemptsKnown", "initialGenerationMs", "repairMs", "retryEligibility",
    "topicCandidateCount", "totalReservedPageCount", "rejectedCandidateCount", "deadlineReached", "executionMode", "knownProviderAttempts", "unknownProviderAttempts",
    "updatedPageCount", "reusedPageCount", "rejectedPageCount", "failedPageCount", "deferredPageCount", "pendingPageCount",
    "operationId", "turnId", "runId", "workspaceId", "sourceId", "paperId", "jobId", "workflowId",
    "agent", "surface", "stage", "layer", "status", "code", "endpoint", "method", "role", "route",
    "capability", "jobType", "cached", "retryable", "attempt", "attempts", "providerAttempts",
    "durationMs", "completed", "total", "added", "modified", "removed", "unchanged", "failureCount",
    "sourceCount", "queueDepth", "papersCompleted", "papersTotal", "chunksCompleted", "chunksTotal",
    "workerId", "activeWorkers", "activeRequests", "concurrency",
    "imageCount",
    "tool", "localKnowledgeUsed", "scopeType", "sourceIds", "granularity", "sufficiency", "originalEvidenceEscalation", "corpusWorkflowRequired",
    "scopeOrigin", "authoritativeSourceCount", "legacyArgumentsNormalized", "legacyRequestedCount", "resolvedSourceCount",
    "requested", "included", "analyzed", "failed", "coverageComplete", "subagentSpawned", "boundedWorkerCount", "boundedReasoningWorker", "reason",
    "outcome", "elapsedMs", "nextEligibleAt", "timeoutCount", "providerRequestStarted", "providerCompletion", "transportStarted", "automaticRetry",
    "projectPaperCount", "automaticPageCeiling", "existingReservedPageCount", "remainingHeadroom", "admittedCandidateCount", "deferredCandidateCount",
    "wikiGenerationRequests", "generationCalls", "wikiMaintenanceMs", "wikiLocalMaintenanceMs", "wikiSkippedGenerationCount", "skippedGenerationCount", "cachedPaperCards",
    "failureStage", "validationField", "validationReason", "normalizedFields",
    "repairedCount", "validationCount", "referenceCount", "unresolvedReferenceCount", "possibleUnsupportedClaimCount",
    "generationStage", "logicalGenerationAttempts", "repairAttempted", "repairOutcome", "stoppingReason", "initialValidationReason",
    "sessionId", "estimatedTokens", "reportedTokens", "effectiveLimit", "outputReserve", "inputBudget", "limitScope",
    "activeRecoveryMs", "quotaWaitMs", "providerCallTimeoutMs", "quotaWaitRemainingMs", "hardDeadlineRemainingMs", "automaticRetryScheduled",
    "callId", "callStage", "callStatus", "timeoutMs", "callsDispatched", "callsCompleted", "callsTimedOut", "callsCancelled", "checkpointCount",
    "recoveryMode", "eventKind", "classificationEvidence", "contextBudget", "quotaCapacity", "quotaRemaining", "quotaResetAt", "quotaScope", "quotaPeriod", "recoveryTarget",
    "beforeTokens", "afterTokens", "chunkCount", "summaryCalls", "summaryTokens", "checkpointBoundary", "continuationStateReset", "degraded",
    "compactionUsed", "compactionCount", "sequence", "toolResultCount", "recoveryStopReason", "providerAttemptsBeforeRetry", "beforeCharacters", "afterCharacters", "affectedResultCount", "trigger", "retryCount", "freshEvidencePreserved", "freshResultCount", "freshResultsShortened",
    "activeCharacterLimit", "continuationByteLimit", "desktopResultCharacterLimit", "httpBodyByteLimit", "compacted",
    "category", "requestId", "modelCalls", "providerCalls", "toolExecutions",
    "serverRequestId", "clientRequestId", "timingSpanId", "eventType", "transport", "requestBytes", "responseBytes", "processUptimeMs",
    "handlerMs", "bodyReadMs", "clientRoundTripMs", "clientOutsideHandlerMs", "serverTimingAvailable", "resourceTimingAvailable", "networkTimingDetailed", "networkTimingAmbiguous",
    "dnsMs", "connectMs", "tlsMs", "requestToFirstByteMs", "downloadMs", "resourceDurationMs", "transferBytes", "droppedEvents",
    "turns", "toolCalls", "toolResults", "invalidatedTurns", "compactedTurns", "compactedToolResults", "chunkIndex",
    "syncAgentSpawned", "l1UpdateCount", "l2LlmCallCount", "l2LlmMs", "l3UpdateMs", "hashCalls",
    "combinedTextSupported", "nativePdfSupported", "structuredOutputMode", "promptVersion", "model",
    "state", "phase", "callRole", "profile", "mode", "sourceKind", "finishReason", "outputLength",
    "statCalls", "fullHashCalls", "llmCalls", "discovered", "dirty", "missing", "cacheHit",
    "hashPerformed", "hashBytes", "hashDurationMs", "parseDurationMs", "indexDurationMs", "paperCardDurationMs", "contentChanged",
    "reconciliationMs", "knowledgeSyncMs", "changedSourceCount", "l1UpdateMs", "l3LlmCallCount", "l3LlmMs",
    "experimentNormalizationCount", "experimentNormalizationMs", "paperCardGenerationCount", "schemaMapperCalls", "mainAgentStartMs",
    "providerStatus", "retryAfterMs", "quotaMetric", "quotaClassificationReason", "inputTokenLimit", "verifiedInputTokenRateLimit", "rateLimitRetryable", "mapReduceReason", "fallbackReason",
    "retrievalScope", "webSearchExpected", "downloadRequested", "workspaceRetrievalTriggered", "matchedPattern", "semanticParserCalls", "semanticContextPresent",
    "originalRequestPreserved", "downloadExposed", "downloadPermitted", "downloadAttemptCount", "downloadResultCount", "downloadSuccessCount", "downloadFailureCount", "correctiveContinuation", "taskStatus",
  ]);
  const token = (value) => String(value || "").replace(/[^A-Za-z0-9._:/-]/g, "_").slice(0, 160);
  const paperCardFields = new Set(("summary authors year abstractSummary researchQuestion mainFindings methods keyResults organisms genes proteins pathways metabolites experimentalConditions measurements importantResults limitations mainConclusion keywords topics title methodsSummary shortSummary abstract_summary research_question major_findings methods_summary experimental_conditions important_results main_conclusion").split(" "));
  function sanitize(details) {
    const result = {};
    for (const [key, value] of Object.entries(details || {})) {
      if (!fields.has(key)) continue;
      if (key === "normalizedFields") {
        if (Array.isArray(value)) result[key] = value.filter(field => paperCardFields.has(field)).slice(0, paperCardFields.size);
        continue;
      }
      if (key === "sourceIds") {
        if (Array.isArray(value)) result[key] = value.filter(id => typeof id === "string" && /^[\w.:-]{1,200}$/.test(id)).slice(0, 100);
        continue;
      }
      if (key === "validationField") {
        if (typeof value === "string" && /^(?:body|query|profile|callContext|activeScope|paperCandidates|conversationContext|projectSemanticRegistry|paperCard)(?:\.[A-Za-z_]+|\[\d{1,5}\])*$/.test(value)) result[key] = value.slice(0, 200);
        continue;
      }
      if (value === null && ["providerAttempts", "attempts", "initialGenerationMs", "repairMs"].includes(key)) result[key] = null;
      else if (typeof value === "boolean") result[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) result[key] = Math.round(value * 100) / 100;
      else if (typeof value === "string" && value) result[key] = token(value);
    }
    return result;
  }

  function createRuntimeLogger({ limit = 1000, sink = root.console, now = () => Date.now(), monotonic = () => root.performance?.now?.() ?? Date.now(), resourceEntries = url => root.performance?.getEntriesByName?.(url) || [], heartbeatMs = 15000 } = {}) {
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
    function chatTiming(details) {
      const requestId = root.crypto?.randomUUID?.() || "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const n = Math.random() * 16 | 0; return (c === "x" ? n : n & 3 | 8).toString(16); });
      const started = monotonic(); let fetchStarted, fetchUrl, firstEvent = false, finished = false, spanId = 0;
      const emit = (stage, fields = {}) => record("chat.timing", { ...details, requestId, stage, elapsedMs: monotonic() - started, ...fields });
      const start = stage => {
        const at = monotonic(), timingSpanId = ++spanId; emit(stage + "_start", { timingSpanId }); let done = false;
        return (fields = {}) => { if (!done) { done = true; emit(stage + "_end", { timingSpanId, durationMs: monotonic() - at, ...fields }); } };
      };
      emit("client_entry");
      return {
        requestId, start, mark: emit,
        bytes: value => new root.TextEncoder().encode(value).byteLength,
        dispatch(url, requestBytes) { fetchUrl = url; fetchStarted = monotonic(); emit("fetch_start", { requestBytes }); },
        headers(response) { emit("fetch_headers", { durationMs: monotonic() - fetchStarted, status: response.status,
          transport: /text\/event-stream/i.test(response.headers?.get?.("content-type") || "") ? "sse" : "json" }); },
        event(type) { if (!firstEvent) { firstEvent = true; emit("first_stream_event", { eventType: type }); } },
        server(timing) {
          const clientRoundTripMs = monotonic() - fetchStarted;
          const valid = timing?.version === 1 && Number.isFinite(timing.handlerMs) && timing.handlerMs >= 0;
          emit("round_trip", { clientRoundTripMs, serverTimingAvailable: valid,
            ...(valid ? { serverRequestId: timing.requestId, handlerMs: timing.handlerMs, bodyReadMs: timing.bodyReadMs,
              clientOutsideHandlerMs: Math.max(0, clientRoundTripMs - timing.handlerMs), droppedEvents: timing.droppedEvents } : {}) });
          if (valid) for (const event of (Array.isArray(timing.events) ? timing.events : []).slice(0, 256)) {
            if (!event || typeof event !== "object") continue;
            record("chat.server-timing", { ...details, requestId, serverRequestId: timing.requestId,
              stage: event.stage, elapsedMs: event.elapsedMs, durationMs: event.durationMs, status: event.status,
              attempt: event.attempt, callStage: event.callStage, outcome: event.outcome, transport: event.transport,
              transportPhase: event.transportPhase, exceptionName: event.exceptionName, transportCode: event.transportCode, transportCauseCode: event.transportCauseCode,
              estimatedTokens: event.estimatedTokens, outputReserve: event.outputReserve, imageCount: event.imageCount,
              requestBytes: event.requestBytes, responseBytes: event.responseBytes, processUptimeMs: event.processUptimeMs });
          }
          // Match only one completed resource. Concurrent indistinguishable
          // fetches must not receive each other's network measurements.
          let resources = [];
          try { resources = resourceEntries(fetchUrl); } catch { /* Optional browser diagnostics must not fail the answer. */ }
          const candidates = resources.filter(e => e.initiatorType === "fetch" && e.startTime >= fetchStarted - 1 && e.responseEnd > 0 && e.responseEnd <= monotonic() + 1);
          const entry = candidates.length === 1 ? candidates[0] : null;
          const detailed = Boolean(entry && entry.requestStart > 0 && entry.responseStart > 0);
          emit("browser_network", { resourceTimingAvailable: Boolean(entry), networkTimingDetailed: detailed, networkTimingAmbiguous: candidates.length > 1,
            ...(entry ? { resourceDurationMs: entry.duration } : {}),
            ...(detailed ? { transferBytes: entry.transferSize, dnsMs: entry.domainLookupEnd - entry.domainLookupStart, connectMs: entry.connectEnd - entry.connectStart,
              tlsMs: entry.secureConnectionStart > 0 ? entry.connectEnd - entry.secureConnectionStart : 0,
              requestToFirstByteMs: entry.responseStart - entry.requestStart, downloadMs: entry.responseEnd - entry.responseStart } : {}) });
        },
        finish(outcome) { if (!finished) { finished = true; emit("client_complete", { outcome, durationMs: monotonic() - started }); } },
      };
    }
    return { record, begin, chatTiming, responseOutcome, entries: () => entries.slice(),
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
  function responseOutcome(data) {
    if (data.fallback || data.failure || data.contextRecoveryIncomplete || (data.taskOutcome && data.taskOutcome.status !== "completed"))
      return { status: data.fallback || data.failure ? "failed" : "partial", stage: "incomplete_result" };
    if (data.desktopToolCalls?.length || data.desktopContinuation || data.evidenceRecovery || data.agentContinuation)
      return { status: "partial", stage: "tool_handoff" };
    if (typeof data.reply === "string" && data.reply.trim() || data.project)
      return { status: "completed", stage: "final_answer" };
    return { status: "partial", stage: "response_received" };
  }
  return Object.assign(logger, { createRuntimeLogger, installPanel, setLanguage, responseOutcome });
});
