# Desktop UI migration — chat-first shell

The Electron renderer follows the local nanobot WebUI's startup and project
navigation flow, using BioDesign's original color tokens. It opens a new-chat
composer after authentication. Choosing a folder is optional. Saved Agent Work conversations
appear in **Chats** for the default workspace and beneath expandable **Projects**
for selected folders. The project-goal and workspace-explorer panels are removed.

This matches the responsibilities inspected in nanobot's `App.tsx` (`onNewChat`,
`onNewChatInProject`, default workspace scope), `lib/chat-groups.ts` (project-based
session grouping), `ThreadShell.tsx` / `ThreadComposer.tsx` (empty-chat hero and
optional project picker), and `PaneWorkbench.tsx` (optional resizable panes).
Nanobot's server protocol and runtime hooks are not required by the renderer.

## User flow

1. Sign in through the existing authenticated FC account flow. A private default
   workspace is opened automatically, without a folder picker or setup screen.
2. Start an Agent Work conversation immediately. **New chat** starts another
   default-workspace conversation. The model and download permission are still
   explicit controls on the composer.
3. Optionally use **Choose project** below an empty composer or **Projects +** in
   the sidebar. A selected folder is remembered. Uninitialized external folders
   require confirmation before creating BioDesign data; cancellation preserves
   the current chat. The default app-owned workspace initializes automatically.
   The Agent Work composer picker preserves draft text and model. Agent write
   permission resets for a new project. Side Chat belongs to its Agent Work panel.
   Opening an external folder with no saved goal offers an optional **Project
   goal** dialog. **Skip for now** continues without changing the goal; it is not
   prompted again during the same signed-in session. Right-click a project
   heading (or use Shift+F10) to **Add project goal** or **Edit project goal**.
   Editing an inactive project's goal first opens that project through the normal
   guarded switch path. The managed default workspace does not prompt for a goal.
4. Each project expands to its saved conversations. Selecting a conversation
   restores its project and history without asking for the folder again.
5. **Side Chat** toggles the two-pane layout: Agent Work on the left and Side Chat
   on the right. Clicking it again returns to Agent Work alone. Narrow windows
   use pane tabs. Histories, execution roles, and permissions remain independent.
   The sidebar lists only Agent Work. Each panel owns up to five Side Chats,
   selected through the **Side Chat history** dropdown inside the open pane.
   **+** creates a Side Chat for that panel; a sixth chat evicts its oldest one.
   Switching Agent Work restores that panel's selected history and draft.
   Finish or stop an active Side Chat before switching Agent Work panels.
   **Copy** copies the pane's transcript as text, including attachment names.
   Desktop copying uses the preload's text-only clipboard command and a trusted,
   validated IPC handler calling Electron's native clipboard. Browser permission
   denial therefore does not block it; no clipboard-read capability is exposed.
   **Fork** creates and selects an independent conversation with the current
   transcript. Side Chat forks retain image references/understanding and belong
   to the same Agent Work panel, within its five-chat limit. Agent Work forks
   retain the model and displayed result but start with read-only permission and
   their own empty Side Chat store. Forking makes no model/tool request and does
   not commit a recommendation. Existing unfinished composer drafts are not
   copied. Copy/fork controls are disabled for empty or running conversations.
6. **Literature** opens an on-demand source dialog. It lists local PDFs, supports
   evidence selection, and shows files saved by the existing download pipeline.
   New downloads are marked unprepared until normal research preparation runs.

Unsupported Agent Work file/image attachment placeholders are hidden. Supported
Side Chat image attachment, paste/drop, storage, and edit/regenerate remain
connected to the existing authenticated image-understanding service.

## Integration and ownership

```text
Existing Electron lifecycle and security
  → generated docs/desktop.html
  → React chat/project shell
  → BioDesignFrontend commands and turn snapshots
  → existing frontend research services
      → authenticated Alibaba Cloud FC → existing agent execution → Requesty
      → existing preload and validated IPC → local research/download services
```

| Concern | Current owner |
| --- | --- |
| Shell, project groups, new-chat hero, pane layout, dialogs | `desktop/renderer/main.jsx`, `workbench.css`; original colors from `docs/styles.css` |
| Explicit role/target commands, activity snapshots, cancellation, stale-turn generations | `docs/desktop-adapter.js` |
| Project switching and default-workspace startup | Desktop-specific controller functions in `docs/app.js` |
| Remembered project locations and summary discovery | `desktop/services/project-catalog.mjs`, main process only |
| Model/tool execution | Existing FC `side-chat-agent.js`, `academic-agent.js`, and `agent-continuation.js`; existing frontend evidence recovery and desktop continuation |
| Conversation persistence | `WorkspaceChatStore` with five Side Chats per Agent Work panel under `.biodesign/chat/agents/<panel-id>/`; Agent Work under `state.agent.workbench` |
| Research data | Existing project `.biodesign/` registry, knowledge, Paper Cards, corpus records, QMD index, and source files |
| Desktop capabilities | Existing preload → validated IPC → filesystem, execution, retrieval, and paper-download services |
| Authorization and credentials | Existing authenticated FC route, role/tool policies, continuation validation, local permission checks, and recommendation commit path; provider credentials stay server-side |
| UI preferences | `biodesign.desktop.ui.v1.*` localStorage keys; no research data stored here |

`ServiceView` mounts the original bound timeline/composer/recommendation nodes
once. React owns their placement; existing services own their contents and
listeners. There is no second transcript writer, nested agent loop, or emulation
of the full nanobot server API. These widgets can be ported individually later.

## Storage and project identity

The main process stores an account-scoped shell registry beneath Electron's
`userData/projects/<account-hash>/projects.json`. It contains only IDs, names,
and paths chosen through the native picker. The account's default workspace is
`userData/projects/<account-hash>/workspace/`. Its research data uses the same
`.biodesign/` formats as an external project.

Project list requests read conversation summaries from each project's existing
stores; they do not duplicate transcripts into the shell registry or activate
another project's services. Known project IDs are resolved in main; renderer
requests cannot supply arbitrary root paths. Missing/replaced folders and corrupt
registries are reported without silently retargeting or overwriting them.

Existing external projects are not moved. Goals remain in the existing
`state.project.goal` field in `.biodesign/state.json`, using the same serialized
save path as the rest of project state. The modal editor updates that field;
the project catalog only reads whether a goal exists. Failed saves retain the
editor draft, and project identity checks prevent saving to a different folder.
Goals continue to supply context through the existing research preparation. The
optional `state.agent.workbench` extension added in stage 1 preserves other state
fields and holds Agent Work panels/recommendations. Unscoped legacy sessionStorage
snapshots are not silently assigned to a project. The browser entry retains its
previous workflow.

Each panel's Side Chat store contains its own `index.json`, `conversations/`, and
`attachments/`, using the existing file schemas and retention implementation.
Eviction and attachment cleanup cannot affect another panel. On the first open
of an older project, existing `.biodesign/chat/` history stays in place and is
associated with the first saved Agent Work panel (or a new panel if none exists).
Its `sideChatScope: "legacy"` marker and the workbench's `sideChatLayoutVersion: 1`
record that association. Other panels use their IDs as store namespaces. No
transcript or attachment is copied or silently assigned to every panel.

Switching projects flushes current state, aborts outstanding turns, and creates
fresh service instances. Workspace/knowledge I/O captures the native project
session ID. Preload rejects stale IDs, and response/progress/save callbacks check
their originating project and account. A late old-project response, including a
401 response, cannot alter the new project's chat or authentication state.

## Literature and downloads

The existing source system, hard selected-source scopes, bounded retrieval,
Paper Cards, corpus coverage, citations, and evidence recovery remain in use.
Removing the explorer does not inject an entire folder into model context.
Without a selection, preparation uses the existing bounded Entire Project path.

Side Chat cannot commit the official recommendation or execute downloads. Agent
Work retains the existing validated result and tool paths, including explicit
download intent and per-turn workspace-write permission. FC still plans and
returns continuation tokens; local execution still validates URLs, PDF bytes,
destinations, deduplication/bookkeeping, failures, and saved-file results. Those
actual results resume the same FC turn. Download completion refreshes the local
file listing; it does not pretend newly saved PDFs have already been ingested.

## Build and verification

Use Node 22–24. `npm run desktop:dev` prepares local assets and starts the existing
Electron application. `npm run renderer:watch` rebuilds renderer JS/CSS during
editing; reload the window afterward. Template HTML changes require another
`renderer:build`. Both development and packaging use local file URLs with the
existing sandbox, context isolation, IPC validation, and update integration.
No Python gateway or development HTTP server is required.

The renderer build copies the nanobot MIT notice into packaged assets. The
nested checkout is unchanged and is not a build dependency. Provenance is in
`desktop/renderer/upstream/README.md`.

`desktop:test` covers default startup without a picker, optional folder
confirmation, account isolation, registry restarts, project-grouped saved chats,
project switching, explicit roles/models/source scope, concurrent streams,
cancellation, errors, attachments/editing, authorized downloads and FC
continuation, local saved files, goal prompting/skipping/editing, transcript
copying, fork isolation and attachment retention, and state recovery. It runs the full renderer
from both loose files and an ASAR archive and captures screenshots at desktop
and narrow widths. `desktop:smoke` checks the real application entry and window
security. Existing backend and research suites retain their execution coverage.

The Electron fixture mocks FC/preparation responses and remote PDF bytes while
using real local persistence, preload, IPC, and download execution. These checks
are not live FC/Requesty or publisher-download verification, and ASAR loading is
not a signed-installer or Windows-update installation test.

## Later runtime adoption

The frontend adapter is the integration seam for later nanobot session lifecycle
and event services. Keep explicit project/conversation IDs, roles, captured model
and source scope, and completion/error states. Replace the execution owner for a
turn when adopting a nanobot runner; do not wrap the existing loop in a second
planner. Model traffic must still use authenticated FC → Requesty, and local
capabilities must still cross validated IPC. Memory and any future research-data
migration need separate ownership/versioning decisions; neither is introduced
by this UI change.

## Chat controls on `nanobot/sidechat`

Both composers are anchored at the bottom of their panes and use the same
220px height. Side Chat's existing model selector is moved into its composer;
its model capture and backend behavior are unchanged. Each pane fills its
resizable column, and narrow windows continue to use pane tabs.

Right-click an Agent Work row or an entry in the Side Chat history dropdown to
choose **Delete chat**. A modal asks for confirmation, with Cancel focused by
default. Deleting Agent Work also removes its owned Side Chat histories; project
files and the official research recommendation remain. Deleting the selected
chat chooses a remaining chat, or creates an empty one when none remain.
Active turns must finish before deletion. Scope/identity checks and serialized
store operations prevent deleting another panel's history. Index writes precede
file cleanup, and shared image attachments stay until no retained chat uses them.

The Side Chat dropdown uses an accessible listbox rather than native option
menus so right-click behavior works consistently. Arrow keys, Home/End, Enter,
Escape and Shift+F10 are supported. Selecting history still does not change its
recency order. Each saved user/assistant message also has a **Copy** button,
using the existing native clipboard bridge and copying only that message plus
its attachment names.
