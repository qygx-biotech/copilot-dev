# Side Chat wiki and planner compatibility

Implemented on the existing `nanobot/sidechat` working tree. Earlier branch changes, the L0–L4 literature architecture, source-write permissions and recommendation-write permissions are preserved. This report distinguishes local verification from the code currently running in the app and cloud.

## Cause and correction

The combined-text Paper Card endpoint previously chose `json_object` whenever strict schemas were unavailable, even if the capability registry did not advertise object mode. The semantic planner correctly required an advertised structured mode and therefore rejected Gemma locally with zero provider attempts. Both endpoints now use the same exact-model capabilities. `google/gemma-4-31b-it` has an object-only default based on the observed successful cards; per-model deployment configuration can override it. Unknown models do not acquire support from a provider-family or planner-profile label. Strict-schema models retain strict mode and the existing narrowly targeted object-mode retry. Captured model selections, including Default, take precedence over optional planner profiles.

The wiki endpoint now requests plain Markdown, with no provider JSON response format, fixed sections or statement objects. The application stores page identity, configuration, contributing source/card dependencies, content hash and generation accounting outside the prose. The existing version-one page reader and quote validator remain for saved pages.

Every working citation must resolve to an exact supplied evidence reference and subsequently to a current project paper/chunk. The host checks physical source bytes, registry versions, canonical card identities and page hashes before publication and reuse. It excludes failed/stale pages from current answer context; historical revisions remain readable. Headings, table headers and questions need no citation. Uncited passages receive visible unverified labels. Reference resolution is not semantic entailment: these pages receive zero automatically verified claims, and L1 remains authoritative for scientific conclusions.

Wiki failures enter the knowledge-maintenance report as L3 failures, including bounded validation details. They do not invalidate successful compatible Paper Cards or block the corpus review. A failed semantic interpretation retains the maintenance report and no longer claims source preparation never began. Diagnostics distinguish logical endpoint calls, configuration requests, known provider attempts, responses with unknown attempt counts and local processing.

## Verification completed

| Check | Result |
| --- | --- |
| `npm --prefix alibaba-fc test` | 786 passed, including localhost streaming regressions |
| Desktop renderer adapters, frontend adapters and chat history | 25 passed |
| `npm run desktop:prepare` | Shared assets copied and React renderer built successfully |
| `npm run check` and `npm --prefix alibaba-fc run check` | Passed |
| `git diff --check` | Passed |
| Deployment ZIP | 2,546 entries; CRC validation passed; executable bootstrap and updated contracts confirmed |

Focused tests cover natural Markdown tables/paragraphs, visible unsupported passages, citation resolution and navigation to the host paper/page, fabricated/malformed/out-of-scope references, deleted and physically modified sources, changes during publication, legacy saved pages, cached cards, model isolation, provider rejection versus unsupported capability versus invalid output, partial wiki maintenance and source/recommendation protections.

The fixture for **“帮我总结所有文献，写个综述。”** uses English source text and the real authenticated FC handler, object-mode planner adapter, canonical validation, local corpus workflow and final-answer loop. Four fixture wiki provider requests fail citation validation; one semantic request succeeds; all three compatible cards feed the real corpus workflow without regeneration; one fixture final-answer request produces a cited Chinese review. Selected-paper scope validation is tested separately on the Gemma object-mode route and existing corpus/Side Chat regressions. These counts describe fixture calls, not a fixed production call budget. More tool rounds, transport retries, missing cards or different topic memberships can change actual counts.

All model outputs in automated tests are fixtures. No new live Requesty inference was performed, and these tests do not establish Gemma's live answer quality or account entitlement.

## Request-driven recovery extension

The subsequent recovery change is also on `nanobot/sidechat`. New Side Chat requests consider missing, failed and stale wiki pages after source reconciliation, including when no files changed. Current compatible pages, L1 artifacts and Paper Cards are reused. The topic index persists pending work, incorporated analysis intent, source/configuration versions, failure details, cooldown eligibility and the last four attempts. Failed publication preserves the prior successful revision; interrupted attempts remain pending across restarts. Projection failures can be repaired locally from committed JSON.

Each pass starts at most eight wiki generations and stops starting additional page updates after a five-minute budget. An active provider call keeps its existing transport timeout and bounded retries. Failed inputs back off from one minute to one hour, honoring longer provider Retry-After values; rate limits apply across pages using that model. Concurrent passes and same-page/input jobs are deduplicated. Unattempted subjects get priority over repeated failures. Deferred work remains pending; there is no background retry timer.

Final recovery validation: **797 FC/shared frontend regression tests and 25 desktop adapter/history tests passed**. The 30 wiki tests include restart recovery, unchanged requests, concurrent requests, cooldown persistence through temporary configuration failures, rate limits across restarts, source/configuration changes, missing pages, bounded and fair maintenance, cancellation, failed publication, projection recovery and source/scope protections. `desktop:prepare`, root/FC checks, changed-module syntax checks and `git diff --check` passed.

The expanded Chinese fixture first encounters four wiki validation failures and completes a review using the three cached cards. An immediate unchanged request makes no wiki provider calls during cooldown. After cooldown, another unchanged request repairs all four pages, passes semantic interpretation again and re-enters the corpus workflow with the same three cards. Across that fixture: eight wiki provider calls, two semantic calls and one final-answer call; all provider responses are synthetic. This is not live Requesty verification.

This extension changes frontend maintenance code and tests; it adds no FC runtime change beyond the preceding compatibility fix. The runtime observations below were made during the earlier compatibility inspection, not rechecked after this extension. No app reload or deployment was performed. The development app must load the updated frontend, and the previously identified FC compatibility deployment plus an authenticated live rerun remain deployment/verification steps. The existing backend ZIP was not replaced.

## Live runtime inspection

The running development Electron process (PID 6593) loads this checkout's `docs/desktop.html`. Its developer console reported:

```json
{"wiki":{"schemaVersion":1,"promptVersion":"literature-wiki-v1","evidenceVersion":"wiki-excerpts-v1"},"oldPlannerDiagnostic":true}
```

The existing failed conversation remains intact. Its logs confirm wiki failures omitted from maintenance failure counts and a semantic failure with `structured_output_unsupported` and zero provider attempts. The window was inspected, not reloaded or resubmitted. Rebuilding assets on disk did not update that loaded window.

The [development FC health endpoint](https://biodesidev-base-nkindwwsvf.cn-beijing.fcapp.run/health) returned:

```json
{"ok":true,"service":"BioDesign Copilot Alibaba FC","streamingSupported":false}
```

It lacks the new `runtimeContracts` marker. The deployed development backend therefore does not contain this update. Other deployment environments were not inspected. No cloud code, credentials, runtime settings or project source files were changed during inspection.

## Deployment still required

The prepared working-tree package is `out/sidechat-wiki-compatibility/Archive-sidechat-wiki-compatibility-2026-09-19.zip`, with adjacent `.manifest.json` and `.zip.sha256` files. It includes current runtime helpers, synchronized shared contracts, HTTP adapter, executable bootstrap, dependency manifests and installed production dependencies. No environment files or credentials are packaged. Previous archives are preserved.

SHA-256: `b79816bf1e57f23e90cf1854d4cdc56db6c5df2474da51ea32c5dfa3a72b47cd`.

1. Deploy this ZIP to the existing development FC function using the current runtime, handler, endpoint, authentication and model configuration. No new environment variable is required. Existing per-model capability overrides remain authoritative; check for an explicit Gemma object-mode disable if a capability error persists.
2. Confirm `/health` contains `runtimeContracts.literatureWiki = literature-wiki-markdown-v2` and `runtimeContracts.semanticPlanner = model-capabilities-v2`.
3. Reload/restart the development Electron app. Confirm `BioDesignLiteratureWiki.VERSION.promptVersion` is `literature-wiki-markdown-v2`. A distributed desktop app needs a rebuilt release separately.
4. With the existing three-paper project and Gemma selected, resubmit **“帮我总结所有文献，写个综述。”**. Verify successful card reuse, a real semantic `json_object` request, the corpus workflow, a Chinese final review and working paper/page citations. After cooldown, an ordinary new Side Chat request now retries eligible failed pages without forcing card regeneration. An explicit “Update the literature wiki” request uses the same bounded recovery policy.
5. Compare the application’s provider-attempt accounting with the corresponding Requesty account usage. Inspect actual Markdown and scientific grounding against original papers. This authenticated rerun is still needed before declaring the issue fixed in the deployed app.
