# Codex capability integration into BioDesign

Branch: `codex/combined`, created from the clean `nanobot/combined` checkout. The integration now includes thirteen utility tools/adapters, six V2-style agent tools, and thirty-three additional JSON tools with scoped execution, state, board and provider adapters. This is a compatible BioDesign adaptation, not full Codex parity. Provider tools remain unavailable without their configured dependencies. No merge, commit, push, deployment, application installation, or user-data migration was performed.

## Source trace and architecture

The behavioral reference is the local checkout, not the tools available to this development chat. Codex assembles built-ins, MCP, dynamic tools and extensions in [spec_plan.rs](/Users/wei/Documents/Columbia%20University/PhD/AI4S/Dev/codex/codex-rs/core/src/tools/spec_plan.rs:123), with core/model/feature selection starting at line 1051. Its [registry](/Users/wei/Documents/Columbia%20University/PhD/AI4S/Dev/codex/codex-rs/core/src/tools/registry.rs) owns dispatch; [context/output conversions](/Users/wei/Documents/Columbia%20University/PhD/AI4S/Dev/codex/codex-rs/core/src/tools/context.rs) distinguish model responses from Code Mode results. Optional host extensions are installed by [app-server extensions](/Users/wei/Documents/Columbia%20University/PhD/AI4S/Dev/codex/codex-rs/app-server/src/extensions.rs).

BioDesign separates model execution, renderer turn/source authority, and registered Electron host workflows. The integration preserves that separation. Since the [local agent loop migration](local-agent-loop-migration.md), the agent loop runs in an Electron utility process and FC only proxies model calls; see [Desktop agent loop](#desktop-agent-loop-local-agent-loop-migration) below:

1. [Shared tool catalog](/Users/wei/Documents/Columbia%20University/PhD/AI4S/Dev/shared/runtime-tools.js) defines bounded JSON schemas and validates arguments. No freeform or namespace support is required from a provider.
2. [Runtime extension envelope](/Users/wei/Documents/Columbia%20University/PhD/AI4S/Dev/shared/runtime-extensions.js) exposes only captured tools applicable to the surface and permission. Existing envelopes without the new field retain their original shape.
3. The agent loop's [dispatch](/Users/wei/Documents/Columbia%20University/PhD/AI4S/Dev/shared/agent/side-chat-agent.js) checks provider tool support, child allowlists, budgets, and inputs before pausing at a step boundary for host tools. [Receipt admission](/Users/wei/Documents/Columbia%20University/PhD/AI4S/Dev/shared/agent/receipt-admission.js) matches each receipt to the original call ID, tool name, and canonical arguments.
4. One [runtime registry](/Users/wei/Documents/Columbia%20University/PhD/AI4S/Dev/docs/runtime-tool-registry.js) per captured [runtime session](/Users/wei/Documents/Columbia%20University/PhD/AI4S/Dev/docs/runtime-session.js) dispatches new tools, existing `read_skill`, existing `spawn`, and captured MCP tools. Duplicate names fail. The existing evidence, academic and library handlers now enter through the same admission registry while retaining their domain result formats and authorization services. Code Mode subcalls use that registry too.
5. Privileged operations remain registered host workflows in [ProjectSessionManager](/Users/wei/Documents/Columbia%20University/PhD/AI4S/Dev/desktop/services/project-session.mjs). Generic MCP retains its own [authorization, validators, queue, cancellation and durable receipts](/Users/wei/Documents/Columbia%20University/PhD/AI4S/Dev/desktop/services/generic-mcp-service.mjs). No model-generated JavaScript executes in Electron main or renderer.
6. [Interaction UI](/Users/wei/Documents/Columbia%20University/PhD/AI4S/Dev/docs/runtime-interaction.js) renders text nodes, plans, and explicit answer controls. [App integration](/Users/wei/Documents/Columbia%20University/PhD/AI4S/Dev/docs/app.js) connects this UI and backend context measurements to the captured session. Structured tool results and UI rendering are separate.

## Capability mapping

“Unavailable dependency” means a real adapter exists but the configured runtime/provider is absent. The user authorized scoped compatible adaptations; the earlier proposed alternatives below are superseded by this implementation.

| Capability | Mapping | Current implementation |
|---|---|---|
| `exec_command`, `write_stdin`, `apply_patch`, `view_image` | Add new, scoped | Real macOS sandbox processes and scratch-only files; explicit turn activation, no project/network/browser access. |
| `exec` / `wait` | Add new | JSON `run_code` / `wait_code`; separate OS process, owned cells, common admission for permitted subcalls. |
| Planning, interaction, clock, context accounting | Reuse earlier additions | `update_plan`, `request_user_input`, `request_user_input_async`, `send_message_to_user_async`, `get_context_remaining`, `clock_curr_time`, `clock_sleep`. |
| `request_permissions` | Merge compatibly | Explicit approval activates scratch within existing Agent Work write authority; does not expand source or network access. |
| `new_context` | Explicitly deferred | User chose checkpoint/evidence-preserving summarization; no fresh-window reset. Proactive policy remains deferred. |
| `wait_for_environment` | Add new | Checks the actual local scratch environment after activation; no remote provisioning claim. |
| `tool_search` | Merge compatibly | Searches schemas advertised in the current model step, including domain and trusted dynamic tools. |
| MCP tools and resource APIs | Reuse existing services | Existing MCP capture, authorization, schema validation, cancellation and journals. Resources/templates remain scoped to connected authorized servers. |
| Host dynamic tools | Add new | Trusted constructor registrations with Ajv schemas, cancellation, receipts; working `host_project_status`. |
| Agent V1/V2 | Approved adaptation | Existing manager; messages, follow-up and interruption within parent turn; close cancels children. No competing registry or V1 lifecycle aliases. |
| `skills.list/read` | Reuse existing | `skills_list/read`, existing enabled skills and read handler. |
| Memory tools | Merge compatibly | Existing typed-memory store, current-source filtering; additions require exact original explicit user memory request. |
| History tools | Merge compatibly | Existing conversation journal projection; revalidate source scope/hash before exposing historical content; never replay calls. |
| Notes tools | Add new | Per-task virtual working notes, expire at parent-turn end; not a second persistent memory store. |
| Agent message board | Add new | Per-parent board, typed handles, subscriptions through existing checkpoint mailboxes; not evidence or an agent registry. |
| `image_gen.imagegen` | Configurable adapter / unavailable dependency | Actual OpenAI-compatible HTTPS image-generation transport, PNG validation, durable generated artifacts and bounded vision previews. No provider configured in this environment. |
| Plugin list/install request | Reuse existing / unavailable dependency | Configured local declarative catalog, existing Apps preview and digest-pinned disabled import with explicit approval. No catalog configured in this environment. |

Codex web/hosted-search, goal tools and internal test tools remain excluded. Existing BioDesign search, project objectives, knowledge, acquisition and browser services remain in place.

## Public contracts for delivered tools

Every call uses `{id, name, args}`. The response is:

```json
{"id":"original-call-id","result":{"ok":true,"runtimeCall":{"name":"tool-name","args":{}},"value":{}}}
```

Failures use `result.ok:false` and `result.error:{code,message}`. Cancellation/expired authority aborts the owning operation instead of fabricating a successful result. Whole receipts are limited to 80,000 characters; oversized results produce an explicit failure, not truncated scientific evidence. Argument envelopes must fit the existing FC 32,000-character admission limit.

The schemas and descriptions are in [runtime-tools.js](/Users/wei/Documents/Columbia%20University/PhD/AI4S/Dev/shared/runtime-tools.js); implementations are in [runtime-session.js](/Users/wei/Documents/Columbia%20University/PhD/AI4S/Dev/docs/runtime-session.js:166). Below, `?` denotes optional input.

| JSON tool | Input | Successful `result.value` / usage |
|---|---|---|
| `clock_curr_time` | `{}` | `{current_time:"YYYY-MM-DD HH:mm:ss UTC"}` |
| `clock_sleep` | `{duration_ms:1..60000}` | `{elapsed_ms,interrupted}`. Monotonic elapsed duration; queued user input interrupts, cancellation rejects. |
| `update_plan` | `{explanation?:string,plan:[{step,status}]}` | `{updated:true,explanation?,plan}`. Status is `pending`, `in_progress`, or `completed`; at most one in progress, at most 50 steps. |
| `skills_list` | `{}` | `{skills:[metadata]}`. Only skills enabled and available at turn creation. |
| `skills_read` | `{name}` | Existing skill metadata plus `body`. Calls the existing service with `forAgent:true`, so later disabling/unavailability is also enforced. |
| `tool_search` | `{query,limit?:1..20}` | `{tools:[function schemas],total}`. Case-insensitive name/description matching; all query words must match. Searches the runtime registry, not every domain tool or a remote marketplace. |
| `get_context_remaining` | `{}` | `{tokens_left:number|null,input_budget_tokens:number|null,estimated_input_tokens,output_reserve_tokens,estimated:true,measured_at}`. Measurement of the last dispatched main-model request, including schemas. Uses existing configured/learned context limits and safety reserve; not a provider quota balance. Before measurement, returns `RUNTIME_CONTEXT_UNAVAILABLE`. |
| `request_user_input` | `{questions:[{id,header,question,options:[{label,description}]}]}` | `{answers:{id:{answers:[string]}}}` or `{answers:{},cancelled:true}`. 1–3 questions, 2–3 choices each, free-text answers allowed. |
| `request_user_input_async` | `{questions:[{title,options?:[string]}]}` | `{accepted:true}` only after the form exists. Later explicit answers enqueue `{request_id,questions,answers}` as user steering. 1–3 questions; up to four outstanding requests. |
| `send_message_to_user_async` | `{message}` | `{accepted:true}` after display. At most 8,000 characters and 30 messages per session. |
| `list_mcp_resources` | `{server?,cursor?}` | `{resources:[{server,uri,description?}],nextCursor?}`. Pages of at most 20, taken from the captured catalog. Cursor bound to this session and server filter. |
| `read_mcp_resource` | `{server,uri}` | Existing MCP envelope `{server,tool,kind,result:{contents:[...]},receipt,evidence}`. Exact match to one captured resource required. Existing host validator and durable receipt path execute the read. |
| `list_mcp_resource_templates` | `{server?,cursor?}` | `{pages:[MCP envelope]}`. Each `result` contains the server’s `resourceTemplates` and optional `nextCursor`; `cursor` requires `server`. Only resource-capable servers with wildcard authorization qualify. Unsupported provider methods fail explicitly. |

The earlier utility tools are root-only. Children retain their read-only domain allowlist and `read_skill`; the new ephemeral board tools are also available within their parent-owned board. MCP adapters require **Agent Work/Command + Full Access** at both exposure and execution. No async answer widens original request authorization, source selection, downloads, or official recommendation authority.

### Lifetimes, cancellation and restart

- Runtime registries and UI belong to one random session ID, captured project ID and turn ID. Closing or aborting cancels waits, questions, and in-flight MCP calls and removes UI. Changing source selection invalidates pending questions. New sessions do not reuse live handles.
- MCP calls keep IDs prefixed with the owning runtime session. Template calls add a server-specific suffix. Existing process/agent/library IDs are not reused as resource cursors or question IDs.
- MCP’s existing host journal records pending before invocation and completed/uncertain afterward. Uncertain effects are not retried automatically, including after restart. Adapter reads and template calls use this same journal and cancellation controller.
- Runtime receipt fingerprints deduplicate identical deliveries and reject changed arguments for the same ID. Receipt admission at each step boundary checks those names and arguments, including the new tools.
- Async answers are acknowledged by the UI only after enqueue succeeds. Queue overflow preserves editable text and shows an error. Unacknowledged injections remain pending until an agent-loop checkpoint acknowledges them. An answer arriving before final checkpoint closure keeps the turn open. Unanswered forms close with the turn; they are not silently answered or replayed after restart.
- Process and cell handles are distinct and owned by a random host session; see the current execution lifecycle below. Native tests exercise isolation, polling, timeouts and cancellation cleanup.

## Decisions and preserved boundaries

- **Execution and paths:** the latest user instruction authorizes compatible sandboxing and scoped access. Implemented isolated scratch execution rather than ambient project/home/network access. No source file transfer or source-writing shell path is provided; source writes and paper acquisition continue through existing authorized domain services.
- **Agent lifecycle:** the user chose parent-turn lifetime with follow-up/interruption during the turn. Existing manager and journals are reused; no cross-turn agent resurrection.
- **Permissions:** scratch approval only activates a capability inside the already selected Agent Work write mode. Changing source authority still requires a new authorized turn. User steering cannot grant that authority.
- **Context:** fresh-window reset was explicitly deferred. Evidence/checkpoint-preserving summarization remains; no proactive threshold policy was added.
- **Academic recovery:** the user approved requiring a new model step between shortlist correction and download. Download authorization and acquisition receipts remain authoritative.
- **Memory/history/notes/board:** current-source projections and turn-owned unverified working state implement the compatible option. No raw access to excluded historical evidence, cross-project state or another parent’s board.

No concrete unresolved incompatibility requiring a new user decision was found for these scoped additions. Broader platform, provider and Codex-parity limitations are listed below rather than hidden behind fallback success.

## Earlier tool-integration verification (before the agent-loop changes)

Focused runtime suite: `node --test desktop/test/runtime-session.test.mjs desktop/test/runtime-turns.test.mjs desktop/test/generic-mcp-service.test.mjs desktop/test/runtime-extension-integration.test.mjs desktop/test/job-execution.test.mjs alibaba-fc/test/runtime-extensions.test.js alibaba-fc/test/context-recovery.test.js` — **87 passed**.

Protected regression suite: knowledge-tool-identity, qmd-knowledge-layers, knowledge-access-audit, preflight-knowledge-sync, saved-knowledge, desktop-download-flow, academic-aggregate-download, literature-specialist, literature-desktop-flow, literature-ownership, literature-workflows — **154 passed**.

Additional checks: `desktop/test/source-download.test.mjs` — **10 passed**; `PLAYWRIGHT_MCP_SMOKE=1 node --test desktop/test/playwright-mcp.test.mjs` — **5 passed**, including real Chrome with temporary profiles; `desktop/test/runtime-interaction-renderer.test.mjs` — **1 passed**, exercising 11 UI behaviors in sandboxed Electron. The shell sandbox initially blocked a loopback test server and Electron launch; these passed outside that shell sandbox without changing installed applications.

Shared asset preparation, renderer build, and `git diff --check` were also run. Provider model calls in automated integration tests use fixtures; no live paid LLM, remote MCP credentials, or image provider was used. Tests cover permission restrictions, schema validation, signed handoffs, output limits, cancellation, background child completion, durable MCP receipts, checkpoint delivery, knowledge invalidation/evidence identity, download authorization/registration, login suppression, browser ownership and reference integrity.

Those are historical test results from the earlier utility integration. The remaining-tool implementation and its newer validation are documented below.


## Agent-loop and context integration (initial integration)

Reference implementations: `codex/codex-rs/core/src/session/turn.rs` (follow-up decisions and `end_turn`), `session/step_context.rs` and `session/step_activation.rs` (captured step settings), `context_manager/normalize.rs` (protocol pairing), `compact.rs` (recent user messages plus summary), `tools/parallel.rs` (shared/exclusive tool admission), and `tools/handlers/multi_agents_v2/` (message, follow-up, interrupt, fork semantics). The V1 handlers were inspected; conflicting close/resume names were not imported.

- **Continuing loop:** `shared/agent/agent-step.js` and `side-chat-agent.js` (originally under `alibaba-fc/`) capture each dispatched request and advertised schema set, including recovery requests. Tool results and explicit `end_turn:false` continue; ordinary text is not assumed to be commentary. The fixed eight-step / 24-tool limits were later replaced by the configurable turn budget in `shared/agent/agent-budget.js` (see the agent loop budget section below). Ordinary work reserves its final step for synthesis; the pre-existing academic path allows eight exploration steps followed by tool-free synthesis. Provider retries and summary calls have their existing separate recovery limits.
- **Per-step context:** the model projection preserves provider metadata, pairs calls/results, removes orphan outputs, and inserts an explicit unknown-outcome receipt for missing results without executing anything. Immutable model/surface/source-authority metadata and context/schema hashes identify the originating request. The loop's turn state retains step metadata. The hashes are diagnostics, not a replacement for host authorization.
- **Reactive summarization:** `alibaba-fc/context-recovery.js` retains canonical system/developer context, whole recent accepted user messages (bounded by available context), a marked historical summary, and the existing unaccepted/pending delta. Existing archive-before-offload, evidence references, source checks and checkpoint semantics remain authoritative. No automatic proactive threshold or fresh-window tool is registered.
- **Approved academic boundary:** correction-only requests cannot also execute an unadvertised download. `STEP_TOOL_NOT_ADVERTISED` records that no tool ran; a subsequent model request can see the repaired shortlist and newly applicable tools. The user explicitly approved the extra call and changed workflow. Existing authorization, accepted-selection checks, acquisition state, signed receipts and library registration still execute.
- **Parallel dispatch:** `docs/runtime-tool-registry.js` admits only `read_skill`, `skills_read`, `skills_list`, `tool_search`, `clock_curr_time`, and `get_context_remaining` concurrently. Exclusive calls wait for prior readers and block later readers. MCP hints do not grant parallel safety. `docs/app.js` batches contiguous runtime calls only after the complete signed FC handoff; download, evidence preparation and browser ownership workflows remain serialized. Results preserve call order; batches drain admitted work before returning failure and do not replay partial effects.
- **Live inputs:** queued user steering and agent messages enter at existing acknowledged checkpoints. Each new request captures its own context/tools, but does not widen source or write authority. A changed host source set blocks child follow-up with `SUBAGENT_SCOPE_CHANGED`; a new authorized turn is required. Disabling a skill still takes effect at the existing host read check. The later scratch activation tool does not widen that captured source authority.

### Added agent contracts

Schemas and validation: `shared/generic-subagent.js`. Exposure: `shared/runtime-extensions.js` and FC `side-chat-agent.js`. Execution: `docs/runtime-session.js` through the existing manager in `docs/generic-subagents.js`. Root-only; children retain their existing read-only tool allowlist, cannot download, invoke generic MCP, or recursively delegate. Every result uses the canonical runtime receipt envelope above.

| JSON tool | Input | `result.value` |
|---|---|---|
| `spawn_agent` | `{task_name,message,fork_turns?:"all"\|"none"\|positive-integer-string}` | `{agent_id,task_name,status}`. Use `list_agents` for run/parent snapshots. Default fork is all validated history; numeric selects whole recent turns. Names are unique lowercase letters/digits/underscore starting with a letter, <=64 chars. |
| `send_message` | `{target,message}` | `{task_name,delivered,queued}`; running/queued tasks receive at checkpoints; idle mailbox does not wake the agent. |
| `followup_task` | `{target,message}` | Idle: `{task_name,agent_id,run_id,status}` for a new bounded run; running: the send-message result. |
| `interrupt_agent` | `{target}` | `{task_name,previous_status,status}` after current-run cancellation and cleanup; retains journal for follow-up. |
| `list_agents` | `{path_prefix?}` | `{agents:[snapshots]}` for reusable agents owned by this parent. |
| `wait_agent` | `{timeout_ms?:1..60000}` | `{reason:"agent_update"\|"user_input"\|"timeout",agents:[snapshots]}`; cancellation rejects; queued results are not consumed. |

Targets accept agent ID, canonical `/root/name`, or relative name. Messages are <=24,000 characters. Fork history over 400,000 characters fails explicitly; it is not silently truncated. Agent IDs remain stable; child run IDs are distinct (`agent-id:run:N`), and completion injection IDs include the run ID to avoid deduplicating later follow-ups. The same manager owns all these handles. Parent close cancels active runs, clears mailboxes and registries, and cleans host child contexts. Reload/restart does not resume these ephemeral agents or replay uncertain effects. Retained child journals are revalidated by the existing conversation-history service before each model run and are not injected wholesale as parent evidence.

### Initial loop validation observed

- `npm --prefix alibaba-fc test`: **1,335 passed, 0 failed**. Includes L0–L4 knowledge identity/readiness/invalidation, context recovery, academic acquisition, specialist protocol/ownership and signed-continuation regressions. Includes the final added child-history regression.
- `node --test desktop/test/runtime-session.test.mjs alibaba-fc/test/conversation-transcript.test.js`: **44 passed, 0 failed**, including the added child-history invalidation, scope-change, wait/cancellation and history-selector tests.
- Focused desktop suite (`runtime-session`, `runtime-dispatch`, `runtime-turns`, `generic-mcp-service`, `runtime-extension-integration`, `job-execution`, `literature-workflows`, `literature-ownership`, `browser-references`, `browser-reference-provenance`, `source-download`, `runtime-interaction-renderer`): **121 passed, 0 failed**. Includes actual Electron interaction fixture and localhost download tests.
- `PLAYWRIGHT_MCP_SMOKE=1 node --test desktop/test/playwright-mcp.test.mjs desktop/test/source-download.test.mjs alibaba-fc/test/streaming.test.js`: **29 passed, 0 failed**, including real Chrome in temporary test profiles. No installed application was changed.
- `node desktop/scripts/sync-renderer-assets.mjs`, `npm run renderer:build`, and `git diff --check` succeeded.

The normal shell sandbox rejected localhost listeners and browser/Electron launch; the relevant suites were rerun with approved local test execution. Provider model calls are controlled fixtures. There was no live same-model quality benchmark, remote MCP credential test, image-provider test, or deployment.

### Why using the same model still does not establish Codex parity

1. BioDesign retains different domain prompts, evidence policies and hard iteration/tool budgets. Codex may continue substantially longer. Subagents remain within the parent turn, read-only, nonrecursive and on the parent model.
2. The default provider uses Chat Completions; a configured Responses adapter now supports completed output items and opaque reasoning continuation. Both reconstruct explicit history. Codex server-side context reuse, native caching and all lifecycle metadata are not reproduced. Identical model names still do not establish identical backend revisions or settings.
3. Host tools run at step boundaries after the complete model response. The completed-call early execution of `host_project_status` described below was removed with the FC loop. Acquisition and browser workflows keep ownership serialization.
4. Compaction remains reactive and model/token estimates differ. No Codex remote compaction service or fresh reset is assumed. Context archives are local files in the open project; the OSS archive adapter described below was removed with the FC loop.
5. The existing receipt, child-history and browser-result limits still apply. Removing the library specialist's 24,000-character model-view clipping does not remove these separate host/transport limits.
6. The new execution tools are scratch-only, macOS-only and disallow child forks, networking and project access. Code Mode cannot invoke domain acquisition/evidence/browser tools, generic MCP, permission escalation or agent lifecycle tools. Provider adapters require configuration; no Codex marketplace or remote provisioning backend is assumed. These restrictions materially change which Codex-style workflows can run.
7. Generic external MCP authorization is still server/tool based in Full Access. It is not a source-level sandbox for arbitrary third-party servers; the integration does not claim that such servers enforce the selected-source rules of the built-in evidence/download/browser services. Resolving that earlier boundary requires a separate capability/permission design.

Fresh reset remains deferred; parent-turn agent lifetime and the extra academic correction step remain as explicitly approved. The following section documents the subsequently authorized compatible tool additions.

## Remaining-tool implementation: contracts and source locations

The public JSON schemas and model descriptions are in [advanced-tools.js](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/shared/advanced-tools.js>). Namespaces use underscores for providers that only support JSON function calls. These are explicitly narrower contracts than the Rust tools; unsupported Codex fields are rejected, not ignored.

All new runtime calls return `{id,result:{ok,runtimeCall:{name,args},value}}` on successful dispatch, or `{id,result:{ok:false,runtimeCall,error:{code,message}}}`. Process/cell execution failure is additionally represented by `value.status:"failed"` and `value.error`; a successful dispatch does not assert the command succeeded. Code Mode receipts include `nestedToolCalls` for the FC budget. Existing domain handlers retain their original evidence/acquisition receipt formats. Text, image and errors are projected separately for model and UI; base64 images are converted to vision messages only for an image-capable model. Oversized delivery fails explicitly, without re-executing effects.

Optional fields below end with `?`. All inputs reject unknown fields. String/collection limits are defined in the shared schema and handler, not delegated to model discretion.

| JSON tool | Public input | Successful `value` / behavior |
|---|---|---|
| `exec_command` | `{cmd,yield_time_ms?,timeout_ms?}` | `{status,process_id,output,exit_code?,stderr?,error?}`. Real `/bin/sh`, scratch cwd, incremental output. |
| `write_stdin` | `{process_id,chars?,terminate?,close_stdin?,yield_time_ms?,output_cursor?,stderr_cursor?}` | Same process snapshot. Empty omission polls; termination kills; wrong owner/type fails. |
| `apply_patch` | `{patch}` | `{applied:[{action,path,moved_to?}],scope:"scratch",source_evidence:false}`. Begin/End Patch add/delete/update/move; validates all hunks first; exact context, ambiguity fails. |
| `view_image` | `{path}` | `{path,content:[{type:"image",mimeType,data}]}`. Scratch-relative PNG/JPEG, bounded decoded preview. |
| `run_code` | `{code,yield_time_ms?,timeout_ms?}` | `{status,cell_id,output,exit_code?,stderr?,error?,value?,content?}`. Async JavaScript; `text(value)` and `await tools.NAME(args)`. |
| `wait_code` | `{cell_id,terminate?,yield_time_ms?,output_cursor?,stderr_cursor?}` | Same cell snapshot, incremental output and permitted subcall execution; no re-evaluation of code. |
| `wait_for_environment` | `{}` | `{status:"ready",environment:"isolated_scratch",network:false,project_access:false,child_processes:false}` only after real environment activation. |
| `request_permissions` | `{reason,capability:"scratch_execution"}` | `{granted,capability,scope?,network?,project_access?}`. Explicit approval/decline; approved scope is this turn. |
| `memories_list` | `{}` | `{memories:[{memory_id,kind,text,sourceIds,status,evidence_status}]}`, at most 50 active scoped records. |
| `memories_read` | `{memory_id}` | One scoped typed-memory record; excluded/missing ID fails. |
| `memories_search` | `{query}` | `{memories:[...]}`, case-insensitive literal search, at most 50. |
| `memories_add_ad_hoc_note` | `{note}` | Existing `projectState.updateMemory` result. Returns the existing typed record (`memoryId`, `kind`, `text`, source/experiment references, status and timestamps). Exact original explicit memory request required; no arbitrary model-authored persistent memory. |
| `history_list_windows` | `{}` | `{windows:[{window_id,status,compacted,evidence_status,item_count}]}` from the captured existing transcript. |
| `history_list_items` | `{window_id,offset?,limit?}` | `{items:[{item_id,role,content}]}`, offset 0+, default 20/max 50. Invalid source bindings produce an explicit withholding message. |
| `history_read_item` | `{window_id,item_id}` | One item, under the same current-source check. |
| `history_search_contents` | `{query,limit?}` | `{items:[{window_id,item_id,role,content}]}`, default 20/max 50, only visible content. |
| `notes_list_files_by_prefix` | `{prefix?}` | `{files:[virtualPath]}` from this task's working notes. |
| `notes_read_file` | `{path,offset?,limit?}` | `{path,total_lines,text,evidence_status:"unverified_working_note"}`, zero-based line offset, default 100/max 500 lines. |
| `notes_search_contents` | `{query}` | `{matches:[{path,text}]}`, literal case-sensitive search. |
| `notes_write_file` | `{path,text}` | `{path,characters,persistence:"parent_turn",evidence_status}`; creates/replaces virtual note. |
| `notes_append_to_file` | `{path,text}` | Same result; appends exact text (no implicit newline), creates missing note. |
| `create_channel` | `{channel_name}` | `{channel_name,channel_id,owner}`; duplicate name fails. |
| `get_channels` | `{query?}` | `{channels:[...]}` scoped to this board. |
| `list_threads` | `{channel_name}` | `{threads:[{thread_id,channel_name}]}`. |
| `search_posts` | `{query,channel_name?}` | `{posts:[post]}`, at most 50 matches. |
| `read_thread` | `{thread_id}` | `{posts:[post]}`; wrong board/missing ID fails. |
| `read_post` | `{message_id}` | `{message_id,thread_id,channel_name,author,text,evidence_status:"untrusted_agent_analysis"}`. |
| `subscribe` | `{channel_name}` | `{subscribed:true,channel_name}`; notifications enter existing checkpoint queue. |
| `unsubscribe` | `{channel_name}` | `{subscribed:false,channel_name}`. |
| `post` | `{text,channel_name?,thread_id?,target_agent?}` | Post plus `notifications:[{subscriber,delivered}]` and optional existing-agent notification status. Requires existing channel or thread; mismatched channel fails. |
| `image_gen_imagegen` | `{prompt}` | `{path,artifact_path,bytes,provider_model,generated:true,evidence_status:"generated_artifact",content?}`. Actual configured provider PNG; original persists, preview is not scientific evidence. |
| `list_available_plugins_to_install` | `{}` | `{plugins:[{plugin_id,...existingAppsPreview}]}` from configured local declarative bundle paths. |
| `request_plugin_install` | `{plugin_id}` | Decline: `{installed:false,declined:true}`. Approval: existing Apps import result; digest checked again; imported capabilities disabled. |

The existing `tool_search({query,limit?})` now searches the full current advertised tool snapshot, including domain schemas. Trusted `host_*` tools carry their own JSON schemas. The working built-in `host_project_status({})` returns `{project,knowledgeWorkerInitialized,projectOpen}`; it reports host state, not evidence readiness. Additional dynamic tools must be installed by trusted host constructor configuration with a definition and real handler; model data cannot register handlers.

### Supporting implementation

- [Runtime session](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/docs/runtime-session.js>): one registry admission, receipt deduplication, advertised-snapshot enforcement, child scoping, explicit confirmation and nested dispatch. [App handoff](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/docs/app.js>) sends existing domain handlers through that admission path.
- [Advanced host service](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/desktop/services/advanced-runtime-service.mjs>): trusted dynamic schema validation, provider transport, existing Apps integration, owned sessions and durable effect journal. Registered workflows and `host_project_status` live in [project-session.mjs](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/desktop/services/project-session.mjs>).
- [Scratch runtime](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/desktop/services/scratch-runtime.mjs>), [patch handler](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/desktop/services/scratch-patch.mjs>), [Code Mode worker](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/desktop/workers/code-cell.cjs>): actual OS isolation, processes/cells, exact patch semantics and RPC. [Image validation/preview](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/desktop/services/runtime-image.mjs>) validates PNG chunks/CRC and uses Electron's decoder for bounded previews.
- [State handlers](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/docs/runtime-state-tools.js>): existing typed-memory/transcript projections, task notes and board. [Project context](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/docs/project-context-service.js>) revalidates current source hashes before historical reads and reuses explicit typed-memory write authorization.
- [Model projection](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/shared/agent/agent-step.js>) converts canonical pixels to vision messages without corrupting stored receipts or tool-call/result groups. [Receipt admission](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/shared/agent/receipt-admission.js>) charges nested attempts against the turn's tool budget. [Interaction UI](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/docs/runtime-interaction.js>) renders approvals, text and images; originals can be saved from the active result panel.

Local Codex references: `core/src/tools/spec_plan.rs` and `registry.rs` for registration/admission; `core/src/tools/handlers/unified_exec.rs` for process/stdin schemas; `core/src/tools/handlers/apply_patch.rs` and `view_image.rs` for editing/media; `tools/src/code_mode.rs` for code/continuation; `core/src/tools/handlers/request_permissions.rs` for explicit permission requests; `ext/memories/src/tools/mod.rs`, `ext/history-notes/src/tools.rs` and `ext/agent-message-board/src/tools/spec.rs` for state/board APIs. These all reside under the local `codex/codex-rs/`. The hosted history/memory/image endpoints were not assumed available or copied as fake local services.

### Availability, ownership and lifetime

- Scratch, images, permission activation, dynamic host tools and plugin operations require Agent Work/Command with `workspace_write` or `full_access`. Execution also requires a successful native sandbox probe and explicit scratch activation. Vision tools additionally require provider image-input support. Side Chat receives neither generic execution nor these write/provider capabilities. Children receive only the existing read capabilities and parent-owned board tools.
- macOS `/usr/bin/sandbox-exec` is the enforced security boundary. Deny-by-default policy permits scratch and installed system runtime libraries; denies project/home/credential reads, network, browser IPC and child process creation. Shell pipelines, forks, login shell and PTY are unsupported. No in-process `eval` of model code runs in Electron main or renderer. Packaged Electron's disabled RunAsNode fuse is preserved.
- Code Mode accepts only captured runtime tools still advertised by the current step. Generic MCP, domain evidence/acquisition/browser tools, agent lifecycle, nested code and permission/plugin grants must be called directly. Subcalls use the same schemas, admission, receipts and budgets. Patch/image reads reject while scratch processes/cells run, preventing a concurrent symlink race.
- `process:<uuid>` and `cell:<uuid>` are distinct host-session handles. `channel:`, `thread:` and `message:` handles belong to one parent board. Agent IDs remain in the existing SubagentManager; no board or host process is treated as an agent.
- Process/cell timeouts default to 60 seconds, max 300 seconds; polls max 10 seconds; four active handles per session. Output caps fail explicitly. Parent cancellation kills owned processes, closes subscriptions and deletes scratch. Concurrent open calls share initialization. Turn restart does not restore live process/cell/board/note handles.
- Host pending receipts are persisted before effects in `.biodesign/runtime/tool-receipts/`; duplicate owner/call ID with matching arguments returns the receipt, changed arguments fail. Pending/uncertain effects are never automatically replayed after restart. Plugin import uses this journal plus existing digest pinning. This is not a guarantee against a model deliberately issuing a new call ID for the same effect.
- Notes survive model compaction within the turn only (32 files, 64,000 characters per file, 256,000 total). Board limits are 32 channels and 128 posts. Both are unverified working state, not L0–L4 evidence or persistent memory. Existing typed memories remain the single persistent memory source; experiment-linked memories are conservatively withheld by this adapter.
- History is a view of captured existing turns/summaries, not a new history store. Source content is withheld unless workspace, source selection, readiness and current version bindings validate. Missing archives are not fabricated. Turns without verifiable source bindings may consequently be unavailable through these tools.

### Configuration and dependencies

A trusted host may set `BIODESIGN_RUNTIME_PROVIDER_CONFIG` to a JSON file:

```json
{
  "image": {
    "endpoint": "https://your-provider.example/v1/images/generations",
    "model": "your-supported-image-model",
    "apiKeyEnv": "YOUR_IMAGE_API_KEY"
  },
  "plugins": [
    { "id": "your-approved-bundle", "path": "project-relative/bundle.json" }
  ]
}
```

The image adapter requires an HTTPS provider accepting `{model,prompt,n:1,response_format:"b64_json"}` and returning `data[0].b64_json` containing a PNG. It sends a Bearer credential from the named host environment variable, denies redirects, bounds streamed output and times out after 60 seconds. It does not silently download returned URLs or claim compatibility with a provider that requires another protocol. Native preview validation precedes artifact persistence. Original generated files persist under `.biodesign/runtime/generated-images/`; they are runtime artifacts, not library papers. No live provider/configuration was present during this task.

The plugin adapter requires catalog entries pointing to valid declarative bundles supported by the existing Apps service. It imports them disabled following an explicit digest-pinned approval. No remote marketplace, executable application installer or automatic MCP/skill enabling is added. No catalog was configured during this task.

Code Mode requires an existing standalone Node executable. `BIODESIGN_SANDBOX_NODE` selects it explicitly; Electron otherwise checks existing `/opt/homebrew/bin/node` and `/usr/local/bin/node`. The exact executable must pass the sandbox probe. A missing runtime, invalid executable, unsupported platform or failed sandbox probe makes execution unavailable. This task installed nothing. Linux/Windows sandbox adapters and remote environment provisioning remain unimplemented.

### Scratch filesystem isolation and nested calls

Scratch patches, image reads and generated-image scratch writes run in `desktop/workers/scratch-files.cjs` under the same deny-by-default OS sandbox as execution. No privileged `ProjectFilesystem` instance points into model-writable scratch. The existing patch parser runs inside that worker; path/symlink checks are defense in depth, with kernel enforcement protecting the actual file access against directory replacement. Files are bounded to 10 MiB. Writes replace an inode atomically rather than overwriting a possibly hard-linked inode.

Each owner has one admission queue shared by process/cell startup and file operations. A file operation rejects with `SCRATCH_BUSY` if any process or cell is active; it never waits for that process to finish. Starts queue behind file operations. Image generation reserves the same lease before contacting its provider. Closing the owner aborts provider work, kills file workers and processes, rejects queued operations and drains the queue before removing scratch. File workers time out after 30 seconds and uncertain operations are not replayed automatically.

`apply_patch`, `view_image` and `image_gen_imagegen` are direct-only tools: Code Mode rejects them with `NESTED_TOOL_DENIED` before host dispatch. Call them after all scratch processes/cells finish. Other permitted nested tools retain the common admission and receipt path. Registry coordinators wait for earlier exclusive operations but do not hold the registry barrier while awaiting nested calls, avoiding recursive-dispatch deadlocks. The native owner queue independently protects scratch throughout asynchronous operations.

### Validation for the remaining tools

Observed, overlapping runs (do not sum these as unique tests):

- `npm --prefix alibaba-fc test`: **1,339 passed, 0 failed**. Includes protected L0–L4 identity/readiness/invalidation, acquisition authorization/recovery, specialist protocol, context/checkpoint regressions and new vision/nested-budget/source-currentness tests.
- Focused desktop/native suite with `BIODESIGN_SANDBOX_TEST=1 PLAYWRIGHT_MCP_SMOKE=1`: **138 passed, 0 failed**. Files: `advanced-runtime`, `scratch-runtime`, `runtime-state-tools`, `runtime-session`, `runtime-dispatch`, `runtime-turns`, `runtime-extension-integration`, `generic-mcp-service`, `job-execution`, `literature-workflows`, `literature-ownership`, `browser-references`, `browser-reference-provenance`, `source-download`, `playwright-mcp`, `runtime-interaction-renderer` under `desktop/test/`.
- After final PNG integrity checks, runtime dependency gating and lifecycle cleanup changes: `BIODESIGN_SANDBOX_TEST=1 node --test desktop/test/advanced-runtime.test.mjs desktop/test/scratch-runtime.test.mjs desktop/test/runtime-interaction-renderer.test.mjs`: **10 passed, 0 failed**. Real macOS sandbox: stdin, owner isolation, project/network/fork denial, timeout and cell cleanup. Real Electron: confirmation UI and native image decoding. Adapter fixtures: actual HTTP request serialization, PNG persistence, provider failure handling, existing Apps import, durable duplicate/uncertain receipt behavior and nested admission.

Native execution, Electron/Chrome and local HTTP regressions needed approved execution outside the enclosing shell sandbox. Controlled model/provider fixtures are not live backend validation. No paid image call, production plugin catalog, packaged release test, live same-model Codex benchmark, deployment or installed application change was performed. Non-macOS execution, unrestricted project shell/editing, arbitrary MCP/domain Code Mode subcalls, image editing, remote marketplace/provisioning and persistent cross-turn notes/agents are explicitly outside this implemented scope.

## Provider, streaming, checkpoint and archive integration (latest changes)

These changes build on the existing loop, registry, agent manager, stores and domain handlers. (The eight-step and 24-tool-call limits referenced at the time were later replaced; see the agent loop budget section below.) Shortlist correction still requires a new model request before downloading. Proactive compaction policy and fresh-window reset remain deferred.

### Provider lifecycle

[provider-lifecycle.js](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/alibaba-fc/provider-lifecycle.js>) adds a configured OpenAI-compatible Responses transport alongside the existing Requesty Chat Completions transport. The actual main and child `requestTurn` path in [index.js](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/alibaba-fc/index.js>) selects it; this is not an unused adapter registration.

- The Responses adapter preserves supported output items in their original order in `provider_context.items`, including message boundaries, phase, annotations, reasoning continuation and function-call identities. Model input replays these items rather than reconstructing them from display text. Structured text/image function outputs remain structured. It requests encrypted reasoning continuation, preserves explicit `end_turn` signals, rejects failed/incomplete responses and uses actual usage metadata. Unsupported item/content formats fail explicitly.
- Provider protocol and capabilities come from trusted configuration, not model-name heuristics. Temperature is omitted unless explicitly supported. Reasoning configuration is passed as configured. Opaque continuation metadata is bound to the API endpoint, native model and reasoning configuration; mismatches fail rather than crossing backends silently. Signed desktop continuations also bind the configured provider profile and credential identity.
- Requesty streaming concatenates fragmented `reasoning_content` without displaying it as assistant text. Native Responses continuation data is stored separately from UI content in the protocol payload, through main-loop, specialist, child, handoff and transcript paths. Display text and derived summaries do not include private reasoning or opaque continuation data. Invalidated source bindings or changed model/protocol context remove unusable protocol history fields. Existing earlier reasoning-only records remain readable; ordering already lost in those records cannot be reconstructed.
- Both transports send explicit history rather than relying on a hidden `previous_response_id` store. Native Responses WebSocket transport, prompt-cache affinity and full Codex server/session semantics are not implemented. Public transcript retention of opaque items is bounded; oversized protocol data fails without truncating a signature.

Trusted server configuration example (`AGENT_PROVIDER_ADAPTERS_JSON`, keyed by an already selectable BioDesign model ID):

```json
{
  "your-biodesign-model-id": {
    "api": "responses",
    "endpoint": "https://your-provider.example/v1/responses",
    "model": "native-provider-model-id",
    "apiKeyEnv": "YOUR_PROVIDER_API_KEY",
    "supportsTools": true,
    "supportsImages": true,
    "supportsTemperature": false,
    "contextWindowTokens": 128000,
    "reasoning": { "effort": "high" }
  }
}
```

This is a protocol contract, not a claim that an arbitrary endpoint/model supports Responses. The host must supply the actual HTTPS endpoint, model and credential. Missing/invalid configured credentials fail explicitly. Existing Requesty account credentials, search paths and default behavior remain unchanged when no adapter is configured. Native Responses credentials and image/tool capabilities are selected before Requesty checks; this path requires no Requesty key or catalog lookup. To enable BioDesign’s existing hosted search on an endpoint that supports it, explicitly set `"webSearch": { "adapter": "responses_web_search" }` in its adapter entry. The existing search stage translates its hosted-search declaration and consumes structured provider citation metadata. Without that adapter, native search remains unavailable. This does not add Codex `web.run` or a new local web tool.

### Completed-call streaming and retry behavior

> **Removed with the FC agent loop (Stage 6 of the [local agent loop migration](local-agent-loop-migration.md)).** Completed-call early execution existed so a host read could start while an FC request was still streaming. In the desktop loop every host tool, `host_project_status` included, runs at the step boundary. Steps 2–4 below describe the removed mechanism; the provider-side Responses item handling (steps 1 and 5) remains.

Local reference: Codex `core/src/session/turn.rs` handles `ResponseEvent::OutputItemDone`, and `core/src/tools/parallel.rs` retains the originating `StepContext` for later tool execution. BioDesign follows those boundaries through:

1. `provider-lifecycle.js` accepts `response.output_item.done` with a completed function item, response/item/call identities and valid full arguments. A parseable argument delta or `function_call_arguments.done` alone never executes a tool. Duplicate items must match exactly; final output must agree with every emitted completed item.
2. `side-chat-agent.js` checked the originating immutable advertised tools, surface, child restrictions and remaining budget. Early execution was limited to `host_project_status`, an independent read backed by the existing advanced host journal.
3. `alibaba-fc/stream-call-ticket.js` signed the exact call, provider identity, step authority, account, project, model and turn. The authenticated SSE event was `tool-ready`. Before admission, the renderer verified its ticket through authenticated `POST /api/runtime/verify-stream-call` with `{ticket,scope}`.
4. `RuntimeSession.executeEarly` entered the same owner checks, live revocation checks, budget, registry and receipt path. The later full handoff returned the same receipt without running the handler again.
5. Interrupted or contradictory streams fail without automatically retrying admitted calls. Parent cancellation aborts verification/provider requests and closes host work. No synthetic successful result replaces an uncertain receipt.

Chat Completions providers retain complete-response dispatch. A Responses endpoint returning buffered JSON also uses complete-response dispatch. The result's `providerCapabilities` reports `api`, `dispatch`, completed-boundary support, reasoning replay and history strategy; native responses also report actual `transport`. Context snapshots expose those capabilities and archive durability through `get_context_remaining`.

Early execution of mutations, Code Mode, generic MCP, downloads, source preparation and shared browser operations was never added; a complete item boundary alone does not establish concurrency or replay safety.

### Parallelism and live authority

[shared/runtime-concurrency.js](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/shared/runtime-concurrency.js>) is the audited concurrency list. It adds task-note reads, board reads and `host_project_status` to the previously admitted utility reads. Note/board mutations remain exclusive barriers: earlier reads finish first, and later reads cannot overtake a mutation. Results retain call IDs and original association. Source preparation, memory/source validation, generic MCP, browser sessions and downloads are serialized. MCP read-only hints do not alter this classification.

At existing checkpoints, [runtime-session.js](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/docs/runtime-session.js>) refreshes enabled skills, connected MCP definitions and captured source validity. Removed or changed MCP schemas are revoked for the rest of the turn rather than silently changing an admitted contract. `runtimeRevokedTools` travels in each boundary reply, is validated and merged monotonically into the loop's turn state, and is removed from the next model tool snapshot. Already-admitted receipts remain associated with their original calls. Discovery omits revoked tools.

A live Agent Work permission reduction aborts the session, the agent-loop turn and owned child/process work. Increasing a UI permission setting does not expand an already captured turn; existing explicit scratch activation remains the supported in-turn grant. User/agent message text cannot alter authority. Parent and child runs share the cancellation chain.

Source refresh reuses `runtimeStateContext` and existing stable-snapshot preparation. A changed/missing captured source cancels the turn with `SOURCE_SCOPE_INVALIDATED`; it does not replace source bytes beneath old evidence bindings. A new authorized turn is needed to prepare that version. This deliberately preserves source identity and citation guarantees rather than providing seamless live source replacement. Current verified context remains available to memory/history reads when the snapshot remains valid.

### Durable context recovery

> **Superseded.** The OSS archive adapter (`alibaba-fc/context-archive-store.js`) was removed with the FC agent loop. The desktop loop keeps one turn in one process and writes archives to the open project's `.biodesign/runtime/context-archives/`, so `archiveDurability` is always `"local_filesystem"`. The description below is historical.

`alibaba-fc/context-archive-store.js` reused the existing OSS client and FC RAM-role credentials when available. Originals are written with private ACLs under `runtime/context-archives/v1/<account-project-hash>/<session>/<content-hash>.txt`, separate from papers and conversation records. Model arguments cannot choose object keys or namespaces.

`ContextRecovery` writes the durable original before publishing a reference or offloading context. A fresh FC instance reads it using the existing signed archive/session references. Local cache and remote content must match the content hash; a corrupt cache can be recovered from OSS, while corrupt/missing durable content fails explicitly. Existing transcript version, evidence bindings, accepted messages, immutable instructions, original authorization, pending exchanges and archive-before-offload behavior remain intact. No historical tool is re-executed by archive recovery.

Dependencies are the existing `OSS_BUCKET`, `OSS_REGION`, `OSS_INTERNAL_ENDPOINT` and FC role credentials. Without them, the original local-filesystem archive path remains in use and reports `archiveDurability:"local_filesystem"`; cold-start availability is not claimed. Configured durable mode reports `"oss"`. This task did not provision a bucket, change its lifecycle policy, deploy credentials or migrate old archives. Retention policy remains an operator/bucket configuration concern.

### Child consistency and validation

The existing SubagentManager remains authoritative. Children and follow-ups use the same provider adapter, context projection, transcript binding checks, step boundaries and checkpoint revocations. Their read-only allowlist and nonrecursive behavior remain enforced, including against malicious native Responses calls. Parent-turn cleanup and interruption semantics are unchanged. Plaintext private reasoning is not added to saved child journals; opaque continuation is retained only where compatible with validated history.

Observed validation for this update:

- Full backend suite: **1,350 passed, 0 failed**. Includes the protected knowledge/download/specialist regressions, public-history privacy boundary, actual FC Responses streaming ticket and continuation path, child Responses restrictions, monotone revocation and existing reactive overflow tests.
- Focused desktop/native suite: **143 passed, 0 failed**. Includes native sandbox/Electron/Playwright tests, runtime cancellation and background completion, existing receipt/checkpoint tests, and new live permission/source invalidation/early deduplication tests.
- Final focused loop/provider/archive/child/live suite after the last refinements: **62 passed, 0 failed**. These overlap the broader runs above.
- Focused adapter/archive/live tests exercise partial JSON without admission, early completed-item execution, contradictory and interrupted streams, cancellation, encrypted metadata replay, account/turn-bound ticket verification, cold archive roots, corruption and remote write failure.
- Renderer/shared asset preparation, renderer build, syntax checks and `git diff --check` succeeded.

Tests used actual execution paths with controlled provider/OSS responses and native local runtimes. No live paid Responses model call, live OSS round trip, cloud cold-start deployment, packaged-app release or same-model Codex quality benchmark was performed. The default Requesty path remains buffered for tools; broad early side-effect execution, other native provider APIs, cross-turn agents, automatic source/permission expansion, proactive compaction and fresh-window reset are not claimed as implemented.

## Image projection and output continuation fixes

Request construction retains structured user content and original attachments alongside tool pixels. Canonical image receipts remain unchanged in storage. In each model request, image descriptors carry `originating_call_id`, `receipt_call_id`, `image_index` and `delivered_as_pixels`. Only the last four eligible PNG/JPEG tool previews (each at most 32,000 base64 characters) are projected into pixels; other descriptors state `TOOL_IMAGE_COUNT_LIMIT`, `IMAGE_DELIVERY_SIZE_LIMIT`, `MODEL_IMAGE_CAPABILITY_UNAVAILABLE` or `INVALID_IMAGE_CONTENT`. Cell media omitted at the receipt boundary reports `CELL_IMAGE_DELIVERY_LIMIT`. Original attachments do not consume the tool-preview allowance. Structured tool content arrays retain their provider-native associations. Delivery means pixels are present in the constructed request, not an assertion that the remote model received or understood them.

Scratch process/cell snapshots retain their owned handle and status after completion. stdout chunks contain at most 16,000 serialized JSON characters, stderr at most 4,000. `output_start`, `output_cursor`, `output_available`, `output_remaining`, `stderr_start`, `stderr_cursor` and `stderr_remaining` describe the retained streams. Cursor offsets count UTF-16 units and never split surrogate pairs; streaming UTF-8 decoding also preserves split multibyte sequences. `write_stdin`/`wait_code` accept explicit cursors for continuation or rereading without rerunning; omitted cursors advance from the last poll. Repeating a receipt ID returns its stored snapshot without advancing again. Invalid cursors fail before stdin writes or termination.

Retention is bounded at 262,144 stdout units and 16,000 stderr units. Excess output sets `output_truncated`/`stderr_truncated` and is discarded without killing a successful process. This is intentionally bounded retention, not unlimited output archival. Handles and unread output expire on parent-turn cleanup or host restart; completed durable receipts remain replayable. No command is rerun to recover lost output. Execution calls must fit 32,000 serialized characters before effects. Bounded host results fit the existing 70,000-character result and 80,000-character renderer receipt limits; runtime handoffs accept up to 180,000 characters for two receipts.

Code Mode return values larger than 8,000 serialized characters are placed in the same retained output stream with `value_delivery:"output_json"`, `value_output_start` and `value_characters`; drain from that offset to recover JSON. Truncation flags apply to these values too. The worker flushes its terminal result before exiting. The renderer rereads a bounded chunk when intermediate nested-tool polls accumulate too much output, preserving completion and continuation instead of replacing the receipt with an oversized-result error.

Offline validation for this fix: 310 focused backend/desktop tests passed, with two native-gated tests skipped in that run; the dedicated native process-output suite separately passed all five tests. The advanced-runtime suite was also rerun with native execution enabled: all five passed, including the two previously skipped cases. These cover actual sandbox execution, Unicode/control escaping, output retention, durable duplicate calls after service reconstruction, cursor polling, cancellation, background completion, and large cell returns. Mocked Chat Completions and Responses requests verify mixed attachments and six tool images. Protected regressions cover knowledge identity, recovery, shortlist correction, acquisition receipts, browser ownership/references and child restrictions. No external service or paid model was contacted.

## Agent loop budget (replaces the fixed eight-step / 24-tool limits)

Codex keeps sampling while the model needs a follow-up (`codex-rs/core/src/session/turn.rs`). BioDesign now does the same within a configurable turn budget in [agent-budget.js](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/shared/agent/agent-budget.js>): 64 steps, 192 tool calls and 30 minutes by default, plus an optional token budget. Configuration is in [the FC README](</Users/wei/Documents/Columbia University/PhD/AI4S/Dev/alibaba-fc/README.md>).

- The budget is resolved by FC (`/api/model/capabilities`) at turn start and held by the loop process for the whole turn. Wall-clock and token bounds span the turn, using the existing `turnUsage` start time and provider-reported usage.
- Reaching any bound still ends with the existing tool-free final synthesis. That synthesis remains the reactive fallback for cheap, small-window or low-quota models; proactive compaction stays deferred. The `loop-budget-exhausted` progress event and the synthesis packet name the stop reason (`step_budget_exhausted`, `tool_budget_exhausted`, `no_observable_progress`, `turn_time_budget_exhausted`, `turn_token_budget_exhausted` or `request_deadline`).
- The desktop loop has no per-request deadline, so a turn no longer pauses at a signed `final:false` checkpoint to resume in a fresh FC request. Each model call is still bounded by its own timeout.
- A step runs at most 64 host tools (`HOST_BATCH_LIMIT` in `shared/agent/local-driver.js`); a later call in the same step returns `HOST_BATCH_LIMIT` with a retry hint instead of `TOOL_BUDGET_EXCEEDED`. (The limit was two receipts per handoff while handoffs crossed FC.)
- The renderer's split-era round guards were removed; admission ceilings in `docs/project-context-service.js` and `docs/runtime-session.js` stay at the largest configurable budget. The loop's budget is authoritative. A Code Mode call still makes at most 24 nested calls.
- Domain budgets are unchanged: academic search/time limits, web-search calls and one-use correction steps.

Validation: `npm --prefix alibaba-fc test` passed 1,463 tests with 0 failures, including the new `test/agent-budget.test.js`. Tests that check budget exhaustion now pin `{maxSteps: 8, maxToolCalls: 24}` explicitly. The desktop suite passed 317 tests with 20 native-gated skips. Its single failure, the Side Chat Electron renderer fixture, also fails on the unmodified tree. No live model call or deployment was performed.

## Desktop agent loop (local agent loop migration)

The agent loop moved from the FC `/chat` handler into the desktop app; the staged plan and parity record are in [local-agent-loop-migration.md](local-agent-loop-migration.md). The loop code is unchanged in substance: `shared/agent/` holds the same step, budget, context-recovery, receipt-admission and specialist modules that FC used to run.

- **Where it runs.** `desktop/services/agent-loop-service.mjs` (main) starts `desktop/workers/agent-loop-worker.mjs` in an Electron utility process. The worker runs `shared/agent/local-driver.js` for each turn. The renderer reaches it through the preload `biodesignDesktop.agent` API (`start`, `respond`, `cancel`, `onEvent`) and sees the turn through `docs/local-agent-transport.js`.
- **Model calls.** Each step is one authenticated `POST /api/model/turn` to FC, which holds the provider keys and returns the provider's result. `POST /api/model/capabilities` resolves the model, its capabilities, the `CONTEXT_*` policy and the `AGENT_*` budget once per turn. No provider URL or key reaches the desktop.
- **Step boundaries.** When the model calls host tools, or a runtime checkpoint is due, the worker posts a `boundary` event. The renderer runs the tools through the existing runtime session, registry and host workflows, then answers with receipts, queued input, revoked tools and its current workspace context. Receipts are admitted against the original calls exactly as before. The turn's state never leaves the worker, so nothing is signed, ticketed or round-tripped through FC.
- **Removed with the FC loop.** The `/chat` agent-loop path, signed continuations (`agent-continuation.js`), completed-call tickets (`stream-call-ticket.js`, `/api/runtime/verify-stream-call`, `RuntimeSession.executeEarly`), desktop-handoff validation, the OSS context-archive adapter, FC chat timing, and the renderer's round guards. The 300-second FC request deadline no longer bounds a turn; it bounds each proxied model call.
- **Kept on FC.** Login and sessions, beta-user key resolution, the model proxy and its usage ledger, Deep retrieval planning/reranking, Paper Card and native-PDF endpoints, corpus mapping, image understanding, transcription, source fetching and the OSS document endpoints.
- **Requirement.** Side Chat and Agent Work need the desktop app with a project folder open. The browser-compatibility build reports `DESKTOP_APP_REQUIRED` instead of falling back to FC.
