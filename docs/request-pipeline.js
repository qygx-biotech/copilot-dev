(function exposeRequestPipeline(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";
  const SYNC_VERSION = 1;
  const SYNC_TASK = "synchronize knowledge base through required derived layers";
  const SYNC_CAPABILITIES = Object.freeze([
    "describe_source", "ensure_source_ready", "generate_paper_card", "update_topics",
    "normalize_experiment", "prepare_document", "remove_derived_source_artifacts",
    "record_readiness", "update_project_metadata",
  ]);
  const unique = (ids) => [...new Set(ids || [])];
  const clock = () => root.performance?.now?.() ?? Date.now();
  const counts = () => ({ papers: 0, experiments: 0, documents: 0 });
  const kindKey = (kind) => kind === "paper" ? "papers" : kind === "experiment" ? "experiments" : "documents";
  const emptyReport = () => ({ status: "completed", added: counts(), removed: counts(),
    updated: { l1Evidence: 0, paperCards: 0, topicMemberships: 0, experimentSources: 0, documents: 0 },
    failures: [], sources: [] });
  const safeCode = (error) => String(error?.code || "KNOWLEDGE_SYNC_FAILED").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);

  function synchronized(source) {
    if (!source.contentHash || source.hashStatus !== "ready") return false;
    if (source.knowledgeSync) return source.knowledgeSync.status === "SYNC_READY" && source.knowledgeSync.contentHash === source.contentHash;
    const current = (artifact) => artifact?.contentHash === source.contentHash;
    // Older projects already maintain these layers, but have no new sync marker.
    // A timestamp touch must not invalidate their valid topic/card associations.
    if (source.sourceKind === "paper") return source.indexStatus === "ready" && source.paperCardStatus === "ready" &&
      current(source.artifacts?.paperText) && current(source.artifacts?.paperCard) &&
      current(source.artifacts?.knowledgeMarkdown) && current(source.artifacts?.paperCardMarkdown);
    if (source.sourceKind === "experiment") return source.structuredDataStatus === "ready" && current(source.artifacts?.experimentData) && current(source.artifacts?.experimentNote);
    return current(source.artifacts?.documentMarkdown);
  }

  // A bounded maintenance worker: no conversational model loop, shell, recommendation
  // writer, user query, conversation, raw tool transcript, or arbitrary tool dispatch.
  class KnowledgeSyncAgent {
    constructor(capabilities) {
      if (Object.keys(capabilities).some((key) => !SYNC_CAPABILITIES.includes(key))) throw new Error("Unknown sync capability");
      this.tools = Object.freeze({ ...capabilities });
    }
    async run(input, progress = () => {}) {
      if (!input.workspaceId || input.task !== SYNC_TASK || Object.keys(input).some((key) => !["workspaceId", "changes", "task"].includes(key))) throw new Error("Invalid sync input");
      const report = emptyReport();
      const jobs = [
        ...unique(input.changes.removed).map((sourceId) => ({ sourceId, operation: "removed" })),
        ...unique([...(input.changes.added || []), ...(input.changes.modified || [])])
          .filter((id) => !input.changes.removed.includes(id))
          .map((sourceId) => ({ sourceId, operation: input.changes.added.includes(sourceId) ? "added" : "modified" })),
      ];
      let cursor = 0, completed = 0, activeCardWorkers = 0;
      await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, async (_, workerIndex) => {
        while (cursor < jobs.length) {
          const { sourceId, operation } = jobs[cursor++];
          let stage = "verify", source = this.tools.describe_source(sourceId);
          const stages = {};
          const sourceStarted = clock();
          const step = (nextStage, details = {}) => progress({ stage: nextStage, sourceId, completed, total: jobs.length, ...details });
          try {
            if (!source) throw Object.assign(new Error(), { code: "SOURCE_NOT_FOUND" });
            if (operation === "removed") {
              stage = "remove";
              step("sync-removing");
              await this.tools.remove_derived_source_artifacts(sourceId);
              report.removed[kindKey(source.sourceKind)]++;
              await this.tools.record_readiness(sourceId, "removed", stages);
            } else {
              await this.tools.record_readiness(sourceId, "running", stages);
              step("sync-verifying");
              await this.tools.ensure_source_ready(sourceId, "stable_snapshot");
              source = this.tools.describe_source(sourceId);
              if (source.sourceKind === "paper") {
                stage = "L1";
                step("sync-evidence", { layer: "L1" });
                const l1 = await this.tools.ensure_source_ready(sourceId, "search");
                step("sync-evidence-ready", { layer: "L1", cached: l1.cached === true });
                stages.l1 = "ready";
                if (!l1.cached) report.updated.l1Evidence++;
                await this.tools.record_readiness(sourceId, "L1_READY", stages);
                stage = "L2";
                const worker = { agent: "PaperCardAgent", workerId: `paper-card-${workerIndex + 1}`, concurrency: 2, layer: "L2" };
                activeCardWorkers++;
                step("sync-paper-cards", { ...worker, activeWorkers: activeCardWorkers, status: "running" });
                let l2;
                try {
                  l2 = await this.tools.generate_paper_card(sourceId);
                } catch (error) {
                  step("sync-paper-card-worker-failed", { ...worker, activeWorkers: activeCardWorkers - 1,
                    status: error?.code === "OPERATION_ABORTED" ? "cancelled" : "failed", code: safeCode(error) });
                  throw error;
                } finally { activeCardWorkers--; }
                step("sync-paper-card-ready", { ...worker, activeWorkers: activeCardWorkers, status: "completed", cached: l2.cached === true });
                stages.l2 = "ready";
                if (!l2.cached) report.updated.paperCards++;
                await this.tools.record_readiness(sourceId, "L2_READY", stages);
                stage = "L3";
                step("sync-topics", { layer: "L3" });
                report.updated.topicMemberships += await this.tools.update_topics(sourceId);
                step("sync-topics-ready", { layer: "L3" });
                stages.l3 = "ready";
              } else if (source.sourceKind === "experiment") {
                stage = "experiment";
                step("sync-experiments");
                await this.tools.normalize_experiment(sourceId);
                report.updated.experimentSources++;
                stages.structuredData = "ready";
                stages.descriptor = "ready";
              } else {
                stage = "document";
                step("sync-document");
                await this.tools.prepare_document(sourceId);
                report.updated.documents++;
                stages.l1 = "ready";
              }
              await this.tools.record_readiness(sourceId, "SYNC_READY", stages);
              if (operation === "added") report.added[kindKey(source.sourceKind)]++;
            }
            report.sources.push({ sourceId, status: operation === "removed" ? "removed" : "ready", contentHash: source.contentHash || null });
            step("sync-source-ready", { status: operation === "removed" ? "removed" : "ready", durationMs: clock() - sourceStarted, completed: completed + 1 });
          } catch (error) {
            if (error?.code === "OPERATION_ABORTED") throw error;
            const failure = { sourceId, stage, code: safeCode(error), retryable: true };
            step("sync-source-failed", { layer: stage, code: failure.code, retryable: true, durationMs: clock() - sourceStarted });
            report.failures.push(failure);
            report.sources.push({ sourceId, status: "partial", contentHash: source?.contentHash || null });
            await this.tools.record_readiness(sourceId, "partial", stages, failure);
          }
          completed++;
        }
      }));
      report.sources.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
      report.failures.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
      try { await this.tools.update_project_metadata(); }
      catch (error) { report.failures.push({ sourceId: null, stage: "metadata", code: safeCode(error), retryable: true }); }
      report.status = report.failures.length ? "partial" : "completed";
      return report;
    }
  }

  class AgentRequestPipeline {
    constructor({ workspace, literature, sourceSystem, workspaceSignal, runtimeLog = root.BioDesignRuntimeLog }) {
      this.workspace = workspace;
      this.workspaceId = (workspace.workspace?.workspaceId || workspace.workspace?.id);
      this.workspaceSignal = workspaceSignal;
      this.literature = literature;
      this.system = sourceSystem;
      this.inFlight = null;
      this.turns = new Map();
      this.listeners = new Set();
      this.lastProgress = null;
      this.log = runtimeLog;
    }
    assertWorkspace() {
      if (this.workspaceSignal?.aborted || (this.workspaceId && (this.workspace.workspace?.workspaceId || this.workspace.workspace?.id) !== this.workspaceId)) {
        throw Object.assign(new Error("Project changed during synchronization"), { code: "OPERATION_ABORTED" });
      }
    }
    emit(event) {
      event = { runId: this.activeRunId, ...event };
      this.lastProgress = event;
      this.log?.record("preflight.stage", { runId: this.activeRunId, workspaceId: this.workspaceId, ...event },
        event.code ? "error" : event.stage === "sync-partial" ? "warn" : "info");
      for (const listener of this.listeners) { try { listener(event); } catch {} }
    }
    async preflight(options = {}) {
      if (options.signal?.aborted) throw Object.assign(new Error("Request cancelled"), { code: "OPERATION_ABORTED" });
      const key = options.turnId;
      const listener = options.onProgress;
      if (listener) { this.listeners.add(listener); if (this.inFlight && this.lastProgress) listener(this.lastProgress); }
      try {
        let promise = key && this.turns.get(key);
        if (!promise) {
          // Different model selections must not share a provider task. Serialize
          // maintenance so concurrent surfaces still cannot write the same artifacts.
          const model = options.callContext?.model || "";
          while (this.inFlight && this.inFlightModel !== model) {
            await this.inFlight.catch(() => {});
            if (options.signal?.aborted) throw Object.assign(new Error("Request cancelled"), { code: "OPERATION_ABORTED" });
          }
          if (!this.inFlight) {
            // Shared maintenance never inherits one consumer's cancellation. Every
            // consumer waits for completion; cancellation only suppresses its answer.
            const finish = this.log?.begin("preflight", { turnId: key, surface: options.surface, workspaceId: this.workspaceId });
            this.inFlightModel = model;
            const active = this.run(options).then((result) => {
              finish?.(result.report.status === "partial" ? "partial" : "completed", { ...result.telemetry, failureCount: result.report.failures.length });
              return result;
            }, (error) => {
              finish?.(error?.code === "OPERATION_ABORTED" ? "cancelled" : "failed", { code: safeCode(error) });
              throw error;
            }).finally(() => { if (this.inFlight === active) this.inFlight = null; });
            this.inFlight = active;
          } else {
            this.log?.record("preflight.joined", { turnId: key, runId: this.activeRunId, surface: options.surface });
          }
          promise = this.inFlight;
          if (key) {
            this.turns.set(key, promise);
            if (this.turns.size > 50) this.turns.delete(this.turns.keys().next().value);
            promise.catch(() => this.turns.delete(key));
          }
        }
        const result = await promise;
        if (options.signal?.aborted) throw Object.assign(new Error("Request cancelled"), { code: "OPERATION_ABORTED" });
        return result;
      } finally { if (listener) this.listeners.delete(listener); }
    }
    // Explicit host filesystem mutations invalidate the turn snapshot. Internal
    // artifact writes do not mutate L0 and never require another reconciliation.
    invalidateTurn(turnId) { this.turns.delete(turnId); }

    async run(options = {}) {
      this.assertWorkspace();
      const started = clock(), wallStarted = Date.now();
      const { registry, preparation, knowledgeLifecycle, topicService, projectState } = this.system;
      const before = { ...preparation.metrics };
      const syncTurnId = this.workspace.createId();
      this.activeRunId = syncTurnId;
      const telemetry = { reconciliationMs: 0, changedSourceCount: 0, knowledgeSyncMs: 0,
        l1UpdateCount: 0, l1UpdateMs: 0, l2LlmCallCount: 0, l2LlmMs: 0,
        l3LlmCallCount: 0, l3LlmMs: 0, l3UpdateMs: 0, experimentNormalizationCount: 0, experimentNormalizationMs: 0,
        syncAgentSpawned: false, mainAgentStartTime: null, mainAgentStartMs: 0 };
      this.emit({ stage: "preflight-checking" });
      const tree = await this.workspace.scanDirectoryTree();
      this.assertWorkspace();
      const reconciliation = await registry.reconcile(tree, { legacyDocuments: this.literature.documents });
      telemetry.reconciliationMs = clock() - started;
      const diff = reconciliation.diff;
      const changes = { added: [], removed: [], modified: [] };
      const verificationFailures = [];
      const context = { surface: options.surface || "side_chat", signal: this.workspaceSignal, turnId: syncTurnId, callContext: { ...options.callContext, turnId: syncTurnId, configurationTurnId: options.callContext?.configurationTurnId || options.turnId || options.callContext?.turnId || syncTurnId, profile: "medium" }, retrievalProfile: "medium", profile: "medium", strictKnowledgeSync: true, deferTopicUpdate: true,
        onProgress: (event) => this.emit(event) };
      for (const source of registry.list({ includeMissing: true })) {
        if (source.syncPending === "removed") changes.removed.push(source.sourceId);
        else if (source.catalogStatus === "missing") continue;
        else if (source.syncPending === "added" || !source.contentHash) changes.added.push(source.sourceId);
        else if (source.hashStatus === "dirty" || source.syncPending === "possiblyModified") {
          const oldHash = source.contentHash;
          try {
            await preparation.ensureSourceReady([source.sourceId], "stable_snapshot", context);
            if (reconciliation.changes.renamed.some((rename) => rename.sourceId === source.sourceId)) source.pathMetadataDirty = true;
            if (source.contentHash !== oldHash || !synchronized(source) || source.pathMetadataDirty) changes.modified.push(source.sourceId);
            else { source.syncPending = null; await registry.persist(); }
          } catch (error) {
            verificationFailures.push({ sourceId: source.sourceId, stage: "verify", code: safeCode(error), retryable: true });
            this.emit({ stage: "sync-source-failed", sourceId: source.sourceId, layer: "verify", code: safeCode(error), retryable: true });
          }
        } else if (source.syncPending || source.knowledgeSync?.status === "partial" ||
          (source.sourceKind === "paper" && (!source.artifacts?.knowledgeMarkdown || source.paperCardStatus !== "ready" || !source.artifacts?.paperCardMarkdown)) ||
          (source.sourceKind === "experiment" && source.structuredDataStatus !== "ready")) changes.modified.push(source.sourceId);
      }
      telemetry.changedSourceCount = unique([...changes.added, ...changes.removed, ...changes.modified, ...verificationFailures.map((item) => item.sourceId)]).length;
      let report = emptyReport();
      if (changes.added.length + changes.removed.length + changes.modified.length) {
        telemetry.syncAgentSpawned = true;
        this.emit({ stage: "preflight-changes", completed: 0, total: telemetry.changedSourceCount, added: changes.added.length, modified: changes.modified.length, removed: changes.removed.length });
        const syncStarted = clock();
        const timed = async (key, action) => { const start = clock(); try { return await action(); } finally { telemetry[key] += clock() - start; } };
        const ready = async (id, capability) => {
          this.assertWorkspace();
          const result = (await preparation.ensureSourceReady([id], capability, context)).sources[0];
          const source = registry.get(id);
          if (capability === "search" && source.pathMetadataDirty && result.cached) {
            await preparation.refreshPaperEvidenceKnowledge(source, await preparation.readPaperArtifact(id), context);
            return { ...result, cached: false };
          }
          return result;
        };
        // Serialize topic mutations; PDF/card work still runs in a two-source pool.
        let topicQueue = Promise.resolve();
        const worker = new KnowledgeSyncAgent({
          describe_source: (id) => { const s = registry.get(id, { includeMissing: true }); return s && { sourceId: id, sourceKind: s.sourceKind, contentHash: s.contentHash }; },
          ensure_source_ready: (id, capability) => capability === "search" ? timed("l1UpdateMs", () => ready(id, capability)) : ready(id, capability),
          generate_paper_card: async (id) => {
            const result = await ready(id, "paper_card");
            const source = registry.get(id);
            if (result.cached && (source.pathMetadataDirty || source.knowledgeSync?.stages?.l2 !== "ready")) {
              await preparation.refreshPaperCardKnowledge(source, await this.workspace.readJson(source.artifacts.paperCard.path), context);
            }
            return result;
          },
          update_topics: (id) => {
            const task = topicQueue.then(() => timed("l3UpdateMs", async () => {
              const source = registry.get(id);
              const card = await this.workspace.readJson(source.artifacts.paperCard.path);
              const affected = await topicService.updatePaper(source, card);
              source.artifacts.topicMembership = { sourceId: id, contentHash: source.contentHash, schemaVersion: 1, topicIds: affected };
              return affected.length;
            }));
            topicQueue = task.catch(() => {});
            return task;
          },
          normalize_experiment: (id) => ready(id, "experiment_data"),
          prepare_document: (id) => this.prepareDocument(id, context),
          remove_derived_source_artifacts: (id) => {
            const task = topicQueue.then(() => knowledgeLifecycle.removeDerivedSourceArtifacts(registry.get(id, { includeMissing: true })));
            topicQueue = task.catch(() => {});
            return task;
          },
          record_readiness: async (id, status, stages, failure) => {
            this.assertWorkspace();
            const source = registry.get(id, { includeMissing: true });
            if (!source) return;
            source.knowledgeSync = { schemaVersion: SYNC_VERSION, status, contentHash: source.contentHash,
              statSignature: source.statSignature, stages: { ...stages }, failure: failure || null, updatedAt: new Date().toISOString() };
            if (["SYNC_READY", "removed"].includes(status)) { source.syncPending = null; source.pathMetadataDirty = false; }
            else source.syncPending ||= "modified";
            await registry.persist();
          },
          update_project_metadata: async () => { if (this.workspace.state && projectState) await projectState.refreshMetadata({ surface: "side_chat" }); },
        });
        const input = { workspaceId: String((this.workspace.workspace?.workspaceId || this.workspace.workspace?.id) || "local-workspace"), changes, task: SYNC_TASK };
        report = await this.system.jobs.runDeduplicated(`knowledge-sync:${input.workspaceId}`, "knowledge-sync",
          [...changes.added, ...changes.modified, ...changes.removed],
          async () => {
            const finish = this.log?.begin("sync-agent", { agent: "KnowledgeSyncAgent", runId: syncTurnId, sourceCount: telemetry.changedSourceCount });
            try {
              const result = await worker.run(input, (event) => this.emit(event));
              for (const failure of result.failures.filter((item) => item.stage === "metadata")) this.emit({ ...failure, stage: "sync-metadata-failed" });
              finish?.(result.status === "partial" ? "partial" : "completed", { failureCount: result.failures.length });
              return result;
            } catch (error) {
              finish?.(error?.code === "OPERATION_ABORTED" ? "cancelled" : "failed", { code: safeCode(error) });
              throw error;
            }
          }, { surface: "side_chat" });
        telemetry.knowledgeSyncMs = clock() - syncStarted;
      } else {
        this.log?.record("sync-agent.skipped", { agent: "KnowledgeSyncAgent", runId: syncTurnId, stage: verificationFailures.length ? "verification-failed" : "knowledge-current", unchanged: diff.unchanged });
      }
      // A source may disappear after the metadata scan while its bytes/card are
      // being prepared. The failed read is authoritative; clean it in this turn.
      for (const source of registry.list({ includeMissing: true }).filter((source) =>
        source.catalogStatus === "missing" && source.syncPending === "removed" && !changes.removed.includes(source.sourceId))) {
        try {
          this.assertWorkspace();
          await knowledgeLifecycle.removeDerivedSourceArtifacts(source);
          source.syncPending = null;
          source.knowledgeSync = { schemaVersion: SYNC_VERSION, status: "removed", contentHash: source.contentHash, stages: {} };
          report.removed[kindKey(source.sourceKind)]++;
          const item = report.sources.find((item) => item.sourceId === source.sourceId);
          if (item) item.status = "removed";
          await registry.persist();
        } catch (error) {
          report.failures.push({ sourceId: source.sourceId, stage: "remove", code: safeCode(error), retryable: true });
        }
      }
      report.failures.push(...verificationFailures);
      if (report.failures.length) report.status = "partial";
      this.assertWorkspace();
      // Projection only: reuse the turn reconciliation, never scan/hash again.
      reconciliation.sources = registry.list();
      const catalogChanged = telemetry.syncAgentSpawned || verificationFailures.length ||
        diff.added.length || diff.removed.length || diff.possiblyModified.length || reconciliation.changes.renamed.length ||
        this.literature.documents.length !== reconciliation.sources.filter((source) => source.extension === ".pdf").length;
      if (catalogChanged) await this.literature.scan({ tree, reconciliation, deferKnowledgeMaintenance: true });
      telemetry.l1UpdateCount = report.updated.l1Evidence;
      telemetry.l2LlmCallCount = preparation.metrics.paperCardCalls - before.paperCardCalls;
      telemetry.l2LlmMs = preparation.metrics.paperCardDurationMs - before.paperCardDurationMs;
      const providerCalls = this.literature.api?.getTurnCallCounts?.(syncTurnId);
      if (providerCalls) {
        telemetry.l2LlmCallCount = ["native_pdf", "combined_text_paper_card", "paper_card_chunk", "paper_card_synthesis"].reduce((total, role) => total + (Number(providerCalls[role]) || 0), 0);
        telemetry.paperCardGenerationCount = preparation.metrics.paperCardCalls - before.paperCardCalls;
        telemetry.schemaMapperCalls = Number(providerCalls.schema_mapper) || 0;
      }
      telemetry.experimentNormalizationCount = preparation.metrics.experimentParseCalls - before.experimentParseCalls;
      telemetry.experimentNormalizationMs = preparation.metrics.experimentParseDurationMs - before.experimentParseDurationMs;
      telemetry.hashCalls = preparation.metrics.fullHashCalls - before.fullHashCalls;
      telemetry.mainAgentStartTime = new Date().toISOString();
      telemetry.mainAgentStartMs = clock() - started;
      telemetry.startedAt = wallStarted;
      console.info("request_preflight", telemetry);
      this.emit({ stage: report.status === "partial" ? "sync-partial" : telemetry.syncAgentSpawned ? "sync-ready" : "preflight-current" });
      return { tree, reconciliation, diff, report, telemetry };
    }

    async prepareDocument(id, context) {
      const { registry, preparation, knowledgeService } = this.system;
      const source = registry.get(id);
      const { file, bytes } = await preparation.readSourceBytesForUse(id, context);
      let text;
      if (source.extension === ".pdf") {
        if (!preparation.parsePaper) throw Object.assign(new Error(), { code: "PDF_PARSER_MISSING" });
        const extracted = await preparation.parsePaper({ source, file, bytes });
        text = extracted.text;
      } else if ([".md", ".txt", ".html", ".json", ".csv", ".tsv"].includes(source.extension)) {
        text = new TextDecoder().decode(bytes);
      } else throw Object.assign(new Error(), { code: "UNSUPPORTED_SOURCE_REPRESENTATION" });
      const path = `.biodesign/knowledge/memory/source-${id}.md`;
      await this.workspace.writeFile(path, `---\nsource_id: ${JSON.stringify(id)}\nsource_path: ${JSON.stringify(source.path)}\ncontent_hash: ${JSON.stringify(source.contentHash)}\nsource_kind: ${JSON.stringify(source.sourceKind)}\nrepresentation_version: 1\nauthoritative: false\n---\n\n# ${source.displayName}\n\n${text || ""}\n`);
      source.artifacts.documentMarkdown = { path, sourceId: id, contentHash: source.contentHash, schemaVersion: 1, extractorVersion: "local-source-v1" };
      if (knowledgeService?.available) await knowledgeService.indexDocuments("project-memory", { embed: false });
      source.parseStatus = "ready";
      source.indexStatus = "ready";
      await registry.persist();
    }
  }
  return { AgentRequestPipeline, KnowledgeSyncAgent, SYNC_CAPABILITIES, SYNC_TASK };
});
