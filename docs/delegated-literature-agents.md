# Finding and downloading papers in Agent Work

The desktop advertises `desktopTools.literatureVersion = 1`. The main agent then
chooses ordinary project tools, general web search, a direct answer, or two
literature tools:

- `discover_papers` hands discovery to a search specialist with its own context.
- `retrieve_papers` downloads selected papers. The host runs a fixed retrieval
  sequence for every paper; a model is involved only at the end, for library
  catalogue browsing, and only when the user configured a library page.

The main agent owns the final answer. The former `download_papers` academic route
and its planning/shortlist modules were removed; the paper MCP's read-only tools
now serve only the discovery specialist.

## Components

| File | Responsibility |
| --- | --- |
| `shared/agent-prompts.js` | Main, discovery, retrieval and browser instructions |
| `shared/literature-agent.js` | Task/result schemas (up to 20 papers per retrieval), validation, identity normalization |
| `shared/agent/literature-specialist.js` | Discovery model loop; deterministic retrieval driver; bounded library browsing |
| `shared/agent/side-chat-agent.js` | Exposes the two tools, integrates results, one completion check |
| `desktop/services/literature-workflows.mjs` | Host jobs, receipts, the per-paper retrieval sequence, access rounds |
| `desktop/services/open-access-sources.mjs` | Official open-access lookups: PMC open data, arXiv, bioRxiv, OpenAlex, Unpaywall, NCBI ID converter, DOI registry |
| `desktop/services/paper-acquisition.mjs` | Direct HTTP stage: candidates, publisher `citation_pdf_url`, browser targets |
| `desktop/services/browser-article-capture.mjs` | Scripted capture in the library browser: sign-in, check and paywall detection, PDF download |
| `desktop/services/playwright-mcp-client.mjs` | Shared library browser, profiles, navigation guard, snapshots, model-directed tools |
| `desktop/services/paper-verification.mjs` | PDF parsing, identity and version receipts |
| `shared/source-fetch.js`, `shared/cookie-jar.js` | Bounded public HTTP transport with an optional per-session cookie jar |
| `docs/literature-login.js` | Library settings, download confirmation card, sign-in/check dialog |

## What the user does

1. Asks in Agent Work, for example "find recent papers on X and download the best five".
2. The first time literature work runs for an account, chooses library access once:
   a library website (for catalogue browsing) and, optionally, a proxy prefix such
   as EZproxy's `https://ezproxy.example.edu/login?url=`. "Continue without
   library" is also remembered. Change it later under **Account → Library URL**.
3. Confirms the download card that lists the papers. In Read-only mode the card
   offers **Switch to Workspace write and download**; that switches the
   conversation's mode. "Not now" ends the retrieval without failing the turn.
4. Only if a site needs it: signs in to the university, or completes a "verify you
   are human" check, in the separate library browser window. All waiting papers are
   gathered into one request; each site has its own open tab, and the download
   continues automatically when the tabs clear (or on **Continue after sign-in**).

Download consent is the card, not the wording of the request. Plan mode never
offers `retrieve_papers`.

## Retrieval sequence (per paper, no model calls)

1. **Local copy.** In-scope project PDFs are parsed once per job and checked
   against every requested paper (`already_present`).
2. **Identity.** A paper without a DOI is looked up by exact title through the
   paper MCP.
3. **Official open copies** (`open-access-sources.mjs`): PMC's open-data bucket
   (its JSON states whether the copy is an author manuscript), arXiv, the bioRxiv/
   medRxiv API, and OpenAlex and Unpaywall locations with their declared versions.
   Preprint servers are always labeled `preprint`. Single-DOI lookups are cached
   for 30 minutes and spaced per host.
4. **Direct HTTP stage** (`paper-acquisition.mjs`): candidates in version order
   (published, accepted manuscript, unknown, preprint), then the publisher page
   resolved through the DOI registry and its `citation_pdf_url`. A session cookie
   jar, up to 10 redirects, gzip/deflate/br and standard TLS ALPN are used with the
   app's downloader name (`BioDesign-Source-Downloader/1.1`). Supplementary files
   are never candidates. Hosts that answer scripts with bot checks or 403s
   (PMC and Europe PMC web pages, ScienceDirect/Cell, Wiley, OUP, Science, PNAS, …)
   are not fetched here; they become browser targets. A PDF that fails
   verification does not stop the sequence.
5. **Library browser stage** (`browser-article-capture.mjs`): up to four targets
   per paper, version of record first and bot-checked repositories last. Publisher
   pages open through the proxy prefix when one is set. The host reads the
   article's own PDF declaration (or Atypon `pdfdirect`/`?download=true`
   variants), Chrome downloads the file (`plugins.always_open_pdf_externally`),
   and the host verifies it. Sign-in pages and human checks are detected and the
   paper is deferred; later papers on a site that is already waiting are not
   visited again in that round. Without library access a sign-in page leaves the
   paper `unresolved`; human checks are still offered.
6. **Access round.** After every paper ran once, the driver issues
   `request_access` (at most three rounds). The renderer shows one dialog naming
   every waiting site and polls `await_attention`, which watches the waiting tabs.
   After the user acts, the deferred papers run their browser routes again.
7. **Library catalogue browsing** (only with a library website, only for papers
   still missing): the browser opens the library page and the retrieval specialist
   model gets a summary of the remaining papers, browser tools and
   `capture_article`. It is bounded to 20 model turns, then finishes. Element
   references are valid only for the latest page, so earlier full snapshots in
   this conversation are replaced by a short note before each model turn.
8. `finish_retrieval` returns host receipts. The main agent receives each paper's
   outcome with its last four attempts; the full receipt stays in
   `.biodesign/literature-jobs/`.

Verified files go to `literature/` (or the task destination) with provenance
sidecars and `ingestion: pending`; unverified PDFs are quarantined under
`.biodesign/literature-unverified/`.

## Verification

Identity is accepted when the PDF text or metadata carries the requested title
(exact, spacing-insensitive for text-layer splits such as "ff 14SB", or with number
words normalized, "three-track" ↔ "3-track") together with the DOI, or the
first page/metadata carries the paper's own DOI with an author or most title
words, or the title matches with an author (and year for token matches).
A cited DOI in references alone, and one- or two-page correction or retraction
notices, are not identity. The version comes from the supplying source when it
declares one, otherwise from first-page wording, otherwise from the route (a
publisher's own PDF is the version of record). Receipts record `version_basis`
and `title_match`.

## Library browser

`ProjectSessionManager` owns one browser for the application: it survives project
switches (keeping session sign-ins) and is closed when the app quits. Each
account uses its own Chrome profile (`library-browser/<account key>/profile`),
selected with a hash of the app account. Downloads are accepted into Playwright's
temporary artifacts directory; only the host reads, verifies and saves them.

The navigation guard allows library proxy ports but blocks local, private and
metadata addresses, URLs with credentials, and shadow-library sites (Sci-Hub,
LibGen, Anna's Archive, Z-Library). Only navigations are DNS-checked; page
subresources are checked by URL. A detached frame, slow navigation or other page
event no longer closes the browser; only a closed or disconnected browser ends the
session. Snapshots shown to a model are capped at 60,000 characters with actionable
lines and headings kept first; `browser_find` searches the full capture and
registers the references it returns. Only actionable lines carry references.

## Discovery

Discovery uses the paper MCP (default providers OpenAlex, PubMed, Europe PMC,
Semantic Scholar and Crossref; arXiv when requested), optional model web search,
and the library catalogue in the browser when a library website is configured.
Without library access, candidates without open-access evidence are marked
(`open_access_evidence: false`), not omitted. The discovery specialist has no hard
turn cap by design; its results are handed to the main agent as authored.

## Bounds

- Retrieval: 20 papers per call; 75 s direct stage per paper; 4 browser targets
  per paper; 60 browser captures per job; 3 access rounds; 20 library-browsing turns.
- Browser capture: 30 s navigation, 8 s for an automatic check to clear, 32 MiB.
- Model-facing results: 150,000 characters (observations are shortened, not failed).
- PDF parser: 20 s, 256 MiB worker heap, 1,000 pages.

## Measurements (2026-10-14, Columbia network, no library configured, headless Chrome)

Fifteen DOIs across PLOS, BMC, Nature, Cell, Science, PNAS, OUP, ACS, Wiley,
bioRxiv and arXiv, through the production host (`literature_worker`), no model:

| Outcome | Before | Now |
| --- | --- | --- |
| Verified PDF saved | 3 of 14 | 11 of 15 |
| Wrong file saved (supplementary PDF) | 2 | 0 |
| Waiting for a one-time human check (Cell, Science, PNAS, Wiley) | — | 4, in one request naming the four sites |
| Total time | — | 146 s (open copies 1–4 s each) |

Headless Chrome is flagged by Cloudflare; in the default visible window Wiley
downloaded without any check, while Science and PNAS still asked for one.

With a Claude Haiku model standing in through `evals/literature/model-bridge.cjs`
(production renderer, loop, host, paper MCP and Chrome): a topic request ran
discovery, the card, and retrieval of three open-access PDFs in 5 model calls and
124 s; a request for two papers behind bot checks ran three access rounds, then
catalogue browsing in Columbia's CLIO, and the final answer reported both papers as
waiting for a website check.

## Verification commands

```sh
node --test desktop/test/paper-acquisition.test.mjs desktop/test/source-session.test.mjs desktop/test/literature-retrieval.test.mjs
node --test desktop/test/literature-workflows.test.mjs desktop/test/literature-receipts.test.mjs desktop/test/literature-ownership.test.mjs
node --test alibaba-fc/test/literature-*.test.js
PLAYWRIGHT_MCP_SMOKE=1 node --test desktop/test/playwright-mcp.test.mjs desktop/test/browser-capture.test.mjs
```

## Limits

- Sites protected by Cloudflare or reCAPTCHA may ask the user to complete a check
  in the visible window; the app does not try to defeat these checks. PMC's
  "Preparing to download" proof-of-work page is handled only by the browser.
- No real university single sign-on was exercised in automated tests; sign-in
  handling is covered with fixtures and the classification of real pages.
- The proxy prefix must be the library's own (EZproxy `login?url=`,
  `login?qurl=`, or an OpenAthens redirector).
- Author manuscripts that PMC provides only as XML or text are not converted to PDF.
- No OCR: scanned PDFs without extractable identity text are quarantined.
- The contact address sent to OpenAlex, Unpaywall and NCBI defaults to a
  placeholder (`biodesign-copilot@example.org`); set the application's support
  address with `BIODESIGN_CONTACT_EMAIL`. `BIODESIGN_OPENALEX_API_KEY` raises the
  OpenAlex daily allowance.
