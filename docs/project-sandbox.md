# Project sandbox

Status: plan approved 2026-10-07 on branch `codex/combined_cc`. Stages 1–4 implemented (uncommitted); the Stage 4 archive still has to be published (see below). Stage 5 next.

## Goal

Let Agent Work run commands and code on the open project folder, the way Codex runs `exec_command` and `apply_patch` on its workspace, inside an OS sandbox. A typical task: "analyse my fermentation CSVs and write a report and a figure into `output/`". Today the execution tools only reach an empty scratch folder, so that task is impossible (section 2 of the Codex comparison).

The local checkout under `codex/` is the behavioural reference: `codex-rs/sandboxing/src/seatbelt.rs` and `seatbelt_base_policy.sbpl` (macOS), `codex-rs/windows-sandbox-rs/` (Windows), and `codex-rs/utils/pty/src/process_group.rs` (process cleanup).

## Decisions

1. **Write scope:** `output/` only. `literature/`, `experiments/`, `data/` and every other folder stay read-only, so primary evidence is never overwritten. Approving other folders one path at a time comes later, with per-action approval.
2. **Read scope:** the project folder without `.biodesign/`, plus the system and runtime paths a process needs. No home folder, no other folders. `.biodesign/` holds chat history, receipts, archives and generic MCP credentials (`.biodesign/runtime/mcp.json`).
3. **Network:** off, with no exceptions. There is no `pip install`; the runtime ships a fixed package set.
4. **Python runtime:** downloaded on first use, versioned separately from the app, published as a release asset next to the app releases, and pinned by SHA-256 in the app. Using an existing Python on the machine may be added later as an advanced setting.
5. **Windows:** macOS first. Windows follows with Codex's Windows sandbox helper (Apache-2.0), shipped as an extra resource like `paper-search-server`, after a short trial of its one-time administrator setup.
6. **Approval and surfaces:** one approval per turn, Agent Work only (`workspace_write` or `full_access`). The prompt states: run code in this project for this turn, read project files, write only `output/`, no network. Per-command approval belongs with the permissions work.

## Constraints that must survive

| Constraint | How it is preserved |
|---|---|
| Primary evidence is never modified by the model | Kernel-enforced write scope (`output/` only); hard links and writes through symlinks are denied by the kernel (verified below). |
| Generated material is never cited as primary evidence | Every file created or changed in `output/` is recorded with its turn and hash; the source registry marks it `generated` (Stage 3). |
| No secrets reach the sandbox | `.biodesign/` is unreadable; the environment is rebuilt from an allowlist (no tokens, no provider settings); `HOME` and `TMPDIR` point to a private per-turn folder. |
| Turn-scoped authority | The grant lives with the runtime owner of one turn, as scratch execution does today. Closing the turn kills its processes and removes its private folder. |
| Durable receipts, no replay of uncertain effects | Calls keep going through `AdvancedRuntimeService.call`, which writes `.biodesign/runtime/tool-receipts/` before and after each effect. |
| Existing scratch mode unchanged | Scratch execution keeps its policy (no project, no forks) and its tests. |

## Current state

- `desktop/services/scratch-runtime.mjs` builds a deny-by-default seatbelt profile whose only readable and writable user folder is a private temp root. It has no `process-fork`, so pipelines and Python multiprocessing fail. `exec_command` runs `/bin/sh -c`, `run_code` runs a Node cell (`desktop/workers/code-cell.cjs`), and file tools (`apply_patch`, `view_image`) run `desktop/workers/scratch-files.cjs` inside the same sandbox.
- `desktop/services/advanced-runtime-service.mjs` exposes these as `runtime_advanced_*` workflows. `request_permissions` (capability `scratch_execution`) asks the user once per turn (`docs/runtime-session.js`) and then grants scratch.
- Tool definitions are in `shared/advanced-tools.js`; `shared/runtime-tools.js` exposes the `scratch` group only to Agent Work with `workspace_write` or `full_access`.
- Scratch is macOS-only and needs a system Node at `/opt/homebrew/bin/node` or `/usr/local/bin/node` when running inside Electron, so most installed copies cannot use it.

## Probe results (macOS 26, `sandbox-exec`, 2026-10-07)

A deny-by-default profile with the project readable except `.biodesign/`, `output/` writable and `process-fork` allowed:

| Attempt | Result |
|---|---|
| Read `literature/paper.txt` | allowed |
| Read `.biodesign/state.json`, or `.BIODESIGN/state.json` on a case-insensitive volume | denied |
| Write `literature/paper.txt` | denied |
| Pipeline writing to `output/` | allowed |
| `ln literature/paper.txt output/link.txt` (hard link) | denied |
| Write through `output/sym.txt -> ../literature/paper.txt` | denied (the symlink itself can be created) |
| `mv output output2` | denied |
| `rmdir output`, without an anchor rule | **allowed**, so `output/` is anchored (see below) |
| Read `.biodesign/` through `/System/Volumes/Data/...` | denied |
| `stat .biodesign/state.json` with an unfiltered `(allow file-read-metadata)` and a later `(deny file-read* ...)` | **allowed**: a wildcard `file-read*` deny does not override the metadata allow |
| TCP connection to a local listener (`nc`, Node `net`) | denied |

Rule precedence, tested directly: for data reads the later rule wins. Metadata is only hidden by a `require-not` filter on the allow or by an explicit `file-read-metadata` deny. The builder therefore puts `require-not` filters for hidden paths on every allow, and repeats an explicit deny at the end.

## Design

### Access policy (macOS)

`desktop/services/sandbox-policy.mjs` builds seatbelt profiles from a policy object. Paths are passed as `-D` parameters and referenced with `(param ...)`, never interpolated into the profile text. Excluded subpaths use `(require-all (subpath ROOT) (require-not (literal X)) (require-not (subpath X)))`, as Codex does.

Project mode:
- **Read:** the project root without `.biodesign/`; system paths (`/System`, `/usr/lib`, `/usr/share`, `/bin`, `/usr/bin`, `/Library/Apple`, dyld cache, `/dev/fd`); the executable and worker files; the runtime folder (Stage 4); the turn's private folder.
- **Write:** `output/` and the turn's private folder; `/dev/null`. `output/` must be a real directory inside the project (created by the host if missing, never a symlink). Unlinking or renaming the `output/` anchor is denied.
- **Processes:** `process-fork` and `process-exec` allowed; signals only within the sandbox; POSIX semaphores for Python multiprocessing.
- **Network:** none.
- **Environment:** `PATH` (system bin folders, later the runtime), `HOME` and `TMPDIR` set to the private folder, `LANG`, `PYTHONDONTWRITEBYTECODE=1`, `PYTHONNOUSERSITE=1`, `MPLBACKEND=Agg`, `MPLCONFIGDIR` in the private folder. Nothing else is inherited.

Symlinks inside the project that point outside it resolve to unreadable paths; this is a deliberate limitation of decision 2. File metadata (existence, size, times) outside the project stays readable, as in scratch mode, so path resolution works; contents do not. Metadata inside `.biodesign/` is denied.

### Process lifetime

Each command starts in its own process group. Cancelling a call, closing the turn or the command's own exit kills the whole group, so background jobs do not outlive it. A process that deliberately leaves its process group can survive cancellation; it remains sandboxed (no network, writes only to `output/`). Codex accepts the same limitation on macOS. Concurrency, timeouts and output limits stay as in scratch mode (4 live handles, 300 s maximum, bounded output).

### Tools and approval (Stage 2)

- `request_permissions` gains the capability `project_execution`. The renderer shows the approval text from decision 6; a granted turn's `exec_command`, `run_code`, `apply_patch`, `view_image` and `wait_for_environment` run in project mode with the project root as working directory. Paths are project-relative; `apply_patch` writes only under `output/`.
- Tool descriptions say which mode applies; the grant result and `wait_for_environment` report the enforced access (read project without `.biodesign/`, write `output/`, no network).
- Available only to Agent Work with `workspace_write` or `full_access`, on macOS, and only when the sandbox probe succeeds.
- One environment per turn: asking for the other one returns `EXECUTION_MODE_CONFLICT`. An unavailable project sandbox returns `PROJECT_SANDBOX_UNAVAILABLE`.
- Project commands need only the OS sandbox. Code cells and file tools also need a Node executable; without one, capabilities report `CODE_RUNTIME_UNAVAILABLE` and those calls fail with that code (Stage 4 removes the dependency).
- In project mode, `image_gen_imagegen` writes under `output/generated/`.

### Provenance, undo and UI (Stage 3)

`desktop/services/output-provenance.mjs`, driven by `AdvancedRuntimeService`:
- **Snapshot and backup at the grant.** The host walks `output/` with `lstat` (never following symlinks) and clones it into `.biodesign/runtime/backups/<owner>/` (APFS clones where available). Above 20,000 entries or 1 GiB no backup is kept and undo is unavailable for that turn. The newest 10 backups are kept. If the snapshot cannot be recorded, the grant fails closed (`PROVENANCE_UNAVAILABLE`).
- **Observation.** After every project-mode execution call (including failed ones and Code Mode replies) and when the turn closes, the host compares `output/` with the snapshot. Created, changed and deleted files are recorded with their `sha256:` hash, size and the first call after which they were seen, in `.biodesign/runtime/generated/<owner>.json`; `index.json` maps each path to its recent generated hashes. Change detection uses size, times and inode (ctime cannot be set by the sandbox); hashing is bounded (512 MiB per observation, 128 MiB per file) and an exceeded bound marks the record incomplete.
- **Tool results.** Each project-mode execution result carries `output_changes`: the files created, changed or deleted by that call (at most 20 listed per kind) plus the turn's totals, whether the record is complete and whether undo is available.
- **Generated, not evidence.** `shared/retrieval-contract.js` (`generatedOutputOrigin`) labels a source under `output/` whose current content hash matches the index: selected-file evidence becomes `evidenceType: "generated-document"` with a notice, search hits carry `origin: "generated"` and the notice, and the searchable document copy gets `origin: "generated"` in its frontmatter. Papers and experiments are never affected: they must live in `literature/` and `experiments/`, which the sandbox cannot write.
- **Undo.** `runtime_advanced_undo { turnId }` (and the `output.undo` frontend command) restores changed and deleted files from the backup and removes created files and the folders the turn created. A file is touched only while it still holds what the turn left; files edited since are kept and reported as conflicts. Nothing is written through a path whose folder was replaced by a symlink. Undo is refused while the turn runs and after it has been applied once.
- **UI.** Activity rows show per-call file counts; the turn card shows the turn's totals and an "Undo these changes" button once the turn has finished. The Workspace explorer already refreshes after every tool step.

While building the undo command, a cross-cutting defect surfaced: Electron's `contextBridge` drops an Error's custom properties (`code`, `status`) and turns a synchronous throw into a bare Error. Every desktop API failure therefore reached the renderer without its code, including agent-loop rejections such as `AUTH_REQUIRED`. The preload now rejects with plain `{ name, code, message, status }` objects, always asynchronously (`desktop/test/preload-errors.test.mjs`; the React workbench fixture checks a real workflow error code across the bridge).

### Parallel tasks

Up to three Agent Work conversations can run at once (`docs/codex-parity-features.md`). Task folders live in a reserved folder, `output/agent-tasks/<task>/`, one per conversation. The host creates `output/agent-tasks/` as a real, anchored directory at every project grant.

- **A task turn.** A turn granted `project_execution` while another turn already holds project write access writes only its conversation's folder. The folder is a real, anchored directory created by the host. The turn's output record, backup and undo cover only that folder.
- **A turn writing `output/`.** Any other turn writes `output/` except `output/agent-tasks/`, from its first process on. The reserved folder is in the profile's `protect` list (readable, not writable), and the turn's own conversation's folder is allowed again after it (`reopen`). Its output record, backup and undo skip `output/agent-tasks/` except that own folder.

Because the reserved folder is never writable to such a turn, no command it starts, including one started before a task began, can write another conversation's folder. An earlier design protected a task's folder only from processes started after the task, which left a command already running able to overwrite the task's files. The cost of the fixed rule is that a turn can read, but never write, another conversation's task folder, even when that task isn't running. Otherwise a turn running alone writes `output/` as before.

### Execution runtime (Stage 4)

**Trial result: the app's own binary cannot run cells.** Packaged builds disable Electron's `RunAsNode` fuse (`forge.config.cjs`), which is the right hardening and stays. Code cells and the sandboxed file tools therefore get their own Node, shipped in the same download as Python.

**Build** (`desktop/scripts/build-execution-runtime.mjs`, inputs in `desktop/scripts/execution-runtime/`, macOS build host):
- `lock.json` pins python-build-standalone `20261003` (CPython 3.12.15, stripped `install_only` builds), Node v24.21.0, and the SHA-256 of each source for `darwin-arm64`, `darwin-x64` and `win32-x64`. The package set is numpy, pandas, scipy, matplotlib and openpyxl.
- `lock` resolves the packages per target (macOS wheel tags capped at macOS 12, the app's minimum) and writes `python-requirements.txt`: 15 packages, every wheel hash. All targets resolve to the same versions (numpy 2.5.3, pandas 3.0.6, scipy 1.18.1, matplotlib 3.11.2, openpyxl 3.1.5).
- `build --target <target> [--manifest]` verifies both downloads, installs the locked wheels with `--require-hashes`, removes pip, IDLE, Tcl/Tk, tests and caches, precompiles bytecode with hash-checked (not time-checked) `.pyc` files, adds the Node binary, writes `BIODESIGN_RUNTIME.json`, and packs `out/execution-runtime/biodesign-runtime-<version>-<target>.tar.gz`. `--manifest` records the archive's file name, size and SHA-256 in `desktop/runtime/execution-runtime.json`, which ships with the app. Builds are not byte-reproducible (tar records file times), so the manifest pins the exact file that was built.
- Sizes for `darwin-arm64`: 136.6 MB compressed, 422 MB installed (Python 294 MB, of which scipy 91 MB; Node 128 MB). Cross-building `darwin-x64` works and runs under Rosetta; it is not recorded in the manifest because the app ships macOS builds for the host architecture.

**Install** (`desktop/services/execution-runtime.mjs`, created in `desktop/main/application.mjs` with Electron's `net.fetch`, so system proxy settings apply):
- The first project grant starts the download in the background, from `https://github.com/qygx-biotech/copilot-dev/releases/download/execution-runtime-<version>/<file>`. HTTPS only, including after redirects.
- The download is streamed to disk while hashed; more or fewer bytes than pinned, another hash, a failed request or an `http:` redirect discards it (`RUNTIME_DOWNLOAD_INVALID` / `RUNTIME_DOWNLOAD_FAILED`), and a later turn can retry. The archive is unpacked with the system `tar` into a staging folder, must describe the pinned version and platform with executables inside it, and is then renamed into `<userData>/runtimes/<version>-<hash>/`. Older versions are removed.
- **One-time warm-up.** The first load of each freshly unpacked native module is slow on macOS, and Matplotlib builds a font cache with absolute paths. Measured cold, a first analysis took 43 s; after the warm-up, 1.7 s. The installer therefore imports the packages once, sandboxed (read the runtime, write only its cache folder), and reports `installing` until that finishes. Each project session copies the prebuilt font cache into its private folder.
- One download serves concurrent turns; a turn that stops waiting does not cancel it; quitting the app aborts it.

**Use.** In project mode `PATH` starts with the runtime's Python and Node, and the sandbox may read the runtime folder but not write it. Cells and file tools prefer the runtime's Node over a system Node; without either they fail with `RUNTIME_PREPARING` (download running) or `CODE_RUNTIME_UNAVAILABLE`. Scratch mode becomes available without a system Node once the runtime is installed. The project grant reports the runtime state; `wait_for_environment` waits up to 25 s per call for the install; the approval text mentions the one-time download and its size while the runtime is not installed.

**Publishing (not done; a release step for the maintainers).** Create the GitHub release `execution-runtime-2026.10.1` in `qygx-biotech/copilot-dev` and upload `out/execution-runtime/biodesign-runtime-2026.10.1-darwin-arm64.tar.gz` unchanged. Its tag is not a semantic version, so the Windows updater ignores the release (tested). Until it is published, project commands work but `python3` is unavailable and the runtime reports `RUNTIME_DOWNLOAD_FAILED`.

### Windows (Stage 5)

Trial first: build Codex's Windows sandbox helper, run it on a standard and a managed Windows machine, and record what the one-time administrator setup changes (local sandbox accounts, Windows Filtering Platform rules) and whether IT policy blocks it. Then translate the same policy (read roots, `output/` writable, `.biodesign/` denied, no network) to the helper and choose the shell (PowerShell or `cmd`).

## Stages

| Stage | Work | Exit criteria |
|---|---|---|
| 1. macOS policy and project mode (done) | `sandbox-policy.mjs`; `ScratchRuntime.openProject` (cwd = project, `output/` writable, private folder, forks with process-group cleanup); project-mode file worker and patch scope; closing removes only the private folder. Not yet exposed to the model. | Met: `desktop/test/project-sandbox.test.mjs` (9 tests, 5 native) passes, and fails under mutations that drop the group kill, the hidden path or the anchor. Existing scratch suites pass natively (23 tests). |
| 2. Tools and approval (done) | `project_execution` capability (`shared/advanced-tools.js`), `AdvancedRuntimeService.grant(owner, capability)`, the `runtime_advanced_grant` workflow's `capability` key, the renderer approval text (`docs/runtime-session.js`), project-mode image path. Code Mode subcall rules and receipts are unchanged. | Met: grant rules and gating in `advanced-runtime.test.mjs`; the renderer shows the project approval and passes the capability (`renderer-agent-loop.test.mjs`); natively, a renderer turn on the agent loop writes `output/report.md` through the real sandbox, and the project-session workflow runs commands with the project as working directory. |
| 3. Provenance, undo, UI (done) | As described above. | Met: `desktop/test/output-provenance.test.mjs` (detection, symlinks, bounds, backups, undo conflicts, a replaced folder, fail-closed grant), `alibaba-fc/test/generated-output-evidence.test.js` (labels in evidence, hits and the searchable copy; none outside `output/` or after edits), observability contract and React fixture checks, and a native run where a sandboxed command's file is reported and undone through the workflow. |
| 4. Execution runtime (done; archive not yet published) | As described above. | Met: `desktop/test/execution-runtime.test.mjs` (verified install and reuse; wrong hash, size, truncation, 404 and `http:` redirect leave nothing installed and can be retried; archive metadata checks; shared download, per-waiter cancellation, abort on close; updater ignores the release; grant, approval size and `wait_for_environment`; Node selection). Natively, the sandbox runs the runtime's `python3` from `PATH` and cannot modify the runtime; with `BIODESIGN_RUNTIME_ARCHIVE` set to the built archive, pandas, scipy and Matplotlib write `output/summary.csv` and `output/titre.png`, and a code cell and a patch run on the runtime's Node with no system Node. |
| 5. Windows | Helper trial, then integration. | Same escape suite on Windows. |
| 6. Docs and end-to-end check | README, `docs/codex-integration.md`, this document. | "Analyse my CSVs into `output/`" works end to end on a fixture project. |

## Risks

| Risk | Mitigation |
|---|---|
| Seatbelt (`sandbox-exec`) is deprecated by Apple | Still used by Codex and Chromium; probed at runtime, and the capability is unavailable when the probe fails. |
| A process escapes its process group | It stays sandboxed; documented limitation, as in Codex. |
| Large `output/` folders make snapshots or backups slow | Bounded walk and backup size; above the bound, the manifest is marked incomplete and undo is unavailable for that turn. |
| Windows administrator setup blocked on managed machines | Trial before integration (Stage 5); the capability stays unavailable on Windows until then. |
| Runtime download unreachable | Reachability matches the app updater; the capability reports the missing runtime instead of falling back to an unsandboxed Python. |
