# General agent and delegated literature work

The desktop advertises `desktopTools.literatureVersion = 1`. The existing main
agent then chooses ordinary project tools, general web search, a direct answer,
or the new `discover_papers` / `retrieve_papers` operations. There is no compulsory
intent-classification inference. Older clients retain the existing academic
workflow. The main agent still owns the final user answer/report.

## Components and boundaries

| File | Responsibility |
| --- | --- |
| `shared/agent-prompts.js` | Reusable general, discovery, retrieval, and browser instructions |
| `shared/literature-agent.js` | Task/result JSON schemas, validation, identity normalization and deduplication |
| `alibaba-fc/literature-specialist.js` | Bounded specialist model loop and separate messages |
| `alibaba-fc/side-chat-agent.js` | General main-loop delegation and compact result integration |
| `alibaba-fc/agent-continuation.js` | Existing signed handoff, extended to specialist receipts |
| `desktop/services/literature-workflows.mjs` | Host authorization, jobs, budgets, routes, receipts and checkpoints |
| `desktop/services/playwright-mcp-client.mjs` | Local MCP lifecycle, browser ownership, runtime schemas and filtered observations |
| `desktop/services/paper-verification.mjs` | PDF parsing, identity/version checks and hashes |
| `desktop/workers/pdf-verification-worker.mjs` | Isolated parser with a time and memory bound |
| `docs/literature-login.js` | Login handoff and persisted-job UI |

The model remains behind the existing backend/provider boundary. Specialists use
the same `requestTurn` closure and selected model. They cannot access provider
credentials. Browser snapshots stay in specialist messages within signed
continuations; only validated compact outcomes enter the main model context.
Specialist prose is not streamed as a main-agent answer. Existing model capability
checks apply; unsupported tool calling does not trigger a model substitution.

Playwright MCP is embedded through its `createConnection` API, connected to an
SDK client using `InMemoryTransport`. This is a real local MCP server/client
connection, without an HTTP listener or a renderer-accessible browser endpoint.
The Electron host owns the Playwright `BrowserContext` through `contextGetter`.
The browser service is general purpose; literature-specific task policies are in
the host workflow. No arbitrary JavaScript, network headers, cookies, filesystem
operations or page-registered WebMCP tools are exposed to workers.

## Setup and behavior

The sidebar's bottom-left **Account → Library URL** control opens a centered
editor. The saved URL is local to the current application account on this device;
users can edit it or clear it with Save. English and Chinese dialog copy is
supported. At the first literature delegation of each new request, the renderer
pauses before starting a host job and displays the saved URL with **Save and
continue**, **Continue without library**, and **Cancel**. Later delegations in
that request reuse the choice. Skipping applies to that request and preserves
the saved preference. Cancelling stops the request. Ordinary non-literature
requests do not show this prompt.

The host requires an explicit library choice for new jobs. An empty choice
disables browser/institutional tools, requests open-access preference from paper
providers, and filters discovery records to provider-confirmed open access or
recognized public repositories. Records without evidence are omitted with a
coverage limitation. Public search providers may still search mixed metadata
indexes before this host filtering. Web search is scoped to open-access full
text, and uncorroborated/non-repository web candidates are omitted. This explicit
user choice overrides broad discovery for that job. Saved jobs retain their
original access choice when resumed; changing the account URL affects new jobs.
The URL-setting change passed 116 focused backend/host tests and 165 checks in
the actual Electron renderer, including save/reopen, invalid input, waiting,
skip and cancellation. The renderer build and syntax checks also passed.

Install repository dependencies normally. `@playwright/mcp` is pinned to `0.0.83`,
including its exact Playwright alpha dependencies. Development still uses the
existing `paper:build` / `desktop:dev` scripts for the paper MCP executable. The
browser currently uses an installed Google Chrome (`channel: chrome`); it does
not install browsers or attach to the user's everyday profile. A missing Chrome
or unavailable paper MCP produces an explicit limitation while other supported
routes remain usable.

Sessions are headed by default. `ProjectSessionManager` accepts
`browserHeadless: true` for controlled deployments after authentication permits
it. Profiles live in the application's cache under `library-browser/<project
hash>/profile`, outside the research project. The profile root is created with
owner-only permissions. Closing the project closes its browser and MCP services.
The service has one exclusive worker owner per session, including observation
and navigation. Login pauses retain that ownership. Other workers receive a
busy/unavailable limitation instead of operating the same tabs.

Users enter university credentials/MFA directly in Chrome. Auth pages and frames
are withheld from snapshots; input values, URL queries/fragments and common
secret patterns are removed from returned observations. Network/console/storage
tools are absent. Login produces a persisted `needs_login` checkpoint and a
dialog with Continue and Cancel controls. Continue rechecks the library or
requested-paper URL before resuming. `Library jobs` also lists unfinished jobs
after restart; Resume starts a fresh signed model flow with the original task,
model, permission and local source scope. It does not replay stale element refs.
The existing signed continuation expiry remains 15 minutes: after an unusually
long login pause, use the saved-job Resume action to obtain a fresh continuation.

Discovery can use local paper MCP, provider-supported general web search, and
library pages. It cannot call retrieval tools. Paper MCP and browser tool schemas
come from runtime `listTools`; their inputs are validated locally. Discovery
preserves original host metadata, corroborates browser/web candidates against
observations, and separates relevance from availability. Metadata/abstracts are
not reported as verified full-text evidence. Provider failures are coverage
limitations, not proof that a paper does not exist.

Retrieval checks up to 100 in-scope local PDFs, then reuses the public resolver
and acquisition pipeline, then permits institutional navigation. Exact requested
identities and accepted document versions remain fixed. The host requires the
existing workspace write permission and explicit download authorization derived
from the original user request; a report request is insufficient. A hard empty
source selection does not become permission to read all files.

Browser automatic downloads are disabled (`acceptDownloads: false`) in both
specialists. `capture_article` can transfer an observed hyperlink, or
`target: "latest_download"` for the latest observed browser download event.
Its authenticated GET uses browser cookies only inside the local host and
recomputes cookies per redirect origin. The existing fetcher enforces public
targets, DNS pinning, redirect/time/byte bounds. It never sends cookies to the
model or stores them in article metadata. Links that yield HTML, a resolver,
or a login page remain unresolved until further navigation establishes a PDF.
`browser_pdf_save` is never exposed or used.

The host parses PDFs in a worker, rejects HTML and malformed files, computes a
SHA-256 hash, and checks DOI plus title or title/author/year evidence. Document
version is conservative: explicit first-page signals identify a published,
accepted-manuscript or preprint version; otherwise it is `unknown`. Success
requires a verified identity and an accepted version. Unverified PDFs are saved
under `.biodesign/literature-unverified/` and excluded from ordinary source
ingestion. Verified files use the existing confined source writer and provenance
sidecars. They have `ingestion: pending`; the normal next-request preflight picks
them up. Existing verified local files have `already_present`, not a new-download
claim. No retrieval outcome claims the paper has been scientifically analyzed.

Jobs and idempotent execution receipts live under `.biodesign/literature-jobs/`.
Reusing a receipt ID with different arguments is rejected. Checkpoints keep the
paper position, attempts and completed receipts; credentials and live element
handles are not persisted as reusable browser state. Resume validates the saved
task, selected model, permissions and source paths. Cancellation interrupts the
active fetch/parser/browser action and persists a cancelled state.

## Bounds and outcome meanings

- Main loop: existing eight iterations / 24 tool calls.
- Specialist: 24 model turns / 36 calls / 12-minute wall-clock limit; only one
  function per specialist turn. A 250,000-character context limit terminates with
  a partial host result instead of silently dropping observations.
- Host job: four minutes of active execution, 36 steps, 18 page-changing
  operations, ten acquisition attempts, five selected papers per retrieval task.
- Provider web discovery: at most three model-selected searches per specialist.
- Article transfer: 32 MiB / 45 seconds for institutional transfers; public
  acquisition retains its existing bounded multi-location resolver.
- PDF parser: 20 seconds, 256 MiB worker heap and at most 1,000 pages.
- Source outcomes: `already_present`, `downloaded`, `needs_login`,
  `access_unavailable`, `unresolved`, `downloaded_unverified`, `failed`, `cancelled`.
  `access_unavailable` requires an explicit observed restriction; an unfamiliar
  language or a failed link alone yields `unresolved`.

## Confirmed interfaces and verification

The original ignored `playwright-mcp/` checkout was inspected in the primary
workspace: README, package/config/type declarations, CLI, source-location note,
and CLI/core/click/capability/library/client fixtures. It is a wrapper around
`playwright-core/lib/coreBundle`. The installed pinned package was then exercised,
so implementation does not depend on assumptions about upstream `main`.

Confirmed against the pinned runtime:

- `createConnection(config, contextGetter)` and SDK in-memory transport.
- Runtime `listTools`, JSON Schema **2020-12**, and tool input validation.
- Snapshot `[ref=eN]` values are passed as **`target`**, not `ref`.
- `browser_snapshot`, `browser_type`, navigation, click, tabs, select, find and
  wait interfaces. Unsafe code exists upstream but is filtered out locally.
- Real headless Chrome fixture with Chinese labels, semantic typing, password
  page suppression, and the Continue-after-sign-in dialog.
- Actual PDF parsing of a generated valid PDF and malformed-PDF rejection.

Tests cover the production renderer request wrapper, authenticated backend,
selected-model specialist dispatch, signed continuations, host checkpoints,
main-context isolation, authorizations, source scope, quarantine, deduplication,
login/resume and cancellation. Browser tests use an in-memory HTML fixture:

```sh
node alibaba-fc/scripts/sync-shared.mjs
node --test alibaba-fc/test/literature-*.test.js
node --test desktop/test/literature-workflows.test.mjs desktop/test/playwright-mcp.test.mjs
PLAYWRIGHT_MCP_SMOKE=1 node --test desktop/test/playwright-mcp.test.mjs
```

## Remaining integration limits

No real university catalogue, institutional SSO/MFA, subscription entitlement,
campus VPN, publisher download or live model inference was tested. Those require
site-specific validation with authorized accounts. Browser DNS routing checks
are guardrails, not an OS network sandbox. Screenshot/coordinate tools are not
enabled in this initial text-based worker; inaccessible canvas/scanned interfaces
return limitations. The article transfer path supports authenticated GET;
POST-only exports, browser-bound tokens and DRM viewers may remain unresolved.
No OCR is performed, so scans without extractable identity text are unverified.
Version and identity checks are deliberately conservative and do not replace a
publisher metadata adapter. Session auth heuristics may require the user to close
an obsolete login tab or navigate back to the catalogue before resuming.

Final focused tests under Electron's Node 24.18.1 passed: 27 passing, one opt-in
Chrome fixture skipped. The separate real Chrome run passed all three browser/
parser tests. Renderer synchronization/build and `git diff --check` passed.
The broader backend and relevant desktop regression run had 1,125 passing,
five skips and three failures in existing `alibaba-fc/test/security-boundaries.test.js`.
All three failures were reproduced from an unchanged archive of the branch base
under the same Electron runtime. A separate desktop security scan also rejects
an official provider documentation URL already present in unchanged
`docs/sidechat-direct-agent-loop.md`. These existing failures remain unresolved;
the full suite is not claimed green. No deployment, publishing, production login
or remote browser connection was performed.
