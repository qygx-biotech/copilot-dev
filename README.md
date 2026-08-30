# BioDesign Copilot

BioDesign Copilot is a local-first, human-in-the-loop workspace for synthetic-biology literature review, evidence interpretation, and planning.

## Architecture

The primary runtime is a packaged Electron desktop application that reuses the existing `docs/` renderer. After the existing login succeeds, the user selects one local project folder with Electron's native directory dialog. That folder is the persistent scientific source of truth; the unprivileged renderer receives only a narrow project-relative filesystem API.

Alibaba Function Compute remains the authenticated, secret-bearing AI gateway:

```text
Electron -> user-selected local workspace -> bounded evidence or on-demand private PDF -> Function Compute -> Requesty
```

Retrieval has two production modes:

- **Fast** is fully offline and runs project-local QMD/SQLite BM25 only. It makes no cloud-planning or reranking call and loads no local model.
- **Deep** asks authenticated Alibaba FC for a structured search plan, runs every validated expansion against local lexical QMD, deterministically fuses candidates, and asks FC to rerank only opaque IDs, titles, stable evidence handles, and budgeted snippets. Evidence is reconstructed from the original local objects before answer generation.

The Deep route is fixed:

```text
Electron renderer -> authenticated Alibaba Function Compute -> Requesty
        ↑                                                      │
        └──────── validated plan/ranking, no document content ─┘

Electron renderer -> preload IPC -> main -> isolated QMD utility -> project-local SQLite BM25
```

Requesty credentials and model names exist only in FC environment variables or secrets. Electron has no Requesty URL or client. Deep sends no absolute path, directory handle, registry, project file, token, whole Paper Card collection, experiment table, or PDF. Candidate count and text follow the existing retrieval/context budgets; project growth is handled by bounded top-K/result handles and the separate coverage-preserving corpus workflow, not a total paper-count ceiling. The existing native-PDF endpoint remains the only explicit whole-PDF route.

## Main files

- `docs/index.html` - login, workspace selection, and workbench structure.
- `docs/styles.css` - responsive visual design.
- `docs/workspace-manager.js` - generic File System Access abstraction, schema validation, initialization, safe JSON writes, and directory lifecycle.
- `docs/knowledge-service.js` - browser-side high-level knowledge abstraction and soft QMD/legacy fallback boundary.
- `docs/source-system.js` - persistent paper/experiment registry, lazy readiness service, preparation locks/jobs, source tools, external result storage, and resumable corpus workflows.
- `docs/literature-module.js` - compatibility adapter for PDF.js extraction and the existing Paper Card generator/cache.
- `docs/project-context-service.js` - bounded progressive source-context construction plus workspace-backed Side Chat persistence.
- `docs/app.js` - UI integration, authentication, Workspace explorer, Side Chat, and workspace lifecycle.
- `desktop/main/` - secure Electron lifecycle, window policy, native picker, and project sessions.
- `desktop/preload/` and `desktop/ipc/` - frozen capability bridge and validated allowlisted IPC.
- `desktop/services/` - confined project filesystem, persisted desktop jobs, and structured execution registry.
- `desktop/workers/` - isolated production QMD runtime; heavy indexing/model work never runs in the renderer or main event loop.
- `alibaba-fc/index.js` - deployed Node 20 Function Compute handler (`index.handler`).
- `alibaba-fc/side-chat-agent.js` - the bounded effect-authorized tool loop shared by Side Chat and Agent Work.
- `local-backend/` - shared `ProjectQmdManager` plus a compatibility-only localhost adapter for targeted browser development/tests.
- `docs/QMD_KNOWLEDGE_ARCHITECTURE.md` - authority, lifecycle, invalidation, model, retrieval, and benchmark design.
- `local-backend/benchmark/REPORT.md` - measured lexical/cloud-replay results plus the historical local-semantic baseline.
- `worker/` - retired Cloudflare endpoint stub; it contains no Requesty client or model configuration.

## Workspace structure

Initialization occurs only after confirmation and creates:

```text
<Project Folder>/
├── literature/
├── experiments/
│   ├── strain-engineering/
│   ├── fermentation/
│   └── downstream-processing/
├── data/
└── .biodesign/
    ├── workspace.json
    ├── state.json
    ├── literature/
    │   ├── index.json
    │   ├── summaries/
    │   └── cache/
    ├── experiments/
    ├── sources/
    │   ├── registry.json
    │   └── artifacts/
    ├── jobs/
    │   └── index.json
    ├── results/
    ├── workflows/
    ├── knowledge/
    │   ├── qmd/
    │   │   ├── index.sqlite
    │   │   └── metadata.json
    │   ├── literature/
    │   ├── paper_cards/
    │   ├── topics/
    │   ├── syntheses/
    │   ├── experiment_notes/
    │   └── memory/
    ├── chat/
    │   ├── index.json
    │   └── conversations/
    └── cache/
```

Unrelated files in the selected folder are not changed. The visible Workspace explorer recursively reflects the actual folder, not a hardcoded module list, and hides `.biodesign`. **Refresh** re-enumerates metadata so changes made in Finder or Explorer appear. Malformed managed JSON is preserved and reported rather than replaced with empty state.

## Unified source lifecycle

Papers under `literature/` and experiment files under `experiments/` share `.biodesign/sources/registry.json`. Each record has a stable source ID, cheap stat signature, content-hash state, explicit parse/index/card/structured-data readiness, versioned artifact associations, last-use timestamps, and a persisted error. The registry schema is version 2.

Workspace open and **Refresh** only enumerate paths and read size, modification time, and a filesystem file ID when the platform exposes one. Reconciliation does not read file bodies, hash, parse, normalize, create Paper Cards, or call an LLM. Deleted sources leave active search and selection immediately. A metadata change marks only that source dirty; a rename retains its ID only when a safe filesystem file ID proves identity.

All source-dependent operations pass through one `ensureSourceReady(sourceIds, capability)` service. Supported capabilities are `catalog`, `stable_snapshot`, `full_text`, `search`, `paper_card`, and `experiment_data`. Per-source jobs are persisted in `.biodesign/jobs/index.json`; concurrent requests share one preparation lock. Jobs left running across an application restart become `stale` and can be retried.

When a paper is materially used for the first time:

1. The service records size and modification time and reads the source once.
2. SHA-256 hashing and PDF.js extraction share those bytes.
3. Size and modification time are checked again before any artifact association is accepted.
4. Pages and bounded chunks are stored under `.biodesign/sources/artifacts/<source-id>/<content-hash>/`.
5. Lexical search returns stable source/page/chunk evidence handles.
6. Unchanged follow-ups reuse the known hash and parsed artifact.

A full hash runs only for an unhashed source, a dirty stat signature, explicit stable-snapshot/verification work, or cache validation. If a timestamp changes but the content hash does not, existing artifacts are revalidated and reused. If content changes, only that source gets a new content version and only the requested capability is rebuilt. If the file changes during processing, the hash/artifact association is rejected.

Paper Cards remain at `.biodesign/literature/summaries/<source-id>.json` for compatibility, but are optional high-level routing notes. They are generated only for an explicit broad summary/comparison or `ensure_paper_card` operation, never on folder open. Precise answers retrieve original parsed evidence even when a card exists. Legacy cards without a content hash are migrated with `validationStatus: "unknown"` and validated lazily rather than regenerated in bulk.

CSV, TSV, TXT, XLS, and XLSX experiment sources are also lazy. Their sheets/rows are normalized into records with raw values, detected biological entities, content version, and source-file/sheet/cell-range provenance. Filtering, group aggregation, and numeric comparison are deterministic; the LLM receives bounded structured records and does not perform hidden numeric transformations.

Encrypted, malformed, empty, and image-only/scanned PDFs, malformed workbooks, locked files, and parser failures produce persisted per-source failures without blocking unrelated files. OCR, unit conversion, structured PDF table/figure extraction, cloud sync, and automatic directory-handle restoration remain out of scope. QMD supplies optional project-local embeddings/vector search; table/figure search still searches their extracted text mentions unless Requesty native PDF is used.

## Corpus workflow and result storage

Explicit whole-library synthesis intent (including English and Chinese “all/my literature”, literature-review, major-theme, and overall-findings requests) bypasses normal top-K routing and uses the saved `summarize-paper-corpus` workflow. The snapshot is the selected papers when a paper selection exists, otherwise every eligible project paper—including discovered sources that are not searchable yet. The workflow runs separate snapshot, bounded preparation, per-paper query-specific map, scientific grouping, hierarchical reduction, original-evidence verification, and answer phases. Preparation and mapping default to concurrency 2. Hashing occurs only when a source enters preparation; the same in-memory bytes are passed to PDF parsing. Each mapper receives a fresh bounded object containing only its paper ID, content hash, question, optional cached Paper Card hint, and original evidence handles—never the parent conversation. Journals checkpoint after each source/map/verified claim in `.biodesign/workflows/`; interruption resumes unchanged work, corpus membership changes stale the previous synthesis, and map caches are keyed by source hash plus normalized question, schema, prompt, and model versions.

Large search results, experiment tables, and workflow outputs are saved under `.biodesign/results/`. Tools return a compact preview and result handle. The backend loop retains recent tool results, compacts older consumed results to reopenable instructions, and bounds conversation history while persisted active paper/experiment IDs survive in chat state.

Native-PDF analyses are also derived, content-hash-addressed artifacts. They are cached by paper hash, normalized task, response schema, prompt version, and model signature; they do not require a Paper Card. Corpus mapping defaults to `balanced`: parsed text first, with native PDF used for a failed structured map or a request that explicitly needs whole-document/layout fidelity. Native results keep stable paper/evidence references and stay out of persistent chat history except for compact handles and previews.

## OSS status

The tested OSS implementation and its legacy endpoints remain in `alibaba-fc/index.js`. `USE_OSS_WORKSPACE_STORAGE` is `false`, no workspace-opening code calls the OSS listing route, and local literature uploads and summaries do not call the OSS upload/review/delete routes. OSS is not required for the local literature flow.

## Desktop development, checks, and packaging

Use Node 22 or 24 for repository development (`package.json` enforces `>=22 <25`), then install dependencies once. End users run the packaged application and do not need Node, npm, QMD, a local server, or Python.

```bash
npm ci
npm run desktop:dev
npm run desktop:test
npm run desktop:package
npm run desktop:smoke:packaged
npm run desktop:build
npm run desktop:smoke:distributable
npm test
```

Electron 44.0.0 bundles Node 24.18.1 and is compatible with QMD's Node `>=22` requirement. Electron Forge 7.11.2 creates the macOS package/DMG and structurally configures Windows ZIP/Squirrel outputs. The latest locally validated macOS ARM64 artifacts are `out/make/BioDesign-0.1.4-arm64.dmg` and `out/make/zip/darwin/arm64/BioDesign-darwin-arm64-0.1.4.zip`. Unsigned local artifacts are suitable for local validation; public distribution still requires Apple/Windows signing credentials and macOS notarization.

Fast QMD works immediately and offline. Cloud-backed Deep requires Internet access and incurs Requesty usage through Alibaba FC, but downloads no local model weights. Search-plan and rerank caches live under `.biodesign/cache/cloud-retrieval/`, contain no credentials, and are invalidated by scope, candidate/evidence hashes, source versions, model signatures, prompt/schema versions, and retrieval configuration. Planning failure falls back to the original lexical query; reranking failure returns deterministic locally fused evidence with `fallback: "local-lexical-fusion"`.

Local semantic embeddings are a separate, explicit opt-in and are disabled in the default app. When enabled for controlled research, EmbeddingGemma remains the default (about 318 MB model storage; prior measured process peak about 1.0 GiB), compatibility metadata still requires a controlled rebuild after model changes, and semantic search may require substantially more memory. It is never required by Fast or cloud-backed Deep.

The packaged application excludes `alibaba-fc/` and `worker/`. Requesty credentials and direct Requesty requests remain exclusively in deployed Alibaba Function Compute. Authentication tokens remain session-only in renderer `sessionStorage` and are never written to project files, QMD, jobs, memory, or desktop logs.

## Browser compatibility development

The previous Chromium/File System Access path remains for compatibility tests and legacy static hosting. The localhost server is not used by Electron production. For a targeted browser/QMD development session, initialize the project once, then run:

```bash
cd local-backend
npm ci
npm start -- --project "/absolute/path/to/project"
```

Then open `http://127.0.0.1:43127`. Login and AI requests use the `ALIBABA_FC_URL` configured in `docs/app.js`. A plain static server remains supported and automatically uses legacy retrieval when QMD is absent:

```bash
python3 -m http.server 3000 --directory docs
```

Inspect or rebuild the project index from `local-backend/`:

```bash
npm run knowledge -- status --project "/absolute/path/to/project"
npm run knowledge -- rebuild --project "/absolute/path/to/project"
npm run knowledge -- rebuild --vectors --force --project "/absolute/path/to/project"
npm test
npm run benchmark -- --fixture --model lexical --output /tmp/cloud-retrieval-benchmark.json
```

Use `--model default` or `--model both` only when explicitly benchmarking optional local embeddings. Add `--cpu` if that native backend can allocate a supported CPU context.

## GitHub Pages deployment

1. Set `ALIBABA_FC_URL` in `docs/app.js` to the deployed HTTPS Function Compute endpoint.
2. Push this branch without merging it to `main` until it has been reviewed.
3. In the GitHub repository, open **Settings -> Pages**.
4. Choose **Deploy from a branch**, select the branch to publish, choose `/docs`, and save.
5. Open the published HTTPS URL in Chrome or Edge and run the manual workspace test.

If the repository already uses an Actions-based Pages workflow, keep that workflow and publish the unchanged `docs/` artifact instead.

## Function Compute deployment

The new stateless routes are:

- `GET /api/knowledge/config`
- `POST /api/knowledge/plan-search`
- `POST /api/knowledge/rerank`
- `POST /api/literature/summarize-chunk`
- `POST /api/literature/synthesize`
- `POST /api/corpus/map-paper`
- `POST /api/literature/analyze-pdf-native`

All require the existing JWT bearer token. Deployment instructions and legacy OSS endpoint details are in `alibaba-fc/README.md`.

## Workspace Side Chat

The left column has one generic Workspace explorer beneath Project Context. Checkboxes provide multi-file selection, the current context is shown as removable chips above Side Chat, and no selection means **Entire Project**. Project scope uses the saved goal/state, processed paper summaries, and file inventory without pretending that unprocessed files were read.

Side Chat sends bounded recent conversation history, the current question, a compact source map, and only the evidence prepared for that request to the existing authenticated `/chat` endpoint. The full registry, all Paper Cards, parsed PDFs, and experiment tables are never injected. Explicit paper and experiment IDs are hard scopes. With no selection, ordinary questions search already-ready metadata/indexes first and prepare only likely candidates; explicit corpus synthesis prepares the frozen full scope. Coverage records discovered, snapshot-included, prepared, analyzed, failed, and missing papers. The existing Context area shows prepare/map/synthesis/verification progress and the final answer is prefixed with exact analyzed coverage.

Both Side Chat and the existing **Agent instruction → Analyze & Recommend** surface call the same `ProjectContextService`, registry, readiness service, and source tools, then use the same bounded model-driven tool loop. Each tool has an effect: informational/internal-state tools are allowed from both surfaces, while official result-producing tools are reserved for Agent Command and destructive/external effects remain denied. Side Chat may therefore prepare sources, update deterministic metadata and compact typed memory, retry workflows, and recover the allowlisted browser analysis coordinator without changing the Current Recommendation. The optional context-router LLM is disabled by default, so unrelated messages make no preparatory source call.

The complete Project context / goal remains a dedicated durable system message. Internal tool inspection is not copied to persistent chat. Typed memory records store compact reusable conclusions and source IDs—not paper text or experiment tables—and are retrieved on demand. Each user message stores a compact source-context snapshot, and the active conversation is restored from `.biodesign/chat/`; **Clear chat** deletes only that conversation. Side Chat still never invokes the Agent Work button or mutates its recommendation panels.
