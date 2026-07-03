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

The frontend supports attaching up to 3 local reference files per page session:

- `.pdf`
- `.txt`
- `.csv`
- `.xlsx`
- `.xls`

Files are parsed locally in the browser. Raw files are not uploaded, stored, or written to a database or storage bucket. When the user sends a chat message, the app sends only extracted text snippets plus lightweight metadata such as filename, MIME type, character counts, and truncation status.

Per-file upload size is limited to 5 MB. Extracted text is capped per file and capped across the full request, so this is not a full RAG system yet. It is a lightweight context-passing MVP for lab reports, spreadsheets, notes, and literature PDFs.

## Run

Open `docs/index.html` directly in a browser for the frontend.

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

Use one of the prompt buttons or type a project idea. The app returns a mocked assistant response with:

- Project Summary
- Key Assumptions
- Clarifying Questions
- Design Considerations
- Safety & Compliance Notes
- Recommended Next Steps
- Draft Memo

When the Worker is available, the frontend calls `POST /chat` and renders the returned reply and project object. If the Worker is unavailable, it falls back to the local mock response.

The right-side project panel updates from the current project state. The **Export Markdown** button downloads the current project memo as `biodesign-copilot-project-memo.md`.
