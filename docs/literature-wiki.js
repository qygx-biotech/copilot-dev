(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";
  const contract = root.BioDesignLiteratureWiki || (typeof require === "function" ? require("../shared/literature-wiki.js") : {});
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = code => Object.assign(new Error(code), { code });
  const unique = values => [...new Set(values)];
  const tokens = value => unique(String(value || "").toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}|[\u3400-\u9fff]{2,}/g) || []);
  class LiteratureWikiService {
    constructor(options) {
      Object.assign(this, options);
      this.workspaceIdentity = this.workspace.workspace;
      this.workspaceId = this.workspaceIdentity?.workspaceId || this.workspaceIdentity?.id;
      this.queue = Promise.resolve();
      this.metrics = { generationCalls: 0 };
    }
    assertActive(options = {}) {
      if (options.signal?.aborted || this.workspace.workspace !== this.workspaceIdentity ||
          (this.workspace.workspace?.workspaceId || this.workspace.workspace?.id) !== this.workspaceId) throw fail("OPERATION_ABORTED");
    }
    async read(topic) {
      if (!topic?.wiki?.path || !topic.wiki.path.startsWith(`.biodesign/knowledge/wiki_pages/${topic.topicId}/`) || topic.wiki.path.includes("..")) return null;
      try {
        const record = await this.workspace.readJson(topic.wiki.path);
        if (record?.pageId !== topic.topicId || !Array.isArray(record.dependencies) || !record.page?.explanation ||
            ["findings", "disagreements", "openQuestions", "relatedPageIds"].some(key => !Array.isArray(record.page[key])) ||
            contract.statements(record.page).some(statement => !Array.isArray(statement.evidence))) return null;
        return record;
      } catch { return null; }
    }
    async dependencies(topic, paperCardContract, options = {}) {
      const result = [];
      for (const paperId of [...topic.paperIds].sort()) {
        const source = this.registry.get(paperId);
        let cached = await this.corpusWorkflows.readValidPaperCardForCorpusMap(source, paperCardContract);
        if (!cached && options.allowGeneration && source) {
          // Reuse the canonical compatibility gate; never force a card refresh or
          // accept an incompatible card simply to make a wiki page current.
          await this.preparation.ensureSourceReady([paperId], "paper_card", options);
          cached = await this.corpusWorkflows.readValidPaperCardForCorpusMap(source, paperCardContract);
        }
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
      const existingPage = previous?.page ? { ...previous.page,
        findings: previous.page.findings.filter(keep), disagreements: previous.page.disagreements.filter(keep),
        openQuestions: previous.page.openQuestions.filter(keep),
      } : null;
      if (existingPage && !keep(existingPage.explanation)) existingPage.explanation = null;
      const relatedPages = this.topics.topics.filter(other => other.topicId !== topic.topicId && other.paperIds.some(id => topic.paperIds.includes(id)))
        .sort((a, b) => a.topicId.localeCompare(b.topicId)).slice(0, 12).map(other => ({ pageId: other.topicId, label: other.label }));
      const words = tokens(topic.label);
      const retainedRefs = new Set(contract.statements(existingPage).flatMap(statement => statement.evidence.map(item => item.reference)));
      const papers = [];
      for (const dependency of dependencies) {
        const source = this.registry.get(dependency.sourceId);
        const card = (await this.corpusWorkflows.readValidPaperCardForCorpusMap(source, paperCardContract)).card;
        const original = await this.preparation.readPaperArtifact(source.sourceId);
        if (original.contentHash !== dependency.contentHash) throw fail("WIKI_SOURCE_CHANGED");
        const chunks = (original.chunks || []).map(chunk => ({ reference: `${source.sourceId}:p${chunk.page}:${chunk.chunkId}`, text: chunk.text || "" }));
        const ranked = chunks.map(item => ({ ...item, score: words.reduce((n, word) => n + (item.text.toLowerCase().includes(word) ? 1 : 0), 0) }))
          .sort((a, b) => b.score - a.score);
        const selected = unique([...chunks.filter(item => retainedRefs.has(item.reference)), ...ranked.slice(0, 3)].map(item => item.reference));
        const evidence = selected.map(reference => {
          const chunk = chunks.find(item => item.reference === reference);
          // Original L1 stays intact. Only bounded, subject-specific excerpts cross
          // the provider boundary. Existing quotations must fit or validation fails.
          return { reference, text: chunk.text.slice(0, 6000) };
        });
        const orientation = { title: String(card.title || "").slice(0, 500), researchQuestion: String(card.researchQuestion || "").slice(0, 1000),
          summary: String(card.summary || "").slice(0, 2000), methods: (card.methods || []).slice(0, 8).map(value => String(value).slice(0, 200)) };
        papers.push({ paperId: source.sourceId, contentHash: source.contentHash, card: orientation, evidence });
      }
      const input = { pageId: topic.topicId, label: topic.label, kind: topic.pageKind || "concept", configuration, papers,
        existingPage, relatedPages, analysisRequest: options.analysisRequest || previous?.analysisRequest || "" };
      if (contract.validateInput(input).length) throw fail("WIKI_INPUT_LIMIT");
      const key = await this.hashValue({ configuration, pageId: topic.topicId, kind: input.kind, dependencies,
        relatedPageIds: relatedPages.map(item => item.pageId), analysisRequest: input.analysisRequest });
      return { input, dependencies, previous, key };
    }
    async update(topic, configuration, paperCardContract, options) {
      const prepared = await this.prepare(topic, configuration, paperCardContract, options);
      if (topic.wiki?.key === prepared.key && contract.sameConfiguration(prepared.previous?.configuration, configuration) &&
          !contract.validatePage(prepared.previous?.page, prepared.input).length) return { pageId: topic.topicId, status: "reused" };
      if (!options.allowGeneration) return { pageId: topic.topicId, status: "stale" };
      return this.jobs.runDeduplicated(`wiki:${topic.topicId}:${prepared.key}`, "update-literature-wiki", topic.paperIds, async () => {
        this.assertActive(options);
        this.metrics.generationCalls++;
        const response = await this.generateWikiPage(prepared.input, options);
        this.assertActive(options);
        if (!contract.sameConfiguration(response?.configuration, configuration) || contract.validatePage(response?.page, prepared.input).length) throw fail("INVALID_WIKI_PAGE");
        const page = clone(response.page);
        // Carry forward supported prior findings/open questions and disagreements.
        // A provider cannot silently erase an inconvenient, unchanged finding.
        for (const key of ["findings", "disagreements", "openQuestions"]) {
          for (const old of prepared.input.existingPage?.[key] || []) {
            if (!page[key].some(item => item.kind === old.kind && item.text === old.text)) page[key].push(old);
          }
        }
        if (contract.validatePage(page, prepared.input).length) throw fail("INVALID_WIKI_MERGE");
        const latest = await this.prepare(topic, configuration, paperCardContract, options);
        if (latest.key !== prepared.key) throw fail("WIKI_SOURCE_CHANGED");
        this.assertActive(options);
        const path = `.biodesign/knowledge/wiki_pages/${topic.topicId}/${prepared.key}.json`;
        const record = { schemaVersion: contract.VERSION.schemaVersion, pageId: topic.topicId, key: prepared.key,
          configuration, dependencies: prepared.dependencies, page, analysisRequest: prepared.input.analysisRequest, updatedAt: new Date().toISOString() };
        await this.workspace.writeJson(path, record);
        try { this.assertActive(options); }
        catch (error) {
          if (this.workspace.workspace === this.workspaceIdentity && topic.wiki?.path !== path) await this.workspace.removeFile(path);
          throw error;
        }
        const old = { wiki: topic.wiki, summaryStatus: topic.summaryStatus, summaryVersion: topic.summaryVersion };
        const history = [topic.wiki, ...(topic.wiki?.history || [])].filter(Boolean)
          .map(item => ({ path: item.path, key: item.key, updatedAt: item.updatedAt })).slice(0, contract.LIMITS.history - 1);
        topic.wiki = { path, key: prepared.key, configuration, updatedAt: record.updatedAt, history };
        topic.summaryStatus = "ready"; topic.summaryVersion = prepared.key;
        try { await this.topics.persist(); }
        catch (error) {
          Object.assign(topic, old);
          if (old.wiki?.path !== path) try { await this.workspace.removeFile(path); } catch { /* An unpublished revision is never served. */ }
          throw error;
        }
        // The immutable JSON + committed index are authoritative. Markdown is a
        // searchable projection, so index/renderer failure never loses a valid page.
        let projectionPending = false;
        try { await this.topics.renderAndIndex([topic.topicId]); }
        catch { projectionPending = true; }
        for (const obsolete of [old.wiki, ...(old.wiki?.history || [])].filter(Boolean)) {
          if (obsolete.path !== path && !history.some(item => item.path === obsolete.path)) {
            try { if (await this.workspace.fileExists(obsolete.path)) await this.workspace.removeFile(obsolete.path); } catch { /* Cleanup can be retried without changing the page. */ }
          }
        }
        return { pageId: topic.topicId, status: "updated", ...(projectionPending ? { projectionPending: true } : {}) };
      }, options);
    }
    async maintain(options = {}) {
      const run = this.queue.then(() => this.maintainInternal(options));
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
      if (!this.generateWikiPage || !this.getPaperCardConfiguration) return { status: "offline", pages: [], generationCalls: 0 };
      const configurationResult = await this.getPaperCardConfiguration(options.signal, options.callContext, this.workspace.workspace || this.workspace);
      const configuration = configurationResult?.wikiConfiguration;
      if (!contract.sameConfiguration(configuration, contract.configuration(configuration?.modelSignature))) {
        for (const topic of this.topics.topics.filter(topic => topic.wiki)) topic.summaryStatus = "stale";
        if (this.topics.topics.some(topic => statuses.get(topic.topicId) !== topic.summaryStatus)) await this.topics.persist();
        return { status: "unavailable", pages: [], generationCalls: 0 };
      }
      const scoped = options.paperIds?.length ? new Set(options.paperIds) : null;
      const changed = new Set(options.changedPaperIds || []);
      const explicit = ["update", "incorporate"].includes(options.action);
      let candidates = this.topics.topics.filter(topic => topic.wiki || topic.paperIds.length >= 2);
      if (options.action === "incorporate") {
        const words = tokens(options.analysisRequest).filter(word => !/^(wiki|literature|incorporate|analysis|comparison|compare|into|the|and|save|add)$/.test(word));
        candidates = candidates.filter(topic => tokens(topic.label).some(word => words.includes(word)));
        if (!candidates.length) return { status: "no-matching-subject", pages: [], generationCalls: 0 };
        if (/\bcompar(?:e|ison)\b|比较/i.test(options.analysisRequest) && candidates.length) {
          if (candidates.length > 1) return { status: "ambiguous-subject", pages: [], generationCalls: 0 };
          const base = candidates[0], topicId = `comparison-${base.topicId}`.slice(0, 100);
          let comparison = this.topics.topics.find(topic => topic.topicId === topicId);
          if (!comparison) {
            comparison = { ...clone(base), topicId, label: `${base.label} comparison`, pageKind: "comparison", parentTopicIds: [base.topicId], wiki: undefined, summary: null, summaryStatus: "stale", summaryVersion: null };
            this.topics.topics.push(comparison); await this.topics.persist();
          }
          candidates = [comparison];
        }
      }
      const before = this.metrics.generationCalls, pages = [];
      for (const topic of candidates) {
        this.assertActive(options);
        if (scoped && topic.paperIds.some(id => !scoped.has(id))) continue;
        const prior = await this.read(topic);
        const affected = explicit || topic.paperIds.some(id => changed.has(id)) || prior?.dependencies.some(item => changed.has(item.sourceId));
        const allowGeneration = affected && this.metrics.generationCalls - before < contract.LIMITS.pagesPerRun;
        try {
          const result = await this.update(topic, configuration, configurationResult, { ...options, allowGeneration });
          pages.push(result);
          if (result.status === "stale") topic.summaryStatus = "stale";
          if (result.status === "reused") topic.summaryStatus = "ready";
        } catch (error) {
          if (error.code === "OPERATION_ABORTED") throw error;
          topic.summaryStatus = "stale";
          pages.push({ pageId: topic.topicId, status: "stale", code: String(error.code || "WIKI_UPDATE_FAILED").slice(0, 80) });
        }
      }
      if (this.topics.topics.some(topic => statuses.get(topic.topicId) !== topic.summaryStatus)) await this.topics.persist();
      return { status: pages.some(page => page.status === "stale") ? "partial" : "ready", pages, generationCalls: this.metrics.generationCalls - before, configuration };
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
          if (contract.statements(record.page).some(statement => statement.evidence.some(item => !dependencies.has(String(item.reference).split(":p")[0])))) issues.push("unsupported-reference");
          for (const pageId of record.page.relatedPageIds) if (!this.topics.topics.some(other => other.topicId === pageId && other.paperIds.length) ||
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
          if (record.page.disagreements.length) issues.push("model-assisted-disagreement-review");
        }
        pages.push({ pageId: topic.topicId, issues: unique(issues) });
      }
      return { status: "checked", pages, truncated: all.length > pages.length, generationCalls: 0, semanticContradictionsAreVerified: false };
    }
    search(query, limit = 5) {
      const words = tokens(query);
      return this.topics.topics.filter(topic => topic.wiki).map(topic => ({ sourceId: topic.topicId, title: topic.label,
        score: words.filter(word => `${topic.label} ${topic.pageKind}`.toLowerCase().includes(word)).length }))
        .filter(item => item.score).sort((a, b) => b.score - a.score).slice(0, limit);
    }
  }
  return { LiteratureWikiService };
});
