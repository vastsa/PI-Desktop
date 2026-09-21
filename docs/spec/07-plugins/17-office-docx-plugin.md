# Office DOCX plugin

> Status: Accepted for the first migrated slice

PI-Desktop ships a bundled `pi.office` plugin for opening, previewing, and
editing existing `.docx` files in the work panel. The editor is a browser
renderer extracted from the pinned GenOffice release recorded in the plugin's
`UPSTREAM.md`.

The host owns file-reference completion and work-panel tabs. The plugin owns
DOCX parsing, rendering, editing, serialization, and file bytes. DOCX files
opened from the project file manager or chat are routed to `pi.office` when
the view is available; other file types keep their existing routes.

The file lifecycle is bounded and optimistic: reads return a fingerprint,
saves reject unexpected mtime/size/hash changes unless the user explicitly
confirms an overwrite, and writes use a same-directory temporary file with
fsync followed by replacement. Recovery copies stay under the plugin data
directory. Non-DOCX files, credential-like paths, paths outside the workspace,
directories, and files over 64 MiB are rejected.

The renderer has no Node or Electron access and the view CSP blocks network
connections. This migration intentionally excludes selection-to-chat actions,
comments, Composer annotations, and paragraph-anchor protocols. It also does
not include new-document creation, Save As, native Microsoft Office/COM,
GenOffice AI, accounts, remote services, or MCP integrations.

The editor zoom range is 25%–200%. Opening a document keeps the editor's
normal zoom behavior; the user can use the page-width and whole-page commands
when an explicit fit mode is wanted. Rebuilding or reloading the plugin view
re-attaches the native work-panel surface after the view has been recreated so
the surrounding work-panel controls remain interactive.
