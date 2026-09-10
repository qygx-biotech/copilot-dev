# Maintained literature wiki (L3)

This adapts the ingest/query/maintenance pattern in [Karpathy's LLM Wiki proposal](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) to the existing local source system. Original paper evidence (L1), canonical Paper Cards (L2), and historical query-specific reviews (L4) retain their existing roles.

## Usage

Source synchronization and Paper Card processing integrate new or changed papers into affected topic pages. Existing compatible cards orient the subject; bounded excerpts from original paper chunks support statements. A subject needs at least two papers before it can become a generated cross-paper page. Existing card topics, methods, and entities supply the subjects; overlapping source dependencies supply related-page links.

Use Side Chat with the desired model selected:

- **“Update the literature wiki.”** Builds eligible pages for an existing library or retries pending/stale updates. Compatible unchanged pages are reused.
- **“Explain the thermostability concept.”** Reads relevant pages through the existing saved-artifact tools. It does not generate a new wiki revision for unchanged inputs.
- **“Incorporate a thermostability comparison into the literature wiki.”** Explicitly integrates an evidence-backed analysis of the named subject through the same validation and publication path. Requests must name an existing subject; unsupported or ambiguous subject matches do not create arbitrary pages. “Incorporate a thermostability analysis into the wiki” updates matching existing subjects without creating a comparison page.
- **“Check the literature wiki.”** Checks a bounded set of pages without rewriting them or making wiki-generation calls.

The existing selected-paper scope applies. A mixed-source page is excluded when it contains papers outside that scope; it is never silently reduced to a misleading selected-paper summary. Wiki commands do not invoke the L4 review-update workflow. Existing whole-library reviews still use the complete-coverage corpus workflow. Questions about saved reviews still read historical L4 artifacts.

## Storage and compatibility

- `.biodesign/knowledge/topics/index.json` remains the authoritative topic index; `index.md` is a compact navigation projection.
- `.biodesign/knowledge/topics/<id>.md` is the searchable wiki projection.
- `.biodesign/knowledge/wiki_pages/<id>/<key>.json` holds immutable generated revisions, keeping the current and previous successful revision. Their timestamps and links provide a minimal per-page history.
- The cache key includes source hashes, canonical card identities (including their existing source, extraction, schema, prompt, and model compatibility), wiki schema/prompt/excerpt versions, the server's opaque model signature, related-page IDs, and any explicitly incorporated analysis request.

Configuration is refreshed through the existing initiating-turn/model/authentication/workspace-scoped configuration facility. Concurrent wiki tasks with different commands, source scopes, cancellation signals, or models are serialized. Repeated unchanged compatible inputs make zero wiki-generation calls and do not rewrite wiki artifacts. A model/version mismatch marks the page stale; an ordinary unchanged-source question does not regenerate it. An explicit update uses the selected model, including any necessary compatible Paper Card preparation.

Generation, validation, cancellation, and index-publication failures preserve the previous valid revision. Changed or removed sources invalidate currentness. If fewer than two supporting papers remain, the old revision stays available only as stale historical material. Original citation handles retain their paper/page/chunk provenance; stale handles are not certified against changed originals. Markdown or search-index failure does not prevent reading a committed JSON page through the local fallback.

## Bounds and validation

Each run attempts at most eight wiki generations. Each page accepts 2–20 papers, up to 140,000 input characters, and a 24,000-character structured output. Input uses compatible card orientation, the retained page, and up to three subject-ranked original chunks per paper plus chunks needed by retained citations (maximum twelve excerpts per paper). Excerpts are capped at 6,000 characters; an update exceeding bounds stays pending/stale. Original L1 content is neither shortened nor replaced. No full wiki/library upload, new storage service, embedding requirement, or graph database is introduced.

Validation requires known original evidence handles and exact quoted substrings, every contributing paper's coverage, valid links, and explicit reported/interpretation/hypothesis labels. Disagreements require distinguishable original sources. Supported previous findings, disagreements, and questions are carried forward when their original sources are unchanged. An update that cannot preserve them within the bounds fails safely.

Quote validation establishes provenance, **not semantic entailment**. Model-reported disagreements are review findings, not guaranteed contradictions. Scientific quality has not been benchmarked. Precise numerical, methodological, and disputed claims still require L1 evidence. Missing or stale wiki coverage requires original retrieval or an explicit limitation.

Read-only maintenance checks at most thirty pages for missing artifacts/sources, broken links, stale source/card/generation dependencies, and unsupported references. It flags existing model-assisted disagreement findings for review; it does not run a separate semantic contradiction detector or rewrite unrelated pages. Larger libraries can leave eligible pages pending; explicit updates process further pending pages within the same bound.

Answer transport retains the existing maximum of four saved artifacts and 12,000 content characters per artifact, with truncation and currentness metadata. Local lexical subject search supplements existing QMD retrieval and works without QMD or a provider connection. Ordinary questions still run the application's existing source synchronization: newly ingested or changed files may therefore compile affected wiki pages before answering.

## Validation evidence

The pre-change shared L3/L4 transport passed all 17 saved-knowledge tests. The previous topic service maintained memberships and placeholder summaries; it made no L3 generation calls.

Synthetic fixtures after this change measure four wiki-generation requests for two papers, zero on an unchanged repeat, and four affected-page requests plus one new Paper Card request when a third related paper is added. A separate unrelated page receives zero update requests. These are logical adapter request counts, not production benchmarks; underlying provider retries may make additional HTTP attempts.

The focused tests cover publication failures, cancellation, incremental dependencies, bounded input/output and maintenance, offline reads, model and workspace isolation, authenticated per-account provider keys, and active-agent consumption with original-paper citations. Existing L4, streaming, history, Agent Command, and Paper Card regressions remain part of the full test suite.

Validation completed: 57 desktop tests, 520 FC/shared frontend tests, and 7 local-backend tests passed (584 total, including 19 focused wiki/provider tests). The full suite passed before the final optional answer-time Paper Card adjustment; the complete FC/shared frontend suite was rerun successfully after that adjustment. `npm run check`, syntax checks for the new modules, and `git diff --check` passed. All provider results in these tests are synthetic; no live-provider or answer-quality benchmark was run.

## Deployment

The frontend assets and FC code must eventually be released together to enable provider-backed generation. The existing packaging scripts include the new shared contract. No new environment variables are required. A frontend talking to an older backend leaves wiki generation unavailable and preserves the existing literature workflows. This implementation does not deploy code or change production settings.
