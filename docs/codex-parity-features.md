# Plan mode, bug reports, cross-conversation memory and parallel tasks

Status: decisions approved 2026-10-07 on branch `codex/combined_cc`. Implemented in this order; each section records its state.

These follow Codex's implementations in the local `codex/` checkout, adapted to BioDesign's scientific workflows and its local agent loop (`docs/local-agent-loop-migration.md`) and project sandbox (`docs/project-sandbox.md`).

## Decisions

1. **Memory scope:** per project, in `.biodesign/memory/`. It travels with the project folder.
2. **Memory default:** off until enabled for each project, as in Codex (`features`: `memories`, `default_enabled: false`). Extraction and consolidation re-send past conversations to the model, which costs tokens on the user's key.
3. **Commands while planning:** allowed read-only. A plan-mode turn may ask for a project sandbox that reads the project and writes nothing in it.
4. **Bug reports:** saved by the user as a local file to email. There is no storage bucket to upload to.
5. **Parallel tasks:** each Agent Work conversation running alongside others writes only to its own folder under `output/`, the sandbox's equivalent of Codex's per-thread git worktree.
6. **Concurrency:** at most 3 Agent Work turns at once. Side Chat is unaffected.

## 1. Plan mode

Codex reference: `collaboration-mode-templates/templates/plan.md` (mode rules and phases), `tui/src/chatwidget/plan_implementation.rs` ("Implement this plan?" with three answers).

- **Turning it on.** The Agent Work composer has a Mode selector (Default, Plan), saved per conversation and captured per turn like the model and permission. The turn carries `desktopTools.collaborationMode: "plan"`; the loop admits it only for Agent Work.
- **Prompt.** `shared/collaboration-modes.js` holds the plan prompt, adapted from Codex for analysis and experiment planning: ground in the project first (evidence tools, read-only commands), ask decision-changing questions with `request_user_input`, and end with one `<proposed_plan>` block.
- **No changes while planning.** The loop denies source writes (downloads, academic saves), recommendation updates, project-memory updates and external side effects (`authorizeTool`). The renderer hides the memory-saving, patch, image-generation, plugin and generic MCP tools and refuses download and academic writes as a second layer. Evidence reads, source preparation (derived caches), turn notes and subagents stay available.
- **Read-only commands.** `request_permissions` with `project_execution` in plan mode grants a read-only project sandbox: the project is readable except `.biodesign/`, only the turn's private folder is writable, and nothing is recorded because nothing in the project can change. Patches and image generation fail with `PLAN_MODE_READ_ONLY`. The approval text says so.
- **The plan card.** A reply containing `<proposed_plan>` renders the plan as a card. On the latest reply it offers Codex's three choices: implement the plan (switch the conversation to Default and send "Implement the plan."), implement in a new conversation (a fresh Agent Work conversation starting from the plan), or keep planning.
- **State.** Implemented. Tests: `alibaba-fc/test/collaboration-modes.test.js`, the plan-mode cases in `agent-loop-driver.test.js`, `advanced-runtime.test.mjs`, `renderer-agent-loop.test.mjs` and the native `project-sandbox.test.mjs`, and the React workbench fixture (Mode selector, plan card, implementation turn).

## 2. Bug reports

Codex reference: `feedback/` and `tui/src/bottom_pane/feedback_view.rs`. Categories, a note, an explicit list of what is included with logs opt-in, and a report ID; uploaded to Sentry. BioDesign saves the report locally (decision 4).

- **Opening it.** "Report a problem" in the header, or "Report this turn" in a turn's details. Both open the same dialog (`docs/feedback-report.js`).
- **The dialog.** Codex's five categories (bug, bad result, good result, blocked by safety, other), a note, and what to include: Debug Console events and the app log (on by default), and, for a turn report, the conversation's text (off by default). Before saving, the dialog lists exactly what the report will contain and says that keys, tokens and the home folder path are removed and that project files and papers are never included.
- **Saving.** The renderer sends only the user's choices and its own parts over `biodesign:feedback:save`, validated field by field (`validateFeedbackPayload`). The host (`desktop/services/feedback-report.mjs`) adds the app version, platform and diagnostics (project open, turns running, sandbox and Python runtime state), the tail of the main log (512 KB), redacts secrets (`shared/redact-secrets.js`: bearer tokens, JWTs, `sk-`/AWS keys, key/token/secret/password assignments) and replaces the home folder with `~` in every string. Reports stay under 5 MB: the oldest main-log lines go first, then Debug Console events, then the earliest conversation messages.
- **The file.** The user chooses where to save (Downloads by default); the file is `biodesign-report-<id>.json`, mode 0600. The renderer never sees the path: the dialog shows the file name and report ID, and "Show in folder" asks the host to reveal the last saved report. The user attaches it to an email.
- **State.** Implemented. Tests: `desktop/test/feedback-report.test.mjs` and the React workbench fixture (dialog, save, and a check of the saved file's redaction and parts).

## 3. Cross-conversation memory

Codex reference: `memories/README.md` (phase 1 extraction, phase 2 consolidation), `memories/write/templates/memories/`, `ext/memories/templates/memories/read_path.md`.

- **Switch.** Settings → Memory, per project (decision 2). The setting is `.biodesign/memory/settings.json`; everything remembered is under `.biodesign/memory/` (decision 1), which the project sandbox already hides from commands. The tab explains what is remembered, that memories are not evidence, and that turning it on sends past conversations to the model again. It shows how many conversations were processed, the last run and the last error, and offers "Update now", "View memory" and "Forget all" (which keeps the on/off setting).
- **Phase 1: extraction** (`docs/project-memory.js`). A conversation is eligible once it has a user message and a reply, has been idle for 30 minutes, is at most 30 days old, and is not running. Side Chats (all Agent Work panels' stores) and Agent Work conversations both count. Each eligible conversation, newest first, at most 8 per run and 2 at a time, is sent once (up to 60,000 characters) with Codex's stage-one prompt adapted to scientific work: what the user asked for, preferences in their own words, project conventions (units, naming, file layout), decisions, and what failed and why. Results are never evidence, and the model is told to prefer saying nothing. The reply (`conversation_summary`, `slug`, `raw_memory`) is redacted and saved in `stage1/`. A conversation updated later is extracted again. Failures back off from 1 hour to 24 hours.
- **Phase 2: consolidation.** When the set of extracted memories changes, each conversation summary is written to `conversation_summaries/<slug>-<hash>.md`, the raw memories are joined into `raw_memories.md`, and the consolidation prompt rewrites `MEMORY.md` (task groups with keywords) and `memory_summary.md` (a short profile, preferences and general tips, starting with `v1`) from the current files and the new raw memories. Invalid output leaves the previous memory unchanged.
- **Model calls.** Through FC's `/api/model/turn` with the user's session, stages `memory-extraction` and `memory-consolidation`, `response_format: json_object`. Keys stay on FC. A run starts 15 seconds after a project opens (or memory is turned on), runs once at a time, and stops without writing if the project changes.
- **Read path.** Each turn's project context carries `memory_summary.md` (up to 6,000 characters). The loop adds it as a "Project memory" system message, after Codex's read path: use it when the request touches earlier work, preferences or conventions, keep the memory pass to a few steps, re-check facts against their sources, and cite the sources, never the memory. Agent Work and Side Chat get `conversation_memory_search` and `conversation_memory_read` (only `MEMORY.md`, `memory_summary.md` and `conversation_summaries/`) while memory is on.
- **State.** Implemented. Tests: `alibaba-fc/test/project-memory.test.js` (eligibility, redaction, no-op, backoff, invalid output, search and read bounds, forgetting, project change), the memory cases in `agent-loop-driver.test.js` and `desktop/test/runtime-session.test.mjs`, and the React workbench fixture (Memory tab, setting saved in the project).

## 4. Parallel tasks

Codex reference: concurrent threads, `worktree/` (one checkout per thread).

- **How many.** Up to 3 Agent Work turns run at once, each in its own conversation (decision 6). The renderer tracks them by conversation (`runningAgentTurns` in `docs/app.js`) instead of one app-wide flag. A conversation that is running takes more text into its current turn, as before. When 3 are running, the other conversations' composers say so and Send waits; the instruction stays in the composer. Side Chat is not counted.
- **Moving between tasks.** While tasks run, every conversation in the open project can be opened, pinned or started, and the others can also be renamed, forked or deleted. A running conversation can't be renamed, forked, deleted, archived or edited. Anything that would switch to another project waits until the tasks finish: that project's rows, its "New chat", and topic, rename and delete commands on its conversations. Switching projects would abandon the running tasks. Each sidebar row shows its own running dot, and each conversation keeps its own activity, clock and stream. When several tasks ask for approval, their requests stack in the corner instead of covering each other.
- **Keeping output apart** (decision 5). Each conversation gets a folder name once: a slug of its title plus the end of its ID (`plot-titre-against-ph-3f9a2c`), saved with the conversation. The renderer sends it as `taskFolder` to `runtime_advanced_open`; the host validates it. Project grants are decided one at a time:
  - If no other turn can write in the project, the turn writes `output/`, as before, except the reserved `output/agent-tasks/`, where only its own conversation's folder is writable.
  - Otherwise it writes only its folder, `output/agent-tasks/<task>/`. The grant result and `wait_for_environment` say so, and the approval text mentions it. The sandbox profile, file tools and image generation follow it.
  - A turn writing `output/` can never write another conversation's task folder, from its first process on, so a command started before a task began can't overwrite it either. Each turn's record and undo cover only what it can write, so no turn's undo can remove another task's files. Details are in `docs/project-sandbox.md` ("Parallel tasks").
- **Shared resources.** Downloads share the one library browser: a second task that needs it while another holds it gets `BROWSER_BUSY` and reports it. The agent loop, FC model calls and runtime sessions are already per turn.
- **State.** Implemented. Tests:
  - `desktop/test/output-provenance.test.mjs`: grant order, task folders, records and undo kept apart, sequential use unchanged.
  - `desktop/test/project-sandbox.test.mjs`: task paths, profile and file worker; native checks that a task writes only its folder and that no command of a turn writing `output/` can write into it, including one started before the task began and one using another letter case.
  - `renderer-agent-loop.test.mjs`: the folder reaches the host, and the model is told where it may write.
  - The React workbench fixture: three running at once, a fourth waiting with its reason, Side Chat alongside, the sidebar's locks, and the host's validation over IPC.

## 5. Follow-up: output isolation, child budgets, Agent Work history

A review on 2026-10-08 found seven further gaps. All seven were confirmed; three were closed and four deferred.

| Gap | State |
|---|---|
| A command a turn started before a parallel task began could overwrite the task's files | **Fixed.** Task folders moved to the reserved `output/agent-tasks/<task>/`. A turn writing `output/` is denied that folder from its first process on, except its own conversation's folder. Each turn's record, backup and undo cover only what it can write. See "Parallel tasks" in `docs/project-sandbox.md`. |
| A child agent ran on the general turn budget (64 steps, 192 tool calls) instead of its declared 8 and 24 | **Fixed.** `runSideChatAgent` caps a child at the smaller of the turn budget and its declared limits, and the cap is carried across checkpoints and resumes. |
| Agent Work replayed only the last 16 messages, 1,800 characters each | **Fixed.** See below. |
| Shell options (`shell`, `login`, `workdir`, `tty`) and Code Mode's narrower nested tools | Deferred. `/bin/sh` can start other shells and change directory. A login shell would read the user's profile, which the sandbox hides on purpose. Cells don't call download, browser or MCP tools, so they can't multiply side effects outside approval. |
| Subagent model and reasoning overrides, recursion, shell access | Deferred for cost control. Children with shell access would need their own sandboxes. |
| Deferred tool loading, a plugin marketplace, image editing | Deferred. Built-in tool schemas cost about 6,000–8,000 tokens per request without MCP. Revisit with large MCP catalogs. |
| AGENTS.md discovery and configurable lifecycle hooks | Deferred. The project goal, skills and memory already carry standing instructions, and user-configured hooks would run scripts on agent events. |

**Agent Work history.**
- **Storage.** Each Agent Work conversation keeps a canonical transcript at `.biodesign/chat/agents/<conversation>/agent-transcript.json` (`docs/agent-transcripts.js`). It uses Side Chat's format and limits (`shared/conversation-transcript.js`): the last 12 turns in full, including tool calls and results, up to 600,000 characters, with older turns summarised.
- **Turn IDs.** A turn's ID is now its user message's ID, so the transcript, queued input and turn details share one ID.
- **Each turn.** The renderer prepares the transcript and sends it with the request instead of message excerpts. It saves the loop's checkpoints as they stream. A transcript that can't be saved is logged, without failing the turn. If the file can't be read, the turn falls back to excerpts, and the file is left untouched.
- **Existing conversations.** Earlier messages without a stored turn become text-only turns; tool history is never invented.
- **Edits, forks and deletes.** Editing the last message discards the replaced turns. A fork keeps the transcript of the turns it keeps. Deleting a conversation deletes its transcript.
- **Loop.** `request-admission.js` accepts the transcript for Agent Work, and `side-chat-agent.js` replays it (`conversation-history.js`).
- **Replay rules for Agent Work.** Side Chat ties a turn to every source in scope and withholds turns it can't verify. Agent Work turns often depend on no versioned source: they run commands or write output files. So an Agent Work turn binds only the sources it used. A turn that used none is replayed, labelled "no versioned sources, reread files when needed". A turn bound to a source that has changed is still withheld. The `history_*` tools now see earlier Agent Work turns too.

**Tests:**
- `alibaba-fc/test/agent-budget.test.js`: child step and tool-call limits across resumes; the parent keeps the general budget.
- `alibaba-fc/test/agent-transcripts.test.js`: seeding, checkpoints, edits, forks, a damaged file, deletion.
- `alibaba-fc/test/agent-loop-driver.test.js`: an Agent Work follow-up receives earlier commands, results and answers; changed sources stay withheld; nothing is replayed without a transcript.
- `desktop/test/project-sandbox.test.mjs` (native): reproduces the original hole, which now fails as it should.
- `desktop/test/output-provenance.test.mjs`: the reserved folder's records and undo.
- The React workbench fixture: transcripts end to end, including seeding, replay, fork, edit and delete.
