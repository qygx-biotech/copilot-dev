#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const semantic = require("../shared/semantic-intent.js");
const { detectCorpusWideLiteratureIntent } = require("../docs/project-context-service.js");
const fixture = require("./fixtures/semantic-intent.json");
const corpusPattern = "literature.corpus_synthesis";
const rows = ["known", "novel", "ambiguous"].flatMap((category) => fixture[category].map((row) => ({ ...row, category })));
const request = (row, profile = "light") => ({ ...(row.category === "ambiguous" ? {} : fixture.context), query: row.query, profile });
const percent = (numerator, denominator) => denominator ? Number((100 * numerator / denominator).toFixed(2)) : null;
function slotChecks(ir, expected = {}) {
  const checks = [];
  for (const entity of expected.entities || []) checks.push(ir.entities.some((item) => item.mention === entity && item.canonicalId === entity));
  for (const operation of expected.operations || []) checks.push(ir.operations.includes(operation));
  for (const slot of expected.unresolved || []) checks.push(ir.unresolvedSlots.includes(slot));
  if (expected.metric) checks.push(ir.metrics[0]?.canonicalField === expected.metric);
  if (expected.limit) checks.push(ir.requestedOutput.limit === expected.limit);
  if (expected.temperatureDifference) checks.push(ir.constraints.some((item) => item.field === "temperature_difference" && item.value === expected.temperatureDifference && item.unit === "degC"));
  if (expected.paperYear) checks.push(ir.filters.some((item) => item.field === "paper_year" && item.operator === "<" && item.value === expected.paperYear));
  return checks;
}
async function run() {
  const durations = [];
  const evaluated = rows.map((row) => {
    const start = performance.now();
    const ir = semantic.interpretLocal(request(row));
    durations.push(performance.now() - start);
    return { ...row, ir, legacyCorpus: detectCorpusWideLiteratureIntent(row.query), checks: slotChecks(ir, row.slots) };
  });
  const known = evaluated.filter((row) => row.category === "known");
  const novel = evaluated.filter((row) => row.category === "novel");
  const ambiguous = evaluated.filter((row) => row.category === "ambiguous");
  const corpus = known.filter((row) => row.pattern === corpusPattern);
  const slots = evaluated.flatMap((row) => row.checks);
  const calibration = [];
  for (const threshold of [0.82, 0.86, 0.9, 0.95, 0.98]) for (const margin of [0.05, 0.08, 0.15]) {
    const results = rows.map((row) => ({ row, ir: semantic.interpretLocal(request(row), { thresholds: { known: threshold, margin } }) }));
    calibration.push({ threshold, margin, knownAccuracyPercent: percent(results.filter(({ row, ir }) => row.category === "known" && ir.matchedPattern === row.pattern).length, known.length), novelFalsePositivePercent: percent(results.filter(({ row, ir }) => row.category === "novel" && ir.matchedPattern).length, novel.length), ambiguousFalsePositivePercent: percent(results.filter(({ row, ir }) => row.category === "ambiguous" && ir.matchedPattern).length, ambiguous.length) });
  }
  const profiles = [];
  for (const profile of ["light", "medium", "high"]) {
    let parserCalls = 0, escalations = 0, acceptedRemote = 0, repeatCalls = 0;
    const byCategory = { known: 0, novel: 0, ambiguous: 0 };
    for (const row of rows) {
      // Controlled provider substitute for protocol/call accounting only. This
      // deliberately makes no claim to measure an LLM's semantic quality.
      const interpreter = new semantic.SemanticInterpreter({ remoteParser: async (payload) => {
        parserCalls += 1;
        return { ir: semantic.interpretLocal(payload) };
      } });
      const result = await interpreter.interpret(request(row, profile));
      if (result.telemetry.semantic.remoteSemanticParserUsed) { escalations += 1; byCategory[row.category] += 1; }
      if (result.telemetry.semantic.route === "remote") acceptedRemote += 1;
      const before = parserCalls;
      await interpreter.interpret(request(row, profile));
      repeatCalls += parserCalls - before;
    }
    profiles.push({ profile, requests: rows.length, semanticParserCallsCold: escalations, semanticParserCallsRepeated: repeatCalls, escalationPercent: percent(escalations, rows.length), acceptedRemote, byCategoryCold: byCategory, otherCloudCalls: { retrievalPlanner: 0, reranker: 0, schemaMapper: 0, corpusMapper: 0, nativePdf: 0, finalAnswer: 0 } });
  }
  const timings = durations.sort((a, b) => a - b);
  const report = {
    fixtureVersion: fixture.version, semanticSchemaVersion: semantic.SEMANTIC_SCHEMA_VERSION, patternLibraryVersion: semantic.PATTERN_LIBRARY_VERSION,
    method: "Versioned multilingual alias/concept-space cosine similarity; no embedding model; closed tool metadata, open goal/output. Controlled parser callbacks measure accounting only, not live LLM accuracy.",
    samples: { known: known.length, novel: novel.length, ambiguous: ambiguous.length }, thresholds: semantic.DEFAULT_THRESHOLDS,
    local: { knownPatternAccuracyPercent: percent(known.filter((row) => row.ir.matchedPattern === row.pattern).length, known.length), openSetFalsePositivePercent: percent(novel.filter((row) => row.ir.matchedPattern).length, novel.length), ambiguousFalsePositivePercent: percent(ambiguous.filter((row) => row.ir.matchedPattern).length, ambiguous.length), slotEntityAccuracyPercent: percent(slots.filter(Boolean).length, slots.length), slotChecks: slots.length, medianMilliseconds: Number(timings[Math.floor(timings.length / 2)].toFixed(3)), p95Milliseconds: Number(timings[Math.floor(timings.length * 0.95)].toFixed(3)) },
    legacyComparison: { scope: "Existing detector only routes corpus synthesis; it has no general intent/slot representation.", corpusParaphrases: corpus.length, legacyCorpusRecallPercent: percent(corpus.filter((row) => row.legacyCorpus).length, corpus.length), semanticCorpusRecallPercent: percent(corpus.filter((row) => row.ir.matchedPattern === corpusPattern).length, corpus.length), legacyNovelCorpusFalsePositivePercent: percent(novel.filter((row) => row.legacyCorpus).length, novel.length), semanticNovelCorpusFalsePositivePercent: percent(novel.filter((row) => row.ir.matchedPattern === corpusPattern).length, novel.length), improvedQueries: corpus.filter((row) => !row.legacyCorpus && row.ir.matchedPattern === corpusPattern).map((row) => row.query) },
    profiles, calibration,
    limitations: ["Small curated fixture, not population-level language coverage or out-of-distribution guarantees.", "Threshold sweep is development calibration, not an independent statistical estimate.", "Concept aliases are static lexical semantic features, not pretrained multilingual embeddings.", "Remote parser quality and live provider latency were not measured; authenticated FC integration has separate mocked contract tests.", "Interpretation benchmark does not run retrieval or final answers; their zero counts mean outside this benchmark, not zero production cost.", "Unresolved novel goals may require clarification or unavailable capabilities; interpretation does not promise execution of unsupported actions."],
    cases: evaluated.map((row) => ({ category: row.category, query: row.query, expectedPattern: row.pattern || null, matchedPattern: row.ir.matchedPattern, confidence: row.ir.patternConfidence, operations: row.ir.operations, answerLanguage: row.ir.answerLanguage, legacyCorpus: row.legacyCorpus, slotsCorrect: row.checks.every(Boolean) }))
  };
  const output = process.argv[process.argv.indexOf("--output") + 1];
  if (process.argv.includes("--output") && output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); }
  console.log(JSON.stringify(report, null, 2));
  if (report.local.knownPatternAccuracyPercent < 90 || report.local.openSetFalsePositivePercent > 5 || report.local.slotEntityAccuracyPercent < 95) process.exitCode = 1;
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
