# Windows binary releases and updates

BioDesign Copilot uses Electron 44, Electron Forge, and the Squirrel.Windows maker. The stable application identity is:

- package and executable: `BioDesign` / `BioDesign.exe`
- installer: `BioDesign-Setup.exe`
- application user model ID: `com.squirrel.BioDesign.BioDesign`
- install root: `%LocalAppData%\BioDesign`

Do not change these values during a routine release. Squirrel treats them as the installed application identity.

## Binary-only update contract

The packaged Windows application never clones, pulls, fetches, or synchronizes a Git repository. It never downloads a GitHub source archive, replaces source directories, or runs a build on the user's computer. The renderer cannot supply a repository, URL, file path, version, or command.

The About dialog's **Check for Updates** action invokes a payload-free IPC method. The Electron main process then:

1. reads public release metadata only from `https://api.github.com/repos/qygx-biotech/copilot-dev/releases?per_page=100`;
2. retains the installed channel: stable versions consider only stable releases, and prerelease versions consider only prereleases;
3. parses the installed `app.getVersion()` value and `v<version>` release tags as semantic versions;
4. rejects drafts, wrong channels, malformed tags, unexpected repositories, duplicate or unsafe asset names, missing assets, non-HTTPS URLs, and noncanonical asset URLs;
5. downloads the small `SHA256SUMS.txt` asset through GitHub's allowlisted release-asset redirect host and validates its strict format;
6. shows the current version, available version, and bounded release notes;
7. downloads only `BioDesign-Setup.exe` after the user chooses **Download and Install**;
8. streams the installer to a unique `.partial` file under Electron's per-user `userData\updates` directory while calculating SHA-256;
9. rejects and deletes an interrupted, wrong-sized, or hash-mismatched download;
10. launches the verified installer as a detached process with `shell: false`, then quits BioDesign.

Squirrel's normal `Setup.exe` path installs its embedded full package into a new versioned application directory and launches the new application. The production launcher therefore passes no command-line option. The existing Windows automation uses `--silent` only for its initial isolated fixture install, where an automatic application launch would interfere with the test.

There is no scheduled or startup update check. No update downloads before user approval. Choosing **Later**, losing network connectivity, receiving malformed metadata, failing a checksum, or failing to launch the installer leaves the installed application files unchanged.

## Release assets

Every release detected by the updater must contain these two uploaded assets:

- `BioDesign-Setup.exe`
- `SHA256SUMS.txt`

The current Forge workflows also publish the standard Squirrel and diagnostic artifacts:

- `RELEASES`
- `BioDesign-<squirrel-version>-full.nupkg`
- `BioDesign-win32-x64-<application-version>.zip`

`SHA256SUMS.txt` contains the lowercase SHA-256 of each payload asset, with two spaces between the digest and filename. GitHub's asset digest, when present, must agree with the installer entry. The installed updater ignores and never downloads the NUPKG, ZIP, or repository-generated source archives.

GitHub release metadata is the small release manifest, so a second `latest.json` format is unnecessary. Using the API avoids maintaining two competing version fields. The canonical application version remains the root `package.json` value, mirrored by the root `package-lock.json`; Forge packages that value and Electron exposes it as `app.getVersion()`.

## User data boundary

Squirrel replaces versioned application files under `%LocalAppData%\BioDesign`. BioDesign data is outside those versioned application folders:

- user-selected project folders contain `.biodesign/workspace.json`, project files, literature, experiments, chat history, jobs, results, workflow state, and workspace caches;
- Electron `userData` contains browser preferences and the updater download directory;
- Electron's logs directory contains `desktop.log`;
- the local QMD cache is under Electron `userData\cache`;
- login credentials are not persisted to release metadata or project JSON; the current web session token is kept in session storage.

The updater does not move, rewrite, or delete these locations. It refuses installation while a project is open or a job is running.

## New-user download

The GitHub Pages application includes a direct **Download for Windows** link:

`https://github.com/qygx-biotech/copilot-dev/releases/latest/download/BioDesign-Setup.exe`

GitHub's `releases/latest` route selects the latest non-prerelease. A beta-only landing page must instead point directly to the approved prerelease tag or resolve the latest public prerelease through a controlled manifest. Users download and run the installer; they do not need repository access or a source checkout.

## Publishing a prerelease

1. Update the root `package.json` and the root `package-lock.json` versions to the same canonical `MAJOR.MINOR.PATCH-beta.NUMBER` value.
2. Commit the intended release changes and push the branch.
3. Run the Windows validation workflow before tagging. It must pass the complete test suite, production dependency audits, Windows x64 package build, ASAR/fuse audit, offline packaged smoke, release identity checks, and the two-version installer update smoke.
4. Create a new annotated tag named `v<package-version>`. Never move or overwrite an existing tag.
5. Push the tag. `.github/workflows/windows-prerelease.yml` builds the Windows x64 artifacts, calculates `SHA256SUMS.txt`, and creates a draft prerelease.
6. Verify the tag, packaged version, Squirrel identity, asset names, asset sizes, `RELEASES`, every SHA-256 entry, and GitHub's asset digests.
7. Publish the existing draft as a public prerelease without changing its tag or verified assets. Drafts are intentionally invisible to installed clients.

Prereleases are currently unsigned and can trigger Windows SmartScreen or an Unknown publisher warning. Do not describe an unsigned prerelease as production-signed.

## Publishing a stable release

1. Change both root version fields to a canonical stable semantic version such as `0.3.0`.
2. Commit, push, validate Windows, create and push the matching immutable `v0.3.0` tag.
3. Run `.github/workflows/windows-stable-release.yml` with that tag and the required confirmation.
4. The protected `windows-production` environment supplies the signing certificate and password only to the ephemeral Windows runner.
5. The workflow builds and verifies the signed installer and application binaries, calculates checksums, and publishes the normal GitHub release.
6. Confirm that `https://github.com/qygx-biotech/copilot-dev/releases/latest/download/BioDesign-Setup.exe` downloads the new installer.

Signing secrets, private keys, API credentials, Alibaba credentials, Requesty credentials, and environment files must never be committed or uploaded as release assets.

## Private source repository and public binaries

GitHub Releases inherit their repository's visibility. The current updater endpoint and workflow use `qygx-biotech/copilot-dev`, which is presently a public source repository. That conflicts with a future requirement to make this source repository private while keeping downloads anonymous.

Before changing the source repository to private, create a dedicated public distribution repository that contains release assets and release notes only. Publish the same immutable tags and verified assets there, then change all three fixed locations in one release:

1. `WINDOWS_UPDATE_REPOSITORY` in `desktop/main/windows-updater.mjs`;
2. the Pages installer link in `docs/index.html`;
3. the GitHub Actions release destination, using a protected narrowly scoped token for the distribution repository.

Publish and verify an initial release in that distribution repository before shipping the client that points to it. The updater itself already needs only anonymous release metadata, `SHA256SUMS.txt`, and `BioDesign-Setup.exe`; it has no dependency on Git data or GitHub source archives.

## Backend deployment

Desktop release publication and Alibaba Function Compute deployment are separate operations. Updater-only changes do not require an FC deployment. If a desktop release also changes shared backend contracts or `alibaba-fc` runtime code, validate and deploy that backend change through its existing process before describing the desktop release as fully compatible. Never copy backend secrets into the desktop package or updater metadata.

## Security limits

SHA-256 detects corruption and substitutions that do not also alter trusted release metadata. It does not protect against compromise of the GitHub repository or release account because the checksum and installer share that trust boundary. Stable builds add Authenticode signing and timestamp verification in the protected release workflow. Prerelease signing is not currently configured.

Electron packages JavaScript in `app.asar`; distributing an Electron installer therefore distributes executable application code even though users never need repository access or source files to install or update. Repository privacy prevents distribution of Git history and development-only files, but ASAR packaging is not source-code encryption.
