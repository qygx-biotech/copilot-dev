# Side Chat editing and citation fixes

Implemented on `feature/open-semantic-intent-ir`. Existing semantic interpretation work and other working-tree changes were preserved. No reset, commit, deployment, or archive rebuild was performed. The pre-existing `alibaba-fc/Archive.zip` change was left untouched.

## Root causes and behavior

- The editor used undefined `--text`, inheriting white text from the user bubble. It now uses `--ink`, an explicit matching caret, and a readable selection color. The existing action button styles remain intact.
- Save used `closest("[data-message-id]")`, which selected the button itself. Save and Ctrl/Cmd+Enter now find the actual `.side-message` container and share one guarded submission path. Only the latest user message is editable. Cancel preserves history; empty input shows an inline error; unchanged text regenerates.
- Editing previously saved truncated history before submitting the replacement and skipped unchanged text. Regeneration now checkpoints retained history plus the replacement question before context preparation or a model request. The obsolete answer is excluded from both history and model context. A failed checkpoint restores the original conversation and edited draft. A request failure retains the replacement for retry. A failed final save keeps the completed answer in memory and shows an error without appending another assistant fallback. Busy state prevents duplicate submissions.
- Answers had no deterministic presentation layer connecting internal catalog/evidence IDs to source identities. The new shared resolver turns explicit citation tokens and registered bracket citations into display links plus stored citation metadata. IDs remain unchanged for tools. Ordinary ID text, Markdown links, inline code, and fenced/indented code are not globally rewritten.

File labels include the locally known workspace name and full relative path, distinguishing nested folders and duplicate filenames. Paper page numbers require a matching current parsed-artifact chunk handle and hash. Experiment references preserve workbook path, sheet, row/range, and available source hash. Model-supplied citation metadata is discarded. Unknown, ambiguous, changed, and missing references are explicitly unavailable. Legacy `local:N` citations without their original metadata cannot safely be mapped to a later request's catalog, so they are shown as unavailable.

Citation clicks focus the verified file in the existing workspace explorer and expand its ancestors without changing evidence selection. Navigation requires agreement among workspace identity, registered source ID/path/hash, and tree membership, followed by the existing workspace-scoped `fileExists` boundary. Workspace identity is checked again after that asynchronous call. Arbitrary model paths and symlink escapes are rejected. No new Electron IPC or filesystem opening capability was added. Absolute project roots remain local.

## Files affected by this fix

| File | Change |
| --- | --- |
| `docs/app.js` | Editor events, guarded regeneration/recovery, citation rendering, snapshot binding, and validated explorer navigation. |
| `docs/styles.css` | Editor text/caret/selection/error styles and inline citation controls. |
| `shared/source-citations.js` | New citation registry, resolution, normalization, labels, persistence metadata, and navigation validation. |
| `docs/project-context-service.js` | Citation persistence, verified page ledger, refreshed source metadata, and experiment hash retention. |
| `docs/source-system.js` | Retain existing experiment source hashes in semantic query results. |
| `alibaba-fc/side-chat-agent.js` | Resolve catalog/evidence IDs on final Side Chat answers and retain verified raw relative paths alongside tool paths. |
| `alibaba-fc/index.js` | Whitelist the page ledger and retained experiment source hashes. |
| `docs/index.html` | Load the shared citation module. |
| `desktop/scripts/sync-renderer-assets.mjs` | Copy the citation module into renderer assets. |
| `alibaba-fc/scripts/sync-shared.mjs` | Include the citation module in FC shared assets. |
| `alibaba-fc/test/source-citations.test.js` | 12 behavioral citation/provenance tests. |
| `alibaba-fc/test/workspace-side-chat.test.js` | Update existing structural assertions for the new submission/rendering signatures. |
| `desktop/test/side-chat-renderer.test.mjs` | Launch isolated Electron renderer verification. |
| `desktop/test/side-chat-fixture/main.cjs` | Load production functions, delegated events, and CSS into sandboxed Chromium with test adapters. |
| `desktop/test/side-chat-fixture/scenarios.js` | 14 editor, failure, rendering, and navigation scenarios. |
| `desktop/test/project-filesystem.test.mjs` | Exercise citation existence checks against real temporary files, missing files, invalid paths, and symlinks. |
| `docs/SIDE_CHAT_FIXES_REPORT.md` | This report. |

Other changes shown by `git diff` predate this fix and were preserved, including semantic modules, benchmarks, and `docs/literature-module.js`.

## Verification

Final `npm test`: **304 passed, 0 failed, 0 skipped** on Node 24.18.1: desktop 54, Alibaba FC 243, local backend 7. This includes the existing Side Chat, source provenance, semantic interpretation, corpus, permission, and Electron security suites. The Electron test contains 14 additional scenario checks within its one test-runner case; these are not counted as 14 extra top-level tests.

The Electron fixture exercised real Chromium DOM click/keyboard events, production editor/submission functions and CSS, and citation rendering/navigation. It checked text, caret, selection, and both buttons using computed colors (minimum tested text contrast 4.5:1), changed and unchanged submissions, Ctrl/Cmd+Enter, cancel, empty input, duplicate submission, initial/final save failures, request failure/retry, missing sources, and a workspace switch during navigation. A captured editor screenshot was visually inspected. Persistence, model requests, source registry, and explorer adapter were mocked in this fixture; no signed-in production Side Chat conversation or live FC/Requesty response was manually exercised.

Separately, the existing full-app smoke workflow loaded the actual renderer and preload and ran real QMD lexical retrieval in an isolated temporary workspace. Renderer loading, layout checks, Light/Medium/High controls, scroll containment, QMD 2.8.3 retrieval, and the Electron sandbox/context-isolation checks passed. Renderer `require` and `process` were unavailable; QMD found the sample source with no native diagnostics. This was an automated smoke check, not a manual end-to-end conversation.

`npm run check`, `npm --prefix alibaba-fc run check`, and `git diff --check` passed. Generated renderer/FC shared assets were synchronized locally. No deployment was performed.
