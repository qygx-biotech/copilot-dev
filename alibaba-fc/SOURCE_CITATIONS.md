# Workspace source links

Assistant answers resolve `[[cite:ID]]`, bracketed handles, bare `local:N`, and an inline code span containing only a catalog handle to registered workspace source links. A short filename appears in chat; hovering shows the full workspace-relative path and clicking focuses the real file in the workspace explorer.

The server resolves aliases using the catalog for that exact request. Saved citations retain the original source ID, path, workspace, and content hash. The app repairs old inline aliases when the answer already contains their saved citation mapping, including the previously unconverted `local:7` example. Missing, ambiguous, changed, or unmapped historical sources show an unavailable reference; the app never guesses using today's catalog order. Code expressions, code blocks, and existing URLs remain unchanged.

## Update the existing dev function

Upload `out/preflight-knowledge-sync/alibaba-fc-citation-handles.zip`. It includes the current image-understanding, paper-card, and streaming runtime along with this citation fix. Keep the existing endpoint, Requesty configuration, authentication, and runtime settings; use the [streaming deployment settings](STREAMING_DEPLOYMENT.md) if streaming is enabled.

The rebuilt Mac app repairs the reported saved answer immediately. Upload this ZIP to ensure future bare or code-formatted aliases are resolved by the backend even when no other citation in the answer supplies their mapping.

## Validation

Tests cover saved inline aliases, bare handles in prose/lists/tables, exact source navigation, unchanged source identities after catalog reordering, unavailable sources, streaming fragments, and final agent responses. The packaged backend smoke uses a local provider fixture, with no live Requesty calls.
