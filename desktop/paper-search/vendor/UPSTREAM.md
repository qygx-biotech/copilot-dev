Vendored from https://github.com/openags/paper-search-mcp
Commit: 234678ab231074a7977320978ee0496dcdaddd1f
License: MIT (LICENSE.paper-search-mcp).
Only anonymous connectors are included. Credential loading is disabled.
The desktop service uses search and metadata methods only; upstream disk-writing download/read methods are never registered as MCP tools.

Local adaptations retain PubMed PMCID identifiers, Europe PMC full-text/access metadata, and OpenAlex alternate locations. The OpenAlex parser is shared by topic search and exact DOI lookup. Resolution and verified file acquisition are implemented by the desktop service and Electron host, rather than upstream disk-writing fallback methods. Upstream credential loading and Sci-Hub/Unpaywall fallbacks remain disabled in this anonymous bundle.
