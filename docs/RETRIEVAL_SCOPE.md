# Retrieval scope for literature discovery

The canonical SemanticIntentIR and its explicit Requesty output schema now
contain one additional required property:

```json
"retrievalScope": {
  "type": "string",
  "enum": ["workspace", "web", "both", "none"]
}
```

| Scope | Preparation and answering |
| --- | --- |
| `workspace` | Existing local literature matching, lexical planning, QMD retrieval, candidate ranking and original evidence preparation. |
| `web` | Skip local retrieval and proceed to the main agent, which can use provider-hosted `web_search` when supported. |
| `both` | Prepare workspace evidence and also ask the main agent to discover external sources. Keep workspace citations and provider-returned web citations distinct. |
| `none` | No forced retrieval. Other explicitly requested actions, including saving a supplied URL, retain their existing permissions. |

The model infers scope from the request's meaning. Neither language, selected
files, the `literature.search` pattern nor the `search_papers` hint can override
an explicit scope. There is no new keyword classifier. The existing semantic
interpreter consults the same model for literature search/comparison even when
its local pattern match is confident: category confidence does not distinguish
external discovery from workspace retrieval. Established corpus-summary and
other local fast paths remain intact.

`search_papers` is preserved as the existing workspace tool. Its name and
execution contract are unchanged. For compatibility, an IR may still pair that
hint with `web`; scope then prevents local retrieval and the advisory plan omits
local evidence tools. The plan's `hostedTools: ["web_search"]` is advisory
metadata, not a local function definition or permission grant. Actual hosted
tool availability still uses the existing model capabilities and tool builder.

## Where the premature search occurred

`ProjectContextService.buildContextInternal` treated literature objects/patterns
as `paperQuestion`, called `matchPapers`, and thereby entered
`LiteratureTools.searchPapers` and the existing QMD/lexical/reranking pipeline.
Later, `decideContextRouting` could independently re-enable literature and a
second `matchPapers` fallback. Layered knowledge retrieval was another entry.

All of these preparation paths now honor the shared IR scope. Web/none also
avoid inheriting a paper reference from earlier conversation or selected files,
without changing the hard selection or permission rules. Knowledge synchronization
still runs as the existing preflight; scope does not redesign or disable the
raw-source-change pipeline.

The main agent receives a concise scope instruction. Search does not download
anything automatically. An explicit save request retains `download_sources`;
the model selects useful URLs and the existing desktop tool saves them locally.
Ingestion remains the existing later source-change workflow.

## Compatibility and diagnostics

- New model output must include a valid scope in either strict schema or
  JSON-object mode. Missing/unknown/null scopes fail canonical validation.
- Older stored/client IRs missing the additive field default to the previous
  workspace policy. IR version remains 1. The local pattern/cache version and FC
  interpretation prompt/configuration signature changed to invalidate old routes.
- Light/offline interpretation and parser failures retain the prior local policy;
  they do not guess web scope using keywords. The normal online Medium policy
  obtains external-discovery scope from the semantic model.
- Model output uses the shared `normalizeModelSemanticIR` boundary before strict
  semantic validation. Paper/article object aliases become `literature`; an
  incompatible optional pattern shortcut becomes null. The goal, scope, operations,
  capability hints, identifiers and hard selections remain intact. Unknown fields,
  invalid scope, invalid operations and unsafe source IDs still fail validation.
- `retrieval.decision` records the effective scope and semantic route/fallback before
  local retrieval can start. `main-agent.started` records the submitted scope and
  whether semantic context is present. These primitive fields pass the runtime
  logger's allowlist; full IR, prompts and response bodies do not.
- `retrieval.routing` records `retrievalScope`,
  `matchedPattern`, `workspaceRetrievalTriggered`, `webSearchExpected` and
  `downloadRequested`, plus available turn/surface identifiers. It omits query
  text and credentials. The workspace flag concerns request-driven retrieval,
  not existing source synchronization.

For the Chinese search-and-download request, the expected routing event is:

```json
{
  "retrievalScope": "web",
  "workspaceRetrievalTriggered": false,
  "webSearchExpected": true,
  "downloadRequested": true
}
```

The focused regression tests run the production context builder, authenticated
FC semantic endpoint, Requesty serializer, local Deep retrieval chain and main
agent, with mocked network/model boundaries. They verify Chinese/English scope,
zero local search before the main agent for web scope, preserved corpus/Q&A
paths, separate source provenance, download permissions and strict validation.
They do not certify live model interpretation or provider acceptance.

The original routing correction was packaged as `Archive-retrieval-scope-routing.zip`.
For the current implementation deploy `Archive-routing-citations.zip` to the same
FC application and reload/rebuild the updated client. Its default sequential
mode uses this unchanged semantic scope to run hosted search separately from the
local-function loop. The unverified Google combined-tool field is confined to an
explicit opt-in mode. See [search stages and continuation](WEB_SEARCH_AND_SOURCE_DOWNLOAD.md).
No additional search provider, storage or infrastructure is introduced.

## Reported composition regression (2026-09-12)

The supplied Gemini result chose `web`, with operations `search` and `store`,
but labeled the task `literature.search` and used the object `papers`. The old
validator rejected this shortcut: it covers only search and expects `literature`.
FC returned `InvalidStructuredOutput`; the desktop then selected its local
fallback (`workspace`, `search` + `export`). This explains the lexical planner,
reranker, missing hosted stage and local-only final answer despite a successful
Requesty semantic generation. The exact supplied JSON reproduces the failure.

Normalization now clears only the optional shortcut and canonicalizes the object
alias, then applies the existing strict validator. It performs no extra model
call and never chooses retrieval scope from query keywords. The regression test
runs this raw JSON through FC, the API client, context preparation and the agent
loop: semantic → hosted search → local download handoff, with no lexical/QMD/rerank
calls. The existing signed download continuation tests still pass.
