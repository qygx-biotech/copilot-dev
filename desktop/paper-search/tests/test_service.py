import asyncio
import sys
import unittest
from pathlib import Path
from datetime import datetime
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor'))
from service import PaperService, PROVIDERS, normalize, merge, same_paper
from paper_search_mcp.paper import Paper


def paper(source='arxiv', identifier='10.1000/example', title='A sufficiently specific paper title for matching'):
    return Paper(paper_id='123', title=title, authors=['A. Author'], abstract='Abstract', doi=identifier,
                 published_date=datetime(2024,1,1), pdf_url='https://example.org/paper.pdf' if source=='arxiv' else '', url='https://example.org/paper', source=source)


class RetrievalTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.service = PaperService()

    async def asyncTearDown(self):
        self.service.pool.shutdown(wait=False, cancel_futures=True)

    async def test_pagination_filters_and_provider_failures_are_explicit(self):
        records = [normalize(paper(identifier=f'10.1000/{i}')) for i in range(5)]
        records[0]['published_date'] = None
        async def collect(*args):
            return records, {'arxiv': {'status': 'completed', 'returned': 5, 'errors': []}, 'core': {'status': 'failed', 'returned': 0, 'errors': ['RATE_LIMITED']}}
        self.service.collect = collect
        first = await self.service.search('topic', limit=2, year_from=2023)
        second = await self.service.search('topic', limit=2, year_from=2023, cursor=first['next_cursor'])
        self.assertEqual(first['status'], 'partial')
        self.assertEqual(first['filters']['unknown_dates_excluded'], 1)
        self.assertEqual(first['total_candidates'], 4)
        self.assertIsNone(second['next_cursor'])
        self.assertEqual(len({x['paper_ref'] for x in first['papers'] + second['papers']}), 4)
        with self.assertRaises(ValueError):
            await self.service.search('different', cursor=first['next_cursor'])

    async def test_resolver_rejects_nearby_wrong_paper(self):
        original = normalize(paper(source='pubmed'))
        self.service.store(original)
        wrong = normalize(paper(identifier='10.1000/wrong'))
        async def collect(*args): return [wrong], {}
        self.service.collect = collect
        result = await self.service.resolve(original['paper_ref'])
        self.assertEqual(result['status'], 'unavailable')
        self.assertFalse(any(x['kind']=='pdf_candidate' for x in result['papers'][0]['locations']))

    async def test_matching_record_merges_locations(self):
        original = normalize(paper(source='pubmed'))
        self.service.store(original)
        async def collect(*args): return [normalize(paper())], {}
        self.service.collect = collect
        result = await self.service.resolve(original['paper_ref'])
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(len(result['papers'][0]['providers']), 2)
        self.assertIsInstance(result['papers'][0]['authors'], list)
        self.assertFalse(result['papers'][0]['locations'][0]['verified_pdf'])

    async def test_no_credentials_loaded(self):
        from paper_search_mcp.config import get_env
        with patch.dict('os.environ', {'CORE_API_KEY':'must-not-load','PAPER_SEARCH_MCP_SEMANTIC_SCHOLAR_API_KEY':'secret'}):
            self.assertEqual(get_env('CORE_API_KEY',''), '')
        self.assertNotIn('unpaywall', PROVIDERS)
        self.assertNotIn('sci_hub', PROVIDERS)
        self.assertNotIn('ieee', PROVIDERS)

    async def test_connector_string_dates_and_author_names_remain_structured(self):
        value = paper(source='hal')
        value.published_date = '2024'
        value.authors = ['Surname, First', 'Another Author']
        result = normalize(value)
        self.assertEqual(result['published_date'], '2024')
        self.assertEqual(result['authors'], value.authors)
        value.published_date = 'not a date'
        self.assertIsNone(normalize(value)['published_date'])

    async def test_doi_in_abstract_is_not_used_as_paper_identity(self):
        from paper_search_mcp.utils import extract_doi
        self.assertEqual(extract_doi('We compare against 10.1000/other.'), '')
        self.assertEqual(extract_doi('https://doi.org/10.1000/paper'), '10.1000/paper')

    async def test_expired_handle_and_invalid_inputs(self):
        with self.assertRaisesRegex(ValueError,'PAPER_HANDLE_EXPIRED'):
            await self.service.metadata(paper_ref='paper_'+'0'*24)
        with self.assertRaises(ValueError): await self.service.search('topic', providers=['ieee'])
        with self.assertRaises(ValueError): await self.service.search('topic', year_from=2025, year_to=2020)

    async def test_malformed_provider_record_does_not_drop_other_candidates(self):
        valid = paper()
        invalid = paper()
        invalid.extra = 'malformed'
        with patch('paper_search_mcp.academic_platforms.arxiv.ArxivSearcher.search', return_value=[invalid, valid]):
            records, status = self.service.worker('arxiv', 'topic', 10, float('inf'))
        self.assertEqual(len(records), 1)
        self.assertEqual(status['status'], 'partial')
        self.assertIn('INVALID_PROVIDER_RECORD', status['errors'])

if __name__ == '__main__': unittest.main()
