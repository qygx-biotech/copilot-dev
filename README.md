# BioDesign Copilot

A static investor-demo frontend for **BioDesign Copilot**, an AI design-review copilot concept for synthetic biology teams.

## Files

- `docs/index.html` - GitHub Pages frontend structure and content.
- `docs/styles.css` - Responsive polished demo styling.
- `docs/app.js` - Frontend chat behavior, mock fallback, project-panel updates, and Markdown export.
- `worker/` - Cloudflare Worker backend.
- `alibaba-fc/` - Experimental Alibaba Function Compute backend proxy.

## Deployment Layout

The frontend is served from `docs/` using GitHub Pages.

The backend Worker lives in `worker/`.

The frontend calls the deployed Cloudflare Worker URL from `docs/app.js`.

## China-Accessible Backend Experiment

`alibaba-fc/` is an experimental backend proxy for teammates in China. It provides an alternative path from the GitHub Pages frontend to Requesty through an Alibaba Cloud Function Compute HTTP endpoint.

The Requesty API key must be stored as an Alibaba Function Compute environment variable, not in the frontend. To test this route, paste the deployed Alibaba HTTP endpoint into `docs/app.js` as `ALIBABA_FC_URL` and temporarily set `BACKEND_PROVIDER = "alibaba"`.

## Reference File Upload MVP

The frontend supports attaching local reference files per page session:

- `.pdf`
- `.txt`
- `.csv`
- `.xlsx`
- `.xls`

Files are parsed locally in the browser. Raw files are not uploaded, stored, or written to a database or storage bucket. When the user sends a chat message, the app sends only extracted text snippets plus lightweight metadata such as filename, MIME type, character counts, and truncation status.

Per-file upload size is limited to 5 MB. Extracted text is capped per file and capped across the full request, so this is not a full RAG system yet. It is a lightweight context-passing MVP for lab reports, spreadsheets, notes, and literature PDFs.

## BioDesign Workbench layout

After login, the frontend opens a simpler evidence-driven BioDesign Workbench for human-in-the-loop synthetic-biology planning.

- Optional project context: one freeform field for plain-language goals, questions, and messy project framing.
- Literature/reference uploads: add PDFs, notes, CSVs, Excel files, and text references. Files are parsed locally in the browser and shown with filename, type, extracted character count, and remove controls.
- Experimental results modules: add batches of Excel, CSV, PDF, or TXT result files plus informal notes inside Strain Engineering, Fermentation, or Downstream Processing modules.
- One main action: **Analyze & Recommend** sends `mode: "agent_instruction"` to the existing `/chat` endpoint and updates the Current Recommendation panel.
- Side chat for questions: sends `mode: "side_chat"` and answers in the side panel without changing the current recommendation.
- Current recommendation output: shows Current Interpretation, Key Evidence Used, Cross-Module Assessment, Recommended Next Step, Module Most Relevant to Next Step, Missing Information, Human Review Notes, and Draft Summary.

Current limitation: the workbench uses frontend/session state only. There is no persistent cloud workspace, database, or permanent file storage yet.

## Experimental Results Modules

The Experimental Results panel is split into three synthetic-biology development modules:

- **Strain Engineering**: genetic design, construct screening, strain comparison, pathway engineering, enzyme variants, and expression data.
- **Fermentation**: cultivation runs, media conditions, growth curves, titer/yield/productivity data, and time-course measurements.
- **Downstream Processing**: separation, purification, extraction, recovery, product quality, process loss, and analytics.

Each module supports independent uploads, file cards, remove controls, clear-all file actions, optional notes, and note cards. Files are parsed locally in the browser using the same PDF/text/CSV/Excel extraction flow as the literature panel. The MVP sends extracted text and metadata to the backend when the user runs the agent or side chat; raw files are not permanently stored and no cloud workspace or database is created.

## Run

For a visual-only static check, open `docs/index.html` directly in a browser.

For login and backend calls, serve the GitHub Pages frontend from `http://localhost:3000` so it matches the backend CORS allowlist:

```bash
python3 -m http.server 3000 --directory docs
```

To run the Worker locally:

```bash
cd worker
npm install
npx wrangler secret put REQUESTY_API_KEY
npm run dev
```

The frontend expects the Worker at `http://127.0.0.1:8787`.

`REQUESTY_MODEL` is configured in `worker/wrangler.jsonc`. The Requesty API key must be provided as a Worker secret and is never exposed to the frontend.

## Demo Behavior

Add optional project context, upload any relevant files, write an agent instruction, and click **Analyze & Recommend**. When the backend is available, the frontend calls `POST /chat` with `projectContext`, `referenceDocuments`, grouped `experimentModules`, flattened `experimentDocuments`, and flattened `experimentNotes`. If the backend is unavailable, it falls back to a local demo recommendation.

The side chat uses the same backend endpoint for questions but does not update the Current Recommendation panel. The **Export Markdown** button downloads the current recommendation as `biodesign-workbench-recommendation.md`.
