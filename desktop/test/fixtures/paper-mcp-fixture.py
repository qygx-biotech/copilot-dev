"""Real MCP protocol fixture with deterministic provider data, never packaged."""
import sys
from pathlib import Path
root = Path(__file__).resolve().parents[2] / 'paper-search'
sys.path.insert(0, str(root))
sys.path.insert(0, str(root / 'vendor'))
from main import mcp, service
from service import normalize
from paper_search_mcp.paper import Paper
from datetime import datetime

def worker(provider, query, limit, deadline):
    record = normalize(Paper(paper_id='fixture', title='Academic fixture paper', authors=['A. Author'], abstract='Fixture abstract.',
        doi='10.1000/fixture', published_date=datetime(2024,1,1), pdf_url='https://papers.example.org/fixture.pdf',
        url='https://papers.example.org/fixture', source=provider))
    return [record], {'status':'completed','returned':1,'errors':[]}

service.worker = worker
mcp.run(transport='stdio')
