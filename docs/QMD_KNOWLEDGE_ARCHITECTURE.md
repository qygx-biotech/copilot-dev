# QMD Knowledge Layers

BioDesign Copilot keeps scientific authority in the selected project folder while using QMD as a replaceable retrieval engine. QMD never owns source identity, source hashes, corpus membership, experiment values, or recommendation state.

```text
                             SIDE CHAT / AGENT COMMAND
                                       │
                              high-level knowledge tools
                                       │
                     ┌─────────────────┴─────────────────┐
                     │                                   │
              KnowledgeService                 structured experiment store
                     │                                   │
              project QMD store                         values,
                     │                             filters, aggregates
       ┌─────────────┼─────────────┬─────────────┐       │
       │             │             │             │       │
  L1 evidence   L2 Paper Cards  L3 topics   L4 syntheses │
       │             │             │             │       │
       └─────────────┴─────────────┴─────────────┴───────┘
                                       │ provenance
                                L0 original sources
```

Every derived layer can be deleted and reconstructed. The original PDF, workbook, CSV, protocol, or other user file is authoritative.

## Layers and ownership

| Layer | Representation | Authority and generation |
|---|---|---|
| 0 — sources | PDFs, supplementary files, XLSX/CSV, protocols | Authoritative. Never rewritten by QMD. Registered and content-versioned by the harness. |
| 1 — evidence | Page-preserving Markdown under `.biodesign/knowledge/literature/` | Derived on first material paper use. Includes source ID, project-relative source path, harness content hash, extraction version, and page boundaries. QMD indexes it for scientific retrieval. |
| 2 — Paper Cards | Canonical existing JSON plus Markdown under `paper_cards/` | Lazy LLM summary for routing and comparison. It never contains the full paper. The JSON/card cache remains canonical. |
| 3 — topics | Canonical `topics/index.json` plus one Markdown file per topic | Derived multi-label DAG. Membership changes mark affected topics and shallow ancestors stale; they do not trigger immediate LLM summaries. |
| 4 — syntheses | Existing workflow journal/structured reduction plus Markdown under `syntheses/` | Reusable corpus analyses with paper IDs, evidence references, coverage, corpus version, and historical parent synthesis. |

Experiment descriptors and compact project-memory entries are parallel searchable derived artifacts. Exact numerical experiment truth remains in the normalized structured records and raw file.

## Runtime boundary

QMD `2.8.3` requires Node `>=22`. The Function Compute backend remains Node 20-compatible and does not load QMD. Electron 44.0.0 bundles Node 24.18.1. In production, one isolated Electron utility process owns the QMD SDK store for the selected project:

```text
renderer (sandboxed, no native QMD dependencies)
  → frozen preload capability API
  → validated main-process IPC
  → QMD utility process
  → @tobilu/qmd createStore({ dbPath, config })
  → <project>/.biodesign/knowledge/qmd/index.sqlite
```

The main process obtains the absolute root from Electron's native picker and never exposes it to the renderer. The worker constructs an allowlist of six collections; neither the model nor a renderer request can supply a filesystem or database path. Requests are paired to `.biodesign/workspace.json` by workspace ID, and switching projects closes the old worker before a new session is established. The compatibility localhost server in `local-backend/` remains only for targeted browser development and tests.

The SDK is used directly and kept open. There is no per-query subprocess or global canonical QMD collection. Production Fast and Deep retrieval use only QMD's SQLite/FTS lexical index and therefore initialize no local model. If a user explicitly enables optional semantic retrieval, its model binaries use an application cache below Electron's `userData` directory and are not copied into the scientific project.

## Project layout

```text
<project>/
├── literature/                         # Layer 0
├── experiments/                        # Layer 0
└── .biodesign/
    ├── workspace.json
    ├── sources/registry.json           # authoritative harness lifecycle
    ├── sources/artifacts/              # parsed/normalized structured artifacts
    ├── literature/summaries/           # canonical Paper Card JSON
    ├── workflows/                      # canonical synthesis journals
    └── knowledge/
        ├── qmd/
        │   ├── index.sqlite
        │   └── metadata.json
        ├── literature/<source-id>.md
        ├── paper_cards/<source-id>.md
        ├── topics/index.json
        ├── topics/<topic-id>.md
        ├── syntheses/<workflow-id>.md
        ├── experiment_notes/<source-id>.md
        └── memory/<memory-id>.md
```

`metadata.json` records QMD package version, exact embedding model URI/version, collection names, vector compatibility, and last update/embed observations. The database is local operational state, not project metadata authority.

## Collections

- `literature-evidence`: page-bounded Markdown used for factual evidence and paper discovery.
- `paper-cards`: high-level reusable summaries, separate from evidence.
- `topics`: multi-label nodes and lazy/stale topic summaries.
- `syntheses`: historical and current corpus reviews.
- `experiment-notes`: source/field/entity descriptors only; no raw numeric truth.
- `project-memory`: compact goals, decisions, hypotheses, observations, and references.

Search tools select collections deliberately. Precise claims use evidence. Project-decision and previous-review questions use memory and syntheses. Broad topic questions add topic and Paper Card routing aids. Experiment questions use QMD only to discover sources, followed by deterministic structured queries.

## Lazy indexing and embeddings

Opening or refreshing a folder performs only metadata reconciliation. It does not hash, parse, render Markdown, update QMD, embed, or call an LLM.

On first relevant paper use:

```text
ensureSourceReady(source, search)
  → stable read and harness SHA-256
  → existing PDF.js extraction
  → parsed page/chunk JSON
  → Layer 1 Markdown mirror
  → incremental QMD update
  → lexical-ready immediately
```

Vector generation is a distinct optional stage. `qmdLexStatus` and `qmdVectorStatus` are persisted separately. Exact identifiers therefore do not wait for model loading. A CLI rebuild or a request that explicitly asks to generate embeddings calls incremental `store.embed`; it does not delete the database. The local KnowledgeService emits `initializing`, `indexing`, `embedding`, `ready`, or `fallback` events; during embedding it polls the backend's real QMD chunk callback so the existing UI can display progress such as `8/32` without appearing frozen.

Paper Cards are generated only by existing explicit broad-summary/comparison triggers or `ensure_paper_card`. Each new card records one deterministic cache key containing the source content hash, card schema, LLM model, and prompt version; legacy keys are migrated only when that card is next requested. Topic membership updates use those structured fields and mark summaries stale without generating them. Corpus syntheses are rendered only after the existing snapshot/map/reduce/verify workflow completes.

## Retrieval tiers and context discipline

`fast` calls local QMD `searchLex` only. It makes no cloud request and does not initialize an embedding, expansion, or reranking model. Production `deep` is cloud-assisted but remains locally authoritative:

```text
query + intent
  → authenticated Alibaba FC search plan
  → Requesty structured output
  → validated lexical expansions
  → repeated local QMD searchLex
  → deterministic fusion/deduplication
  → opaque IDs + handles + budgeted snippets to authenticated Alibaba FC
  → Requesty structured rerank
  → validate candidate IDs/scores
  → reconstruct original evidence objects locally
```

The renderer never calls Requesty directly. Search planning sends only the query and intent. Reranking sends only the original query, intent, opaque candidate IDs, titles, stable evidence handles, and deduplicated snippets selected by the existing evidence budgets. Absolute paths, directory handles, tokens, registries, unrelated project state, full documents, and PDF bytes are rejected. The existing authenticated native-PDF endpoint is the sole explicit whole-PDF route.

Exact biological identifiers, DOIs, author/title tokens, mutations, strain IDs, `Km`, and `kcat` remain lexical inputs and are preserved through plan validation. Cross-language plans may add English terminology for Chinese or other-language questions. Optional `semantic` retrieval can still call `searchVector` after explicit enablement and a compatible vector build, but it is disabled by default and is not a dependency of Fast or cloud-backed Deep.

The host groups QMD results by stable paper ID, keeps only the best few snippets per paper, and enforces an explicit `paperIds` scope after retrieval. One long paper cannot win simply by returning many chunks. Candidates omitted by the cloud ranker keep deterministic locally fused order after cloud-ranked candidates. A malformed plan or planning outage uses the original query; a malformed rerank, hallucinated/duplicate ID, or outage returns the local fusion with `fallback: "local-lexical-fusion"`. The existing paper-evidence tool reopens original parsed page/chunk evidence after ranking. Requesty native PDF remains the escalation for whole-paper, layout, figure, table, poor-extraction, or critical-verification needs.

Cloud plan and rerank results use the project's existing cache-management and invalidation path under `.biodesign/cache/cloud-retrieval/`. Cache identities include normalized query and intent, collection and paper/experiment scope, candidate IDs, evidence/content hashes, source versions, retrieval configuration, opaque FC model signature, and prompt/schema versions. Credentials and bearer tokens are neither identity inputs nor cached values.

### Reused bounded-retrieval contract

`shared/retrieval-contract.js` centralizes values that already existed in IPC validation, QMD normalization, and source-context construction; the migration does not lower them. Tests import the same contract instead of declaring separate numeric expectations.

| Existing boundary | Effective value retained |
|---|---:|
| Query / intent | 20,000 / 1,000 characters |
| Paper scope | 500 IDs, 256 characters per ID |
| Final result count | default 10, maximum 100 |
| Candidate count | default 40, maximum 200 |
| Collections | existing six-item allowlist |
| Candidate snippet / title / evidence handle | 1,200 / 500 / 500 characters |
| Matched sections per paper | 3 |
| Source context / aggregate evidence | 5,000 / 360,000 characters |
| FC request serialization | 600,000 characters |
| Bounded output/reason text | 5,000 characters |

Adjacent limits were audited and left in their existing scoped modules:

| Workflow boundary | Existing configuration retained |
|---|---|
| Progressive project context | 500 inventory files, 150 evidence files, 20 project summaries |
| Conversation/context | 40 messages; 120,000 characters per message and aggregate; 100 stored messages; 48,000-character summary |
| Literature map/reduce | 12,000-character FC chunks, up to 48 chunks, 60,000-character synthesis input |
| Corpus mapping | no total-paper ceiling; prepare/map concurrency 2; 3 mapper attempts; 8 evidence excerpts and 16,000 characters per FC map request |
| Experiment context | existing 12 files per module / 36 total; FC retains 36 experiment documents and 36 notes |
| Stored large results | externalize at 24,000 characters and return the existing compact preview/result handle |
| Native PDF | active local-workspace endpoint 20 MiB; retained legacy OSS flow 5 MiB, 100 pages, 96,000 extracted characters |
| Provider/client retries | existing FC Requesty maximum 2 attempts; renderer cloud client maximum 2 attempts for its existing retryable/network cases; retry delay capped at 2 seconds |
| Existing concurrency | literature chunk concurrency 2; corpus prepare/map 2; retained PDF review concurrency 3 |
| Timeouts | retained 30-second server PDF-parse timeout; cloud fetches remain abort-signal driven rather than gaining a new migration-specific timeout |

In particular, the ordinary retrieval limits are not a corpus-size ceiling: growing projects are routed through top-K handles, while explicit corpus workflows continue their coverage-preserving snapshot/map/reduce behavior.

Corpus-wide intent bypasses ordinary top-K routing. The existing `SNAPSHOT → PREPARE → MAP → GROUP → REDUCE → VERIFY → ANSWER` workflow still gives every snapshot paper an opportunity to contribute. QMD improves local preparation and later reuse; it never substitutes ranking for coverage.

## Invalidation and concurrency

- A metadata-only folder change marks a source dirty without processing it.
- On next use, an unchanged harness content hash revalidates and reuses artifacts.
- A changed hash removes that paper's evidence/card Markdown, resets lexical/vector status, invalidates the card, updates affected topics, and regenerates only what the request requires.
- Deletion removes active registry membership immediately. Reconciliation removes derived evidence/card/experiment descriptors, updates QMD, and removes topic memberships. Empty leaf-topic files are pruned; shallow root nodes may remain.
- Previous synthesis journals and Markdown remain historical. Corpus membership/version changes stale the prior workflow and create an incremental child when an update is requested.
- The existing per-source preparation lock deduplicates extraction. A project-level promise queue serializes QMD update/embed operations against one SQLite database.
- An embedding-model URI change sets `requiresVectorRebuild`; only explicitly enabled semantic search is blocked until a forced re-embedding succeeds. Fast and cloud-backed Deep remain lexically usable.

## Failure behavior

KnowledgeService initialization is soft. A missing package, localhost backend, native dependency, optional model download, optional embedding failure, or QMD database error records an accurate status and keeps the legacy local text/metadata path available. Alibaba FC or Requesty failure cannot prevent project browsing or Fast search and preserves valid local evidence for Deep fallback. Per-source PDF/workbook errors remain isolated by the existing registry and job system. QMD does not fabricate a result and cannot mutate an original source.

The legacy text scorer remains installed for dual-run migration and fallback. QMD is attempted first for bounded top-K routing; when it returns routed candidates, the host avoids scanning every ready legacy artifact. The 150-paper regression test asserts that behavior.

## Models and benchmark

Cloud planner and reranker model names are configured only in Alibaba FC as `REQUESTY_SEARCH_PLANNER_MODEL` and `REQUESTY_RERANK_MODEL`, each falling back to the existing `REQUESTY_MODEL`. FC exposes only opaque configuration signatures for cache invalidation. Electron resources contain neither model names nor Requesty credentials.

The default application does not download or initialize QMD's query-expansion model, Qwen reranker, or Qwen embedding model. Optional local semantic retrieval is a separate explicit choice. When enabled, its retained default is EmbeddingGemma:

```text
hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf
```

It requires roughly 318 MB of cached model storage and prior measurements observed about 1.0 GiB process RSS; actual native-backend memory varies. Changing the URI preserves the existing compatibility check and controlled vector-rebuild requirement. The Qwen3 embedding URI remains an explicit benchmark/override candidate, not a production default.

`scripts/benchmark-retrieval.js` retains the original 11-document corpus and 10-query set, and now compares legacy lexical, QMD lexical, recorded cloud-planned lexical, and recorded cloud-reranked paths without local model acquisition. The recorded cloud stages use validated representative plan/rank responses to measure deterministic local orchestration, exact identifier recall, semantic/concept recall, Chinese→English recall, evidence recall, FC call counts, and estimated Requesty input/output usage. They do not claim live network/provider latency. Optional historical vector/model comparisons remain documented separately.

## Operations

From `local-backend/`:

```bash
npm ci
npm start -- --project "/absolute/path/to/initialized/project"
npm run knowledge -- status --project "/absolute/path/to/initialized/project"
npm run knowledge -- rebuild --project "/absolute/path/to/initialized/project"
npm run knowledge -- rebuild --vectors --force --project "/absolute/path/to/initialized/project"
npm test
npm run benchmark -- --fixture --model lexical --repeats 3 --output /tmp/requesty-cloud-benchmark.json
```

Use `--model default` or `--model both` only for an explicit optional-semantic benchmark. Use `--cpu` for QMD's supported CPU fallback if a native GPU context cannot be allocated. The measured cloud-retrieval comparison and the historical optional-model observations are in `local-backend/benchmark/REPORT.md`.

To select the multilingual model for a new or explicitly rebuilt project:

```bash
BIODESIGN_QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf" npm start -- --project "/absolute/path/to/project"
```

After any optional embedding-model change, run the forced vector rebuild before semantic search. Fast and cloud-backed Deep do not require that rebuild.
