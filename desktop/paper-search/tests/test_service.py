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
        records = [normalize(paper(identifier=f'10.1000/{i}')) for i in range(23)]
        records[0]['published_date'] = None
        async def collect(*args, **kwargs):
            return records, {'arxiv': {'status': 'completed', 'returned': 23, 'errors': []}, 'core': {'status': 'failed', 'returned': 0, 'errors': ['RATE_LIMITED']}}
        self.service.collect = collect
        first = await self.service.search('topic', limit=2, year_from=2023)
        second = await self.service.search('topic', limit=2, year_from=2023, cursor=first['next_cursor'])
        self.assertEqual(first['status'], 'partial')
        self.assertEqual(first['filters']['unknown_dates_excluded'], 1)
        self.assertEqual(first['total_candidates'], 22)
        self.assertEqual(len(first['papers']), 20)
        self.assertEqual(len(second['papers']), 2)
        self.assertIsNone(second['next_cursor'])
        self.assertEqual(len({x['paper_ref'] for x in first['papers'] + second['papers']}), 22)
        with self.assertRaises(ValueError):
            await self.service.search('different', cursor=first['next_cursor'])

    async def test_resolver_rejects_nearby_wrong_paper(self):
        original = normalize(paper(source='pubmed'))
        self.service.store(original)
        wrong = normalize(paper(identifier='10.1000/wrong'))
        async def collect(*args, **kwargs): return [wrong], {}
        self.service.collect = collect
        result = await self.service.resolve(original['paper_ref'])
        self.assertEqual(result['status'], 'unavailable')
        self.assertFalse(any(x['kind']=='pdf_candidate' for x in result['papers'][0]['locations']))

    async def test_matching_record_merges_locations(self):
        original = normalize(paper(source='pubmed'))
        self.service.store(original)
        async def collect(*args, **kwargs): return [normalize(paper())], {}
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

    async def test_pmcid_and_alternate_repository_pdf_survive_normalization(self):
        from paper_search_mcp.academic_platforms.openalex import OpenAlexSearcher
        raw = {'id': 'https://openalex.org/W1', 'title': 'Enabling technology and core theory of synthetic biology',
               'doi': 'https://doi.org/10.1007/s11427-022-2214-2', 'publication_date': '2023-02-07',
               'primary_location': {'landing_page_url': 'https://doi.org/10.1007/s11427-022-2214-2', 'pdf_url': 'https://link.springer.com/a.pdf'},
               'open_access': {'is_oa': True}, 'locations': [
                   {'landing_page_url': 'https://www.ncbi.nlm.nih.gov/pmc/articles/9907219', 'pdf_url': 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9907219/pdf/article.pdf'}]}
        result = normalize(OpenAlexSearcher()._parse_item(raw))
        self.assertEqual(result['identifiers']['pmcid'], 'PMC9907219')
        self.assertTrue(result['access'][0]['is_open_access'])
        self.assertIn('https://europepmc.org/articles/PMC9907219?pdf=render', [x['url'] for x in result['locations']])
        self.assertEqual(result['locations'][0]['url'], raw['locations'][0]['pdf_url'])
        self.assertIn('https://link.springer.com/a.pdf', [x['url'] for x in result['locations']])

    async def test_exact_resolution_precedes_repository_search_and_keeps_identifier(self):
        original = normalize(paper(source='pubmed'))
        self.service.store(original)
        calls = []
        async def collect(providers, query, limit, **kwargs):
            calls.append((providers, query, kwargs))
            value = paper(source='europepmc')
            value.extra = {'pmcid': 'PMC9907219', 'is_open_access': True}
            return [normalize(value)], {'europepmc': {'status': 'completed', 'returned': 1, 'errors': []}}
        self.service.collect = collect
        result = await self.service.resolve(original['paper_ref'])
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0][2]['exact'])
        self.assertEqual(calls[0][1], original['doi'])
        self.assertEqual(result['papers'][0]['identifiers']['pmcid'], 'PMC9907219')
        self.assertIn('europepmc:identifier', result['provider_status'])

    async def test_repository_fallback_uses_doi_and_title_with_one_deadline(self):
        original = normalize(paper(source='pubmed'))
        self.service.store(original)
        calls = []
        async def collect(providers, query, limit, **kwargs):
            calls.append((providers, query, kwargs))
            return [], {}
        self.service.collect = collect
        await self.service.resolve(original['paper_ref'])
        self.assertEqual(calls[1][1], [original['doi'], original['title']])
        self.assertIn('pmc', calls[1][0])
        self.assertLessEqual(calls[1][2]['deadline'] - calls[0][2]['deadline'], 20.1)

    async def test_open_access_preference_keeps_other_candidates_and_cursor_binding(self):
        closed = normalize(paper(source='pubmed', identifier='10.1000/closed'))
        available = paper(identifier='10.1000/available')
        available.pdf_url = 'https://arxiv.org/pdf/1234.56789'
        async def collect(*args, **kwargs):
            return [closed, normalize(available)], {'pubmed': {'status': 'completed', 'returned': 2, 'errors': []}}
        self.service.collect = collect
        first = await self.service.search('topic', limit=1, prefer_open_access=True)
        self.assertEqual(first['papers'][0]['doi'], '10.1000/available')
        self.assertEqual(first['papers'][1]['doi'], closed['doi'])
        # An older issued cursor with a one-record slice still resumes unchanged.
        cursor = first['result_set_id'] + ':1'
        second = await self.service.search('topic', limit=1, cursor=cursor, prefer_open_access=True)
        self.assertEqual(second['papers'][0]['doi'], closed['doi'])
        with self.assertRaises(ValueError): await self.service.search('topic', limit=1, cursor=cursor, prefer_open_access=False)

    async def test_doi_lookup_reuses_cache_and_never_accepts_nearby_search_results(self):
        calls = []
        async def collect(providers, query, limit, **kwargs):
            calls.append(kwargs)
            return [normalize(paper(identifier='10.1000/wrong')), normalize(paper())], {}
        self.service.collect = collect
        first = await self.service.metadata(query='https://doi.org/10.1000/example')
        second = await self.service.metadata(query='10.1000/example')
        self.assertEqual(first['papers'][0]['doi'], '10.1000/example')
        self.assertEqual(second['papers'][0]['paper_ref'], first['papers'][0]['paper_ref'])
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0]['exact'])

    async def test_complementary_queries_share_deadline_deduplicate_and_page_without_network(self):
        calls = []
        def worker(provider, query, limit, deadline):
            calls.append((provider, query, deadline))
            own = normalize(paper(source=provider, identifier='10.1000/' + query))
            shared = normalize(paper(source=provider, identifier='10.1000/shared'))
            return [own, shared], {'status': 'completed', 'returned': 2, 'errors': []}
        self.service.worker = worker
        first = await self.service.search('design', queries=['validation'], providers=['pubmed', 'arxiv'], limit=2)
        self.assertEqual(len(calls), 4)
        self.assertEqual(len({call[2] for call in calls}), 1)
        self.assertEqual(first['total_candidates'], 3)
        self.assertEqual(first['metrics']['raw_candidates'], 8)
        self.assertEqual([p['doi'] for p in first['papers']], ['10.1000/design', '10.1000/validation', '10.1000/shared'])
        self.assertIsNone(first['next_cursor'])
        cursor = first['result_set_id'] + ':2'  # Cursor issued by the former two-record initial slice.
        second = await self.service.search('design', limit=2, queries=['validation'], providers=['pubmed', 'arxiv'], cursor=cursor)
        self.assertEqual(len(calls), 4)
        self.assertTrue(second['metrics']['cached_page'])
        self.assertEqual(second['metrics']['provider_jobs'], 0)
        self.assertEqual(second['papers'][0]['doi'], '10.1000/shared')
        with self.assertRaises(ValueError):
            await self.service.search('design', queries=['other'], providers=['pubmed', 'arxiv'], cursor=cursor)

    async def test_handles_stay_stable_across_different_queries_and_later_doi_metadata(self):
        first = normalize(paper(source='pubmed', identifier=''))
        self.service.store(first)
        later = self.service.store(normalize(paper(source='crossref')))
        self.assertEqual(first['paper_ref'], later['paper_ref'])
        self.assertEqual(later['doi'], '10.1000/example')
        self.assertEqual(len(later['providers']), 2)
        conflict = self.service.store(normalize(paper(identifier='10.1000/conflict')))
        self.assertNotEqual(conflict['paper_ref'], later['paper_ref'])

    async def test_query_batch_limits_and_partial_provider_results(self):
        for queries in [[], ['topic'], ['one'] * 4, [None]]:
            with self.assertRaises(ValueError): await self.service.search('topic', queries=queries)
        with self.assertRaises(ValueError): await self.service.search('topic', queries=['other'], providers=list(PROVIDERS))
        def worker(provider, query, limit, deadline):
            if query == 'failed': return [], {'status': 'failed', 'returned': 0, 'errors': ['RATE_LIMITED']}
            return [normalize(paper())], {'status': 'completed', 'returned': 1, 'errors': []}
        self.service.worker = worker
        result = await self.service.search('good', queries=['failed'], providers=['arxiv'])
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(len(result['papers']), 1)
        self.assertEqual(result['provider_status']['q2:arxiv']['errors'], ['RATE_LIMITED'])

if __name__ == '__main__': unittest.main()
