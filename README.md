# BioDesign Copilot

BioDesign Copilot is a local-first, human-in-the-loop workspace for synthetic-biology literature review, evidence interpretation, and planning.

## Architecture

The static frontend is served from `docs/` by GitHub Pages. After the existing login succeeds, the user explicitly selects a writable local project folder. That folder is the persistent source of truth; the browser does not retain its directory handle across restarts.

Alibaba Function Compute remains the authenticated, secret-bearing AI gateway:

```text
GitHub Pages -> user-selected local workspace -> extracted text only -> Function Compute -> Requesty
```

Original PDFs, workspace metadata, project state, literature indexes, and generated summaries remain local. Function Compute receives only bounded extracted text chunks, the AI task, and minimal metadata such as the filename, size, modification time, and page count. It does not receive an arbitrary local path or the selected project folder.

## Main files

- `docs/index.html` - login, workspace selection, and workbench structure.
- `docs/styles.css` - responsive visual design.
- `docs/workspace-manager.js` - generic File System Access abstraction, schema validation, initialization, safe JSON writes, and directory lifecycle.
- `docs/literature-module.js` - local PDF discovery, stable indexing, PDF.js extraction, bounded map/reduce summarization, and local summary caching.
- `docs/app.js` - UI integration, existing authentication/chat behavior, and workspace lifecycle.
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
    └── cache/
```

Unrelated files in the selected folder are not changed. Malformed managed JSON is preserved and reported rather than replaced with empty state.

## Literature flow

PDFs copied into `literature/` are discovered from lightweight file metadata when the workspace opens or **Refresh Literature** is selected. **Add Literature** copies chosen PDFs into that folder and generates a unique filename on conflict.

On **Summarize**:

1. PDF.js extracts embedded text in the browser.
2. The text is split at paragraph or sentence boundaries into bounded chunks.
3. At most two chunk requests run concurrently through authenticated Function Compute.
4. Function Compute calls the configured Requesty model but persists no project data.
5. A final structured review is written to `.biodesign/literature/summaries/<document-id>.json`.
6. An unchanged PDF reuses that local cache. A modified PDF is marked stale and offers both cache viewing and explicit regeneration.

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

## Current non-literature behavior

The Strain Engineering, Fermentation, and Downstream Processing panels remain available but are not converted into persistent experimental-analysis modules in this milestone. Their uploaded evidence and notes retain the existing session behavior. Side Chat retains its bounded 20-message session history and clear action. Full workspace-backed chat, agent memory, and experiment state are future milestones.
