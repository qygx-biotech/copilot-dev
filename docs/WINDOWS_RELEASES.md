# Windows releases and automatic updates

## Current implementation and identity

BioDesign uses Electron's supported Squirrel.Windows updater architecture.

| Item | Value |
| --- | --- |
| Electron | `44.0.0` |
| Electron Forge | `7.11.2` |
| Main-process entry | `desktop/main/main.mjs` |
| Squirrel lifecycle package | `electron-squirrel-startup@1.0.1` |
| Updater helper | `update-electron-app@3.3.0` |
| Squirrel package identity | `BioDesign` |
| Executable | `BioDesign.exe` |
| AppUserModelId | `com.squirrel.BioDesign.BioDesign` |
| Windows architecture | `x64` |
| Version source | root `package.json` |
| First updater-enabled version | `0.1.6` |
| Stable update repository | `qygx-biotech/copilot-dev` |
| Update host | `https://update.electronjs.org` |
| Runtime endpoint shape | `https://update.electronjs.org/qygx-biotech/copilot-dev/win32-x64/<installed-version>` |

Do not change the Squirrel `name`, executable name, AppUserModelId, or installation identity between releases. These values determine shortcut, taskbar, installation, and update continuity.

For `v0.1.6`, Forge generates these required Squirrel assets under `out/make/squirrel.windows/x64/`:

- `BioDesign-Setup.exe`
- `RELEASES`
- `BioDesign-0.1.6-full.nupkg`

It also generates `BioDesign-win32-x64-0.1.6.zip`. Delta NUPKGs are optional and are never required by the release validator.

## User-visible update behavior

The updater runs only when all of these conditions hold:

- the operating system is Windows;
- `app.isPackaged` is true;
- the entry point is not handling a Squirrel install, update, uninstall, or obsolete lifecycle launch.

The entry point handles Squirrel lifecycle events before loading the application module, creating a window, or starting project/background services. The normal application sets the Squirrel-derived AppUserModelId before readiness.

After the normal UI and project services start safely, BioDesign waits 30 seconds and checks for an update. A `--squirrel-firstrun` launch uses a 10-second delay to allow Squirrel's installation lock to clear. Later checks occur every six hours. Only one check or download can be active; overlapping checks and duplicate download notifications are ignored.

The owner, repository, host, platform, architecture, and installed version determine the feed. The host is HTTPS. Feed configuration cannot come from renderer IPC, preload, project files, localStorage, command-line input, remote model output, or any project data.

An eligible update downloads in the background. BioDesign does not force-close. When the download finishes, it validates that the reported version is a strictly higher stable semantic version and offers **Restart Now** or **Later**:

- **Restart Now** is an explicit user action. If a project is open or a job is running, restart is refused and deferred. Only when no project or job is active does BioDesign call `quitAndInstall()`.
- **Later** does not close the app. Squirrel keeps the update staged and applies it on a subsequent normal restart.

An offline connection, DNS failure, GitHub outage, `update.electronjs.org` outage, malformed response, or updater exception is logged only as a generic event and is nonfatal. Startup and all local project features continue normally. Updater logs omit errors and response details that might contain cookies, tokens, headers, local paths, project contents, or signed download URLs.

## One-time v0.1.5 bootstrap

`v0.1.5` does not contain any updater. A current `v0.1.5` user must manually obtain and run the first updater-enabled signed stable `BioDesign-Setup.exe` once. Installing `v0.1.6` over the existing Squirrel identity is the planned bootstrap. The installer must be signed by the production BioDesign publisher and its SHA-256 value must match `SHA256SUMS.txt`.

After that one manual installation, every eligible higher stable release downloads from the fixed feed; users do not need to visit GitHub or manually download another installer.

## Stable and prerelease channels

`update.electronjs.org` considers only public GitHub releases with valid semantic-version tags that are neither drafts nor prereleases. It also requires the matching Windows installer, `RELEASES`, and full NUPKG assets.

- `.github/workflows/windows-stable-release.yml` is a manually authorized production workflow. It publishes a normal, non-draft, non-prerelease release only after tests, a signed package build, offline packaged smoke, content/fuse audit, Squirrel identity validation, Authenticode/timestamp validation, and checksum generation.
- `.github/workflows/windows-prerelease.yml` remains a separate trusted-tester path for tags such as `v0.1.7-beta.1`. It creates an unsigned draft prerelease. Stable clients ignore it.
- `.github/workflows/windows-update-smoke.yml` contains no release/signing secrets. It builds isolated versions A and B with one test-only Squirrel identity, serves B from a loopback feed, installs A, verifies a background download, performs a normal restart, and verifies that B launches with A's project data.

Every stable package version and tag must be `MAJOR.MINOR.PATCH` and strictly higher than every already published valid version. Never reuse a version or tag, replace assets in place, or publish a downgrade.

## Production signing

Production Windows release builds fail closed unless all required signing values are available. Local developer packaging remains unsigned and must not be described as production-ready.

Configure the protected GitHub environment `windows-production` with required reviewers and these Actions secrets:

- `WINDOWS_CERTIFICATE_BASE64`: the trusted Authenticode PFX encoded as base64;
- `WINDOWS_CERTIFICATE_PASSWORD`: the PFX password;
- `WINDOWS_SIGNING_SUBJECT`: the expected publisher certificate subject (or a unique subject substring) used for post-build verification.

The workflow materializes the PFX only in the ephemeral runner's temporary directory immediately before packaging and deletes it in an always-run cleanup step. The PFX, password, signing subject, GitHub token, and any cloud-signing credentials must never be committed, uploaded as artifacts, printed, or passed to pull-request code. A cloud/HSM signing service may replace the PFX approach only through a separately reviewed Forge-supported signing hook and protected environment; do not add client-side signing credentials.

Forge supplies the same SHA-256 Authenticode configuration to Electron Packager and the Squirrel maker so the packaged executables, native binaries, Update executable, and installer are signed by one publisher identity. Production signatures use an RFC 3161 timestamp. The workflow checks every packaged `.exe`, `.dll`, and `.node` plus `BioDesign-Setup.exe` for a valid signature, the expected publisher subject, and a timestamp.

GitHub Actions permissions default to `contents: read`; only the stable publishing job receives `contents: write`. Checkout/setup actions are pinned to full commit SHAs. The signing workflow has no pull-request trigger and requires manual confirmation plus the protected environment.

## Package and client hardening

Runtime code is packaged in `app.asar`. Native `.node`, `.dll`, `.dylib`, and `.so` files required by QMD/sqlite-vec remain in `app.asar.unpacked`. The packaged Electron binary has these audited fuses:

- `RunAsNode`: disabled;
- `EnableNodeOptionsEnvironmentVariable`: disabled;
- `EnableNodeCliInspectArguments`: disabled;
- `EnableEmbeddedAsarIntegrityValidation`: enabled;
- `OnlyLoadAppFromAsar`: enabled;
- `GrantFileProtocolExtraPrivileges`: enabled because the preserved renderer is loaded with `BrowserWindow.loadFile()` from inside ASAR.

Electron 44 also has a ninth `WasmTrapHandlers` fuse. Forge 7.11.2's supported `@electron/fuses@1.8.0` peer does not name that newer fuse, so it remains at Electron's documented enabled default; the package audit verifies the ninth wire position explicitly. Disabling it is not a requested hardening control and would add WebAssembly bounds-check overhead.

Packaged smoke testing showed that disabling `GrantFileProtocolExtraPrivileges` makes the existing file-protocol renderer fail to resolve `docs/index.html` from `app.asar`. It is therefore not disabled. Migrating the renderer to a privileged custom protocol could allow revisiting that fuse, but such a migration is outside this updater change and must not be approximated by weakening sandbox, CSP, navigation, or IPC controls.

Context isolation, renderer sandboxing, disabled Node integration, disabled production DevTools, restrictive CSP, frozen preload capabilities, denied navigation/window creation, denied permissions, and schema/path-validated IPC remain in place.

The package allow/deny policy excludes Git metadata, CI, desktop tests/scripts, source maps, test/fixture/example directories, development tools, environment files, certificates/keys, the Alibaba FC deployable tree, the Worker tree, obsolete localhost server entry points, backend tests, and unused repository source. The package audit scans ASAR and loose resources and fails on backend source trees, source maps, environment/certificate files, Requesty hosts/configuration, Alibaba credentials, signing secrets, GitHub tokens, or model weights.

## Confidentiality and server-side proprietary value

ASAR is an archive, not a confidentiality boundary. Minification, obfuscation, and client-side encryption also cannot prevent a determined user from inspecting, reverse engineering, or reproducing an installed Electron client. ASAR integrity and Windows code signing protect package integrity and publisher identity; they do not make client code confidential.

Therefore:

- Requesty credentials, Alibaba FC secrets, signing credentials, GitHub credentials, API keys, private prompts, privileged model configuration, authorization rules, and protected datasets must never be packaged in Electron;
- Requesty access and proprietary application logic remain behind authenticated Alibaba FC endpoints with authorization, rate limiting, and input validation;
- no hardware fingerprinting, hidden telemetry, destructive anti-tamper behavior, or client-side secret licensing key is permitted;
- local project data and ordinary offline functionality remain local and are not moved to a server merely for obscurity.

### Current source-repository blocker

`qygx-biotech/copilot-dev` is public and currently tracks `alibaba-fc/index.js` and related deployable backend source, including server-only prompts and privileged model-selection logic. Those files are excluded from the installer, but their presence in a public Git repository means their source is already public. Client packaging cannot repair that exposure.

Before claiming proprietary source protection, move ongoing proprietary source development to a private repository and use a dedicated public binary-only update repository, or deploy a separately secured update service. Because changing the update repository changes the fixed client feed, that repository decision must be authorized and completed before publishing the first updater-enabled stable release. This task does not migrate repositories or rewrite public history.

## Pre-publication validation

On a Windows x64 staging machine or the protected release workflow:

1. Confirm `package.json` has a strictly higher stable version and the tag is exactly `v<version>`.
2. Run `npm ci`, `npm test`, `npm run check`, and production dependency audits.
3. Build with the production signing environment and `npm run desktop:build:windows`.
4. Run `npm run desktop:audit:package`, `npm run desktop:smoke:packaged`, and `npm run desktop:verify:windows`.
5. Run `desktop/scripts/verify-windows-signatures.ps1` with the expected subject.
6. Run `npm run desktop:smoke:update:windows` on Windows. It must report download from A, normal-restart installation of B, and retained project data.
7. Independently inspect `SHA256SUMS.txt`, the Authenticode publisher/timestamp, `RELEASES`, and the full NUPKG identity/version.
8. Confirm the prospective GitHub release is normal (not draft/prerelease) and contains the matching Setup EXE, `RELEASES`, and full NUPKG before making it eligible.

Do not publish if signing is missing/invalid, identities differ, the package audit fails, packaged offline startup fails, or the realistic two-version update smoke has not passed.

## Publishing the first updater-enabled stable release

No release is created automatically by the implementation task. After the repository/source-protection decision and external publisher certificate are ready:

1. Keep the Squirrel identity exactly `BioDesign` / `BioDesign.exe` / `com.squirrel.BioDesign.BioDesign`.
2. Review and merge the updater changes. Confirm the intended first stable version is `0.1.6` and is higher than every published version.
3. Configure protected environment `windows-production`, required reviewers, and the three signing secrets above.
4. Create the annotated or lightweight Git tag `v0.1.6` on the reviewed release commit and push only that tag. Do not create a GitHub release yet.
5. Manually run **Windows x64 stable release** with `release_tag` set to `v0.1.6` and confirmation set to `publish-stable`.
6. Wait for every test, signed build, offline packaged smoke, package/fuse audit, release identity check, signature/timestamp check, and checksum step to pass. The workflow then creates a normal stable GitHub release with `BioDesign-Setup.exe`, `BioDesign-0.1.6-full.nupkg`, `RELEASES`, the ZIP, and `SHA256SUMS.txt`.
7. From a separate Windows machine, verify the checksum/signature and manually install `BioDesign-Setup.exe` over `v0.1.5`. Confirm projects open unchanged.
8. Before the next stable release, run the two-version smoke and a staged update from the signed first updater release to a higher signed candidate using the same publisher identity.

## Rollback and recovery

Squirrel stable updates must never use a lower version. If a stable release is defective, stop promotion/communication as quickly as possible and publish a corrected, signed, strictly higher stable version with the same identity and publisher. Do not replace assets under the existing tag; clients and caches may already hold them.

Users who have a staged bad update should close only after saving/finishing work, then install the corrected higher signed installer if necessary. If the app no longer launches, use the corrected higher `BioDesign-Setup.exe`; do not delete user project folders. Project data lives in user-selected directories and the updater/installer must not remove or rewrite it. Preserve diagnostic logs without tokens, paths, project contents, headers, or signed URLs.
