# Side Chat knowledge-access contract

Implemented on the existing `nanobot/sidechat` branch without changing the UI or replacing the agent loop. The model expresses evidence needs through the three existing public tools. Storage layers remain implementation details. The shared JavaScript module uses JSDoc types, JSON tool schemas and runtime validation, consistent with this repository's UMD shared contracts.

## Requirement

All `requirement` fields are optional on input. The host returns the resolved form:

```ts
type EvidenceRequirement = {
  task: 'lookup' | 'overview' | 'explanation' | 'comparison' |
        'synthesis' | 'literature_review' | 'source_verification';
  domains: string[]; // only ['literature'] is enabled; experiments are reserved
  scope: {
    type: 'project' | 'single_source' | 'selected_sources' | 'corpus';
    sourceIds: string[]; // stable registry IDs, resolved against the hard scope
  };
  coverage: 'targeted' | 'relevant' | 'broad' | 'exhaustive';
  granularity: 'metadata' | 'overview' | 'concept' | 'section' |
               'page' | 'passage' | 'claim_support';
  freshness: 'current';
  claimSupport: 'not_required' | 'as_needed' | 'required';
};
```

Search defaults to overview/relevant/as-needed support; original retrieval defaults to lookup/targeted/passage/required support. Corpus defaults to literature-review/exhaustive/overview. Fine granularity and source verification require original support even if the model requests a weaker support level. Unknown properties/domains/values, malformed IDs and conflicting old/new selectors fail locally. Explicit model selectors are bounded to eight IDs; omitting them resolves the host's full permitted scope. A corpus call cannot narrow the host's authoritative requested snapshot. Its public schema omits scope, coverage and freshness; legacy selectors remain accepted internally only after safe identity and permission checks.

`search_project_knowledge` and `retrieve_project_evidence` still accept `{query, paper_ids?}`. They now also accept `requirement?`; original retrieval accepts optional positive `page` and bounded `section`. `run_corpus_workflow` still accepts `{}` and now accepts `requirement?`, but continues using the host's complete original question, selected model, language and captured hard selection.

## Bundle

Successful results preserve their existing fields and add `evidenceBundle`:

```ts
type EvidenceBundle = {
  version: 1;
  resolvedRequirement: EvidenceRequirement;
  scope: EvidenceRequirement['scope'];
  coverage: {
    requested: number; included: number; complete: boolean;
    analyzed?: number; failed?: number; missing?: number;
    searchedSourceIds?: string[];
  };
  items: Array<{
    sourceIds: string[];
    artifactId?: string;
    evidenceKind: 'metadata' | 'paper_card' | 'wiki' | 'historical_synthesis' |
                  'original_passage' | 'original_section' | 'original_page' | 'other';
    derived: boolean;
    current: boolean;
    content: string;
    truncated?: boolean;
    verificationStatus?: string;
    provenance: { sourceVersions: Record<string, string>; cardIdentity?: string; generation?: object };
    references: Array<{ sourceId: string; reference: string; page: number; contentHash: string }>;
  }>;
  gaps: string[];
  escalationHints: string[];
  sufficiency: 'needs_original_evidence' | 'agent_must_assess';
  limitation: string;
};
```

References are the existing validated `citationEvidence` records, using existing `[[cite:SOURCE_ID:pPAGE:CHUNK_ID]]` syntax and navigation. Bundle excerpts are bounded to 1,000 characters per item; the existing tool result fields contain fuller bounded content. The references describe that returned evidence, not a new citation namespace. `current` describes dependency/configuration freshness, **not scientific entailment**. A resolved citation never proves a claim. Missing or partial output remains explicit. Only the corpus workflow reports measured analyzed counts and complete coverage; search cannot manufacture such a result.

## Tool routing and refinement

| Public tool | Existing storage used | Behavior |
| --- | --- | --- |
| `search_project_knowledge` | L0 registry metadata; compatible L2 cards; gated L3 wiki/drafts; dependency-checked L4 syntheses | Local cached orientation. Rank card/metadata text without reading every original artifact. At most eight cards/metadata results plus existing bounded saved-artifact search. No artifact regeneration. |
| `retrieve_project_evidence` | Current L1 extraction/chunks backed by reconciled L0 | Search permitted sources, read at most eight papers and eight chunks per paper, with existing 12k per-paper excerpt ceiling. Optional page/section filters and stable original citations. No card generation. |
| `run_corpus_workflow` | Authoritative L0 snapshot, current L1 passages, compatible L2 cards, current L3/L4 context | Collect locally across the full scoped snapshot. Preserve included/analyzed/failed/missing accounting, source-ID/hash diffs, cancellation and recovery. Return one bounded evidence bundle for the main agent to synthesize; no per-paper LLM mapping or query-time Paper Card generation. |

Fallback/escalation rules:

1. No project-dependent question means no required knowledge call. Maintenance remains separate from retrieval; no classifier, automatic RAG or mandatory provider planning was added.
2. Cards/wiki orient; the agent can stop if that is sufficient. Missing cards return metadata and a refinement hint. Failed summaries never disable original evidence.
3. Fine claims always need original support. A search bundle with such a requirement returns `needs_original_evidence`. The agent may go straight to original retrieval; it need not traverse all tools.
4. A source-code query locally includes code/software availability, implementation, repository, GitHub, data availability and supplementary terms. Zero lexical matches are reported as such, never as evidence of non-release.
5. Section metadata may be absent. In that case the bundle explicitly reports passage fallback, not a complete section. Page/section excerpts remain bounded.
6. Each tool reconciles before access and again before publishing results. A source-set/version change invalidates the response. Failed individual reads are reported while other permitted sources remain usable.
7. Draft/stale/unverified wiki material retains its labels and validated citation subset. Old saved syntheses without sufficient configuration metadata remain readable as historical context (`current: false`). No compatibility migration spends on regeneration during search.
8. The public corpus tool uses `local-corpus-evidence-v1` collections keyed by query and source version. Old provider maps remain readable but are replaced locally for this path. Cards remain intact. Original excerpts are resolved again against current source/hash/page/chunk before delivery. Failed cards never block original evidence.

## Bounded reasoning and observability

The public corpus tool sets host-owned `localEvidenceOnly: true`. Local QMD/lexical retrieval runs in the fast profile, without provider search planning, reranking or mapping. The existing bounded workflow scheduler still handles sources and failures; grouping/reduction/reference checks remain deterministic. The selected main model receives the combined tool result and writes the synthesis in its next normal loop call. Extra evidence tools remain possible when needed, but there is no mandatory per-paper model call.

Compatible cards supply orientation; current wiki/saved syntheses are supplementary derived context. Original evidence comes from resolved current chunks, up to six matches per paper. On a no-match question, representative source excerpts are clearly labeled as orientation, never proof of absence. The final package allocates roughly 22k original-text characters and 6k card-text characters across up to 100 paper entries, with bounded wiki/synthesis context. Input delivery counts and omissions are explicit; a larger corpus must not be represented as a complete final review of unseen contents. Full local workflow coverage and bounded synthesis-input coverage are separate. Citation resolution does not prove entailment.

The prior mapper implementation and endpoint remain available for legacy explicit callers; `run_corpus_workflow` in the main agent does not invoke them. The local collection mode is stored in the workflow journal and inherited by resume/retry/incremental operations, so recovery does not re-enable provider mapping. Initial ingestion/knowledge maintenance can still generate Paper Cards/wiki under existing policy; this is separate from query-time evidence collection.

`knowledge.access` records tool name, resolved source IDs/scope type, granularity, sufficiency status, original-evidence escalation, corpus requirement, measured coverage and worker count. `corpus-local-evidence` progress marks local per-paper collection (`providerRequest: false`); `providerMapRequests` and `subagentSpawned` remain zero in this path. Existing model-tool telemetry identifies the direct-answer path with no knowledge calls. The runtime log allowlist excludes prompts, document text and model reasoning. Existing maintenance, image, replay and provider-call diagnostics remain separate.

## Compatibility and verification

Unchanged: visible chat history, persisted paired transcript/replay/compaction, desktop continuations, original user request/attachments/language, semantic helpers for existing callers, selected-model resolution, source-file and recommendation protections, original citation validation/navigation, five storage layers, evidence-gated wiki policy and five-minute ceiling, source reconciliation, cached compatible cards and corpus recovery.

Implementation files: `shared/side-chat-tools.js`, `docs/project-context-service.js`, `docs/source-system.js`, `docs/runtime-log.js`, `alibaba-fc/side-chat-agent.js`, and the backend health marker in `alibaba-fc/index.js`. Tests: new `alibaba-fc/test/evidence-access.test.js` and additional bundle assertions in `alibaba-fc/test/literature-wiki.test.js`. This document records the contract; pre-existing branch changes are retained.

Verification uses local in-memory source/storage fixtures, scripted selected-model responses, the real authenticated backend/desktop-continuation path, and native Electron navigation fixtures. These tests verify the control flow and protections; they do not establish live Requesty model behavior. No live inference or deployment was performed for this change. Backend rollout must include synced shared contracts and expose `runtimeContracts.knowledgeAccess: "evidence-bundle-v1"`. Rebuild/reload the desktop (or rebuild/reinstall its package) to load the updated shared schema and host retrieval. Building assets alone does not update an already-running process. A live selected-model direct answer, progressive evidence read and Chinese corpus review remain rollout verification steps.

Final verification on 2026-09-21: **846/846 backend tests**, including 14 new evidence-access tests; **38/38 focused desktop tests**, including the native Electron fixture's **53 behavioral checks**; root `check`, FC `check`, shared-contract synchronization, `desktop:prepare`/renderer build and `git diff --check` passed. Initial sandbox-only localhost binding failures were rerun successfully with the required permission. No dedicated TypeScript/lint script is configured for these JavaScript modules.

The follow-up audit and observable A–O evaluation matrix are recorded in `../evals/results/knowledge-access-audit-2026-09-21/report.md`. Targeted passage reads now exclude zero-match padding, lexical terms avoid short-token substring collisions, extracted section headings take precedence over body mentions, and declared exhaustive scope survives signed continuations.

The corpus collection follow-up supersedes the earlier eight-excerpt cap: each delivered paper now has its own current evidence allocation, rather than drawing all final support from the first eight references in the corpus. The provider response fixtures verify one main-agent tool decision followed by one final synthesis, zero per-paper workers, and existing citation navigation.

Local-collection verification (2026-09-21): 894 backend tests, 38 focused desktop tests including 53 native Electron checks, syntax/build checks and diff checks passed. The new fixtures cover zero mapper/planner/card-generation calls during collection, Chinese main-loop synthesis, failed cards with usable original evidence, a 20-paper bounded package, changed-source invalidation, saved local-mode recovery, scope and invalid citations. No live Requesty call or deployment was performed. Reload/rebuild the desktop and deploy the synced backend public-tool descriptions for rollout.

## Knowledge-tool identity and local evidence handoff (2026-09-22)

Root causes: the model-facing catalog displayed request-local item handles prominently, but `resolveRequirement` compared its `sourceIds` directly with registry IDs. A valid current catalog handle consequently produced `SOURCE_OUTSIDE_SCOPE`. Meanwhile, `read_paper_evidence` belonged to the backend's loaded-context dispatcher instead of the existing project-host dispatcher, so it could report unavailable evidence merely because the first model request contained metadata only.

The public identity is now the stable registry `sourceId` / `paper_id`. Catalog lines and list results explicitly separate that identity from `item_id` and exact citation references. Shared `resolveSourceId` / `resolveArguments` accept a compatibility handle only through an exact host-owned paper binding for the current request and content hash. Bindings survive signed continuations without being rebuilt or retargeted. Historical namespaces, missing bindings, ambiguity, non-paper artifacts, version changes, deletion and scope denial have distinct errors. Titles, paths, citation prefixes and historical namespace suffixes are never used to guess a source ID. Continuations predating the binding snapshot cannot silently recreate handle bindings; stable IDs remain the supported path.

All three tools still validate arguments and enforce the same host-owned hard selection. The backend resolves current handles before handoff; the local host independently resolves stable IDs, reconciles the registry, verifies hashes and rejects changed/deleted sources before publishing results. Identity errors contain static guidance, not other sources' metadata or private paths.

| Tool | Current behavior |
| --- | --- |
| `search_project_knowledge` | Searches cached compatible cards, metadata, eligible wiki content and saved syntheses. Uses the cached/current card configuration when available; configuration uncertainty returns a gap instead of regenerating cards. Does not search original chunks for orientation. Stale synthesis metadata remains labeled `current:false`, but its prose is excluded. Eligible unverified wiki drafts remain explicitly unverified. Returns stable IDs, the existing EvidenceBundle, provenance, scope and escalation hints. |
| `retrieve_project_evidence` | Reads current local original-evidence artifacts, using permitted extraction when the cache is missing. No card generation is needed. Supports targeted page, section, passage and claim-support access with existing exact citation references and versions. Unmatched page/section queries do not receive arbitrary chunks. Missing section boundaries yield matching passages and an explicit gap. |
| `read_paper_evidence` | In the current Side Chat project-tool flow, a compatibility adapter to the same host-backed retrieval branch. Keeps `paper_id`, `item_id`, `query`, `evidence_ref`, `offset` and `max_characters` input support. Unknown arguments/conflicting identities/invalid references fail explicitly. Returns content, stable identity/version, evidence citations, bounded-read fields and an EvidenceBundle. Offsets in this host adapter count original text characters excluding inserted citation markers, as reported by `offset_unit`. |

No-match means no match in the material searched, not that the paper contains no statement or that its authors released no code. Missing local extraction is invalidated and prepared independently of a compatible Paper Card. The existing selected model, signed continuation token, original request, tool-call IDs, call/result ordering, execution budgets and historical transcript remain in use. Historical replay executes no tools. Old clients without the project-host capability retain their older bounded-context path; update/reload the client for the new adapter.

`run_corpus_workflow` remains a separate measured-coverage operation with local evidence collection and cached work reuse, without per-paper LLM mapping. Single-paper identity failures never invoke it automatically. No mandatory retrieval, classifier, planning request, subagent, new permission or external service was added. Source files and Current Recommendation protections remain enforced by existing application code.

Safe diagnostic events distinguish `knowledge_tool_resolution` identity failures, scope denial and host handoff; host events distinguish cached/local original evidence, no matches and other local failures. Existing historical-replay and provider/configuration-call accounting remain separate. No paper text, credentials or model reasoning are logged by these events.

Files changed in this pass: `shared/side-chat-tools.js`, `alibaba-fc/side-chat-agent.js`, `alibaba-fc/index.js`, `docs/project-context-service.js`, `alibaba-fc/test/knowledge-tool-identity.test.js`, `alibaba-fc/test/side-chat-agent.test.js`, and this document.

Verification: **933 backend tests**, **38 focused desktop tests** (including 53 native Electron renderer checks), FC/root syntax checks, renderer preparation/build and diff checks passed. New tests use real authenticated FC handlers, signed continuations and the local host dispatcher with fixture provider responses; they cover both knowledge tools resolving the same current handle, legacy reads, immutable bindings, invalid identities, source changes/deletion, hard scope, bounded reads, missing extraction, failed cards and citation navigation. Existing tests cover no-retrieval answers, progressive refinement, stale derived knowledge and measured corpus coverage.

This is **fixture/local integration verification**, not live Requesty verification. Deploy the backend with synchronized `shared/side-chat-tools.js` and the updated agent/index. The health endpoint then exposes `runtimeContracts.knowledgeIdentity: "stable-source-host-v1"`. Reload/restart the rebuilt Electron app (or rebuild/reinstall the packaged app) for the host adapter and shared validation. No backend deployment, running-app reload or live provider inference was performed during this pass. All edits stayed on `nanobot/sidechat`; existing branch work was preserved.


## Host-owned corpus scope

The corpus tool previously exposed the shared source-ID selector and rejected valid incomplete enumerations with `CORPUS_SCOPE_MISMATCH`. Its model-facing input is now:

```ts
{
  requirement?: {
    task?: EvidenceRequirement['task'];
    domains?: ['literature'];
    granularity?: EvidenceRequirement['granularity'];
    claimSupport?: EvidenceRequirement['claimSupport'];
  };
}
```

Both objects reject additional properties in the advertised schema. All fields are optional; defaults remain literature_review / literature / overview / as_needed. Fine granularity or source verification still enforces required original support. The host enforces currentness and exhaustive coverage. Search/retrieve retain source-ID targeting and their existing schemas. There is no new classifier, retrieval gate or provider call.

The local host captures explicit selected IDs/paths separately from bounded retrieval lists. No selection means the permitted project registry; selection means that complete selection only. Unresolved selection fails closed with `SOURCE_SCOPE_UNRESOLVED`. Reconciliation happens before execution and again before publication. Registered missing sources remain in the authoritative snapshot and missing counts, even when every selected paper is missing. A known source version change still requires a fresh request; newly discovered project papers enter the snapshot without relying on semantic search.

Legacy `requirement.scope.sourceIds` is accepted by application validation but not advertised to the model. Exact current request handles use the existing host-owned identity/version mapping; unknown, expired, ambiguous, artifact, stale-version and out-of-scope references retain their existing errors. A valid legacy enumeration is replaced by the entire host scope, never used to narrow it or widen permissions. Legacy scope types do not create a user selection. Top-level `paper_ids` was never a supported corpus argument and remains explicitly rejected.

Results add `scopeResolution` with `scopeOrigin` (project/user_selection), `authoritativeSourceCount`, `legacyArgumentsNormalized`, `legacyRequestedCount` (resolved unique legacy sources), and `resolvedSourceCount`. Legacy calls include a fixed normalization explanation. The existing EvidenceBundle supplies the full resolved scope and measured included/analyzed/failed/missing counts. These fields survive structural compaction. Safe `knowledge.access` diagnostics report the same counts and scope origin without paper contents or paths. Missing sources do not become current evidence, and complete coverage stays false when failures or missing papers remain.

Incremental files: `shared/side-chat-tools.js`, `alibaba-fc/side-chat-agent.js`, `alibaba-fc/index.js` (health marker), `docs/project-context-service.js`, `docs/source-system.js` (preserve missing requested records in snapshots), `docs/runtime-log.js`, `alibaba-fc/test/corpus-scope.test.js`, `alibaba-fc/test/evidence-access.test.js`, `alibaba-fc/test/corpus-continuation.test.js`, `alibaba-fc/test/direct-side-chat.test.js`, and this document. Existing build scripts synchronize shared backend and desktop copies.

Deploy the backend with `runtimeContracts.corpusScope: host-authoritative-v1` and reload the desktop host/shared assets (or rebuild/reinstall a packaged app). Fixture tests exercise authenticated provider-adapter dispatch, signed continuations and real local corpus collection; they do not establish live Requesty acceptance. No deployment or app reload is performed by these source changes.


Verification for host-owned scope: **998 backend tests passed**, **38 focused desktop tests passed**, including **53 native Electron behavioral checks**. Backend/root syntax checks, shared-contract synchronization, desktop renderer build and `git diff --check` passed. The added fixtures cover four-paper default scope, three-of-four legacy normalization, two-paper selection and one-of-two normalization, exact current handles, invalid/out-of-scope/historical/artifact/ambiguous/stale bindings, added/changed/deleted sources, failed-card L1 fallback, warm cache reuse and explicit unresolved/all-missing selections. Existing regressions cover direct answers without retrieval, historical replay, context/quota recovery and signed tool/result pairing. The public development health check reports `contextBudget: provider-reactive-tool-progress-v3`, but no `corpusScope` marker; corpus-scope deployment remains required. No live authenticated Requesty reproduction was run.


## Original-evidence budget

`retrieve_project_evidence` defaults to **30,000 characters per paper**, including inserted citation markers and separators. Its optional `max_characters` accepts integer upper bounds from 200 through 30,000. `read_paper_evidence` retains the 12,000-character default, 200–16,000 explicit range, offsets, exact-reference lookup and legacy response fields.

The host allocates evidence before collection rather than slicing result prefixes afterward. For N retrieved papers (at most eight), the aggregate JSON-encoded passage budget is `min(48000, 64000 - 4000 - 3000*N)` characters. Each paper gets an equal share, capped by its requested per-paper bound; unused shares are not reassigned. This reserves space for the envelope, previews and provenance. Typical upper bounds are 30,000 for one paper, 24,000 each for two, and 4,500 each for eight. JSON escaping consumes additional serialized space and can reduce actual text further. Legacy reads reserve space for both their `content` and `files[].content` copies. Existing eight-chunk/read limits remain in place. Budget/chunk truncation is reported in gaps; absence of a match is never scientific absence.

`files[].content` carries the fuller original evidence. The normalized EvidenceBundle keeps a 1,000-character preview, labeled `contentRole: preview` and linked to the full field through `fullEvidenceLocation`; provenance/citations refer to the fuller returned evidence. Previews omit incomplete trailing citation markers. The previous 32,000-character trigger / 20,000-total prefix reduction no longer applies to original-evidence results. Each result includes `evidenceBudget` with requested/effective limits, aggregate allocation and its policy.

The full serialized original-evidence result is limited to 64,000 characters; exceptional metadata growth returns an explicit `LOCAL_EVIDENCE_RESULT_LIMIT` local error rather than slicing evidence or pretending the provider rejected it. Two original-evidence results fit below the unchanged 180,000-character signed result-batch guard. Mixed larger tool batches still obey that batch guard. The 700,000-byte signed continuation limit, 32 MiB HTTP limit, persisted history limits, cancellation, step/tool budgets and provider-triggered structural/context-quota recovery remain unchanged. Active results are delivered intact on the initial provider attempt. Original artifacts and compatible Paper Cards are reused; no eager retrieval or extra provider calls were added.

Files changed for this increment: `docs/project-context-service.js`, `shared/side-chat-tools.js`, `alibaba-fc/index.js` (health marker), `alibaba-fc/test/evidence-budget.test.js`, and this document. Shared copies and desktop assets are generated by the existing build scripts. Deploy the backend with `originalEvidenceBudget: 30000-per-paper-v1` and reload the desktop host/shared assets (rebuild/reinstall a packaged app). Fixture verification is separate from live Requesty acceptance.


Budget verification: **1,007 backend tests passed**, **38 focused desktop tests passed**, including **53 Electron behavioral checks**; backend/root syntax checks, shared synchronization, renderer build and `git diff --check` passed. Nine new tests use the authenticated provider adapter and signed handoffs to cover one/two/eight-paper allocation, two simultaneous reads, evidence after character 12,000, exact current citation targets, initial payload equality, 30,000-character bounds, explicit bounds, legacy offsets/fields, JSON escaping, exceptional metadata overflow and the retained 180,000-character batch rejection. These are fixtures, not live Requesty inference. No deployment or app reload was performed.

## Targeted original-evidence retrieval

Targeted passage/claim-support reads now spend the output budget in relevance order, then arrange only the retained excerpts in document order. Previously, sorting candidate chunks into document order before allocation let weak early matches exhaust the budget before a late Code Availability passage. Taking chunk prefixes also lost matches near the end of long chunks.

The local locator reuses lexical expansion (including Chinese availability queries against English evidence). It removes the resolved paper's leading display-name token from ordinary lexical scoring. Availability statements and repository locators receive stronger signals than incidental terms; comparison/baseline repositories are distinguished where the surrounding text identifies them. These are deterministic locator heuristics, not repository-ownership or scientific-claim verification. A repository whose URL contains the paper-name token is still evidence to inspect, not proof of ownership.

Targeted excerpts center on the strongest matching statement/URL with up to 500 preceding characters. They copy original text only and avoid cutting URL tokens. If a complete focal URL cannot fit, the passage is omitted rather than reconstructing a link. Same-page exact duplicate/contained windows and boundary overlaps are removed when that preserves the focal match and complete URLs. Retained excerpts keep their existing chunk citation targets, page and source hash. Explicit page/section reads, page/section granularity, exact-reference and legacy offset reads retain their established document-read semantics. No stored evidence is rewritten.

The 30,000-character default and explicit caller bounds remain; aggregate serialization allocation, eight retained chunks, eight sources, full-result/transport safeguards and provider-triggered recovery remain unchanged. Targeted reads may return less than the ceiling when only shorter matching windows are useful. The full evidence remains in `files[].content`; the EvidenceBundle remains a compact preview. No Paper Card regeneration, per-paper provider mapping, automatic retrieval, classifier or subagent was added.

`retrievalDetails` records per-source hash, searched/matching/delivered/omitted chunk counts, delivered pages, truncation, overlap reductions, availability locator kinds and refinement hints. `needsRefinement` means the requested locator was not delivered; its absence does not certify an answer or a scientific claim. `evidence_found` only means passages were returned. Missing matches remain inconclusive.

The existing agent loop allows one completion check if the model attempts to finish while its latest current-turn original-evidence read reports an unresolved detail. It can refine query/page/section within the same hard scope or explain the limitation. Signed continuation state retains the check allowance and canonical read keys. An identical unsuccessful read is rejected before a new host handoff. Historical replay does not create read attempts or execute tools. If the detail remains unresolved, the final answer and persisted assistant message include a deterministic searched-scope limitation. Existing step/tool/cancellation bounds still apply, and a general question with no retrieval remains a direct-answer route.

Limitations: lexical expansion is not semantic entailment; unusual titles/repository names and ambiguous ownership can still require model assessment or refinement. The identity hint uses the leading display-name token and does not guess source IDs. URLs split by PDF extraction or across chunks are not reconstructed. Overlap reduction is exact-text and bounded, not fuzzy deduplication. Explicit page/section prefix reads may need a subsequent targeted query to reach a late detail. Provider-triggered compaction can still shorten evidence under the established recovery policy.

Files changed for this increment: `shared/side-chat-tools.js`, `docs/project-context-service.js`, `alibaba-fc/side-chat-agent.js`, `alibaba-fc/index.js` (health marker), `alibaba-fc/test/targeted-evidence.test.js`, `alibaba-fc/test/evidence-budget.test.js` (nonredundant budget fixture), and this document. Existing scripts generate synchronized backend/shared and desktop assets.

Verification: **1,012 backend tests passed**, **38 focused desktop tests passed**, including **53 native Electron checks**. Backend/root syntax checks, shared synchronization, desktop renderer build and `git diff --check` passed. New fixtures exercise the authenticated tool dispatch, real local evidence collector and signed desktop continuation: large early SurfDock performance sections, a competing DiffDock URL, a late long-chunk availability statement/full URL under a 1,600-character bound, overlap reduction, exact page/citation/hash navigation, no-match results, useful refinement, duplicate-read rejection, persisted unresolved limitations, unchanged original artifacts and compatible cards. Existing regressions cover hard selection/currentness, 30,000-character bounds and aggregate safeguards, history replay, compaction, permissions and zero-retrieval answers. These are fixture results, not live Requesty inference.

Deployment requires the updated Function Compute backend (`targetedEvidence: relevance-first-v1`) and refreshed desktop host/shared assets; rebuild/reinstall packaged apps. No deployment, app reload or live authenticated Requesty reproduction was performed by this change.

The public development backend health check during this pass returned `contextBudget: provider-reactive-tool-progress-v3` but no `targetedEvidence` or `originalEvidenceBudget` marker. The deployed backend therefore has not confirmed either of these retrieval increments; backend deployment and desktop reload remain required.
