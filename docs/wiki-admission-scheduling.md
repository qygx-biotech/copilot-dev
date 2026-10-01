# Wiki admission and scheduling

The production host path is `docs/request-pipeline.js` →
`LiteratureWikiService.maintain()` in `docs/literature-wiki.js` → the existing
wiki API/generation/repair pipeline. Reference repositories are not involved.

## One admission policy

Automatic updates, explicit updates and incorporation requests all require:

- 2–20 distinct contributing papers, ready original text and current provenance.
- Compatible existing Paper Cards; wiki maintenance does not regenerate cards.
- Exact production input preparation/validation before a new reservation.
- Conservative duplicate-topic filtering and the same hard selected-paper scope.
- Available project page headroom for new pages.

For N current project papers, the page ceiling remains zero below two papers,
otherwise `min(30, max(3, ceil(N / 4)))`. This is a project size policy, not a
scheduling limit. Existing pages, drafts, reservations and historical generation
attempts reserve their slots even above the ceiling. Refreshes do not take new
slots. Above-ceiling projects cannot expand through an explicit request.
Topic labels and preparation-only records are not automatically wiki pages.

Admission uses the actual source checks and input builder. Prepared inputs are
reused at dispatch, with source and publication checks still in place to detect
changes while maintenance runs. Current valid pages need no new model input.
Source races can still invalidate work after admission; such failures retain
the earlier revision and are reported separately from admission rejections.

## Scheduling and latency

The three-generation-request cutoff is removed, with no replacement page-count
cutoff. Processing remains sequential and serialized through the existing queue
and per-page/evidence job deduplication. Each eligible page can be dispatched
once per invocation. Fresh/unattempted pages and eligible timeout recoveries
retain the existing alternating, oldest-attempt-first scheduling order.

The original maintenance deadline is established once (normally five minutes,
or a shorter supplied deadline). Configuration, admission, generation and repair
cannot reset it. The existing duration estimate may defer a call when the
remaining time is unlikely to accommodate it; this is reported as
`insufficient_remaining_time`, separately from `deadlineReached: true`.
Provider cooldowns, cancellation and the existing two-provider-attempt allowance
per page remain in force. Deterministic formatting repairs add no model call;
at most one targeted model repair shares that page's two-attempt allowance.
Completed results and audits remain durable when later work fails or is deferred.

**Maintenance remains foreground work.** The initiating conversation awaits it.
Removing the three-call cutoff can increase latency when more pages are eligible:
five 30-second calls can take about 150 seconds plus local/transport work.
Unchanged valid pages require no generation. No background scheduler was added.
The maintenance deadline bounds provider dispatch/waiting; final local persistence
and reporting may take additional time. A queued invocation also waits for any
already-running serialized maintenance invocation.

## Outcomes and diagnostics

The result includes `counts` for updated, reused, rejected, failed and deferred
pages, plus per-page reason/code, actionable admission diagnostics, pending work,
`deadlineReached`, remaining time and `executionMode: foreground`.

- `existingReservedPageCount`: reserved slots before admission.
- `admittedCandidateCount`: newly admitted slots only.
- `totalReservedPageCount`: reserved slots after admission.
- `topicCandidateCount`: considered topic candidates, including rejected labels.
- `automaticPageCeiling`: historical field name, now shared by all update modes.

`providerAttempts` is null if any relevant provider attempt count is unknown;
`knownProviderAttempts` and `unknownProviderAttempts` retain the known subtotal
and number of responses/failures with unknown counts. A timeout after dispatch
does not establish that the provider never received the request.

`automaticRetryScheduled` is always false. Timeout recovery can be eligible on
a future maintenance invocation after its persisted cooldown; other failures
retain their existing explicit-retry/new-evidence policy. Expiry alone does not
launch work. Rejected candidates need eligibility changes, not a retry loop.

The existing application debug logger records:

```text
wiki.candidate-admission {pageId, stage, eligibilityOutcome, reason, code, durationMs, remainingMaintenanceMs}
wiki.page-stage {pageId, stage: generation, providerAttempts: null, remainingMaintenanceMs}
wiki.page-outcome {pageId, stage, outcome, providerAttempts, providerAttemptsKnown, initialGenerationMs, repairMs}
wiki.maintenance-outcome {outcome, updatedPageCount, reusedPageCount, rejectedPageCount, failedPageCount, deferredPageCount, deadlineReached, automaticRetryScheduled: false}
```

Times unavailable from older adapters remain null rather than being reported as
zero. Backend per-call diagnostics remain controlled by `WIKI_DEBUG=1`; optional
model repair remains controlled by `WIKI_MODEL_REPAIR=0` to disable it. There is no
new scheduling configuration or background retry setting.

Existing project data is not migrated or regenerated. Original articles, drafts,
raw responses, repairs, evidence IDs, locations and provenance remain preserved.
Duplicate filtering is conservative label normalization, not semantic equivalence;
claim-support checks remain heuristic as described in
[wiki generation reliability](wiki-generation-reliability.md).
