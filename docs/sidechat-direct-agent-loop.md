# Side Chat direct agent loop

Implemented on the existing `nanobot/sidechat` branch, 2026-09-20. This supersedes the mandatory Side Chat semantic-planning path described in the earlier integration notes. Existing branch work, the five literature layers, five-minute wiki maintenance, transcript storage, and Agent Work behavior remain in place.

## Local nanobot comparison

The local nanobot checkout inspected for this change is `2fb16593`.

| nanobot | Electron / FC equivalent |
| --- | --- |
| `agent/loop.py`: construct a session turn, checkpoint and `_save_turn` | `askSideChat`, the existing conversation store and versioned transcript checkpoints |
| `agent/context.py`: fresh instructions, history, current user message and media | `buildAgentContext`, FC system/catalog assembly, bounded transcript replay and original image injection |
| `agent/runner.py`: model call, validated tool calls, paired results, next model call | `runSideChatAgent`, the permitted tool registry and signed desktop continuations |
| `session/manager.py`: bounded history at valid exchange boundaries | Existing `shared/conversation-transcript.js` and `alibaba-fc/conversation-history.js` |

The socket is a transport detail. Electron continues to use its confined host/IPC services and authenticated FC HTTP/SSE endpoint; Requesty credentials stay in FC. No nanobot shell or unrestricted filesystem tools were copied.

## Request path

1. Capture the original request, selected model, attachments, workspace and hard source selection. Locally derive the answer language from the request and explicit user language preferences; do not create an intent plan.
2. Run the existing source reconciliation and knowledge invalidation/maintenance. Reuse compatible original evidence, Paper Cards and current wiki revisions. Wiki failures remain pending and are reported without blocking the answer loop.
3. Assemble fresh system instructions, current catalog and source versions, bounded persisted exchanges, original request and attachments. The initial catalog is metadata, not evidence or proof of corpus coverage.
4. Send the context and permitted tools to the selected model. It can answer immediately or request tools. There is no required semantic interpretation, image extraction, web search or classifier call.
5. Validate requested tools against application-owned effects and scopes. FC executes bounded context reads; project evidence/corpus tools return a signed continuation to Electron. Electron executes the registered host operation, then FC appends the corresponding result to the same assistant tool call and resumes the model.
6. Stop at a final answer, cancellation or the existing loop limits. Failed tools produce paired error results. Historical replay never executes tools.

The backend allows eight ordinary model iterations, up to 24 tool calls and a terminal answer attempt. Electron also caps desktop handoffs at 12 rounds. Optional model-requested hosted search is separately capped at three calls. These bounds persist across signed continuations. Tool receipt IDs are deduplicated by ID and exact arguments; conflicting reuse is rejected.

## Project tools and protections

The shared tool contract is `shared/side-chat-tools.js`:

- `retrieve_project_evidence`: searches current in-scope papers and reads bounded original excerpts with stable paper/page/chunk references. It does not regenerate Paper Cards.
- `search_project_knowledge`: reads current compatible Paper Cards, validated wiki pages, clearly unverified saved drafts and locally resolved historical syntheses, retaining their provenance and limitations. It does not treat arbitrary project-memory snippets as selected-paper evidence or regenerate knowledge.
- `run_corpus_workflow`: runs the existing corpus pipeline over every current paper in the host's captured hard selection, or the whole project when there is no selection. It accepts no model-supplied scope or rewritten task.

Corpus processing retains the existing snapshots, compatible Paper Card/map reuse, per-paper mapping, grouping, synthesis, verification, journals and resume behavior. For `帮我总结所有文献，写个综述。`, the original Chinese request and Chinese answer language reach the workflow unchanged. Both summarization and review writing remain requested deliverables.

The host reports analyzed/expected paper counts from the current workflow and source catalog. A recognized explicit all-paper request without a completed corpus workflow receives at most one corrective model continuation and an explicit incomplete-coverage notice. Model-written coverage fields are discarded. Reading a few excerpts cannot certify full coverage. This is a coverage check, not a prerequisite classifier or automatic corpus routing stage.

Hard selection is enforced before reading, including an empty/deleted selection. Explicit tool paper IDs cannot expand it. The host checks workspace/request identity and reconciles again before publishing tool findings; changed source versions invalidate the pending result. Machine-managed wiki metadata and citation validation remain separate from free-form Markdown. Source files and Current Recommendation remain protected by the existing effect registry and confined host APIs, irrespective of model decisions, attachments or history.

## Models and images

The selected model is captured for the turn and its model-backed tools; no silent fallback changes it. Tool and vision support use the same per-model capability resolver, exact supported-model defaults, optional `REQUESTY_MODEL_CAPABILITIES_JSON` overrides, and account-scoped cached Requesty catalog metadata. Unknown support fails closed. The catalog's documented fields are `supports_tool_calling`, `supports_vision` and `supports_web_search`; see [Requesty's model contract](https://docs.requesty.ai/api-reference/endpoint/models-list).

The public Requesty catalog was read on 2026-09-20. It advertises tools and vision for `google/gemma-4-31b-it`, `google/gemini-3.1-flash-lite:flex`, and `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`. This is capability metadata, not proof of account access or successful inference. Gemma's prior successful `json_object` Paper Card compatibility exception remains; this change does not alter the optional semantic endpoint's structured-output validation.

For a compatible model, FC sends the original image bytes and question together in the current main-model user message. Pixels are injected only into the provider request, not the persisted text transcript or signed continuation; continuation bindings include an image digest. The existing local attachment store retains originals for edits. Replay contains an explicit image breadcrumb, not a claim that pixels were reloaded. Unsupported/unconfirmed vision returns `MODEL_IMAGE_CAPABILITY_UNAVAILABLE`; unavailable tools are omitted and any invented tool call is rejected. The separate image-understanding endpoint remains available for legacy/explicit callers, with no new mandatory gate.

## Persistence and diagnostics

Existing visible chat history stays unchanged. Completed and interrupted turns retain model-visible assistant calls, identifiers, arguments and corresponding results in the versioned transcript. Subsequent turns use fresh instructions/catalog plus source-version-checked history. Legacy conversations remain explicitly unverified when their original tool evidence is absent. Interrupted calls receive an unknown-outcome replay receipt and are never retried by replay.

The existing buffer retains 12 recent turns within approximately 600,000 serialized characters, with bounded historical derived summaries (12,000 characters). Replay is bounded at 120,000 characters and retains complete exchanges; compaction does not leave orphaned tool results. Stable identity/version bindings prevent old display handles from resolving to different sources. Changed, deleted or out-of-scope historical evidence is withheld. See [transcript details](sidechat-conversation-transcript.md) for storage/checkpoint compatibility.

Diagnostics distinguish host knowledge preparation, `side-chat.model-selected-tool`, zero-execution historical replay, actual answer/tool provider calls and configuration requests. Signed handoffs preserve cumulative provider counts. Partial maintenance status accompanies fresh context.

## Remaining preprocessing

Source scanning, reconciliation/invalidation, attachment validation, language preference resolution and history assembly are local and still precede the main call. The preserved knowledge maintenance stage can make provider calls for missing/changed Paper Cards or unattempted wiki work authorized by raw-evidence ingestion/change. A missing page, old failure, restart or configuration change does not independently trigger wiki generation; compatible cards are reused. See [the evidence gate and draft contract](sidechat-literature-maintenance.md). Configuration/capability requests may also occur and are not inference calls.

There is no compulsory semantic interpretation or image-to-text request for ordinary Side Chat. Semantic helpers and the endpoint remain for explicit callers and the existing Agent Work path. A model-selected corpus/search tool may itself use existing provider workers when compatible caches are unavailable; those are conditional tool costs.

## Verification and rollout

Regression fixtures exercise the production renderer request wrapper, authenticated FC handler, actual project host tools, signed continuations, paired transcript replay, Chinese answers, original images, real corpus journals/cache reuse and source/page citations. They also cover unavailable capabilities, empty/deleted/out-of-scope selections, sources changing during execution, forged coverage, cancellation, bounded correction and write protection. Existing planner, literature/wiki, persistence and Agent Work regressions remain enabled. Provider responses are fixture responses; no live Requesty inference was performed for this change.

Final checks passed: 826 backend tests; 28 targeted desktop tests, including 53 native Electron UI behavioral assertions; `desktop:prepare`; root and FC check scripts; additional shared/continuation/image syntax checks; and `git diff --check`. The public capability-catalog request and deployed health request were live read-only checks, separate from these inference fixtures.

Build with `npm run desktop:prepare`, run root/FC checks, and run the backend and relevant desktop regressions. `npm --prefix alibaba-fc run sync:shared` must precede packaging the backend. Include the current runtime, `conversation-history.js`, `semantic-input-privacy.js`, updated continuation/image/capability modules and synchronized shared contracts including `side-chat-tools.js`. Previously created deployment archives do not automatically contain these changes.

The configured development FC `/health` was checked on 2026-09-20: it contains the wiki, semantic-planner, transcript and math-validation contracts, but **does not contain `sideChatAgentLoop: direct-tools-v1`**. This change still requires backend deployment. The health response also reports `streamingSupported: false`; intermediate cancellation checkpoints require the existing streaming HTTP adapter/trigger, while buffered requests retain checkpoints returned in completed responses.

Local renderer assets were rebuilt. Reload/restart the development app, or rebuild/reinstall the packaged desktop. Loaded runtime code has not been certified by rebuilding files alone. After rollout, verify the new health contract, then a live Gemma evidence read/follow-up, the Chinese full-corpus review and an original-image question. Compare actual Requesty messages/call roles with the saved paired transcript before claiming production verification.
