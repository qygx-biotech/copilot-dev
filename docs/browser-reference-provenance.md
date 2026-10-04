# Browser reference provenance

BioDesign's local Electron host normalizes exact bare/bracketed snapshot references and binds them to its current browser session, owner, Page object, latest registered snapshot, ElementHandle, owning Frame (when available), and Document version. URLs and `f1e66`-style spelling are not identity evidence.

## Installed implementation inspected

The installed `@playwright/mcp` is 0.0.83. Its implementation in `node_modules/playwright-core/lib/coreBundle.js` uses `Tab.captureSnapshot` → `page.ariaSnapshot({ mode: 'ai' })` and `Tab.targetLocators` → `page.locator('aria-ref=…')`. Tool results do not expose an authoritative reference-to-Frame map. Playwright's public `ElementHandle.ownerFrame()` does expose that association.

BioDesign therefore captures on the exact host-owned Page with that same snapshot API, resolves exact `aria-ref` IDs to retained ElementHandles, and reads their ownerFrame. It compares retained Document handles before and after capture. Click/type/select use the retained handle, with the existing advertised tool schemas and host checks, instead of asking MCP to re-resolve an ID after an asynchronous boundary. Article capture uses the same resolver. No general evaluation tool or arbitrary selector is exposed to models.

## Invalidation and race handling

- Frame navigation is checked against actual Document identity; same-document history/hash changes do not invalidate an unchanged element.
- Document replacement invalidates the affected frame and descendants. Detachment and page closure have distinct reasons. Activity in another tab does not clear the active snapshot.
- Target validation checks its owning frame and ancestors; unrelated frames cannot reject a mapped, unchanged target. Ordinary DOM changes do not increment document versions. Removed/replaced elements fail exact-handle connectivity checks.
- Snapshot registration checks all relevant document versions and page navigation events around capture and handle registration. At most three read-only attempts are made. A completed snapshot, load event or delay is never treated as proof of quiescence.
- Rejection diagnostics are copied before refresh. A new snapshot may contain the same ID, but the rejected call stays skipped; only a subsequent explicit call can use the new snapshot. Actions are dispatched at most once. A failure after dispatch has an unknown outcome and is never automatically replayed or reported as a successful observation.

Diagnostics contain host-local session/page/frame/snapshot IDs, version counters and reason codes, not document objects, URLs, cookies or credentials. Ownership, library/login checks, permission bindings, article byte/identity verification and receipt storage remain in their existing host paths. Tool schemas remain native tools; specialist observation messages do not duplicate them.

## Limitations

If a unique ElementHandle exists but its owning Frame is unavailable, the host conservatively validates the page's document set; an unrelated frame document change may then invalidate that reference. If no exact element identity can be established, the action is skipped. Reference spelling is never used to invent frame ownership.

A page that continuously replaces documents can exhaust the observation retry limit. `snapshot_changed_during_capture` or `snapshot_capture_failed` requires a later explicit observation. Public browser APIs do not offer an atomic lock against page activity during input dispatch; retained handles prevent substitution with a new element/document, while post-dispatch failures are reported as unknown outcomes rather than falsely claiming that input was skipped.

The model-facing schema stays compatible with the pinned MCP version. Updating Playwright/MCP requires rerunning the native-schema tests and real Chrome provenance fixture.
