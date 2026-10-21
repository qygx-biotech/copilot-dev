# Local paper search MCP

The desktop bundles a Python MCP server (`desktop/paper-search`) that searches
academic indexes for the literature discovery specialist. It ships with Electron
and runs locally as a child process over standard input/output; end users install
neither Python nor an MCP service. There is no listening port or cloud-hosted
paper MCP. Retrieval of PDFs is not done by this server: the desktop host's
retrieval sequence is described in [delegated literature agents](delegated-literature-agents.md).

```text
discover_papers → discovery specialist ↔ literature_worker host ↔ local stdio MCP → public indexes
retrieve_papers → confirmation card → host retrieval sequence → project/literature/
```

The former `download_papers` route (with `plan_literature_search` and
`select_literature_papers`, enabled by `desktopTools.academicVersion`) was removed.

## Tools

| Tool | Result |
| --- | --- |
| `search_academic_papers` | Up to 20 deduplicated candidates per response, with abstracts, identifiers, per-location versions and open-access evidence, provider status and a cached cursor |
| `get_academic_paper` | Cached metadata by `paper_ref`, or a DOI/title lookup |
| `resolve_paper_full_text` | Matching public locations for a `paper_ref` (unverified until fetched) |

`query` plus up to three `queries` share one 35-second provider budget and at most
20 provider/query jobs. Year filters apply after retrieval. Handles and candidate
sets expire after 30 minutes or when the project closes.

## Providers

Default providers: OpenAlex, PubMed, Europe PMC, Semantic Scholar and Crossref.
arXiv (and the other registered providers: bioRxiv, medRxiv, PMC, CORE, OpenAIRE,
DOAJ, Zenodo, HAL, DBLP, CiteSeerX, IACR, SSRN, Google Scholar) are used when the
specialist requests them, for example arXiv for physics, mathematics or computing.

Normalization keeps OpenAlex's PubMed and PMC identifiers and each location's
declared version (`published`, `accepted_manuscript`, `preprint`), open-access
flag and license. A PMC record is reported as free full text through its PMC
article page; PMC and Europe PMC PDF endpoints are not advertised because they
answer scripts with bot checks. The desktop host retrieves those papers through
PMC's open-data service or the library browser.

No user credentials are loaded. Two application settings reach the server through
the desktop process: `BIODESIGN_CONTACT_EMAIL` (the application's contact
address, sent as OpenAlex `mailto`) and an optional `BIODESIGN_OPENALEX_API_KEY`.
Semantic Scholar runs anonymously and is often rate-limited.

## Building and verification

Use Node 22 or 24 and Python 3.10+ on the build machine. `BIODESIGN_PAPER_PYTHON`
can select the build interpreter. Python dependencies are locked in
`desktop/paper-search/requirements.txt`; the connector code is vendored with its
MIT license and pinned upstream commit.

```bash
npm run paper:build      # PyInstaller bundle in desktop/paper-search/dist/<platform>-<arch>/
npm run paper:smoke
cd desktop/paper-search && .venv/bin/python -m unittest discover -s tests
```

The build checks all provider imports and a real offline MCP protocol exchange;
the packaged-app smoke test launches the bundled server from Electron.
