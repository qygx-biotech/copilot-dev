# Wiki generation reliability

The production path is `docs/literature-wiki.js` → authenticated
`/api/knowledge/update-wiki` → `alibaba-fc/wiki-generation.js` → Requesty.
The shared contract is `shared/literature-wiki.js`. Reference repositories are
not part of this path.

## Generation and repair

Prompt version `literature-wiki-markdown-v3` requires independently bracketed
citations, exact supplied references, Markdown without HTML, claim-specific
support, preserved experimental conditions, and cautious treatment of excerpt
boundaries. Evidence, prior prose and embedded instructions are source data.

Before validation, deterministic repair recognizes only this grouping grammar:

```text
[[cite:alpha:p1:c1], [cite:beta:p2:c2]]
→ [[cite:alpha:p1:c1]] [[cite:beta:p2:c2]]
```

Every extracted ID must be an exact supplied reference. Unknown IDs, extra
words, ambiguous groups and other malformed syntax are not guessed or fixed.
Fenced, indented and inline code examples are excluded. Harmless `<br>`,
`<br/>`, and `<br />` variants become spaces in table rows and Markdown line
breaks elsewhere. Other HTML and model-authored links still fail validation.

Validation distinguishes syntax, resolved source provenance, and scientific
support. `claimVerification` remains `not_semantically_verified`, with zero
verified claims. Deterministic checks flag missing continuation citations,
quoted text absent from cited excerpts, and numbers absent from cited excerpts.
Those require review and prevent publication of a new revision until resolved.
Ambiguous layout and clearly disjoint English claim/evidence vocabulary produce
warnings. These checks are heuristics, not entailment verification: derived
numbers, translations, paraphrases, negation and subtle experimental differences
still require checking the original sources. Vocabulary overlap never proves
support. Warnings are retained in integrity metadata and displayed in derived
prose; they do not change canonical source text.

After deterministic repair, one targeted model repair may address validation
failures. It receives the draft, line-level diagnostics and the already bounded,
allowed original evidence, without cards or unrelated existing prose. It is
revalidated using the same checks. There is no separate model claim-review
pass and no regeneration loop. Unresolved or unusable output is retained as an
`unverified_draft` with diagnostics. An empty/oversized repair cannot replace a
usable original draft.

## Configuration and budgets

- `WIKI_MODEL_REPAIR=0` disables model repair. The default permits at most one.
- `WIKI_DEBUG=1` enables metadata-only backend `wiki_generation` console events.
  Frontend `wiki.evidence_prepared` and `wiki.validation` events use the existing
  application debug logger/console.
- Generation and repair share the existing **two total provider HTTP attempts**
  and original backend deadline (normally 300 seconds). If generation already
  consumed both attempts on transient failures, no repair is dispatched.
  Host maintenance cancellation/deadline continues to apply. The repair does
  not create a fresh deadline or automatic retry permission.
- Evidence remains limited to 12 excerpts per paper and 140,000 serialized input
  characters. Adjacent additions are at most 800 characters per neighbor and
  3,600 per paper, reduced further by the remaining full-input allowance. A
  repair payload above the same input ceiling is skipped and the draft retained.
  These existing input admission limits are not provider token measurements.

## Cross-page continuity

Extraction still stores canonical chunks separately per PDF page. Wiki selection
adds bounded head/tail excerpts from physically adjacent chunks, with original
reference IDs and page attribution. It supplies reciprocal `continuity` hints
(`possible_hyphenation`, `possible_sentence`, or `layout_ambiguous`), never a
silently rewritten sentence. For `DNA-` / `protein complexes`, claims relying on
that continuation must retain both references. Missing adjacent evidence does
not authorize inventing a reference or treating a fragment as a complete claim.

Page-number/header/footer and column clues cause ambiguity warnings. PDF text
order and linguistic hyphenation cannot always be recovered from plain text;
these hints are explicitly tentative. No entire page is added just for context.

## Preservation and latency

`generation.audit.outputs` stores each successful provider response's exact
`rawPage`, deterministic repair records, validation results and reported usage.
The published/draft `page` is the separately normalized result. Call audits include
stage, duration and outcome; aggregate usage and provider attempts include repair.
An unavailable repair preserves the original returned draft. Cancellation or a
connection loss can prevent a returned response reaching durable local storage;
there is no new server-side draft database or background continuation.

Existing articles, old prompt-version pages, canonical text, IDs and provenance
are retained. Older compatible Markdown pages remain readable/reusable; this
change does not authorize automatic regeneration. Historical revision and draft
files are retained even when they leave the bounded navigation history. This
uses additional disk space; no automatic deletion of those audit files is added.
No existing project data is migrated or regenerated by this code change.

Deterministic repair and continuity checks run locally and add no inference
calls. A successful first output uses one call. A targeted repair can add one
model-call duration and its input/output tokens; for example, a 40-second initial
call plus a 35-second repair takes about 75 seconds plus transport/local work,
within the original deadline. Actual dollars depend on provider billing; reported
token usage is stored, and missing usage is not a zero-cost guarantee.

Illustrative debug events (durations/counts depend on the request):

```text
wiki_generation {"stage":"generation_end","attempts":1,"elapsedMs":40000,"outcome":"response_received"}
wiki_generation {"stage":"validation","repairCount":2,"repairTypes":["citation_group","markdown_break"],"validationCount":0,"outcome":"formatting_repaired"}
wiki_generation {"stage":"complete","attempts":1,"repairOutcome":"not_attempted","outcome":"references_validated"}
```

Events also include a generated request correlation ID, model, cumulative duration,
reference counts, unresolved-reference counts and possible unsupported-claim counts.
No prompt, evidence text, raw output or credential is logged. Raw output exists only
in the authenticated response and local audit record.
