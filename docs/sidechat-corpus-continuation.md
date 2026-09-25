# Corpus evidence continuation

The September 22 desktop log shows successful local collection for all three papers at 00:29:34.002 UTC and a second `/chat` request at 00:29:34.060. The response arrived at 00:30:02.293. The saved failed transcript contains the assistant's `run_corpus_workflow` call and its matching tool result. Collection and the desktop-to-FC handoff therefore completed. A desktop `/chat` request is not proof that Requesty accepted or completed a provider call.

The old FC failure response discarded the provider status, attempts and stop diagnostics, replacing them with an English “safe fallback review” message. The available incident data cannot identify the original upstream rejection or distinguish it from an empty answer or transport failure. It must not be attributed definitively to a quota without that evidence.

## Repairs

- The model receives a compact view of the corpus receipt. Original passages and Paper Card orientation are sent once in `findings.papers`; bundle entries point to them and retain provenance. Repeated reference records are replaced with locations only when their source, hash, page and complete reference exactly match the retained passages. Other derived bundle content stays labeled. The complete receipt remains in the persisted transcript.
- Context recovery sizes its target from the actual attempted messages and retains that reduced budget across transcript reconstruction and subsequent continuations. Previously a 121,000-character retry threshold could leave a smaller failing request unchanged, and reconstructing from the persisted transcript could undo compaction.
- Corpus compaction preserves valid JSON, source IDs, hashes, pages, citation references, coverage and gaps. Shortened excerpts are disclosed. It never slices the result into an invalid JSON prefix or substitutes subset coverage for corpus coverage.
- A confirmed oversized input-token quota returns to the agent compactor without an identical immediate provider retry. The bounded smaller retry respects the reported cooldown and cancellation. This is a conservative character estimate, not a tokenizer or guarantee of provider acceptance. Other quota/HTTP failures remain failures.
- An empty provider answer after corpus collection gets one corrective synthesis attempt. Context/quota recovery and empty-answer recovery are each bounded to one attempt within the existing loop; neither reruns collection or per-paper workers. A persistent failure leaves the turn failed with its evidence retained.
- Side Chat reports task-neutral failure text in the requested language, including safe error code/status and applicable quota/context details. The UI no longer marks this as answer-ready or prepends a successful-review coverage claim. Agent Work's legacy response contract remains unchanged.
- Diagnostics distinguish logical model turns, actual main-agent provider attempts, historical replay and local tools. Configuration catalog requests do not count as provider inference. Errors retain allowlisted protocol identifiers/counts only, never upstream prose, prompts, source text, credentials or model reasoning.

The normal path remains main model → corpus tool → local collection from current knowledge → same selected model for final synthesis. There is no per-paper mapping provider call or new planning gate. Scope, citation resolution, corpus accounting, source reconciliation, cached cards and write protections remain in their existing implementations.

## Verification and deployment

`alibaba-fc/test/corpus-continuation.test.js` runs the production renderer request functions, authenticated FC handler, signed continuation, actual local corpus collection and Requesty HTTP adapter. Provider responses are fixtures. Tests cover the original Chinese request, three English papers, Chinese synthesis, citation navigation metadata, persisted receipts, context/quota compaction, empty responses, provider rejection, transport failure, bounded retries, cancellation and 25-paper compaction. These do not verify live Gemma answer quality or Requesty availability.

The configured development `/health` endpoint was checked during this investigation. It reports `direct-tools-v1` and `evidence-bundle-v1` but lacks the new `runtimeContracts.corpusContinuation: "bounded-synthesis-v1"` marker. Deploy the updated FC runtime using the existing packaging procedure, including all current JavaScript modules and synchronized shared contracts. Rebuilding Electron alone does not update FC. No model/environment configuration change is required.

Renderer assets were rebuilt locally. The already-running development Electron process must be reloaded/restarted to load the frontend failure-reporting changes; packaged clients require a new build. No deployment, application restart or live Requesty synthesis was performed by this investigation.
