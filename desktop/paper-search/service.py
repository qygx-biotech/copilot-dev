"""Local, anonymous academic retrieval. MCP transports metadata; Electron owns writes."""
from __future__ import annotations
import asyncio
import concurrent.futures
import hashlib
import importlib
import json
import re
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import asdict
from urllib.parse import urlparse
import requests

PROVIDERS = {
    'arxiv': 'ArxivSearcher', 'pubmed': 'PubMedSearcher', 'biorxiv': 'BioRxivSearcher',
    'medrxiv': 'MedRxivSearcher', 'google_scholar': 'GoogleScholarSearcher', 'iacr': 'IACRSearcher',
    'semantic': 'SemanticSearcher', 'crossref': 'CrossRefSearcher', 'openalex': 'OpenAlexSearcher',
    'pmc': 'PMCSearcher', 'core': 'CORESearcher', 'europepmc': 'EuropePMCSearcher',
    'dblp': 'DBLPSearcher', 'openaire': 'OpenAiresearcher', 'citeseerx': 'CiteSeerXSearcher',
    'doaj': 'DOAJSearcher', 'zenodo': 'ZenodoSearcher', 'hal': 'HALSearcher', 'ssrn': 'SSRNSearcher',
}
DEFAULT_PROVIDERS = ['pubmed', 'europepmc', 'semantic', 'crossref', 'arxiv']
CONTEXT = threading.local()
_request = requests.Session.request


def bounded_request(session, method, url, **kwargs):
    """Bound inherited connector I/O and report errors even if a connector catches them."""
    if time.monotonic() > getattr(CONTEXT, 'deadline', float('inf')):
        raise requests.Timeout('Provider deadline exceeded')
    session.trust_env = False  # No netrc credentials, inherited proxies or .env configuration.
    kwargs['timeout'] = (5, 10)
    kwargs['stream'] = True
    try:
        response = _request(session, method, url, **kwargs)
        chunks, size = [], 0
        for chunk in response.iter_content(65536):
            size += len(chunk)
            if size > 6 * 1024 * 1024 or time.monotonic() > getattr(CONTEXT, 'deadline', float('inf')):
                response.close()
                raise requests.Timeout('Provider response limit exceeded')
            chunks.append(chunk)
        response._content = b''.join(chunks)
        response._content_consumed = True
        response.close()
        if response.status_code >= 400:
            CONTEXT.errors.append('RATE_LIMITED' if response.status_code == 429 else 'PROVIDER_HTTP_ERROR')
        return response
    except requests.RequestException:
        if hasattr(CONTEXT, 'errors'):
            CONTEXT.errors.append('PROVIDER_NETWORK_ERROR')
        raise


requests.Session.request = bounded_request


def doi(value):
    value = re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', '', str(value or '').strip(), flags=re.I).lower()
    return value if re.fullmatch(r'10\.\d{4,9}/\S+', value) else ''


def title_key(value):
    return re.sub(r'[^\w]+', ' ', str(value or '').casefold()).strip()


def safe_url(value):
    value = str(value or '')
    if len(value) > 4096 or re.search(r'[\x00-\x20\\]', value):
        return ''
    try:
        parsed = urlparse(value)
        return value if parsed.scheme in ('http', 'https') and parsed.hostname and not parsed.username and not parsed.password else ''
    except ValueError:
        return ''


def normalize(paper):
    data = asdict(paper)
    title = str(data.get('title') or '').strip()[:1000]
    identifier = doi(data.get('doi'))[:300]
    native_id = str(data.get('paper_id') or '')[:300]
    provider = data['source']
    raw_authors = data.get('authors') or []
    if isinstance(raw_authors, str):
        raw_authors = [raw_authors]  # Preserve names; never split an author's surname comma.
    authors = [str(x)[:200] for x in raw_authors][:100]
    # Keep title-only records distinct across providers until an explicit matching lookup.
    key = 'doi:' + identifier if identifier else provider + ':' + (native_id or title_key(title) + ':' + '|'.join(authors))
    ref = 'paper_' + hashlib.sha256(key.encode()).hexdigest()[:24]
    locations = []
    for field, kind in [('pdf_url', 'pdf_candidate'), ('url', 'landing_page')]:
        url = safe_url(data.get(field))
        if url and not any(x['url'] == url for x in locations):
            locations.append({'url': url, 'kind': kind, 'provider': provider, 'verified_pdf': False})
    date = data.get('published_date')
    date = date.isoformat() if hasattr(date, 'isoformat') else str(date or '')
    date = date if re.fullmatch(r'\d{4}(?:-\d{2}(?:-\d{2}(?:T.*)?)?)?', date) else None
    extra = data.get('extra') or {}
    return {'paper_ref': ref, 'title': title, 'authors': authors, 'doi': identifier,
            'published_date': date,
            'abstract': str(data.get('abstract') or '')[:12000],
            'venue': str(extra.get('journal') or extra.get('container_title') or '')[:500],
            'providers': [{'source': provider, 'paper_id': native_id}], 'locations': locations,
            'evidence_type': 'metadata_abstract', 'retrieved_at': int(time.time())}


def same_paper(left, right):
    if left.get('doi') and right.get('doi'):
        return left['doi'] == right['doi']
    return (len(title_key(left['title'])) >= 25 and title_key(left['title']) == title_key(right['title'])
            and bool(set(title_key(a) for a in left['authors']) & set(title_key(a) for a in right['authors'])))


def merge(left, right):
    for field in ['providers', 'locations']:
        for item in right[field]:
            if item not in left[field]:
                left[field].append(item)
        left[field] = left[field][:8 if field == 'locations' else 20]
    for field in ['doi', 'abstract', 'published_date', 'venue']:
        if not left.get(field):
            left[field] = right.get(field)
    return left


class PaperService:
    def __init__(self):
        self.records = OrderedDict()
        self.sets = OrderedDict()
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=6)

    def store(self, record):
        ref = record['paper_ref']
        if ref in self.records:
            record = merge(self.records[ref], record)
        self.records[ref] = record
        self.records.move_to_end(ref)
        while len(self.records) > 3000:
            self.records.popitem(last=False)
        return record

    def get(self, ref):
        record = self.records.get(ref)
        if not record or time.time() - record['retrieved_at'] > 1800:
            raise ValueError('PAPER_HANDLE_EXPIRED')
        return record

    def worker(self, provider, query, limit, deadline):
        CONTEXT.errors, CONTEXT.deadline = [], deadline
        try:
            # The native preprint APIs accept recent category feeds, not topic search.
            if provider in ('biorxiv', 'medrxiv'):
                cls = getattr(importlib.import_module('paper_search_mcp.academic_platforms.europepmc'), 'EuropePMCSearcher')
                papers = cls().search(f'({query}) AND SRC:PPR AND PUBLISHER:"{provider}"', max_results=limit)
                for paper in papers:
                    paper.source = provider
            else:
                cls = getattr(importlib.import_module('paper_search_mcp.academic_platforms.' + provider), PROVIDERS[provider])
                searcher = cls()
                kwargs = {'fetch_details': False} if provider == 'iacr' else {}
                papers = searcher.search(query, max_results=limit, **kwargs)
            records = []
            for paper in papers:
                try:
                    if paper.title:
                        records.append(normalize(paper))
                except (TypeError, ValueError, AttributeError, KeyError):
                    CONTEXT.errors.append('INVALID_PROVIDER_RECORD')
            errors = sorted(set(CONTEXT.errors))
            return records, {'status': 'partial' if records and errors else 'failed' if errors else 'completed' if records else 'empty_or_unavailable',
                             'returned': len(records), 'errors': errors}
        except Exception:
            return [], {'status': 'failed', 'returned': 0, 'errors': sorted(set(CONTEXT.errors)) or ['PROVIDER_FAILED']}

    async def collect(self, providers, query, limit):
        deadline = time.monotonic() + 35
        futures = [self.pool.submit(self.worker, name, query, limit, deadline) for name in providers]
        tasks = [asyncio.wrap_future(future) for future in futures]
        done, pending = await asyncio.wait(tasks, timeout=36)
        results, statuses = [], {}
        for provider, task, future in zip(providers, tasks, futures):
            if task not in done:
                future.cancel()
                statuses[provider] = {'status': 'failed', 'returned': 0, 'errors': ['PROVIDER_TIMEOUT']}
            else:
                papers, statuses[provider] = task.result()
                results.append(papers)
        # Round-robin interleaving avoids letting the first provider dominate page one.
        merged = []
        for i in range(max([len(x) for x in results] or [0])):
            for batch in results:
                if i >= len(batch):
                    continue
                record = batch[i]
                existing = next((old for old in merged if same_paper(old, record)), None)
                if existing:
                    merge(existing, record)
                else:
                    merged.append(record)
        return merged, statuses

    async def search(self, query, providers=None, limit=10, per_source_limit=20, year_from=None, year_to=None, cursor=None):
        if not isinstance(query, str) or not 1 <= len(query) <= 1000 or not 1 <= limit <= 20 or not 1 <= per_source_limit <= 100:
            raise ValueError('INVALID_ACADEMIC_INPUT')
        providers = providers or DEFAULT_PROVIDERS
        if not providers or any(x not in PROVIDERS for x in providers) or len(set(providers)) != len(providers):
            raise ValueError('INVALID_ACADEMIC_INPUT')
        if any(x is not None and (not isinstance(x, int) or not 1600 <= x <= 2200) for x in [year_from, year_to]) or (year_from and year_to and year_from > year_to):
            raise ValueError('INVALID_ACADEMIC_INPUT')
        signature = json.dumps([query, providers, per_source_limit, year_from, year_to])
        if cursor:
            set_id, offset_text = cursor.split(':')
            entry = self.sets.get(set_id)
            if not entry or entry['signature'] != signature or time.time() - entry['created'] > 1800:
                raise ValueError('SEARCH_CURSOR_EXPIRED')
            offset = int(offset_text)
            if offset < 0 or offset > len(entry['papers']):
                raise ValueError('INVALID_ACADEMIC_INPUT')
        else:
            papers, statuses = await self.collect(providers, query, per_source_limit)
            unknown_dates = sum(not p['published_date'] for p in papers)
            if year_from or year_to:
                papers = [p for p in papers if p['published_date'] and (year_from or 1600) <= int(p['published_date'][:4]) <= (year_to or 2200)]
            papers = [self.store(p) for p in papers]
            set_id, offset = uuid.uuid4().hex, 0
            entry = {'signature': signature, 'created': time.time(), 'papers': papers, 'provider_status': statuses, 'unknown_dates': unknown_dates}
            self.sets[set_id] = entry
            while len(self.sets) > 24:
                self.sets.popitem(last=False)
        batch = []
        while offset < len(entry['papers']) and len(batch) < limit:
            paper = dict(entry['papers'][offset])
            paper['abstract'] = paper['abstract'][:1500]
            if batch and len(json.dumps(batch + [paper])) > 65000:
                break
            batch.append(paper)
            offset += 1
        return {'version': 1, 'status': 'partial' if any(x['status'] != 'completed' for x in entry['provider_status'].values()) else 'completed',
                'papers': batch, 'result_set_id': set_id, 'next_cursor': f'{set_id}:{offset}' if offset < len(entry['papers']) else None,
                'total_candidates': len(entry['papers']), 'provider_status': entry['provider_status'],
                'coverage': 'bounded_candidates; cursor pages cached results, not the entire provider corpus',
                'filters': {'year_from': year_from, 'year_to': year_to, 'method': 'post_filter', 'unknown_dates_excluded': entry['unknown_dates'] if year_from or year_to else 0}}

    async def metadata(self, paper_ref=None, query=None):
        if bool(paper_ref) == bool(query):
            raise ValueError('INVALID_ACADEMIC_INPUT')
        if paper_ref:
            return {'version': 1, 'status': 'completed', 'papers': [self.get(paper_ref)]}
        return await self.search(query, providers=['crossref', 'europepmc', 'arxiv'], per_source_limit=5)

    async def resolve(self, paper_ref):
        record = self.get(paper_ref)
        if time.time() - record.get('resolved_at', 0) > 300:
            candidates, statuses = await self.collect(['europepmc', 'openalex', 'core', 'openaire', 'hal', 'crossref'], record['doi'] or record['title'], 3)
            for candidate in candidates:
                if same_paper(record, candidate):
                    merge(record, candidate)
            record['resolved_at'] = time.time()
        else:
            statuses = {}
        return {'version': 1, 'status': 'completed' if any(x['kind'] == 'pdf_candidate' for x in record['locations']) else 'unavailable',
                'papers': [record], 'provider_status': statuses}
