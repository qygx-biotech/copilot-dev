# Electron Desktop Migration Specification

## Objective

Transform BioDesign Copilot from a browser-hosted application into a packaged Electron desktop application without redesigning the product or changing its scientific, knowledge, authorization, authentication, or recommendation semantics.

The desktop application must preserve the existing HTML/CSS/JavaScript renderer, Alibaba Function Compute backend, account/password authentication, Requesty proxying, QMD Layer 0–4 knowledge architecture, experiment records, corpus workflows, project memory, Side Chat, Agent Command, and Current Recommendation boundary.

This document is the completion contract for the migration. Electron launching in development is not sufficient. Completion requires all acceptance criteria and the packaged-app validation described below.

## Hard invariants

1. Requesty is callable only by Alibaba Function Compute.
2. No Electron main, preload, renderer, utility process, worker, configuration file, package resource, or installer may contain a Requesty credential or a direct Requesty request path.
3. Original project sources and `.biodesign` data remain local and authoritative.
4. The existing UI, DOM structure, CSS, panels, interactions, and login experience remain substantially unchanged.
5. The migration changes runtime, deployment, filesystem access, and process capabilities—not scientific algorithms or product semantics.
6. The Electron renderer remains unprivileged: `nodeIntegration: false`, `contextIsolation: true`, and sandboxing enabled where compatible.
7. Electron production does not depend on `showDirectoryPicker`, `FileSystemDirectoryHandle`, localhost HTTP, a manually started backend, system Node/npm, or Python.
8. Privileged operations are exposed only through a narrow, validated preload API. Raw `ipcRenderer`, `fs`, `child_process`, QMD stores, SQLite connections, shell execution, and secrets are not exposed.

## Target architecture

```text
                        BioDesign Desktop
                               │
               ┌───────────────┴───────────────┐
               │                               │
        Renderer process                  Main process
       existing docs UI                        │
               │                    validated IPC handlers
               │                               │
               │                    ┌──────────┼──────────┐
               │                    │          │          │
               │               Project FS   QMD worker   Jobs
               │                    │          │          │
               │                    └──────────┼──────────┘
               │                               │
               │                       local project folder
               │
               │ HTTPS
               ▼
        Alibaba Function Compute
               ├── account/password authentication
               ├── authenticated search-plan endpoint
               ├── authenticated rerank endpoint
               ├── existing answer-generation endpoints
               └── Requesty and native-PDF calls
```

The only permitted Requesty route is:

```text
Electron → HTTPS → Alibaba FC → Requesty
```

## Baseline architecture to preserve

- Renderer: `docs/index.html`, `docs/styles.css`, and the current plain JavaScript modules.
- Cloud client: existing Alibaba FC URL and request/response contracts.
- Authentication: existing account/password endpoint and bearer-token behavior; validation remains server-side.
- Side Chat: conversational, knowledge-aware, allowed to perform internal-state operations, forbidden from changing Current Recommendation.
- Agent Command: retains the existing result-producing authorization pathway.
- Workspace: `.biodesign/workspace.json`, state, source registry, artifacts, jobs, workflows, results, chat, knowledge, and memory.
- QMD: `@tobilu/qmd@2.8.3`, project-local SQLite/FTS lexical retrieval, optional explicitly enabled vector search, model compatibility metadata, and serialized maintenance. Production Deep uses cloud planning/reranking around local lexical search and never calls QMD's local deep-model operation.
- Literature: lazy hash, PDF.js extraction, page-preserving Markdown, original-evidence verification, optional Paper Cards, and Requesty native-PDF escalation through FC.
- Topics: shallow multi-label DAG with lazy summaries.
- Syntheses: historical, source-versioned, incremental, evidence-linked artifacts.
- Experiments: raw spreadsheets/CSV plus deterministic normalized records; QMD contains descriptors only.
- Corpus workflow: `SNAPSHOT → PREPARE → MAP → GROUP → REDUCE → VERIFY → ANSWER`, with resumability, bounded concurrency, validation, recovery, and incremental reuse.

## Runtime and packaging decisions

The implemented runtime is Electron `44.0.0`, with bundled Node `24.18.1` and Chromium `152.0.7977.54`. QMD's Node `>=22` requirement is therefore met by the application itself. Root development uses Node 22 or 24 (`>=22 <25`) so Electron Forge and its installer helpers share a supported host ABI.

Electron Forge `7.11.2` is the only packaging framework. It builds an ASAR package and uses Electron rebuild plus `@electron-forge/plugin-auto-unpack-natives`. `.node`, `.dylib`, `.so`, and `.dll` files are unpacked. A version-guarded preparation patch translates `sqlite-vec@0.1.9` loadable paths from `app.asar` to `app.asar.unpacked`. Fast and the local stage of Deep pass packaged lexical retrieval without native diagnostics. QMD's optional semantic native dependencies remain packaged for explicit opt-in, but a fresh default run creates or downloads no model weights.

QMD runs in an Electron utility process with one project root established by the main process. SQLite indexing and lexical search therefore do not run in the renderer or main event loop. Cloud planning and reranking stay in the authenticated renderer cloud-client boundary; bearer tokens never cross project IPC. Optional semantic embedding, when explicitly enabled, remains isolated in the utility process and uses the Electron user-data cache. The default application performs no local expansion, reranking, embedding, or model download.

macOS ARM64 is built and executed here. Forge also defines Windows ZIP and Squirrel makers, and all filesystem paths crossing IPC are normalized project-relative POSIX paths; Windows packaging/execution remains structurally configured but was not run on a Windows host.

Python is not required for current functionality and will not be bundled. A structured future execution interface will support a later Python runtime decision.

## Desktop project layout

```text
desktop/
  main/                 Electron lifecycle, window, project sessions
  preload/              contextBridge API only
  ipc/                  schemas and validated IPC handlers
  workers/              QMD and other isolated local work
  services/             ProjectFilesystem, JobManager, execution registry
  test/                 security, filesystem, IPC, lifecycle, packaging tests
docs/                   unchanged renderer UI and compatibility modules
local-backend/           reusable ProjectQmdManager and optional dev/test HTTP adapter
alibaba-fc/              independently deployable cloud backend
```

Files should remain in their current locations unless movement is required for packaging or a clean runtime boundary.

## Renderer and preload contract

The preload bridge must expose a frozen, narrow API conceptually equivalent to:

```text
window.biodesignDesktop.runtime.info()
window.biodesignDesktop.project.open({ initialize })
window.biodesignDesktop.project.close()
window.biodesignDesktop.project.status()
window.biodesignDesktop.files.list({ relativePath })
window.biodesignDesktop.files.stat({ relativePath })
window.biodesignDesktop.files.exists({ relativePath })
window.biodesignDesktop.files.readText/readBinary(...)
window.biodesignDesktop.files.writeText/writeBinary(...)
window.biodesignDesktop.files.mkdir/remove(...)
window.biodesignDesktop.knowledge.initialize/status/update/embed/search/document(...)
window.biodesignDesktop.jobs.start/status/list/cancel(...)
window.biodesignDesktop.execution.listWorkflows/runWorkflow(...)
```

The renderer must never receive Electron IPC primitives directly. Every main-process handler must validate object shape, lengths, enum values, identifiers, and project-relative paths.

## Project filesystem requirements

`ProjectFilesystem` owns the absolute root. The renderer receives a project ID, display name, and workspace metadata—not unrestricted host filesystem capabilities.

Required operations:

```text
list, stat, readText, readBinary, writeText, writeBinary,
mkdir, remove, exists, project status
```

Rules:

- accept project-relative paths only;
- reject absolute paths, `..`, NUL bytes, traversal, symlink escapes, and paths outside the active project;
- preserve atomic/safe-write behavior for managed JSON;
- preserve existing `.biodesign` format so browser-created projects open unchanged;
- select a project once through Electron's native directory dialog;
- close resources and cancel/flush appropriate jobs when switching projects;
- prevent Project A operations from observing Project B.

## Renderer workspace compatibility

Introduce an Electron workspace adapter behind the existing workspace interface rather than scattering filesystem IPC through UI code. Browser compatibility may remain temporarily, but Electron production must select the native adapter and must not call the File System Access API.

The adapter must support existing application expectations including file-like binary reads, directory scans, safe JSON writes, workspace initialization/loading, state persistence, and recursive explorer data.

## QMD integration

Reuse `ProjectQmdManager`; do not duplicate QMD logic or replace QMD.

Production path:

```text
renderer KnowledgeService
  → preload IPC
  → main session/controller
  → QMD utility process
  → ProjectQmdManager
  → <project>/.biodesign/knowledge/qmd/index.sqlite
```

The localhost server may remain for targeted development/tests but is not a production dependency.

The QMD worker must:

- own one store for the active project;
- close it on project switch or app exit;
- preserve six allowlisted collections;
- serialize update/embed maintenance;
- allow bounded lexical searches for Fast and the candidate stage of Deep, plus explicitly optional semantic searches;
- enforce stable paper scopes and project/workspace IDs;
- emit model/index/embed progress, including chunk counts;
- preserve embedding-model compatibility and controlled rebuild semantics;
- isolate SQLite/native work and any explicitly optional semantic model work from renderer/main;
- never accept renderer-supplied collection paths or database paths.

## Layer 0–4 preservation

- **Layer 0:** original PDFs, supplements, workbooks, CSVs, protocols, and files remain authoritative and unchanged by QMD.
- **Layer 1:** lazy, page-preserving evidence Markdown remains derived and QMD-searchable.
- **Layer 2:** Paper Cards remain lazy canonical JSON with model/schema/prompt/source-hash cache identity and separate Markdown mirrors.
- **Layer 3:** topics remain a shallow multi-parent/multi-label DAG; summaries remain lazy and staleable.
- **Layer 4:** synthesis artifacts remain historical, source-versioned, evidence-linked, incrementally updateable, and QMD-indexed.

Opening a project must remain metadata-only. It must not eagerly hash all sources, parse all PDFs/workbooks, embed the corpus, generate Paper Cards, regenerate topics, or rewrite syntheses.

## Jobs and future execution

Add a desktop `JobManager` for privileged long-running local operations. Persist important job/workflow state under `.biodesign/jobs` using statuses:

```text
queued, running, completed, failed, cancelled, stale
```

Each job records ID, type, safe structured inputs, progress, timestamps, compact outputs/handles, and sanitized errors. Existing corpus journals remain the authoritative recovery mechanism for corpus stages.

Add a `LocalExecutionService`/`ScientificJobRunner` registry with structured allowlisted workflows. It must not expose arbitrary shell strings to the renderer or LLM. Initial migration functionality may register no scientific scripts beyond safe internal jobs. Python support remains a documented future runtime decision.

## Cloud, authentication, and secret boundary

- Keep current Alibaba FC endpoints and schemas wherever possible.
- Keep account/password validation in Alibaba FC.
- Keep Requesty API keys and other server secrets exclusively in FC environment/secrets.
- Configure planner and reranker only in FC through `REQUESTY_SEARCH_PLANNER_MODEL` and `REQUESTY_RERANK_MODEL`, falling back to `REQUESTY_MODEL` when absent. Electron receives only opaque configuration signatures for cache invalidation.
- Fast is local `searchLex` only. Deep calls authenticated `GET /api/knowledge/config`, `POST /api/knowledge/plan-search`, local lexical search/fusion, and authenticated `POST /api/knowledge/rerank`, then reconstructs evidence from local candidate objects.
- Planning failure uses the original query. Reranking failure preserves deterministic local fusion and reports `fallback: "local-lexical-fusion"`.
- Cache plan/rank output under the existing project cache conventions using query/intent/scope, candidate IDs and content hashes, source versions, retrieval configuration, opaque model signatures, and prompt/schema versions. Never cache a password, API key, or bearer token.
- Keep native-PDF base64 upload through the existing authenticated FC endpoint.
- Do not bundle `alibaba-fc` server source into desktop application resources except shared non-secret schemas deliberately extracted for that purpose.
- Local QMD/project browsing must remain usable when FC is unavailable; cloud-dependent actions return clear errors.
- Persistent auth tokens must not enter project files, QMD, memory, logs, or plain renderer local storage. Use an OS-backed secure facility when persistent desktop login is required; otherwise retain session-only memory semantics.
- Logs belong in Electron's application log directory and must redact tokens, passwords, keys, and private document bodies.

`shared/retrieval-contract.js` is the canonical request/retrieval contract. It centralizes pre-existing values—20,000-character query, 1,000-character intent, 500 scoped paper IDs, result default/max 10/100, candidate default/max 40/200, 1,200-character snippets, three matched sections, 5,000 characters per evidence source, 360,000 aggregate evidence characters, and 600,000 serialized request characters—without changing their effective behavior. Other scoped limits remain at their existing definitions: conversation/stored-message budgets, corpus mapper concurrency/retries, result externalization previews, native-PDF 20 MiB and review bounds, HTTP retries/timeouts, and response sizes. These are per-operation budgets, not a fixed project-size or corpus-size ceiling.

## UI and behavior parity

Reuse the current `docs` renderer without framework migration. Preserve login, project selection/opening, workspace explorer, literature displays, experiment panels, Side Chat, Agent Command, Current Recommendation, formatting, responsive layout, and interactions.

Desktop-specific changes are limited to native folder selection, privileged operation status, window integration, and secure session/runtime plumbing. Any deliberate visual difference requires documentation and screenshot evidence.

## Packaging and distribution

Provide root-level commands equivalent to:

```text
npm run desktop:dev
npm run desktop:build
npm run desktop:test
```

The packaged application must include Electron's Node runtime, QMD, and required native binaries. End users must not install Node, npm, QMD, a local backend, or Python.

Build validation must include an unpackaged Electron smoke test and a packaged output smoke test. Installer/output paths and platform limitations must be documented. Application updates must remain separate from and never delete user project folders.

## Migration stages

1. Audit current entry points, auth/cloud calls, workspace API, source/knowledge architecture, runtime, dependencies, tests, and secrets.
2. Record a passing baseline.
3. Add the secure Electron shell around the existing renderer.
4. Add preload schemas and validated IPC handlers.
5. Implement native project selection and `ProjectFilesystem`.
6. Add the renderer workspace adapter and remove Electron production dependence on browser directory handles.
7. Move `ProjectQmdManager` behind an isolated worker and Electron KnowledgeService.
8. Add desktop JobManager and allowlisted future execution registry.
9. Verify Side Chat, Agent Command, Current Recommendation, cloud auth, FC, and native-PDF behavior.
10. Add packaging/native-module rebuild configuration.
11. Run parity, security, packaged-app, retrieval, corpus, experiment, and benchmark validation.
12. Mark obsolete web/localhost paths as compatibility/development-only after Electron parity is proven.

## Required tests

### Existing baseline and parity

- all current application/FC tests;
- all QMD manager/SDK tests;
- login success/failure against a mock or existing backend contract;
- unchanged Side Chat and Agent Command effects;
- Current Recommendation unchanged by project open, search, preparation, embedding, corpus synthesis, experiment analysis, memory updates, and QMD rebuild;
- authorized Agent Command can still update recommendation according to existing behavior.

### Electron security

- `nodeIntegration` disabled, context isolation enabled, sandbox configured;
- renderer has no Node globals and cannot `require("fs")` or access `child_process`;
- preload exposes only allowlisted methods and no raw IPC object;
- all IPC payloads are validated;
- absolute paths, traversal, symlink escape, oversized payloads, and unknown collections/workflows are rejected;
- renderer/main/worker/packaged resources contain no Requesty API key or direct Requesty hostname call;
- desktop network mocks fail any direct Requesty attempt while allowing Alibaba FC.

### Project lifecycle

- native open, initialize, close, reopen, and switch;
- existing `.biodesign` projects open without conversion;
- no File System Access API required in Electron;
- one selection establishes both workspace access and QMD root;
- Project A and Project B data/search results remain isolated;
- close/switch flushes state and terminates the old QMD worker.

### Knowledge and workflows

- project open automatically initializes QMD without localhost;
- Fast retrieval works offline with no cloud request and no local model;
- Deep uses authenticated FC planning/reranking, preserves exact identifiers, and validates Chinese→English expansions;
- no production Deep operation initializes or downloads local QMD query expansion, Qwen reranking, or Qwen embedding models;
- cloud payloads follow the shared existing budgets and exclude paths, handles, tokens, unrelated state, and whole PDFs;
- duplicate/hallucinated rank IDs fail closed, omitted candidates retain local order, and cloud failure preserves local lexical evidence;
- project close releases QMD;
- 150-paper ordinary query remains bounded and does not scan 150 Paper Cards;
- 32-paper corpus review analyzes 32, then a 32→36 update maps only four new/changed papers;
- failed-paper retry and restart recovery;
- deterministic experiment normalization/queries and literature+experiment QA;
- Paper Card/topic/synthesis/project-memory behavior and invalidation unchanged.

### Packaging

- native dependencies rebuild for Electron ABI;
- unpackaged Electron development smoke;
- packaged application launches from build output;
- packaged QMD SDK indexes/searches using bundled runtime;
- package does not contain FC secrets or require system Node/npm/QMD/Python;
- macOS validated first; Windows configuration is structurally supported and platform gaps documented.

### Benchmark

Re-run the existing controlled corpus/query set without changing fixtures. Compare legacy lexical, QMD lexical, cloud-planned lexical, cloud-reranked retrieval, and the earlier local semantic/deep baseline where reproducible. Record recall@5, recall@10, evidence recall, exact-identifier and Chinese→English behavior, first/steady latency, FC/Requesty call counts, estimated usage, and fallback behavior. Live network latency/provider usage must be labeled separately from deterministic replay.

## Acceptance checklist

- [x] 1. Electron desktop application exists.
- [x] 2. Existing UI/layout is preserved.
- [x] 3. Existing application logic is preserved.
- [x] 4. Existing scientific algorithms are preserved.
- [x] 5. QMD Layer 0–4 architecture is preserved.
- [x] 6. Experiment architecture is preserved.
- [x] 7. Corpus architecture is preserved.
- [x] 8. Incremental corpus updates work.
- [x] 9. Side Chat semantics work.
- [x] 10. Agent Command semantics work.
- [x] 11. Current Recommendation protection remains.
- [x] 12. Alibaba FC remains the backend.
- [x] 13. Account/password authentication remains in Alibaba FC.
- [x] 14. Requesty calls occur only from Alibaba FC.
- [x] 15. No Requesty API key is packaged in Electron.
- [x] 16. User selects a project folder once.
- [x] 17. Electron obtains local folder access natively.
- [x] 18. Electron production requires no `FileSystemDirectoryHandle`.
- [x] 19. QMD initializes automatically.
- [x] 20. No manually started localhost backend is required.
- [x] 21. Users require no system Node/npm.
- [x] 22. Current functionality requires no system Python.
- [x] 23. QMD native dependencies work in packaged builds.
- [x] 24. Heavy work does not freeze renderer/main.
- [x] 25. Existing resumable jobs/workflows remain resumable.
- [x] 26. Future script execution has a structured allowlisted architecture without unrestricted shell access.
- [x] 27. Project data remains local.
- [x] 28. Requesty native-PDF escalation still flows through Alibaba FC.
- [x] 29. Retrieval benchmarks do not materially regress.
- [x] 30. Existing test suite passes.
- [x] 31. New Electron integration/security tests pass.
- [x] 32. Packaged-app smoke test passes.
- [x] 33. Fast is offline lexical-only and initializes no local model.
- [x] 34. Deep calls only authenticated Alibaba FC planning/reranking endpoints.
- [x] 35. Cloud outputs and payloads use the shared pre-existing budgets.
- [x] 36. Duplicate/hallucinated rankings and cloud failures retain deterministic local evidence.
- [x] 37. Packaged and fresh-extraction smokes pass with an empty model cache.
- [x] 38. Package audit contains no model weights, Requesty path, FC source, or FC secret.
- [ ] 39. Deployed production FC/Requesty credentials and live network latency/usage have been validated.

## Implementation and validation evidence

The cloud-retrieval runtime change is implemented on branch `feature/requesty-cloud-rerank`, created from the existing dirty working tree without resetting or discarding prior Electron/QMD work. The renderer remains `docs/index.html`, `docs/styles.css`, and the existing plain-JavaScript modules. `ElectronWorkspaceManager` and `ElectronQmdKnowledgeService` sit behind the existing high-level renderer interfaces; the compatibility browser and localhost adapters remain available for targeted development only.

The secure desktop boundary consists of:

- a sandboxed `BrowserWindow` with Node integration disabled, context isolation enabled, navigation/window/permission denial, CSP, and runtime Requesty-host blocking;
- a frozen preload bridge with six capability groups and exact channel parity, without raw IPC, filesystem, process, or shell objects;
- validated IPC payloads with key, type, length, enum, identifier, collection, mode, and project-ID checks;
- `ProjectFilesystem` containment with absolute/traversal/backslash/NUL/symlink rejection, bounded reads/writes, atomic managed writes, and one active project;
- an isolated QMD utility process with an allowlisted environment and no renderer-provided root/database paths;
- persisted sanitized desktop jobs and an initially empty structured `LocalExecutionService` registry that rejects arbitrary commands.

`local-backend/src/project-qmd-manager.js` is reused directly by the utility process. Fast and the Deep candidate stage both call lexical `searchLex`; production code never calls QMD's local deep operation. The default Electron service disables semantic embedding and never initializes/downloads QMD expansion, Qwen reranker, or Qwen embedding weights. The package retains the manager and optional-semantic native dependencies, but excludes the localhost server/CLI, local-backend dependency duplicate, Alibaba FC, retired Cloudflare Worker, tests, and build scripts.

Deep retrieves an opaque FC configuration signature, requests a strict plan with only query/intent, validates cross-language expansions and identifiers, performs deterministic repeated lexical search/fusion, and submits only opaque candidate IDs, titles, stable evidence handles, and budgeted snippets for strict FC reranking. Cache identity includes scopes, content/source versions, candidate hashes, model signatures, retrieval configuration, and prompt/schema versions. The renderer reconstructs all returned evidence locally. Planner/ranker failure preserves local lexical evidence.

Validation results:

- `npm test`: 16/16 Electron tests, 130/130 application/Alibaba FC tests, and 7/7 QMD manager/SDK tests passed. Coverage includes authenticated planning/reranking, strict structured output, Chinese→English expansion, shared-budget derivation, privacy filtering, cache invalidation, duplicate/hallucinated IDs, deterministic fallbacks, login/CORS, Side Chat/Agent Command authorization, recommendation protection, native-PDF FC routing, Layer 0–4 invalidation, experiment normalization, the original bounded 150-paper routing fixture, 32-paper mapping, 32→36 incremental mapping of only four papers, failure/retry, and restart recovery.
- Unpackaged Electron smoke: renderer loaded with the existing login visible; bridge keys were exactly `runtime`, `project`, `files`, `knowledge`, `jobs`, and `execution`; renderer `require` and `process` were undefined; sandbox/context isolation were active.
- Real QMD SDK smoke: project-local indexing and lexical retrieval passed under both ordinary Node and Electron's isolated utility process.
- Controlled retrieval rerun, unchanged 11-document/10-query fixture: legacy/QMD lexical recall@5/recall@10/evidence recall were `0.80/0.80/0.70` and `0.20/0.20/0.20`; cloud-planned lexical and cloud-reranked replay were both `1.00/1.00/1.00`, including Chinese→English and exact identifiers. Local orchestration steady p50 was `0.994 ms` planned and `0.981 ms` reranked; this explicitly excludes live network/provider latency. Estimated 10-query cold use was 6,580 input and 1,078 output tokens, 30 FC requests, and 20 Requesty calls.
- The earlier optional local-semantic baseline remains `1.00/1.00/1.00`; a fresh reproduction was not possible because this host's QMD build reported no CPU-only prebuilt and Metal could not allocate an embedding context. Production-path replay required no model.
- Packaged and relocated-ZIP smokes: Electron `44.0.0`, bundled Node `24.18.1`, packaged mode true, Fast marker matched, native diagnostics empty, and zero files resembling local model weights in a newly empty cache.
- Package audit: 6,138 ASAR entries, 41 packaged native binaries, raw sqlite-vec library unpacked, compatibility dependencies/server trees excluded, zero direct Requesty paths, and zero packaged model-weight files. Native dependencies with published platform/architecture prebuilds are consumed directly instead of being recompiled against host Xcode or Visual Studio. Production dependency audits for desktop, Alibaba FC, and local backend each reported zero vulnerabilities.

Final macOS ARM64 outputs:

- `out/make/BioDesign-0.1.2-arm64.dmg` — 217,597,476 bytes; SHA-256 `1436ef7cf0a5bea5293a15fe5a981c5d25c356fc71bd2c265f222dbce5872f9d`.
- `out/make/zip/darwin/arm64/BioDesign-darwin-arm64-0.1.2.zip` — 217,997,839 bytes; SHA-256 `5f7c1276a6ab6f6cf1cd4297aebdf3492ea105aa27b6b3a8c8d9d071b5d84ebc`.

This local build is ad-hoc/unsigned and not notarized. Public macOS distribution requires an Apple Developer identity/notarization, and Windows code signing requires separate signing credentials. The tag-triggered GitHub workflow performs Windows x64 packaging and execution validation on `windows-latest` before it creates a draft prerelease. Live production login/Requesty calls were not made without deployment/account credentials; authenticated FC, Requesty-only, failure, cache, and native-PDF contracts were exercised with repository mocks. Therefore checklist item 39 remains externally blocked and this document does not claim live-cloud completion.

## Final fresh-machine scenario

Before completion, demonstrate or faithfully simulate with packaged output:

```text
Fresh machine
  → install packaged BioDesign desktop application
  → no system Node/npm/QMD/Python required
  → launch application
  → log in using existing Alibaba FC account/password flow
  → select one local project folder through the native dialog
  → QMD initializes automatically for that project
  → ask Side Chat about papers using bounded local retrieval
  → run/resume a corpus review
  → analyze experiment results from structured records
  → perform a Requesty-dependent operation through Alibaba FC
  → observe no direct desktop-to-Requesty request
```

The final ZIP was extracted into a newly created temporary directory and launched from there. The relocated app reported `packaged: true`, exposed no renderer Node globals, displayed the existing login UI, initialized a temporary `.biodesign` project without localhost or system QMD, and completed Fast lexical retrieval with no native diagnostics or model weights in a newly empty cache. The test harness used the development machine's Node only to extract/launch and inspect the result; the launched application used its bundled Node `24.18.1`. Cloud steps were simulated by the passing authenticated FC, Requesty-only, Deep pipeline, fallback, and native-PDF contract tests because no production account credential was supplied.

## Completion evidence and final report

The final report must state the branch, Electron and bundled Node versions, packaging framework, added/changed files, renderer/preload/IPC/project/QMD/job/execution architecture, `local-backend` disposition, Alibaba FC/auth/Requesty boundary, secret audit, UI parity evidence, retrieval/multilingual/corpus/experiment/test results, packaged smoke results, limitations, development/build commands, and installer paths.

Any unrun validation must be identified explicitly. The Goal must not be marked complete while an acceptance criterion remains unverified, except for a genuine external blocker handled according to the Goal blocking rules.
