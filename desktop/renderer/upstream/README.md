# nanobot UI provenance

Reference: local `nanobot/` checkout of https://github.com/HKUDS/nanobot,
commit `2fb16593988b9e85131e02f395bb9a5108e220e7`.

The React shell and stylesheet adapt the sidebar/list/thread/workbench
composition in `webui/src/App.tsx`, `components/Sidebar.tsx`,
`components/ChatList.tsx`, `lib/chat-groups.ts`,
`components/thread/ThreadShell.tsx`, `components/thread/ThreadComposer.tsx`, and
`components/workbench/PaneWorkbench.tsx`. Default-workspace chats and optional
project groups follow nanobot's new-chat navigation, using BioDesign's original
palette. `components/ResizeHandle.jsx` adapts
the pointer-capture and keyboard-resize pattern in
`webui/src/components/SidebarResizeHandle.tsx`.

The original MIT notice is preserved in `nanobot-LICENSE` and copied into the
production renderer assets. BioDesign-specific code lives in the parent
repository. The nested checkout is unchanged and is not a build dependency.

Nanobot's hooks, client, routing, runtime, provider setup, memory, automations,
and channel controls are not shipped. Existing BioDesign services supply the
connected functionality through `docs/desktop-adapter.js`.
