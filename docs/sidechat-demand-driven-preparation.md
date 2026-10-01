# Demand-driven Side Chat preparation

Side Chat previously awaited `AgentRequestPipeline.preflight()` before the main answer loop. That sync prepared every changed or incomplete source through extraction, Paper Cards, topic membership and eligible wiki generation, including for general questions.

`ProjectContextService.buildAgentContext()` now reconciles filesystem metadata and projects the literature catalog only. Authentication, attachment validation, history, hard selection and tool permissions retain their existing paths. The first decision belongs to the main model with the original request, history, catalog and permitted tools. It makes no separate semantic call. Metadata changes mark source freshness as dirty/unverified; they do not authorize generation.

## Tool behavior

- `retrieve_project_evidence` and legacy `read_paper_evidence` prepare/reuse only local original extraction. They never require cards or wikis.
- `search_project_knowledge` defaults to cached orientation. Optional `prepare: "paper_cards"` requests canonical cards for its resolved sources; `prepare: "wiki"` also prepares their topic dependencies and invokes existing wiki admission/eligibility/maintenance. Source IDs narrow a targeted request. Other workspace sources are untouched.
- `run_corpus_workflow` still collects original evidence deterministically for the complete authorized scope and reports measured coverage. It accepts the same optional preparation choices when the task needs derived artifacts. No per-paper reasoning mapper is added.
- Omitted `prepare` and `prepare: "cached"` retain previous tool-call/continuation behavior. There is no mandatory sequence through all knowledge layers.

Wiki update/check/incorporate commands are interpreted from the original user request, never from the tool's query. Existing explicit processing/rebuild entry points remain available. Selecting preparation does not confer source-file write permissions, change the Current Recommendation, expand hard selections, or override wiki generation eligibility, cooldowns, or attempted-evidence records. Missing unrelated pages do not authorize a rebuild. An ineligible required wiki remains a reported gap; original evidence remains available.

## Freshness and failures

The host captures stat signatures and known current hashes at request entry. Dirty/new sources are hashed on first tool use and then bound to that version. Current request-local metadata handles can resolve unprepared sources, but still pass through host scope, signature and hash validation before evidence publication. Known mismatched handle versions remain rejected. Mid-request changes invalidate evidence; unrelated dirty sources do not block a scoped read. Signed continuation validation is unchanged.

Derived preparation reports per-source/page failures and safe timing/accounting. Repeated equivalent preparation within a turn reuses its result, including failure, rather than spending another generation attempt. Cancellation stops scheduling and publishing; verified original evidence remains independently retrievable when derived generation fails. Corpus coverage and exact citation checks remain authoritative.

## Call sequences

| Request | Before | After |
| --- | --- | --- |
| General question/follow-up | Metadata → workspace preparation/cards/wiki → main answer | Metadata → main answer |
| Specific paper fact | Workspace preparation/cards/wiki → main → original read → main | Metadata → main → scoped original read → main |
| Cross-paper synthesis | Workspace preparation/cards/wiki → main → evidence tool → main | Metadata → main → selected scoped tool (reuse or requested preparation) → main synthesis |

The change does not raise model/tool/time budgets or move execution to the cloud. Cache hits can avoid all derived-generation calls. A cold synthesis that explicitly needs cards/wiki still incurs their existing provider costs.

## Diagnostics and regression checks

`knowledge.metadata-reconciliation` reports metadata latency and zero provider attempts. `knowledge.original-evidence` and `knowledge.cached-retrieval` report retrieval latency separately. `knowledge.derived-preparation` reports preparation time, local parse time, card generation count/time and provider-attempt deltas; unknown provider attempts remain null. Existing detailed wiki generation/admission/provider logs remain available. Counts are not dollar estimates; no credentials, prompts or paper text are added to diagnostics.

`demand-driven-side-chat.test.js` exercises the production main loop, local host and signed continuations with controlled providers: cold direct answers/follow-ups, scoped original facts/citations, card/wiki synthesis, cache reuse, stale-source refresh, original fallback, explicit maintenance, scope enforcement, cancellation and corpus coverage. Existing cached-evidence tests seed artifacts explicitly; they no longer rely on an unrelated chat to create their fixtures. Agent Work acquisition regressions remain in the full backend suite.
