# SurfDock source-code answer investigation

Investigated on 2026-09-20 on `nanobot/sidechat`. This is an investigation only: application code, the user's project artifacts and conversation, model selection, and deployed services were not changed. No Requesty inference was initiated.

## Finding

The failure occurs after semantic interpretation. Prepared original evidence is available to backend tools, but the first answer-model request contains a source catalog rather than the original passages. The model can omit every reading tool and return a final answer. The application accepts that answer and resolves its file citation without checking whether the cited evidence supports the claim or repository URL.

The supplied planner correctly identifies the source-code question, Chinese answer language, SurfDock paper ID, and workspace-plus-web scope. Its `read`/`search` operations and `read_paper_evidence` hint are advisory; they do not require an actual read before finalization. The model's statement that it needs to check the paper does not execute a tool.

## Observed run and original evidence

The saved conversation in `LocalWork_Test_NewUI` contains the exact question `SurfDock有代码么`, created at 2026-09-20T22:03:13.970Z. Its answer, saved at 22:09:28.762Z, asserts that the paper explicitly provides `https://github.com/S-S-S-S/SurfDock`.

- The saved answer has no web sources or web metadata and reports hosted search unavailable for the selected model.
- The run records one semantic-parser call and one answer-model call.
- Its paper citation resolves to source `11edc790-b681-46f3-b64b-349243767a1d`, with `page: null`. This establishes the file identity, not evidence for the URL.
- Neither the wrong URL nor the correct URL appears in the earlier saved assistant messages. The earlier reviews provide background; the wrong repository address first appears in this answer.
- The existing L1 extraction already contains the actual Code availability section on PDF page 17, chunk `11edc790-b681-46f3-b64b-349243767a1d-P17-C2`. It names `https://github.com/CAODH/SurfDock` and a Zenodo record. No new paper parsing or wiki generation was necessary to locate it.
- A read-only web check confirmed that the paper's GitHub URL now redirects to the public [Intelligent-Drug-Discovery-Lab/SurfDock repository](https://github.com/Intelligent-Drug-Discovery-Lab/SurfDock), which contains code and model weights.

The saved conversation is `.biodesign/chat/agents/1789865290173-01cae80c4ec228/conversations/a5faf6ee-5fd1-44d7-8639-8863e4f073c6.json` in that project. The original extraction is `.biodesign/knowledge/literature/11edc790-b681-46f3-b64b-349243767a1d.md`, under its Page 17 heading. These files were read without modification.

## Execution path

1. `docs/project-context-service.js` constructs the semantic evidence plan and retrieves/completes bounded original evidence. The English goal from this planner includes “source code”, so the short Chinese wording does activate code-availability completion in this case.
2. `alibaba-fc/side-chat-agent.js`, `createSideChatKnowledgeBase`, stores those passages as readable items. `buildSideChatCatalog` supplies metadata to the model; it explicitly calls that catalog metadata rather than evidence. `runSideChatAgent` initially supplies the catalog, semantic context and conversation history, exposing paper-reading functions.
3. `alibaba-fc/requesty-search-stage.js` returns `unsupported` with zero search-model calls when hosted search is unavailable. A scope of `both` requests web research but does not confer a provider capability. Local original evidence remains available.
4. The local-function request exposes tools with no forced reading step. In `runSideChatAgent`, a response with no tool calls reaches `parseFinalAnswer` and `finalData`. Existing corrective continuations enforce some download/academic-workflow actions; they do not enforce original-evidence consumption for this paper question.
5. `resolveSideChatAnswerCitations` resolves `[[cite:local:1]]` to the real PDF. A file-only citation is accepted without a page, inspected passage, or URL-provenance check. The fabricated address remains in the answer, accompanied by a working citation to an unrelated level of evidence.

This is an evidence-consumption and finalization gap. It can occur even when preparation and semantic planning both succeed.

## Local reproduction

A temporary probe used the existing routing fixture, this project's actual extracted chunks, its previous conversation messages, and the supplied semantic interpretation. The stable paper ID was mapped to the fixture ID `P31`. It applied the same semantic normalization before backend sanitization; the `both` scope, named paper and both requested operations remained intact.

Observed results:

| Check | Result |
| --- | --- |
| Original evidence completion | Located the required code-availability passage; no missing dimension |
| Prepared evidence and backend readable items | Both contained the correct repository URL |
| Initial model request | 13 functions exposed, zero tool results, two previous assistant messages |
| Correct URL / Code availability passage in that request | Absent |
| Fixture model response | Wrong repository URL, file-only citation, zero tool calls |
| Application result | `ok: true`, wrong URL retained, citation `resolved`, page null |
| Backend telemetry | One answer call; no model-selected capabilities used |

The probe deliberately supplies an unsupported model answer to test acceptance. It demonstrates the application's failure to reject that answer; it is not a live reproduction of Gemma's generation or a claim about its internal reasoning. The complete serialized Requesty request was not exported, so its exact full prompt was not independently compared byte for byte with the replay.

The existing literature-routing and literature-evidence-recovery suites pass all 30 tests. Their active-agent fixture explicitly makes the model call `read_paper_evidence`; it therefore does not exercise the refusal-to-read path reproduced here. No full build was needed for this read-only investigation.

## Related diagnostic gaps

- Frontend `capabilitiesUsed` adds `search_papers` and `read_paper_evidence` for host preparation, and `docs/app.js` merges these with backend tool telemetry. Seeing those names in saved telemetry does not prove that the answer model called them or received their tool results.
- The backend completion-dimension allowlist in `sanitizeLocalWorkspaceContext` omits `code_availability`. It can discard a missing-code-passage diagnostic even though the local completer produces it.
- The short wording `有代码么` alone is not recognized by the local code-availability rule. The English goal supplied here compensates for that; a separate probe with no useful English interpretation misses the dimension. This is a secondary language-coverage issue, not the cause of the reproduced run with the supplied planner output.
- The semantic normalizer clears the optional `literature.paper_qa` pattern when its operation recipe does not admit `search`. It preserves the requested operations and scope; the saved `finalPattern: null` is therefore not evidence that interpretation was lost.

## Follow-up fix boundary

Retain semantic planning and the existing evidence tools. Require bounded, current original-evidence consumption before finalizing a source-specific availability claim; make a skipped read or missing passage trigger bounded recovery or an explicit limitation. Verify repository addresses against inspected paper passages or returned web sources. Preserve file navigation while distinguishing a valid file target from claim support. Separate host preparation telemetry from model tool execution, and retain code-availability diagnostics through transport. Regression coverage should include an otherwise plausible model answer that skips reading and invents a URL.

No implementation or deployment of those fixes is claimed by this investigation.
