# BioDesign Copilot v0.1.7-beta.2 — Windows x64

This version includes the semantic interpretation and Side Chat fixes committed in `680afa2`, and the Windows validation fixes committed in `8006785`. The earlier `v0.1.7-beta.1` tag remains immutable at `680afa2022cb3b7a2d6c87afe5b6482f7fe14a72`; its failed release gate created no draft.

## Release contract

- Desktop package and both root lockfile version fields: `0.1.7-beta.2`; release tag: `v0.1.7-beta.2`.
- Electron `44.0.0`, Windows x64, Squirrel identity `BioDesign`, executable `BioDesign.exe`, installer `BioDesign-Setup.exe`, and application user model ID `com.squirrel.BioDesign.BioDesign` remain unchanged.
- The updater shipped in `v0.1.6-beta.3` recognizes the newer semantic version and Squirrel package version `0.1.7-beta2`. Stable installations retain their signed stable-only channel; beta checks remain explicit and draft releases remain undiscoverable.
- Required assets are exactly `BioDesign-Setup.exe`, `BioDesign-0.1.7-beta2-full.nupkg`, `BioDesign-win32-x64-0.1.7-beta.2.zip`, `RELEASES`, and `SHA256SUMS.txt`. Verify the full package's SHA-1 and size against `RELEASES`, the four payload hashes against `SHA256SUMS.txt`, and all five assets against GitHub's SHA-256 digests.
- The Electron architecture, permission boundaries, retrieval profiles, source files, workspace/chat schema version 1, and existing update feeds are preserved.

## Validate Windows before tagging

Push the release commit, then dispatch `.github/workflows/windows-update-smoke.yml` on that exact commit. The workflow now runs locked installs, complete and explicit desktop regressions, root/FC syntax checks, all three production dependency audits, Windows Squirrel/ZIP packaging, package/fuse audits, offline packaged QMD smoke, NuSpec/identity verification, and stable/beta Squirrel install/update/restart/retained-data tests. It has read-only repository permissions and creates no release.

Create the new annotated tag only after that exact commit passes the Windows gate. The tag then triggers the unchanged draft-only `.github/workflows/windows-prerelease.yml`. Download and verify its resulting draft independently, including its actual packaged version and compatibility with the updater extracted from the published `v0.1.6-beta.3` package. Leave it as a draft.

The Windows fixes initialize Electron serially before parallel tests and recognize both existing Side Chat scrolling layouts during smoke inspection. Chromium regression checks cover 1500, 1200, and 900 pixel viewports and reject unbounded history. They do not change production UI layout or relax Electron security settings.

## Separate Alibaba FC readiness

The matching FC code is source-ready but this desktop release does not deploy it or establish which commit is live. Full semantic parsing, schema mapping, semantic/provenance context, and server-side Side Chat citations require the matching FC implementation. Deploy the FC entry point, `index.js`, `side-chat-agent.js`, synchronized shared contracts, and locked dependencies from the release commit using a separately named deployment artifact.

The FC lockfile includes the targeted `qs` security update to `6.16.0`; independent backend package versions remain `0.1.0`. Run `npm --prefix alibaba-fc ci`, `npm --prefix alibaba-fc run sync:shared`, the FC tests and production audit when preparing deployment. Optional `REQUESTY_SEMANTIC_PARSER_MODEL` and `REQUESTY_SCHEMA_MAPPER_MODEL` overrides must resolve to models supporting strict `json_schema`. Verify the deployed revision, authenticated semantic endpoints, and a real Side Chat conversation before publishing the desktop prerelease. Unauthenticated health/route checks alone do not establish readiness.

The existing modified `alibaba-fc/Archive.zip` must remain excluded from commits and untouched, with SHA-256 `f01bcc9ebc41daa215250245ffe9d273ceb9f7e17b3aefba4afe4563d1b7e7e6`.

The prior full root dependency audit reported 26 build-tooling advisories, while desktop/FC/QMD production audits were clean and no advisory was attributed to Electron itself. Retain that distinction in the final verification report; do not silently perform broad tooling or architecture upgrades.
