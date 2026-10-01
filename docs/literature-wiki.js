(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";
  const contract = root.BioDesignLiteratureWiki || (typeof require === "function" ? require("../shared/literature-wiki.js") : {});
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = (code, validationProblems = []) => Object.assign(new Error(validationProblems.join(" ") || code), { code, validationProblems });
  const unique = values => [...new Set(values)];
  const tokens = value => unique(String(value || "").toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}|[\u3400-\u9fff]{2,}/g) || []);
  const RETRY_BASE_MS = 60000, RETRY_MAX_MS = 3600000, RUN_BUDGET_MS = 300000, ATTEMPT_HISTORY = 4;
  const automaticPageCeiling = count => count < 2 ? 0 : Math.min(30, Math.max(3, Math.ceil(count / 4)));
  // Only orthographic aliases, not fuzzy scientific-topic or source-set merging.
  const admissionKey = topic => `${topic.pageKind === "comparison" ? "comparison" : "subject"}:` +
    String(topic.label || topic.topicId).normalize("NFKC").toLowerCase()
      .replace(/([\p{L}\p{N}])[-_‐‑–—]+(?=[\p{L}\p{N}])/gu, "$1 ").replace(/\s+/g, " ").trim();
  const TIMEOUT_COOLDOWNS = [60000, 300000, 900000, 3600000];
  class LiteratureWikiService {
    constructor(options) {
      Object.assign(this, options);
      this.workspaceIdentity = this.workspace.workspace;
      this.workspaceId = this.workspaceIdentity?.workspaceId || this.workspaceIdentity?.id;
      this.queue = Promise.resolve();
      this.metrics = { generationCalls: 0, generationMs: 0, providerAttempts: 0, unknownProviderAttempts: 0 };
    }
    assertActive(options = {}) {
      if (options.signal?.aborted || this.workspace.workspace !== this.workspaceIdentity ||
          (this.workspace.workspace?.workspaceId || this.workspace.workspace?.id) !== this.workspaceId) throw fail("OPERATION_ABORTED");
    }
    time() { return Number(this.now ? this.now() : Date.now()); }
    async withinMaintenanceBudget(work, options) {
      const remaining = options.deadline - this.time();
      if (remaining <= 0) throw Object.assign(fail("WIKI_MAINTENANCE_DEADLINE"), { attempts: 0 });
      const controller = new AbortController(); let timer, abort;
      const stopped = new Promise((_, reject) => {
        abort = () => { controller.abort(); reject(fail("OPERATION_ABORTED")); };
        options.signal?.addEventListener("abort", abort, { once: true });
        timer = (this.setMaintenanceTimeout || setTimeout)(() => { controller.abort(); reject(Object.assign(fail("WIKI_MAINTENANCE_DEADLINE"), { attempts: 0 })); }, remaining);
      });
      try { this.assertActive(options); return await Promise.race([work(controller.signal), stopped]); }
      finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
    }
    sourceVersions(topic) {
      return [...topic.paperIds].sort().map(sourceId => ({ sourceId, contentHash: this.registry.get(sourceId)?.contentHash || null }));
    }
    async observeEvidence(topic, changed) {
      const dependencies = this.sourceVersions(topic);
      const fingerprint = await this.hashValue(dependencies);
      const saved = topic.wikiEvidence;
      const recovery = topic.wikiMaintenance?.timeoutRecovery;
      if (recovery && recovery.evidenceFingerprint !== fingerprint && recovery.status !== "superseded") {
        recovery.status = "superseded"; recovery.supersededAt = this.time();
        await this.topics.persist();
      }
      const published = !saved ? await this.read(topic) : null;
      const lastProviderAttempt = topic.wikiMaintenance?.attempts?.findLast(attempt => attempt.dependencies?.length && ["generation", "validation", "publication"].includes(attempt.stage));
      const prior = saved?.dependencies || lastProviderAttempt?.dependencies || published?.dependencies || topic.wikiMaintenance?.dependencies || dependencies;
      const previous = new Map(prior.map(item => [item.sourceId, item.contentHash]));
      const rawChanged = dependencies.some(item => previous.has(item.sourceId) && previous.get(item.sourceId) !== item.contentHash) ||
        prior.some(item => !this.registry.get(item.sourceId)) ||
        dependencies.some(item => changed.has(item.sourceId) && (!saved || !previous.has(item.sourceId)));
      const attempted = new Set(saved?.attemptedFingerprints || []);
      let interrupted = false;
      for (const attempt of topic.wikiMaintenance?.attempts || []) if (attempt.status === "running") {
        attempt.status = "interrupted"; attempt.finishedAt = this.time(); interrupted = true;
        topic.wikiMaintenance.status = "pending";
        if (recovery?.status === "running") recovery.status = "interrupted";
      }
      // Migrate old persisted attempts without granting another automatic call.
      if (!saved) for (const attempt of topic.wikiMaintenance?.attempts || []) {
        if (attempt.dependencies?.length && (["generation", "validation", "publication"].includes(attempt.stage) || attempt.providerAttempts > 0)) {
          attempted.add(await this.hashValue(attempt.dependencies.map(({ sourceId, contentHash }) => ({ sourceId, contentHash })).sort((a, b) => a.sourceId.localeCompare(b.sourceId))));
        }
      }
      if (published) attempted.add(await this.hashValue(published.dependencies.map(({ sourceId, contentHash }) => ({ sourceId, contentHash })).sort((a, b) => a.sourceId.localeCompare(b.sourceId))));
      const eligibleFingerprint = rawChanged ? fingerprint : saved?.eligibleFingerprint === fingerprint ? fingerprint : null;
      const state = { schemaVersion: 1, fingerprint, dependencies, eligibleFingerprint,
        trigger: rawChanged ? saved || topic.wiki ? "raw_evidence_changed" : "initial_ingestion" : saved?.trigger || null,
        attemptedFingerprints: [...attempted] };
      if (interrupted || JSON.stringify(state) !== JSON.stringify(saved)) { topic.wikiEvidence = state; await this.topics.persist(); }
      const timeoutRetry = recovery?.status === "retryable_timeout" && recovery.evidenceFingerprint === fingerprint;
      return { evidenceFingerprint: fingerprint, timeoutRetry, eligible: timeoutRetry || eligibleFingerprint === fingerprint && !attempted.has(fingerprint),
        skipReason: attempted.has(fingerprint) ? "evidence_already_attempted" : "no_raw_evidence_change" };
    }
    // Admission lives on the same authoritative index as revisions/attempts.
    // maintain() serializes admissions and commits reservations before provider work.
    async admitPages(candidates, explicit, options) {
      const current = this.registry.list({ sourceKind: "paper" }).filter(source => !["missing", "removed", "deleted"].includes(source.catalogStatus));
      const currentIds = new Set(current.map(source => source.sourceId));
      const occupied = topic => Boolean(topic.wiki || topic.wikiDraft || topic.wikiAdmission ||
        topic.wikiMaintenance?.attempts?.some(attempt => attempt.generationStarted || attempt.providerAttempts > 0 || ["generation", "validation", "publication"].includes(attempt.stage)));
      const reserved = this.topics.topics.filter(occupied);
      const counted = new Set(reserved.map(topic => topic.topicId));
      const report = { projectPaperCount: currentIds.size, automaticPageCeiling: automaticPageCeiling(currentIds.size),
        topicCandidateCount: candidates.length, existingReservedPageCount: counted.size,
        admittedCandidateCount: 0, totalReservedPageCount: counted.size, remainingHeadroom: 0,
        deferredCandidateCount: 0, rejectedCandidateCount: 0, deferredReasons: {} };
      const reservations = new Map(this.topics.topics.map(topic => [topic, topic.wikiAdmission]));
      // Retain old slots above the ceiling; their presence grants no expansion.
      const owners = new Map();
      for (const topic of [...reserved].sort((a, b) => Number(Boolean(b.wiki)) - Number(Boolean(a.wiki)) || a.topicId.localeCompare(b.topicId))) {
        if (!owners.has(admissionKey(topic))) owners.set(admissionKey(topic), topic.topicId);
      }
      const rank = topic => ["concept", "method", "comparison"].includes(topic.pageKind) ? 2 : topic.pageKind === "entity" ? 1 : 0;
      candidates = [...candidates].sort((a, b) => Number(counted.has(b.topicId)) - Number(counted.has(a.topicId)) ||
        rank(b) - rank(a) || b.paperIds.length - a.paperIds.length || a.topicId.localeCompare(b.topicId));
      const deferred = [], admitted = [], prepared = new Map(), durations = new Map(); let changed = false;
      const logger = options.logger || this.runtimeLog || root.BioDesignRuntimeLog;
      const logCandidate = (topic, fields) => logger?.record("wiki.candidate-admission", { pageId: topic.topicId,
        turnId: options.callContext?.turnId || options.turnId, stage: "admission", remainingMaintenanceMs: Math.max(0, options.deadline - this.time()), ...fields });
      for (const topic of candidates) {
        this.assertActive(options);
        const started = this.time(), key = admissionKey(topic), existing = counted.has(topic.topicId);
        let reason, code, diagnostics = [], transient = false;
        if (topic.paperIds.length < 2) reason = "insufficient_support";
        else if (topic.paperIds.length > contract.LIMITS.papers || new Set(topic.paperIds).size !== topic.paperIds.length) reason = "unsupported_source_scope";
        else if (topic.paperIds.some(id => !currentIds.has(id))) reason = "missing_source";
        else if (topic.paperIds.some(id => {
          const source = this.registry.get(id);
          return source.hashStatus !== "ready" || !this.preparation.capabilitySatisfied(source, "full_text");
        })) { reason = "source_not_ready"; transient = true; }
        else if (owners.has(key) && owners.get(key) !== topic.topicId) reason = "redundant_candidate";
        else if (!existing && counted.size >= report.automaticPageCeiling) reason = "page_ceiling";
        else if (this.time() >= options.deadline) { reason = "maintenance_deadline"; transient = true; }
        else if (options.configuration) {
          try {
            // The same source checks and input builder used at dispatch determine admission.
            const input = await this.withinMaintenanceBudget(async signal => {
              const checkedOptions = { ...options, signal };
              await this.checkSources(topic, checkedOptions);
              // Current valid pages need no new model input and no prompt-version regeneration.
              if (existing && !options.analysisRequest && await this.readForUse(topic, { ...checkedOptions, paperCardContract: options.configurationResult })) return null;
              return this.prepare(topic, options.configuration, options.configurationResult, checkedOptions);
            }, options);
            if (this.time() >= options.deadline) { reason = "maintenance_deadline"; transient = true; }
            else prepared.set(topic.topicId, input);
          } catch (error) {
            if (error.code === "OPERATION_ABORTED") throw error;
            code = error.code || "WIKI_PREPARATION_FAILED";
            reason = code === "WIKI_MAINTENANCE_DEADLINE" ? "maintenance_deadline" : code === "WIKI_INPUT_LIMIT" ? "input_size_limit" : code === "WIKI_COMPATIBLE_CARD_REQUIRED" ? "compatible_card_required" : "evidence_preparation_failed";
            diagnostics = error.validationProblems || [];
            transient = !["WIKI_INPUT_LIMIT", "WIKI_INVALID_EVIDENCE"].includes(code);
          }
        } else if (!existing) { reason = options.configurationError ? "configuration_unavailable" : "generation_unavailable"; transient = true; }
        if (reason) {
          const result = { pageId: topic.topicId, status: transient ? "deferred" : "rejected", category: transient ? "deferred" : "rejected",
            pending: transient, generationSkipped: true, reason, code: code || `WIKI_${reason.toUpperCase()}`,
            validationProblems: diagnostics, requiredAction: {
              insufficient_support: "Use at least two distinct supporting papers.",
              unsupported_source_scope: "Use 2–20 distinct supporting papers.",
              missing_source: "Restore or reconcile missing sources before updating this page.",
              source_not_ready: "Finish preparing current original evidence, then invoke maintenance again.",
              redundant_candidate: "Use the existing topic page; an alias does not receive another slot.",
              page_ceiling: "Refresh an existing eligible page; the project has no new-page headroom.",
              maintenance_deadline: "Invoke maintenance again to continue; no automatic retry is scheduled.",
              compatible_card_required: "Prepare compatible Paper Cards before requesting this update.",
              input_size_limit: "Narrow the topic or incorporated analysis to fit wiki input limits.",
              evidence_preparation_failed: "Reconcile original evidence and address the validation diagnostics before retrying.",
              configuration_unavailable: "Restore the selected model configuration, then invoke maintenance again.",
              generation_unavailable: "Configure the wiki provider before requesting generation.",
            }[reason], attempts: 0, stage: "admission", eligibilityOutcome: "ineligible",
            durationMs: Math.max(0, this.time() - started), remainingMaintenanceMs: Math.max(0, options.deadline - this.time()),
            automaticRetry: false, automaticRetryScheduled: false, retryEligibility: transient ? "future_maintenance_after_prerequisite" : "requires_eligibility_change" };
          deferred.push(result);
          logCandidate(topic, { eligibilityOutcome: "ineligible", outcome: result.category, reason, code: result.code, durationMs: result.durationMs, providerAttempts: 0 });
          report.deferredReasons[reason] = (report.deferredReasons[reason] || 0) + 1;
          continue;
        }
        if (!topic.wikiAdmission) {
          topic.wikiAdmission = { schemaVersion: 1, origin: existing ? "legacy" : explicit ? "explicit" : "automatic", admittedAt: this.time(), key };
          changed = true;
        }
        if (!existing) { counted.add(topic.topicId); report.admittedCandidateCount++; }
        owners.set(key, topic.topicId); admitted.push(topic);
        durations.set(topic.topicId, Math.max(0, this.time() - started));
        logCandidate(topic, { eligibilityOutcome: "eligible", outcome: existing ? "existing_slot" : "new_slot", durationMs: durations.get(topic.topicId), providerAttempts: 0 });
      }
      report.totalReservedPageCount = counted.size;
      report.remainingHeadroom = Math.max(0, report.automaticPageCeiling - counted.size);
      report.deferredCandidateCount = deferred.filter(page => page.category === "deferred").length;
      report.rejectedCandidateCount = deferred.filter(page => page.category === "rejected").length;
      if (changed) {
        this.assertActive(options);
        try { await this.topics.persist(); }
        catch (error) {
          for (const [topic, previous] of reservations) { if (previous) topic.wikiAdmission = previous; else delete topic.wikiAdmission; }
          throw error;
        }
      }
      return { candidates: admitted, deferred, report, prepared, durations };
    }
    async preparationPending(topic, configuration, options) {
      const dependencies = this.sourceVersions(topic);
      const analysisRequest = options.analysisRequest || topic.wikiMaintenance?.analysisRequest || (await this.read(topic))?.analysisRequest || "";
      const version = { pageId: topic.topicId, configuration: configuration || null, dependencies, analysisRequest,
        requestedModel: options.callContext?.model || null };
      this.pending(topic, { ...version, inputKey: await this.hashValue(version) });
    }
    // Stored on the authoritative topic index, never in model-authored prose.
    // A running attempt surviving a restart is still pending, not successful.
    pending(topic, version) {
      const previous = topic.wikiMaintenance;
      const same = previous?.inputKey === version.inputKey;
      const attempts = clone(previous?.attempts || []).slice(-ATTEMPT_HISTORY);
      for (const attempt of attempts.filter(item => item.status === "running")) {
        attempt.status = "interrupted"; attempt.finishedAt = this.time();
      }
      const previousAttempt = attempts.findLast(attempt => attempt.inputKey === version.inputKey);
      const retry = same ? previous : previousAttempt?.status === "failed" ? previousAttempt : {};
      topic.wikiMaintenance = { schemaVersion: 1, status: "pending", ...version,
        pendingSince: same ? previous.pendingSince || this.time() : this.time(),
        failureCount: retry.failureCount || 0,
        nextRetryAt: retry.nextRetryAt || 0,
        lastFailure: retry.lastFailure || retry.failure || null, attempts,
        ...(previous?.timeoutRecovery ? { timeoutRecovery: clone(previous.timeoutRecovery) } : {}) };
      return topic.wikiMaintenance;
    }
    failure(error) {
      return { code: String(error.code || "WIKI_UPDATE_FAILED").slice(0, 80),
        validationProblems: (error.validationProblems || []).slice(0, 8).map(value => String(value).slice(0, 500)),
        providerStatus: Number(error.providerStatus || error.status) || null,
        providerAttempts: Number.isInteger(error.attempts) ? error.attempts : null,
        retryAfterMs: Math.max(0, Number(error.retryAfterMs) || 0) };
    }
    deferred(topic, reason) {
      const state = topic.wikiMaintenance;
      return { pageId: topic.topicId, status: "stale", pending: true, reason,
        code: state?.lastFailure?.code || `WIKI_${reason.toUpperCase()}`,
        validationProblems: state?.lastFailure?.validationProblems || [],
        nextRetryAt: ["evidence_already_attempted", "no_raw_evidence_change"].includes(reason) ? null : state?.nextRetryAt || null,
        explicitRetryAfter: state?.nextRetryAt || null, attempts: 0,
        lastFailure: state?.lastFailure || null, generationSkipped: true,
        evidenceFingerprint: topic.wikiEvidence?.fingerprint || null, automaticRetry: false,
        ...this.attemptStatus(topic), lastAttempt: this.attemptStatus(topic), elapsedMs: 0,
        transportStarted: false, providerRequestStarted: false, providerCompletion: "not_started",
        outcome: reason === "timeout_cooldown" ? "cooling_down" : "deferred_without_attempt" };
    }
    attemptStatus(topic) {
      const state = topic.wikiMaintenance, last = state?.attempts?.at(-1), recovery = state?.timeoutRecovery;
      const active = Boolean(recovery && recovery.evidenceFingerprint === topic.wikiEvidence?.fingerprint);
      return { outcome: last?.status || "deferred_without_attempt", failureStage: last?.failure ? last.stage : null, timeoutCount: active ? recovery?.timeoutCount || 0 : 0,
        nextEligibleAt: active && recovery.status === "retryable_timeout" ? recovery.nextRetryAt : null,
        elapsedMs: last?.generationDurationMs || 0, transportStarted: last?.transportStarted || false,
        providerRequestStarted: last?.providerRequestStarted ?? null, providerCompletion: last?.providerCompletion || "unknown",
        automaticRetry: false, automaticRetryScheduled: false,
        retryEligibleOnFutureMaintenance: active && recovery?.status === "retryable_timeout" };
    }
    estimatedDuration(topic, configuration) {
      const own = (topic.wikiMaintenance?.attempts || []).filter(attempt => attempt.generationStarted && attempt.generationDurationMs > 0 && attempt.configuration?.modelSignature === configuration.modelSignature);
      const observations = own.length ? own : this.topics.topics.flatMap(item => item.wikiMaintenance?.attempts || [])
        .filter(attempt => attempt.generationStarted && attempt.generationDurationMs > 0 && attempt.configuration?.modelSignature === configuration.modelSignature);
      // 90s fallback; 25% margin over the slowest observation, capped at 4min
      // so a page always fits at the start of a fresh five-minute run.
      return observations.length ? Math.min(240000, Math.max(60000, Math.ceil(Math.max(...observations.map(attempt => attempt.generationDurationMs)) * 1.25))) : 90000;
    }
    schedule(candidates, eligibility, explicit) {
      const attempts = this.topics.topics.flatMap(topic => topic.wikiMaintenance?.attempts || []).filter(attempt => attempt.generationStarted);
      const last = attempts.sort((a, b) => (b.scheduleSequence || 0) - (a.scheduleSequence || 0))[0];
      const groups = { fresh: [], timeout_retry: [], passive: [] };
      for (const topic of candidates) {
        const evidence = eligibility.get(topic.topicId), recovery = topic.wikiMaintenance?.timeoutRecovery;
        const kind = evidence.timeoutRetry ? recovery.nextRetryAt <= this.time() ? "timeout_retry" : "passive" : explicit || evidence.eligible ? "fresh" : "passive";
        groups[kind].push(topic);
      }
      for (const group of Object.values(groups)) group.sort((a, b) =>
        (a.wikiMaintenance?.attempts?.findLast(attempt => attempt.generationStarted)?.scheduleSequence || 0) -
        (b.wikiMaintenance?.attempts?.findLast(attempt => attempt.generationStarted)?.scheduleSequence || 0) || a.topicId.localeCompare(b.topicId));
      let next = last?.scheduledClass === "fresh" && last?.status !== "retryable_timeout" ? "timeout_retry" : "fresh";
      const scheduled = [];
      while (groups.fresh.length || groups.timeout_retry.length) {
        if (!groups[next].length) next = next === "fresh" ? "timeout_retry" : "fresh";
        scheduled.push(groups[next].shift()); next = next === "fresh" ? "timeout_retry" : "fresh";
      }
      return [...scheduled, ...groups.passive];
    }
    async recordFailure(topic, error, stage) {
      const state = topic.wikiMaintenance, detail = this.failure(error);
      const attempt = state.attempts.at(-1);
      const newFailure = attempt?.status === "running" || state.lastFailure?.code !== detail.code || state.nextRetryAt <= this.time();
      if (attempt?.status === "running" && detail.providerAttempts === null) detail.providerAttempts = attempt.providerAttempts;
      if (attempt?.status === "running") Object.assign(attempt, { status: error.code === "OPERATION_ABORTED" ? "cancelled" : "failed",
        finishedAt: this.time(), stage, failure: detail, providerAttempts: detail.providerAttempts ?? attempt.providerAttempts });
      else if (state.lastFailure?.code !== detail.code || state.nextRetryAt <= this.time()) {
        state.attempts.push({ inputKey: state.inputKey, configuration: state.configuration, dependencies: state.dependencies,
          requestedModel: state.requestedModel || state.configuration?.modelSignature || null,
          startedAt: this.time(), finishedAt: this.time(), status: "failed", stage, failure: detail, providerAttempts: 0 });
      }
      state.attempts = state.attempts.slice(-ATTEMPT_HISTORY);
      state.status = "pending"; state.lastFailure = detail;
      if (error.code !== "OPERATION_ABORTED" && newFailure) {
        state.failureCount = Math.min(16, state.failureCount + 1);
        state.nextRetryAt = this.time() + Math.max(detail.retryAfterMs, Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (state.failureCount - 1)));
      } else if (error.code === "OPERATION_ABORTED") state.nextRetryAt = 0;
      const timedOut = error.localWikiDeadline === true && attempt?.generationStarted && stage === "generation";
      if (timedOut) {
        const old = state.timeoutRecovery;
        const timeoutCount = (old?.evidenceFingerprint === attempt.evidenceFingerprint ? old.timeoutCount || 0 : 0) + 1;
        state.nextRetryAt = this.time() + TIMEOUT_COOLDOWNS[Math.min(3, timeoutCount - 1)];
        state.timeoutRecovery = { status: "retryable_timeout", evidenceFingerprint: attempt.evidenceFingerprint,
          timeoutCount, nextRetryAt: state.nextRetryAt, configuration: clone(attempt.configuration), dependencies: clone(attempt.dependencies) };
        attempt.status = "retryable_timeout"; attempt.timeoutCount = timeoutCount;
      } else if (attempt?.generationStarted && ["generation", "validation", "publication"].includes(stage) && state.timeoutRecovery?.status === "running") {
        state.timeoutRecovery.status = error.code === "OPERATION_ABORTED" ? "cancelled" : "failed";
      }
      if (newFailure) Object.assign(state.attempts.at(-1), { nextRetryAt: state.nextRetryAt, failureCount: state.failureCount });
      topic.summaryStatus = await this.readForUse(topic) ? "ready" : "stale";
      // Cancellation may save the journal only in its original workspace.
      this.assertActive();
      await this.topics.persist();
    }
    async checkSources(topic, options) {
      for (const id of topic.paperIds) {
        this.assertActive(options);
        const source = this.registry.get(id);
        if (!source || source.sourceKind !== "paper") throw fail("WIKI_SOURCE_CHANGED", ["missing-source"]);
        if (source.hashStatus !== "ready") throw fail("WIKI_SOURCE_CHANGED", ["stale-source"]);
        let hash;
        try { hash = await this.hashSourceBytes(new Uint8Array(await (await this.workspace.readFile(source.path)).arrayBuffer())); }
        catch { throw fail("WIKI_SOURCE_CHANGED", ["missing-source"]); }
        if (hash !== source.contentHash) throw fail("WIKI_SOURCE_CHANGED", ["stale-source"]);
      }
      this.assertActive(options);
    }
    async project(topic, options) {
      this.assertActive(options);
      await this.topics.renderAndIndex([topic.topicId]);
      this.assertActive(options);
      topic.wikiMaintenance.projectionPending = false;
      const last = topic.wikiMaintenance.attempts.at(-1);
      const failedReplacement = topic.wikiMaintenance.lastFailure && ["generation", "validation", "publication"].includes(last?.stage) && last.status !== "published";
      if (!failedReplacement) Object.assign(topic.wikiMaintenance, { status: "current", lastFailure: null, nextRetryAt: 0, failureCount: 0 });
      await this.topics.persist();
    }
    async read(topic, pointer = topic?.wiki) {
      if (!pointer?.path || !pointer.path.startsWith(`.biodesign/knowledge/wiki_pages/${topic.topicId}/`) || pointer.path.includes("..")) return null;
      try {
        const record = await this.workspace.readJson(pointer.path);
        if (record?.pageId !== topic.topicId || !Array.isArray(record.dependencies)) return null;
        if (!contract.isMarkdownPage(record.page) && (!record.page?.explanation ||
            ["findings", "disagreements", "openQuestions", "relatedPageIds"].some(key => !Array.isArray(record.page[key])) ||
            contract.statements(record.page).some(statement => !Array.isArray(statement.evidence)))) return null;
        return record;
      } catch { return null; }
    }
    // Historical records remain readable via read(). All publication, cache reuse
    // and current-evidence consumers go through this read-only integrity gate.
    async inspect(topic, record, options = {}) {
      const issues = [], papers = [];
      const scope = options.hardSelection || options.paperIds?.length ? new Set(options.paperIds || []) : null;
      if (!record || record.pageId !== topic.topicId) return { issues: ["missing-page"] };
      if (record.dependencies.length !== topic.paperIds.length || topic.paperIds.some(id => !record.dependencies.some(dep => dep.sourceId === id))) issues.push("stale-dependencies");
      for (const dependency of record.dependencies) {
        this.assertActive(options);
        const source = this.registry.get(dependency.sourceId);
        if (!topic.paperIds.includes(dependency.sourceId) || (scope && !scope.has(dependency.sourceId))) issues.push("out-of-scope-reference");
        if (!source || source.sourceKind !== "paper" || ["missing", "removed", "deleted"].includes(source.catalogStatus)) { issues.push("missing-source"); continue; }
        if (source.contentHash !== dependency.contentHash || source.hashStatus !== "ready") issues.push("stale-source");
        // Recheck physical bytes as well as the registry, including edits made
        // while a provider request was running. This never edits source files.
        try {
          const checked = options.reconciledSources?.get(source.sourceId);
          if (!checked || checked.contentHash !== dependency.contentHash || checked.statSignature !== source.statSignature) {
            const file = await this.workspace.readFile(source.path);
            if (await this.hashSourceBytes(new Uint8Array(await file.arrayBuffer())) !== dependency.contentHash) issues.push("stale-source");
          }
        } catch { issues.push("missing-source"); }
        const card = await this.corpusWorkflows.readValidPaperCardForCorpusMap(source, options.paperCardContract);
        if (card?.contentIdentity !== dependency.cardIdentity) issues.push("stale-card");
        try {
          const parsed = await this.preparation.readPaperArtifact(source.sourceId);
          if (parsed.contentHash !== dependency.contentHash) { issues.push("stale-evidence"); continue; }
          if (issues.includes("out-of-scope-reference") || source.contentHash !== dependency.contentHash || source.hashStatus !== "ready") continue;
          const evidence = (parsed.chunks || []).map(chunk => ({ reference: `${source.sourceId}:p${chunk.page}:${chunk.chunkId}`, text: chunk.text || "" }));
          const links = contract.continuityLinks(evidence);
          for (const item of evidence) if (links.get(item.reference)?.length) item.continuity = links.get(item.reference);
          papers.push({ paperId: source.sourceId, contentHash: dependency.contentHash, evidence });
        } catch { issues.push("missing-evidence"); }
      }
      const input = { pageId: topic.topicId, papers, relatedPages: this.topics.topics
        .filter(other => other.topicId !== topic.topicId && other.paperIds.length && (!scope || other.paperIds.every(id => scope.has(id))))
        .map(other => ({ pageId: other.topicId })) };
      const validationProblems = contract.validatePage(record.page, input);
      if (validationProblems.length && !options.allowDraft) issues.push("unsupported-reference");
      if (record.contentHash && record.contentHash !== await this.hashValue(record.page)) issues.push("changed-page-content");
      this.assertActive(options);
      return { issues: unique(issues), validationProblems, integrity: contract.citationIntegrity(record.page, input) };
    }
    async readForUse(topic, options = {}) {
      const record = await this.read(topic);
      const checked = await this.inspect(topic, record, options);
      return checked.issues.length || !this.compatible(record, options.configuration || topic.wikiCompatibility) ? null : { ...record, integrity: checked.integrity };
    }
    compatible(record, configuration) {
      if (!record) return false;
      if (!configuration) return true;
      // Version-one saved prose remains readable through the existing legacy gate.
      if ((record.page?.schemaVersion === 1 && record.configuration?.promptVersion === "literature-wiki-v1") || (record.page?.schemaVersion === 2 && record.configuration?.promptVersion === "literature-wiki-markdown-v2")) return record.configuration.modelSignature === configuration.modelSignature && record.configuration.evidenceVersion === configuration.evidenceVersion;
      return contract.sameConfiguration(record.configuration, configuration);
    }
    async readDraftForUse(topic, options = {}) {
      const record = await this.read(topic, topic.wikiDraft);
      if (!record || !this.compatible(record, options.configuration || topic.wikiCompatibility)) return null;
      const checked = await this.inspect(topic, record, { ...options, allowDraft: true });
      return checked.issues.length ? null : { ...record, integrity: checked.integrity, publicationStatus: "unverified_draft" };
    }
    async saveDraft(topic, prepared, response, page, options) {
      if (!contract.isMarkdownPage(page)) return;
      const contentHash = await this.hashValue(page);
      const auditHash = await this.hashValue(response.generationAudit || null);
      const path = `.biodesign/knowledge/wiki_pages/${topic.topicId}/${prepared.key}-${contentHash}-${auditHash}.draft.json`;
      const record = { schemaVersion: contract.VERSION.schemaVersion, pageId: topic.topicId, key: prepared.key,
        configuration: prepared.input.configuration, dependencies: prepared.dependencies, evidenceFingerprint: options.evidenceFingerprint,
        page: clone(page), contentHash, publicationStatus: "unverified_draft",
        integrity: contract.citationIntegrity(page, prepared.input), validationProblems: contract.publicationProblems(page, prepared.input),
        generation: { attempts: response.attempts ?? null, usage: response.usage || null, audit: response.generationAudit || null }, updatedAt: new Date().toISOString() };
      this.assertActive(options);
      await this.workspace.writeJson(path, record);
      this.assertActive(options);
      const old = topic.wikiDraft;
      topic.wikiDraft = { path, key: prepared.key, updatedAt: record.updatedAt };
      try { await this.topics.persist(); } catch (error) { topic.wikiDraft = old; throw error; }
      // Keep prior draft bytes as an audit trail; never erase an unresolved original during repair.
    }
    async dependencies(topic, paperCardContract, options = {}) {
      const result = [];
      for (const paperId of [...topic.paperIds].sort()) {
        const source = this.registry.get(paperId);
        let cached = await this.corpusWorkflows.readValidPaperCardForCorpusMap(source, paperCardContract);
        // Wiki maintenance never regenerates a card for compatibility or history.
        if (!cached) throw fail("WIKI_COMPATIBLE_CARD_REQUIRED");
        result.push({ sourceId: paperId, contentHash: source.contentHash, cardIdentity: cached.contentIdentity });
      }
      return result;
    }
    async prepare(topic, configuration, paperCardContract, options) {
      this.assertActive(options);
      if (topic.paperIds.length < 2 || topic.paperIds.length > contract.LIMITS.papers) throw fail("WIKI_SUBJECT_SCOPE_LIMIT");
      const dependencies = await this.dependencies(topic, paperCardContract, options);
      const previous = await this.read(topic);
      const current = new Map(dependencies.map(item => [item.sourceId, item]));
      const unchanged = new Set((previous?.dependencies || []).filter(item => current.get(item.sourceId)?.contentHash === item.contentHash).map(item => item.sourceId));
      // Only still-supported previous statements are eligible for preservation.
      const keep = statement => statement.evidence.every(item => unchanged.has(item.reference.split(":p")[0]));
      const existingPage = contract.isMarkdownPage(previous?.page)
        ? (previous.dependencies.every(item => unchanged.has(item.sourceId)) ? previous.page : null)
        : previous?.page ? { ...previous.page,
        findings: previous.page.findings.filter(keep), disagreements: previous.page.disagreements.filter(keep),
        openQuestions: previous.page.openQuestions.filter(keep),
      } : null;
      if (existingPage && !contract.isMarkdownPage(existingPage) && !keep(existingPage.explanation)) existingPage.explanation = null;
      const relatedPages = this.topics.topics.filter(other => other.topicId !== topic.topicId && other.paperIds.some(id => topic.paperIds.includes(id)))
        .sort((a, b) => a.topicId.localeCompare(b.topicId)).slice(0, 12).map(other => ({ pageId: other.topicId, label: other.label }));
      const words = tokens(topic.label);
      const retainedRefs = new Set(contract.references(existingPage));
      const papers = [], chunksByPaper = new Map();
      for (const dependency of dependencies) {
        const source = this.registry.get(dependency.sourceId);
        const card = (await this.corpusWorkflows.readValidPaperCardForCorpusMap(source, paperCardContract)).card;
        const original = await this.preparation.readPaperArtifact(source.sourceId);
        if (original.contentHash !== dependency.contentHash) throw fail("WIKI_SOURCE_CHANGED");
        const chunks = (original.chunks || []).map(chunk => ({ reference: `${source.sourceId}:p${chunk.page}:${chunk.chunkId}`, text: chunk.text || "" }));
        chunksByPaper.set(source.sourceId, chunks);
        const ranked = chunks.map(item => ({ ...item, score: words.reduce((n, word) => n + (item.text.toLowerCase().includes(word) ? 1 : 0), 0) }))
          .sort((a, b) => b.score - a.score);
        const selected = unique([...chunks.filter(item => retainedRefs.has(item.reference)), ...ranked.slice(0, 3)].map(item => item.reference));
        const evidence = contract.selectEvidence(chunks, selected, 0);
        const orientation = { title: String(card.title || "").slice(0, 500), researchQuestion: String(card.researchQuestion || "").slice(0, 1000),
          summary: String(card.summary || "").slice(0, 2000), methods: (card.methods || []).slice(0, 8).map(value => String(value).slice(0, 200)) };
        papers.push({ paperId: source.sourceId, contentHash: source.contentHash, card: orientation, evidence });
      }
      const input = { pageId: topic.topicId, label: topic.label, kind: topic.pageKind || "concept", configuration, papers,
        existingPage, relatedPages, analysisRequest: options.analysisRequest || topic.wikiMaintenance?.analysisRequest || previous?.analysisRequest || "" };
      const evidenceStarted = this.time();
      for (const paper of papers) {
        const chunks = chunksByPaper.get(paper.paperId);
        const remaining = Math.max(0, contract.LIMITS.inputCharacters - JSON.stringify(input).length - 4000);
        const expanded = contract.selectEvidence(chunks, paper.evidence.map(e => e.reference), Math.min(3600, Math.floor(remaining / 2)));
        const previous = paper.evidence;
        paper.evidence = expanded;
        if (JSON.stringify(input).length > contract.LIMITS.inputCharacters) paper.evidence = previous;
      }
      root.BioDesignRuntimeLog?.record("wiki.evidence_prepared", { stage: "adjacent_context", turnId: options.callContext?.turnId, sourceCount: papers.length,
        included: papers.reduce((n, p) => n + p.evidence.length, 0), durationMs: Math.max(0, this.time() - evidenceStarted) });
      // A corrupt or stale historical revision is never model evidence for its
      // own repair. Original chunks and compatible cards remain authoritative.
      if (contract.isMarkdownPage(input.existingPage)) {
        if (contract.validatePage(input.existingPage, input).length) input.existingPage = null;
      } else if (input.existingPage) {
        const supported = statement => {
          const refs = new Set((statement?.evidence || []).map(item => item.reference));
          const page = { schemaVersion: 1, pageId: topic.topicId, explanation: statement, findings: [statement], disagreements: [], openQuestions: [], relatedPageIds: [] };
          return !contract.validatePage(page, { ...input, papers: papers.filter(paper => paper.evidence.some(item => refs.has(item.reference))) }).length;
        };
        if (!supported(input.existingPage.explanation)) input.existingPage.explanation = null;
        for (const field of ["findings", "disagreements", "openQuestions"]) input.existingPage[field] = input.existingPage[field].filter(supported);
        input.existingPage.relatedPageIds = input.existingPage.relatedPageIds.filter(id => relatedPages.some(page => page.pageId === id));
      }
      if (previous?.contentHash && previous.contentHash !== await this.hashValue(previous.page)) input.existingPage = null;
      const inputProblems = contract.validateInput(input);
      if (inputProblems.length) throw fail(inputProblems.some(problem => /evidence/i.test(problem)) ? "WIKI_INVALID_EVIDENCE" : "WIKI_INPUT_LIMIT", inputProblems);
      const key = await this.hashValue({ configuration, pageId: topic.topicId, kind: input.kind, dependencies,
        relatedPageIds: relatedPages.map(item => item.pageId), analysisRequest: input.analysisRequest });
      return { input, dependencies, previous, key };
    }
    async update(topic, configuration, paperCardContract, options) {
      const current = await this.readForUse(topic, { ...options, configuration });
      if (current && options.timeoutRetry && current.key === topic.wikiMaintenance?.inputKey) {
        Object.assign(topic.wikiMaintenance, { status: "current", lastFailure: null, nextRetryAt: 0, failureCount: 0 });
        topic.wikiMaintenance.timeoutRecovery.status = "published";
        await this.topics.persist();
        options = { ...options, timeoutRetry: false };
      }
      if (current && !options.analysisRequest && !options.timeoutRetry) {
        const missingProjection = !(await this.workspace.fileExists(`.biodesign/knowledge/topics/${topic.topicId}.md`));
        topic.summaryStatus = "ready";
        if (missingProjection || topic.wikiMaintenance?.projectionPending) {
          if (!topic.wikiMaintenance) await this.preparationPending(topic, configuration, options);
          if (options.deadline > this.time()) await this.project(topic, options);
          else return { ...this.deferred(topic, "budget_exhausted"), projectionPending: true };
        }
        if (topic.wikiMaintenance?.lastFailure) {
          const last = topic.wikiMaintenance.attempts.at(-1);
          if (["configuration", "preparation"].includes(last?.stage)) {
            Object.assign(topic.wikiMaintenance, { status: "current", configuration, lastFailure: null, nextRetryAt: 0, failureCount: 0 });
            await this.topics.persist();
          } else return { ...this.deferred(topic, options.skipReason), currentRevisionAvailable: true };
        }
        return { pageId: topic.topicId, status: "reused", generationSkipped: true, reason: "current_cached_revision", attempts: 0 };
      }
      if (!options.allowGeneration) {
        // Currentness checks and pending-state reporting do not prepare provider
        // inputs, regenerate cards, or turn a missing page into spending consent.
        if (topic.wikiMaintenance?.configuration?.modelSignature !== configuration.modelSignature || !topic.wikiMaintenance) {
          await this.preparationPending(topic, configuration, options); await this.topics.persist();
        }
        const last = topic.wikiMaintenance.attempts.findLast(attempt => attempt.evidenceFingerprint === options.evidenceFingerprint && ["generation", "validation", "publication"].includes(attempt.stage));
        if (last?.failure && topic.wikiMaintenance.lastFailure?.code !== last.failure.code) {
          Object.assign(topic.wikiMaintenance, { lastFailure: last.failure, nextRetryAt: last.nextRetryAt || 0, failureCount: last.failureCount || 0 });
          await this.topics.persist();
        }
        topic.summaryStatus = "stale";
        return this.deferred(topic, options.deferReason || (options.eligible ? "budget_exhausted" : options.skipReason));
      }
      let prepared;
      try {
        await this.checkSources(topic, options);
        prepared = options.admittedPreparation || await this.prepare(topic, configuration, paperCardContract, options);
      } catch (error) {
        if (error.code !== "OPERATION_ABORTED") await this.preparationPending(topic, configuration, options);
        throw error;
      }
      if (topic.wiki?.key === prepared.key && contract.sameConfiguration(prepared.previous?.configuration, configuration) &&
          !contract.validatePage(prepared.previous?.page, prepared.input).length &&
          (await this.readForUse(topic, { ...options, paperCardContract }))) {
        const missingProjection = !(await this.workspace.fileExists(`.biodesign/knowledge/topics/${topic.topicId}.md`));
        if (topic.wikiMaintenance?.status !== "current" || missingProjection || topic.wikiMaintenance?.projectionPending) {
          const state = this.pending(topic, { inputKey: prepared.key, configuration, dependencies: prepared.dependencies, analysisRequest: prepared.input.analysisRequest });
          topic.summaryStatus = "ready";
          state.projectionPending = true;
          await this.topics.persist();
          if (state.nextRetryAt > this.time()) return { ...this.deferred(topic, "cooldown"), projectionPending: true };
          if (options.deadline <= this.time()) return { ...this.deferred(topic, "budget_exhausted"), projectionPending: true };
          await this.project(topic, options);
        }
        return { pageId: topic.topicId, status: "reused" };
      }
      const state = this.pending(topic, { inputKey: prepared.key, configuration, dependencies: prepared.dependencies, analysisRequest: prepared.input.analysisRequest });
      topic.summaryStatus = "stale";
      await this.topics.persist();
      if (!options.allowGeneration) return this.deferred(topic, options.eligible ? "budget_exhausted" : "not_requested");
      if (options.deadline <= this.time()) return this.deferred(topic, "budget_exhausted");
      if (state.timeoutRecovery?.evidenceFingerprint === options.evidenceFingerprint && state.timeoutRecovery.status === "retryable_timeout" && state.timeoutRecovery.nextRetryAt > this.time()) return this.deferred(topic, "timeout_cooldown");
      if (state.nextRetryAt > this.time()) return this.deferred(topic, "cooldown");
      // A rate limit applies to this selected model across its pages. No sleeping
      // or background retry loop: the next request can resume after Retry-After.
      const throttledUntil = Math.max(0, ...this.topics.topics.flatMap(item => item.wikiMaintenance?.attempts || [])
        .filter(attempt => attempt.configuration?.modelSignature === configuration.modelSignature && attempt.failure?.providerStatus === 429)
        .map(attempt => attempt.nextRetryAt || 0));
      if (throttledUntil > this.time()) return { ...this.deferred(topic, "provider_cooldown"), nextRetryAt: throttledUntil };
      return this.jobs.runDeduplicated(`wiki:${topic.topicId}:${options.evidenceFingerprint}`, "update-literature-wiki", topic.paperIds, async () => {
        this.assertActive(options);
        const estimate = this.estimatedDuration(topic, configuration);
        if (options.deadline - this.time() < estimate) return this.deferred(topic, "insufficient_remaining_time");
        state.status = "running";
        const attempt = { inputKey: prepared.key, evidenceFingerprint: options.evidenceFingerprint, configuration: clone(configuration), dependencies: clone(prepared.dependencies),
          startedAt: this.time(), status: "running", stage: "generation", providerAttempts: null,
          generationStarted: false, transportStarted: false, providerRequestStarted: false, providerCompletion: "not_started",
          scheduledClass: options.timeoutRetry ? "timeout_retry" : "fresh",
          scheduleSequence: 1 + Math.max(0, ...this.topics.topics.flatMap(item => item.wikiMaintenance?.attempts || []).map(item => item.scheduleSequence || 0)) };
        state.attempts = [...state.attempts, attempt].slice(-ATTEMPT_HISTORY);
        await this.topics.persist();
        this.assertActive(options);
        if (options.deadline - this.time() < estimate) {
          state.status = "pending";
          Object.assign(attempt, { status: "deferred", finishedAt: this.time(), providerAttempts: 0 });
          await this.topics.persist();
          return this.deferred(topic, "insufficient_remaining_time");
        }
        // Persist before crossing the provider boundary. A crash/cancellation
        // with an unknown provider outcome must not cause an automatic re-send.
        const previousFingerprints = [...topic.wikiEvidence.attemptedFingerprints];
        const previousRecoveryStatus = state.timeoutRecovery?.status;
        attempt.generationStarted = true; attempt.providerRequestStarted = null; attempt.providerCompletion = "unknown";
        if (state.timeoutRecovery?.evidenceFingerprint === options.evidenceFingerprint) state.timeoutRecovery.status = "running";
        topic.wikiEvidence.attemptedFingerprints = unique([...topic.wikiEvidence.attemptedFingerprints, options.evidenceFingerprint]);
        await this.topics.persist();
        this.assertActive(options);
        // Persistence itself can use the remaining budget. No adapter call has
        // happened yet, so this known local deferral must not consume evidence.
        if (options.deadline - this.time() < estimate) {
          topic.wikiEvidence.attemptedFingerprints = previousFingerprints;
          if (state.timeoutRecovery) state.timeoutRecovery.status = previousRecoveryStatus;
          state.status = "pending";
          Object.assign(attempt, { status: "deferred", generationStarted: false, finishedAt: this.time(),
            providerAttempts: 0, providerRequestStarted: false, providerCompletion: "not_started" });
          await this.topics.persist();
          return this.deferred(topic, "insufficient_remaining_time");
        }
        (options.logger || this.runtimeLog || root.BioDesignRuntimeLog)?.record("wiki.page-stage", { pageId: topic.topicId,
          turnId: options.callContext?.turnId || options.turnId, stage: "generation", providerAttempts: null,
          remainingMaintenanceMs: Math.max(0, options.deadline - this.time()) });
        this.metrics.generationCalls++;
        const generationStarted = this.time();
        let response;
        try {
          response = await this.generateWithinBudget(prepared.input, { ...options, onRequestQueued: () => { attempt.transportQueued = true; }, onRequestStarted: async () => {
            this.assertActive(options); attempt.transportStarted = true; await this.topics.persist();
          } });
        } catch (error) {
          // The client may still be waiting for its shared provider cooldown.
          // A deadline before dispatch is known not to have reached FC.
          if ((error.localWikiDeadline || error.code === "ProviderRateLimited") && attempt.transportQueued && !attempt.transportStarted) {
            topic.wikiEvidence.attemptedFingerprints = previousFingerprints;
            if (state.timeoutRecovery) state.timeoutRecovery.status = previousRecoveryStatus;
            state.status = "pending";
            state.nextRetryAt = Math.max(state.nextRetryAt || 0, this.time() + (Number(error.retryAfterMs) || 0));
            Object.assign(attempt, { status: "deferred", generationStarted: false, finishedAt: this.time(),
              providerAttempts: 0, providerRequestStarted: false, providerCompletion: "not_started" });
            this.metrics.generationCalls--;
            await this.topics.persist();
            return this.deferred(topic, "provider_cooldown_before_dispatch");
          }
          if (Number.isInteger(error.attempts)) attempt.providerRequestStarted = error.attempts > 0;
          if (error.code === "INVALID_WIKI_PAGE" && error.attempts > 0) {
            attempt.stage = "validation"; attempt.providerCompletion = "response_received";
          }
          if (error.attempts === 0) attempt.providerCompletion = "not_started";
          else if (error.attempts > 0 && Number(error.providerStatus || error.status) >= 400 && Number(error.providerStatus || error.status) < 500 && Number(error.providerStatus || error.status) !== 408) attempt.providerCompletion = "rejected";
          if (Number.isInteger(error.attempts)) this.metrics.providerAttempts += error.attempts;
          else this.metrics.unknownProviderAttempts++;
          throw error;
        } finally {
          if (attempt.generationStarted) {
            attempt.generationDurationMs = Math.max(0, this.time() - generationStarted);
            this.metrics.generationMs += attempt.generationDurationMs;
          }
        }
        if (Number.isInteger(response?.attempts)) this.metrics.providerAttempts += response.attempts;
        else this.metrics.unknownProviderAttempts++;
        attempt.providerAttempts = response?.attempts ?? null;
        attempt.providerRequestStarted = Number.isInteger(response?.attempts) ? response.attempts > 0 : null;
        attempt.providerCompletion = response?.attempts === 0 ? "not_started" : "response_received";
        attempt.initialGenerationMs = response?.generationAudit?.calls?.filter(call => call.stage === "generation").reduce((n, call) => n + call.durationMs, 0) ?? null;
        attempt.repairMs = response?.generationAudit?.calls?.filter(call => call.stage === "repair").reduce((n, call) => n + call.durationMs, 0) ?? null;
        attempt.stage = "validation";
        this.assertActive(options);
        if (!contract.sameConfiguration(response?.configuration, configuration)) throw fail("WIKI_CONFIGURATION_CHANGED");
        const validationStarted = this.time();
        const normalized = contract.normalizeMarkdown(response?.page, prepared.input);
        if (contract.isMarkdownPage(response?.page)) {
          if (response.generationAudit && normalized.repairs.length) response.generationAudit.hostRepairs = normalized.repairs;
          response.generationAudit ||= { outputs: [{ stage: "generation", rawPage: clone(response.page), repairs: normalized.repairs }] };
          response.page = normalized.page;
        }
        const validationProblems = contract.publicationProblems(response?.page, prepared.input);
        root.BioDesignRuntimeLog?.record("wiki.validation", { stage: "publication", turnId: options.callContext?.turnId, repairAttempted: Boolean(response.generationAudit?.modelRepairCalls),
          durationMs: Math.max(0, this.time() - validationStarted),
          repairedCount: [...(response.generationAudit?.outputs || []).flatMap(output => output.repairs || []), ...(response.generationAudit?.hostRepairs || [])].reduce((n, repair) => n + repair.count, 0), validationCount: validationProblems.length,
          outcome: validationProblems.length ? "unverified_draft" : "references_validated" });
        if (validationProblems.length) {
          await this.saveDraft(topic, prepared, response, response?.page, options);
          throw Object.assign(fail("INVALID_WIKI_PAGE", validationProblems), { attempts: response.attempts ?? null });
        }
        const page = clone(response.page);
        // Carry forward supported prior findings/open questions and disagreements.
        // A provider cannot silently erase an inconvenient, unchanged finding.
        for (const key of contract.isMarkdownPage(page) ? [] : ["findings", "disagreements", "openQuestions"]) {
          for (const old of prepared.input.existingPage?.[key] || []) {
            if (!page[key].some(item => item.kind === old.kind && item.text === old.text)) page[key].push(old);
          }
        }
        const mergedProblems = contract.validatePage(page, prepared.input);
        if (mergedProblems.length) throw fail("INVALID_WIKI_MERGE", mergedProblems);
        const latest = await this.prepare(topic, configuration, paperCardContract, options);
        if (latest.key !== prepared.key) throw fail("WIKI_SOURCE_CHANGED");
        this.assertActive(options);
        const path = `.biodesign/knowledge/wiki_pages/${topic.topicId}/${prepared.key}.json`;
        const record = { schemaVersion: contract.VERSION.schemaVersion, pageId: topic.topicId, key: prepared.key,
          configuration, dependencies: prepared.dependencies, evidenceFingerprint: options.evidenceFingerprint, page, contentHash: await this.hashValue(page),
          generation: { attempts: response.attempts ?? null, usage: response.usage || null, audit: response.generationAudit || null },
          integrity: contract.citationIntegrity(page, prepared.input),
          analysisRequest: prepared.input.analysisRequest, updatedAt: new Date().toISOString() };
        const checked = await this.inspect(topic, record, { ...options, reconciledSources: null, paperCardContract });
        if (checked.issues.length) throw fail("WIKI_SOURCE_CHANGED", checked.issues);
        this.assertActive(options);
        attempt.stage = "publication";
        await this.workspace.writeJson(path, record);
        try { this.assertActive(options); }
        catch (error) {
          if (this.workspace.workspace === this.workspaceIdentity && topic.wiki?.path !== path) await this.workspace.removeFile(path);
          throw error;
        }
        const old = { wiki: topic.wiki, wikiMaintenance: clone(state), summaryStatus: topic.summaryStatus, summaryVersion: topic.summaryVersion };
        const history = [topic.wiki, ...(topic.wiki?.history || [])].filter(Boolean)
          .map(item => ({ path: item.path, key: item.key, updatedAt: item.updatedAt })).slice(0, contract.LIMITS.history - 1);
        topic.wiki = { path, key: prepared.key, configuration, updatedAt: record.updatedAt, history };
        topic.summaryStatus = "ready"; topic.summaryVersion = prepared.key;
        Object.assign(attempt, { status: "published", finishedAt: this.time() });
        if (state.timeoutRecovery?.evidenceFingerprint === options.evidenceFingerprint) state.timeoutRecovery.status = "published";
        Object.assign(state, { status: "pending", projectionPending: true, failureCount: 0, nextRetryAt: 0, lastFailure: null });
        try { await this.topics.persist(); }
        catch (error) {
          Object.assign(topic, old);
          if (old.wiki?.path !== path) try { await this.workspace.removeFile(path); } catch { /* An unpublished revision is never served. */ }
          throw error;
        }
        // The immutable JSON + committed index are authoritative. Markdown is a
        // searchable projection, so index/renderer failure never loses a valid page.
        try { await this.project(topic, options); }
        catch (error) { error.code ||= "WIKI_PROJECTION_FAILED"; throw error; }
        // Keep historical revision bytes; only the navigation history is bounded.
        return { pageId: topic.topicId, status: "updated", attempts: attempt.providerAttempts, ...this.attemptStatus(topic) };
      }, options);
    }
    async generateWithinBudget(input, options) {
      const remaining = options.deadline - this.time();
      if (remaining <= 0) throw Object.assign(fail("WIKI_BUDGET_EXHAUSTED"), { attempts: 0 });
      const controller = new AbortController();
      let timer, abort;
      const stopped = new Promise((_, reject) => {
        abort = () => { reject(fail("OPERATION_ABORTED")); controller.abort(); };
        options.signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
          reject(options.signal?.aborted ? fail("OPERATION_ABORTED") : Object.assign(fail("WIKI_MAINTENANCE_TIMEOUT"), { localWikiDeadline: true }));
          controller.abort();
        }, remaining);
      });
      try {
        this.assertActive(options);
        return await Promise.race([this.generateWikiPage(input, { ...options, signal: controller.signal }), stopped]);
      } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
    }
    async maintain(options = {}) {
      const run = this.queue.then(async () => {
        const started = this.time(), deadline = Math.min(Number.isFinite(options.deadline) ? options.deadline : Infinity, started + RUN_BUDGET_MS);
        let result;
        try { result = await this.maintainInternal({ ...options, deadline }); }
        catch (error) {
          (options.logger || this.runtimeLog || root.BioDesignRuntimeLog)?.record("wiki.maintenance-outcome", { stage: "maintenance",
            code: error.code || "WIKI_MAINTENANCE_FAILED", outcome: error.code === "OPERATION_ABORTED" ? "cancelled" : "failed",
            durationMs: Math.max(0, this.time() - started), remainingMaintenanceMs: Math.max(0, deadline - this.time()),
            deadlineReached: this.time() >= deadline, automaticRetryScheduled: false, executionMode: "foreground" });
          throw error;
        }
        if (options.action === "check") return result;
        const counts = { updated: 0, reused: 0, rejected: 0, failed: 0, deferred: 0 };
        for (const page of result.pages || []) {
          page.category ||= ["updated", "reused", "rejected", "deferred"].includes(page.status) ? page.status : page.generationSkipped ? "deferred" : "failed";
          counts[page.category]++;
          page.automaticRetryScheduled = false; page.automaticRetry = false;
          const evidence = this.topics.topics.find(topic => topic.topicId === page.pageId)?.wikiEvidence;
          const unattemptedEvidence = evidence?.eligibleFingerprint === evidence?.fingerprint && evidence?.fingerprint && !evidence.attemptedFingerprints?.includes(evidence.fingerprint);
          page.retryEligibility ||= page.retryEligibleOnFutureMaintenance ? "future_maintenance_after_cooldown" : !page.pending ? "none" :
            unattemptedEvidence ? "future_maintenance" : "explicit_retry_or_new_evidence";
        }
        const knownProviderAttempts = result.providerAttempts ?? 0;
        const report = { ...result, counts, knownProviderAttempts, providerAttempts: result.unknownProviderAttempts > 0 ? null : knownProviderAttempts,
          deadlineReached: this.time() >= deadline, durationMs: Math.max(0, this.time() - started),
          remainingMaintenanceMs: Math.max(0, deadline - this.time()), pendingPages: (result.pages || []).filter(page => page.pending).map(page => ({ pageId: page.pageId, reason: page.reason || page.code, retryEligibility: page.retryEligibility })),
          automaticRetryScheduled: false, executionMode: "foreground", outcome: counts.failed || counts.deferred ? "incomplete" : counts.rejected ? "completed_with_rejections" : "completed" };
        const logger = options.logger || this.runtimeLog || root.BioDesignRuntimeLog;
        for (const page of report.pages || []) logger?.record("wiki.page-outcome", {
          pageId: page.pageId, turnId: options.callContext?.turnId || options.turnId, stage: page.stage || "configuration",
          eligibilityOutcome: page.eligibilityOutcome, outcome: page.category, reason: page.reason, code: page.code,
          durationMs: page.durationMs ?? page.elapsedMs ?? 0, admissionMs: page.admissionMs, remainingMaintenanceMs: page.remainingMaintenanceMs ?? report.remainingMaintenanceMs,
          providerAttempts: page.attempts ?? null, providerAttemptsKnown: Number.isInteger(page.attempts),
          initialGenerationMs: page.initialGenerationMs ?? null, repairMs: page.repairMs ?? null,
          providerCompletion: page.providerCompletion, automaticRetryScheduled: false,
          retryEligibility: page.retryEligibility,
        });
        logger?.record("wiki.maintenance-outcome", { turnId: options.callContext?.turnId || options.turnId, outcome: report.outcome,
          durationMs: report.durationMs, remainingMaintenanceMs: report.remainingMaintenanceMs, deadlineReached: report.deadlineReached,
          updatedPageCount: counts.updated, reusedPageCount: counts.reused, rejectedPageCount: counts.rejected,
          failedPageCount: counts.failed, deferredPageCount: counts.deferred, pendingPageCount: report.pendingPages.length,
          knownProviderAttempts, unknownProviderAttempts: report.unknownProviderAttempts || 0,
          automaticRetryScheduled: false, executionMode: "foreground" });
        return report;
      });
      this.queue = run.catch(() => {});
      return run;
    }
    async maintainInternal(options) {
      this.assertActive(options);
      await this.topics.load();
      const statuses = new Map(this.topics.topics.map(topic => [topic.topicId, topic.summaryStatus]));
      if (options.action === "check") {
        let configuration;
        try { configuration = (await this.getPaperCardConfiguration?.(options.signal, options.callContext, this.workspace.workspace || this.workspace))?.wikiConfiguration; }
        catch { this.assertActive(options); }
        return this.lint({ ...options, configuration });
      }
      const scoped = options.hardSelection || options.paperIds?.length ? new Set(options.paperIds || []) : null;
      const changed = new Set(options.changedPaperIds || []);
      const explicit = ["update", "incorporate"].includes(options.action);
      let candidates = this.topics.topics.filter(topic => (topic.wiki || topic.wikiDraft || topic.wikiAdmission || topic.wikiMaintenance || topic.paperIds.length) && (!scoped || topic.paperIds.length && topic.paperIds.every(id => scoped.has(id))));
      if (options.action === "incorporate") {
        const words = tokens(options.analysisRequest).filter(word => !/^(wiki|literature|incorporate|analysis|comparison|compare|into|the|and|save|add)$/.test(word));
        candidates = candidates.filter(topic => tokens(topic.label).some(word => words.includes(word)));
        if (!candidates.length) return { status: "no-matching-subject", pages: [], generationCalls: 0 };
        if (/\bcompar(?:e|ison)\b|比较/i.test(options.analysisRequest) && candidates.length) {
          if (candidates.length > 1) return { status: "ambiguous-subject", pages: [], generationCalls: 0 };
          const base = candidates[0], topicId = `comparison-${base.topicId}`.slice(0, 100);
          let comparison = this.topics.topics.find(topic => topic.topicId === topicId);
          if (!comparison) {
            comparison = { ...clone(base), topicId, label: `${base.label} comparison`, pageKind: "comparison", parentTopicIds: [base.topicId], wiki: undefined, wikiDraft: undefined, wikiEvidence: undefined, wikiMaintenance: undefined, wikiAdmission: undefined, summary: null, summaryStatus: "stale", summaryVersion: null };
            this.topics.topics.push(comparison); await this.topics.persist();
          }
          candidates = [comparison];
        }
      }
      const eligibility = new Map();
      for (const topic of candidates) eligibility.set(topic.topicId, await this.observeEvidence(topic, changed));
      let configurationResult, configuration, configurationError;
      if (candidates.length && this.getPaperCardConfiguration && this.generateWikiPage && this.time() < options.deadline) try {
        configurationResult = await this.withinMaintenanceBudget(signal => this.getPaperCardConfiguration(signal, options.callContext, this.workspace.workspace || this.workspace), options);
        configuration = configurationResult?.wikiConfiguration;
        if (!contract.sameConfiguration(configuration, contract.configuration(configuration?.modelSignature))) throw fail("WIKI_CONFIGURATION_UNAVAILABLE");
      } catch (error) { this.assertActive(options); configurationError = error; configuration = null; }
      const admission = await this.admitPages(candidates, explicit, { ...options, configuration, configurationResult, configurationError });
      candidates = admission.candidates;
      const admissionReport = admission.report;
      if (!candidates.length) return { status: !this.getPaperCardConfiguration || !this.generateWikiPage ? "offline" : configurationError ? "unavailable" : admission.deferred.some(page => page.pending) ? "partial" : "ready", pages: admission.deferred, admission: admissionReport, generationCalls: 0, providerAttempts: 0, skippedGenerationCount: admission.deferred.length };
      if (!this.getPaperCardConfiguration || !this.generateWikiPage) {
        const pages = [...admission.deferred];
        for (const topic of candidates) {
          const revision = await this.readForUse(topic, options);
          const status = revision ? "ready" : "stale";
          if (topic.summaryStatus !== status) { topic.summaryStatus = status; await this.topics.persist(); }
          pages.push({ pageId: topic.topicId, status: revision ? "reused" : "stale", pending: !revision,
            generationSkipped: true, reason: "generation_unavailable", attempts: 0, automaticRetry: false });
        }
        return { status: "offline", pages, admission: admissionReport, generationCalls: 0, providerAttempts: 0, unknownProviderAttempts: 0, skippedGenerationCount: pages.length };
      }
      if (configurationError) {
        const error = configurationError;
        error.attempts = 0; // Configuration transport never calls the model.
        const pages = [...admission.deferred];
        for (const topic of candidates) {
          await this.preparationPending(topic, configuration, options);
          await this.recordFailure(topic, error, "configuration");
          pages.push(this.deferred(topic, "configuration_unavailable"));
        }
        return { status: "unavailable", pages, admission: admissionReport, generationCalls: 0, providerAttempts: 0, unknownProviderAttempts: 0 };
      }
      const before = this.metrics.generationCalls, generationMsBefore = this.metrics.generationMs, providerBefore = this.metrics.providerAttempts, unknownBefore = this.metrics.unknownProviderAttempts, pages = [...admission.deferred];
      const deadline = options.deadline;
      candidates = this.schedule([...new Map(candidates.map(topic => [topic.topicId, topic])).values()], eligibility, explicit);
      for (const topic of candidates) {
        this.assertActive(options);
        const evidence = eligibility.get(topic.topicId);
        const eligible = explicit || evidence.eligible;
        const recovery = topic.wikiMaintenance?.timeoutRecovery;
        const deferReason = evidence.timeoutRetry && recovery.nextRetryAt > this.time() ? "timeout_cooldown" :
          deadline - this.time() < this.estimatedDuration(topic, configuration) ? "insufficient_remaining_time" : null;
        const allowGeneration = Boolean(this.generateWikiPage) && eligible && !deferReason;
        if (!contract.sameConfiguration(topic.wikiCompatibility, configuration)) { topic.wikiCompatibility = clone(configuration); await this.topics.persist(); }
        const callsBefore = this.metrics.generationCalls, pageStarted = this.time();
        try {
          const result = await this.update(topic, configuration, configurationResult, { ...options, ...evidence, eligible, allowGeneration, deferReason, deadline, admittedPreparation: admission.prepared.get(topic.topicId) });
          const last = topic.wikiMaintenance?.attempts?.at(-1);
          pages.push({ ...result, attempts: result.attempts ?? (result.status === "reused" ? 0 : null), stage: result.status === "updated" ? "publication" : "scheduling",
            eligibilityOutcome: "eligible", durationMs: Math.max(0, this.time() - pageStarted) + (admission.durations.get(topic.topicId) || 0), admissionMs: admission.durations.get(topic.topicId) || 0, remainingMaintenanceMs: Math.max(0, deadline - this.time()),
            initialGenerationMs: this.metrics.generationCalls > callsBefore ? last?.initialGenerationMs ?? null : 0,
            repairMs: this.metrics.generationCalls > callsBefore ? last?.repairMs ?? null : 0 });
          if (result.status === "stale" && !result.projectionPending && !result.currentRevisionAvailable) topic.summaryStatus = "stale";
          if (result.status === "reused") topic.summaryStatus = "ready";
        } catch (error) {
          if (this.metrics.generationCalls === callsBefore) error.attempts = 0;
          if (topic.wikiMaintenance && this.workspace.workspace === this.workspaceIdentity) {
            try {
              const last = topic.wikiMaintenance.attempts.at(-1);
              if (last?.status === "running") error.attempts ??= last.providerAttempts;
              await this.recordFailure(topic, error, last?.status === "running" ? last.stage : topic.wikiMaintenance.projectionPending ? "projection" : "preparation");
            } catch (storageError) {
              // The old committed revision remains authoritative. Missing/stale
              // pages and any persisted running attempt are discoverable next time.
              if (error.code !== "OPERATION_ABORTED") error = Object.assign(fail("WIKI_MAINTENANCE_STATE_FAILED"), { cause: storageError, attempts: error.attempts ?? null });
            }
          }
          this.assertActive(options);
          if (error.code === "OPERATION_ABORTED") throw error;
          topic.summaryStatus = await this.readForUse(topic, options) ? "ready" : "stale";
          pages.push({ pageId: topic.topicId, status: "stale", pending: true, ...this.failure(error),
            attempts: error.attempts ?? null, nextRetryAt: topic.wikiMaintenance?.nextRetryAt || null, draftSaved: Boolean(topic.wikiDraft), ...this.attemptStatus(topic), category: "failed", stage: topic.wikiMaintenance?.attempts?.at(-1)?.stage || "preparation",
            eligibilityOutcome: "eligible_at_admission", durationMs: Math.max(0, this.time() - pageStarted) + (admission.durations.get(topic.topicId) || 0), admissionMs: admission.durations.get(topic.topicId) || 0, remainingMaintenanceMs: Math.max(0, deadline - this.time()),
            initialGenerationMs: this.metrics.generationCalls > callsBefore ? topic.wikiMaintenance?.attempts?.at(-1)?.initialGenerationMs ?? null : 0, repairMs: this.metrics.generationCalls > callsBefore ? topic.wikiMaintenance?.attempts?.at(-1)?.repairMs ?? null : 0 });
        }
      }
      if (this.topics.topics.some(topic => statuses.get(topic.topicId) !== topic.summaryStatus)) {
        try { await this.topics.persist(); }
        catch {
          this.assertActive(options);
          pages.push({ pageId: null, status: "stale", pending: true, code: "WIKI_MAINTENANCE_STATE_FAILED", attempts: 0 });
        }
      }
      return { status: pages.some(page => page.status === "stale") ? "partial" : "ready", pages, admission: admissionReport, generationCalls: this.metrics.generationCalls - before,
        skippedGenerationCount: pages.filter(page => page.generationSkipped).length,
        generationMs: this.metrics.generationMs - generationMsBefore,
        providerAttempts: this.metrics.providerAttempts - providerBefore, unknownProviderAttempts: this.metrics.unknownProviderAttempts - unknownBefore, configuration };
    }

    async lint(options = {}) {
      this.assertActive(options); await this.topics.load();
      const pages = [];
      const all = this.topics.topics.filter(topic => topic.wiki && (!options.paperIds?.length || topic.paperIds.every(id => options.paperIds.includes(id))));
      for (const topic of all.slice(0, contract.LIMITS.lintPages)) {
        this.assertActive(options);
        const record = await this.read(topic), issues = [];
        if (!record) issues.push("missing-page");
        else {
          if (!(await this.workspace.fileExists(`.biodesign/knowledge/topics/${topic.topicId}.md`))) issues.push("missing-projection");
          if (!contract.sameConfiguration(record.configuration, options.configuration || contract.configuration(record.configuration?.modelSignature))) issues.push("incompatible-generation");
          const dependencies = new Set(record.dependencies.map(item => item.sourceId));
          if (contract.references(record.page).some(reference => !dependencies.has(String(reference).split(":p")[0]))) issues.push("unsupported-reference");
          issues.push(...(await this.inspect(topic, record, options)).issues);
          for (const pageId of record.page.relatedPageIds || []) if (!this.topics.topics.some(other => other.topicId === pageId && other.paperIds.length) ||
              !(await this.workspace.fileExists(`.biodesign/knowledge/topics/${pageId}.md`))) issues.push("broken-link");
          for (const dependency of record.dependencies) {
            const source = this.registry.get(dependency.sourceId);
            if (!source) { issues.push("missing-source"); continue; }
            if (source.contentHash !== dependency.contentHash) issues.push("stale-source");
            const card = await this.corpusWorkflows.readValidPaperCardForCorpusMap(source);
            if (card?.contentIdentity !== dependency.cardIdentity) issues.push("stale-card");
            try {
              const parsed = await this.preparation.readPaperArtifact(source.sourceId);
              for (const support of contract.statements(record.page).flatMap(statement => statement.evidence).filter(item => item.reference.startsWith(`${source.sourceId}:p`))) {
                const chunk = parsed.chunks.find(chunk => `${source.sourceId}:p${chunk.page}:${chunk.chunkId}` === support.reference);
                if (!chunk || !String(chunk.text).replace(/\s+/g, " ").includes(support.quote.replace(/\s+/g, " "))) issues.push("unsupported-reference");
              }
            } catch { issues.push("missing-evidence"); }
          }
          if (topic.summaryStatus !== "ready") issues.push("stale-dependencies");
          if (record.page.disagreements?.length) issues.push("model-assisted-disagreement-review");
        }
        pages.push({ pageId: topic.topicId, issues: unique(issues) });
      }
      return { status: "checked", pages, truncated: all.length > pages.length, generationCalls: 0, semanticContradictionsAreVerified: false };
    }
    search(query, limit = 5) {
      const words = tokens(query);
      return this.topics.topics.filter(topic => topic.wiki || topic.wikiDraft).map(topic => ({ sourceId: topic.topicId, title: topic.label,
        score: words.filter(word => `${topic.label} ${topic.pageKind}`.toLowerCase().includes(word)).length }))
        .filter(item => item.score).sort((a, b) => b.score - a.score).slice(0, limit);
    }
  }
  return { LiteratureWikiService, automaticPageCeiling };
});
