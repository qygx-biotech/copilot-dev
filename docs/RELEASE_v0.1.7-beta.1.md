# BioDesign Copilot v0.1.7-beta.1 — Windows x64

This release includes open semantic interpretation, canonical experiment fields and units, and the Side Chat editing, regeneration, persistence, and verified source citation fixes. See [semantic implementation](SEMANTIC_INTENT_IMPLEMENTATION_REPORT.md) and [Side Chat fixes](SIDE_CHAT_FIXES_REPORT.md) for behavior and limitations.

## Upgrade contract

- Desktop package version and root lockfile versions: `0.1.7-beta.1`; tag: `v0.1.7-beta.1`.
- Electron remains `44.0.0`; target remains Windows x64. Squirrel identity remains `BioDesign`, executable `BioDesign.exe`, installer `BioDesign-Setup.exe`, and application user model ID `com.squirrel.BioDesign.BioDesign`.
- The updater module and Forge configuration are unchanged from `v0.1.6-beta.3`. The new version sorts after `0.1.6-beta.3` and maps to Squirrel version `0.1.7-beta1`.
- Exactly five release assets are required: `BioDesign-Setup.exe`, `BioDesign-0.1.7-beta1-full.nupkg`, `RELEASES`, `SHA256SUMS.txt`, and `BioDesign-win32-x64-0.1.7-beta.1.zip`.
- `RELEASES` must contain one full-package entry with its SHA-1 and exact byte size. `SHA256SUMS.txt` must contain the four other assets and agree with their bytes and GitHub digests.
- Beta discovery remains an explicit action in packaged Windows prereleases. Stable installations retain their existing signed stable-only channel. A draft is intentionally undiscoverable; publication is a separate maintainer action.
- Workspace and chat schema versions remain 1. Semantic mappings and citation/telemetry metadata are additive derived data in the existing workspace format. Source files, retrieval profiles, permission boundaries, and the Electron IPC architecture are preserved.

## Alibaba FC deployment dependency

Matching FC deployment is required for the complete release behavior. This release does **not** deploy FC or establish that the matching backend is live.

On 2026-09-05, the configured FC endpoint returned HTTP 200 for `/health` and HTTP 401 for unauthenticated requests to both semantic routes. This establishes endpoint reachability and protected route presence, but does not identify the deployed commit or validate its model configuration and citation behavior.

Deploy `alibaba-fc/index.js`, `side-chat-agent.js`, the existing FC entry point, locked dependencies, and synchronized shared contracts from this release commit. Run `npm --prefix alibaba-fc ci` and `npm --prefix alibaba-fc run sync:shared` when preparing a separately named deployment artifact. Do not overwrite the existing `alibaba-fc/Archive.zip`.

The matching backend adds authenticated `POST /api/semantic/interpret` and `POST /api/semantic/map-schema`, accepts the new bounded semantic and provenance context, and resolves Side Chat citations. `REQUESTY_SEMANTIC_PARSER_MODEL` and `REQUESTY_SCHEMA_MAPPER_MODEL` are optional overrides; their selected models must support strict `json_schema` output. Existing authentication, Requesty routing, and tool permissions remain in force. Missing parser support falls back to local interpretation, but an older backend does not provide the full semantic/tool/citation behavior. Verify authenticated requests and a real Side Chat conversation after deployment and before publishing the desktop prerelease.

The FC lockfile updates only transitive `qs` from `6.15.3` to `6.16.0`, fixing [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) and [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g). Backend package versions retain their independent `0.1.0` versions.

## Release validation

Local validation uses Node 24.18.1. All 304 regression tests pass (desktop 54, FC 243, local backend 7), including 14 Chromium Side Chat scenario checks within one desktop test. Root and FC syntax checks, the semantic benchmark, the real Electron/QMD lexical smoke check, and all three production dependency audits pass. Provider behavior is covered with mocks; live FC/Requesty behavior still requires deployment validation.

The tag-triggered `.github/workflows/windows-prerelease.yml` is the Windows release gate: locked installs, complete and explicit desktop regressions, dependency audits, x64 Squirrel/ZIP packaging, packaged-content and fuse audits, packaged smoke, NuSpec identity/version validation, checksums, and draft prerelease creation. Download and independently inspect its resulting assets, and test their metadata through the updater shipped in `v0.1.6-beta.3`, before treating the draft as validated. The separate Windows update smoke workflow exercises Squirrel installation, background download, Later, restart, and retained data with isolated fixtures.

The pre-existing modified `alibaba-fc/Archive.zip` is excluded from this release commit and retained byte-for-byte with SHA-256 `f01bcc9ebc41daa215250245ffe9d273ceb9f7e17b3aefba4afe4563d1b7e7e6`.
