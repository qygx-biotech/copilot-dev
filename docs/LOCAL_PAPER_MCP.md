# Local academic search and PDF acquisition

Agent Work can search online literature, inspect structured paper metadata, resolve public full-text locations, and save PDFs in the selected project. The MCP server ships with Electron and runs locally as a child process over standard input/output. End users install neither Python nor an MCP service. There is no listening HTTP port or cloud-hosted paper MCP.

```text
Original request → existing semantic planner → existing Agent tool loop
                                               ↕ signed tool handoff
                                           Electron host
                                               ↕ local stdio MCP
                                      bundled paper-search-server
                                               ↕ HTTPS
                                      public academic providers

Selected paper refs → Electron PDF downloader → project/literature/
                                             → provenance sidecar
Next user request → existing source preflight and ingestion
```

Alibaba FC continues to authenticate requests and run the existing model loop. Its academic module exposes function schemas, validates permissions, carries signed continuation state, and reports actual tool outcomes. It does not host the MCP server, query academic providers, download academic PDFs, or write project files. Search terms go directly from the desktop to providers; bounded returned metadata goes to the model through the existing FC connection. PDF bytes stay on the desktop during acquisition. Later ingestion retains its existing behavior.

## Routing and tools

The desktop advertises `desktopTools.academicVersion: 1`. The new route applies only to `agent_command` with validated semantic IR containing `literature` and retrieval scope `web` or `both`. It uses the existing 8-step/24-call loop and skips the provider-native search stage for that literature move. Side Chat, general native web search, existing workspace `search_papers`, evidence recovery, and ingestion retain their current routes.

| Tool | Execution | Result |
| --- | --- | --- |
| `search_academic_papers` | Local MCP | Structured candidates, abstracts, identities, provider status and candidate cursor |
| `get_academic_paper` | Local MCP | Cached metadata by handle or candidate lookup by DOI/title |
| `resolve_paper_full_text` | Local MCP | Matching public locations, still unverified until fetched |
| `download_papers` | Electron workflow using MCP resolution | Per-paper PDF paths or failures |

Search and metadata work with read-only Agent permission. Saving requires explicit save/download intent in the existing semantic plan and `workspace_write` or `full_access`. Each desktop handoff accepts at most two academic calls and five downloads. Selection uses returned `paper_ref` handles; invented handles and duplicate attempts in the same move are rejected. The host reports the actual saved count and does not claim success when the requested count was not reached.

Search accepts a focused query, optional provider selection and year range, up to 100 candidates per provider, and up to 20 results per response. DOI and conservative title/author matching merge duplicates. The cursor pages a cached, bounded candidate set; it is not exhaustive upstream pagination. Year ranges are applied after retrieval and records with unknown dates are excluded when a year filter is requested. Provider failures, empty-or-unavailable responses and coverage are explicit. The model can refine queries or choose other providers within the existing budget.

Handles and candidate sets expire after 30 minutes and are scoped to the local project process. Closing the project terminates that process. Reopening or an expired handle requires a new search. Saved PDFs and provenance persist.

## Anonymous provider coverage

All 19 supported anonymous modes are registered; no provider API keys, inherited credentials or user configuration files are loaded.

| Providers | Role and limitations |
| --- | --- |
| arXiv, bioRxiv, medRxiv, IACR | Preprints and public PDF candidates. bioRxiv/medRxiv topic discovery uses Europe PMC's preprint index; native recent-feed APIs are not topic search. |
| PubMed, PMC, Europe PMC | Biomedical discovery and public full-text locations. A PubMed record alone does not guarantee free full text. |
| Crossref, OpenAlex, Semantic Scholar, DBLP | Bibliographic discovery and linked public copies where supplied. Optional-key services use only their anonymous modes. |
| CORE, OpenAIRE, DOAJ, Zenodo, HAL, CiteSeerX | Open-access indexes and repositories, using public endpoints or public search pages. |
| Google Scholar, SSRN | Public discovery pages; anti-bot challenges and access restrictions can make them unavailable. |

Default discovery queries PubMed, Europe PMC, Semantic Scholar, Crossref and arXiv. The other providers are selectable in the tool. Full-text resolution also checks Europe PMC, OpenAlex, CORE, OpenAIRE, HAL and Crossref for matching alternatives. Optional-key providers may offer reduced anonymous coverage or rate-limit requests. Registration does not imply every result or provider will have an accessible PDF.

API-key-only/institutional integrations (including IEEE/ACM and BASE) are deferred. Unpaywall's email registration is also deferred. Sci-Hub is not part of the public-source acquisition route. Publisher or repository public copies linked from any supported provider can be downloaded without adding that publisher as a separate search connector.

## Local files and provenance

The default destination is `literature/`; the tool can select another ordinary relative folder within the open project. Existing filesystem confinement and collision handling apply. Public HTTP(S) fetches validate DNS addresses and each redirect and have byte/time limits. Academic downloads use the desktop network path only, with no FC download fallback.

The downloader tries candidate PDFs and PDF links declared on public landing pages. It rejects detected DOI mismatches, requires PDF byte signatures, and never saves an HTML error/paywall page as a paper. This verifies file type and available identity metadata; it is not a full-text scientific identity review. Files exceeding the existing 20 MiB source limit fail explicitly. Search metadata and abstracts are discovery evidence, not full-text findings.

The existing `.biodesign/sources/<download-id>.json` sidecar includes paper metadata, original and resolved URLs, local path, timestamp and SHA-256. `.biodesign/academic/downloads.json` supports reuse when the paper handle, destination and current file hash match. No files are overwritten and no knowledge layers are generated by downloading. Existing preflight discovers and ingests new PDFs on the next request.

## Building and verification

Use Node 22 or 24 and Python 3.10+ on the build machine. `BIODESIGN_PAPER_PYTHON` can select the initial build interpreter. Python dependencies are locked in `desktop/paper-search/requirements.txt`; the original connector code is vendored with its MIT license and pinned upstream commit. The separately cloned root `paper-search-mcp/` folder is not needed at build time and is excluded from releases.

```bash
npm ci
npm run paper:build
npm run paper:smoke
npm run desktop:dev
npm run desktop:package
npm run desktop:audit:package
npm run desktop:smoke:packaged
```

`paper:build` freezes the Python runtime, MCP SDK and connectors with PyInstaller into `desktop/paper-search/dist/<platform>-<arch>/paper-search-server/`. Forge builds or validates that bundle and copies it to Electron's resources directory outside ASAR. Each target requires a native build runner or an already built matching bundle; Python is not cross-compiled. Windows workflows install build-time Python. The source virtual environment and tests are excluded from the application.

The build checks all provider imports and a real offline MCP protocol exchange. The packaged-app smoke test also launches the bundled server from Electron and checks discovery, a structured tool error and shutdown without a provider connection. Automated fixtures cover renderer → authenticated FC continuation → local workflow → saved PDF, real Python stdio, provider failures, deduplication, pagination, permissions and Side Chat routing. Run the Python service tests with the build environment's interpreter:

```bash
cd desktop/paper-search
.venv/bin/python -m unittest discover -s tests
# Windows: .venv\Scripts\python.exe -m unittest discover -s tests
```

Ship the updated Electron package together with the corresponding FC harness version through the normal release process. This feature adds no cloud MCP deployment and no new provider credentials.
