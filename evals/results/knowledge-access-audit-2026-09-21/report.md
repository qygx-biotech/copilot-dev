# Knowledge-access audit: 2026-09-21

All work stayed on `nanobot/sidechat`. This is a controlled runtime evaluation using synthetic papers and scripted selected-model responses, the real agent loop, local source registry/artifacts, host tools, signed desktop continuations and final citation resolver. It is **not a live model routing benchmark**. Model choices are supplied by fixtures; host resolution, returned evidence, escalation, worker dispatch, coverage and citation outcomes are measured. No chain-of-thought is recorded. The configured `BIODESIGN_EVAL_FC_TOKEN` was unavailable; no live Requesty inference was performed.

K = `search_project_knowledge`; E = `retrieve_project_evidence`; C = `run_corpus_workflow`. Four papers are in the fixture project. “Derived” means derived material was delivered, not a claim about private model reasoning. “Original” includes an explicit original-evidence tool or original-evidence corpus mapping. Provenance validity checks current source/link/page resolution, never scientific entailment. “Paper” denotes a current source link for a derived overview; “page” denotes a validated original page/chunk link.

| Case / representative query | Route | Resolved scope | Granularity | Coverage mode | Derived | Original | Corpus | Worker | Final provenance |
|---|---|---|---|---|---|---|---|---|---|
| A — What is Bayesian optimization? | Direct | — | — | — | No | No | No | No | N/A (general answer) |
| A2 — Why is methane relevant to ectoine production? | Direct | — | — | — | No | No | No | No | N/A (general answer) |
| B — What are the major themes in this project? | K | project (4) | overview | broad | Yes | No | No | No | Valid paper |
| C — What is the Methane paper about? | K | single_source (1) | overview | targeted | Yes | No | No | No | Valid paper |
| D — Why is methane relevant to ectoine production according to this paper? | K → E | single_source (1) → single_source (1) | concept → claim_support | relevant → targeted | Yes | Yes | No | No | Valid page |
| D2 — How does bio-milking differ from conventional extraction in the Milking paper? | K → E | single_source (1) → single_source (1) | concept → claim_support | relevant → targeted | Yes | Yes | No | No | Valid page |
| D3 — Why might salinity affect ectoine production according to these studies? | K → E | selected_sources (2) → selected_sources (2) | concept → claim_support | relevant → targeted | Yes | Yes | No | No | Valid page |
| E — How do the papers' reactor strategies relate to methane production? | K → E | selected_sources (2) → selected_sources (2) | concept → claim_support | relevant → targeted | Yes | Yes | No | No | Valid page |
| F — What exact pH did the Reactor paper use? | E | single_source (1) | passage | targeted | No | Yes | No | No | Valid page |
| G — Which passage supports the claim that bio-milking retains viable biomass? | E | single_source (1) | claim_support | targeted | No | Yes | No | No | Valid page |
| H — Does the Software paper provide code, data or a repository? | E | single_source (1) | passage | targeted | No | Yes | No | No | Valid page |
| I — Compare the themes of these two selected papers. | K | selected_sources (2) | overview | relevant | Yes | No | No | No | Valid paper |
| J — Synthesize relevant project findings about methane. | K → E | project (4) → selected_sources (2) | overview → claim_support | relevant → targeted | Yes | Yes | No | No | Valid page |
| K — 帮我整理一下所有文献，写个综述。 | C | corpus (4) | overview | exhaustive | Yes | No | Yes | No | Valid paper |
| L — Which page reported that value? | E | single_source (1) | page | targeted | No | Yes | No | No | Valid page |
| M — What pH did the paper with the failed Paper Card use? | E | single_source (1) | claim_support | targeted | No | Yes | No | No | Valid page |
| N — What do current project findings say about methane? | K → E | project (4) → single_source (1) | overview → claim_support | relevant → targeted | Yes | Yes | No | No | Valid page |
| O — Explain across the complete corpus how methane supply, osmotic stress and reactor configuration interact. | C | corpus (4) | concept | exhaustive | Yes | Yes | Yes | Yes | Valid page |

K and O measured **4 included / 4 analyzed / 0 failed / 0 missing**. I stayed within its two-paper hard selection. D/D2 retrieve one paper; D3/E retrieve two. L replays persisted evidence without executing historical calls, then performs one newly selected page read to obtain a current working citation. N labels the old synthesis non-current and obtains current original support.

## Reproduced problems and minimal fixes

1. **Short scientific-token collision:** substring scoring matched `pH` inside “chromatography,” allowing distractors to displace the true result. Shared lexical scoring now matches whole terms/phrases; CJK retains substring matching. The wider regressions exposed unit-only temperature reports, so bounded unit locator hints preserve recall for “30 C,” “37℃,” and similar reports without returning arbitrary chunks.
2. **Passage over-retrieval:** targeted reads appended zero-score chunks and no-match reads returned arbitrary chunks. Targeted reads now return matching passages only. No matches return an explicit gap and refinement/page/section hint. Explicit page/section reads remain available independently of keyword matches.
3. **Orientation over-retrieval:** relevant searches padded a good match with unrelated cards. They now exclude zero-score cards when positive matches exist. Broad orientation still returns a bounded overview; zero-match orientation is explicitly labeled non-query-specific.
4. **Wrong section:** a section name mentioned in a Discussion paragraph was treated as section membership. Extracted headings now take precedence; text fallback is used only when section metadata is absent and remains labeled as passage fallback.
5. **Overeager worker dispatch:** “briefly” and other harmless phrasing caused generic corpus overviews to spawn per-paper workers. Removed the question-keyword heuristic. Overview/metadata requirements with optional support can reuse cards; concept/fine-grained requirements, explanation/source-verification tasks or required support use the existing bounded mapper when no compatible query map exists.
6. **Lost exhaustive obligation:** explicit `coverage: exhaustive` on a knowledge call did not affect the completion guard after a desktop continuation unless the question matched the legacy phrase regex. Validated exhaustive requirements now persist through the signed continuation. A corpus scope defaults to exhaustive coverage. A subset cannot establish completion; the bounded correction requests the corpus workflow, or the final response reports missing coverage.
7. **Stale support flag:** the generic bundle helper counted a non-current original item toward required support. Only current original items with references now satisfy that prerequisite. The agent still assesses substantive sufficiency.
8. **Unnecessary corpus reread:** located original excerpts existed in corpus verification but were absent from the public bundle and working citation registry. Concept/fine-grained corpus calls now return up to eight excerpts, each resolved again against the current in-scope source hash and exact page/chunk. Fabricated/out-of-scope saved references are excluded. This reuses existing original artifacts without another provider call or a mandatory second model-selected tool call.

## Stress coverage

- Direct general answers, including the ambiguous standalone methane question, can finish with one provider-fixture turn and zero project calls.
- Progressive scientific explanations use derived orientation then targeted original passages; the stress case returns one matching chunk from each of two selected papers, excluding distractors and unrelated sources.
- Whole-corpus variants (`all papers`, `every paper`, `entire literature set`, `full review`, `complete corpus`) were exercised with semantic exhaustive requirements and produced measured scope. A keyword-free phrase (`Account for the collection without omissions`) plus an exhaustive search requirement was tested against an attempted false completion: the runtime reported zero analyzed and incomplete coverage.
- Worker tests cover no spawning for deterministic retrieval, semantic eligibility independent of paraphrases, selected-model/scope preservation, bounded per-paper input, cancellation before dispatch, concurrent call deduplication, cached-map reuse and source/recommendation write protections.
- Existing regression coverage continues to exercise transcript pairing, stale/deleted/out-of-scope citation protection, wiki failures, source reconciliation and corpus recovery.

## Remaining limits

- Scripted decisions cannot establish how often Gemma actually chooses the right tool, granularity or coverage. Live selected-model evaluation is still required. In particular, a model that mislabels a complex request as overview can under-retrieve; the contract exposes the distinction but is not another intent classifier.
- The old request-text corpus completion backstop is retained for compatibility. It is not an exhaustive language parser; unexpressed or ambiguous corpus intent still depends on the main model. Declared exhaustive intent now works independently of that phrase list.
- Original passage selection remains lexical and bounded. Synonyms, cross-language paraphrases and information absent from extraction can require model-selected reformulation or explicit page/section reading. A missing match never proves absence.
- Relevant searches with zero matches may return a labeled bounded orientation fallback. Broad orientation is capped at eight papers; it is never proof of complete corpus coverage.
- The existing bounded reasoning worker is a corpus mapper, not a new general-purpose research agent. Non-corpus multi-facet questions use the main agent’s progressive tool calls. This pass does not introduce a service, mandatory decomposition step or autonomous filesystem permissions.
- Citation resolution validates provenance and navigation, not whether the sentence is scientifically entailed by the cited source.
- Reload/rebuild the desktop and deploy the changed backend/shared contracts before live validation. No deployment or running-app reload was performed.

## Reproduction

`node --test alibaba-fc/test/knowledge-access-audit.test.js` runs the matrix and stress tests. Set `KNOWLEDGE_AUDIT_OUTPUT` to an output file to emit the observable JSON matrix. Run `node alibaba-fc/scripts/sync-shared.mjs` first after shared-contract changes. `runtime-decisions.json` contains only queries, selected tools, resolved requirements/scopes and observable outcomes; it contains no private reasoning.

## Final verification

- 31/31 audit tests passed (18 matrix rows plus focused stress checks and the matrix parent test).
- 877/877 backend regression tests passed.
- 38/38 focused desktop tests passed, including 53 native Electron behavioral checks.
- Root and FC syntax/check scripts, shared asset synchronization, desktop renderer build, and `git diff --check` passed.
- Confirmed current branch `nanobot/sidechat` at start and finish; no branch was created or switched.

Production changes in this audit are confined to `shared/side-chat-tools.js`, `docs/project-context-service.js`, and `alibaba-fc/side-chat-agent.js`. Added `alibaba-fc/test/knowledge-access-audit.test.js`, updated the existing detailed-corpus fixtures to express semantic requirements explicitly, and updated the contract documentation. Existing unrelated work remains intact. Initial matrix L/N failures were fixture assumptions (historical citations need a new selected read; small corpus results can be inline), not production persistence failures; those fixtures were corrected without changing history behavior.
