# Side Chat conversation transcript

The [direct agent-loop update](sidechat-direct-agent-loop.md) retains this persistence contract and supersedes this document's earlier mandatory semantic-preparation path and deployment snapshot.

Implemented on `nanobot/sidechat`, 2026-09-20. This change preserves the visible conversation schema, five literature layers, semantic planner, selected model, five-minute wiki maintenance budget, and existing source/recommendation write authorization.

## Comparison with local nanobot

`nanobot/nanobot/agent/loop.py::_save_turn` commits only the new turn, preserves assistant tool calls and their results, excludes orphan/duplicate results, and keeps an assistant whose text is empty when it contains calls. `session/manager.py::get_history` reconstructs protocol fields and selects a legal, bounded history boundary. `agent/context.py::build_transcript` surrounds that history with a fresh system prompt and appends the current message separately. Its summary checkpoints archive an older prefix.

Side Chat previously stored primarily visible user/assistant messages. Both `boundedMessages` in the context service and `sanitizeChatMessagesForLlm` in FC omitted tool messages; the latter also removed tool-call fields. The loop retained its evidence only until the HTTP move ended. A later question could therefore receive a previous conclusion without the original tool evidence.

The visible `messages` array remains for rendering and semantic interpretation. A separate, versioned `transcript` field in the same per-panel conversation JSON stores recent model-facing exchanges. No new database or permissions are introduced. Fresh source reconciliation, knowledge invalidation, semantic planning, and corpus preparation still run before the transcript is replayed to the answer loop.

## Persistence and recovery

Each transcript turn records the user message ID, selected model, workspace ID, sequence number, timestamps, completion status, assistant messages, local function calls/arguments, corresponding tool results, and source/artifact identity/version bindings. Opaque local provider signatures are retained; private reasoning text is excluded. Hosted provider invocations are stored and converted to explicitly labeled historical data on replay, never local executable functions.

FC emits `transcript` checkpoints before model requests/tool dispatch, after each result, and on completion. Large checkpoints send a full initial snapshot followed by sequence-checked message suffix patches to keep stream traffic bounded; the client reconstructs a full turn before persisting it. FC also includes the latest host-owned `conversationTurn` in JSON responses and evidence-recovery handoffs. Model-written fields with those names are removed. The renderer awaits checkpoint persistence through the existing serialized workspace chat store. Sequence checks protect against duplicate/outdated events and stale autosaves. Editing a question tombstones its old transcript turn; a late event cannot restore it. Forks retain independent copies of the transcript. Background checkpoint writes cannot activate an old chat or recreate an evicted one.

An interrupted turn remains recorded. Replay synthesizes an explicitly unknown outcome for any call whose result never arrived, preserving the protocol pair without asserting success or reexecuting the call. Failed results are stored. Signed desktop continuation handling remains separate: only the existing authenticated continuation route can accept actual desktop results and continue execution. Historical transcript data cannot trigger that route. Evidence recovery retains one current-turn journal and cumulative call budget.

Old conversation files load unchanged. Their available text is migrated in memory as `legacy_unverified_no_tool_evidence`; absent tool results are never invented. Older backends that return no transcript remain usable, but their final answer is recorded as legacy unverified history. Such a backend needs updating to provide full tool persistence.

## Identity, provenance and bounded replay

New catalog handles combine a turn namespace with a digest of the stable item identity, so catalog reordering within a turn does not change a handle and an old handle cannot target an unrelated current `local:1`. Bindings retain stable source IDs, artifact identities, and versions. Current paper reads use stable paper IDs. Old display citation handles are labeled historical rather than reused as current links. Original page/chunk references still pass through the existing current citation registry and source/page navigation.

Before replay, bindings are checked against the reconciled source catalog and current hard scope. Changed, deleted, dirty, missing, out-of-scope, and unverifiable evidence causes historical findings and tool arguments to be withheld with an explicit invalidation marker. An artifact's saved content/provenance fingerprint must also match. A matching source version does not certify a prior assistant interpretation. Fresh instructions require relevant evidence to be reread when needed and prohibit treating history as permissions or current scientific proof. Restoring history performs no Paper Card or wiki generation.

The persisted recent buffer keeps at most 12 turns and approximately 600,000 serialized characters. Older turns become bounded extractive summaries with provenance, explicitly labeled historical derived context. Summary storage is capped at 12,000 characters. Individual stored message text is capped at 64,000 characters with an omission notice for tool output. Oversized provenance fails closed instead of silently certifying incomplete dependencies.

Replay has a 120,000-character ceiling and shares the existing active-loop context budget. It retains recent complete exchanges and summarizes/omits older exchanges atomically, without leaving orphan results. This compaction is local and adds no provider calls. Call IDs are retained unless historical collisions require consistent renaming of a call and its result. Provider signatures are not reused when the model, arguments, or corresponding identifiers change.

Diagnostics separate `hostPreparationCapabilities`, `modelToolCapabilities`, `historicalReplay` counts, and actual `cloudCalls.answer`. Runtime events identify host preparation, replay (zero execution/provider calls), and backend model calls. The legacy `capabilitiesUsed` aggregate remains for compatibility. Configuration requests continue to use their existing configuration diagnostics; they are not counted as answer-model calls.

## Verification and deployment

Regression coverage includes Chinese questions and answers with English paper evidence, page-17 citation resolution, multi-turn tool replay, parallel/failed/interrupted calls, restart recovery through the real conversation store, stale autosaves, forks/edits, legacy migration, handle reordering/collisions, scope/version invalidation, compaction, provider signatures, and authenticated FC/SSE serialization. Existing literature, wiki, semantic-planner, evidence-recovery, desktop continuation, and write-protection suites are also run. Provider responses in these tests are fixtures; they do not verify live Requesty behavior.

Validation completed: the final full FC regression run passed 809 tests; desktop history/adapter tests passed 27. Coverage includes streamed checkpoint patches, reuse when only a current source hash is present, and invalidation of changed corpus artifact revisions. `desktop:prepare`, root and FC check scripts, direct syntax checks for both new modules, and `git diff --check` passed. These checks exercise real local storage, serialization, protocol validation and the host loop with fixture provider responses.

The configured development FC endpoint was checked directly on 2026-09-20. `/health` reported `literatureWiki: literature-wiki-markdown-v2` and `semanticPlanner: model-capabilities-v2`, but no `conversationTranscript` contract. It reported `streamingSupported: false`. This transcript change has **not** been deployed or live-tested against Requesty.

Deployment must include the updated FC runtime files, new `conversation-history.js`, and synchronized `shared/conversation-transcript.js`/`shared/event-stream.js`. Run `npm --prefix alibaba-fc run sync:shared` before packaging. The updated health response must include `runtimeContracts.conversationTranscript: 1`. For checkpoint delivery during a running turn, deploy the existing `src/index.js` streaming HTTP adapter/custom-runtime bootstrap and ensure the FC trigger forwards streaming responses. A buffered `index.handler` response retains completed transcripts but cannot deliver intermediate checkpoints before cancellation or connection loss; this limitation cannot be repaired solely in the Electron client.

`npm run desktop:prepare` builds the updated renderer assets. Reload/restart the development Electron app, or rebuild/reinstall a packaged app. The running process was confirmed to launch this checkout with `electron-forge start`; its loaded renderer was not certified as updated. No running app was restarted, no deployment was performed, and no credentials or source documents were modified.

After deployment/reload, verify a live selected-model read followed by a Chinese follow-up, inspect the saved transcript and Requesty request for the matching tool/result pair, cancel after a streamed tool result and reopen the chat, and repeat after changing/deleting a source. Confirm actual calls and current citations in Requesty before considering production behavior verified. Transcript persistence addresses lost evidence history; it does not prove that every model-generated scientific claim is correct.
