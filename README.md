# BioDesign Copilot

BioDesign Copilot is a local-first, human-in-the-loop workspace for synthetic-biology literature review, evidence interpretation, and planning.

## Architecture

The static frontend is served from `docs/` by GitHub Pages. After the existing login succeeds, the user explicitly selects a writable local project folder. That folder is the persistent source of truth; the browser does not retain its directory handle across restarts.

Alibaba Function Compute remains the authenticated, secret-bearing AI gateway:

```text
GitHub Pages -> user-selected local workspace -> extracted text only -> Function Compute -> Requesty
```

Original PDFs, workspace metadata, project state, literature indexes, and generated summaries remain local. Function Compute receives only bounded extracted or derived text, the AI task, and minimal metadata such as workspace-relative filenames, size, modification time, and page count. It never receives an absolute local path, directory handle, or the selected project folder itself.

## Main files

- `docs/index.html` - login, workspace selection, and workbench structure.
- `docs/styles.css` - responsive visual design.
- `docs/workspace-manager.js` - generic File System Access abstraction, schema validation, initialization, safe JSON writes, and directory lifecycle.
- `docs/source-system.js` - persistent paper/experiment registry, lazy readiness service, preparation locks/jobs, source tools, external result storage, and resumable corpus workflows.
- `docs/literature-module.js` - compatibility adapter for PDF.js extraction and the existing Paper Card generator/cache.
- `docs/project-context-service.js` - bounded progressive source-context construction plus workspace-backed Side Chat persistence.
- `docs/app.js` - UI integration, authentication, Workspace explorer, Side Chat, and workspace lifecycle.
- `alibaba-fc/index.js` - deployed Node 20 Function Compute handler (`index.handler`).
- `alibaba-fc/side-chat-agent.js` - the bounded read-only tool loop shared by Side Chat and Agent Work.
- `worker/` - retained alternate Cloudflare Worker backend.

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

Encrypted, malformed, empty, and image-only/scanned PDFs, malformed workbooks, locked files, and parser failures produce persisted per-source failures without blocking unrelated files. OCR, embeddings, vector search, unit conversion, structured PDF table/figure extraction, cloud sync, and automatic directory-handle restoration remain out of scope. Table/figure search currently searches their extracted text mentions.

## Corpus workflow and result storage

Explicit whole-library synthesis intent (including English and Chinese “all/my literature”, literature-review, major-theme, and overall-findings requests) bypasses normal top-K routing and uses the saved `summarize-paper-corpus` workflow. The snapshot is the selected papers when a paper selection exists, otherwise every eligible project paper—including discovered sources that are not searchable yet. The workflow runs separate snapshot, bounded preparation, per-paper query-specific map, scientific grouping, hierarchical reduction, original-evidence verification, and answer phases. Preparation and mapping default to concurrency 2. Hashing occurs only when a source enters preparation; the same in-memory bytes are passed to PDF parsing. Each mapper receives a fresh bounded object containing only its paper ID, content hash, question, optional cached Paper Card hint, and original evidence handles—never the parent conversation. Journals checkpoint after each source/map/verified claim in `.biodesign/workflows/`; interruption resumes unchanged work, corpus membership changes stale the previous synthesis, and map caches are keyed by source hash plus normalized question, schema, prompt, and model versions.

Large search results, experiment tables, and workflow outputs are saved under `.biodesign/results/`. Tools return a compact preview and result handle. The backend loop retains recent tool results, compacts older consumed results to reopenable instructions, and bounds conversation history while persisted active paper/experiment IDs survive in chat state.

## OSS status

The tested OSS implementation and its legacy endpoints remain in `alibaba-fc/index.js`. `USE_OSS_WORKSPACE_STORAGE` is `false`, no workspace-opening code calls the OSS listing route, and local literature uploads and summaries do not call the OSS upload/review/delete routes. OSS is not required for the local literature flow.

## Local checks

Use a Chromium desktop browser because writable File System Access is required. File access requires a secure context; `localhost` is accepted for development and GitHub Pages is HTTPS.

```bash
cd alibaba-fc
npm ci
npm run check
npm test
```

Serve the frontend from the repository root:

```bash
python3 -m http.server 3000 --directory docs
```

Then open `http://localhost:3000`. Login and AI requests use the `ALIBABA_FC_URL` configured in `docs/app.js`.

## GitHub Pages deployment

1. Set `ALIBABA_FC_URL` in `docs/app.js` to the deployed HTTPS Function Compute endpoint.
2. Push this branch without merging it to `main` until it has been reviewed.
3. In the GitHub repository, open **Settings -> Pages**.
4. Choose **Deploy from a branch**, select the branch to publish, choose `/docs`, and save.
5. Open the published HTTPS URL in Chrome or Edge and run the manual workspace test.

If the repository already uses an Actions-based Pages workflow, keep that workflow and publish the unchanged `docs/` artifact instead.

## Function Compute deployment

The new stateless routes are:

- `POST /api/literature/summarize-chunk`
- `POST /api/literature/synthesize`
- `POST /api/corpus/map-paper`

Both require the existing JWT bearer token. Deployment instructions and legacy OSS endpoint details are in `alibaba-fc/README.md`.

## Workspace Side Chat

The left column has one generic Workspace explorer beneath Project Context. Checkboxes provide multi-file selection, the current context is shown as removable chips above Side Chat, and no selection means **Entire Project**. Project scope uses the saved goal/state, processed paper summaries, and file inventory without pretending that unprocessed files were read.

Side Chat sends bounded recent conversation history, the current question, a compact source map, and only the evidence prepared for that request to the existing authenticated `/chat` endpoint. The full registry, all Paper Cards, parsed PDFs, and experiment tables are never injected. Explicit paper and experiment IDs are hard scopes. With no selection, ordinary questions search already-ready metadata/indexes first and prepare only likely candidates; explicit corpus synthesis prepares the frozen full scope. Coverage records discovered, snapshot-included, prepared, analyzed, failed, and missing papers. The existing Context area shows prepare/map/synthesis/verification progress and the final answer is prefixed with exact analyzed coverage.

Both Side Chat and the existing **Agent instruction → Analyze & Recommend** surface call the same `ProjectContextService`, registry, readiness service, and source tools, then use the same bounded model-driven tool loop. Side Chat keeps its plain answer parser; Agent Work keeps its existing structured recommendation parser. The optional context-router LLM is disabled by default, so unrelated messages make no preparatory source call. The backend tools are read-only over the bounded browser-supplied evidence because Function Compute cannot access the user's local directory.

The complete Project context / goal remains a dedicated durable system message. Internal tool inspection is not copied to persistent chat. Each user message stores a compact source-context snapshot, and the active conversation is restored from `.biodesign/chat/`; **Clear chat** deletes only that conversation. Side Chat still never invokes the Agent Work button or mutates its recommendation panels.
