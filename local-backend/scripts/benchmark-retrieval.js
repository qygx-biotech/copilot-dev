import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "@tobilu/qmd";
import retrievalContract from "../../shared/retrieval-contract.js";

import {
  DEFAULT_EMBED_MODEL,
  MULTILINGUAL_EMBED_MODEL,
  QMD_PACKAGE_VERSION,
  groupPaperResults,
} from "../src/project-qmd-manager.js";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_CORPUS = path.join(PACKAGE_ROOT, "benchmark/representative-corpus.json");
const DEFAULT_QUERIES = path.join(PACKAGE_ROOT, "benchmark/representative-queries.json");
const DEFAULT_CLOUD_PLANS = path.join(PACKAGE_ROOT, "benchmark/representative-cloud-plans.json");
const { RETRIEVAL_LIMITS } = retrievalContract;

const MODELS = Object.freeze({
  lexical: null,
  default: DEFAULT_EMBED_MODEL,
  multilingual: MULTILINGUAL_EMBED_MODEL,
});

function parseArguments(argv) {
  const args = {
    projectRoot: "",
    fixture: false,
    model: "both",
    queriesPath: "",
    outputPath: "",
    repeats: 3,
    cpu: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--project") args.projectRoot = path.resolve(argv[++index] || "");
    else if (value === "--fixture") args.fixture = true;
    else if (value === "--model") args.model = argv[++index] || "both";
    else if (value === "--queries") args.queriesPath = path.resolve(argv[++index] || "");
    else if (value === "--output") args.outputPath = path.resolve(argv[++index] || "");
    else if (value === "--repeats") args.repeats = Math.min(10, Math.max(1, Number(argv[++index]) || 3));
    else if (value === "--cpu") args.cpu = true;
  }
  if (!args.projectRoot) args.fixture = true;
  if (!args.fixture && !args.queriesPath) {
    throw new Error("A real-project benchmark requires --queries with expectedPaperIds.");
  }
  if (!Object.hasOwn(MODELS, args.model) && args.model !== "both") {
    throw new Error("--model must be lexical, default, multilingual, or both.");
  }
  return args;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function recallAt(ranking, expected, k) {
  if (!expected.length) return null;
  const found = new Set(ranking.slice(0, k));
  return expected.filter((paperId) => found.has(paperId)).length / expected.length;
}

function reciprocalRank(ranking, expected) {
  const expectedSet = new Set(expected);
  const index = ranking.findIndex((paperId) => expectedSet.has(paperId));
  return index < 0 ? 0 : 1 / (index + 1);
}

function legacyTokens(value) {
  return [...new Set(String(value || "").toLowerCase().match(/[a-z0-9]+(?:[._+-][a-z0-9]+)*/g) || [])];
}

function legacyRanking(documents, query) {
  const terms = legacyTokens(query);
  return documents
    .map((document) => {
      const tokens = new Set(legacyTokens(`${document.title} ${document.body} ${document.doi || ""}`));
      return {
        paperId: document.paperId,
        score: terms.reduce((total, term) => total + (tokens.has(term) ? 1 : 0), 0),
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.paperId.localeCompare(right.paperId))
    .map((item) => item.paperId);
}

async function measure(search, repeats) {
  const firstStarted = performance.now();
  const firstResult = await search();
  const firstMs = performance.now() - firstStarted;
  const steadyMs = [];
  let result = firstResult;
  for (let index = 0; index < repeats; index += 1) {
    const started = performance.now();
    result = await search();
    steadyMs.push(performance.now() - started);
  }
  return { ...result, firstMs, steadyMs, steadyP50Ms: percentile(steadyMs, 0.5) };
}

function evidenceRecallAt5(result, expectedTerms) {
  if (!expectedTerms.length) return null;
  const text = result.ranking.slice(0, 5)
    .flatMap((paperId) => result.evidenceByPaper?.[paperId] || [])
    .join("\n")
    .toLowerCase();
  return expectedTerms.filter((term) => text.includes(String(term).toLowerCase())).length /
    expectedTerms.length;
}

function groupedOutput(raw, query) {
  const groups = groupPaperResults(raw, { query, limit: 10 });
  return {
    ranking: groups.map((result) => result.paperId),
    evidenceByPaper: Object.fromEntries(groups.map((result) => [
      result.paperId,
      result.matchedSections.map((section) => section.snippet),
    ])),
  };
}

function replayRerankScore(result, plan) {
  const text = [
    result.title,
    ...(result.matchedSections || []).map((section) => section.snippet),
  ].join(" ").toLowerCase();
  const identifiers = [...new Set(plan.identifiers || [])];
  const queryTerms = [...new Set((plan.queries || [])
    .flatMap((query) => legacyTokens(query))
    .filter((term) => term.length > 2))];
  return identifiers.reduce(
    (score, identifier) => score + (text.includes(String(identifier).toLowerCase()) ? 2 : 0),
    0
  ) + queryTerms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
}

async function replayCloudRetrieval(store, item, plan, rerank) {
  const queries = [];
  const seen = new Set();
  for (const value of [item.query, ...(plan.queries || []), ...(plan.identifiers || [])]) {
    const query = String(value || "").trim();
    if (!query || seen.has(query)) continue;
    seen.add(query);
    queries.push(query);
  }
  if (queries.length > RETRIEVAL_LIMITS.candidateMaximum) {
    throw new Error(`Recorded plan for ${item.id} exceeds the shared retrieval limit.`);
  }
  const fused = new Map();
  let firstSeen = 0;
  for (const query of queries) {
    const raw = await store.searchLex(query, {
      collection: "literature-evidence",
      limit: RETRIEVAL_LIMITS.candidateDefault,
    });
    const grouped = groupPaperResults(raw, {
      query,
      limit: RETRIEVAL_LIMITS.candidateDefault,
    });
    grouped.forEach((result, rank) => {
      const existing = fused.get(result.paperId) || {
        result,
        fusionScore: 0,
        firstSeen: firstSeen++,
      };
      existing.fusionScore += 1 / (rank + 1);
      fused.set(result.paperId, existing);
    });
  }
  let entries = [...fused.values()].sort((left, right) =>
    right.fusionScore - left.fusionScore ||
    left.firstSeen - right.firstSeen ||
    left.result.paperId.localeCompare(right.result.paperId)
  );
  if (rerank) {
    entries = entries.sort((left, right) =>
      replayRerankScore(right.result, plan) - replayRerankScore(left.result, plan) ||
      right.fusionScore - left.fusionScore ||
      left.firstSeen - right.firstSeen
    );
  }
  entries = entries.slice(0, RETRIEVAL_LIMITS.resultDefault);
  const evidenceByPaper = Object.fromEntries(entries.map(({ result }) => [
    result.paperId,
    (result.matchedSections || []).map((section) => section.snippet),
  ]));
  const candidatePayload = entries.map(({ result }, index) => ({
    candidateId: `candidate-${String(index + 1).padStart(16, "0")}`,
    title: String(result.title || "").slice(0, RETRIEVAL_LIMITS.titleCharacters),
    evidence: (result.matchedSections || [])
      .slice(0, RETRIEVAL_LIMITS.matchedSectionsPerPaper)
      .map((section, sectionIndex) => ({
        evidenceHandle: `evidence-${String(index + 1).padStart(16, "0")}-${sectionIndex + 1}`,
        snippet: String(section.snippet || "").slice(0, RETRIEVAL_LIMITS.snippetCharacters),
      })),
  }));
  const planInputCharacters = JSON.stringify({ query: item.query, intent: "benchmark scientific evidence retrieval" }).length;
  const planOutputCharacters = JSON.stringify(plan).length;
  const rerankInputCharacters = rerank
    ? JSON.stringify({ query: item.query, intent: "benchmark scientific evidence retrieval", candidates: candidatePayload }).length
    : 0;
  const rerankOutputCharacters = rerank
    ? JSON.stringify({ ranked: candidatePayload.map((candidate) => ({ candidateId: candidate.candidateId, score: 0, reason: "replay" })) }).length
    : 0;
  return {
    ranking: entries.map(({ result }) => result.paperId),
    evidenceByPaper,
    usageEstimate: {
      inputCharacters: planInputCharacters + rerankInputCharacters,
      outputCharacters: planOutputCharacters + rerankOutputCharacters,
      inputTokens: Math.ceil((planInputCharacters + rerankInputCharacters) / 4),
      outputTokens: Math.ceil((planOutputCharacters + rerankOutputCharacters) / 4),
      coldFcRequests: rerank ? 3 : 2,
      coldRequestyCalls: rerank ? 2 : 1,
      cachedFcRequests: 1,
      cachedRequestyCalls: 0,
    },
  };
}

function renderFixtureDocument(document) {
  return `${[
    "---",
    `source_id: ${JSON.stringify(document.paperId)}`,
    `title: ${JSON.stringify(document.title)}`,
    `doi: ${JSON.stringify(document.doi || "")}`,
    "authoritative: false",
    "---",
    "",
    `# ${document.title}`,
    "",
    "## Page 1",
    "",
    document.body,
  ].join("\n")}\n`;
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biodesign-qmd-benchmark-"));
  const literaturePath = path.join(root, ".biodesign/knowledge/literature");
  await mkdir(literaturePath, { recursive: true });
  const documents = JSON.parse(await readFile(DEFAULT_CORPUS, "utf8"));
  for (const document of documents) {
    await writeFile(
      path.join(literaturePath, `${document.paperId}.md`),
      renderFixtureDocument(document),
      "utf8"
    );
  }
  return { root, documents, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function readRealDocuments(projectRoot) {
  const corpusPath = path.join(projectRoot, ".biodesign/knowledge/literature");
  const names = (await readdir(corpusPath)).filter((name) => name.endsWith(".md"));
  const documents = [];
  for (const name of names) {
    const body = await readFile(path.join(corpusPath, name), "utf8");
    const sourceId = body.match(/^source_id:\s*["']?([^\n"']+)/m)?.[1]?.trim() ||
      name.replace(/\.md$/i, "");
    const title = body.match(/^title:\s*["']?([^\n"']+)/m)?.[1]?.trim() || sourceId;
    const doi = body.match(/^doi:\s*["']?([^\n"']+)/m)?.[1]?.trim() || "";
    documents.push({ paperId: sourceId, title, doi, body });
  }
  return { corpusPath, documents };
}

function aggregateQueryMetrics(rows, backend, language = null) {
  const selected = rows.filter((row) =>
    row.backend === backend && (!language || row.language === language)
  );
  const defined = (key) => selected.map((row) => row[key]).filter((value) => value !== null);
  const mean = (values) => values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
  return {
    queryCount: selected.length,
    recallAt5: mean(defined("recallAt5")),
    recallAt10: mean(defined("recallAt10")),
    evidenceRecallAt5: mean(defined("evidenceRecallAt5")),
    meanReciprocalRank: mean(defined("reciprocalRank")),
    firstQueryMeanMs: mean(defined("firstMs")),
    steadyQueryP50Ms: percentile(defined("steadyP50Ms"), 0.5),
  };
}

async function runModelBenchmark({ modelName, modelId, root, documents, queries, cloudPlans, repeats }) {
  const dbDirectory = path.join(root, ".biodesign/knowledge/qmd/benchmarks");
  await mkdir(dbDirectory, { recursive: true });
  const dbPath = path.join(dbDirectory, `${modelName}.sqlite`);
  const corpusPath = path.join(root, ".biodesign/knowledge/literature");
  const rssBefore = process.memoryUsage().rss;
  const store = await createStore({
    dbPath,
    config: {
      ...(modelId ? { models: { embed: modelId } } : {}),
      collections: {
        "literature-evidence": { path: corpusPath, pattern: "**/*.md" },
      },
    },
  });
  let peakRss = process.memoryUsage().rss;
  const checkpoint = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };
  try {
    const updateStarted = performance.now();
    const update = await store.update({ collections: ["literature-evidence"] });
    const updateMs = performance.now() - updateStarted;
    checkpoint();
    let embed = null;
    let steadyEmbed = null;
    let firstEmbedMs = null;
    let steadyEmbedMs = null;
    if (modelId) {
      const embedStarted = performance.now();
      embed = await store.embed({ collection: "literature-evidence", force: true });
      firstEmbedMs = performance.now() - embedStarted;
      checkpoint();
      const steadyEmbedStarted = performance.now();
      steadyEmbed = await store.embed({ collection: "literature-evidence", force: false });
      steadyEmbedMs = performance.now() - steadyEmbedStarted;
      checkpoint();
    }

    const rows = [];
    for (const item of queries) {
      const backends = {
        legacy: async () => {
          const ranking = legacyRanking(documents, item.query);
          return {
            ranking,
            evidenceByPaper: Object.fromEntries(documents.map((document) => [
              document.paperId,
              [document.body],
            ])),
          };
        },
        qmdLex: async () => groupedOutput(
          await store.searchLex(item.query, { collection: "literature-evidence", limit: RETRIEVAL_LIMITS.candidateDefault }),
          item.query
        ),
        ...(modelId ? {
          qmdVector: async () => groupedOutput(
            await store.searchVector(item.query, { collection: "literature-evidence", limit: RETRIEVAL_LIMITS.candidateDefault }),
            item.query
          ),
          qmdHybrid: async () => groupedOutput(
            await store.search({
              queries: [
                { type: "lex", query: item.query },
                { type: "vec", query: item.query },
              ],
              collections: ["literature-evidence"],
              limit: RETRIEVAL_LIMITS.candidateDefault,
              candidateLimit: RETRIEVAL_LIMITS.candidateDefault,
              rerank: false,
            }),
            item.query
          ),
        } : {}),
        cloudPlannedLexicalReplay: async () => replayCloudRetrieval(
          store,
          item,
          cloudPlans[item.id],
          false
        ),
        cloudRerankedReplay: async () => replayCloudRetrieval(
          store,
          item,
          cloudPlans[item.id],
          true
        ),
      };
      for (const [backend, search] of Object.entries(backends)) {
        const timing = await measure(search, repeats);
        checkpoint();
        const expected = Array.isArray(item.expectedPaperIds) ? item.expectedPaperIds : [];
        const expectedEvidenceTerms = Array.isArray(item.expectedEvidenceTerms)
          ? item.expectedEvidenceTerms
          : [];
        rows.push({
          queryId: item.id,
          language: item.language || "unknown",
          backend,
          expectedPaperIds: expected,
          ranking: timing.ranking,
          recallAt5: recallAt(timing.ranking, expected, 5),
          recallAt10: recallAt(timing.ranking, expected, 10),
          evidenceRecallAt5: evidenceRecallAt5(timing, expectedEvidenceTerms),
          reciprocalRank: reciprocalRank(timing.ranking, expected),
          firstMs: timing.firstMs,
          steadyMs: timing.steadyMs,
          steadyP50Ms: timing.steadyP50Ms,
          ...(timing.usageEstimate ? { usageEstimate: timing.usageEstimate } : {}),
        });
      }
    }
    const backendNames = [...new Set(rows.map((row) => row.backend))];
    return {
      modelName,
      modelId,
      dbPath,
      update: { durationMs: updateMs, result: update },
      embedding: {
        firstDurationMs: firstEmbedMs,
        steadyDurationMs: steadyEmbedMs,
        firstResult: embed,
        steadyResult: steadyEmbed,
      },
      memory: {
        rssBeforeBytes: rssBefore,
        peakRssBytes: peakRss,
        peakDeltaBytes: Math.max(0, peakRss - rssBefore),
      },
      aggregates: Object.fromEntries(backendNames.map((backend) => [
        backend,
        {
          all: aggregateQueryMetrics(rows, backend),
          en: aggregateQueryMetrics(rows, backend, "en"),
          zh: aggregateQueryMetrics(rows, backend, "zh"),
        },
      ])),
      queries: rows,
    };
  } finally {
    await store.close();
  }
}

function recommend(results) {
  if (results.length < 2) {
    return {
      selected: results[0]?.modelName || null,
      reason: "Only one model was measured; no cross-model recommendation was possible.",
    };
  }
  const defaults = results.find((result) => result.modelName === "default");
  const multilingual = results.find((result) => result.modelName === "multilingual");
  const defaultZh = defaults.aggregates.qmdHybrid.zh.recallAt5 || 0;
  const multilingualZh = multilingual.aggregates.qmdHybrid.zh.recallAt5 || 0;
  const memoryRatio = multilingual.memory.peakRssBytes /
    Math.max(1, defaults.memory.peakRssBytes);
  const selected = multilingualZh - defaultZh >= 0.1 && memoryRatio <= 2
    ? "multilingual"
    : "default";
  return {
    selected,
    reason: selected === "multilingual"
      ? "Measured Chinese hybrid recall@5 improved materially without exceeding the 2x peak-memory guardrail."
      : "The multilingual model did not clear both the +0.10 Chinese recall@5 and 2x peak-memory guardrails.",
    defaultChineseHybridRecallAt5: defaultZh,
    multilingualChineseHybridRecallAt5: multilingualZh,
    multilingualToDefaultPeakMemoryRatio: memoryRatio,
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.cpu) process.env.QMD_FORCE_CPU = "1";
  const fixture = args.fixture ? await createFixture() : null;
  const root = fixture?.root || args.projectRoot;
  const real = fixture ? null : await readRealDocuments(root);
  const documents = fixture?.documents || real.documents;
  const queries = JSON.parse(await readFile(args.queriesPath || DEFAULT_QUERIES, "utf8"));
  const cloudPlans = JSON.parse(await readFile(DEFAULT_CLOUD_PLANS, "utf8"));
  for (const query of queries) {
    if (!cloudPlans[query.id]) throw new Error(`Missing recorded cloud plan for ${query.id}.`);
  }
  const modelNames = args.model === "both" ? ["default", "multilingual"] : [args.model];
  const results = [];
  try {
    for (const modelName of modelNames) {
      console.error(`Benchmarking ${modelName}: ${MODELS[modelName]}`);
      results.push(await runModelBenchmark({
        modelName,
        modelId: MODELS[modelName],
        root,
        documents,
        queries,
        cloudPlans,
        repeats: args.repeats,
      }));
    }
    const report = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      fixture: args.fixture,
      qmdPackageVersion: QMD_PACKAGE_VERSION,
      nodeVersion: process.version,
      queryCount: queries.length,
      repeats: args.repeats,
      models: results,
      recommendation: recommend(results),
      notes: [
        "QMD hybrid uses one lexical and one vector query with reranking disabled, isolating retrieval and embedding-model effects.",
        "First embedding time includes lazy model startup and any cold download; first-query timing begins after embeddings exist.",
        "Steady query latency is the median of repeated warm queries.",
        "RSS checkpoints are process-level and the two models run sequentially, so retained native allocations can affect the second baseline.",
        "Cloud-planned and cloud-reranked rows replay validated structured responses over the unchanged corpus/query set; their measured latency is local orchestration only, not live FC/Requesty network latency.",
        "Recorded usage is a character-based token estimate (four characters per token); live provider usage was unavailable because no production FC credential was supplied.",
      ],
    };
    if (args.outputPath) {
      await mkdir(path.dirname(args.outputPath), { recursive: true });
      await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (fixture) await fixture.cleanup();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
