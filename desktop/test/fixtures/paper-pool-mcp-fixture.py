"""Production stdio MCP/server with controlled provider responses, never packaged."""
import sys
from pathlib import Path
from datetime import datetime

root = Path(__file__).resolve().parents[2] / 'paper-search'
sys.path.insert(0, str(root))
sys.path.insert(0, str(root / 'vendor'))
from main import mcp, service
from service import normalize
from paper_search_mcp.paper import Paper

jobs = set()
deadlines = {}


def worker(provider, query, limit, deadline, **kwargs):
    # Repeating provider work while traversing cached slices is a test failure.
    assert (provider, query) not in jobs
    jobs.add((provider, query))
    if query in ('design', 'validation'):
        deadlines.setdefault('initial', deadline)
        assert deadline == deadlines['initial']
    start = {'design': 0, 'validation': 10, 'coverage gap': 30}.get(query, 50)
    records = [normalize(Paper(
        paper_id=f'fixture-{i}', title=f'Engineering design and validation study {i}',
        authors=[f'Author {i}'] if '--large' not in sys.argv else [f'Author {i}-{j} ' + 'x' * 180 for j in range(20)],
        abstract=f'Study {i} evaluates design and validation methods.' + ('x' * 6000 if '--large' in sys.argv else ''),
        doi=f'10.1000/pool-{i}', published_date=datetime(2024, 1, 1),
        pdf_url=f'https://arxiv.org/pdf/2401.{i:05d}', url=f'https://papers.example.org/{i}', source=provider,
    )) for i in range(start, start + min(limit, 20))]
    return records, {'status': 'completed', 'returned': len(records), 'errors': []}


service.worker = worker
mcp.run(transport='stdio')
