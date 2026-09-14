# Literature acquisition benchmark

Run from the repository root with the supported Node 22–24 runtime. The four representative requests cover broad AI/synthetic-biology coverage, narrow enzyme-method comparison, Chinese date-constrained retrieval, and sparse evidence where the requested count cannot be met. The suite freezes requests and criteria; it does not impose those topics on production users.

```sh
npm run eval:literature -- --mode=replay --out=/tmp/literature-replay
npm run paper:build
npm run eval:literature -- --mode=collect --out=/tmp/literature-collection
npm run eval:literature -- --mode=live --model=YOUR_CONFIGURED_MODEL --out=/tmp/literature-live
```

Replay exercises the production Agent harness with synthetic records and scripted model decisions. It verifies planning, shortlist gating, pagination, dates, recovery, honest partial completion and metric plumbing. Its relevance scores describe the controlled fixtures, not live LLM quality; downloads are simulated and latency is local test overhead. No paid model is called.

Collect runs the rebuilt local stdio MCP against anonymous public providers. It executes the predeclared complementary query plan and one cached next page, recording candidate metadata, per-provider status, collection/page latency, query coverage and deduplicated counts. It makes no LLM calls and performs no downloads. This separates provider behavior from model quality and cost.

Live uses the production Agent harness, local MCP and Electron download workflow, with an actual model selected by `--model`. It requires `REQUESTY_API_KEY` in the environment; it never reads credential files or prints credentials. The key is for the existing LLM transport, not a paper provider. Public benchmark requests and metadata are sent to that model. PDFs are saved in an isolated temporary project whose path is recorded in the report. The live model receives neither fixture selections nor gold labels. Use `--case=ai-synthetic-biology` to bound a live run to one request. Existing Agent and paper I/O budgets apply.

`report.json` contains observations and raw tool results. Keep baseline and candidate reports in separate new directories, using the same model, prices, request suite and repeat count. Anonymous provider responses vary; record run dates and compare repeated cold runs rather than treating one run as a speed or quality guarantee. Frozen tool transcripts can support review without re-querying providers.

Metrics include shortlist relevance precision, topic coverage, duplicate rate, saved/attempted download rate, wall/search/model latency, model calls and observed input/output tokens. Relevance and coverage stay `null` until every shortlisted DOI (or handle when DOI is absent) has a reviewed label. Do not use the selector's own relevance scores as gold. Supply `--judgments=FILE` for a live run, or rescore a saved report without calling providers:

```sh
node evals/literature/rescore.mjs --report=/tmp/literature-live/report.json --judgments=/tmp/reviewed-labels.json --out=/tmp/literature-scored.json
```

Judgment format: `{ "case-id": { "10.example/doi": { "relevant": true, "topics": ["exact topic from cases.mjs"] } } }`. Review titles and abstracts against the original request, publication dates and topic criteria. Record excluded and uncertain cases as well as selected papers; double-review disagreements when comparing models. Missing labels are unknown, not irrelevant. Empty shortlists have undefined precision. A sparse but relevant shortlist may have high precision and low coverage/completion; inspect all metrics together.

For token-based estimates, pass `--input-usd-per-million=NUMBER --output-usd-per-million=NUMBER` to live or rescore. Rates must come from the model configuration being evaluated. Incomplete usage leaves cost unknown. These are estimates, not billing invoices; no price is inferred from text length, latency or a model's name. Provider-query jobs, download attempts, and model calls are distinct counters.
