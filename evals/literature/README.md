# Literature benchmarks

Two model-free checks for the literature pipeline. Run from the repository root
with Node 22–24 after `npm run paper:build`.

```sh
npm run eval:literature -- --mode=retrieval --out=/tmp/literature-retrieval
npm run eval:literature -- --mode=retrieval --headed --proxy=https://ezproxy.example.edu/login?url= --out=/tmp/with-proxy
npm run eval:literature -- --mode=collect --out=/tmp/literature-collection
```

**Retrieval** runs the production host retrieval sequence (`LiteratureWorkflows`:
local PDFs → official open copies → publisher pages in the library browser) on the
frozen DOI set in `cases.mjs` (`retrievalDois`), or on `--dois=a,b,c`. Metadata
comes from OpenAlex, as discovery would hand it over. The report lists each
paper's host-verified status, route, version and time, the access request the job
would show, and a summary (`score.mjs`). Chrome runs headless unless `--headed`;
headless Chrome is flagged by some bot checks that a visible window passes.
`--library-url` and `--proxy` set library access as the app's settings would.
Results depend on the network: an institutional network reaches subscription PDFs
without any sign-in.

**Collect** runs the four predeclared search plans through the local paper MCP and
one cached next page, recording candidates, provider status and latency.

Neither mode calls a model or records relevance judgments. Model behavior is
covered by `alibaba-fc/test/literature-*.test.js` with scripted models.
`RESULTS-2026-09-13.md` documents the earlier, removed `download_papers` route.

## Model-in-the-loop bridge

`model-bridge.cjs` runs one Agent Work turn through the production renderer turn
code, agent loop, FC model proxy, literature host, paper MCP and Chrome, with the
model replaced by a loopback HTTP queue. Whoever stands in for the model reads each
request with `GET /pending` and answers with `POST /respond`. The confirmation card
is approved automatically; `WAIT_MODE=continue` also continues access dialogs.

```sh
QUERY="Find 3 recent papers on machine-learning-guided enzyme engineering and download them." \
  node evals/literature/model-bridge.cjs
LIBRARY='{"url":"https://library.example.edu","proxy":"https://ezproxy.example.edu/login?url="}' WAIT_MODE=continue \
  QUERY="Download doi 10.1126/science.1225829." node evals/literature/model-bridge.cjs
```

The log (`BRIDGE_LOG`, default in the temporary directory) records every model
answer, host step, card, access dialog and the final outcome. On 2026-10-14 a
Claude Haiku stand-in completed both flows above: three open-access papers
discovered and saved (5 model calls, 124 s), and, for two named papers behind
publisher bot checks in headless Chrome, three access rounds followed by catalogue
browsing in the library and an accurate report that both still needed a check.
