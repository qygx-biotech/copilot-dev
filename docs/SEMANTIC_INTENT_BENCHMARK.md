# Semantic interpretation benchmark

Run from the repository root:

```bash
node scripts/benchmark-semantic-intent.js --output docs/SEMANTIC_INTENT_BENCHMARK.json
node --test alibaba-fc/test/semantic-intent.test.js
```

The versioned fixture contains 30 known English/Chinese paraphrases, 12 deliberately novel compositions, and five ambiguous questions. Pattern examples are static data in `shared/semantic-intent.js`; the fixture is not loaded by the production interpreter. The matcher uses multilingual aliases projected into a sparse concept space and cosine similarity against those examples. It does not initialize an embedding model or a second QMD/model stack.

| Measure | Existing deterministic corpus detector | New local semantic interpreter |
|---|---:|---:|
| Corpus paraphrase recall (14 examples) | 7/14, 50% | 14/14, 100% |
| Known pattern accuracy (30 examples) | Not applicable: only a corpus boolean exists | 30/30, 100% |
| Novel requests incorrectly routed to corpus synthesis | 3/12, 25% | 0/12, 0% |
| Novel requests forced into any named pattern | Not applicable | 0/12, 0% |
| Ambiguous questions forced into a named pattern | Not applicable | 0/5, 0% |
| Annotated slots/entities/constraints | No structured representation | 60/60, 100% |

Newly recognized corpus paraphrases include “What does my literature say overall?”, “What does the whole corpus say?”, “Put together the major themes from every publication”, “全部文章主要讲了什么？”, and “把项目里的文章归纳一下。” The old detector also routes “Summarize all papers and email the review…” to the corpus branch without representing the requested external action. The new interpreter retains `summarize` and `send`, rejects the narrow corpus pattern, and leaves the unavailable sending capability unresolved. Permissions remain independently enforced.

The EctD composition stays open (`matchedPattern: null`) while preserving `rank`, `search`, `filter`, `find-conflicts`, temperature analysis, EctD, top five, and an inclusive maximum difference of 5 degC for “exclude differences above 5°C”. The planner combines experiment queries, literature search, and original paper evidence. The temperature condition is an explicit cross-source constraint; the semantic interpreter does not claim to have computed it.

## Profile and call accounting

The following counts run all 47 requests. A controlled callback returns schema-valid IR to exercise one-call escalation, host validation, caching, and telemetry. **These are protocol/call-count measurements, not observed LLM accuracy or production cloud cost.** The authenticated FC parser has separate mocked provider contract tests. A live Requesty comparison requires authorized provider credentials and was not run.

| Profile | Cold semantic parser calls | Known / novel / ambiguous cold calls | Calls on identical repeated requests |
|---|---:|---:|---:|
| Light | 0 | 0 / 0 / 0 | 0 |
| Medium | 17 | 0 / 12 / 5 | 17 |
| High | 37 | 20 / 12 / 5 | 17 |

High proactively parses the known corpus and ranking recipes in this fixture; their confirmed interpretations are cached. Medium keeps all these known paraphrases local. Open or unresolved interpretations are deliberately not cached as confirmed patterns. Each escalation is one fused call for goal understanding, multilingual normalization, entities, and slots. There are no separate translation calls. Retrieval planner, reranker, schema mapper, corpus mapper, native PDF, and final answer counts are all zero **because this benchmark ends at interpretation**; existing application retrieval and answer costs still apply.

The recorded local median is about 0.3 ms and p95 about 1 ms on the development machine, including interpretation and validation. See the JSON output for the exact run; these are not provider latency measurements.

## Calibration and limits

The configurable known-match threshold is 0.86, uncertain threshold 0.64, and winner margin 0.08. A pattern must also cover the requested operations and domains. A first-place score alone is insufficient. The development sweep records thresholds 0.82–0.98 and margins 0.05, 0.08, and 0.15. The default maintains 100% known accuracy with zero measured novel false positives; increasing the margin to 0.15 rejects more known requests (53.33% known accuracy) without improving the already-zero measured false positives. Detailed configurations and per-query decisions are in `SEMANTIC_INTENT_BENCHMARK.json`.

This is a small curated development fixture, and its alias vocabulary and thresholds have been tuned against it. It is not an independent held-out statistical estimate or a guarantee of arbitrary multilingual understanding. English and Chinese are the calibrated languages; additional scripts retain their text and can use the remote parser. Novel goals outside the recognized local concepts retain their original goal text and unresolved slots for the existing agent loop. Unsupported capabilities remain unresolved. No source evidence is translated or modified by the benchmark.
