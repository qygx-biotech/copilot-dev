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
- `docs/literature-module.js` - local PDF discovery, stable indexing, PDF.js extraction, bounded map/reduce summarization, and local summary caching.
- `docs/project-context-service.js` - bounded project/file context construction plus workspace-backed Side Chat persistence.
- `docs/app.js` - UI integration, authentication, Workspace explorer, Side Chat, and workspace lifecycle.
- `alibaba-fc/index.js` - deployed Node 20 Function Compute handler (`index.handler`).
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
    ├── chat/
    │   ├── index.json
    │   └── conversations/
    └── cache/
```

Unrelated files in the selected folder are not changed. The visible Workspace explorer recursively reflects the actual folder, not a hardcoded module list, and hides `.biodesign`. **Refresh** re-enumerates metadata so changes made in Finder or Explorer appear. Malformed managed JSON is preserved and reported rather than replaced with empty state.

## Literature flow

PDFs anywhere in the visible workspace are discovered from lightweight file metadata when the workspace opens or **Refresh** is selected. Merely opening the workspace, expanding a folder, or selecting a PDF never reads or summarizes its contents.

When a Side Chat question requires an unprocessed selected PDF:

1. PDF.js extracts embedded text in the browser.
2. The text is split at paragraph or sentence boundaries into bounded chunks.
3. At most two chunk requests run concurrently through authenticated Function Compute.
4. Function Compute calls the configured Requesty model but persists no project data.
5. A final structured review is written to `.biodesign/literature/summaries/<document-id>.json`.
6. An unchanged PDF reuses that local cache. A modified PDF is marked stale and regenerated when a later question requires its contents.

Detailed questions can re-extract the selected local PDF and send bounded question-relevant excerpts together with the cached summary. Multiple selected PDFs are summarized independently and then synthesized by the existing `/chat` request; entire PDFs are never concatenated into one request.

Encrypted, malformed, empty, and image-only/scanned PDFs fail with controlled messages. OCR, embeddings, RAG, PostgreSQL, cloud sync, and automatic directory-handle restoration are intentionally out of scope.

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

Both require the existing JWT bearer token. Deployment instructions and legacy OSS endpoint details are in `alibaba-fc/README.md`.

## Workspace Side Chat

The left column has one generic Workspace explorer beneath Project Context. Checkboxes provide multi-file selection, the current context is shown as removable chips above Side Chat, and no selection means **Entire Project**. Project scope uses the saved goal/state, processed paper summaries, and file inventory without pretending that unprocessed files were read.

Side Chat sends bounded recent conversation history, the current question, and the context prepared for that turn to the existing authenticated `/chat` endpoint. Each user message stores its own project/file context snapshot. The active conversation is restored from `.biodesign/chat/` when the same workspace is reopened; **Clear chat** deletes only that conversation.

PDF is the only robust content processor in this milestone. Files such as `.xlsx`, `.csv`, `.fasta`, and `.txt` remain first-class visible workspace files, but Side Chat reports them as unsupported rather than inferring their contents. Embeddings, vector search, full RAG, Excel analysis, OCR, cloud sync, and automatic directory-handle restoration remain out of scope.

Side Chat never calls the Agent Work run action and never mutates the current recommendation, agent instruction, or analysis panels. The existing center-column workflow remains the deliberate **Agent instruction → Analyze & Recommend → recommendation** path.
