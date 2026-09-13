"""Frozen entry point. Stdout contains MCP protocol messages only."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / 'vendor'))
from mcp.server.fastmcp import FastMCP
from service import PaperService

mcp = FastMCP('biodesign-paper-search')
service = PaperService()

@mcp.tool()
async def search_academic_papers(query: str, providers: list[str] | None = None, limit: int = 10,
                                per_source_limit: int = 20, year_from: int | None = None,
                                year_to: int | None = None, cursor: str | None = None,
                                prefer_open_access: bool = False) -> dict:
    """Search anonymous academic providers; return structured records and a bounded-result cursor."""
    return await service.search(query, providers, limit, per_source_limit, year_from, year_to, cursor, prefer_open_access)

@mcp.tool()
async def get_academic_paper(paper_ref: str | None = None, query: str | None = None) -> dict:
    """Read cached metadata or look up a DOI/title. Handles expire after 30 minutes or server restart."""
    return await service.metadata(paper_ref, query)

@mcp.tool()
async def resolve_paper_full_text(paper_ref: str) -> dict:
    """Resolve matching public full-text locations without saving any files."""
    return await service.resolve(paper_ref)

if __name__ == '__main__':
    if '--check' in sys.argv:
        import importlib
        import json
        from service import PROVIDERS
        for provider, class_name in PROVIDERS.items():
            assert getattr(importlib.import_module('paper_search_mcp.academic_platforms.' + provider), class_name)
        print(json.dumps({'providers': list(PROVIDERS), 'credentials': 'disabled'}))
    else:
        mcp.run(transport='stdio')
