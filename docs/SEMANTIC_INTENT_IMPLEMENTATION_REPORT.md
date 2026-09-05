# Open semantic interpretation implementation report

Branch: `feature/open-semantic-intent-ir`. The starting branch was `feature/retrieval-quality-profiles` and the working tree was clean. The implementation preserves Electron, the existing UI, QMD L0–L4, corpus workflows/shared planning, Alibaba FC, source authority, and recommendation permissions.

## Requested implementation details

1. **Branch:** `feature/open-semantic-intent-ir`.
2. **Previous routing:** English/Chinese regular expressions in `project-context-service.js`, including an action/scope/review corpus detector; High could invoke the separate context router. Experiment columns used normalized header strings and limited aliases.
3. **Semantic IR:** Strict v1 JSON with language, optional pattern/confidence, open goal, composable operations/objects, canonical entities/metrics, hard scope, filters/constraints, comparison variables, output type/limit, capability hints, and unresolved slots. `matchedPattern: null` is supported throughout execution.
4. **Pattern library:** 17 versioned patterns with multilingual examples, operations, domain coverage, and existing recipe/capability declarations. These are optional optimizations, not an exhaustive intent catalog.
5. **Local matching:** Multilingual field/entity/concept aliases projected into a sparse shared concept space, with cosine similarity against static examples. No new model, embedding stack, or runtime paraphrase-generation calls.
6. **Open-set logic:** Configurable 0.86 known threshold, 0.64 uncertainty threshold, and 0.08 winner margin, plus domain/operation coverage. Telemetry distinguishes known, uncertain, and novel. Host validation also rejects weak/incompatible remote pattern claims.
7. **Capabilities:** Machine-readable metadata for all 15 existing agent tools plus three host recipes. The planner composes object/operation coverage without executable arguments. An open request can retain a corpus subrecipe while composing other capabilities.
8. **Permissions:** Existing informational/internal-state/result-producing/destructive/external classes and tool authorization remain authoritative. Both surfaces share semantics. Side Chat recommendation updates remain denied; explanation stays read-only.
9. **Canonical experiment fields:** Versioned field registry with separate EN/ZH labels for temperature, pH, culture time, product titer/yield, productivity, activities, OD600, mutation, strain, protein, gene, and sample IDs.
10. **Aliases:** Shared multilingual scientific/field aliases, contextual project mappings, WT normalization, and deterministic unit normalization/conversion. Protected scientific identifiers retain exact spelling.
11. **Ambiguity:** Bare `产量`, unspecified activity, conflicting duplicate columns, missing criteria, and incompatible units remain explicit. Confirmed mappings and user corrections persist in `.biodesign/experiments/schema-mappings.json` using contextual identities and versions. The correction API is `confirmSchemaMapping`; no large editor UI was introduced.
12. **FC routes:** Authenticated `POST /api/semantic/interpret` and `POST /api/semantic/map-schema`, using the existing FC→Requesty path. Semantic parsing fuses interpretation/translation of concepts/entities/slots into one bounded request. Schema mapping sends a small schema sample, never a workbook.
13. **Structured output:** Strict `json_schema` at FC and host validation of results, scope, identifiers, capability names, and units. No semantic JSON-object downgrade or repair subcall. Existing provider transport retries remain distinct from logical parser requests.
14. **Light:** Local semantic matching and partial/open IR; no dedicated semantic-router request. Existing retrieval/final-answer rules continue.
15. **Medium:** Local first, with one fused parser request on uncertainty, unresolved slots, multiple domains, or complexity. Existing Fast-first retrieval behavior continues.
16. **High:** Uses the parser proactively for relevant complex requests, then existing High retrieval and paper/PDF policies. Production uses the semantic result without another context-router request.
17. **Paraphrase benchmark:** 30/30 known patterns; corpus subset improves from 7/14 to 14/14 (50%→100%). Annotated slot/entity/constraint checks: 60/60.
18. **Open-set benchmark:** 0/12 novel requests forced into a pattern; 0/5 ambiguous questions forced into a pattern. This is a curated development fixture, not a production accuracy guarantee.
19. **EN/ZH schema tests:** Equivalent schemas, original bytes/rows/headers/values, sheet/source/cell provenance, distinct titer/yield/productivity, conversions, corrections, cache reload/invalidation/concurrency, duplicate columns, and deterministic full-source ranking are covered.
20. **Cloud-call counts:** Across the 47 benchmark requests, controlled cold semantic-parser counts are Light 0, Medium 17, High 37; repeated counts are 0/17/17. Other cloud counts are zero in this interpretation-only benchmark. Application telemetry separately records semantic/schema parsers, retrieval planner, reranker, corpus mapper, native PDF, and answer calls. A controlled complete agent comparison records three answer-model turns and two allowed tool capabilities.
21. **Files changed:** See the file inventory below.
22. **Full validation:** `npm test` passed **290/290**: desktop 52/52, FC 231/231, local backend 7/7. No failures or skipped tests. This includes a real QMD 2.8.3 lexical SDK smoke test. Both root and FC syntax-check commands and `git diff --check` passed. Final runs used Electron's bundled Node **24.18.1**, within the supported runtime range. Provider responses were mocked; no live provider accuracy/cost evaluation or deployment was performed.

## Three end-to-end cases

### 1. Same goal, different language

Inputs:

- `Write a review using all papers.`
- `把所有论文综合成一个综述。`

Both produce `literature.corpus_synthesis`, use the same two-paper snapshot and existing corpus workflow, and retain `answerLanguage: en` versus `zh`. The fixture contains English and Chinese original paper text; its original sources are unchanged after both runs. Open compositions such as “Summarize all papers and rank the experiment variants” also retain full corpus coverage without receiving a forced named pattern.

### 2. Same experiment semantics, different schema

`Temperature` and `温度（℃）` map to `temperature`. `Hydroxyectoine Titer (g/L)` and `羟基依克多因产量（g/L）` map to `hydroxyectoine_titer`. Raw headers, cell values, workbook/sheet/source identity, and row provenance remain recoverable.

A bare `羟基依克多因产量` or `产量` needs sufficient units/context or a confirmed correction to disambiguate titer versus yield/productivity. A field label can be canonicalized without inventing an unstated measurement unit.

### 3. Novel composition

Input:

> Find the top five experimental EctD variants, look for contradictory literature, ignore comparisons where temperature differs by more than 5°C, and explain what remains.

The IR keeps `matchedPattern: null`, rank/search/filter/conflict/condition operations, EctD, limit 5, and `temperature_difference <= 5 degC`. With an explicit project primary metric, the host ranks the canonical experimental titer records before truncation, searches original paper evidence using ranked identifiers, and passes the IR/results to the same agent loop.

The integration fixture verifies A163V at 5 g/L and an experimental assay temperature of 30°C. The model can supply an exact original-paper quotation reporting 35°C through the existing `query_experiment_results` tool. The host verifies the quote/source/record/units, computes a 5°C difference, and marks the comparison eligible. The same difference fails a strict `< 5` constraint. Fabricated quotes, card-only evidence, ambiguous temperatures, missing units, and wrong IDs stay unresolved. Scientific contradiction assessment still requires the cited findings; a temperature match alone does not establish scientific comparability.

## File inventory

Existing files updated:

- `alibaba-fc/index.js`: endpoints, request/result validation, diagnostics.
- `alibaba-fc/side-chat-agent.js`: capability metadata, existing-loop semantic context, deterministic result access and grounded comparisons.
- `alibaba-fc/scripts/sync-shared.mjs`: FC contract packaging.
- `desktop/scripts/sync-renderer-assets.mjs`: bundled semantic modules.
- `docs/index.html`: local script loading; layout unchanged.
- `docs/literature-module.js`: FC client, schema-mapper wiring and logical call counters.
- `docs/project-context-service.js`: shared interpretation, corpus/open composition integration, full-scope computation, ranked-entity retrieval, compact telemetry.
- `docs/source-system.js`: canonical structured artifacts, mappings/corrections and deterministic computation.
- `docs/app.js`: existing per-turn/panel telemetry persistence.

New implementation and verification files:

- `shared/semantic-intent.js`
- `shared/experiment-semantics.js`
- `alibaba-fc/test/semantic-intent.test.js`
- `alibaba-fc/test/experiment-semantics.test.js`
- `alibaba-fc/test/semantic-backend.test.js`
- `alibaba-fc/test/semantic-integration.test.js`
- `scripts/benchmark-semantic-intent.js`
- `scripts/fixtures/semantic-intent.json`
- `docs/SEMANTIC_INTENT_ARCHITECTURE.md`
- `docs/SEMANTIC_INTENT_BENCHMARK.md`
- `docs/SEMANTIC_INTENT_BENCHMARK.json`
- `docs/SEMANTIC_INTENT_IMPLEMENTATION_REPORT.md`

Architecture details and limitations are in [SEMANTIC_INTENT_ARCHITECTURE.md](SEMANTIC_INTENT_ARCHITECTURE.md); reproducible benchmark commands, calibration, per-profile counts and limitations are in [SEMANTIC_INTENT_BENCHMARK.md](SEMANTIC_INTENT_BENCHMARK.md).
